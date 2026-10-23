import type { Locator, Page } from 'playwright';
import { HttpError } from './store.ts';
import { waitForCode } from './graph.ts';
import { password, system, type System } from './systems.ts';

// How the server signs in to the web connections whose sign-in is more than a user name and a password (browser.ts does that one
// for the rest): Target, Costco and Burlington, each written against the live site. A code the site mails is read from the mailbox
// of the m365 connection the system's `otp_mail` setting names (M365 Mail if unset). A site that asks for a code again later, as
// Costco's PingID does on the way into its Vendor Accounting Portal, is answered by `challenge`, which the browser calls after each
// step of a flow.

export type Codes = Set<string>;
export type Adapter = {
  signIn(page: Page, sys: System, codes: Codes): Promise<void>;
  // Answers a code page if one shows; true if it did. `posting` lets the browser send while it answers, as a sign-in does.
  challenge?(page: Page, sys: System, codes: Codes, posting: (on: boolean) => void): Promise<boolean>;
};

const CODE_WAIT = 25_000, RESENDS = 3, STEP = 60_000;

// Waits up to `ms` for the first of `states` to hold, checking twice a second; null if none does.
export async function until<K extends string>(ms: number, states: Record<K, () => Promise<boolean>>): Promise<K | null> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 500)))
    for (const [k, test] of Object.entries(states) as [K, () => Promise<boolean>][]) if (await test().catch(() => false)) return k;
  return null;
}

const shown = (l: Locator) => l.first().isVisible();
export const pageText = async (page: Page) => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

// Types the code the site just mailed into `box`, key by key (some forms enable their button only on key presses), and submits it.
// `since` is when the site was asked to send it. If none comes within 25 seconds, presses the site's resend, up to three times.
async function enterCode(sys: System, codes: Codes, since: Date, sender: RegExp, box: Locator, resend: Locator) {
  const id = sys.settings?.otp_mail || 'm365-mail', mail = system(id), mailbox = mail?.settings?.mailbox;
  if (!mail || !mailbox) throw new HttpError(409, `${sys.name} mails a sign-in code, and ${id} is not set up to read it`);
  for (let i = 0; i <= RESENDS; i++) {
    if (i) await resend.first().click({ timeout: 40_000 }); // a resend may count down first
    const code = await waitForCode(mail, mailbox, new Date(since.getTime() - 10_000), sender, CODE_WAIT, '4,8', codes);
    if (code) {
      codes.add(code);
      await box.first().fill('');
      await box.first().pressSequentially(code, { delay: 60 });
      await box.first().press('Enter');
      return;
    }
  }
  throw new HttpError(504, `${sys.name} said it mailed a sign-in code, but none reached ${mailbox} in ${(RESENDS + 1) * CODE_WAIT / 1000} seconds with ${RESENDS} resends; check that mailbox's quarantine and rules for mail from the site`);
}

// ---- Target Partners Online: email and password, then a one-time passcode by email.
const target: Adapter = {
  async signIn(page, sys, codes) {
    await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
    const pass = page.locator('input[type=password]');
    await pass.first().waitFor({ timeout: STEP });
    await page.locator('#userID, input[type=email], input[type=text]').first().fill(sys.username!);
    await pass.first().fill(password(sys));
    await page.getByRole('button', { name: /^log ?in$/i }).first().click();
    const email = page.getByRole('button', { name: /^Email\b/i }), signin = () => /logonservices|oauth\.iam/.test(new URL(page.url()).host);
    const state = await until(STEP, {
      // After many codes in a short time Target offers only SMS and voice, for a while.
      noEmail: async () => /disabled email OTP/i.test(await pageText(page)),
      choose: () => shown(email),
      in: async () => !signin(),
      refused: async () => /something went wrong|incorrect|invalid|locked/i.test(await pageText(page)),
    });
    if (state === 'noEmail') throw new HttpError(423, 'Target has turned off email passcodes for this account after too many attempts, and offers only SMS or voice; try again later, usually the next day');
    if (state === 'refused') throw new HttpError(502, `Target refused the sign-in: "${(await pageText(page)).slice(0, 160)}"`);
    if (!state) throw new HttpError(504, 'Target\'s sign-in page did not move on');
    if (state === 'choose') {
      const since = new Date();
      await email.first().click();
      const box = page.locator('input[type=password], input[name*=otp i], input[autocomplete=one-time-code]').filter({ visible: true });
      await box.first().waitFor({ timeout: STEP });
      await enterCode(sys, codes, since, /target\.com|one-time passcode/i, box, page.getByText(/^Resend( OTP)?$/i));
      if (!(await until(STEP, { in: async () => !signin() }))) throw new HttpError(502, `Target did not take the passcode: "${(await pageText(page)).slice(0, 160)}"`);
    }
  },
};

// ---- Costco Vendor Hub: email, password and the terms box, then a PingID passcode by email; PingID may ask again for the Vendor
// Accounting Portal.
const PING = /pingidentity|authentication request/i;
const costco: Adapter = {
  async signIn(page, sys, codes) {
    await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
    await page.locator('#password').waitFor({ timeout: STEP });
    await page.locator('#username').fill(sys.username!);
    await page.locator('#password').fill(password(sys));
    const terms = page.locator('#tncCheckbox');
    if (await terms.count() && !(await terms.isChecked())) await terms.check();
    const since = new Date();
    await page.getByRole('button', { name: /^sign in$/i }).first().click();
    const hub = () => new URL(page.url()).host === new URL(sys.url!).host;
    const state = await until(STEP, { code: () => shown(page.locator('#otp')), in: async () => hub() });
    if (!state) throw new HttpError(502, `Costco's sign-in did not move on: "${(await pageText(page)).slice(0, 160)}"`);
    if (state === 'code') {
      await enterCode(sys, codes, since, PING, page.locator('#otp'), page.getByText(/^Resend Passcode$/i));
      if (!(await until(STEP, { in: async () => hub() }))) throw new HttpError(502, `Costco did not take the passcode: "${(await pageText(page)).slice(0, 160)}"`);
    }
  },
  async challenge(page, sys, codes, posting) {
    if (!(await shown(page.locator('#otp')).catch(() => false))) return false;
    const since = new Date(Date.now() - 30_000), from = new URL(page.url()).host;
    posting(true);
    try {
      await enterCode(sys, codes, since, PING, page.locator('#otp'), page.getByText(/^Resend Passcode$/i));
      await until(STEP, { done: async () => new URL(page.url()).host !== from });
    } finally {
      posting(false);
    }
    return true;
  },
};

// ---- Burlington, on Traverse: user name and password; its single-page app lands on #/home.
const burlington: Adapter = {
  async signIn(page, sys) {
    await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
    const pass = page.locator('#password, input[type=password]').first();
    await pass.waitFor({ timeout: STEP });
    await page.locator('#username, input[type=text], input[type=email]').first().fill(sys.username!);
    await pass.fill(password(sys));
    await pass.press('Enter');
    const state = await until(STEP, { in: async () => /#\/home/.test(page.url()), refused: async () => /invalid|incorrect|locked/i.test(await pageText(page)) });
    if (state !== 'in') throw new HttpError(502, `Burlington did not take the sign-in: "${(await pageText(page)).slice(0, 160)}"`);
  },
};

const adapters: Record<string, Adapter> = { target, costco, burlington };
export const adapter = (id: string): Adapter | undefined => adapters[id];

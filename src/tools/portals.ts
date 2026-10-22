import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright';
import { HttpError } from '../store.ts';
import { newContext } from '../browser.ts';
import { waitForCode } from '../graph.ts';
import { password, system, type System } from '../systems.ts';
import { localDate, register, registerTest, type Context } from './index.ts';

// Tools that sign in to a customer's vendor portal and download its reports: Target, Costco and Burlington. Each is a fixed script
// written against the live site, in a browser the server runs; where a site mails a sign-in code, it is read from the mailbox of the
// m365 system the portal's settings name. They only read: signing in and choosing a report's period are their only form posts.
// A portal shows what it has now, so these ignore --date and RF_TODAY.

const CODE_WAIT = 25_000, RESENDS = 3, STEP = 60_000;

type Portal = { sys: System; page: Page; codes: Set<string> };

// Opens the portal's browser, runs `fn`, and closes it. If `fn` fails and a tool is running, a screenshot of where it stopped goes
// into working/ so a person can see what the site showed.
async function withPortal<T>(sys: System, ctx: Context | null, fn: (p: Portal) => Promise<T>): Promise<T> {
  const context = await newContext();
  context.setDefaultTimeout(STEP);
  const p: Portal = { sys, page: await context.newPage(), codes: new Set() };
  try {
    return await fn(p);
  } catch (e) {
    const err = e as Error & { status?: number }, at = p.page.url();
    const shot = ctx ? await p.page.screenshot({ fullPage: true }).then(b => ` A screenshot of the page is ${ctx.save(`${sys.name} stopped ${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`, b)}.`, () => '') : '';
    throw new HttpError(err.status ?? 502, `${sys.name}: ${err.message.split('\n')[0]}${at.startsWith('http') ? ` (at ${new URL(at).origin}${new URL(at).pathname})` : ''}.${shot}`);
  } finally {
    await context.close().catch(() => {});
  }
}

// Waits up to `ms` for the first of `states` to hold, checking twice a second; null if none does.
async function until<K extends string>(ms: number, states: Record<K, () => Promise<boolean>>): Promise<K | null> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 500)))
    for (const [k, test] of Object.entries(states) as [K, () => Promise<boolean>][]) if (await test().catch(() => false)) return k;
  return null;
}

const shown = (l: Locator) => l.first().isVisible();
const pageText = async (page: Page) => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

// Types the code the site just mailed into `box`, key by key (some forms enable their button only on key presses), and submits it.
// `since` is when the site was asked to send it. If none comes within 25 seconds, presses the site's resend, up to three times.
async function enterCode(p: Portal, since: Date, sender: RegExp, box: Locator, resend: Locator) {
  const id = p.sys.settings?.otp_mail || 'm365-mail', mail = system(id), mailbox = mail?.settings?.mailbox;
  if (!mail || !mailbox) throw new HttpError(409, `the site mails a sign-in code, and ${id} is not set up to read it`);
  for (let i = 0; i <= RESENDS; i++) {
    if (i) await resend.first().click({ timeout: 40_000 }); // a resend may count down first
    const code = await waitForCode(mail, mailbox, new Date(since.getTime() - 10_000), sender, CODE_WAIT, '4,8', p.codes);
    if (code) {
      p.codes.add(code);
      await box.first().fill('');
      await box.first().pressSequentially(code, { delay: 60 });
      await box.first().press('Enter');
      return;
    }
  }
  throw new HttpError(504, `the site said it mailed a sign-in code, but none reached ${mailbox} in ${(RESENDS + 1) * CODE_WAIT / 1000} seconds with ${RESENDS} resends; check that mailbox's quarantine and rules for mail from the site`);
}

async function download(page: Page, click: () => Promise<unknown>): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
}

const lines = (b: Buffer) => b.toString('utf8').split(/\r?\n/).filter(l => l.trim()).length;
const fetched = (ctx: Context) => `read live on ${localDate()}${ctx.asOfFrom === 'today' ? '' : `; the portal has no history, so the date ${ctx.asOf} (${ctx.asOfFrom}) does not apply`}`;

// ---- Target Partners Online: email and password, then a one-time passcode by email.

async function targetSignIn(p: Portal) {
  const { page, sys } = p;
  await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
  const pass = page.locator('input[type=password]');
  await pass.first().waitFor();
  await page.locator('#userID, input[type=email], input[type=text]').first().fill(sys.username!);
  await pass.first().fill(password(sys));
  await page.getByRole('button', { name: /^log ?in$/i }).first().click();
  const email = page.getByRole('button', { name: /^Email\b/i }), signin = (u: string) => /logonservices|oauth\.iam/.test(new URL(u).host);
  const state = await until(STEP, {
    // After many codes in a short time Target offers only SMS and voice, for a while.
    noEmail: async () => /disabled email OTP/i.test(await pageText(page)),
    choose: () => shown(email),
    in: async () => !signin(page.url()),
    refused: async () => /something went wrong|incorrect|invalid|locked/i.test(await pageText(page)),
  });
  if (state === 'noEmail') throw new HttpError(423, 'Target has turned off email passcodes for this account after too many attempts, and offers only SMS or voice; try again later, usually the next day');
  if (state === 'refused') throw new HttpError(502, `the sign-in was refused: "${(await pageText(page)).slice(0, 160)}"`);
  if (!state) throw new HttpError(504, 'the sign-in page did not move on');
  if (state === 'choose') {
    const since = new Date();
    await email.first().click();
    const box = page.locator('input[type=password], input[name*=otp i], input[autocomplete=one-time-code]').filter({ visible: true });
    await box.first().waitFor();
    await enterCode(p, since, /target\.com|one-time passcode/i, box, page.getByText(/^Resend( OTP)?$/i));
    if (!(await until(STEP, { in: async () => !signin(page.url()) }))) throw new HttpError(502, `the passcode was not taken: "${(await pageText(page)).slice(0, 160)}"`);
  }
}

async function targetExport(p: Portal, ctx: Context) {
  const { page, sys } = p, report = sys.settings?.report;
  if (!report) throw new HttpError(409, 'set the report page under Systems');
  await page.goto(report, { waitUntil: 'domcontentloaded' });
  // The card's "⋮" menu at its top right, then Export, then Export to csv.
  const menu = page.locator('[aria-label*="more" i], [aria-label*="option" i], [aria-label*="action" i], [title*="more" i], [data-testid*="more" i], [data-testid*="menu" i]').filter({ visible: true });
  await menu.first().waitFor({ timeout: 120_000 });
  await menu.first().click();
  await page.getByText(/^Export$/i).filter({ visible: true }).first().click();
  const file = await download(page, () => page.getByText(/^(Export to )?csv$/i).filter({ visible: true }).first().click());
  const saved = ctx.save(`Target specific document search ${localDate()}.csv`, file.bytes);
  return { files: [saved], text: `Target Partners Online, Specific Document Search, exported as ${file.name}: ${lines(file.bytes) - 1} rows; ${fetched(ctx)}.` };
}

registerTest('target', async s => withPortal(s, null, async p => { await targetSignIn(p); return `Signed in to Target as ${s.username}, with the emailed passcode, and reached ${new URL(p.page.url()).host}.`; }));

register({
  name: 'target-document-search', system: 'target',
  summary: 'Target Partners Online: the Specific Document Search card (Account Payable: Domestic) exported as csv.',
  params: [],
  run: ctx => withPortal(ctx.need('target'), ctx, async p => { await targetSignIn(p); return targetExport(p, ctx); }),
});

// ---- Costco Vendor Hub: email and password and the terms box, then a PingID passcode by email, for the hub and again for the
// Vendor Accounting Portal if it asks.

async function pingCode(p: Portal, since: Date) {
  const { page } = p;
  await enterCode(p, since, /pingidentity|authentication request/i, page.locator('#otp'), page.getByText(/^Resend Passcode$/i));
}

async function costcoSignIn(p: Portal) {
  const { page, sys } = p;
  await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
  await page.locator('#password').waitFor();
  await page.locator('#username').fill(sys.username!);
  await page.locator('#password').fill(password(sys));
  const terms = page.locator('#tncCheckbox');
  if (await terms.count() && !(await terms.isChecked())) await terms.check();
  const since = new Date();
  await page.getByRole('button', { name: /^sign in$/i }).first().click();
  const hub = () => new URL(page.url()).host === new URL(sys.url!).host;
  const state = await until(STEP, { code: () => shown(page.locator('#otp')), in: async () => hub() });
  if (!state) throw new HttpError(502, `the sign-in did not move on: "${(await pageText(page)).slice(0, 160)}"`);
  if (state === 'code') {
    await pingCode(p, since);
    if (!(await until(STEP, { in: async () => hub() }))) throw new HttpError(502, `the passcode was not taken: "${(await pageText(page)).slice(0, 160)}"`);
  }
}

async function costcoPortal(p: Portal) {
  const { page, sys } = p, portal = sys.settings?.portal;
  if (!portal) throw new HttpError(409, 'set the Vendor Accounting Portal address under Systems');
  const since = new Date();
  await page.goto(portal, { waitUntil: 'domcontentloaded' });
  const tab = page.getByRole('radio', { name: 'Payments', exact: true });
  let state = await until(2 * STEP, { code: () => shown(page.locator('#otp')), in: () => shown(tab) });
  if (state === 'code') {
    await pingCode(p, since);
    state = await until(2 * STEP, { in: () => shown(tab) });
  }
  if (state !== 'in') throw new HttpError(502, `the Vendor Accounting Portal did not open: "${(await pageText(page)).slice(0, 160)}"`);
}

// Waits out the portal's busy indicator after a change.
async function costcoIdle(page: Page) {
  await page.waitForTimeout(1000);
  await page.locator('.sapUiLocalBusyIndicator, .sapMBusyIndicator, .sapUiBlockLayer').filter({ visible: true }).first().waitFor({ state: 'hidden', timeout: 180_000 }).catch(() => {});
}

async function costcoDownload(page: Page) {
  await page.locator('button[title=Download]').filter({ visible: true }).first().click();
  return download(page, () => page.getByText('Download List as CSV').filter({ visible: true }).first().click());
}

const COSTCO_REPORTS = ['payments', 'unpaid-items'];

registerTest('costco', async s => withPortal(s, null, async p => {
  await costcoSignIn(p);
  await costcoPortal(p);
  return `Signed in to Costco as ${s.username}, with the emailed passcode, and opened the Vendor Accounting Portal.`;
}));

register({
  name: 'costco-ap', system: 'costco',
  summary: 'Costco Vendor Accounting Portal: Payments for the last 12 months and the Unpaid Items, each downloaded as csv. One sign-in serves both.',
  params: [{ name: 'report', hint: 'which: payments, unpaid-items; both if not given', many: true, choices: COSTCO_REPORTS }],
  run: ctx => withPortal(ctx.need('costco'), ctx, async p => {
    const { page } = p, want = ctx.args.report?.length ? ctx.args.report : COSTCO_REPORTS, files: string[] = [], said: string[] = [];
    await costcoSignIn(p);
    await costcoPortal(p);
    if (want.includes('payments')) {
      await page.getByRole('radio', { name: 'Payments', exact: true }).click();
      await costcoIdle(page);
      await page.locator('[role=combobox]').filter({ visible: true }).first().click();
      await page.locator('[role=option]').filter({ hasText: 'Last 12 Months' }).filter({ visible: true }).first().click();
      await costcoIdle(page);
      const period = await page.locator('[role=combobox] input').first().inputValue();
      if (period !== 'Last 12 Months') throw new HttpError(502, `Payments shows "${period}", not Last 12 Months`);
      const f = await costcoDownload(page);
      files.push(ctx.save(`Costco payments last 12 months ${localDate()}.csv`, f.bytes));
      said.push(`Payments, Last 12 Months: ${lines(f.bytes) - 1} rows`);
    }
    if (want.includes('unpaid-items')) {
      await page.getByRole('radio', { name: 'Unpaid Items', exact: true }).click();
      await costcoIdle(page);
      const f = await costcoDownload(page), total = /Total Balance\s*\r?\n[^,]*,\s*([-\d.]+)/.exec(f.bytes.toString('utf8'));
      files.push(ctx.save(`Costco unpaid items ${localDate()}.csv`, f.bytes));
      said.push(`Unpaid Items: ${lines(f.bytes) - 3} rows${total ? `, total balance ${total[1]}` : ''}`);
    }
    return { files, text: `Costco Vendor Accounting Portal as ${p.sys.username}: ${said.join('; ')}; ${fetched(ctx)}.` };
  }),
});

// ---- Burlington, on Traverse: user name and password; the invoice search takes its criteria in the page's address.

async function burlingtonSignIn(p: Portal) {
  const { page, sys } = p;
  await page.goto(sys.url!, { waitUntil: 'domcontentloaded' });
  const pass = page.locator('#password, input[type=password]').first();
  await pass.waitFor();
  await page.locator('#username, input[type=text], input[type=email]').first().fill(sys.username!);
  await pass.fill(password(sys));
  await pass.press('Enter');
  const state = await until(STEP, { in: async () => /#\/home/.test(page.url()), refused: async () => /invalid|incorrect|locked/i.test(await pageText(page)) });
  if (state !== 'in') throw new HttpError(502, `the sign-in was not taken: "${(await pageText(page)).slice(0, 160)}"`);
}

registerTest('burlington', async s => withPortal(s, null, async p => { await burlingtonSignIn(p); return `Signed in to Burlington's Traverse portal as ${s.username}.`; }));

register({
  name: 'burlington-invoice', system: 'burlington',
  summary: 'Burlington (Traverse) Invoice Inquiry: the invoices with these numbers, exported as csv, with their status, check number and date.',
  params: [{ name: 'invoice', hint: 'an invoice number; repeat for several', required: true, many: true }],
  run: ctx => withPortal(ctx.need('burlington'), ctx, async p => {
    const { page, sys } = p, wanted = ctx.args.invoice.map(s => s.trim());
    for (const n of wanted) if (!/^[\w-]+$/.test(n)) throw new HttpError(400, `"${n}" is not an invoice number`);
    await burlingtonSignIn(p);
    await page.goto(`${new URL(sys.url!).origin}/#/search/invoice?fnc_invoice_num=${encodeURIComponent(wanted.join(','))}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' }); // the search runs from the address only on a fresh load
    const state = await until(2 * STEP, { found: () => shown(page.getByText(/Viewing \d+ - \d+ of \d+ records/)), none: () => shown(page.getByText(/No results/i)) });
    if (state === 'none') throw new HttpError(404, `Burlington has no invoice ${wanted.join(', ')}`);
    if (!state) throw new HttpError(504, 'the invoice search did not finish');
    const f = await download(page, () => page.getByText(/^\s*Export to CSV\s*$/i).filter({ visible: true }).first().click());
    const found = f.bytes.toString('utf8').split(/\r?\n/).slice(1).filter(l => l.trim()).map(l => l.split(',')[0].replace(/^'/, ''));
    const lost = wanted.filter(n => !found.includes(n));
    const saved = ctx.save(`Burlington invoices ${wanted.length > 3 ? `${wanted.length} numbers` : wanted.join(' ')} ${localDate()}.csv`, f.bytes);
    return { files: [saved], text: `Burlington Invoice Inquiry for ${wanted.join(', ')}: ${found.length} row${found.length === 1 ? '' : 's'}${lost.length ? `; not found: ${lost.join(', ')}` : ''}; ${fetched(ctx)}.` };
  }),
});

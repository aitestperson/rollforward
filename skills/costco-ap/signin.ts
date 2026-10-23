import { HttpError } from '../../src/store.ts';
import { password } from '../../src/systems.ts';
import { enterCode, pageText, shown, until, STEP, type Adapter } from '../../src/signin.ts';

// How the server signs in to Costco's Vendor Hub for this skill, with the account in its settings: email, password and the terms box,
// then a PingID passcode by email. PingID may ask again on the way into the Vendor Accounting Portal, which challenge answers.
const PING = /pingidentity|authentication request/i;
const signIn: Adapter = {
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

export default signIn;

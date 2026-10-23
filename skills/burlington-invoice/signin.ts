import { HttpError } from '../../src/store.ts';
import { password } from '../../src/systems.ts';
import { pageText, until, STEP, type Adapter } from '../../src/signin.ts';

// How the server signs in to Burlington's Traverse portal for this skill, with the account in its settings: user name and password;
// its single-page app lands on #/home.
const signIn: Adapter = {
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

export default signIn;

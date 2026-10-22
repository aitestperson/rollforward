import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { HttpError, type Entry, type Instance } from './store.ts';
import { choice, isWrite, password, system, type System } from './systems.ts';

// The agent's browser for the systems in its series' Tool use. It runs in the server, not the agent: the server signs in with the
// system's service account, so the password never reaches the agent, and it stops every request that is a write (see systems.ts)
// unless a person approved it. The agent drives it with `rf browse SYSTEM ACTION ...`; a write it wants made it proposes as steps,
// which wait for a person, and on approval the server makes them in a browser of its own.

const ACTION_MS = 30_000, MAX_ACTIONS = 500, TEXT_MAX = 6000, MAX_ELEMENTS = 200, MAX_STEPS = 50;
const STEP_ACTIONS = ['click', 'type', 'select', 'check', 'press'];

let browser: Promise<Browser> | undefined;
const launch = () => (browser ??= chromium.launch());

export async function closeBrowser() {
  const b = browser;
  browser = undefined;
  await (await b)?.close();
}

type Session = { sys: System; context: BrowserContext; page: Page; writes: boolean; blocked: string[] };
export type Step = { do: string; target?: string; value?: string };

async function openContext(sys: System): Promise<Session> {
  const context = await (await launch()).newContext({ acceptDownloads: true });
  context.setDefaultTimeout(ACTION_MS);
  const origins = new Set([new URL(sys.url).origin, ...sys.extra_origins.map(o => new URL(o).origin)]);
  const s: Session = { sys, context, page: await context.newPage(), writes: false, blocked: [] };
  await context.route('**/*', route => {
    const r = route.request(), u = new URL(r.url());
    if (!/^https?:$/.test(u.protocol)) return route.continue();
    if (!origins.has(u.origin)) {
      s.blocked.push(`Stopped a request to ${u.origin}: the browser stays on ${[...origins].join(', ')}.`);
      return route.abort('blockedbyclient');
    }
    if (!s.writes && isWrite(sys, r.method(), r.url())) {
      s.blocked.push(`Stopped ${r.method()} ${u.pathname}: it is a write to ${sys.name}. Propose it with rf browse ${sys.id} propose, for a person to approve.`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return s;
}

// Waits for a navigation the last action may have started; most actions start none, so only briefly.
const settle = (page: Page) => page.waitForNavigation({ timeout: 3000, waitUntil: 'domcontentloaded' }).catch(() => {});

async function login(s: Session) {
  const { sys, page } = s, passSel = sys.login?.pass || 'input[type=password]';
  s.writes = true; // the sign-in form posts
  try {
    await page.goto(sys.url, { waitUntil: 'domcontentloaded' });
    const pass = page.locator(passSel).first();
    if (!(await pass.count())) return; // no sign-in page
    const user = page.locator(sys.login?.user || 'input:not([type=password]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio])').first();
    if (await user.count()) await user.fill(sys.username);
    await pass.fill(password(sys));
    const nav = settle(page);
    if (sys.login?.submit) await page.locator(sys.login.submit).first().click();
    else await pass.press('Enter');
    await nav;
    if (await page.locator(passSel).count()) throw new HttpError(502, `${sys.name} did not take the service account. Ask an admin to check it under Systems.`);
  } finally {
    s.writes = false;
  }
}

export async function testLogin(sys: System): Promise<string> {
  const s = await openContext(sys);
  try {
    await login(s);
    return `Signed in to ${sys.name} as ${sys.username}: "${await s.page.title()}" at ${s.page.url()}`;
  } finally {
    await s.context.close();
  }
}

// Reads the page; a navigation still going (such as to the error page after a stopped request) destroys the page's context, so wait and read again.
async function look(s: Session): Promise<string> {
  for (let tries = 1; ; tries++) {
    await s.page.waitForLoadState('domcontentloaded').catch(() => {});
    try {
      return await read(s);
    } catch (e) {
      if (tries >= 3 || !/context was destroyed|navigat/i.test((e as Error).message)) throw e;
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

async function read(s: Session): Promise<string> {
  const { page } = s;
  const seen = await page.evaluate(max => {
    for (const e of document.querySelectorAll('[data-rf-ref]')) e.removeAttribute('data-rf-ref');
    const out: any[] = [];
    let n = 0;
    for (const e of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem]') as NodeListOf<any>) {
      const box = e.getBoundingClientRect();
      if (!box.width && !box.height) continue;
      if (++n > max) break;
      e.setAttribute('data-rf-ref', String(n));
      const tag = e.tagName.toLowerCase(), type = (e.getAttribute('type') ?? '').toLowerCase(), name = e.getAttribute('name');
      const label = (e.labels?.[0]?.innerText ?? e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? '').trim().replace(/\s+/g, ' ');
      const text = (e.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const value = type === 'password' ? '' : tag === 'select' ? e.options[e.selectedIndex]?.text ?? '' : tag === 'input' || tag === 'textarea' ? e.value : '';
      const role = tag === 'a' ? 'link' : tag === 'button' || type === 'submit' || e.getAttribute('role') === 'button' ? 'button' : '';
      const named = text || (type === 'submit' ? e.value : '') || label;
      // A selector that finds this element again on a fresh page, for steps the agent proposes.
      const sel = e.id ? `#${CSS.escape(e.id)}` : name ? `${tag}[name="${name}"]` : role && named ? `role=${role}[name="${named.replace(/"/g, '\\"')}"]` : '';
      out.push({ n, tag, type, name, label, text, value, role, sel, href: tag === 'a' ? e.getAttribute('href') : '', options: tag === 'select' ? [...e.options].map((o: any) => o.text) : undefined });
    }
    return { title: document.title, text: document.body?.innerText ?? '', els: out };
  }, MAX_ELEMENTS);
  const text = seen.text.trim().replace(/\n{3,}/g, '\n\n');
  const el = (e: any) => {
    const what = e.role === 'link' ? `link "${e.text}" → ${e.href}` : e.role === 'button' ? `button "${e.text || e.value || e.label}"`
      : e.tag === 'select' ? `select${e.name ? ` name=${e.name}` : ''}${e.label ? ` "${e.label}"` : ''} = "${e.value}" (options: ${e.options.join(' | ')})`
      : `${e.tag === 'input' ? `input ${e.type || 'text'}` : e.tag}${e.name ? ` name=${e.name}` : ''}${e.label ? ` "${e.label}"` : ''}${e.type === 'password' ? ' (password: the server fills it)' : ` value="${e.value}"`}`;
    return `[${e.n}] ${what}${e.sel ? `   {${e.sel}}` : ''}`;
  };
  return `${s.sys.name} · ${seen.title} — ${page.url()}\n\n${text.slice(0, TEXT_MAX)}${text.length > TEXT_MAX ? `\n… (${text.length - TEXT_MAX} more characters)` : ''}`
    + `\n\nElements: use the number in click, type, select and download, and the {selector} in propose.\n${seen.els.map(el).join('\n') || '(none)'}`;
}

// A path under the instance's working/, where the agent's files go.
function workingFile(instDir: string, file: string | undefined): string {
  const rel = posix.normalize(String(file ?? '').replace(/^working\//, ''));
  if (!file || rel.startsWith('..') || rel.startsWith('/') || /^[a-z]:/i.test(rel)) throw new HttpError(400, 'FILE is a path under your working/, such as "E1 vouchers 09.06.2026.csv"');
  const path = join(instDir, 'working', rel);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function parseSteps(spec: unknown): { start: string; steps: Step[] } {
  const s = spec as { start?: unknown; steps?: unknown };
  if (!s || typeof s.start !== 'string' || !Array.isArray(s.steps) || !s.steps.length || s.steps.length > MAX_STEPS)
    throw new HttpError(400, `STEPS is JSON: {"start": "/path/of/the/form", "steps": [{"do": "type", "target": "input[name=\\"invoice\\"]", "value": "HF-23001"}, {"do": "click", "target": "role=button[name=\\"Save\\"]"}]}, with 1 to ${MAX_STEPS} steps`);
  const steps = s.steps.map((x: any, i: number) => {
    if (!STEP_ACTIONS.includes(x?.do)) throw new HttpError(400, `step ${i + 1}: "do" is one of ${STEP_ACTIONS.join(', ')}`);
    if (x.do !== 'press' && (typeof x.target !== 'string' || !x.target)) throw new HttpError(400, `step ${i + 1}: needs a "target" selector, from look`);
    if (['type', 'select', 'press'].includes(x.do) && typeof x.value !== 'string') throw new HttpError(400, `step ${i + 1}: needs a "value"`);
    return { do: x.do, ...(x.target && { target: x.target }), ...(x.value !== undefined && { value: String(x.value) }) };
  });
  return { start: s.start, steps };
}

// One run's use of the browser: a session per system, closed when the run ends.
export class Browsing {
  sessions = new Map<string, Session>();
  actions = 0;
  inst: Instance;
  tools: string[];
  constructor(inst: Instance, tools: string[]) {
    this.inst = inst;
    this.tools = tools;
  }

  private allowed(name: string): System {
    const c = choice(name), sys = system(name);
    if (!c || !this.tools.includes(c.id)) throw new HttpError(403, `${name} is not in this series' Tool use${this.tools.length ? `; it has ${this.tools.map(t => choice(t)?.name ?? t).join(', ')}` : ', which is empty'}.`);
    if (!sys) throw new HttpError(409, `${c.name} is chosen for this series but not set up yet: an admin adds its address and service account under Systems.`);
    return sys;
  }

  private async session(sys: System): Promise<Session> {
    let s = this.sessions.get(sys.id);
    if (!s) {
      s = await openContext(sys);
      this.sessions.set(sys.id, s);
      await login(s);
    }
    return s;
  }

  async command(name: string, action: string, args: string[]): Promise<{ status: number; text: string }> {
    const sys = this.allowed(name);
    if (++this.actions > MAX_ACTIONS) throw new HttpError(429, `this run has used its ${MAX_ACTIONS} browser actions`);
    if (action === 'propose') return this.propose(sys, args[0], args[1]);
    const s = await this.session(sys), { page } = s;
    const ref = (n: string | undefined) => {
      if (!/^\d+$/.test(n ?? '')) throw new HttpError(400, `${action} takes an element number from look`);
      return page.locator(`[data-rf-ref="${n}"]`).first();
    };
    const gone = async (l: ReturnType<typeof ref>) => { if (!(await l.count())) throw new HttpError(400, `element ${args[0]} is gone; run look again`); return l; };
    this.inst.append('agent', 'browse', { system: sys.id, action, args: action === 'type' ? [args[0], '…'] : args });
    let note = '';
    switch (action) {
      case 'open': await page.goto(new URL(args[0] || '/', sys.url).href, { waitUntil: 'domcontentloaded' }).catch(() => {}); break;
      case 'look': break;
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); break;
      case 'click': {
        const l = await gone(ref(args[0])), nav = settle(page);
        await l.click();
        await nav;
        break;
      }
      case 'type': {
        const l = await gone(ref(args[0]));
        if ((await l.getAttribute('type'))?.toLowerCase() === 'password') throw new HttpError(403, 'the server fills password fields itself');
        await l.fill(args.slice(1).join(' '));
        return { status: 200, text: `Typed into [${args[0]}].` };
      }
      case 'select': {
        const l = await gone(ref(args[0])), v = args.slice(1).join(' ');
        await l.selectOption({ label: v }).catch(() => l.selectOption(v));
        return { status: 200, text: `Selected "${v}" in [${args[0]}].` };
      }
      case 'press': { const nav = settle(page); await page.keyboard.press(args[0] ?? 'Enter'); await nav; break; }
      case 'download': {
        const path = workingFile(this.inst.dir, args[1]);
        if (/^\d+$/.test(args[0] ?? '')) {
          const l = await gone(ref(args[0])), [dl] = await Promise.all([page.waitForEvent('download'), l.click()]);
          await dl.saveAs(path);
        } else {
          // A link that opens in the page rather than downloading: read it with the session's cookies. Reads only, and only from the system.
          const u = new URL(args[0] ?? '', page.url().startsWith('http') ? page.url() : sys.url);
          if (u.origin !== new URL(sys.url).origin) throw new HttpError(403, `${u.origin} is outside ${sys.name}`);
          const r = await s.context.request.get(u.href);
          if (!r.ok()) throw new HttpError(502, `${sys.name} answered ${r.status()} for ${u.pathname}`);
          writeFileSync(path, await r.body());
        }
        return { status: 200, text: `Saved working/${posix.normalize(args[1].replace(/^working\//, ''))}.` };
      }
      case 'screenshot':
        await page.screenshot({ path: workingFile(this.inst.dir, args[0]), fullPage: true });
        return { status: 200, text: `Saved working/${args[0]}.` };
      default: throw new HttpError(400, `rf browse SYSTEM open [PATH] | look | click N | type N TEXT | select N OPTION | press KEY | back | download N|PATH FILE | screenshot FILE | propose "WHAT" STEPS.json`);
    }
    if (s.blocked.length) note = s.blocked.splice(0).join('\n') + '\n\n';
    return { status: 200, text: note + (await look(s)) };
  }

  private async propose(sys: System, description: string | undefined, stepsJson: string | undefined): Promise<{ status: number; text: string }> {
    if (!description?.trim()) throw new HttpError(400, 'propose takes a one-line description of the write, then the steps');
    let spec;
    try { spec = JSON.parse(stepsJson ?? ''); } catch { spec = undefined; }
    const { start, steps } = parseSteps(spec);
    const id = `r${this.inst.log.length + 1}`, dir = join(this.inst.dir, 'calls');
    mkdirSync(dir, { recursive: true });
    const s = this.sessions.get(sys.id);
    let screenshot: string | null = null;
    if (s) {
      await s.page.screenshot({ path: join(dir, `${id}.png`), fullPage: true }).then(() => { screenshot = `calls/${id}.png`; }, () => {});
    }
    this.inst.append('agent', 'request', { request: id, system: sys.id, name: sys.name, description: description.trim(), start, steps, screenshot });
    return { status: 202, text: `Held for a person's approval as ${id}. Nothing was sent. Their approve or reject arrives as a log entry; once approved, the server makes the steps and logs a call entry with the outcome and a screenshot.` };
  }

  async close() {
    await Promise.all([...this.sessions.values()].map(s => s.context.close().catch(() => {})));
    this.sessions.clear();
  }
}

export function pendingRequests(inst: Instance): Entry[] {
  const decided = new Set(inst.log.filter(e => e.op === 'approve' || e.op === 'reject').map(e => e.request));
  return inst.log.filter(e => e.op === 'request' && !decided.has(e.request));
}

export function rejectPending(inst: Instance, reason: string) {
  for (const r of pendingRequests(inst)) inst.append('server', 'reject', { request: r.request, reason });
}

// A person's decision on a proposed write. On approval the server signs in afresh, opens the start page and makes the steps, with
// writes let through for those steps alone, then logs what happened with a screenshot.
export async function decide(inst: Instance, id: string, by: string, approve: boolean, tools: string[]) {
  const req = pendingRequests(inst).find(e => e.request === id);
  if (!req) throw new HttpError(409, `${id} is not waiting for a decision`);
  if (!approve) return void inst.append(by, 'reject', { request: id });
  const sys = system(String(req.system));
  if (!sys || !tools.includes(sys.id)) throw new HttpError(409, `${req.name} is no longer in this series' Tool use; reject the request instead`);
  inst.append(by, 'approve', { request: id });
  const s = await openContext(sys), shot = `calls/${id}.result.png`;
  let error: string | undefined, done = 0;
  try {
    await login(s);
    await s.page.goto(new URL(String(req.start), sys.url).href, { waitUntil: 'domcontentloaded' });
    s.writes = true;
    for (const step of req.steps as Step[]) {
      const l = step.target ? s.page.locator(step.target).first() : undefined, nav = ['click', 'press'].includes(step.do) ? settle(s.page) : undefined;
      if (step.do === 'click') await l!.click();
      if (step.do === 'type') await l!.fill(step.value!);
      if (step.do === 'select') await l!.selectOption({ label: step.value! }).catch(() => l!.selectOption(step.value!));
      if (step.do === 'check') await l!.check();
      if (step.do === 'press') await (l ? l.press(step.value!) : s.page.keyboard.press(step.value!));
      await nav;
      done++;
    }
  } catch (e) {
    error = `step ${done + 1}: ${(e as Error).message.split('\n')[0]}`;
  }
  s.writes = false;
  await s.page.screenshot({ path: join(inst.dir, shot), fullPage: true }).catch(() => {});
  const text = (await s.page.locator('body').innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 600), url = s.page.url();
  await s.context.close().catch(() => {});
  inst.append('server', 'call', { request: id, system: sys.id, name: sys.name, ok: !error, steps: done, url, text, screenshot: shot, ...(error && { error }) });
}

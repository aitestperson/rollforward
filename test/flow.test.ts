import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem } from '../src/system.ts';
import { createInstance, type Instance } from '../src/store.ts';
import { saveSystem } from '../src/systems.ts';
import { Browsing, closeBrowser } from '../src/browser.ts';
import { flowLookup } from '../src/skills.ts';
import type { Flow } from '../src/flow.ts';

// A stand-in site behind a sign-in: a report page whose period is chosen by a button and which exports a csv, a search that posts,
// and a form whose post is a write.
const PASS = 'S3rvice!pw';
const tmp = mkdtempSync(join(tmpdir(), 'rf-flow-'));
let site: Server, url = '', inst: Instance, b: Browsing;
const posted: string[] = [];

async function form(req: IncomingMessage) {
  let s = '';
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

function standIn(): Server {
  const sessions = new Set<string>();
  return createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x'), sid = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const html = (title: string, body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`);
    if (req.method === 'POST') posted.push(u.pathname);
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = await form(req);
      if (f.get('username') !== 'svc' || f.get('password') !== PASS) return html('Sign in', '<p>Wrong.</p>');
      const id = String(Math.random()).slice(2);
      sessions.add(id);
      return void res.writeHead(302, { location: '/home', 'set-cookie': `sid=${id}; Path=/` }).end();
    }
    if (!sid || !sessions.has(sid)) {
      if (u.pathname !== '/login') return void res.writeHead(302, { location: '/login' }).end();
      return html('Sign in', '<form method="post" action="/login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>');
    }
    const q = u.searchParams.get('q') ?? '';
    if (u.pathname === '/home') return html('Home', '<a href="/reports">Reports</a>');
    if (u.pathname === '/reports') {
      if (q === 'none') return html('Reports', '<p>No results</p>');
      return html('Reports', `<div id="busy">Loading…</div><div id="out" hidden><p>Results for ${q}</p>
        <label>Period <input id="period" value="Last 90 Days"></label> <button onclick="period.value='Last 12 Months'">Last 12 Months</button>
        <input id="note"> <span hidden>Export CSV</span> <a href="/export.csv?q=${encodeURIComponent(q)}" onclick="this.href += '&period=' + encodeURIComponent(period.value) + '&note=' + encodeURIComponent(note.value)">Export CSV</a></div>
        <script>setTimeout(() => { busy.remove(); out.hidden = false; }, 300)</script>`);
    }
    if (u.pathname === '/export.csv') return void res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' })
      .end(`q,period,note\n${q},${u.searchParams.get('period')},${u.searchParams.get('note')}\n`);
    if (u.pathname === '/search' && req.method === 'GET') return html('Search', '<form method="post" action="/search"><input name="q" value="x"><button>Search</button></form>');
    if (u.pathname === '/search' && req.method === 'POST') return html('Search', '<p>Found 2</p>');
    if (u.pathname === '/save' && req.method === 'GET') return html('Save', '<form method="post" action="/save"><button>Save</button></form>');
    if (u.pathname === '/save' && req.method === 'POST') return html('Saved', '<p>Saved.</p>');
    res.writeHead(404).end();
  });
}

const flows: Record<string, Flow> = {
  'demo/report': { connection: 'e1', vars: ['q'], steps: [
    { goto: '/reports?q={q}' },
    { wait: { gone: '#busy' } },
    { wait: { text: '/^Results for/' } },
    { click: { role: 'button', name: 'Last 12 Months' } },
    { expect: { css: '#period' }, value: 'Last 12 Months' },
    { fill: { css: '#note' }, value: '{note}' },
    { download: { text: 'Export CSV' }, save: 'Report {q} {today}.csv' },
  ] },
  'demo/none': { connection: 'e1', steps: [{ goto: '/reports?q=none' }, { stop_if: { text: '/No results/i' }, message: 'nothing for none' }] },
  'demo/search': { connection: 'e1', steps: [{ goto: '/search' }, { click: { role: 'button', name: 'Search' } }, { wait: { text: 'Found 2' }, timeout: 3000 }] },
  'demo/search-allowed': { connection: 'e1', reads_that_post: ['POST */search'], steps: [{ goto: '/search' }, { click: { role: 'button', name: 'Search' } }, { wait: { text: 'Found 2' } }] },
  'demo/save': { connection: 'e1', reads_that_post: ['POST */search'], steps: [{ goto: '/save' }, { click: { role: 'button', name: 'Save' } }, { wait: { text: 'Saved.' }, timeout: 3000 }] },
  'other/thing': { connection: 'dms', steps: [{ goto: '/' }] },
};
const lookup = (name: string) => {
  if (!flows[name]) throw new Error(`no flow ${name}`);
  return { flow: flows[name], vars: { note: 'from settings' } };
};
const runFlow = (name: string, ...vars: string[]) => b.command('e1', 'run', [name, ...vars.flatMap(v => ['--var', v])]);

before(async () => {
  initSystem(tmp);
  site = standIn();
  await new Promise<void>(ok => site.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  saveSystem('e1', { name: 'E1', url: `${url}/login`, username: 'svc', password: PASS }, 'admin');
  const seriesDir = join(tmp, 'demo', 'Weekly');
  mkdirSync(seriesDir, { recursive: true });
  inst = createInstance(seriesDir, 'w1', 'admin@demo.test');
  b = new Browsing(inst, ['e1'], lookup);
});

after(async () => {
  await b.close();
  await closeBrowser();
  site.close();
  site.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('a flow signs in, waits, clicks, checks, fills and downloads into working/, with --var and the skill\'s settings', async () => {
  const r = await runFlow('demo/report', 'q=acme');
  const today = new Date().toLocaleDateString('sv');
  assert.match(r.text, new RegExp(`Ran demo/report on E1: 7 steps\\. Saved: working/Report acme ${today}\\.csv\\.`));
  assert.equal(readFileSync(join(inst.dir, 'working', `Report acme ${today}.csv`), 'utf8'), 'q,period,note\nacme,Last 12 Months,from settings\n');
  const again = await runFlow('demo/report', 'q=acme', 'note=asked');
  assert.match(again.text, /Report acme .* \(2\)\.csv/, 'a second download never overwrites the first');
  const entry = inst.log.findLast(e => e.op === 'flow')!;
  assert.deepEqual([entry.flow, entry.vars, entry.steps], ['demo/report', { q: 'acme', note: 'asked' }, 7]);
});

test('a flow says what it is missing, stops where the page says so, and leaves a screenshot when it fails', async () => {
  await assert.rejects(runFlow('demo/report'), /the flow needs --var q=…/);
  await assert.rejects(runFlow('demo/none'), (e: any) => e.status === 404 && /step 2 \(stop_if, message\): nothing for none/.test(e.message));
  assert.ok(readdirSync(join(inst.dir, 'working')).some(f => f.startsWith('demo none stopped')), 'a screenshot of where it stopped');
  await assert.rejects(b.command('e1', 'run', ['other/thing']), /other\/thing is a flow for dms, not e1/);
});

test('a flow makes no write: a post is stopped unless the flow names it as a read, and only while that flow runs', async () => {
  posted.length = 0;
  await assert.rejects(runFlow('demo/search'), /Stopped POST \/search: it is a write to E1/);
  assert.ok(!posted.includes('/search'), 'nothing reached the site');
  assert.match((await runFlow('demo/search-allowed')).text, /Ran demo\/search-allowed/);
  assert.ok(posted.includes('/search'));
  await assert.rejects(runFlow('demo/save'), /Stopped POST \/save/);
  assert.ok(!posted.includes('/save'));
  await assert.rejects(runFlow('demo/search'), /Stopped POST \/search/, 'what one flow named does not carry over to the next');
});

test('only the flows of the skills a series chose can run', () => {
  assert.throws(() => flowLookup({})('costco-ap/payments'), /costco-ap is not in this series' Skill use/);
  assert.throws(() => flowLookup({ 'costco-ap': {} })('costco-ap/nope'), /costco-ap has no flow nope; it has payments, unpaid-items/);
  assert.deepEqual(flowLookup({ 'costco-ap': { portal: 'https://portal.test' } })('costco-ap/payments').vars, { portal: 'https://portal.test' });
  assert.ok(!existsSync(join(inst.dir, 'working', 'nothing')));
});

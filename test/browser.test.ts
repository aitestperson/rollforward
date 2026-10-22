import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem } from '../src/system.ts';
import { createInstance, type Instance } from '../src/store.ts';
import { choices, saveSystem, systems, view } from '../src/systems.ts';
import { Browsing, closeBrowser, decide, pendingRequests, rejectPending, testLogin } from '../src/browser.ts';

// A small stand-in for a company system: a sign-in page, a list with a CSV export, and a form whose POST is a write.
const PASS = 'S3rvice!pw';
const vouchers = [{ supplier: 'Harbor Freight Lines', invoice: 'HF-22817', amount: 18420.5 }, { supplier: 'Cobalt Packaging Co', invoice: 'CP-9041', amount: 7395 }];
const tmp = mkdtempSync(join(tmpdir(), 'rf-browse-'));
let sys: Server, other: Server, url = '', otherUrl = '', inst: Instance, b: Browsing;

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
    if (u.pathname === '/login' && req.method === 'POST') {
      const f = await form(req);
      if (f.get('username') !== 'svc' || f.get('password') !== PASS) return html('Sign in', '<p>Wrong.</p><form method="post" action="/login"><input name="username"><input name="password" type="password"></form>');
      const id = String(Math.random()).slice(2);
      sessions.add(id);
      return void res.writeHead(302, { location: '/vouchers', 'set-cookie': `sid=${id}; Path=/` }).end();
    }
    if (!sid || !sessions.has(sid)) {
      if (u.pathname !== '/login') return void res.writeHead(302, { location: '/login' }).end();
      return html('Sign in', '<form method="post" action="/login"><label>User <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>');
    }
    const q = u.searchParams.get('supplier') ?? '', rows = vouchers.filter(v => v.supplier.toLowerCase().includes(q.toLowerCase()));
    if (u.pathname === '/vouchers.csv') return void res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="v.csv"' }).end(rows.map(v => `${v.supplier},${v.invoice},${v.amount}`).join('\n'));
    if (u.pathname === '/vouchers' && req.method === 'GET') return html('AP vouchers', `<form><label>Supplier <input name="supplier" value="${q}"></label><button>Find</button></form><ul>${rows.map(v => `<li>${v.supplier} ${v.invoice}</li>`).join('')}</ul><a href="/vouchers.csv?supplier=${encodeURIComponent(q)}">Export CSV</a>`);
    if (u.pathname === '/vouchers/new') return html('Enter voucher', '<form method="post" action="/vouchers"><label>Supplier <input name="supplier"></label><label>Invoice <input name="invoice"></label><label>Amount <input name="amount"></label><button>Save voucher</button></form>');
    if (u.pathname === '/vouchers' && req.method === 'POST') {
      const f = await form(req);
      vouchers.push({ supplier: f.get('supplier')!, invoice: f.get('invoice')!, amount: Number(f.get('amount')) });
      return html('Voucher saved', `<p>Voucher saved for ${f.get('supplier')}.</p>`);
    }
    res.writeHead(404).end();
  });
}

const listen = async (s: Server) => { await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok)); return `http://127.0.0.1:${(s.address() as { port: number }).port}`; };

before(async () => {
  initSystem(tmp);
  url = await listen(sys = standIn());
  otherUrl = await listen(other = standIn());
  saveSystem('e1', { name: 'E1', url, username: 'svc', password: PASS }, 'admin');
  const seriesDir = join(tmp, 'larkfield', 'Weekly');
  mkdirSync(seriesDir, { recursive: true });
  inst = createInstance(seriesDir, 'w1', 'admin@demo.test');
  b = new Browsing(inst, ['e1', 'xts']);
});

after(async () => {
  await b.close();
  await closeBrowser();
  for (const s of [sys, other]) { s.close(); s.closeAllConnections(); }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('E1, DMS and XTS are always offered; one is usable once an admin sets it up, and its password stays sealed', async () => {
  assert.deepEqual(choices().slice(0, 3).map(c => [c.id, c.configured]), [['e1', true], ['dms', false], ['xts', false]]);
  assert.ok(!choices().some(c => c.id.startsWith('m365')), 'the Microsoft 365 apps serve tools; a series does not choose them');
  assert.ok(!readFileSync(join(tmp, '.rf', 'systems.json'), 'utf8').includes(PASS));
  assert.ok(!('password' in view(systems()[0])));
  assert.throws(() => saveSystem(undefined, { name: 'DMS', url, username: 'svc', password: 'x' }, 'admin'), /built in/);
  assert.match(await testLogin(systems()[0]), /Signed in to E1/);
  await assert.rejects(b.command('XTS', 'look', []), /XTS is chosen for this series but not set up yet/);
  await assert.rejects(b.command('DMS', 'look', []), /DMS is not in this series' Tool use; it has E1, XTS/);
});

test('the server signs in; the agent finds and downloads into working/, and never sees the password', async () => {
  let r = await b.command('E1', 'open', ['/vouchers']);
  assert.match(r.text, /AP vouchers/);
  const field = r.text.match(/\[(\d+)\] input text name=supplier/)![1];
  await b.command('e1', 'type', [field, 'Harbor']);
  r = await b.command('e1', 'press', ['Enter']);
  assert.ok(!r.text.includes('Cobalt'), 'the search narrowed the list');
  const csv = r.text.match(/\[(\d+)\] link "Export CSV"/)![1];
  await b.command('e1', 'download', [csv, 'E1 vouchers.csv']);
  assert.match(readFileSync(join(inst.dir, 'working', 'E1 vouchers.csv'), 'utf8'), /HF-22817/);
  await assert.rejects(b.command('e1', 'download', ['/vouchers.csv', '../escape.csv']), /under your working/);
  assert.ok(!JSON.stringify(inst.log).includes(PASS) && !r.text.includes(PASS));
});

test('a write is stopped unless a person approves it; on approval the server makes it', async () => {
  const before = vouchers.length;
  let r = await b.command('e1', 'open', ['/vouchers/new']);
  const n = (name: string) => r.text.match(new RegExp(`\\[(\\d+)\\] input \\w+ name=${name}`))![1];
  for (const [f, v] of [['supplier', 'Cobalt Packaging Co'], ['invoice', 'CP-9100'], ['amount', '1200']]) await b.command('e1', 'type', [n(f), v]);
  r = await b.command('e1', 'click', [r.text.match(/\[(\d+)\] button "Save voucher"/)![1]]);
  assert.match(r.text, /Stopped POST \/vouchers: it is a write to E1/);
  assert.equal(vouchers.length, before, 'nothing reached E1');

  const steps = { start: '/vouchers/new', steps: [
    { do: 'type', target: 'input[name="supplier"]', value: 'Cobalt Packaging Co' }, { do: 'type', target: 'input[name="invoice"]', value: 'CP-9100' },
    { do: 'type', target: 'input[name="amount"]', value: '1200' }, { do: 'click', target: 'role=button[name="Save voucher"]' }] };
  assert.equal((await b.command('e1', 'propose', ['Enter Cobalt invoice CP-9100', JSON.stringify(steps)])).status, 202);
  const [req] = pendingRequests(inst);
  assert.ok(existsSync(join(inst.dir, String(req.screenshot))));
  assert.equal(vouchers.length, before, 'still nothing, until a person decides');
  await decide(inst, String(req.request), 'admin@demo.test', true, ['e1']);
  const made = inst.log.at(-1)!;
  assert.deepEqual([made.op, made.ok, made.steps], ['call', true, 4]);
  assert.match(String(made.text), /Voucher saved for Cobalt Packaging Co/);
  assert.equal(vouchers.at(-1)!.invoice, 'CP-9100');
  await assert.rejects(decide(inst, String(req.request), 'admin@demo.test', true, ['e1']), /not waiting/);

  await b.command('e1', 'propose', ['Another', JSON.stringify(steps)]);
  rejectPending(inst, 'the instance was closed');
  assert.deepEqual(pendingRequests(inst), []);
  assert.equal(vouchers.filter(v => v.invoice === 'CP-9100').length, 1, 'a rejected write sends nothing');
  await assert.rejects(b.command('e1', 'propose', ['x', '{"start": "/", "steps": []}']), /STEPS is JSON/);
});

test('the browser stays on the system\'s own address', async () => {
  const r = await b.command('e1', 'open', [`${otherUrl}/vouchers`]);
  assert.match(r.text, /Stopped a request to http:\/\/127\.0\.0\.1:\d+: the browser stays on/);
});

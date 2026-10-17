import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const series = 'Weekly borrowing base', monthly = 'Monthly rec', renamed = 'Weekly BB';
const weeks = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 6, 5 + 7 * i)).toISOString().slice(0, 10));

const tmp = mkdtempSync(join(tmpdir(), 'rf-')), root = join(tmp, 'data');
let proc: ChildProcess, base: string;

const at = (...parts: string[]) => `/api/larkfield/${parts.map(encodeURIComponent).join('/')}`;
const json = async (path: string) => (await fetch(base + path)).json();
const call = (method: string, path: string, body?: BodyInit) => fetch(base + path, { method, body });
const rfc = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of the RFC 6238 test key
const form = (path: string, fields: Record<string, string>) => fetch(base + path, { method: 'POST', body: new URLSearchParams(fields) });
const accessCli = (...args: string[]) => execFileSync(process.execPath, [join(app, 'src', 'access.ts'), root, ...args], { encoding: 'utf8' });
const code = (secret: string, step = Math.floor(Date.now() / 30_000)) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const key = Buffer.from([...secret].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('').match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const h = createHmac('sha1', key).update(counter).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];
const workspaces = () => json('/api');
const seriesList = async () => (await workspaces()).find((w: { workspace: string }) => w.workspace === 'larkfield').series;
const shown = async (name: string) => (await seriesList()).find((s: { series: string }) => s.series === name);

before(async () => {
  cpSync(join(app, 'demo', 'snapshot'), root, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(tmp, 'home') };
  mkdirSync(env.HOME);
  delete env.OPENROUTER_API_KEY;
  const probe = createServer();
  await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], { env, detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
});

after(async () => {
  process.kill(-proc.pid!, 'SIGTERM');
  await once(proc, 'exit');
  rmSync(tmp, { recursive: true, force: true });
});

test('GET /api lists the series and its instances with statuses', async () => {
  const s = (await seriesList()).find((x: { series: string }) => x.series === series);
  assert.deepEqual(s.instances.map((i: { label: string; status: string }) => [i.label, i.status]), [
    ...weeks.map(w => [w, w === '2026-09-06' ? 'open' : 'closed']),
    ['scratch', 'abandoned'],
  ]);
});

test('a new instance starts from the last closed one; a new series can be made', async () => {
  assert.equal((await call('POST', at(series, '2026-09-13'))).status, 200);
  const { doc, log } = await json(at(series, '2026-09-13'));
  const last = (await json(at(series, '2026-08-30'))).doc;
  assert.equal(doc.status, 'open');
  assert.deepEqual(doc.items.map((i: { id: string }) => i.id), last.items.map((i: { id: string }) => i.id));
  assert.ok(doc.items.every((i: { file: unknown }) => i.file === null));
  assert.equal(log[0].op, 'create');
  assert.equal(log[0].from, '2026-08-30');
  assert.equal(log[0].fetch, true, '08-30 fetched inputs, so the new instance starts a run at once');
  let done;
  for (let i = 0; !done && i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    done = (await json(at(series, '2026-09-13'))).log.find((e: { op: string }) => e.op === 'done');
  }
  assert.ok(done, 'the fetch run ended');

  assert.equal((await call('POST', at(monthly))).status, 200);
  assert.ok(await shown(monthly));
});

test('an upload lands read-only, becomes an item, and starts one run that ends with an error', async () => {
  const bytes = 'a,b\n1,2\n', label = '2026-09-13';
  assert.equal((await call('POST', at(monthly, label))).status, 200);
  assert.equal((await call('POST', `${at(monthly, label, 'upload')}?by=t&pane=in&name=x.csv`, bytes)).status, 200);
  const file = join(root, 'larkfield', monthly, label, 'upload', 'x.csv');
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(statSync(file).mode & 0o222, 0);
  const first = await json(at(monthly, label));
  assert.deepEqual(first.log.slice(-2).map((e: { op: string }) => e.op), ['upload', 'point']);
  assert.equal(first.log.at(-2).sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(first.doc.items.some((i: { file: string; kind: string }) => i.file === 'upload/x.csv' && i.kind === 'input'));

  let done;
  for (let i = 0; !done && i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    done = (await json(at(monthly, label))).log.find((e: { op: string }) => e.op === 'done');
  }
  assert.ok(done, 'run ended');
  assert.ok(done.error, 'no model reachable, so the run carries an error');
  await new Promise(r => setTimeout(r, 1000));
  assert.equal((await json(at(monthly, label))).log.filter((e: { op: string }) => e.op === 'run').length, 1, 'a run that never started is not retried');
});

test('an upload streams to disk as it arrives, and is refused if its instance closes meanwhile', async () => {
  const label = '2026-09-20';
  assert.equal((await call('POST', at(monthly, label))).status, 200);
  let release!: () => void, sent = false;
  const held = new Promise<void>(ok => { release = ok; });
  const body = new ReadableStream({ async pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(1 << 20)); } else { await held; c.close(); } } });
  const upload = fetch(`${base}${at(monthly, label, 'upload')}?by=t&pane=in&name=big.bin`, { method: 'POST', body, duplex: 'half' } as RequestInit);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(readdirSync(join(root, '.tmp')).length, 1, 'the body is being written before it has all arrived');
  assert.equal((await call('POST', at(monthly, label, 'close'))).status, 200);
  release();
  assert.equal((await upload).status, 409);
  assert.deepEqual(readdirSync(join(root, '.tmp')), []);
  assert.ok(!existsSync(join(root, 'larkfield', monthly, label, 'upload', 'big.bin')));
});

test('duplicate copies a closed instance into an open one, once', async () => {
  assert.equal((await call('POST', `${at(series, '2026-09-06', 'duplicate')}?as=x`)).status, 409);
  const copyPath = at(series, '2026-08-30 copy');
  const dup = `${at(series, '2026-08-30', 'duplicate')}?as=${encodeURIComponent('2026-08-30 copy')}`;
  assert.equal((await call('POST', dup)).status, 200);
  const { doc, log } = await json(copyPath);
  assert.equal(doc.status, 'open');
  assert.deepEqual(doc.items, (await json(at(series, '2026-08-30'))).doc.items);
  assert.equal(existsSync(join(root, 'larkfield', series, '2026-08-30 copy', 'session')), false);
  assert.equal(log.at(-1).op, 'duplicate');
  assert.equal(log.at(-1).from, '2026-08-30');
  assert.equal((await call('POST', dup)).status, 409);
});

test('rename moves an open instance and logs it; an existing label is refused', async () => {
  const rename = (label: string, to: string) => call('POST', `${at(series, label, 'rename')}?as=${encodeURIComponent(to)}`);
  assert.equal((await rename('2026-08-30 copy', '2026-08-30 rework')).status, 200);
  assert.equal(existsSync(join(root, 'larkfield', series, '2026-08-30 copy')), false);
  assert.deepEqual((await json(at(series, '2026-08-30 rework'))).log.at(-1).from, '2026-08-30 copy');
  assert.equal((await rename('2026-08-30 rework', '2026-09-06')).status, 409);
});

test('close and abandon end an open instance; a closed one takes no actions', async () => {
  assert.equal((await call('POST', at(series, '2026-09-06', 'close'))).status, 200);
  const closed = await json(at(series, '2026-09-06'));
  assert.equal(closed.doc.status, 'closed');
  assert.equal(closed.log.at(-1).op, 'close');
  for (const action of ['upload', 'steer', 'close', 'abandon'])
    assert.equal((await call('POST', `${at(series, '2026-09-06', action)}?name=y.csv`, 'x')).status, 409, action);

  assert.equal((await call('POST', at(series, '2026-09-13', 'abandon'))).status, 200);
  const ab = await json(at(series, '2026-09-13'));
  assert.equal(ab.doc.status, 'abandoned');
  assert.equal(ab.log.at(-1).op, 'abandon');
});

test('series settings write series.json; a rename moves the folder and rewrites readers', async () => {
  const put = (name: string, body: object) => call('PUT', at(name), JSON.stringify(body));
  assert.equal((await put(monthly, { name: monthly, visible_to: [series] })).status, 200);
  assert.equal((await put(series, { name: series, visible_to: [monthly] })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'larkfield', series, 'series.json'), 'utf8')), { visible_to: [monthly] });
  assert.deepEqual((await shown(series)).visible_to, [monthly]);
  assert.deepEqual((await shown(monthly)).reads, [series]);

  assert.equal((await put(series, { name: renamed, visible_to: [monthly] })).status, 200);
  assert.ok(existsSync(join(root, 'larkfield', renamed, '2026-08-30')));
  assert.ok(!existsSync(join(root, 'larkfield', series)));
  const sessions = globSync('*/session/*.jsonl', { cwd: join(root, 'larkfield', renamed) });
  assert.ok(sessions.length);
  for (const f of sessions) assert.equal(JSON.parse(readFileSync(join(root, 'larkfield', renamed, f), 'utf8').split('\n')[0]).cwd, join(root, 'larkfield', renamed), 'Pi finds a session only under the folder it recorded');
  assert.deepEqual((await shown(monthly)).visible_to, [renamed]);
  assert.deepEqual((await shown(monthly)).reads, [renamed]);

  assert.equal((await put(renamed, { name: monthly, visible_to: [] })).status, 409);
  assert.equal((await put(renamed, { name: series, visible_to: [monthly] })).status, 200);
});

test('a workspace can be made; a workspace or a series is archived and restored, and a renamed series stays archived', async () => {
  const acme = async () => (await workspaces()).find((w: { workspace: string }) => w.workspace === 'Acme');
  assert.equal((await call('POST', '/api/Acme')).status, 200);
  assert.deepEqual(await acme(), { workspace: 'Acme', archived: false, series: [] });
  assert.equal((await call('PUT', '/api/Acme', JSON.stringify({ archived: true }))).status, 200);
  assert.equal((await acme()).archived, true);
  assert.equal((await call('PUT', '/api/Acme', JSON.stringify({ archived: false }))).status, 200);
  assert.equal((await acme()).archived, false);

  const put = (name: string, to: string, archived: boolean) => call('PUT', at(name), JSON.stringify({ name: to, visible_to: [monthly], archived }));
  assert.equal((await put(series, renamed, true)).status, 200);
  assert.equal((await shown(renamed)).archived, true);
  assert.equal((await put(renamed, series, false)).status, 200);
  assert.equal((await shown(series)).archived, false);
});

test('files: uploads download as attachments; paths outside upload/ and working/ are refused', async () => {
  const file = (rel: string) => `/files/larkfield/${encodeURIComponent(series)}/2026-08-30/${encodeURIComponent(rel)}`;
  const name = 'Larkfield AR aging 083026.xlsx';
  const r = await fetch(base + file(`upload/${name}`));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition')!, /^attachment/);
  assert.ok((Buffer.from(await r.arrayBuffer())).equals(readFileSync(join(root, 'larkfield', series, '2026-08-30', 'upload', name))));
  for (const rel of ['upload/../../workspace.json', 'workspace.json', 'log.jsonl'])
    assert.equal((await fetch(base + file(rel))).status, 400, rel);
  symlinkSync('/proc/self/environ', join(root, 'larkfield', series, '2026-08-30', 'working', 'env.txt'));
  assert.equal((await fetch(base + file('working/env.txt'))).status, 400, 'a link out of the instance is refused');
});

test('a cross-site POST is refused, so another web page cannot steer the agent', async () => {
  const r = await fetch(base + at(series, '2026-09-06', 'steer'), { method: 'POST', body: '{"text":"x"}', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('until someone is invited the site is open; then it asks for a name and a code from an authenticator app, and each wrong code doubles the wait before the next try', async () => {
  assert.equal((await fetch(base + '/api')).status, 200);
  writeFileSync(join(root, '.access.json'), JSON.stringify({ alex: { secret: rfc } }));
  assert.equal(code(rfc, 1), '287082', 'the RFC 6238 vector for T=59, so the server agrees with the RFC');
  assert.equal((await fetch(base + '/api')).status, 401);
  assert.match(await (await fetch(base + '/')).text(), /authenticator app/);
  assert.equal(await (await fetch(base + '/agent/workspace')).text(), 'no run for this token', 'the agent API takes its run token instead');
  assert.equal((await form('/login', { name: 'alex', code: 'wrong' })).status, 401);
  assert.equal((await form('/login', { name: 'alex', code: code(rfc) })).status, 429, 'a right code waits out the delay too');
  await new Promise(r => setTimeout(r, 2000));
  const cookie = cookieOf(await form('/login', { name: 'Alex ', code: code(rfc) }));
  assert.equal((await fetch(base + '/api', { headers: { cookie } })).status, 200, 'a name ignores case and spaces');
});

test('an invite link sets up one person, once; revoking them ends their session', async () => {
  const link = accessCli('invite', 'Sam').trim(), secretOf = (page: string) => page.match(/name="secret" value="([A-Z2-7]{32})"/)![1];
  const secret = secretOf(await (await fetch(base + link)).text());
  assert.notEqual(secretOf(await (await fetch(base + link)).text()), secret, 'each view shows a new secret');
  assert.equal((await form(link, { secret, code: 'wrong' })).status, 401);
  const r = await form(link, { secret, code: code(secret) });
  assert.equal(r.status, 200);
  const sam = cookieOf(r);
  assert.equal((await fetch(base + '/api', { headers: { cookie: sam } })).status, 200);
  assert.equal((await fetch(base + link)).status, 404, 'the link works once');
  assert.match(accessCli('list'), /^sam\tset up$/m);
  accessCli('revoke', 'sam');
  assert.equal((await fetch(base + '/api', { headers: { cookie: sam } })).status, 401);
});

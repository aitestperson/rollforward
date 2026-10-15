import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
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
const seriesList = async () => (await json('/api')).find((c: { client: string }) => c.client === 'larkfield').series;
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
  const { workspace, log } = await json(at(series, '2026-09-13'));
  const last = (await json(at(series, '2026-08-30'))).workspace;
  assert.equal(workspace.status, 'open');
  assert.deepEqual(workspace.items.map((i: { id: string }) => i.id), last.items.map((i: { id: string }) => i.id));
  assert.ok(workspace.items.every((i: { file: unknown }) => i.file === null));
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
  assert.ok(first.workspace.items.some((i: { file: string; kind: string }) => i.file === 'upload/x.csv' && i.kind === 'input'));

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

test('duplicate copies a closed instance into an open one, once', async () => {
  assert.equal((await call('POST', `${at(series, '2026-09-06', 'duplicate')}?as=x`)).status, 409);
  const copyPath = at(series, '2026-08-30 copy');
  const dup = `${at(series, '2026-08-30', 'duplicate')}?as=${encodeURIComponent('2026-08-30 copy')}`;
  assert.equal((await call('POST', dup)).status, 200);
  const { workspace, log } = await json(copyPath);
  assert.equal(workspace.status, 'open');
  assert.deepEqual(workspace.items, (await json(at(series, '2026-08-30'))).workspace.items);
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
  assert.equal(closed.workspace.status, 'closed');
  assert.equal(closed.log.at(-1).op, 'close');
  for (const action of ['upload', 'steer', 'close', 'abandon'])
    assert.equal((await call('POST', `${at(series, '2026-09-06', action)}?name=y.csv`, 'x')).status, 409, action);

  assert.equal((await call('POST', at(series, '2026-09-13', 'abandon'))).status, 200);
  const ab = await json(at(series, '2026-09-13'));
  assert.equal(ab.workspace.status, 'abandoned');
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

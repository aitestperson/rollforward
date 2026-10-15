import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, globSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance, duplicateInstance, forget, renameInstance, HttpError, instance, instances, isPerson, safeName, type Entry, type Instance } from './store.ts';
import { startRun, type Run } from './runner.ts';

const root = resolve(process.argv[2]);
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(app, 'web', 'index.html');
const exec = promisify(execFile);
const port = Number(process.argv[3] ?? 8780);
const LIMIT_MS = Number(process.env.RF_LIMIT_MIN ?? 120) * 60_000;

type Active = { inst: Instance; n: number; token: string; run?: Run; sent: number; seen: number; texts: Map<string, number>; interrupted: boolean; done: boolean; cost: number; timer?: NodeJS.Timeout };
const active = new Map<string, Active>();
const byToken = new Map<string, Active>();
const debounce = new Map<string, NodeJS.Timeout>();

function seenBefore(inst: Instance): number {
  return (inst.log.findLast(e => e.op === 'done')?.seen as number | undefined) ?? 0;
}

function pending(inst: Instance, seen: number): Entry[] {
  return inst.log.filter(e => e.seq > seen && isPerson(e) && (['upload', 'answer', 'steer'].includes(e.op) || (e.op === 'create' && e.fetch)));
}

function message(inst: Instance, n: number, entries: Entry[]): string {
  const reads = readable(inst.series()).map(s => `../${s}/`).join(', ');
  return `Instance ${basename(inst.dir)} (folder ${basename(inst.dir)}/), run ${n}.${reads ? ` Series you can read: ${reads}.` : ''} New log entries:\n`
    + entries.map(e => JSON.stringify(e)).join('\n');
}

function visibleTo(seriesDir: string): string[] {
  const p = join(seriesDir, 'series.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).visible_to : [];
}

function readable(seriesDir: string): string[] {
  const name = basename(seriesDir), clientDir = dirname(seriesDir);
  return dirs(clientDir).filter(s => s !== name && visibleTo(join(clientDir, s)).some(v => v === '*' || v === name));
}

function kick(inst: Instance) {
  const a = active.get(inst.series());
  if (a) return a.inst === inst && a.run && flush(a);
  clearTimeout(debounce.get(inst.dir));
  debounce.set(inst.dir, setTimeout(() => { debounce.delete(inst.dir); start(inst); }, 1500));
}

function flush(a: Active) {
  const entries = a.inst.log.filter(e => e.seq > a.sent && e.by !== 'agent');
  if (!pending(a.inst, a.sent).length) return;
  const text = message(a.inst, a.n, entries);
  a.sent = entries.at(-1)!.seq;
  a.texts.set(text, a.sent);
  a.run!.steer(text);
}

async function start(inst: Instance) {
  const series = inst.series();
  const seen = seenBefore(inst);
  if (active.has(series) || inst.doc.status !== 'open' || !pending(inst, seen).length) return;
  const n = inst.log.filter(e => e.op === 'run').length + 1;
  const entries = inst.log.filter(e => e.seq > seen && e.by !== 'agent');
  const text = message(inst, n, entries);
  const a: Active = { inst, n, token: randomUUID(), sent: entries.at(-1)!.seq, seen, texts: new Map([[text, entries.at(-1)!.seq]]), interrupted: false, done: false, cost: 0 };
  active.set(series, a);
  byToken.set(a.token, a);
  inst.append('server', 'run', { run: n, upto: a.sent });
  try {
    a.run = await startRun({
      seriesDir: series, instanceDir: inst.dir, message: text,
      env: { RF_URL: `http://127.0.0.1:${port}`, RF_TOKEN: a.token },
      onEvent: e => {
        if (e.type === 'message_end' && e.message.role === 'assistant') a.cost += e.message.usage.cost.total;
        if (e.type !== 'message_start' || e.message.role !== 'user') return;
        const c = e.message.content;
        const seq = a.texts.get(typeof c === 'string' ? c : c.map(b => (b.type === 'text' ? b.text : '')).join(''));
        if (seq) a.seen = Math.max(a.seen, seq);
      },
    });
  } catch (err) {
    finish(a, true, String(err));
    return;
  }
  flush(a);
  a.timer = setTimeout(async () => {
    a.interrupted = true;
    await a.run!.interrupt().catch(() => {});
    finish(a, true, 'time limit');
  }, LIMIT_MS);
  a.run.settled.then(aborted => finish(a, aborted));
}

function finish(a: Active, aborted: boolean, error?: string) {
  if (a.done) return;
  a.done = true;
  clearTimeout(a.timer);
  byToken.delete(a.token);
  const series = a.inst.series();
  active.delete(series);
  a.run?.stop();
  a.inst.append('server', 'done', { run: a.n, aborted, seen: a.seen, cost: +a.cost.toFixed(4), summary: a.inst.doc.summary ?? null, ...(error && { error }) });
  if (!a.run) return; // it never started, as with a missing API key: wait for the next person action rather than retry at once
  if (!a.interrupted && pending(a.inst, a.seen).length) return void start(a.inst);
  const next = instances(series).find(i => i.doc.status === 'open' && !(a.interrupted && i.dir === a.inst.dir) && pending(i, seenBefore(i)).length);
  if (next) start(next);
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
}

async function agent(req: IncomingMessage, res: ServerResponse, url: URL) {
  const a = byToken.get(req.headers.authorization?.replace('Bearer ', '') ?? '');
  if (!a) throw new HttpError(401, 'no run for this token');
  if (url.pathname === '/agent/workspace' && req.method === 'GET') return send(res, 200, a.inst.doc);
  if (url.pathname === '/agent/workspace' && req.method === 'PUT') return send(res, 200, `saved, rev ${a.inst.put((await body(req)).toString())}`);
  if (url.pathname === '/agent/reply' && req.method === 'POST') return send(res, 200, `replied, seq ${a.inst.append('agent', 'reply', { text: (await body(req)).toString() }).seq}`);
  throw new HttpError(404, 'not found');
}

function dirs(path: string): string[] {
  return existsSync(path) ? readdirSync(path).filter(n => !n.startsWith('.') && statSync(join(path, n)).isDirectory()).sort() : [];
}

function queued(inst: Instance): boolean {
  const a = active.get(inst.series());
  return a?.inst !== inst && inst.doc.status === 'open' && (debounce.has(inst.dir) || (!!a && pending(inst, seenBefore(inst)).length > 0));
}

function questions(inst: Instance): number {
  if (inst.doc.status !== 'open') return 0;
  return inst.doc.items.flatMap(i => i.notes ?? []).filter(n => n.id && n.options && !inst.answered(n.id)).length;
}

function tree() {
  return dirs(root).map(client => ({
    client,
    series: dirs(join(root, client)).map(series => ({
      series, visible_to: visibleTo(join(root, client, series)), reads: readable(join(root, client, series)),
      instances: instances(join(root, client, series)).map(i => ({
        label: basename(i.dir), status: i.doc.status, rev: i.doc.rev, running: active.get(i.series())?.inst === i, queued: queued(i), questions: questions(i),
      })),
    })),
  }));
}

function steps(inst: Instance) {
  const dir = join(inst.dir, 'session');
  type Step = { kind: string; text: string; at?: string; result?: string; lines?: number; error?: boolean };
  const out: Step[] = [], calls = new Map<string, Step>();
  for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort() : []) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.type !== 'message') continue;
      const m = e.message;
      if (m.role === 'user') out.push({ kind: 'user', at: e.timestamp, text: typeof m.content === 'string' ? m.content : m.content.map((b: { text?: string }) => b.text ?? '').join('') });
      if (m.role === 'assistant') for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) out.push({ kind: 'say', at: e.timestamp, text: b.text });
        if (b.type === 'toolCall') {
          out.push({ kind: b.name, at: e.timestamp, text: b.arguments.command ?? b.arguments.path ?? JSON.stringify(b.arguments) });
          calls.set(b.id, out.at(-1)!);
        }
      }
      if (m.role === 'toolResult') {
        const text = m.content.map((b: { text?: string }) => b.text ?? '').join('');
        Object.assign(calls.get(m.toolCallId)!, { result: text.slice(0, 4000), lines: text.trimEnd().split('\n').length, error: m.isError });
      }
    }
  }
  return out;
}

async function file(res: ServerResponse, url: URL, preview: boolean) {
  const [client, series, label, ...rest] = url.pathname.split('/').slice(2).map(decodeURIComponent);
  const rel = rest.join('/');
  if (normalize(rel) !== rel || !/^(upload|working)\//.test(rel) || rel.split('/').includes('..')) throw new HttpError(400, 'bad path');
  const path = join(root, safeName(client), safeName(series), safeName(label), rel);
  if (!existsSync(path)) throw new HttpError(404, 'no such file');
  if (preview) {
    const { stdout } = await exec(join(app, '.venv', 'bin', 'python'), [join(app, 'src', 'preview.py'), path], { timeout: 30_000, maxBuffer: 64e6 });
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(stdout);
  }
  const image = rel.match(/\.(png|jpe?g|gif|webp|svg)$/i)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('svg', 'svg+xml');
  res.writeHead(200, {
    'content-type': image ? `image/${image}` : 'application/octet-stream', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'content-disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(rel))}`,
  });
  createReadStream(path).pipe(res);
}

async function people(req: IncomingMessage, res: ServerResponse, url: URL) {
  const [client, series, label, action] = url.pathname.split('/').slice(2).map(s => safeName(decodeURIComponent(s)));
  const seriesDir = join(root, client, series);
  const by = url.searchParams.get('by') ?? 'someone';
  if (!label) {
    if (req.method === 'POST') {
      mkdirSync(seriesDir, { recursive: true });
      return send(res, 200, 'ok');
    }
    if (req.method === 'PUT') {
      const { name, visible_to } = JSON.parse((await body(req)).toString());
      if (!Array.isArray(visible_to) || !visible_to.every(n => typeof n === 'string')) throw new HttpError(400, 'visible_to must be a list of series names');
      const to = safeName(name), clientDir = join(root, client), updates = new Map([[seriesDir, visible_to]]);
      if (to !== series) {
        if (existsSync(join(clientDir, to))) throw new HttpError(409, `${to} exists`);
        if (active.has(seriesDir) || instances(seriesDir).some(i => debounce.has(i.dir))) throw new HttpError(409, 'wait for the run to end');
        for (const s of dirs(clientDir)) {
          const v = visibleTo(join(clientDir, s));
          if (v.includes(series)) updates.set(join(clientDir, s), v.map(n => (n === series ? to : n)));
        }
      }
      for (const [dir, names] of updates) {
        const p = join(dir, 'series.json');
        writeFileSync(p + '.tmp', JSON.stringify({ visible_to: names }, null, 1), { mode: 0o444 });
        renameSync(p + '.tmp', p);
      }
      if (to !== series) {
        const dir = resolve(clientDir, to);
        renameSync(seriesDir, dir);
        forget(seriesDir);
        for (const f of globSync('*/session/*.jsonl', { cwd: dir })) {
          const text = readFileSync(join(dir, f), 'utf8'), nl = text.indexOf('\n');
          writeFileSync(join(dir, f), JSON.stringify({ ...JSON.parse(text.slice(0, nl)), cwd: dir }) + text.slice(nl));
        }
      }
      return send(res, 200, 'ok');
    }
    return send(res, 200, instances(seriesDir).map(i => ({ label: basename(i.dir), status: i.doc.status, running: active.get(seriesDir)?.inst === i })));
  }
  if (!action && req.method === 'POST') {
    const created = createInstance(seriesDir, label, by);
    kick(created);
    return send(res, 200, created.doc);
  }
  const dir = join(seriesDir, label);
  if (!existsSync(join(dir, 'workspace.json'))) throw new HttpError(404, `no instance ${label}`);
  const inst = instance(dir);
  const a = active.get(seriesDir);
  const mine = a?.inst === inst ? a : undefined;
  if (!action) return send(res, 200, { workspace: inst.doc, log: inst.log, run: mine ? { n: mine.n, cost: +mine.cost.toFixed(4) } : null, queued: queued(inst) });
  if (action === 'steps') return send(res, 200, steps(inst));
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (action === 'duplicate') {
    if (inst.doc.status === 'open') throw new HttpError(409, 'only a closed or abandoned instance can be duplicated');
    return send(res, 200, duplicateInstance(inst, url.searchParams.get('as') ?? '', by).doc);
  }
  if (inst.doc.status !== 'open') throw new HttpError(409, `instance is ${inst.doc.status}`);
  if (action === 'upload') {
    const pane = url.searchParams.get('pane') === 'out' ? 'out' : 'in';
    inst.upload(by, url.searchParams.get('name') ?? 'file', await body(req), pane, url.searchParams.get('onto'));
  } else if (action === 'answer') {
    const { note, choice } = JSON.parse((await body(req)).toString());
    inst.answer(by, note, choice);
  } else if (action === 'steer') {
    inst.append(by, 'steer', { text: JSON.parse((await body(req)).toString()).text });
  } else if (action === 'interrupt') {
    if (!mine?.run) throw new HttpError(409, 'no run going');
    inst.append(by, 'interrupt');
    mine.interrupted = true;
    await mine.run.interrupt();
    return send(res, 200, 'ok');
  } else if (action === 'rename') {
    if (mine || debounce.has(inst.dir)) throw new HttpError(409, 'wait for the run to end');
    const label = url.searchParams.get('as') ?? '';
    renameInstance(inst, label).append(by, 'rename', { from: basename(inst.dir) });
    return send(res, 200, 'ok');
  } else if (action === 'close' || action === 'abandon') {
    if (mine) throw new HttpError(409, 'wait for the run to end');
    inst[action](by);
    return send(res, 200, 'ok');
  } else throw new HttpError(404, `no action ${action}`);
  kick(inst);
  send(res, 200, 'ok');
}

createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(page));
    } else if (url.pathname === '/api') send(res, 200, tree());
    else if (url.pathname.startsWith('/files/')) await file(res, url, false);
    else if (url.pathname.startsWith('/preview/')) await file(res, url, true);
    else if (url.pathname.startsWith('/agent/')) await agent(req, res, url);
    else if (url.pathname.startsWith('/api/')) await people(req, res, url);
    else throw new HttpError(404, 'not found');
  } catch (err) {
    send(res, err instanceof HttpError ? err.status : 500, (err as Error).message);
  }
}).listen(port, process.env.RF_HOST ?? '127.0.0.1', () => console.log(`rollforward on http://${process.env.RF_HOST ?? '127.0.0.1'}:${port}, data in ${root}`));

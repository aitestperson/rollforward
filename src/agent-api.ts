import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { HttpError, type Instance } from './store.ts';
import { Browsing, workingFile } from './browser.ts';
import { filesGet, filesList, mailFind, mailSave, type Args } from './m365.ts';
import { seriesSettings } from './series.ts';
import { flowLookup, skill, unset } from './skills.ts';
import { choice, kindOf, system, type System } from './systems.ts';

// The agent's use of its series' connections and skills, behind `rf`: shared by the server, for runs, and by `cli.ts try`, which
// lets an admin run a skill's steps without the model.
//   GET  /agent/connections        what the series may use, and how
//   GET  /agent/settings?skill=ID  a chosen skill's settings in this series, as JSON
//   POST /agent/files {args}       rf files list|get …
//   POST /agent/mail {args}        rf mail find|save …
//   POST /agent/browse {system, action, args}   rf browse …, and run SKILL/FLOW

export type AgentRun = { inst: Instance; browsing?: Browsing };

// Parses `--name value` pairs, where a name may repeat, and a bare `--flag` (followed by another --name or nothing) as "true".
export function parseArgs(words: string[]): { args: Args; rest: string[] } {
  const args: Args = {}, rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/s.exec(words[i]);
    if (!m) { rest.push(words[i]); continue; }
    const v = m[2] ?? (words[i + 1] === undefined || words[i + 1].startsWith('--') ? 'true' : words[++i]);
    (args[m[1]] ??= []).push(v);
  }
  return { args, rest };
}

// A connection of the series' Tool use that is ready, of the kind asked.
function connection(seriesDir: string, id: string, what: string): System {
  const c = choice(id), chosen = seriesSettings(seriesDir).tools;
  if (!c || !chosen.includes(c.id)) throw new HttpError(403, `${c?.name ?? id} is not in this series' Tool use, so ${what} can't be used`);
  const s = system(c.id);
  if (!s) throw new HttpError(409, `${c.name} is chosen for this series but not set up yet: an admin sets it up under Systems`);
  return s;
}

export function connectionsText(seriesDir: string): string {
  const set = seriesSettings(seriesDir), lines: string[] = [];
  for (const id of set.tools) {
    const c = choice(id), s = system(id);
    if (!c) continue;
    if (!s) { lines.push(`${c.name}: chosen but not set up yet, so not usable`); continue; }
    lines.push(`${s.name}: ${id === 'm365-files' ? 'rf files list|get' : id === 'm365-mail' ? 'rf mail find|save' : kindOf(s) === 'web' ? `rf browse ${s.id} (${s.url})` : ''}`);
  }
  for (const [id, values] of Object.entries(set.skills)) {
    const k = skill(id);
    if (!k) continue;
    const needs = [...unset(k, values).map(l => `its setting "${l}"`), ...k.connections.filter(c => !set.tools.includes(c) || !system(c)).map(c => `${choice(c)?.name ?? c} in Tool use, set up`)];
    lines.push(`Skill ${k.name}${needs.length ? ` (needs ${needs.join(', ')})` : ''}: rf settings ${id}${k.flows.length ? `; flows ${k.flows.map(f => `${id}/${f}`).join(', ')}` : ''}`);
  }
  return lines.join('\n') || 'Nothing: this series\' Tool use and Skill use are empty.';
}

// The agent API on a port of its own, for one stand-in run: what `cli.ts try` and the tests use in place of the server.
export async function serveAgent(a: AgentRun): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x'), send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json' }).end(typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    try {
      if (req.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, 'no run for this token');
      const r = await agentCall(a, url.pathname, req.method ?? 'GET', url.searchParams, async () => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c); });
      if (!r) throw new HttpError(404, 'not found');
      send(r.status, r.data);
    } catch (e) {
      send((e as HttpError).status ?? 500, (e as Error).message);
    }
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token,
    async close() { await a.browsing?.close(); server.close(); server.closeAllConnections(); },
  };
}

export async function agentCall(a: AgentRun, path: string, method: string, query: URLSearchParams, body: () => Promise<Buffer>): Promise<{ status: number; data: unknown } | null> {
  const seriesDir = a.inst.series(), working = join(a.inst.dir, 'working');
  const json = async () => { try { return JSON.parse((await body()).toString() || '{}'); } catch { throw new HttpError(400, 'the body is JSON'); } };
  if (path === '/agent/connections' && method === 'GET') return { status: 200, data: connectionsText(seriesDir) };
  if (path === '/agent/settings' && method === 'GET') {
    const chosen = seriesSettings(seriesDir).skills, id = query.get('skill') ?? '';
    if (!id) return { status: 200, data: chosen };
    if (!chosen[id]) throw new HttpError(403, `${id} is not in this series' Skill use; it has ${Object.keys(chosen).join(', ') || 'none'}`);
    return { status: 200, data: chosen[id] };
  }
  if (path === '/agent/files' && method === 'POST') {
    const s = connection(seriesDir, 'm365-files', 'rf files'), { rest } = parseArgs(((await json()).args ?? []).map(String)), [cmd, target, file] = rest;
    mkdirSync(working, { recursive: true });
    if (cmd === 'list' && target) {
      const out = await filesList(s, target);
      a.inst.append('agent', 'files', { action: 'list', target: out.name, items: 'items' in out ? (out.items as unknown[]).length : undefined });
      return { status: 200, data: out };
    }
    if (cmd === 'get' && target && file) {
      const out = await filesGet(s, target, workingFile(a.inst.dir, file));
      a.inst.append('agent', 'files', { action: 'get', name: out.name, modified: out.modified, file: `working/${file.replace(/^working\//, '')}` });
      return { status: 200, data: { ...out, saved: `working/${file.replace(/^working\//, '')}` } };
    }
    throw new HttpError(400, 'rf files list LINK|REF | get LINK|REF FILE');
  }
  if (path === '/agent/mail' && method === 'POST') {
    const s = connection(seriesDir, 'm365-mail', 'rf mail'), { args, rest } = parseArgs(((await json()).args ?? []).map(String));
    if (rest[0] === 'find') {
      const out = await mailFind(s, args);
      a.inst.append('agent', 'mail', { action: 'find', date: out.date, subject: args.subject?.[0], found: out.messages.length });
      return { status: 200, data: out };
    }
    if (rest[0] === 'save' && rest[1]) {
      mkdirSync(working, { recursive: true });
      let name: RegExp | undefined;
      try { name = args.name ? new RegExp(args.name[0], 'i') : undefined; } catch { throw new HttpError(400, '--name is a regular expression'); }
      const saved = await mailSave(s, rest[1], name, working, args.prefix?.[0] ?? '');
      a.inst.append('agent', 'mail', { action: 'save', saved });
      return { status: 200, data: { saved } };
    }
    throw new HttpError(400, 'rf mail find [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | save ID [--name REGEX] [--prefix TEXT]');
  }
  if (path === '/agent/browse' && method === 'POST') {
    const { system: name, action, args } = await json(), set = seriesSettings(seriesDir);
    a.browsing ??= new Browsing(a.inst, set.tools, flowLookup(set.skills));
    const r = await a.browsing.command(String(name ?? ''), String(action ?? ''), Array.isArray(args) ? args.map(String) : []);
    return { status: r.status, data: r.text };
  }
  return null;
}

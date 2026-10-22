import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './store.ts';
import { key, readJson, writeJson } from './system.ts';

// The systems the agent may use in a browser, such as E1, DMS or XTS, kept by admins. Each has an address and a shared service
// account; the server keeps the password sealed and types it in itself, so it never reaches the agent. `writes` says which requests
// count as writes ("POST */save*", or a bare URL pattern for any method); with none, every request but GET, HEAD and OPTIONS does.

export type System = {
  id: string; name: string; url: string; username: string; password?: string;
  login?: { user?: string; pass?: string; submit?: string }; writes: string[]; extra_origins: string[];
  updated_by?: string; updated_at?: string;
};

// The company's systems, always offered in Tool use. A series may choose one before an admin has set it up, with its address and
// service account; the agent can use it only once it is.
export const BUILT_IN = [{ id: 'e1', name: 'E1' }, { id: 'dms', name: 'DMS' }, { id: 'xts', name: 'XTS' }];

// The systems set up, with their addresses and service accounts.
export function systems(): System[] {
  return readJson<System[]>('systems.json', []);
}

export function system(id: string): System | undefined {
  const k = id.toLowerCase();
  return systems().find(s => s.id === k || s.name.toLowerCase() === k);
}

// What Tool use offers: the built-in systems, then any others admins added, each saying whether it is set up yet.
export function choices(): { id: string; name: string; configured: boolean }[] {
  const set = systems();
  return [...BUILT_IN.map(b => set.find(s => s.id === b.id) ?? b), ...set.filter(s => !BUILT_IN.some(b => b.id === s.id))]
    .map(s => ({ id: s.id, name: s.name, configured: 'url' in s }));
}

export function choice(id: string): { id: string; name: string; configured: boolean } | undefined {
  const k = id.toLowerCase();
  return choices().find(c => c.id === k || c.name.toLowerCase() === k);
}

export function view(s: System) {
  const { password, ...rest } = s;
  return { ...rest, has_password: !!password };
}

function seal(text: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key('systems.key'), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}

export function password(s: System): string {
  if (!s.password) return '';
  const [iv, tag, data] = s.password.split('.').map(p => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key('systems.key'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

const lines = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(s => String(s).trim()).filter(Boolean);

export function saveSystem(id: string | undefined, input: Record<string, any>, by: string): System {
  // A built-in system that isn't set up yet is set up by its id, as if it were new.
  const list = systems(), old = id ? list.find(s => s.id === id) : undefined;
  if (id && !old && !BUILT_IN.some(b => b.id === id)) throw new HttpError(404, `no system ${id}`);
  if (id && !old) input = { ...input, id };
  const errors: string[] = [];
  const name = String(input.name ?? '').trim(), url = String(input.url ?? '').trim().replace(/\/$/, ''), username = String(input.username ?? '').trim();
  // The id is what series name in their Tool use, so it never changes once made.
  const sid = old?.id ?? String(input.id ?? name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!name || name.length > 40) errors.push('name: up to 40 characters');
  if (!sid) errors.push('name: needs a letter or a digit');
  if (list.some(s => s.id !== old?.id && (s.id === sid || s.name.toLowerCase() === name.toLowerCase()))) errors.push(`${name} is already in the list`);
  if (!old && !id && BUILT_IN.some(b => b.id === sid)) errors.push(`${name} is built in: set it up from its row instead`);
  if (!/^https?:\/\/[^/]/.test(url)) errors.push('address: an http(s) address, such as https://e1.example.com');
  if (!username) errors.push('service account: a user name');
  const extra = lines(input.extra_origins);
  for (const o of extra) if (!/^https?:\/\/[^/]+$/.test(o)) errors.push(`other address ${o}: only scheme and host, such as https://login.example.com`);
  if (!old?.password && !input.password) errors.push('service account: a password');
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  const login = { user: String(input.login?.user ?? '').trim(), pass: String(input.login?.pass ?? '').trim(), submit: String(input.login?.submit ?? '').trim() };
  const s: System = {
    id: sid, name, url, username, password: input.password ? seal(String(input.password)) : old?.password,
    ...(login.user || login.pass || login.submit ? { login } : {}), writes: lines(input.writes), extra_origins: extra,
    updated_by: by, updated_at: new Date().toISOString(),
  };
  writeJson('systems.json', old ? list.map(x => (x.id === s.id ? s : x)) : [...list, s]);
  return s;
}

export function removeSystem(id: string) {
  const list = systems();
  if (!list.some(s => s.id === id)) throw new HttpError(404, `no system ${id}`);
  writeJson('systems.json', list.filter(s => s.id !== id));
}

const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

export function isWrite(s: System, method: string, url: string): boolean {
  if (!s.writes.length) return !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return s.writes.some(w => {
    const [m, p] = /^[A-Z]+\s+\S/.test(w) ? w.split(/\s+/, 2) : ['*', w];
    return (m === '*' || m === method) && glob(p).test(url);
  });
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './store.ts';
import { key, readJson, writeJson } from './system.ts';

// The systems the agent may use, kept by admins. Three kinds:
// - web: a site the agent, or a tool, uses in a browser the server runs, signed in as a shared service account. The server keeps the
//   password sealed and types it in itself, so it never reaches the agent. `writes` says which requests count as writes ("POST
//   */save*", or a bare URL pattern for any method); with none, every request but GET, HEAD and OPTIONS does.
// - m365: an app registered in Microsoft Entra ID, whose client secret lets the server read OneDrive files or a mailbox through
//   Microsoft Graph. Tools use these; series don't choose them.
// - source: data a tool fetches through an m365 system, such as a OneDrive folder or a mailbox's mail; it holds only settings.
// Company values (addresses, links, ids) live in the data root's .rf/systems.json, set from the Systems page, never in this code.

export type Kind = 'web' | 'm365' | 'source';
export type Field = { key: string; label: string; hint?: string };
export type System = {
  id: string; name: string; kind?: Kind; url?: string; username?: string; password?: string;
  tenant?: string; client_id?: string; settings?: Record<string, string>;
  login?: { user?: string; pass?: string; submit?: string }; writes: string[]; extra_origins: string[];
  updated_by?: string; updated_at?: string;
};
type BuiltIn = { id: string; name: string; kind: Kind; internal?: boolean; uses?: string; fields?: Field[] };

// The company's systems, always offered. A series may choose one before it is set up; a tool or the agent can use it only once it is.
export const BUILT_IN: BuiltIn[] = [
  { id: 'e1', name: 'E1', kind: 'web' },
  { id: 'dms', name: 'DMS', kind: 'web' },
  { id: 'xts', name: 'XTS', kind: 'web' },
  { id: 'm365-mail', name: 'M365 Mail', kind: 'm365', internal: true, fields: [{ key: 'mailbox', label: 'Mailbox', hint: 'The mailbox this app reads, such as a shared inbox or a person\'s' }] },
  { id: 'm365-files', name: 'M365 OneDrive', kind: 'm365', internal: true },
  { id: 'jde-ar', name: 'JDE A/R', kind: 'source', uses: 'm365-files', fields: [
    { key: 'folder_450', label: 'Company 450 folder link', hint: 'A OneDrive or SharePoint link to the folder of AR aging reports; a year folder is followed to the year of the date asked' },
    { key: 'folder_236', label: 'Company 236 folder link' }] },
  { id: 'walmart', name: 'Walmart Retail Link', kind: 'source', uses: 'm365-files', fields: [
    { key: 'file', label: 'Paid History workbook link' }, { key: 'sheets', label: 'Sheets', hint: 'Comma-separated, such as 236, 450' },
    { key: 'date_column', label: 'Date column', hint: 'Such as Date Paid' }, { key: 'days', label: 'Days back', hint: 'Rows dated within this many days up to the date asked' }] },
  { id: 'kohls', name: 'Kohls', kind: 'source', uses: 'm365-mail', fields: [{ key: 'subject', label: 'Subject contains' }] },
  { id: 'target', name: 'Target', kind: 'web', fields: [
    { key: 'otp_mail', label: 'Verification codes arrive in', hint: 'The id of an m365 system, such as m365-mail' },
    { key: 'report', label: 'Report page', hint: 'The address of the Specific Document Search card on Greenfield' }] },
  { id: 'costco', name: 'Costco', kind: 'web', fields: [
    { key: 'otp_mail', label: 'Verification codes arrive in', hint: 'The id of an m365 system, such as m365-mail' },
    { key: 'portal', label: 'Vendor Accounting Portal', hint: 'Its address, opened after signing in to the hub' }] },
  { id: 'burlington', name: 'Burlington', kind: 'web' },
];

export const builtIn = (id: string) => BUILT_IN.find(b => b.id === id);
export const kindOf = (s: { id: string; kind?: Kind }): Kind => s.kind ?? builtIn(s.id)?.kind ?? 'web';

// The systems saved, set up or not.
export function systems(): System[] {
  return readJson<System[]>('systems.json', []);
}

function saved(id: string): System | undefined {
  const k = id.toLowerCase();
  return systems().find(s => s.id === k || s.name.toLowerCase() === k);
}

// What a system still needs before it can be used; empty when it's ready.
export function missing(s: System | undefined, id = s?.id ?? ''): string[] {
  const b = builtIn(id), kind = s ? kindOf(s) : b?.kind ?? 'web', need: string[] = [];
  if (!s) return ['not set up'];
  if (kind === 'web') {
    if (!s.url) need.push('address');
    if (!s.username) need.push('service account');
    if (!s.password) need.push('password');
  }
  if (kind === 'm365') {
    if (!s.tenant) need.push('tenant id');
    if (!s.client_id) need.push('client id');
    if (!s.password) need.push('client secret');
  }
  for (const f of b?.fields ?? []) if (kind !== 'web' && !s.settings?.[f.key]) need.push(f.label.toLowerCase());
  if (b?.uses && missing(saved(b.uses), b.uses).length) need.push(`${builtIn(b.uses)!.name} set up`);
  return need;
}

// A system ready to use, or undefined.
export function system(id: string): System | undefined {
  const s = saved(id);
  return s && !missing(s).length ? s : undefined;
}

// A system as saved, ready or not; tools read their settings from it.
export const savedSystem = saved;

// What Tool use offers: the built-in systems a series may choose, then any others admins added, each saying whether it is ready.
export function choices(): { id: string; name: string; configured: boolean }[] {
  const set = systems();
  return [...BUILT_IN.filter(b => !b.internal).map(b => set.find(s => s.id === b.id) ?? b), ...set.filter(s => !builtIn(s.id))]
    .map(s => ({ id: s.id, name: s.name, configured: !missing(set.find(x => x.id === s.id), s.id).length }));
}

export function choice(id: string): { id: string; name: string; configured: boolean } | undefined {
  const k = id.toLowerCase();
  return choices().find(c => c.id === k || c.name.toLowerCase() === k);
}

// What the Systems page shows: every system, built in or added, with its kind, its fields and what it still needs; never a secret.
export function catalog() {
  const set = systems();
  return [...BUILT_IN.map(b => ({ b, s: set.find(s => s.id === b.id) })), ...set.filter(s => !builtIn(s.id)).map(s => ({ b: undefined, s }))]
    .map(({ b, s }) => ({ ...(s ? view(s) : {}), id: b?.id ?? s!.id, name: s?.name ?? b!.name, kind: s ? kindOf(s) : b!.kind, built_in: !!b, internal: !!b?.internal,
      uses: b?.uses, fields: b?.fields ?? [], saved: !!s, configured: !missing(s, b?.id ?? s?.id).length, missing: missing(s, b?.id ?? s?.id) }));
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

// The password, or for an m365 system the client secret.
export function password(s: System): string {
  if (!s.password) return '';
  const [iv, tag, data] = s.password.split('.').map(p => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key('systems.key'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

const lines = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(s => String(s).trim()).filter(Boolean);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Saves a system. A built-in one can be saved in part, such as its links before its secret, and is ready once nothing is missing;
// one an admin adds is a web system and needs all of it at once.
export function saveSystem(id: string | undefined, input: Record<string, any>, by: string): System {
  const list = systems(), old = id ? list.find(s => s.id === id) : undefined;
  if (id && !old && !builtIn(id)) throw new HttpError(404, `no system ${id}`);
  const b = builtIn(id ?? ''), kind: Kind = old ? kindOf(old) : b?.kind ?? 'web';
  const errors: string[] = [];
  const name = String(input.name ?? old?.name ?? b?.name ?? '').trim(), url = String(input.url ?? '').trim().replace(/\/$/, ''), username = String(input.username ?? '').trim();
  // The id is what series name in their Tool use, so it never changes once made.
  const sid = old?.id ?? b?.id ?? String(input.id ?? name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!name || name.length > 40) errors.push('name: up to 40 characters');
  if (!sid) errors.push('name: needs a letter or a digit');
  if (list.some(s => s.id !== sid && s.name.toLowerCase() === name.toLowerCase())) errors.push(`${name} is already in the list`);
  if (!id && builtIn(sid)) errors.push(`${name} is built in: set it up from its row instead`);
  if (kind === 'web') {
    if (url && !/^https?:\/\/[^/]/.test(url)) errors.push('address: an http(s) address, such as https://e1.example.com');
    if (!b) {
      if (!url) errors.push('address: an http(s) address, such as https://e1.example.com');
      if (!username) errors.push('service account: a user name');
      if (!old?.password && !input.password) errors.push('service account: a password');
    }
  }
  const tenant = String(input.tenant ?? '').trim(), client_id = String(input.client_id ?? '').trim();
  if (kind === 'm365') {
    if (tenant && !GUID.test(tenant)) errors.push('tenant id: the directory (tenant) id, a GUID');
    if (client_id && !GUID.test(client_id)) errors.push('client id: the application (client) id, a GUID');
  }
  const extra = lines(input.extra_origins);
  for (const o of extra) if (!/^https?:\/\/[^/]+$/.test(o)) errors.push(`other address ${o}: only scheme and host, such as https://login.example.com`);
  // The selector boxes are easy to mistake for the account and password, which would then sit there unsealed: refuse what doesn't
  // look like a CSS selector, without echoing it.
  for (const [k, label] of [['user', 'user box'], ['pass', 'password box'], ['submit', 'sign-in button']] as const) {
    const v = String(input.login?.[k] ?? '').trim();
    if (v && (v.includes('@') || !/^[a-z]+$|[#.[\]:>= ]/i.test(v))) errors.push(`selector of the ${label}: that doesn't look like a CSS selector, such as input[name="username"]. The account and password go in their own boxes.`);
  }
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  const settings: Record<string, string> = {};
  for (const f of b?.fields ?? []) {
    const v = String(input.settings?.[f.key] ?? '').trim();
    if (v) settings[f.key] = v;
  }
  const login = { user: String(input.login?.user ?? '').trim(), pass: String(input.login?.pass ?? '').trim(), submit: String(input.login?.submit ?? '').trim() };
  const s: System = {
    id: sid, name, ...(b ? {} : { kind }), ...(url && { url }), ...(username && { username }), ...(tenant && { tenant }), ...(client_id && { client_id }),
    password: input.password ? seal(String(input.password)) : old?.password, ...(Object.keys(settings).length && { settings }),
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

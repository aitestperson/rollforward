import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { HttpError } from './store.ts';
import { forgetOwners, initSystem, key, readJson, writeJson } from './system.ts';

// Sign-in with a Microsoft account. People press "Sign in with Microsoft" and type nothing. With RF_OIDC_ISSUER and the app's id and
// secret set, the button goes to Microsoft Entra ID (OpenID Connect, code flow with PKCE). Without them it goes to a demo account
// picker that offers the two demo accounts below, so keep a demo on localhost.

export type Role = 'admin' | 'user';
export type User = { name?: string; role: Role; disabled?: boolean; sub?: string; epoch?: number; created?: string; last_login?: string };
export type Me = { email: string; name: string; role: Role };

export const DEMO_ACCOUNTS: { email: string; name: string; role: Role }[] = [
  { email: 'admin@demo.test', name: 'Demo Admin', role: 'admin' },
  { email: 'bob@demo.test', name: 'Bob', role: 'user' },
];

const env = process.env;
const oidc = {
  issuer: env.RF_OIDC_ISSUER?.replace(/\/$/, ''), clientId: env.RF_OIDC_CLIENT_ID ?? '', clientSecret: env.RF_OIDC_CLIENT_SECRET ?? '',
  scopes: env.RF_OIDC_SCOPES ?? 'openid profile email', publicUrl: (env.RF_PUBLIC_URL ?? '').replace(/\/$/, ''),
};
export const mode: 'microsoft' | 'demo' = oidc.issuer ? 'microsoft' : 'demo';
const admins = new Set([...(env.RF_ADMINS ?? '').split(','), ...(mode === 'demo' ? DEMO_ACCOUNTS.filter(a => a.role === 'admin').map(a => a.email) : [])].map(s => s.trim().toLowerCase()).filter(Boolean));
const domains = (env.RF_ALLOWED_DOMAINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_MS = Number(env.RF_SESSION_HOURS ?? 12) * 3_600_000;
const secure = oidc.publicUrl.startsWith('https:');

export function users(): Record<string, User> {
  return readJson<Record<string, User>>('users.json', {});
}

export function upsertUser(email: string, change: Partial<User>): User {
  const all = users(), id = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(id)) throw new HttpError(400, `not an email address: ${email}`);
  all[id] = { role: 'user', created: new Date().toISOString(), ...all[id], ...change };
  // Disabling: a new epoch makes every cookie signed for the old one stop working.
  if (change.disabled) all[id].epoch = (all[id].epoch ?? 0) + 1;
  writeJson('users.json', all);
  return all[id];
}

export function removeUser(email: string) {
  const all = users();
  if (!all[email]) throw new HttpError(404, `no user ${email}`);
  delete all[email];
  writeJson('users.json', all);
  forgetOwners(email);
}

export function signOutEverywhere(email: string) {
  const all = users();
  if (!all[email]) throw new HttpError(404, `no user ${email}`);
  all[email].epoch = (all[email].epoch ?? 0) + 1;
  writeJson('users.json', all);
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString();
const mac = (data: string) => createHmac('sha256', key('session.key')).update(data).digest('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
}

function cookie(name: string, value: string, maxAge: number, path = '/') {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function session(req: IncomingMessage): Me | null {
  const [email = '', exp = '', sig = ''] = (cookies(req).rf_session ?? '').split('.');
  const id = unb64(email), u = users()[id];
  if (!u || u.disabled || !(Number(exp) > Date.now()) || !same(sig, mac(`${id} ${exp} ${u.epoch ?? 0}`))) return null;
  return { email: id, name: u.name ?? id, role: admins.has(id) ? 'admin' : u.role };
}

// Lets someone in whom Microsoft (or the demo picker) has vouched for: records them, then sets the session cookie.
function admit(res: ServerResponse, email: string, name: string | undefined, sub: string | undefined, next: string, extra: string[] = []) {
  const known = users()[email];
  if (!known && env.RF_AUTO_PROVISION === '0' && !admins.has(email)) return page(res, 403, `${email} has no access yet. Ask an admin to add you.`);
  if (known?.disabled) return page(res, 403, `${email} is disabled. Ask an admin.`);
  if (known?.sub && sub && known.sub !== sub) return page(res, 403, `${email} belongs to another Microsoft account.`);
  const u = upsertUser(email, { name: name ?? known?.name, ...(sub && { sub }), last_login: new Date().toISOString(), ...(admins.has(email) && { role: 'admin' as Role }) });
  const exp = String(Date.now() + SESSION_MS);
  res.writeHead(302, { location: next, 'set-cookie': [cookie('rf_session', `${b64(email)}.${exp}.${mac(`${email} ${exp} ${u.epoch ?? 0}`)}`, SESSION_MS / 1000), ...extra] });
  res.end();
}

const LOGO = '<svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>';
const STYLE = `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>body { margin: 0; font: 15px/1.5 "IBM Plex Sans", system-ui, sans-serif; color: #15181d; background: #f6f7f8; }
.box { max-width: 380px; margin: 14vh auto 0; padding: 32px 28px; background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; } p { margin: 0 0 22px; color: #474e5b; font-size: 14px; } .bad { color: #b42318; }
.ms { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; padding: 11px 12px; font: 600 15px "Segoe UI", "IBM Plex Sans", sans-serif;
  color: #5e5e5e; background: #fff; border: 1px solid #8c8c8c; border-radius: 2px; text-decoration: none; cursor: pointer; }
.ms:hover { background: #f3f3f3; }
.acct { display: flex; align-items: center; gap: 14px; width: 100%; padding: 12px 10px; background: none; border: 0; border-top: 1px solid #e3e6ea; text-align: left; font: inherit; cursor: pointer; }
.acct:hover { background: #f3f3f3; } .acct b { display: block; font-weight: 500; } .acct small { color: #6b7280; font-size: 13px; }
.av { flex: none; width: 36px; height: 36px; border-radius: 50%; background: #e7eaee; display: grid; place-items: center; font-weight: 600; color: #474e5b; }
.note { margin: 18px 0 0; font-size: 12.5px; color: #6b7280; } .brand { display: flex; align-items: center; gap: 8px; color: #5e5e5e; font-weight: 600; margin-bottom: 18px; }</style>`;

function page(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>rollforward</title>${STYLE}
<div class="box"><h1>rollforward</h1><p class="bad">${esc(text)}</p><a class="ms" href="/auth/login">${LOGO}Sign in with Microsoft</a></div>`);
}

function signInPage(res: ServerResponse, next: string) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in · rollforward</title>${STYLE}
<div class="box"><h1>rollforward</h1><p>Recurring tasks, files in and files out. Sign in with your work account.</p>
<a class="ms" href="/auth/login?next=${encodeURIComponent(next)}">${LOGO}Sign in with Microsoft</a></div>`);
}

// The demo's stand-in for Microsoft's account picker: the two demo accounts, one click each.
function demoPicker(res: ServerResponse, next: string) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pick an account</title>${STYLE}
<div class="box"><div class="brand">${LOGO}Microsoft</div><h1>Pick an account</h1><p>to continue to rollforward</p>
<form method="post" action="/auth/demo"><input type="hidden" name="next" value="${esc(next)}">
${DEMO_ACCOUNTS.map(a => `<button class="acct" name="email" value="${esc(a.email)}"><span class="av">${esc(a.name[0])}</span><span><b>${esc(a.name)}</b><small>${esc(a.email)} · ${a.role}</small></span></button>`).join('')}
</form><p class="note">Demo accounts. Set RF_OIDC_ISSUER, RF_OIDC_CLIENT_ID and RF_OIDC_CLIENT_SECRET to sign in with real Microsoft accounts instead.</p></div>`);
}

let discovered: { issuer: string; authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string } | undefined;

async function discovery() {
  if (discovered) return discovered;
  const r = await fetch(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new HttpError(502, `Microsoft's sign-in configuration did not load (${r.status})`);
  const d = await r.json();
  // The token comes straight from the token endpoint, so TLS vouches for it (OpenID Connect Core 3.1.3.7); only a local test provider may skip TLS.
  if (!/^https:/.test(d.token_endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(d.token_endpoint)) throw new HttpError(502, 'the token endpoint must use https');
  return (discovered = d);
}

// Each sign-in keeps its state in a cookie of its own, named by the state, so sign-ins started in several tabs don't overwrite each other.
const pendingCookie = (state: string) => `rf_oidc_${state}`;

async function microsoft(res: ServerResponse, next: string) {
  const d = await discovery();
  const state = randomBytes(16).toString('base64url'), nonce = randomBytes(16).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const pending = b64(JSON.stringify({ state, nonce, verifier, next, exp: Date.now() + 600_000 }));
  const to = new URL(d.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: oidc.clientId, redirect_uri: `${oidc.publicUrl}/auth/callback`, scope: oidc.scopes, state, nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account',
  })) to.searchParams.set(k, v);
  res.writeHead(302, { location: to.href, 'set-cookie': cookie(pendingCookie(state), `${pending}.${mac(pending)}`, 600, '/auth') });
  res.end();
}

async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
  const state = url.searchParams.get('state') ?? '';
  const [pending = '', sig = ''] = (/^[\w-]+$/.test(state) ? cookies(req)[pendingCookie(state)] ?? '' : '').split('.');
  const p = pending && same(sig, mac(pending)) ? JSON.parse(unb64(pending)) : undefined;
  if (!p || p.exp < Date.now() || p.state !== state) {
    // Already signed in, as after going back to this address or finishing in another tab: carry on rather than complain.
    if (session(req)) return void res.writeHead(302, { location: '/' }).end();
    return page(res, 400, 'The sign-in took too long or came from another browser. Try again.');
  }
  if (url.searchParams.get('error')) return page(res, 401, `Microsoft refused: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`);
  const d = await discovery();
  const r = await fetch(d.token_endpoint, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${oidc.publicUrl}/auth/callback`, client_id: oidc.clientId, client_secret: oidc.clientSecret, code_verifier: p.verifier }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.id_token) return page(res, 401, `Microsoft did not sign you in: ${t.error_description ?? t.error ?? r.status}`);
  const claims = JSON.parse(unb64(t.id_token.split('.')[1]));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== d.issuer || !aud.includes(oidc.clientId) || !(claims.exp * 1000 > Date.now()) || claims.nonce !== p.nonce) return page(res, 401, 'The sign-in token did not check out.');
  const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? '').toLowerCase();
  if (!email.includes('@')) return page(res, 403, 'Your account has no email address.');
  if (domains.length && !domains.includes(email.split('@')[1])) return page(res, 403, `${email} is not in an allowed domain.`);
  admit(res, email, claims.name, claims.sub, p.next, [cookie(pendingCookie(state), '', 0, '/auth')]);
}

const nextOf = (url: URL | URLSearchParams) => {
  const n = (url instanceof URL ? url.searchParams : url).get('next') ?? '/';
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
};

// Who is asking. Answers the sign-in routes itself, and shows the sign-in page to anyone not signed in, then returns null.
export async function authenticate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<Me | null> {
  if (url.pathname === '/auth/login') {
    if (session(req)) res.writeHead(302, { location: nextOf(url) }).end();
    else if (mode === 'microsoft') await microsoft(res, nextOf(url));
    else res.writeHead(302, { location: `/auth/demo?next=${encodeURIComponent(nextOf(url))}` }).end();
  } else if (url.pathname === '/auth/demo' && mode === 'demo') {
    if (req.method !== 'POST') return demoPicker(res, nextOf(url)), null;
    const form = new URLSearchParams(Buffer.concat(await Array.fromAsync(req as AsyncIterable<Buffer>)).toString());
    const account = DEMO_ACCOUNTS.find(a => a.email === form.get('email'));
    if (!account) return page(res, 400, 'Pick one of the demo accounts.'), null;
    admit(res, account.email, account.name, undefined, nextOf(form));
  } else if (url.pathname === '/auth/callback' && mode === 'microsoft') await callback(req, res, url);
  else if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const end = mode === 'microsoft' ? (await discovery().catch(() => undefined))?.end_session_endpoint : undefined;
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie('rf_session', '', 0) });
    res.end(JSON.stringify({ next: end ? `${end}?post_logout_redirect_uri=${encodeURIComponent(oidc.publicUrl + '/')}` : '/' }));
  } else {
    const me = session(req);
    if (me) return me;
    if (url.pathname !== '/' || req.method !== 'GET') throw new HttpError(401, 'sign in first');
    signInPage(res, '/');
  }
  return null;
}

export function checkConfig(host: string) {
  if (mode === 'microsoft' && (!oidc.clientId || !oidc.clientSecret || !oidc.publicUrl)) throw new Error('RF_OIDC_ISSUER needs RF_OIDC_CLIENT_ID, RF_OIDC_CLIENT_SECRET and RF_PUBLIC_URL');
  if (mode === 'demo' && !['127.0.0.1', 'localhost', '::1'].includes(host)) console.warn(`Demo sign-in: anyone who reaches ${host} can sign in as a demo admin. Set RF_OIDC_ISSUER for Microsoft accounts.`);
}

if (import.meta.main) {
  initSystem(resolve(process.argv[2]));
  const [, cmd, email = '', arg] = process.argv.slice(2), id = email.trim().toLowerCase();
  const all = users();
  try {
    if (cmd === 'add' && id) upsertUser(id, { role: arg === 'admin' ? 'admin' : 'user' });
    else if (cmd === 'role' && id in all && (arg === 'admin' || arg === 'user')) upsertUser(id, { role: arg });
    else if (cmd === 'disable' && id in all) upsertUser(id, { disabled: true });
    else if (cmd === 'enable' && id in all) upsertUser(id, { disabled: false });
    else if (cmd === 'signout' && id in all) signOutEverywhere(id);
    else if (cmd === 'remove' && id in all) removeUser(id);
    else if (cmd === 'list') for (const [n, u] of Object.entries(all)) console.log([n, u.role, u.disabled ? 'disabled' : '', u.last_login ? `last in ${u.last_login}` : 'never in'].filter(Boolean).join('\t'));
    else {
      console.error('usage: node src/auth.ts DATA_ROOT list | add EMAIL [admin] | role EMAIL admin|user | disable EMAIL | enable EMAIL | signout EMAIL | remove EMAIL');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

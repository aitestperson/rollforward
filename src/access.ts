import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { renderSVG } from 'uqr';
import { HttpError } from './store.ts';

type People = Record<string, { secret?: string; invite?: string }>;

const file = join(resolve(process.argv[2]), '.access.json');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SESSION_MS = 7 * 86_400_000;
let fails = 0, nextTry = 0;

const load = (): People => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const mac = (secret: string, name: string, exp: string) => createHmac('sha256', secret).update(`${name} ${exp}`).digest('base64url');

function save(people: People) {
  writeFileSync(file + '.tmp', JSON.stringify(people, null, 1), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

function codeOk(secret: string, code: string): boolean {
  const key = Buffer.from([...secret].map(c => B32.indexOf(c).toString(2).padStart(5, '0')).join('').match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const step = Math.floor(Date.now() / 30_000);
  return [step - 1, step, step + 1].some(s => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(s));
    const h = createHmac('sha1', key).update(counter).digest();
    return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0') === code;
  });
}

function cookie(req: IncomingMessage) {
  const [name = '', exp = '', sig = ''] = (req.headers.cookie?.match(/(?:^|;\s*)rf=([^;]*)/)?.[1] ?? '').split('.');
  return { name: Buffer.from(name, 'base64url').toString(), exp, sig };
}

function signedIn(req: IncomingMessage): boolean {
  const { name, exp, sig } = cookie(req), secret = load()[name]?.secret;
  if (!secret || !(Number(exp) > Date.now())) return false;
  const want = Buffer.from(mac(secret, name, exp)), got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

function page(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>rollforward</title>
<style>body { font: 15px/1.5 system-ui; max-width: 26em; margin: 10vh auto; padding: 0 16px } input, button { font: inherit; padding: 6px 10px } svg { display: block; width: 200px } .bad { color: #b42318 }</style>
${body}`);
}

function gate(res: ServerResponse, status: number, name: string, note = '') {
  page(res, status, `<form method="post" action="/login"><p>Your name and code, as your authenticator app shows them under rollforward.</p>
<p><input name="name" value="${esc(name)}" placeholder="Name" autocomplete="username" required ${name ? '' : 'autofocus'}></p>
<p><input name="code" placeholder="Code" inputmode="numeric" autocomplete="one-time-code" required ${name ? 'autofocus' : ''}> <button>Enter</button></p>
<p class="bad">${note}</p></form>`);
}

function enter(res: ServerResponse, name: string, secret: string) {
  const exp = String(Date.now() + SESSION_MS);
  // The cookie outlives the session so that the code page can fill in the name.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `rf=${Buffer.from(name).toString('base64url')}.${exp}.${mac(secret, name, exp)}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax` });
  res.end(`<script>localStorage.rfName = ${JSON.stringify(name).replaceAll('<', '\\u003c')}; location.replace('/')</script>`);
}

function login(res: ServerResponse, form: URLSearchParams) {
  const name = form.get('name')?.trim().toLowerCase() ?? '', secret = load()[name]?.secret;
  const wait = Math.ceil((nextTry - Date.now()) / 1000);
  if (wait > 0) return gate(res, 429, name, `Too many tries. Try again in ${wait} s.`);
  if (!secret || !codeOk(secret, form.get('code')?.replace(/\D/g, '') ?? '')) {
    nextTry = Date.now() + Math.min(2 ** ++fails, 300) * 1000;
    return gate(res, 401, name, 'Wrong name or code.');
  }
  fails = 0;
  enter(res, name, secret);
}

// Each view of an invite shows a new secret; the form posts it back with a code from it, so whoever only saw the page holds nothing.
function enroll(res: ServerResponse, token: string, form?: URLSearchParams) {
  const people = load(), name = Object.keys(people).find(n => people[n].invite === token);
  if (!name) return page(res, 404, '<p>This link has been used or withdrawn. Ask for a new one.</p>');
  const secret = form ? form.get('secret') ?? '' : Array.from(randomBytes(32), b => B32[b & 31]).join('');
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new HttpError(400, 'bad secret');
  if (form && codeOk(secret, form.get('code')?.replace(/\D/g, '') ?? '')) {
    people[name] = { secret };
    save(people);
    return enter(res, name, secret);
  }
  const uri = `otpauth://totp/rollforward:${encodeURIComponent(name)}?secret=${secret}&issuer=rollforward`;
  page(res, form ? 401 : 200, `<h2>Set up rollforward</h2>
<p>1. In Microsoft Authenticator or Google Authenticator on your phone, add an account (Microsoft calls it "Other account") and scan this code.</p>
${renderSVG(uri)}
<p>On this phone, <a href="${esc(uri)}">open it in the app</a> instead, or type the key <code>${secret.match(/.{4}/g)!.join(' ')}</code>.</p>
<form method="post"><input type="hidden" name="secret" value="${secret}">
<p>2. Enter the code the app shows, for rollforward (${esc(name)}).</p>
<p><input name="code" placeholder="Code" inputmode="numeric" autocomplete="one-time-code" required autofocus> <button>Continue</button></p>
<p class="bad">${form ? 'Wrong code. Enter the one the app shows now.' : ''}</p></form>`);
}

export async function access(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const form = async () => new URLSearchParams(Buffer.concat(await Array.fromAsync(req)).toString());
  if (url.pathname === '/login' && req.method === 'POST') login(res, await form());
  else if (url.pathname.startsWith('/join/')) enroll(res, url.pathname.slice(6), req.method === 'POST' ? await form() : undefined);
  else if (url.pathname.startsWith('/agent/') || signedIn(req)) return false;
  else if (url.pathname === '/') gate(res, 200, cookie(req).name);
  else throw new HttpError(401, 'enter the code first');
  return true;
}

if (import.meta.main) {
  const [, cmd, ...words] = process.argv.slice(2), name = words.join(' ').trim().toLowerCase(), people = load();
  if (cmd === 'invite' && name) {
    people[name] = { ...people[name], invite: randomBytes(16).toString('base64url') };
    save(people);
    console.log(`/join/${people[name].invite}`);
  } else if (cmd === 'revoke' && name in people) {
    delete people[name];
    save(people);
  } else if (cmd === 'list') {
    for (const [n, p] of Object.entries(people)) console.log([n, p.secret && 'set up', p.invite && 'invited'].filter(Boolean).join('\t'));
  } else {
    console.error('usage: node src/access.ts DATA_ROOT invite NAME | revoke NAME | list');
    process.exitCode = 2;
  }
}

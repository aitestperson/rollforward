import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// With RF_OIDC_* set, the same Sign in with Microsoft button goes to Microsoft Entra ID. A stand-in provider plays Microsoft here:
// it signs in whoever the login hint names, and checks the app's secret and its PKCE verifier.

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'rf-ms-')), root = join(tmp, 'data');
let proc: ChildProcess, idp: Server, base = '', idpBase = '';
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sessionOf = (r: Response) => r.headers.getSetCookie().find(c => c.startsWith('rf_session='))?.split(';')[0];

async function start(email: string) {
  const out = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const to = new URL(out.headers.get('location')!);
  to.searchParams.set('login_hint', email);
  return { cookie: out.headers.getSetCookie()[0].split(';')[0], back: (await fetch(to, { redirect: 'manual' })).headers.get('location')! };
}

before(async () => {
  idp = createServer(async (req, res) => {
    const u = new URL(req.url!, idpBase), send = (d: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    if (u.pathname === '/.well-known/openid-configuration') return send({ issuer: idpBase, authorization_endpoint: `${idpBase}/authorize`, token_endpoint: `${idpBase}/token` });
    if (u.pathname === '/authorize') {
      const code = b64(JSON.stringify({ email: u.searchParams.get('login_hint'), nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge') }));
      return void res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` }).end();
    }
    let body = '';
    for await (const c of req) body += c;
    const f = new URLSearchParams(body), c = JSON.parse(Buffer.from(f.get('code')!, 'base64url').toString());
    if (f.get('client_secret') !== 'shh' || createHash('sha256').update(f.get('code_verifier')!).digest('base64url') !== c.challenge) return void res.writeHead(400).end('{"error":"invalid_grant"}');
    send({ id_token: `${b64('{"alg":"none"}')}.${b64(JSON.stringify({ iss: idpBase, aud: 'rf-test', exp: Date.now() / 1000 + 300, nonce: c.nonce, email: c.email, name: 'Alex', sub: `sub-${c.email}` }))}.` });
  });
  await new Promise<void>(ok => idp.listen(0, '127.0.0.1', ok));
  idpBase = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  const probe = createNetServer();
  await new Promise<void>(ok => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise(ok => probe.close(ok));
  base = `http://127.0.0.1:${port}`;
  mkdirSync(root);
  const env = { ...process.env, HOME: tmp, RF_OIDC_ISSUER: idpBase, RF_OIDC_CLIENT_ID: 'rf-test', RF_OIDC_CLIENT_SECRET: 'shh', RF_PUBLIC_URL: base, RF_ADMINS: 'alex@acme.test' };
  proc = spawn(process.execPath, [join(app, 'src', 'server.ts'), root, String(port)], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    proc.stdout!.on('data', d => String(d).includes('rollforward on') && ok(null));
    proc.on('exit', code => fail(new Error(`server exited with ${code}`)));
  });
});

after(async () => {
  if (process.platform === 'win32') proc.kill();
  else process.kill(-proc.pid!, 'SIGTERM');
  await once(proc, 'exit');
  idp.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('the button goes to Microsoft, and back with a session; the demo picker is gone', async () => {
  const out = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  assert.ok(out.headers.get('location')!.startsWith(`${idpBase}/authorize?`));
  assert.equal(new URL(out.headers.get('location')!).searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await fetch(`${base}/auth/demo`, { method: 'POST', body: new URLSearchParams({ email: 'admin@demo.test' }) })).status, 401);
  const a = await start('alex@acme.test');
  const s = sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: a.cookie } }))!;
  const me = await (await fetch(`${base}/me`, { headers: { cookie: s } })).json();
  assert.deepEqual([me.email, me.name, me.role, me.sign_in], ['alex@acme.test', 'Alex', 'admin', 'microsoft']);
});

test('sign-ins started in two tabs both finish, and a forged return is refused', async () => {
  const a = await start('sam@acme.test'), b = await start('sam@acme.test'), jar = `${a.cookie}; ${b.cookie}`;
  assert.ok(sessionOf(await fetch(a.back, { redirect: 'manual', headers: { cookie: jar } })), 'the tab that started first still finishes');
  assert.ok(sessionOf(await fetch(b.back, { redirect: 'manual', headers: { cookie: jar } })));
  const forged = new URL(a.back);
  forged.searchParams.set('state', 'forged');
  assert.equal((await fetch(forged, { redirect: 'manual', headers: { cookie: jar } })).status, 400);
});

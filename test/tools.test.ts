import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSystem } from '../src/system.ts';
import { saveSystem, system } from '../src/systems.ts';
import { endpoints, waitForCode } from '../src/graph.ts';
import { parseArgs, run, tools, toolsFor } from '../src/tools/all.ts';

// A stand-in for Microsoft's sign-in and Graph: two JDE folders (with a 2025 folder beside the 2026 one) and a mailbox.
const SECRET = 'app-Secret!', MAILBOX = 'ap@demo.test';
const tmp = mkdtempSync(join(tmpdir(), 'rf-tools-'));
const methods: string[] = [];
let graph: Server;

const item = (id: string, name: string, modified: string, folder = false) =>
  ({ id, name, lastModifiedDateTime: modified, parentReference: { driveId: 'd1', id: 'top' }, ...(folder ? { folder: {} } : { file: {} }) });
const shares: Record<string, ReturnType<typeof item>> = { 'https://share.test/450': item('y2026', '2026', '2026-01-02T00:00:00Z', true) };
const folders: Record<string, ReturnType<typeof item>[]> = {
  top: [item('y2026', '2026', '2026-01-02T00:00:00Z', true), item('y2025', '2025', '2025-01-02T00:00:00Z', true)],
  y2026: [
    item('a', 'AGING_A_1.csv', '2026-10-20T12:00:00Z'),
    item('b', 'AGING_B_2.csv', '2026-10-20T12:30:00Z'),
    item('c', 'AGING_A_0.csv', '2026-10-19T12:00:00Z'),
  ],
  y2025: [item('d', 'AR aging for Co450_2025.12.31.csv', '2026-01-01T12:00:00Z')],
};
const content: Record<string, string> = { a: 'As-Of Date,10/20/2026\nCustomer,Open\nAcme,10\n', b: 'As-Of Date,10/13/2026\nother report\n', c: 'As-Of Date,10/19/2026\n', d: 'year end\n' };
const mail = [
  { id: 'm1', subject: "FW: Request successfully processed for DEMO SUPPLIER LLC", receivedDateTime: '2026-10-20T11:00:00Z', hasAttachments: true, from: { emailAddress: { address: 'may@demo.test' } } },
  { id: 'm2', subject: 'Something else', receivedDateTime: '2026-10-20T12:00:00Z', hasAttachments: true, from: { emailAddress: { address: 'x@demo.test' } } },
];
const codes: { receivedDateTime: string; from: { emailAddress: { address: string } }; subject: string; body: { content: string } }[] = [];

before(async () => {
  initSystem(tmp);
  graph = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'), send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (u.pathname.endsWith('/oauth2/v2.0/token')) {
      let body = '';
      req.on('data', c => (body += c)).on('end', () => {
        const f = new URLSearchParams(body);
        if (f.get('client_secret') !== SECRET) return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
        send({ access_token: 'tok', expires_in: 3600 });
      });
      return;
    }
    methods.push(req.method!);
    if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
    let m;
    if ((m = /^\/shares\/u!([\w-]+)\/driveItem$/.exec(u.pathname))) return send(shares[Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()]);
    if ((m = /^\/drives\/d1\/items\/(\w+)\/children$/.exec(u.pathname))) return send({ value: folders[m[1]] ?? [] });
    if ((m = /^\/drives\/d1\/items\/(\w+)\/content$/.exec(u.pathname))) return void res.writeHead(200).end(content[m[1]]);
    if ((m = /^\/drives\/d1\/items\/(\w+)$/.exec(u.pathname))) return send(item(m[1], 'LFM', '2026-01-01T00:00:00Z', true));
    if (decodeURIComponent(u.pathname) === `/users/${MAILBOX}/messages`) {
      const [, from, to] = /ge (\S+) and receivedDateTime lt (\S+)/.exec(u.searchParams.get('$filter') ?? '') ?? [];
      return send({ value: [...mail, ...codes].filter(x => x.receivedDateTime >= from && x.receivedDateTime < to).sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime)) });
    }
    if (decodeURIComponent(u.pathname) === `/users/${MAILBOX}/messages/m1/attachments`) return send({ value: [
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'RPA - Open to Pay.xlsx', contentType: 'application/vnd.ms-excel', contentBytes: Buffer.from('xlsx bytes').toString('base64') },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', contentType: 'image/png', contentBytes: '' },
    ] });
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'itemNotFound', message: 'not here' } }));
  });
  await new Promise<void>(ok => graph.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
  Object.assign(endpoints, { login: base, graph: base });
  const app = { tenant: '00000000-0000-0000-0000-000000000001', client_id: '00000000-0000-0000-0000-000000000002', password: SECRET };
  saveSystem('m365-files', app, 'admin');
  saveSystem('m365-mail', { ...app, settings: { mailbox: MAILBOX } }, 'admin');
  saveSystem('jde-ar', { settings: { folder_450: 'https://share.test/450', folder_236: 'https://share.test/236' } }, 'admin');
  saveSystem('kohls', { settings: { subject: 'Request successfully processed' } }, 'admin');
});

after(() => {
  graph.close();
  graph.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const tool = (name: string) => tools().find(t => t.name === name)!;
const out = (name: string) => join(tmp, 'inst', name, 'working');

test('a series sees the tools of the systems in its Tool use only', () => {
  assert.deepEqual(toolsFor(['jde-ar', 'e1']).map(t => t.name), ['jde-ar-aging']);
  assert.deepEqual(toolsFor(['costco', 'burlington']).map(t => t.name), ['costco-ap', 'burlington-invoice']);
});

test('JDE A/R: the file changed that day whose own As-Of Date is that day; another year follows the year folder', async () => {
  const r = await run(tool('jde-ar-aging'), parseArgs(['--company', '450', '--date', '2026-10-20']), out('jde'));
  assert.equal(r.files.length, 1);
  assert.match(r.text, /AGING_A_1\.csv.*As-Of Date is 2026-10-20.*of 2 candidates/);
  assert.equal(readFileSync(join(out('jde'), r.files[0].replace('working/', '')), 'utf8'), content.a);
  const y = await run(tool('jde-ar-aging'), parseArgs(['--company', '450', '--date', '2025-12-31']), out('jde'));
  assert.match(y.text, /AR aging for Co450_2025\.12\.31\.csv from OneDrive folder 2025 \(dated 2025-12-31/);
  await assert.rejects(run(tool('jde-ar-aging'), parseArgs(['--company', '450', '--date', '2026-10-18']), out('jde')), /no AR aging file for company 450 dated 2026-10-18 in 2026\. Latest there: AGING_B_2\.csv/);
  await assert.rejects(run(tool('jde-ar-aging'), parseArgs(['--company', '999']), out('jde')), /--company is one of 450, 236/);
  await assert.rejects(run(tool('jde-ar-aging'), parseArgs([]), out('jde')), /needs --company/);
  assert.ok(methods.length && methods.every(m => m === 'GET'), 'Graph is only ever read');
});

test('a second run never overwrites the first file', async () => {
  const again = await run(tool('jde-ar-aging'), parseArgs(['--company', '450', '--date', '2026-10-20']), out('jde'));
  assert.match(again.files[0], / \(2\)\.csv$/);
  assert.equal(readdirSync(out('jde')).filter(f => f.includes('2026-10-20')).length, 2);
});

test("Kohls: the day's mail with the subject, its spreadsheet attachments only", async () => {
  const r = await run(tool('kohls-open-ap'), parseArgs(['--date', '2026-10-20']), out('kohls'));
  assert.deepEqual(r.files, ['working/Kohls open AP 2026-10-20 - RPA - Open to Pay.xlsx']);
  assert.match(r.text, /received 2026-10-20T11:00:00Z in ap@demo\.test/);
  await assert.rejects(run(tool('kohls-open-ap'), parseArgs(['--date', '2026-10-21']), out('kohls')), /no mail with an attachment.*on 2026-10-21/);
});

test('a tool whose system is not ready says what it needs; a wrong secret shows what Microsoft said', async () => {
  await assert.rejects(run(tool('walmart-paid-history'), {}, out('w')), /Walmart Retail Link is not set up yet/);
  saveSystem('burlington', { url: 'https://burl.test' }, 'admin');
  await assert.rejects(run(tool('burlington-invoice'), parseArgs(['--invoice', '1']), out('b')), /Burlington is not ready: it needs service account, password/);
  saveSystem('m365-files', { tenant: '00000000-0000-0000-0000-000000000001', client_id: '00000000-0000-0000-0000-000000000002', password: 'wrong' }, 'admin');
  await assert.rejects(run(tool('jde-ar-aging'), parseArgs(['--company', '450']), out('jde')), /did not give the app a token: AADSTS7000215/);
});

test('a sign-in code: the newest from the sender after the request, never one already used', async () => {
  const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  codes.push(
    { receivedDateTime: at(-600), from: { emailAddress: { address: 'noreply@pingidentity.com' } }, subject: 'New Authentication Request', body: { content: '<p>Passcode: <b>111111</b></p>' } },
    { receivedDateTime: at(-2), from: { emailAddress: { address: 'noreply@pingidentity.com' } }, subject: 'New Authentication Request', body: { content: '<p>Passcode: <b>222222</b></p>' } },
    { receivedDateTime: at(-1), from: { emailAddress: { address: 'someone@demo.test' } }, subject: 'Invoice 333333', body: { content: 'not a code' } },
  );
  const mailApp = system('m365-mail')!, since = new Date(Date.now() - 60_000);
  assert.equal(await waitForCode(mailApp, MAILBOX, since, /pingidentity/i, 5000), '222222', 'the old code is before the request; the other mail is from someone else');
  assert.equal(await waitForCode(mailApp, MAILBOX, since, /pingidentity/i, 1000, '4,8', new Set(['222222'])), null, 'a used code is not given twice');
});

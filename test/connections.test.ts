import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { initSystem } from '../src/system.ts';
import type { Instance } from '../src/store.ts';
import { saveSystem, system } from '../src/systems.ts';
import { endpoints, waitForCode } from '../src/graph.ts';
import { agentCall, serveAgent, type AgentRun } from '../src/agent-api.ts';
import { checkChosen, publicSettings, saveSkillConfig, skill, skills } from '../src/skills.ts';

// A stand-in for Microsoft's sign-in and Graph: a company's year folders of AR aging reports, and a mailbox. The connections' reads
// are called as a run's agent calls them, and the skills' scripts run against them as they would in a run.
const SECRET = 'app-Secret!', MAILBOX = 'ap@demo.test';
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = join(app, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const tmp = mkdtempSync(join(tmpdir(), 'rf-conn-')), seriesDir = join(tmp, 'demo', 'Weekly'), instDir = join(seriesDir, 'w1');
const methods: string[] = [], log: { op: string; data: any }[] = [];
let graph: Server;

const item = (id: string, name: string, modified: string, folder = false) =>
  ({ id, name, lastModifiedDateTime: modified, parentReference: { driveId: 'b!d1', id: 'top' }, ...(folder ? { folder: {} } : { file: {} }) });
const shares: Record<string, ReturnType<typeof item>> = { 'https://share.test/450': item('y2026', '2026', '2026-01-02T00:00:00Z', true), 'https://share.test/target': item('tgt', '2026 Target Input', '2026-01-02T00:00:00Z', true) };
const folders: Record<string, ReturnType<typeof item>[]> = {
  top: [item('y2026', '2026', '2026-01-02T00:00:00Z', true), item('y2025', '2025', '2025-01-02T00:00:00Z', true)],
  y2026: [item('a', 'AGING_A_1.csv', '2026-10-20T12:00:00Z'), item('b', 'AGING_B_2.csv', '2026-10-20T12:30:00Z'), item('c', 'AGING_A_0.csv', '2026-10-19T12:00:00Z')],
  y2025: [item('d', 'AR aging for Co450_2025.12.31.csv', '2026-01-01T12:00:00Z')],
  tgt: [item('t1', '1020Input-Specific Document Search (3).csv', '2026-10-23T04:15:56Z'), item('t2', '1005Input-Specific Document Search.csv', '2026-10-23T04:15:50Z')],
};
const content: Record<string, string> = { t1: 'Document,Amount\nD-1,10\n', t2: 'old\n', a: 'As-Of Date,10/20/2026\nCustomer,Open\nAcme,10\n', b: 'As-Of Date,10/13/2026\nother report\n', c: 'As-Of Date,10/19/2026\n', d: 'year end\n' };
const mail = [
  { id: 'm1', subject: 'FW: Request successfully processed for DEMO SUPPLIER LLC', receivedDateTime: '2026-10-20T11:00:00Z', hasAttachments: true, from: { emailAddress: { address: 'may@demo.test' } } },
  { id: 'm2', subject: 'Something else', receivedDateTime: '2026-10-20T12:00:00Z', hasAttachments: true, from: { emailAddress: { address: 'x@demo.test' } } },
];
const codes: { receivedDateTime: string; from: { emailAddress: { address: string } }; subject: string; body: { content: string } }[] = [];
const inst = { dir: instDir, log: [], series: () => seriesDir, append: (_by: string, op: string, data: any) => { log.push({ op, data }); return { seq: log.length }; } } as unknown as Instance;
const run: AgentRun = { inst };
const call = (path: string, body?: unknown, query = '') => agentCall(run, path, body === undefined ? 'GET' : 'POST', new URLSearchParams(query), async () => Buffer.from(JSON.stringify(body ?? {})));
const settings = (s: object) => writeFileSync(join(seriesDir, 'series.json'), JSON.stringify(s));

before(async () => {
  initSystem(tmp);
  mkdirSync(join(instDir, 'working'), { recursive: true });
  graph = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'), path = decodeURIComponent(u.pathname), send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path.endsWith('/oauth2/v2.0/token')) {
      let body = '';
      req.on('data', c => (body += c)).on('end', () => {
        if (new URLSearchParams(body).get('client_secret') !== SECRET) return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
        send({ access_token: 'tok', expires_in: 3600 });
      });
      return;
    }
    methods.push(req.method!);
    if (req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
    let m;
    if ((m = /^\/shares\/u!([\w-]+)\/driveItem$/.exec(path))) return send(shares[Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()]);
    if ((m = /^\/drives\/b!d1\/items\/(\w+)\/children$/.exec(path))) return send({ value: folders[m[1]] ?? [] });
    if ((m = /^\/drives\/b!d1\/items\/(\w+)\/content$/.exec(path))) return void res.writeHead(200).end(content[m[1]]);
    if ((m = /^\/drives\/b!d1\/items\/(\w+)$/.exec(path))) return send(m[1] === 'top' ? item('top', 'LFM', '2026-01-01T00:00:00Z', true) : [...Object.values(folders).flat()].find(i => i.id === m![1]));
    if (path === `/users/${MAILBOX}/messages`) {
      const [, from, to] = /ge (\S+) and receivedDateTime lt (\S+)/.exec(u.searchParams.get('$filter') ?? '') ?? [];
      return send({ value: [...mail, ...codes].filter(x => x.receivedDateTime >= from && x.receivedDateTime < to).sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime)) });
    }
    if (path === `/users/${MAILBOX}/messages/m1/attachments`) return send({ value: [
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Open to Pay.xlsx', contentType: 'application/vnd.ms-excel', contentBytes: Buffer.from('xlsx bytes').toString('base64') },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', contentType: 'image/png', contentBytes: '' },
    ] });
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'itemNotFound', message: 'not here' } }));
  });
  await new Promise<void>(ok => graph.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(graph.address() as { port: number }).port}`;
  Object.assign(endpoints, { login: base, graph: base });
  const appIds = { tenant: '00000000-0000-0000-0000-000000000001', client_id: '00000000-0000-0000-0000-000000000002', password: SECRET };
  saveSystem('m365-files', appIds, 'admin');
  saveSystem('m365-mail', { ...appIds, settings: { mailbox: MAILBOX } }, 'admin');
  saveSkillConfig('jde-ar-aging', { folder_450: 'https://share.test/450', folder_236: 'https://share.test/236' }, 'admin');
  saveSkillConfig('kohls-open-ap', { subject: 'Request successfully processed' }, 'admin');
  saveSkillConfig('target-document-search', { folder: 'https://share.test/target' }, 'admin');
  settings({ skills: ['jde-ar-aging', 'kohls-open-ap'] });
});

after(() => {
  graph.close();
  graph.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

test('rf files lists a folder by its link, steps to its parent, and saves a file under working/; Graph is only read', async () => {
  const folder = (await call('/agent/files', { args: ['list', 'https://share.test/450'] }))!.data as any;
  assert.deepEqual([folder.name, folder.folder, folder.parent, folder.items.length], ['2026', true, 'b!d1/top', 3]);
  const up = (await call('/agent/files', { args: ['list', folder.parent] }))!.data as any;
  assert.deepEqual(up.items.map((i: any) => i.name), ['2026', '2025']);
  const got = (await call('/agent/files', { args: ['get', 'b!d1/a', 'aging.csv'] }))!.data as any;
  assert.equal(got.saved, 'working/aging.csv');
  assert.equal(readFileSync(join(instDir, 'working', 'aging.csv'), 'utf8'), content.a);
  await assert.rejects(call('/agent/files', { args: ['get', 'b!d1/a', '../escape.csv'] }), /under your working/);
  assert.ok(methods.length && methods.every(m => m === 'GET'));
});

test('rf mail reads only the connection\'s mailbox: the day\'s mail by subject, and saves attachments without overwriting', async () => {
  const found = (await call('/agent/mail', { args: ['find', '--date', '2026-10-20', '--subject', 'request successfully', '--attachments'] }))!.data as any;
  assert.deepEqual([found.mailbox, found.messages.map((m: any) => m.id)], [MAILBOX, ['m1']]);
  assert.ok(!('body' in found.messages[0]), 'a message\'s body is never handed out');
  const saved = (await call('/agent/mail', { args: ['save', 'm1', '--name', '\\.xlsx$'] }))!.data as any;
  const again = (await call('/agent/mail', { args: ['save', 'm1', '--name', '\\.xlsx$'] }))!.data as any;
  assert.deepEqual([saved.saved, again.saved], [['working/Open to Pay.xlsx'], ['working/Open to Pay (2).xlsx']]);
});

test('a connection no chosen skill uses, a skill not chosen, or one not set up, is refused', async () => {
  settings({ skills: ['kohls-open-ap'] });
  await assert.rejects(call('/agent/files', { args: ['list', 'https://share.test/450'] }), /no skill in this series' Skill use uses M365 OneDrive/);
  await assert.rejects(call('/agent/settings', undefined, 'skill=jde-ar-aging'), /not in this series' Skill use/);
  settings({ skills: ['burlington-invoice'] });
  await assert.rejects(call('/agent/flow', { args: ['burlington-invoice/invoice', '--var', 'invoices=1'] }), /Burlington.* is not set up yet: it needs address, account, password/i);
  await assert.rejects(call('/agent/flow', { args: ['costco-ap/payments'] }), /costco-ap is not in this series' Skill use/);
});

test('admins set each skill up once; a password is sealed, never handed out, and kept when left empty; a series picks skills that exist', () => {
  assert.deepEqual(checkChosen(['kohls-open-ap', 'kohls-open-ap']), ['kohls-open-ap']);
  assert.throws(() => checkChosen(['nope']), /no skill nope/);
  assert.throws(() => saveSkillConfig('kohls-open-ap', { mailbox: 'x' }, 'admin'), /kohls-open-ap has no setting mailbox/);
  saveSkillConfig('burlington-invoice', { url: 'https://burl.test/#/login', username: 'svc', password: 'P4ss!word' }, 'admin');
  assert.ok(!readFileSync(join(tmp, '.rf', 'skills.json'), 'utf8').includes('P4ss!word'));
  assert.deepEqual(publicSettings(skill('burlington-invoice')!), { url: 'https://burl.test/#/login', username: 'svc' });
  saveSkillConfig('burlington-invoice', { url: 'https://burl.test/#/login', username: 'svc2' }, 'admin');
  assert.ok(JSON.parse(readFileSync(join(tmp, '.rf', 'skills.json'), 'utf8'))['burlington-invoice'].password, 'an empty password keeps the one saved');
  const ids = skills().map(s => s.id);
  for (const id of ['jde-ar-aging', 'walmart-paid-history', 'kohls-open-ap', 'target-document-search', 'costco-ap', 'burlington-invoice', 'e1-automation']) assert.ok(ids.includes(id), id);
  assert.deepEqual(skills().find(s => s.id === 'costco-ap')!.flows, ['payments', 'unpaid-items']);
  assert.deepEqual([skill('costco-ap')!.signin, skill('burlington-invoice')!.signin, skill('target-document-search')!.site], [true, true, undefined]);
});

// The skills' scripts, run as in a run: rf reaching the agent API, files landing in working/.
async function script(skill: string, args: string[], env: Record<string, string> = {}) {
  const api = await serveAgent(run);
  try {
    return await promisify(execFile)(python, [join(app, 'skills', skill, 'scripts', 'fetch.py'), ...args], { env: { ...process.env, RF_URL: api.url, RF_TOKEN: api.token, RF_WORKING: join(instDir, 'working'), RF_TODAY: '', ...env } });
  } finally {
    await api.close();
  }
}

test('jde-ar-aging: the file changed that day whose own As-Of Date is that day; another year follows the year folder', async () => {
  settings({ skills: ['jde-ar-aging'] });
  const r = await script('jde-ar-aging', ['--company', '450', '--date', '2026-10-20']);
  assert.match(r.stdout, /Saved working\/JDE AR aging 450 2026-10-20 - AGING_A_1\.csv: .*its As-Of Date is 2026-10-20, the latest of 2 candidates/);
  assert.equal(readFileSync(join(instDir, 'working', 'JDE AR aging 450 2026-10-20 - AGING_A_1.csv'), 'utf8'), content.a);
  assert.ok(!readdirSync(join(instDir, 'working')).some(f => f.startsWith('.jde')), 'the other candidates are cleared away');
  const y = await script('jde-ar-aging', ['--company', '450'], { RF_TODAY: '2025-12-31' });
  assert.match(y.stdout, /AR aging for Co450_2025\.12\.31\.csv from OneDrive folder 2025, dated 2025-12-31 \(RF_TODAY\)/);
  await assert.rejects(script('jde-ar-aging', ['--company', '450', '--date', '2026-10-18']), /no AR aging file for company 450 dated 2026-10-18 \(--date\) in OneDrive folder 2026\. Latest there: AGING_B_2\.csv/);
});

test("kohls-open-ap: the day's mail with the subject, its spreadsheets only, named for the day", async () => {
  settings({ skills: ['kohls-open-ap'] });
  const r = await script('kohls-open-ap', ['--date', '2026-10-20']);
  assert.match(r.stdout, /Saved working\/Kohls open AP 2026-10-20 - Open to Pay\.xlsx from the mail .* received 2026-10-20T11:00:00Z in ap@demo\.test/);
  await assert.rejects(script('kohls-open-ap', ['--date', '2026-10-21']), /no mail with an attachment.*on 2026-10-21/);
});

test("target-document-search: the day's file, by the MMDD its name starts with", async () => {
  settings({ skills: ['target-document-search'] });
  const r = await script('target-document-search', ['--date', '2026-10-20']);
  assert.match(r.stdout, /Saved working\/Target specific document search 2026-10-20 - 1020Input-Specific Document Search \(3\)\.csv/);
  assert.equal(readFileSync(join(instDir, 'working', 'Target specific document search 2026-10-20 - 1020Input-Specific Document Search (3).csv'), 'utf8'), content.t1);
  await assert.rejects(script('target-document-search', ['--date', '2026-10-23']), /no Target input file for 2026-10-23 \(--date\).*no name starts with 1023\. Latest there: 1020Input/, 'not another day\'s file, though all were changed that day');
});

test('a wrong client secret shows what Microsoft said', async () => {
  settings({ skills: ['jde-ar-aging'] });
  saveSystem('m365-files', { tenant: '00000000-0000-0000-0000-000000000001', client_id: '00000000-0000-0000-0000-000000000002', password: 'wrong' }, 'admin');
  await assert.rejects(call('/agent/files', { args: ['list', 'https://share.test/450'] }), /did not give the app a token: AADSTS7000215/);
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

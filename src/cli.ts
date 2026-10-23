import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Instance } from './store.ts';
import { initSystem } from './system.ts';
import { kindOf, missing, savedSystem } from './systems.ts';
import { closeBrowser, testLogin } from './browser.ts';
import { testM365 } from './m365.ts';
import { connectionsText, serveAgent } from './agent-api.ts';
import { SKILLS } from './skills.ts';

// An admin's shell into the connections and skills, with what DATA_ROOT has set up, and no model:
//   node --env-file=.env src/cli.ts DATA_ROOT test SYSTEM
//       what Test does on the Systems page
//   node --env-file=.env src/cli.ts DATA_ROOT try WORKSPACE/SERIES [--out DIR] -- COMMAND ...
//       runs COMMAND as a run of that series would: with its Tool use and Skill use, rf reaching them, and working/ under DIR
//       (default ./try-output). Such as: python skills/jde-ar-aging/scripts/fetch.py --company 450
//                                          rf browse costco run costco-ap/payments

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const [root, cmd, ...rest] = process.argv.slice(2);
if (!root || !cmd) {
  console.error('usage: node src/cli.ts DATA_ROOT test SYSTEM | try WORKSPACE/SERIES [--out DIR] -- COMMAND ...');
  process.exit(2);
}
initSystem(resolve(root));

async function test(id: string) {
  const s = savedSystem(id), need = missing(s, id);
  if (need.length) throw new Error(`${id} still needs ${need.join(', ')}`);
  console.log(await (kindOf(s!) === 'm365' ? testM365 : testLogin)(s!));
}

async function tryIt(series: string, args: string[]) {
  const dash = args.indexOf('--');
  if (!series?.includes('/') || dash < 0 || dash === args.length - 1) throw new Error('try WORKSPACE/SERIES [--out DIR] -- COMMAND ...');
  const at = args.indexOf('--out'), out = resolve(at >= 0 && at < dash ? args[at + 1] : 'try-output'), seriesDir = join(resolve(root), series);
  mkdirSync(join(out, 'working'), { recursive: true });
  // A stand-in instance: what the agent API needs of one, its log printed rather than kept.
  const inst = { dir: out, log: [], series: () => seriesDir, append: (by: string, op: string, data: object) => { console.log(`  [log] ${op} ${JSON.stringify(data)}`); return { seq: 0 }; } } as unknown as Instance;
  const api = await serveAgent({ inst });
  console.log(`${series}:\n${connectionsText(seriesDir)}\n`);
  let words = args.slice(dash + 1);
  const venv = join(app, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  if (words[0] === 'rf') words = [process.execPath, join(app, 'src', 'rf.ts'), ...words.slice(1)];
  if (words[0] === 'python') words = [join(venv, process.platform === 'win32' ? 'python.exe' : 'python'), ...words.slice(1)];
  const code = await new Promise<number>(done => spawn(words[0], words.slice(1), {
    stdio: 'inherit', cwd: app,
    env: { ...process.env, RF_URL: api.url, RF_TOKEN: api.token, RF_WORKING: join(out, 'working'), RF_SKILLS: SKILLS, PATH: [join(app, 'bin'), venv, process.env.PATH].join(delimiter) },
  }).on('exit', c => done(c ?? 1)).on('error', e => { console.error(e.message); done(1); }));
  await api.close();
  console.log(`\nExit ${code}. In ${join(out, 'working')}: ${readdirSync(join(out, 'working')).join(', ') || 'nothing'}`);
  process.exitCode = code;
}

try {
  if (cmd === 'test') await test(rest[0] ?? '');
  else if (cmd === 'try') await tryIt(rest[0], rest.slice(1));
  else throw new Error(`no command ${cmd}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await closeBrowser();
}

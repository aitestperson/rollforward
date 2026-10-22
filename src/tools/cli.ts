import { resolve } from 'node:path';
import { initSystem } from '../system.ts';
import { savedSystem, missing } from '../systems.ts';
import { testLogin, closeBrowser } from '../browser.ts';
import { parseArgs, run, tester, tools, usage } from './all.ts';

// Runs tools and system checks from a shell, as an admin, with the systems set up in DATA_ROOT:
//   node src/tools/cli.ts DATA_ROOT list
//   node src/tools/cli.ts DATA_ROOT test SYSTEM
//   node src/tools/cli.ts DATA_ROOT TOOL [--name value ...] [--out DIR]     (DIR defaults to ./tool-output)

const [root, cmd, ...rest] = process.argv.slice(2);
if (!root || !cmd) {
  console.error('usage: node src/tools/cli.ts DATA_ROOT list | test SYSTEM | TOOL [--name value ...] [--out DIR]');
  process.exit(2);
}
initSystem(resolve(root));
try {
  if (cmd === 'list') for (const t of tools()) console.log(`${usage(t)}\n  ${t.system}: ${t.summary}\n`);
  else if (cmd === 'test') {
    const s = savedSystem(rest[0] ?? ''), need = missing(s, rest[0]);
    if (need.length) throw new Error(`${rest[0]} still needs ${need.join(', ')}`);
    console.log(await (tester(s!.id) ?? testLogin)(s!));
  } else {
    const t = tools().find(t => t.name === cmd);
    if (!t) throw new Error(`no tool ${cmd}; list shows them`);
    const at = rest.indexOf('--out'), out = resolve(at >= 0 ? rest.splice(at, 2)[1] : 'tool-output');
    const r = await run(t, parseArgs(rest), out);
    console.log(`${r.text}\nAs of ${r.asOf} (${r.asOfFrom}). Saved in ${out}: ${r.files.map(f => f.replace(/^working\//, '')).join(', ')}`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await closeBrowser();
}

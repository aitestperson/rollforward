import { existsSync, readFileSync } from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);
const arg = args.join(' ');
const headers = { authorization: `Bearer ${process.env.RF_TOKEN}` };
const url = `${process.env.RF_URL}/agent`;

// rf browse SYSTEM ACTION ARGS...: one step in the server's browser. propose takes its steps as a file, or as JSON inline.
function browse(): Promise<Response> {
  const [system, action, ...rest] = args;
  if (action === 'propose' && rest[1] && existsSync(rest[1])) rest[1] = readFileSync(rest[1], 'utf8');
  return fetch(`${url}/browse`, { method: 'POST', headers, body: JSON.stringify({ system, action, args: rest }) });
}

let res: Response;
if (cmd === 'show') res = await fetch(`${url}/workspace`, { headers });
else if (cmd === 'put' && arg) res = await fetch(`${url}/workspace`, { method: 'PUT', headers, body: readFileSync(arg === '-' ? 0 : arg) });
else if (cmd === 'reply' && arg) res = await fetch(`${url}/reply`, { method: 'POST', headers, body: arg === '-' ? readFileSync(0) : arg });
else if (cmd === 'browse' && args.length >= 2) res = await browse();
else if (cmd === 'connections') res = await fetch(`${url}/connections`, { headers });
else if (cmd === 'settings') res = await fetch(`${url}/settings?skill=${encodeURIComponent(args[0] ?? '')}`, { headers });
else if ((cmd === 'files' || cmd === 'mail') && args.length >= 1) res = await fetch(`${url}/${cmd}`, { method: 'POST', headers, body: JSON.stringify({ args }) });
else {
  console.error('usage: rf show | rf put FILE | rf reply TEXT | rf connections | rf settings [SKILL] | rf files list LINK|REF | rf files get LINK|REF FILE'
    + ' | rf mail find [--date YYYY-MM-DD] [--subject TEXT] [--from TEXT] [--attachments] | rf mail save ID [--name REGEX] [--prefix TEXT]'
    + ' | rf browse SYSTEM open [PATH] | look | click N | type N TEXT | select N OPTION | press KEY | back | download N|PATH FILE | screenshot FILE | run SKILL/FLOW [--var NAME=VALUE ...] | propose "WHAT" STEPS.json');
  process.exit(2);
}
console.log(await res.text());
process.exitCode = res.ok ? 0 : 1;

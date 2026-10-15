import { readFileSync } from 'node:fs';

const [cmd, arg] = process.argv.slice(2);
const headers = { authorization: `Bearer ${process.env.RF_TOKEN}` };
const url = `${process.env.RF_URL}/agent`;

let res: Response;
if (cmd === 'show') res = await fetch(`${url}/workspace`, { headers });
else if (cmd === 'put' && arg) res = await fetch(`${url}/workspace`, { method: 'PUT', headers, body: readFileSync(arg === '-' ? 0 : arg) });
else if (cmd === 'reply' && arg) res = await fetch(`${url}/reply`, { method: 'POST', headers, body: arg === '-' ? readFileSync(0) : arg });
else {
  console.error('usage: rf show | rf put FILE | rf reply TEXT');
  process.exit(2);
}
console.log(await res.text());
process.exitCode = res.ok ? 0 : 1;

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../store.ts';
import { builtIn, savedSystem, system, missing, type System } from '../systems.ts';

// Tools: fetches the server makes for the agent, by name, from a system in its series' Tool use, with that system's credentials. Each
// saves what it fetched in the instance's working/ and says what it did. They only read.
//   rf tool jde-ar-aging --company 450      rf tools      lists the ones the series may use
// "Today" is the date asked (--date), else RF_TODAY, else today here; a test run sets RF_TODAY to a day the systems have data for.

export type Args = Record<string, string[]>;
export type Context = {
  args: Args; asOf: string; asOfFrom: string;
  // Saves bytes under working/, under a safe version of `name`, and returns the path relative to the instance.
  save(name: string, bytes: Buffer | string): string;
  // A system the tool needs, which must be ready, such as the m365 system a source fetches through.
  need(id: string): System;
  settings: Record<string, string>;
};
export type Param = { name: string; hint: string; required?: boolean; many?: boolean; choices?: string[] };
export type Tool = { name: string; system: string; summary: string; params: Param[]; run(ctx: Context): Promise<{ files: string[]; text: string }> };

const registry: Tool[] = [];
export const register = (...tools: Tool[]) => void registry.push(...tools);
export const tools = () => registry;

// Systems page Test: what checking a system means, for systems whose check is more than signing in to a site.
const testers = new Map<string, (s: System) => Promise<string>>();
export const registerTest = (id: string, fn: (s: System) => Promise<string>) => void testers.set(id, fn);
export const tester = (id: string) => testers.get(id);

// The tools of the systems a series has in its Tool use.
export const toolsFor = (chosen: string[]) => registry.filter(t => chosen.includes(t.system));

export const localDate = (d = new Date()) => d.toLocaleDateString('sv');

export function asOf(args: Args): { asOf: string; asOfFrom: string } {
  const d = args.date?.[0] ?? process.env.RF_TODAY;
  if (d && !/^\d{4}-\d\d-\d\d$/.test(d)) throw new HttpError(400, `--date is YYYY-MM-DD, not ${d}`);
  return d ? { asOf: d, asOfFrom: args.date?.[0] ? '--date' : 'RF_TODAY' } : { asOf: localDate(), asOfFrom: 'today' };
}

// Local midnight of a YYYY-MM-DD day, plus `days`.
export function day(date: string, days = 0): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d + days);
}

const safe = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();

export function usage(t: Tool): string {
  return `rf tool ${t.name} ${t.params.map(p => `${p.required ? '' : '['}--${p.name} ${p.choices ? p.choices.join('|') : p.name.toUpperCase()}${p.many ? ' …' : ''}${p.required ? '' : ']'}`).join(' ')}`.trim();
}

function notReady(id: string): string {
  const s = savedSystem(id), name = s?.name ?? builtIn(id)?.name ?? id;
  return `${name} is ${s ? `not ready: it needs ${missing(s, id).join(', ')}` : 'not set up yet'}. An admin sets it up under Systems.`;
}

// Runs a tool, saving into `outDir` (an instance's working/). Checks its arguments, and that its system and what that uses are ready.
export async function run(t: Tool, args: Args, outDir: string): Promise<{ files: string[]; text: string; asOf: string; asOfFrom: string }> {
  for (const p of t.params) {
    const v = args[p.name] ?? [];
    if (p.required && !v.length) throw new HttpError(400, `${t.name} needs --${p.name}: ${p.hint}\n${usage(t)}`);
    if (!p.many && v.length > 1) throw new HttpError(400, `${t.name} takes one --${p.name}`);
    for (const x of v) if (p.choices && !p.choices.includes(x)) throw new HttpError(400, `--${p.name} is one of ${p.choices.join(', ')}`);
  }
  for (const k of Object.keys(args)) if (k !== 'date' && !t.params.some(p => p.name === k)) throw new HttpError(400, `${t.name} has no --${k}\n${usage(t)}`);
  const sys = savedSystem(t.system);
  if (!sys || missing(sys).length) throw new HttpError(409, notReady(t.system));
  const when = asOf(args);
  mkdirSync(outDir, { recursive: true });
  const ctx: Context = {
    args, ...when, settings: sys!.settings ?? {},
    // A name already there is never overwritten, as the screen may have shown that file: the new one gets " (2)", " (3)"...
    save(name, bytes) {
      const clean = safe(name), dot = clean.lastIndexOf('.'), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
      let file = clean;
      for (let n = 2; existsSync(join(outDir, file)); n++) file = `${stem} (${n})${ext}`;
      writeFileSync(join(outDir, file), bytes);
      return `working/${file}`;
    },
    need(id) {
      const s = system(id);
      if (!s) throw new HttpError(409, notReady(id));
      return s;
    },
  };
  const out = await t.run(ctx);
  return { ...out, ...when };
}

// Parses `--name value` pairs, where a name may repeat.
export function parseArgs(words: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < words.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(words[i]);
    if (!m) throw new HttpError(400, `expected --name value, not ${words[i]}`);
    const v = m[2] ?? words[++i];
    if (v === undefined) throw new HttpError(400, `--${m[1]} needs a value`);
    (args[m[1]] ??= []).push(v);
  }
  return args;
}

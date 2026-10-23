import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.ts';
import { readFlow } from './flow.ts';
import type { FlowLookup } from './browser.ts';
import type { Field } from './systems.ts';

// Skills: what to fetch, and how, built on the connections (systems.ts). Each is a folder skills/<id>/ with
// - SKILL.md, in Pi's format: a front matter with `name` and `description`, then instructions the agent reads when it needs them;
// - skill.json, rollforward's: {"connections": [ids], "settings": [{"key", "label", "hint"?, "optional"?}]};
// - whatever it runs: scripts the agent runs in its sandbox, which reach connections through `rf`, and flows (*.flow.json) the
//   server runs in a web connection's browser.
// A series chooses its skills under Skill use and gives each its settings (series.json `skills`); a run loads only those.

export const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export type Skill = { id: string; name: string; description: string; dir: string; connections: string[]; settings: Field[]; flows: string[] };
export type Chosen = Record<string, Record<string, string>>;

function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text), out: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export function skills(): Skill[] {
  if (!existsSync(SKILLS)) return [];
  return readdirSync(SKILLS).filter(id => existsSync(join(SKILLS, id, 'SKILL.md'))).sort().map(id => {
    const dir = join(SKILLS, id), fm = frontMatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
    const meta = existsSync(join(dir, 'skill.json')) ? JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf8')) : {};
    return {
      id, name: fm.name ?? id, description: fm.description ?? '', dir, connections: meta.connections ?? [], settings: meta.settings ?? [],
      flows: readdirSync(dir).filter(f => f.endsWith('.flow.json')).map(f => f.replace(/\.flow\.json$/, '')),
    };
  });
}

export const skill = (id: string) => skills().find(s => s.id === id);

// What a series may save as its skills: chosen ones that exist, each with only the settings it declares, as short strings.
export function checkChosen(input: unknown): Chosen {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'skills is {"<skill>": {"<setting>": "<value>"}}');
  const out: Chosen = {};
  for (const [id, values] of Object.entries(input as Record<string, unknown>)) {
    const s = skill(id);
    if (!s) throw new HttpError(400, `no skill ${id}; there are ${skills().map(x => x.id).join(', ')}`);
    out[id] = {};
    for (const [k, v] of Object.entries((values ?? {}) as Record<string, unknown>)) {
      if (!s.settings.some(f => f.key === k)) throw new HttpError(400, `${id} has no setting ${k}`);
      if (typeof v !== 'string' || v.length > 2000) throw new HttpError(400, `${id} ${k}: text of up to 2000 characters`);
      if (v.trim()) out[id][k] = v.trim();
    }
  }
  return out;
}

// The settings a chosen skill still needs.
export const unset = (s: Skill, values: Record<string, string> = {}) => s.settings.filter(f => !f.optional && !values[f.key]).map(f => f.label);

export function flowLookup(chosen: Chosen): FlowLookup {
  return name => {
    const [id, flow] = name.split('/');
    const s = chosen[id] ? skill(id) : undefined;
    if (!s) throw new HttpError(403, `${id} is not in this series' Skill use`);
    if (!flow || !s.flows.includes(flow)) throw new HttpError(404, `${id} has no flow ${flow ?? ''}; it has ${s.flows.join(', ') || 'none'}`);
    return { flow: readFlow(join(s.dir, `${flow}.flow.json`)), vars: chosen[id] };
  };
}

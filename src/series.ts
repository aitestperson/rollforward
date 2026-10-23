import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skill } from './skills.ts';

// series.json: {"visible_to": [series], "skills": [skill ids]}, set by people through the server. A series saved before Skill use
// existed keeps what it had then, as every run loaded e1-automation; one saved with each skill's settings keeps its choice, the
// settings now being the admins' (skills.ts). Tool use, the connections a series once chose, is gone: its skills say what they use.
export type SeriesSettings = { visible_to: string[]; skills: string[]; [k: string]: unknown };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json'), { tools: _, ...s } = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  const chosen = Array.isArray(s.skills) ? s.skills : s.skills ? Object.keys(s.skills) : skill('e1-automation') ? ['e1-automation'] : [];
  return { ...s, visible_to: s.visible_to ?? [], skills: chosen };
}

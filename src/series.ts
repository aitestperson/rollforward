import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skill, type Chosen } from './skills.ts';

// series.json: {"visible_to": [series], "tools": [connection ids], "skills": {"<skill>": {settings}}}, set by people through the
// server. A series saved before Skill use existed keeps what it had then: every run loaded e1-automation.
export type SeriesSettings = { visible_to: string[]; tools: string[]; skills: Chosen; [k: string]: unknown };

export function seriesSettings(seriesDir: string): SeriesSettings {
  const p = join(seriesDir, 'series.json'), s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  return { ...s, visible_to: s.visible_to ?? [], tools: s.tools ?? [], skills: s.skills ?? (skill('e1-automation') ? { 'e1-automation': {} } : {}) };
}

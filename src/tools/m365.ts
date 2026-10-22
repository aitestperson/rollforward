import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HttpError } from '../store.ts';
import { attachments, children, download, messages, parent, shared, type DriveItem } from '../graph.ts';
import { asOf, day, localDate, register, registerTest } from './index.ts';
import { savedSystem, system } from '../systems.ts';

// Tools that read through Microsoft Graph: JDE A/R aging reports and the Walmart paid history from OneDrive, Kohls's open AP report
// from a mailbox.

const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const python = join(app, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const exec = promisify(execFile);
const SHEETS = /\.(csv|xlsx|xlsm|xls)$/i;

// The ways a file name may carry a date, each turned into YYYY-MM-DD.
function datesIn(name: string): string[] {
  const out: string[] = [], pad = (n: string | number) => String(n).padStart(2, '0'), year = (y: string) => (y.length === 2 ? `20${y}` : y);
  for (const m of name.matchAll(/(?<!\d)(20\d\d)[-_. ]?(\d\d)[-_. ]?(\d\d)(?!\d)/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of name.matchAll(/(?<!\d)(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{2}|\d{4})(?!\d)/g)) out.push(`${year(m[3])}-${pad(m[1])}-${pad(m[2])}`);
  for (const m of name.matchAll(/(?<!\d)(\d\d)(\d\d)(\d\d)(?!\d)/g)) out.push(`20${m[3]}-${m[1]}-${m[2]}`);
  return out;
}

// The folder a link points at, or, if it is a year folder (2026) and the date is in another year, that year's folder beside it.
async function yearFolder(s: Parameters<typeof shared>[0], link: string, date: string): Promise<DriveItem> {
  const folder = await shared(s, link), year = date.slice(0, 4);
  if (!folder.folder) throw new HttpError(400, `the link is to a file, ${folder.name}, not a folder`);
  if (!/^20\d\d$/.test(folder.name) || folder.name === year) return folder;
  const other = (await children(s, await parent(s, folder))).find(i => i.folder && i.name === year);
  if (!other) throw new HttpError(404, `there is no ${year} folder beside ${folder.name}`);
  return other;
}

// Systems page Test: each check reads something real, so a missing permission shows up as Microsoft's own error.
const recent = (items: DriveItem[]) => items.filter(i => i.file).sort((a, b) => b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime));

registerTest('m365-mail', async s => {
  const mailbox = s.settings?.mailbox;
  if (!mailbox) throw new HttpError(409, 'set the mailbox first');
  const { asOf: d } = asOf({}), found = await messages(s, mailbox, day(d), day(d, 1));
  return `Read ${mailbox}: ${found.length} message${found.length === 1 ? '' : 's'} on ${d}.`;
});

registerTest('m365-files', async s => {
  const link = savedSystem('jde-ar')?.settings?.folder_450 ?? savedSystem('walmart')?.settings?.file;
  if (!link) return 'Microsoft gave the app a token. Set up JDE A/R or Walmart to check it can read their files.';
  const item = await shared(s, link);
  return `Read ${item.name} on OneDrive${item.folder ? `, a folder of ${(await children(s, item)).length} items` : ''}.`;
});

registerTest('jde-ar', async j => {
  const s = system('m365-files');
  if (!s) throw new HttpError(409, 'set up M365 OneDrive first');
  const { asOf: d } = asOf({}), out: string[] = [];
  for (const c of ['450', '236']) {
    const folder = await yearFolder(s, j.settings![`folder_${c}`], d), files = recent(await children(s, folder));
    out.push(`${c}: folder ${folder.name}, ${files.length} files, latest ${files[0]?.name ?? 'none'}`);
  }
  return out.join('\n');
});

registerTest('walmart', async w => {
  const s = system('m365-files');
  if (!s) throw new HttpError(409, 'set up M365 OneDrive first');
  const item = await shared(s, w.settings!.file);
  return `Read ${item.name}, changed ${item.lastModifiedDateTime}.`;
});

registerTest('kohls', async k => {
  const s = system('m365-mail');
  if (!s) throw new HttpError(409, 'set up M365 Mail first');
  const { asOf: d } = asOf({}), want = (k.settings?.subject ?? '').toLowerCase();
  const found = (await messages(s, s.settings!.mailbox, day(d), day(d, 1))).filter(m => (m.subject ?? '').toLowerCase().includes(want));
  return `${found.length} mail${found.length === 1 ? '' : 's'} on ${d} with that subject${found[0] ? `, the latest at ${found[0].receivedDateTime}${found[0].hasAttachments ? ' with attachments' : ', without attachments'}` : ''}.`;
});

register({
  name: 'jde-ar-aging', system: 'jde-ar',
  summary: 'The JDE A/R aging report of a company, as of the date: the csv or Excel file in its OneDrive folder dated that day.',
  params: [{ name: 'company', hint: 'the JDE company: 450 (LFM) or 236 (MHI)', required: true, choices: ['450', '236'] }],
  async run(ctx) {
    const company = ctx.args.company[0], link = ctx.settings[`folder_${company}`], s = ctx.need('m365-files');
    const folder = await yearFolder(s, link, ctx.asOf);
    const files = (await children(s, folder)).filter(i => i.file && SHEETS.test(i.name));
    // A file dated the day in its name, else one changed that day; of several, the latest changed.
    const byName = files.filter(f => datesIn(f.name).includes(ctx.asOf));
    const pick = (byName.length ? byName : files.filter(f => localDate(new Date(f.lastModifiedDateTime)) === ctx.asOf))
      .sort((a, b) => b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime));
    if (!pick.length) {
      const recent = files.sort((a, b) => b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime)).slice(0, 5).map(f => `${f.name} (changed ${f.lastModifiedDateTime.slice(0, 10)})`);
      throw new HttpError(404, `no AR aging file for company ${company} dated ${ctx.asOf} in ${folder.name}. Latest there: ${recent.join('; ') || 'none'}`);
    }
    // A JDE csv states its own date ("As-Of Date,10/20/2026"); of several candidates, one whose date is the day asked wins.
    const got: { f: DriveItem; bytes: Buffer; reportDate?: string }[] = [];
    for (const f of pick.slice(0, 5)) {
      const bytes = await download(s, f), m = /As-Of Date,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(bytes.subarray(0, 2000).toString('latin1'));
      got.push({ f, bytes, reportDate: m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : undefined });
      if (got.at(-1)!.reportDate === ctx.asOf) break;
    }
    const best = got.find(g => g.reportDate === ctx.asOf) ?? got[0], f = best.f;
    const saved = ctx.save(`JDE AR aging ${company} ${ctx.asOf} - ${f.name}`, best.bytes);
    const stated = best.reportDate ? (best.reportDate === ctx.asOf ? `; the report's As-Of Date is ${best.reportDate}` : `; but the report's As-Of Date is ${best.reportDate}, not ${ctx.asOf}`) : '';
    return { files: [saved], text: `Company ${company}: ${f.name} from OneDrive folder ${folder.name} (${byName.length ? 'dated' : 'changed'} ${ctx.asOf}, at ${f.lastModifiedDateTime}${stated})${pick.length > 1 ? `, of ${pick.length} candidates that day` : ''}.` };
  },
});

register({
  name: 'walmart-paid-history', system: 'walmart',
  summary: 'Walmart Retail Link paid history: from the Paid History workbook on OneDrive, each sheet\'s rows whose date paid falls in the days up to the date, one csv a sheet.',
  params: [],
  async run(ctx) {
    const s = ctx.need('m365-files'), item = await shared(s, ctx.settings.file);
    const days = Math.max(1, Number(ctx.settings.days ?? 7) || 7), from = localDate(day(ctx.asOf, -(days - 1)));
    const tmp = mkdtempSync(join(tmpdir(), 'rf-walmart-'));
    try {
      writeFileSync(join(tmp, 'book.xlsx'), await download(s, item));
      const { stdout } = await exec(python, [join(app, 'src', 'tools', 'walmart_filter.py'), join(tmp, 'book.xlsx'), tmp, ctx.settings.sheets ?? '236, 450', ctx.settings.date_column ?? 'Date Paid', from, ctx.asOf], { timeout: 600_000, maxBuffer: 16e6 })
        .catch(e => { throw new HttpError(422, `reading ${item.name}: ${e.killed ? 'it took over 10 minutes' : (e.stderr || e.message).trim().split('\n').at(-1)}`); });
      const sheets: { sheet: string; rows: number; total: number; file: string }[] = JSON.parse(stdout);
      const files = sheets.map(x => ctx.save(`Walmart paid ${x.sheet} ${from} to ${ctx.asOf}.csv`, readFileSync(x.file)));
      return { files, text: `${item.name} (changed ${item.lastModifiedDateTime}), ${ctx.settings.date_column ?? 'Date Paid'} from ${from} to ${ctx.asOf}: ${sheets.map(x => `sheet ${x.sheet}, ${x.rows} of ${x.total} rows`).join('; ')}.` };
    } finally {
      // On Windows a scanner may still hold the folder; leaving it in the temp folder is harmless.
      try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
  },
});

register({
  name: 'kohls-open-ap', system: 'kohls',
  summary: 'Kohl\'s open AP report: the Excel attachment of the day\'s mail whose subject contains the configured words, from the mailbox.',
  params: [],
  async run(ctx) {
    const s = ctx.need('m365-mail'), mailbox = s.settings?.mailbox ?? '', want = (ctx.settings.subject ?? '').toLowerCase();
    if (!mailbox) throw new HttpError(409, 'M365 Mail has no mailbox set');
    const found = (await messages(s, mailbox, day(ctx.asOf), day(ctx.asOf, 1))).filter(m => m.hasAttachments && (m.subject ?? '').toLowerCase().includes(want));
    if (!found.length) throw new HttpError(404, `no mail with an attachment and a subject containing "${ctx.settings.subject}" in ${mailbox} on ${ctx.asOf}`);
    const m = found[0], files: string[] = [];
    for (const a of await attachments(s, mailbox, m.id)) if (SHEETS.test(a.name)) files.push(ctx.save(`Kohls open AP ${ctx.asOf} - ${a.name}`, a.bytes));
    if (!files.length) throw new HttpError(404, `the mail "${m.subject}" (${m.receivedDateTime}) has no csv or Excel attachment`);
    return { files, text: `From the mail "${m.subject}" received ${m.receivedDateTime} in ${mailbox}${found.length > 1 ? `, the latest of ${found.length} that day` : ''}.` };
  },
});

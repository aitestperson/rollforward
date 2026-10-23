"""Fetches a company's JDE A/R aging report for a day from its OneDrive folder into working/.

usage: fetch.py --company 450|236 [--date YYYY-MM-DD]
Reads through the server (RF_URL, RF_TOKEN), never with credentials of its own; saves into RF_WORKING.
"""
import argparse, json, os, re, sys
from datetime import date, datetime
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SHEETS = re.compile(r'\.(csv|xlsx|xlsm|xls)$', re.I)


def rf(path, body=None, query=None):
    """One call to the server's agent API; exits with what the server said if it refused."""
    url = f"{os.environ['RF_URL']}/agent/{path}" + (f'?{urlencode(query)}' if query else '')
    req = Request(url, data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'POST',
                  headers={'authorization': f"Bearer {os.environ['RF_TOKEN']}"})
    try:
        with urlopen(req, timeout=600) as r:
            text = r.read().decode()
    except HTTPError as e:
        sys.exit(f"rf {path}: {e.read().decode().strip()}")
    try:
        return json.loads(text)
    except ValueError:
        return text


def dates_in(name):
    """The ways a file name may carry a date, each as YYYY-MM-DD."""
    out = [f'{y}-{m}-{d}' for y, m, d in re.findall(r'(?<!\d)(20\d\d)[-_. ]?(\d\d)[-_. ]?(\d\d)(?!\d)', name)]
    for m, d, y in re.findall(r'(?<!\d)(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{2}|\d{4})(?!\d)', name):
        out.append(f"{y if len(y) == 4 else '20' + y}-{int(m):02}-{int(d):02}")
    out += [f'20{y}-{m}-{d}' for m, d, y in re.findall(r'(?<!\d)(\d\d)(\d\d)(\d\d)(?!\d)', name)]
    return out


def local_day(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone().date().isoformat()


def as_of(path):
    """The report's own date, from its "As-Of Date,10/20/2026" line."""
    with open(path, 'rb') as f:
        m = re.search(r'As-Of Date,\s*(\d{1,2})/(\d{1,2})/(\d{4})', f.read(2000).decode('latin1'))
    return f'{m[3]}-{int(m[1]):02}-{int(m[2]):02}' if m else None


def unique(path):
    stem, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(path):
        path, n = f'{stem} ({n}){ext}', n + 1
    return path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--company', required=True, choices=['450', '236'])
    p.add_argument('--date')
    a = p.parse_args()
    day, frm = (a.date, '--date') if a.date else (os.environ['RF_TODAY'], 'RF_TODAY') if os.environ.get('RF_TODAY') else (date.today().isoformat(), 'today')
    link = rf('settings', query={'skill': 'jde-ar-aging'}).get(f'folder_{a.company}')
    if not link:
        sys.exit(f'jde-ar-aging has no company {a.company} folder link set (an admin sets it under Skills)')

    folder = rf('files', {'args': ['list', link]})
    year = day[:4]
    # A link to one year's folder leads to the year asked, beside it.
    if re.fullmatch(r'20\d\d', folder['name']) and folder['name'] != year:
        if not folder.get('parent'):
            sys.exit(f"{folder['name']} has no parent folder to find {year} in")
        sibling = next((i for i in rf('files', {'args': ['list', folder['parent']]})['items'] if i['folder'] and i['name'] == year), None)
        if not sibling:
            sys.exit(f"there is no {year} folder beside {folder['name']}")
        folder = rf('files', {'args': ['list', sibling['ref']]})

    files = [i for i in folder['items'] if not i['folder'] and SHEETS.search(i['name'])]
    by_name = [f for f in files if day in dates_in(f['name'])]
    pick = sorted(by_name or [f for f in files if local_day(f['modified']) == day], key=lambda f: f['modified'], reverse=True)
    if not pick:
        latest = sorted(files, key=lambda f: f['modified'], reverse=True)[:5]
        sys.exit(f"no AR aging file for company {a.company} dated {day} ({frm}) in OneDrive folder {folder['name']}. Latest there: "
                 + ('; '.join(f"{f['name']} (changed {f['modified'][:10]})" for f in latest) or 'none'))

    # Of several candidates, the one whose own As-Of Date is the day.
    working = os.environ['RF_WORKING']
    got = []
    for i, f in enumerate(pick[:5]):
        tmp = f".jde-{a.company}-{i}{os.path.splitext(f['name'])[1]}"
        rf('files', {'args': ['get', f['ref'], tmp]})
        got.append((f, os.path.join(working, tmp), as_of(os.path.join(working, tmp))))
        if got[-1][2] == day:
            break
    f, path, stated = next((g for g in got if g[2] == day), got[0])
    final = unique(os.path.join(working, f"JDE AR aging {a.company} {day} - {f['name']}"))
    os.replace(path, final)
    for _, other, _ in got:
        if other != path and os.path.exists(other):
            os.remove(other)

    note = '' if not stated else f'; its As-Of Date is {stated}' if stated == day else f'; but its As-Of Date is {stated}, not {day}'
    print(f"Saved working/{os.path.basename(final)}: {f['name']} from OneDrive folder {folder['name']}, "
          f"{'dated' if by_name else 'changed'} {day} ({frm}), at {f['modified']}{note}"
          + (f', the latest of {len(pick)} candidates' if len(pick) > 1 else '') + '.')
    print(f"Source: JDE A/R {a.company}, OneDrive {f['name']}" + (f' (As-Of {stated})' if stated else '') + f", read {datetime.now():%m-%d %H:%M}")


if __name__ == '__main__':
    main()

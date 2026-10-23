"""Fetches the day's Target Specific Document Search export from the Target Input folder on OneDrive into working/.

usage: fetch.py [--date YYYY-MM-DD]
The files are named for their day, MMDD first (1023Input-Specific Document Search.csv). Reads through the server (RF_URL, RF_TOKEN),
never with credentials of its own; saves into RF_WORKING.
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


def for_day(name, day):
    """Whether a file name is for the day: MMDD at its start, or the full date anywhere in it."""
    y, m, d = day.split('-')
    return name.startswith(m + d) and not name[4:5].isdigit() or any(
        f'{a}-{b}-{c}' == day for a, b, c in re.findall(r'(?<!\d)(20\d\d)[-_. ]?(\d\d)[-_. ]?(\d\d)(?!\d)', name))


def unique(path):
    stem, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(path):
        path, n = f'{stem} ({n}){ext}', n + 1
    return path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--date')
    a = p.parse_args()
    day, frm = (a.date, '--date') if a.date else (os.environ['RF_TODAY'], 'RF_TODAY') if os.environ.get('RF_TODAY') else (date.today().isoformat(), 'today')
    link = rf('settings', query={'skill': 'target-document-search'}).get('folder')
    if not link:
        sys.exit('target-document-search has no Target Input folder link set (an admin sets it under Skills)')
    folder = rf('files', {'args': ['list', link]})
    files = [i for i in folder.get('items', []) if not i['folder'] and SHEETS.search(i['name'])]
    pick = sorted([f for f in files if for_day(f['name'], day)], key=lambda f: f['modified'], reverse=True)
    if not pick:
        latest = sorted(files, key=lambda f: f['modified'], reverse=True)[:5]
        sys.exit(f"no Target input file for {day} ({frm}) in OneDrive folder {folder['name']}: no name starts with {day[5:7]}{day[8:]}. Latest there: "
                 + ('; '.join(f"{f['name']} (changed {f['modified'][:10]})" for f in latest) or 'none'))
    f = pick[0]
    name = os.path.basename(unique(os.path.join(os.environ['RF_WORKING'], f"Target specific document search {day} - {f['name']}")))
    rf('files', {'args': ['get', f['ref'], name]})
    print(f"Saved working/{name}: {f['name']} from OneDrive folder {folder['name']}, for {day} ({frm}), changed at {f['modified']}"
          + (f', the latest of {len(pick)} for that day' if len(pick) > 1 else '') + '.')
    print(f"Source: Target, OneDrive {f['name']}, read {datetime.now():%m-%d %H:%M}")


if __name__ == '__main__':
    main()

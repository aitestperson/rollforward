"""Fetches Walmart's Paid History workbook from OneDrive and keeps, for each configured sheet, the rows paid in the days up to a day.

usage: fetch.py [--date YYYY-MM-DD]
Reads through the server (RF_URL, RF_TOKEN), never with credentials of its own; saves into RF_WORKING.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile
from datetime import date, datetime, timedelta
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))


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


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--date')
    a = p.parse_args()
    day, frm = (a.date, '--date') if a.date else (os.environ['RF_TODAY'], 'RF_TODAY') if os.environ.get('RF_TODAY') else (date.today().isoformat(), 'today')
    s = rf('settings', query={'skill': 'walmart-paid-history'})
    if not s.get('file'):
        sys.exit('walmart-paid-history has no Paid History workbook link set (an admin sets it under Skills)')
    days = max(1, int(s.get('days') or 7))
    start = (date.fromisoformat(day) - timedelta(days=days - 1)).isoformat()
    column, sheets = s.get('date_column') or 'Date Paid', s.get('sheets') or '236, 450'

    working = os.environ['RF_WORKING']
    got = rf('files', {'args': ['get', s['file'], '.walmart-book.xlsx']})
    book, tmp = os.path.join(working, '.walmart-book.xlsx'), tempfile.mkdtemp(prefix='rf-walmart-')
    try:
        r = subprocess.run([sys.executable, os.path.join(HERE, 'walmart_filter.py'), book, tmp, sheets, column, start, day],
                           capture_output=True, text=True, timeout=600)
        if r.returncode:
            sys.exit(f"reading {got['name']}: {(r.stderr or r.stdout).strip().splitlines()[-1]}")
        out = []
        for x in json.loads(r.stdout):
            name = f"Walmart paid {x['sheet']} {start} to {day}.csv"
            target, n = os.path.join(working, name), 2
            while os.path.exists(target):
                target, n = os.path.join(working, f"Walmart paid {x['sheet']} {start} to {day} ({n}).csv"), n + 1
            shutil.move(x['file'], target)
            out.append(f"working/{os.path.basename(target)}: sheet {x['sheet']}, {x['rows']} of {x['total']} rows")
    finally:
        os.remove(book)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{got['name']} (changed {got['modified']}), {column} from {start} to {day} ({frm}):\n" + '\n'.join(out))
    print(f"Source: Walmart Retail Link, OneDrive {got['name']} (changed {got['modified'][:16]}), read {datetime.now():%m-%d %H:%M}")


if __name__ == '__main__':
    main()

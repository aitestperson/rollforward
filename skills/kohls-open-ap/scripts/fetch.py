"""Saves the spreadsheet attachments of the day's latest mail whose subject has the configured words into working/.

usage: fetch.py [--date YYYY-MM-DD]
Reads through the server (RF_URL, RF_TOKEN), never with credentials of its own; saves into RF_WORKING.
"""
import argparse, json, os, sys
from datetime import date, datetime
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


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
    subject = rf('settings', query={'skill': 'kohls-open-ap'}).get('subject')
    if not subject:
        sys.exit('this series has no subject set for kohls-open-ap (series settings, Skill use)')
    found = rf('mail', {'args': ['find', '--date', day, '--subject', subject, '--attachments']})
    if not found['messages']:
        sys.exit(f"no mail with an attachment and a subject containing \"{subject}\" in {found['mailbox']} on {day} ({frm})")
    m = found['messages'][0]
    saved = rf('mail', {'args': ['save', m['id'], '--name', r'\.(csv|xlsx|xlsm|xls)$', '--prefix', f'Kohls open AP {day} - ']})['saved']
    if not saved:
        sys.exit(f"the mail \"{m['subject']}\" ({m['received']}) has no csv or Excel attachment")
    print(f"Saved {', '.join(saved)} from the mail \"{m['subject']}\" received {m['received']} in {found['mailbox']}"
          + (f", the latest of {len(found['messages'])} that day" if len(found['messages']) > 1 else '') + f' ({day}, {frm}).')
    print(f"Source: Kohls, mail \"{m['subject']}\" received {m['received'][:16]}, read {datetime.now():%m-%d %H:%M}")


if __name__ == '__main__':
    main()

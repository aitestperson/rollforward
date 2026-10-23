---
name: kohls-open-ap
description: Fetch Kohl's open AP report - the Excel attachment of the day's mail whose subject has the configured words (such as "Request successfully processed for ..."). Use when an instance needs Kohl's open-to-pay report as an input.
---

# Kohl's open AP from the mailbox

Kohl's open-to-pay report arrives each day as an Excel attachment to a mail with a fixed subject. This skill finds the day's latest such mail in the **M365 Mail** connection's mailbox and saves its spreadsheet attachments. The subject words are this series' setting (`rf settings kohls-open-ap`).

```bash
python "$RF_SKILLS/kohls-open-ap/scripts/fetch.py" [--date YYYY-MM-DD]
```

- **The day:** `--date`, else `RF_TODAY` (set on a test server), else today here.
- **The output:** `working/Kohls open AP 2026-10-20 - <attachment>.xlsx`, and the mail it came from. Use a line like `Kohls, mail "FW: Request successfully processed…" received 10-20 23:18, read 10-22 09:12` as the item's `"source"`.
- **No mail that day** (it exits 1): don't take another day's. Note it on the item and carry on with the rest.
- Put the command in `process.md`, so the next instance repeats it.

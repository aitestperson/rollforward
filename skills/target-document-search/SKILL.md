---
name: target-document-search
description: Fetch Target's Specific Document Search export (Partners Online, Account Payable - Domestic) for a day, from the Target Input folder on OneDrive where it is put each day. Use when an instance needs Target's AP documents as an input.
---

# Target Specific Document Search, from OneDrive

The Specific Document Search export from Target Partners Online is put each day into a Target Input folder on OneDrive, as a csv whose name starts with its day, `MMDD` (such as `1023Input-Specific Document Search.csv`). This skill picks the day's one and saves it in `working/`. It reads through the **M365 OneDrive** connection; the folder link is the skill's setting, set by admins under Skills (`rf settings target-document-search`).

```bash
python "$RF_SKILLS/target-document-search/scripts/fetch.py" [--date YYYY-MM-DD]
```

- **The day:** `--date`, else `RF_TODAY` (set on a test server), else today here. The output says which, so check it against the instance.
- **The file:** the one whose name starts with the day's `MMDD` (or carries the full date); of several, the latest changed.
- **The output:** `working/Target specific document search 2026-10-23 - <name>.csv`, and a line to use as the item's `"source"`, such as `Target, OneDrive 1023Input-Specific Document Search.csv, read 10-23 09:12`.
- **No file for the day** (it exits 1 and lists the latest files there): don't take another day's file instead. Note it on the item and carry on with the rest; a person puts the day's export in the folder.
- Put the command in `process.md`, so the next instance repeats it.

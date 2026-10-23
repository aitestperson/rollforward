---
name: jde-ar-aging
description: Fetch a JDE A/R aging report (company 450, LFM, or 236, MHI) for a day from its OneDrive folder. Use when an instance needs the JDE AR aging of 450 or 236 as an input.
---

# JDE A/R aging from OneDrive

JDE drops each company's AR aging report, a csv, into a OneDrive folder every day. This skill picks the one for the day and saves it in `working/`. It reads through the **M365 OneDrive** connection; the folder links are the skill's settings, set by admins under Skills (`rf settings jde-ar-aging`).

```bash
python "$RF_SKILLS/jde-ar-aging/scripts/fetch.py" --company 450 [--date YYYY-MM-DD]
```

- **The day:** `--date`, else `RF_TODAY` (set on a test server), else today here. The output says which, so check it against the instance.
- **The file:** one whose name carries the day, else one changed that day. Of several, the one whose own `As-Of Date` line is the day wins. A link to a year folder (`…/2026`) is followed to the year asked.
- **The output:** the saved file (`working/JDE AR aging 450 2026-10-20 - <name>.csv`), and a line to use as the item's `"source"`, such as `JDE A/R 450, OneDrive <file>.csv (As-Of 10/20/2026), read 10-22 09:12`.
- **No file for the day** (it exits 1 and lists the latest files there): don't take another day's file instead. Note it on the item and carry on with the rest.
- Put the command in `process.md`, so the next instance repeats it.

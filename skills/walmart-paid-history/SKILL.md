---
name: walmart-paid-history
description: Fetch Walmart Retail Link paid history from the Paid History workbook on OneDrive - for each configured sheet (such as 236 and 450) the rows paid in the last days up to a day, one csv a sheet. Use when an instance needs Walmart's recent payments as an input.
---

# Walmart Retail Link paid history

The Paid History workbook on OneDrive holds a sheet per company, each running to hundreds of thousands of rows. This skill reads it through the **M365 OneDrive** connection and keeps, for each sheet, the rows whose date paid falls in the days up to the day. The workbook link, the sheets, the date column and the number of days are this series' settings (`rf settings walmart-paid-history`).

```bash
python "$RF_SKILLS/walmart-paid-history/scripts/fetch.py" [--date YYYY-MM-DD]
```

- **The day:** `--date`, else `RF_TODAY` (set on a test server), else today here. The output says which, and the range it kept.
- **The output:** a csv per sheet, `working/Walmart paid 236 2026-10-14 to 2026-10-20.csv`, with how many rows it kept of how many. Use a line like `Walmart Retail Link, OneDrive Paid History (changed 10-20 15:02), read 10-22 09:12` as the item's `"source"`.
- Reading the workbook takes a minute or so; let it run.
- Put the command in `process.md`, so the next instance repeats it.

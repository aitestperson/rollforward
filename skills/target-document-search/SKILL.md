---
name: target-document-search
description: Export Target Partners Online's Specific Document Search (Account Payable - Domestic) as csv. Use when an instance needs Target's AP documents as an input.
---

# Target Specific Document Search

Uses the **Target** connection: the server signs in to Partners Online with its account, reads the one-time passcode Target mails from M365 Mail (pressing resend if none comes in 25 seconds), and runs this skill's flow in that browser. The report card's address is this series' setting.

```bash
rf browse target run target-document-search/export    # -> working/Target specific document search <today>.csv
```

- The report shows what it holds now, whatever `RF_TODAY` says.
- If Target has turned off email passcodes for the account after too many attempts, the sign-in says so: don't retry in this run. Note it on the item; a person can try the next day.
- Use a line like `Target Partners Online, Specific Document Search, read 10-22 09:12` as the item's `"source"`, and put the command in `process.md`.
- A failure names the step, says why, and leaves a screenshot in `working/`. Don't click through the site yourself instead; note it on the item.

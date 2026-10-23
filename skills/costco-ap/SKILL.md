---
name: costco-ap
description: Fetch Costco's Vendor Accounting Portal reports as csv - Payments for the last 12 months, and the Unpaid Items. Use when an instance needs what Costco paid or still owes as an input.
---

# Costco Vendor Accounting Portal

Uses the **Costco** connection: the server signs in to Costco's Vendor Hub with its account, reads the sign-in code Costco mails from M365 Mail, and runs this skill's flows in that browser. The portal's address is this series' setting.

```bash
rf browse costco run costco-ap/payments        # Payments, Last 12 Months -> working/Costco payments last 12 months <today>.csv
rf browse costco run costco-ap/unpaid-items    # Unpaid Items             -> working/Costco unpaid items <today>.csv
```

- Run both in the same run when you need both: they share one sign-in, so Costco mails one code, not two.
- The portal shows what it holds now; there is no earlier day to ask for, whatever `RF_TODAY` says.
- The Payments csv has a header line and a row per invoice. The Unpaid Items csv starts with a `Vendor,Total Balance` block, then a blank line, then the item rows. Say how many rows each has, and the total balance, on the items.
- Use a line like `Costco Vendor Accounting Portal, Payments (Last 12 Months), read 10-22 09:12` as the item's `"source"`, and put the commands in `process.md`.
- A failure names the step, says why, and leaves a screenshot in `working/`. Don't click through the portal yourself instead; note it on the item.

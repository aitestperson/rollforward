---
name: burlington-invoice
description: Look up Burlington invoices by number on its Traverse vendor portal (Invoice Inquiry) and save them as csv - status, due date, check number and check date. Use when an instance needs whether and when Burlington paid given invoices.
---

# Burlington Invoice Inquiry

The server signs in to Burlington's Traverse portal with the account in this skill's settings (set by admins under Skills; you never see the password), and runs this skill's flow in that browser.

```bash
rf flow burlington-invoice/invoice --var invoices=12345678,12345679
```

- `invoices` is one invoice number, or several separated by commas, all in one search.
- The csv, `working/Burlington invoices <numbers> <today>.csv`, has a row per invoice found (`Invoice Num` first). Compare it with the numbers you asked for and say on the item which weren't found. If none was found, the flow stops with "Burlington has no invoice …" and saves nothing.
- The portal shows what it holds now, whatever `RF_TODAY` says.
- Use a line like `Burlington Traverse, Invoice Inquiry for 12345678, read 10-22 09:12` as the item's `"source"`, and put the command in `process.md`.
- A failure names the step, says why, and leaves a screenshot in `working/`. Don't click through the portal yourself instead; note it on the item.

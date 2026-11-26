---
name: monthly-close
description: "Use for monthly bookkeeping and bank reconciliation: turn local statements and invoices into a ledger, match line by line, check balances and list unmatched items; reports only."
metadata:
  pibot-version: "1"
  pibot-name: "Monthly close"
  pibot-params: "[{\"name\":\"statements\",\"description\":\"CSV / Excel exports from the bank or payment platform, or their folder\"},{\"name\":\"receipts\",\"description\":\"Folder with invoices and receipts\",\"default\":\"none\"},{\"name\":\"month\",\"description\":\"The month to close\"}]"
---

# Monthly close

Statements: {statements}
Receipts: {receipts}
Month: {month}

## Steps
1. Inspect the files first: list each file read with its row count, date range and currency; when a header is unclear, say how you read each column. Originals are read only.
2. Bookkeeping: one row per transaction with date, counterparty, memo, income, spending, currency, category and source (file name + line). Use the owner's existing categories; otherwise sales, software, contractors, advertising, office, taxes, transfer, other.
3. Moves between the owner's own accounts are transfers, neither income nor spending.
4. Reconciliation: the statement is the reference; find the invoice or receipt for each line (amount, date within 7 days and counterparty must all match).
5. Balance check: opening balance + income − spending = closing balance. If not, state the difference and list suspect lines (duplicates, refunds, fees, cross-month items).
6. For many rows you may ask to run a read-only summing command (reads inputs only, no network, writes a new file), explaining its purpose and waiting for confirmation; or build a workbook with formulas using the built-in Office tools.
7. Report only: payments, missing invoices and refunds go under For you to handle, and the owner acts personally.

## Delivery
Write two files in this run's output folder:
- `ledger-<month>.xlsx` (or CSV): the fields above, one row per transaction.
- `close-<month>.md`:

```
# Close <month>
Data period / source files / generated on

## Summary
| Category | Income | Spending | Count |

## Balance check
Opening ... + income ... - spending ... = ...; statement closing ...; difference ...

## Unmatched
| Date | Counterparty | Amount | Missing | Source line |

## For you to handle
- ...
```

## Checks
- Ledger rows equal the transaction rows of all source files (excluding header and total rows; say how many were excluded).
- Write "balance checked" only when the difference is 0; otherwise give the actual difference.
- Keep only the last four digits of card and account numbers.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

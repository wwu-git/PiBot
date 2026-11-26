---
name: cash-flow-report
description: "Use for cash flow and receivables: compute current cash, period income and spending, receivables ageing and upcoming payments from the ledger or statements, and draft reminders; reports only."
metadata:
  pibot-version: "1"
  pibot-name: "Cash flow and receivables"
  pibot-params: "[{\"name\":\"data\",\"description\":\"Ledger, statements, invoices or a receivables list\"},{\"name\":\"period\",\"description\":\"Date range the report covers\",\"default\":\"the last week\"}]"
---

# Cash flow and receivables

Data: {data}
Period: {period}

## Steps
1. List data sources, period and currencies first; use this month's close when there is one, otherwise read the statements directly.
2. Current cash: each account's closing balance with its as-of date; keep currencies apart, and state rate and date when converting.
3. Period income and spending: totals by category with the net, compared with the previous period; say so when the periods differ in length.
4. Receivables: for each unpaid invoice record customer, amount, issue date, due date and days overdue, grouped by age (not yet due, 1–30, 31–60, over 60 days).
5. Payables: bills, subscriptions and taxes due in the next 30 days with amounts and dates; only remind, the owner pays personally.
6. Forecast (optional): cash for the next 4 weeks with stated assumptions, labelling forecasts apart from actuals.
7. Reminders: one draft per overdue receivable (polite, with invoice number, amount, due date and how to pay) in a draft file; never send.

## Delivery
Write `cash-flow-<period>.md` in this run's output folder:

```
# Cash flow <period>
Data period / source files / generated on

## Current cash
| Account (last 4) | Currency | Balance | As of |

## Period income and spending
| Category | Income | Spending | Net | Previous net |

## Receivables ageing
| Customer | Invoice | Amount | Due | Days overdue | Group |

## Upcoming payments
| Date | Item | Amount | Note |

## Reminders and drafts
- Reminder drafts: `reminder-drafts.md` (you send them after confirming)
```

## Checks
- Period net = closing cash − opening cash (excluding transfers); otherwise state the difference.
- Every overdue invoice can be found in a source file.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

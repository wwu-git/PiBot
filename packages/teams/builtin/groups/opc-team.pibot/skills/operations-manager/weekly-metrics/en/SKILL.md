---
name: weekly-metrics
description: "Use for the weekly metrics review: keep one fixed set of metrics and definitions, compare with last week, explain changes and give 1–3 actions for next week."
metadata:
  pibot-version: "1"
  pibot-name: "Weekly metrics"
  pibot-params: "[{\"name\":\"reports\",\"description\":\"Platform exports, site analytics or files the owner attached\"},{\"name\":\"period\",\"description\":\"This week's date range\",\"default\":\"last Monday to Sunday\"}]"
---

# Weekly metrics

Reports: {reports}
Period: {period}

## Steps
1. Read last period's weekly metrics file first and keep the same metrics and definitions; the first time, agree 5–8 metrics with the owner (for example visits, sign-ups, paid conversion, engagement rate, net followers, revenue).
2. For each metric give its definition, source file and period; when a definition changes, say so and do not compare directly with last week.
3. Use only figures in the reports; write missing data where a figure is absent instead of estimating. Revenue figures come from finance's files.
4. Compute this week, last week, the change and the change rate; write a dash when the denominator is 0.
5. For changes beyond ±20% give one hypothesis and how to test it (for example "Wednesday's post drove visits" → check clicks on that post's link).
6. Give 1–3 actions for next week, each with an owner and a measure.

## Delivery
Write `weekly-metrics-<period>.md` in this run's output folder:

```
# Weekly metrics <period>
Source: <files> / generated on

| Metric | Definition | This week | Last week | Change | Source |

## What changed
- <metric>: <hypothesis> (guess); test: <how>

## Next week
1. <action> - <owner> - measured by <metric>

## Missing data
- ...
```

## Checks
- Every figure can be found in a source file; recompute each change rate from the table.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

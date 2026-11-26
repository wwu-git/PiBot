---
name: weekly-business-review
description: "Use for the weekly business review: combine finance cash, operations metrics, the support summary and development progress, check definitions and list the owner's decisions."
metadata:
  pibot-version: "1"
  pibot-name: "Weekly business review"
  pibot-params: "[{\"name\":\"period\",\"description\":\"Date range the review covers\",\"default\":\"last Monday to Sunday\"}]"
---

# Weekly business review

Period: {period}

## Assignments (the coordinator starts this in the group)
1. Finance: this week's cash in and out, closing balance and overdue receivables, delivered as `cash-flow-<period>.md`.
2. Operations: the fixed weekly metrics against last week, delivered as `weekly-metrics-<period>.md`.
3. Support: ticket count, categories and open items, delivered as `support-weekly-<period>.md`.
4. When there was development work, the developer delivers this week's change notes.
5. Once those are delivered, the coordinator combines them; the coordinator never supplies a member's professional figures.

## Combining and checking
- Copy every figure from a member's file and cite its path; do not re-estimate.
- Check that period, currency and definitions match; send mismatches back to that member or list them under Gaps and to-dos.
- Give each cash or metric anomaly one likely cause and a next step, marking causes that are guesses.
- Write the owner's decisions as options, costs and a recommendation.
- List outgoing content only as draft paths awaiting confirmation.

## Delivery
Write `weekly-business-review-<period>.md` in this run's output folder:

```
# Weekly business review <period>

## In one line
## Cash (source: ...)
## Operations metrics (source: ...)
## Support (source: ...)
## Development (source: ...)
## Decisions for you
| Matter | Options | Cost | Recommendation |
## Gaps and to-dos
```
When this is a plan's check step, end with a line reading "Verdict: PASS" or "Verdict: FAIL", and on FAIL list what each member must change.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

---
name: decision-log
description: "Use to collect and record the owner's decisions: pending ones as options, settled ones with reasons and review dates, so nothing is asked twice."
metadata:
  pibot-version: "1"
  pibot-name: "Decision log"
  pibot-params: "[{\"name\":\"matter\",\"description\":\"What needs deciding or was decided, with related material\"}]"
---

# Decision log

Matter: {matter}

## Steps
1. Read the existing `decision-log.md` first (create it if missing); if the matter is already settled, cite that entry instead of asking again.
2. Pending decisions: a line or two of background, 2–3 options, each option's cost (money, time, risk) and your recommendation with its reason.
3. Mark options involving money or promises to others as for the owner to carry out; the log records the decision and never executes it.
4. Once the owner decides, record the date, the choice, the reason (the owner's words or key points), the member who carries it out and a review date.
5. When a decision is reversed, keep the old row: set its status to reversed and add a new row citing it and the reason.
6. Decisions reaching their review date go into that day's briefing under Decisions for you.

## Delivery
Update `decision-log.md` in the working folder (inside a plan, write it to this run's output folder), with two tables:

```
# Decision log

## Pending
| No. | Matter | Background | Options and costs | Recommendation | Latest |

## Decided
| No. | Date | Matter | Choice | Reason | Carried out by | Review date | Status |
```
Status is one of: active, reversed, done.

## Checks
- Every decided entry can be traced to a message or file in which the owner made the decision.
- No entry says a payment was made or a message was sent on the owner's behalf.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

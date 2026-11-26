---
name: faq-upkeep
description: "Use to keep the FAQ current: turn recurring tickets into questions and answers with conditions, sources and update dates, listing changes for the owner to confirm."
metadata:
  pibot-version: "1"
  pibot-name: "FAQ upkeep"
  pibot-params: "[{\"name\":\"tickets\",\"description\":\"The recent ticket table or customer messages\"}]"
---

# FAQ upkeep

Tickets: {tickets}

## Steps
1. Read the existing `faq.md` first; create it if missing.
2. Find questions that appear twice or more, and ones answered wrongly or slowly.
3. For each entry:
   - Write the question the way customers put it.
   - Answer with the conclusion first, then steps; prices, refunds and time limits come only from the owner's rules, with the rule's date.
   - State when it applies (plan, version, region).
   - Record the source ticket numbers and the update date.
4. When an existing entry conflicts with a new case, do not just edit it: list it under Changes for you to confirm with the old answer, the proposed answer and why.
5. Mark outdated entries retired with a reason instead of deleting them.
6. Include no customer personal details.

## Delivery
Update `faq.md` (inside a plan, write it to this run's output folder) and list this round's changes at the end of the same file:

```
# FAQ

## <section>
### Q: <customer's words>
A: <conclusion>. <steps>
Applies to: <conditions>  Basis: <owner's rule / date>  Source: <tickets>  Updated: <date>

## Changes this round
| Entry | Added / changed / retired | Reason | Source tickets |

## Changes for you to confirm
- ...
```

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

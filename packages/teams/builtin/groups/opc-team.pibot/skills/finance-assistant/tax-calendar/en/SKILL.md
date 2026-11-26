---
name: tax-calendar
description: "Use for tax filing and payment dates: list upcoming obligations, material to prepare and sources for the region and entity type, marking anything uncertain for an accountant."
metadata:
  pibot-version: "1"
  pibot-name: "Tax calendar"
  pibot-params: "[{\"name\":\"region\",\"description\":\"Country or region of the business (and state or province)\"},{\"name\":\"entity\",\"description\":\"Entity type, e.g. sole proprietor, LLC, limited company, freelancer\"},{\"name\":\"range\",\"description\":\"Time range to cover\",\"default\":\"the next 90 days\"}]"
---

# Tax calendar

Region: {region}
Entity: {entity}
Range: {range}

## Steps
1. Confirm region, entity type, accounting basis and filing frequency (monthly, quarterly, yearly); write what the owner did not say as assumptions at the top of the file.
2. Read any existing `tax-calendar.md` and material from the owner or their accountant first; it takes precedence.
3. When public rules are needed, prefer the tax authority's own site; give every date a source and a check date. When only secondary articles are available, mark it to confirm with an accountant.
4. For each item record the deadline, the obligation (filing / payment / annual report), when it applies, material to prepare (with file paths from the close and ledger where available) and status.
5. When deadlines move for weekends or holidays, state the rule and the moved date.
6. Give no tax amounts and no ruling on reliefs; list such questions under Ask the accountant.
7. Payments are only reminders; the owner pays personally through official channels.

## Delivery
Write `tax-calendar.md` in this run's output folder:

```
# Tax calendar (<region>, <entity>)
Assumptions / generated on

| Deadline | Obligation | Applies when | Material | Source | Checked on | Status |

## Ask the accountant
- ...
```
Status is one of: to prepare, material ready, filed (changed only after the owner confirms). You may suggest a routine that reminds the owner 7 days before each deadline.

## Checks
- Every row has a source and a check date; a row without a source gives no specific date and is marked to confirm with an accountant.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

---
name: ticket-triage
description: "Use to triage customer tickets: turn emails, comments and messages into a ticket table sorted by category and urgency, marking what the owner must handle and what goes to the developer."
metadata:
  pibot-version: "1"
  pibot-name: "Ticket triage"
  pibot-params: "[{\"name\":\"sources\",\"description\":\"Customer emails, comments, chat logs or exported files\"},{\"name\":\"period\",\"description\":\"Time range to triage\",\"default\":\"the last week\"}]"
---

# Ticket triage

Sources: {sources}
Period: {period}

## Steps
1. Read the existing ticket table first and merge repeat messages by customer alias and topic instead of opening duplicates.
2. Record for each ticket: number, source, received time, customer alias (no full email, phone or address) and a one-line summary.
3. Category: question, bug, refund, complaint, suggestion.
4. Urgency:
   - High: service down, payment or account problems, heated tone, anything legal, safety or privacy related; goes to the owner personally.
   - Medium: affects use but has a workaround, or needs an answer within 2 working days.
   - Low: general questions and suggestions.
5. Handler: support drafts replies the FAQ can answer; bugs go to the developer with reproduction steps, environment and screenshot paths; refunds, compensation and exceptions go to the owner.
6. Status is one of new, draft awaiting confirmation, waiting on customer, resolved; resolved needs a reply the owner sent or the customer's confirmation.

## Delivery
Write `ticket-triage-<period>.md` in this run's output folder:

```
# Ticket triage <period>
Sources / generated on

| No. | Received | Source | Customer alias | Category | Urgency | Summary | Handler | Status |

## For you to handle personally
- <no.>: <reason>

## For the developer
- <no.>: <reproduction steps / environment>
```

## Checks
- Every message belongs to one ticket, and the file contains no full contact details.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

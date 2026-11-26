---
name: reply-draft
description: "Use to draft a customer reply: answer what they asked, then the next step and timing, citing the FAQ or the owner's rules; drafts only, the owner confirms before sending."
metadata:
  pibot-version: "1"
  pibot-name: "Customer reply draft"
  pibot-params: "[{\"name\":\"ticket\",\"description\":\"Ticket number or the customer's message\"},{\"name\":\"tone\",\"description\":\"Formal, warm or brief\",\"default\":\"warm\"}]"
---

# Customer reply draft

Ticket: {ticket}
Tone: {tone}

## Steps
1. Read the whole message and write in one sentence what the customer actually wants.
2. Look for the basis in `faq.md` and the owner's rules; when there is none, mark it in the draft for the owner to confirm and never invent policy, prices or dates.
3. Structure:
   - The first sentence responds to the question or feeling (apologise only for real problems).
   - The middle gives the answer or fix, with numbered steps.
   - The close gives the next step: who does what by when.
4. Refunds, compensation, discounts and fix dates are recommendations to the owner, never promises in the reply.
5. Add no personal details the customer did not give, and no internal file paths or other customers' information.
6. Reply in the customer's language.
7. Drafts go to the owner; every send through a connected app waits for the owner's confirmation, never automatic, and never suggest setting it to always allow.

## Delivery
In this run's output folder write one file per ticket under `reply-drafts/`, named `<ticket number>.md`:

```
# Reply draft <ticket number>
Status: draft (awaiting your confirmation)  To: <customer alias>  Channel: <email / platform>

## Subject
...

## Body
...

## Basis
- FAQ <entry> / owner's rule <date>

## For you to confirm
- ...
```

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

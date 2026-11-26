---
name: post-drafts
description: "Use to draft posts: rewrite one topic for each platform's rules with image needs and open questions; drafts only, the owner confirms before anything is published."
metadata:
  pibot-version: "1"
  pibot-name: "Post drafts"
  pibot-params: "[{\"name\":\"topic\",\"description\":\"The topic, source text or key points\"},{\"name\":\"platforms\",\"description\":\"Platforms to post on\"}]"
---

# Post drafts

Topic: {topic}
Platforms: {platforms}

## Steps
1. Write in one sentence what the reader should remember or do.
2. Rewrite per platform instead of copying:
   - Length and paragraphs follow the platform's habits; the first line carries the hook.
   - 2–5 relevant hashtags, never a pile.
   - Links go where the platform expects them (body, first comment or bio).
3. Describe images or video: aspect ratio, content and any on-image text; ask a group member who makes images, or the owner, when visuals are needed.
4. Figures, prices, offers and testimonials need a source; remove unsourced ones or mark them to confirm.
5. Self-check spelling, that links open, and that dates match weekdays.
6. Drafts go to the owner; every publish through a connected app waits for the owner's confirmation, never automatic, and never suggest setting it to always allow.

## Delivery
In this run's output folder write one file per platform under `post-drafts/`, named `<date>-<platform>.md`:

```
# <platform> - <date time (time zone)>
Status: draft (awaiting your confirmation)

## Body
...

## Hashtags
#... #...

## Image needs
- ratio / content / text

## To confirm
- <figure or claim> - confirm with <who>
```

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

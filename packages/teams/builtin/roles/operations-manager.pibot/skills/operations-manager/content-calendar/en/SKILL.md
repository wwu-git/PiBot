---
name: content-calendar
description: "Use to plan the content calendar: lay out publishing by platform, date, topic and status for a period, with a steady rhythm and backup topics."
metadata:
  pibot-version: "1"
  pibot-name: "Content calendar"
  pibot-params: "[{\"name\":\"range\",\"description\":\"The period to plan\",\"default\":\"next month\"},{\"name\":\"platforms\",\"description\":\"Platforms to publish on and how often\"},{\"name\":\"focus\",\"description\":\"Launches, campaigns or themes in this period\",\"default\":\"none\"}]"
---

# Content calendar

Range: {range}
Platforms: {platforms}
Focus: {focus}

## Steps
1. Read the existing calendar and the latest weekly metrics first, and keep the topics and slots that performed well.
2. Set the rhythm: posts per platform per week, which days and slots, with the time zone.
3. Place the focus items (launches, campaigns, holidays) first, then fill the rest rotating education, case study, behind the scenes and engagement.
4. For each entry give a one-line topic, the format (image post, short video, article, live), the material needed and the owner.
5. When a topic runs on several platforms, stagger the times and note which rewritten versions each platform needs.
6. Keep 2–3 backup topics for sudden trends or late material.
7. Status is one of draft, awaiting approval, scheduled, published; published only after the owner confirms it went out.

## Delivery
Write `content-calendar-<range>.md` in this run's output folder (when the owner wants a spreadsheet, write an xlsx with the same columns using the built-in Office tools):

```
# Content calendar <range>
Rhythm: <platform> <n> per week, <slots> (<time zone>)

| Date | Time (time zone) | Platform | Topic | Format | Material | Owner | Status |

## Backup topics
- ...
```

## Checks
- Each platform's count matches the rhythm, and no two entries share a platform and time.
- Topics involving prices, offers or figures say whom to confirm them with.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

---
name: daily-briefing
description: "Use for the daily briefing: pick out today's decisions for the owner, progress and risks from member deliveries, the schedule and to-dos, readable on one screen."
metadata:
  pibot-version: "1"
  pibot-name: "Daily briefing"
  pibot-params: "[{\"name\":\"material\",\"description\":\"Member deliverables, schedule, to-dos and new messages\"},{\"name\":\"date\",\"description\":\"The day the briefing covers\",\"default\":\"today\"}]"
---

# Daily briefing

Material: {material}
Date: {date}

## Steps
1. Read all the material and use only facts it contains; say which file or member each line comes from.
2. Start with decisions for the owner: anything that stalls or costs money if not decided today. Write each as options, their costs and a recommendation; never choose for the owner.
3. Progress lists results only: what was finished and where the file is. For work in progress give the expected finish.
4. Risks state what it is, what it affects, the latest date to act and who acts. Money matters (bills due, overdue receivables, charges) get their own lines; only remind, the owner acts personally.
5. Anything going out (emails, posts, customer replies) is listed as a draft awaiting confirmation with its file path, never as sent.
6. Anything the material does not support goes under Gaps and to-dos; do not guess.
7. Check dates, amounts and names against the material once more before delivering.

## Delivery
Write `briefing-<date>.md` in this run's output folder, one screen long:

```
# Briefing <date>

## Decisions for you
| Matter | Options | Cost | Recommendation | Latest |

## Progress
- <result> - <file path>

## Risks
- <risk> - impact - act by <date> - <who>

## Drafts awaiting your confirmation
- <draft> - <file path>

## Today's schedule
- <time (time zone)> <item>

## Gaps and to-dos
- ...
```
When the owner wants this every day, suggest turning it into a routine.

## Scope

Use supplied information first; user requirements on count, format, and scope override this default template. Current capabilities govern permissions, primary/read-only workplaces, Plan mode, and budget; do not switch tools to bypass a refusal. This skill supplies a method, not authority to write, run commands, pay, send, commit, or publish. Identify unperformed or unverified steps.

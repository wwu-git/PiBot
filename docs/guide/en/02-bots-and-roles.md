# 2 · Bots and roles

Each Bot has its own name, persona, model, skills, permissions and memory. Pi is the default main Bot; you can create more Bots from roles so each one owns an area, and put several into a group to split work (see [6 · Group chats](06-groups.md)).

On this page:

- [Create a Bot](#create-a-bot)
- [The Bot profile panel](#the-bot-profile-panel)
- [Memory](#memory)
- [External agents](#external-agents)
- [Import and sidebar groups](#import-and-sidebar-groups)

## Create a Bot

Click "+" at the top of the sidebar and choose **New Bot** (⌘1 / Ctrl+1).

![New menu](../images/en/new-menu.png)

### From a role

![Pick a role](../images/en/role-picker.png)

"Pick a role" lists the roles you can use; filter by category (Engineering, Product & design, Data & research, Content & marketing, Office & operations, General) or search. A role brings working norms, skills and default permissions. All roles:

- **Engineering**: Backend Developer, Frontend Developer, Full-stack Developer, Code Reviewer, DevOps / Ops, QA Engineer, Technical Writer, Plugin Builder
- **Product & design**: Product Manager, UI / UX Designer, Image Designer
- **Data & research**: Researcher, Data Analyst, Tutor
- **Content & marketing**: Copywriter, Social Media Manager, Presentation Designer, Translator, Video Scriptwriter
- **Office & operations**: Personal Assistant, Project Manager, Recruiter / HR, Proactive Assistant
- **General**: General Assistant

The installer ships the common ones (such as Full-stack Developer, QA Engineer, Code Reviewer, Researcher, Social Media Manager, Presentation Designer and Plugin Builder), which work offline. The other roles and group templates live in the **role library**: they appear next to the bundled ones and are downloaded the first time you pick them, after their official signature is checked. **Check role library** and **Refresh role library** above the list fetch the latest roles and new versions. You can also browse every role and group template in the [role library](https://pibot.space/en/roles/) on the website and click **Open in Pi Bot** to add one (needs Pi Bot 0.0.3 or later; the app asks you before adding it).

The **Proactive Assistant** (Wren) checks your calendar and to-dos on the schedule you set and only alerts you when something needs you; otherwise it stays quiet. It only reads and organizes, and never replies or changes your calendar for you. A mail connection comes in a later version.

The Image Designer needs a model that can generate images, set up in Settings › Models & API keys; until then it can't be created.

After you click a role you can change the name and add an extra description (for example which project it covers; this is reference, not instructions), and see its model, default permissions, built-in skills and working norms. Click **Create Bot**.

![New Bot from a role](../images/en/new-bot-from-role.png)

### Describe your own

The last item, **General (describe it yourself)**: write a job description and Pi Bot generates a name and persona.

## The Bot profile panel

Click the Bot's name or avatar at the top of the chat to open its profile on the right. The panel has four tabs: Profile, Topics, Skills, Permissions. Changes save when you leave a field.

### Profile

![Profile](../images/en/bot-profile.png)

- **Name, Its job**: shown in the sidebar and in chats.
- **Model, Thinking level**: defaults to the default model in Settings › Models & API keys; each Bot can use its own. Thinking level is Low, Medium or High.
- **From role**: Bots created from a role show the role and its version.
- **Code review**: **Default reviewer** decides which Bot handles "Ask … to review" in the changes panel (automatic recommendation looks for a Code Reviewer Bot first, then a Bot on a different model). **Ask for a review after changing code** only applies to turns that changed files; reviews are read-only.
- **Automatic actions**: run formatting after writing (still approved per your permissions); notify on completion (no chat text in the notification).
- **Persona & working norms**: edited separately.
- **Used folders**: folders this Bot has worked in. Folders belong to topics and are picked at the top of the chat.
- **Command log retention**: days to keep and a size cap, per Bot.
- **Run limits (including the cost cap)**: limits for the next run.

### Topics

![Topics](../images/en/bot-topics.png)

This Bot's routines (you can create one here with **New routine**) and all its topics, including Archived.

### Skills

![Skills and memory](../images/en/bot-skills-memory.png)

- **Skills**: the skills this Bot can use, with on/off switches. Mention the task in chat and the Bot uses the matching skill; disabled skills stay out of its prompt. **Add** gives it more skills.
- **Saved plans**: a group plan whose steps all passed can be saved with **Save as a reusable plan** on its completion message and run again directly.
- **Connections it can use**: apps and MCP servers it has access to.
- **Memory**: see below.

### Permissions

![Permissions](../images/en/bot-permissions.png)

By default a Bot follows the global permissions in Settings › Permissions. Anything changed is marked **Set for this Bot**; **Reset** returns it to the global setting. You can also toggle the Bot browser's **Google compatibility mode**, **Clear browsing data**, and **View activity log**. What each permission means: [5 · Approvals and permissions](05-approvals-and-permissions.md).

## Memory

Bots remember your preferences and agreements and use them next time. There are four kinds of memory, told apart by who can use them:

| Memory | Who uses it | What goes in | Where to see and edit it |
|---|---|---|---|
| **User memory** (About you) | Every Bot, in group chats too | Facts about you: who you are, personal preferences, habits, how you like to communicate | Avatar menu › **About you** |
| **Bot memory** | Only this Bot | This Bot's work, its ways of working, task progress | The **Skills** tab of the Bot's profile panel |
| **Group memory** | Only this group | The group's roles, agreements and work | The **Skills** tab of the group's profile panel |
| **Project memory** | Every Bot and group working in this folder | The project's conventions, build commands and layout | The folder menu at the top of the chat › **Project memory for this folder** |

Project memory belongs to the working folder: only a project folder you chose has it; a Bot's own folder and folders on a runner don't. It stays on this computer and is never written into the project's files.

When a Bot saves a memory it picks the kind itself: facts about you go to user memory, project conventions to project memory (only while it works in a project folder), and other work to Bot memory in a direct chat or group memory in a group.

![About you](../images/en/about-you.png)

Ways to add memory:

- Tell a Bot "remember that I prefer…".
- In a memory list click **+ Add**, write the memory and pick a category (About you, Work, How to work, Other).
- Turn on **Extract memories from conversations**. Pi Bot schedules extraction when you switch topics, after about 30 minutes without new messages, or after a group plan or routine with input from you finishes. Pending extraction is saved when you quit and can resume when you next open Pi Bot.

You can also correct a Bot directly, for example by saying “Put the conclusion first in future reports.” With extraction on and **Remember** selected, Pi Bot prioritizes corrections and lasting preferences it recognizes. Once saved, **Remembered** appears under the original reply, where you can choose **Undo**. If the model is busy, this may take longer. With **Ask first**, you get a suggestion to confirm.

**When it learns something new** can be **Remember** or **Ask first**. With Ask first, the Bot asks you before it writes a memory. **Sort into place** in About you uses the model to move memories that belong to one Bot's work back to that Bot; the move proposals appear in the Inbox for you to confirm one by one.

Memory is stored only on this computer and can be edited or deleted any time. Each run's work receipt lists which memories it used (see [3 · Chatting](03-chatting.md#work-receipts)).

## External agents

Coding agents already installed on your computer (Codex, Claude Agent, Cursor, OpenCode, or any agent that supports ACP) can join Pi Bot as Bots. In "Pick a role", choose the **External agents** category: Pi Bot checks which ones are installed (only their paths and versions; it never reads their accounts or chats). Pick one and follow **Add … as a Bot**.

- It uses its own sign-in and billing; Pi Bot never reads or stores its tokens.
- It runs in Pi Bot's sandbox and can only write to the topic's working folder. Windows has no command sandbox, so the card is marked **Runs without sandbox**.
- Sign-in or plan problems show up early: the profile and chat show **Sign in needed** or **Plan limited** with the sign-in command to run in a terminal (**Copy command**). Fix it, then click **Check again**, instead of finding out when a run fails.

## Import and sidebar groups

![Open the sidebar plus menu to find import and grouping options](../images/en/new-menu.png)

- **Import a .pibot file**: "+" › **Import a .pibot file**; you preview before importing. Multi-Bot or group templates import as a whole, as previewed.
- **New sidebar group**: "+" › **New sidebar group** to organize the sidebar.

## Let Pi manage Bots and assign work

The default Pi is your chief of staff. In your direct chat with Pi, say things like "set up someone for the bookkeeping", "make a group with Fin and Dev" or "have the reviewer check the contracts": Pi can create, edit, archive or restore Bots, create groups, add or remove members, archive or restore groups, and hand a task to a Bot or a group.

- Every change shows a card first that lists exactly what changes (name, role, model, members, or who gets which task). Ticking **Don't ask again** sets the matching row on Pi's permissions tab to **Always**. With YOLO on in Pi's topic these cards pass like other YOLO-able confirmations (a row set to **Never** still refuses).
- Pi's **Permissions** tab starts with **Manage and assign · Pi only**: **Manage Bots and groups** and **Assign work to Bots and groups** can each be **Never**, **Ask** (default) or **Always**. No other Bot has these rows or the tools behind them.
- Pi cannot delete Bots or groups (archive only, always restorable), cannot change any Bot's permissions, and cannot read keys.
- Assigned work opens a new topic marked **From Pi** at the receiver, which works under its own permissions; a group plans it through its coordinator as usual. When it finishes, fails, stops or needs you, a receipt card appears in Pi's chat (result, summary, outputs, **Open topic**) and Pi tells you in a sentence or two.
- At most 3 hand-offs per turn; a Bot or group working on Pi's task cannot hand work on, or back to Pi.
- This works only in your direct chat with Pi: on the computer, or from your paired phone through the computer (cards and receipts show there too, including **Don't ask again**). Not with the phone's own offline model, an editor (ACP), groups or routines.

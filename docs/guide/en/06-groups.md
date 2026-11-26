# 6 · Group chats

Put several Bots in one group and a **coordinator** hands out the work: a Bot you @mention answers directly, the coordinator takes other messages and splits bigger jobs into a plan for the members. Groups use more model capacity (several Bots may process each message); most tasks only need a chat with one Bot.

On this page:

- [Create a group chat](#create-a-group-chat)
- [Giving work to a group](#giving-work-to-a-group)
- [Tasks panel and plans](#tasks-panel-and-plans)
- [Pause and continue](#pause-and-continue)
- [Group profile and settings](#group-profile-and-settings)
- [Example: hand off research to a writing Bot](#example-hand-off-research-to-a-writing-bot)

## Create a group chat

1. Click "+" at the top of the sidebar › **New group chat** (⌘2 / Ctrl+2).
2. Pick a **group template**, or choose members yourself:
   - Templates: Content & Growth, Lean Dev Team, Product Team, Research Group, Study Group; each card says what it is for. Lean Dev Team and Research Group come with the installer; the others are downloaded from the role library the first time you use them (this needs an internet connection). You preview a template first; **Create group and Bots** then creates its Bots (with the default model and role permissions) and the group, reusing any Bot you already have from the same role. The coordinator posts a welcome message.
   - Your own: choose 2 to 6 Bots. Image Bots can be members; the coordinator must be a text Bot.
3. Enter the **Group name** and choose the **Coordinator**.
4. Click **Create group chat**.

![New group chat](../images/en/group-new.png)

A group also has its own working folder, **The group's own folder** by default. Click the folder name at the top of the chat to use your project folder instead (only the main folder is writable; references are read-only):

![Group folder](../images/en/group-folder.png)

## Giving work to a group

- Say what you need and the coordinator decides who does it, or @mention a member to have it answer directly.
- Groups have **Execute / Plan only** too. Let everyone analyse with Plan only, then click **Switch to execution**.
- A group moves its own work forward: once the coordinator has split the task, implement, test and review hand off in turn without you having to chase each step. When a test or review fails, the program sends the problems back to be fixed and then hands the fix to the same role to check again; the group's summary follows what the test and review concluded.
- The top of the group shows "Automatic rounds: N / M": when Bots have replied to each other that many times, they stop and wait for you; a new message from you resets the count. The **Pause automatic conversation** switch next to it is the same as the **Pause** button described below (see [Pause and continue](#pause-and-continue)).
- Each member's run can be stopped on its own ("Stop this run by …").

![Group chat](../images/en/group-chat.png)

## Tasks panel and plans

Click **Tasks** at the top of the group to open the tasks panel:

![Tasks panel](../images/en/group-tasks.png)

- **Current plan**: a timeline of the steps with who does each one, what it is for, its deliverables and checks; steps that run at the same time are grouped together. The progress below shows whether each step is in progress, waiting, needs you, passed or failed, and how much has been spent.
- **Main tasks** and **Child tasks**: who is doing what, and whether it's in progress or waiting for you.
- **Finished tasks**.
- **Usage this time**: tools, model requests, run time and cost across all runs in this round (with a note when some requests have no pricing).
- **Group plan history**: earlier execution plans.

For complex work the coordinator first posts an **Execution plan** card: who does each step, which steps depend on which, which can run at the same time, the deliverables, and an estimated cost. Click **Start** to run it, or **Modify** to say what to change and send it back to the coordinator.

Serial steps run in the group's main folder. Development steps that can run at the same time: on macOS each uses its own workspace and is merged into the group's folder after review and your permission approval; on Windows and Linux, and while the computer has no Git, they take turns in the group's folder instead. The result is the same, only slower (for Git, see [4 · Working folders and changes](04-folders-and-changes.md#git)).

A plan whose steps all passed can be saved with **Save as a reusable plan** on its completion message and run again directly.

## Pause and continue

While a group is working, a bar above the input shows the running step and who is on it (for example "Plan running · step 2/4 · Kit: …"), with a **Pause** button on the right.

[![Pause and continue a group (click for the video)](../../assets/pibot-group-pause.gif)](../../assets/pibot-group-pause.mp4)

- **Pause**: the running steps stop and progress is kept; the bar changes to "Paused · progress kept; step N "…" stopped here". A command running inside a step is stopped; background services (such as a local preview) keep running.
- **Continue**: the stopped steps pick up where they stopped. The Bot that continues is told which files it had changed and which commands it had run (the one the pause cut off is marked "stopped by the pause"), and which files someone else, such as you, changed during the pause. It reruns the command that was cut off and doesn't redo finished work. The continue message names every step resumed.
- **Status**: **Paused** means the step can resume with **Continue**. **Stopped** means the plan was stopped or cancelled.
- **Say it in the chat**: sending "hold on", "pause", "go on" or "continue" works like the buttons. Only a message that is just that counts; a question or a message with other instructions goes to the coordinator as usual.
- **Chat while paused**: ask members questions or edit files yourself; Bots answer only when you send a message or mention them. No new plan starts while the group is paused.
- The **Pause automatic conversation** switch at the top of the chat and **Pause / Continue** on the phone are the same pause (see [11 · Phone app](11-phone-app.md#chats-tasks-and-approvals)).

![The bar of a paused group](../images/en/group-pause.png)

## Group profile and settings

Click the group name to open its profile panel, with Profile, Topics, Skills, Permissions and Settings tabs.

![Group profile](../images/en/group-info.png)

- **Group name**, **Coordinator**, **Automatic round limit**, **Announcement** (saved when you leave the box). Renaming a group doesn't interrupt a running step.
- **Members**: see members and add another Bot. Members' private chats are unaffected.
- **Used folders**, **Run limits (including the cost cap)**.
- **Skills**: a group can have its own skill list.
- **Permissions**: a group has its own permission scope, which can only narrow members' permissions, never widen them.
- **Archive**: stops the group's tasks and keeps chats and files; restore it from Archived in the sidebar.

## Example: hand off research to a writing Bot

1. Create a group with a coordinator, a researcher, and a writing Bot. Select the working folder for deliverables.
2. Start in Plan only. Say: “Have the researcher record findings and sources from the three documents in research.md. Have the writing Bot use that file to produce draft.md. Propose a plan with writing dependent on research.”
3. Check the assignees, dependencies, and paths on the plan card. Start the plan and open Tasks to follow each step.
4. When research finishes, open research.md and check the sources. If writing is still waiting, see whether the previous step needs review or approval.
5. Open draft.md from the group result. To supply missing information, quote the relevant result in the group and explain what to add.

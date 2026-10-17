# rollforward: recurring tasks, files in and files out

`src/` holds the server, the store, the runner and `rf`, `web/` the page, and `demo/` a made-up weekly series to test them with. [docs/design.md](docs/design.md) holds the design notes for the page.

- **What this is:** a small web platform for recurring tasks. People drop in input files, and an agent produces the output files, having learned how from earlier instances. People move files; they don't type prompts.

## Concepts

- **Workspace:** a top-level folder of series, such as one client's or one team's. No run sees another workspace's files (enforced from M3).
- **Series:** a recurring transform, such as "Weekly borrowing base": each instance's input files become its output files. The folder name is the series' name. What an instance should contain comes from earlier instances, not from a declaration.
- **Visibility:** a series can make itself visible to other series of the workspace, or to all of them. Their agents may then read it, never write it, and copy into their own `working/` what they rely on. Visibility is one way, and only the publishing series grants it.
- **Archive:** a workspace or a series that's no longer in use can be archived. It leaves the sidebar, except under "Show archived", until it's restored, and nothing in it changes. It isn't transitive, but what a reader copies can flow on.
- **Instance:** one pass through a series, under a label people choose, such as "2026-08-24" or "Larkfield refinancing". Instances needn't be periods. They sort alphabetically by label, and only open ones show by default.
- **Item:** one tile on an instance's screen. It has a stable id, a display name and a kind: input, step or output. A **step** is an intermediate result a reviewer would check, such as "Eligible AR", in a file the agent writes. An item also has the file it currently shows, the items it's made from (`from`), and its notes. Replacing a file means pointing the item at a new file.
- **Graph:** the items, joined by what each is made from. It's a picture for people: nothing runs it, and the agent's scripts needn't follow it.
- **Example:** a closed instance. Its input items and output items are one example pair. The agent learns the transform from these pairs, and writes it down as scripts and notes in `working/`.
- **Run:** one stretch of agent work on an instance, started by an upload, an answer or a Steer. Runs are internal; the ops log and Advanced show them.
- **Note:** an agent comment on an item, pinned to a place in the file, such as a cell, where that matters. A **question** is a note with options and a default.
- **Key and additional inputs:**
  - An input item is a **key input**: the output is made from it, and the series expects it every time.
  - Anything else a note relies on, such as an email or a document, is an **additional input**. The note lists it in `files`, and the page shows it under the inputs as "Also used".
  - Where a file came from is a separate question. It is **evidence** if it was taken from outside as it is (an upload, or a file the agent fetched), and **working** if the agent made it.

## Screens

- **Sidebar:** a cascade of workspaces, series and instances. The open workspace lists its series, and the open series its open instances in label order, then "Show closed (18)". The open workspace and series carry their actions in their row's corner: ⋯ opens settings, and + makes a series or an instance. + by "Workspaces" makes a workspace. A red dot on a collapsed workspace or series marks an open question in it; a black dot on an instance marks changes since this browser last opened it.
- **Instance:** the graph. Inputs come first, then the steps, column by column, and lines join each tile to what it's made from. Outputs have their own column on the right, which scrolls on its own, so they're always in view. Hovering a tile highlights what feeds it and what it feeds. Outputs and the rest are the two drop zones.
  - A tile shows the item's name, its current file and version, and who made it, by colour: blue for a person and black for the agent. Hover shows who, when, and what it replaced. Earlier files are in the ops log.
  - Dashed tiles are items with no file yet: inputs that earlier instances had and this one lacks, and steps and outputs not built yet. The agent's note says why.
  - The agent can add inputs of its own, such as a table it extracted from an emailed PDF. Their files live in `working/`, so they show as agent-made.
  - An output's tile shows the agent's one-line headline. An input the agent fetched shows its source. Under the input tiles, "Also used" lists the files that notes cite and no tile shows.
  - A corner marks a tile with agent notes: gray for a note, which is for information, and red for a question waiting for a person. Hover shows them, with where in the file they apply. A question shows its options as buttons, and says which applies if it's still unanswered at close; clicking one answers it.
  - A drop is a hint. The server adds each dropped file as a new item at once, even mid-run: an output if it was dropped on Outputs, otherwise an input, and the log records the tile it was dropped on, if any. The agent then decides what it is, such as a replacement for an input's file, and says so in a note.
  - There is no text box. People drop files, click answers and close the instance.
- **State hints:** a spinner marks the running instance in the sidebar and the top bar, with a stripe along Outputs; ⧗ marks one waiting to run. A tile flashes when it changes and keeps a black dot until opened. An unanswered question's corner pulses, and an answer shows a spinner until the agent has read it. Uploads show progress, a finished run and an error each show a toast, the tab title counts open questions, Esc closes the top layer, and abandoned instances are struck through.
- **Not shown:** `process.md`, the agent's own account of the process, which points at its scripts. The graph is the process for people.
- **Ops log:** a side panel listing who did what, when: uploads, runs, every change the screen showed, answers, steers, the agent's replies and the close. Earlier files open from here.
- **Preview** shows a spreadsheet with its noted cells marked. If the file replaced an earlier one, "Compare with previous" highlights the cells that changed, and a click shows the old value.
- **Advanced:** a bar along the bottom that expands over the graph, like VS Code's terminal panel.
  - It shows what the agent does, like Claude Code: each run starts with what triggered it, plus its time and cost. The agent's messages read as text, and each tool call is one line with a short result. Consecutive calls fold into a summary such as "Read 3 files, ran 2 commands". Each call expands to its full output, and failures are red. During a run it is live. Past runs are read from the instance's Pi session file.
  - It is the only place to type. **Steer** sends the agent a message, and starts a run if none is going. **Interrupt** stops the run. The agent answers a question with `rf reply`, which shows in the ops log and here, never as a note.
- **New series:** give it a name. Then import past instances one at a time, in label order: create the instance, drop its inputs on the left and what was actually sent on the right, let the agent rebuild each output and note what it can't derive, and close it.
- **New instance:** give it a label. It starts with the graph of the most recently closed instance, as dashed tiles.
- **Close instance:** freezes the instance as an example. Unanswered questions take their defaults, and the dialog lists which. It is disabled while a run is going.
- **Abandon:** the other way an instance ends. It stays as it is, but it isn't an example, never becomes a new instance's starting point, and applies no defaults. It is also disabled while a run is going. Closed and abandoned instances both show under "Show closed".
- **Duplicate:** a closed or abandoned instance can be copied, under a new label, into an open instance. The copy has its files, screen and log, but not its agent session, and its log records the copy as `duplicate`.
- **Rename:** an open instance's label changes from the pencil by its title, between runs. The log records `rename`.
- **Series settings:** the series' name, its visibility (the other series that can see it) and Archive. Renaming moves the series folder, and waits until no run is going. **Workspace settings** hold only Archive for now. An archived workspace or series is restored from its settings, under "Show archived".
- **Names:** until M3 adds sign-in, the page asks for a name once and keeps it in the browser.

## Storage

Workspaces are folders on the host's disk. There is no database.

    <workspace>/              e.g. "Larkfield"
      .archived               there while the workspace is archived, set by people through the server
      <series>/               e.g. "Weekly borrowing base"; moved only by a rename in Series settings
        series.json           {"visible_to": [series names, or "*"]}, set by people through the server, read-only
        .archived             there while the series is archived
        <label>/              an instance: a folder holding workspace.json, made by New instance
          upload/             people's files, as uploaded, read-only
          working/            the agent's area: scripts, process.md, drafts, outputs and its own inputs
          workspace.json      the instance's screen, saved by the server, read-only
          log.jsonl           everything that happened in the instance, written by the server
          session/            the instance's Pi session, shown in Advanced

- **The server holds each instance's screen and log.** They needn't be files, but who owns what stays the same. The server saves the screen to `workspace.json` (a temporary file renamed into place, read-only) and appends each event to `log.jsonl`. Closed instances therefore stay plain folders.
- **Who writes what:**
  - People upload, answer, steer, interrupt and close, all through the server.
  - The server adds each upload as an item at once, creates and closes instances, and is the only writer of the log.
  - The agent decides the items and the notes. It changes them only through `rf`, and reads `log.jsonl` directly.
- **`upload/` belongs to people.** Nobody moves, renames or changes these files. Each streams, as it arrives, to a temporary file in the data root's `.tmp/`, which the server empties when it starts; it is then renamed into place and made read-only. An upload may take up to an hour, and is refused if its instance closed or moved meanwhile. A repeated name becomes `<stem>_<n><ext>`, with the lowest free n. Names and labels have `/`, `\` and control characters replaced, and may not start with `.`.
- **`working/` belongs to the agent,** which may do anything there with one limit. A file the screen has shown never changes again: the server makes it read-only and logs its hash, so a new version gets a new name.
- **`rf`** is a small command on the agent's `PATH`:
  - `rf show` prints the screen, `workspace.json`, including its `rev`, which the server bumps on every change.
  - `rf reply TEXT` answers a person's question; the server logs it as `reply`.
  - `rf put FILE` replaces the screen with FILE. The server rejects it if its `rev` isn't current, because someone changed the screen since the agent read it; the agent then re-reads and merges. It also rejects an invalid document, listing the reasons.
  - **Valid** means:
    - every item has a unique id, a name, and a kind of input, step or output;
    - `from`, if present, lists ids of the instance's items, and never leads round to the item itself;
    - `file` is null, or the path of an existing file under `upload/` or `working/`, relative to the instance folder;
    - `headline` and `source`, if present, are strings;
    - a note's `files` are paths of existing files under `upload/` or `working/` of this instance or another (`../<label>/working/...`);
    - `status` is unchanged;
    - each question has a unique id, two or more options, and a valid default.
  - On accept, the server logs each change: `point`, `item`, `note`, `unnote` and `remove`. It also freezes each newly shown file.
- **The agent makes the decisions.** It decides what each upload is (a new input, a replacement or a revised output), what the outputs are, and the notes. If an item points at a person's upload, the agent repoints it to its own file only by asking first.
- **A closed instance's `workspace.json` is its example pair:** the items and the files that were actually used or sent.
- **Red dot:** in v0, each browser remembers when it last opened an instance. There are no read events in the log.

## Protocol

The schemas are loose, and unknown fields are ignored, so the agent and the UI can extend them independently. The examples are made up. The `//` comments are annotations for this plan, not part of the data.

**The screen** (`workspace.json`), after Sam's revision and the agent's run 3:

    {
      "rev": 31,
      "status": "open",                         // the server sets "closed" or "abandoned"
      "summary": "Rebuilt the borrowing base from Sam's review.",   // the agent's line for the ops log, each run
      "items": [
        {"id": "ar-aging", "name": "AR aging", "kind": "input",
         "file": "upload/Larkfield AR aging 082426_2.xlsx",
         "notes": [{"ref": "", "text": "Replaces the 10:41 upload: two customers corrected."}]},
        {"id": "inventory", "name": "Inventory at cost", "kind": "input",
         "file": "working/Inventory at cost 08.23.2026.xlsx",   // fetched by the agent
         "source": "Warehouse DB, snapshot 08-23, read 08-24 09:12"},
        {"id": "loan-activity", "name": "Granite Point loan activity", "kind": "input", "file": null,
         "notes": [{"ref": "", "text": "Not in the mailbox yet; every closed instance had it."}]},
        {"id": "eligible-ar", "name": "Eligible AR", "kind": "step",
         "file": "working/Eligible AR 08.24.2026 v2.csv", "from": ["ar-aging"]},
        {"id": "borrowing-base", "name": "Borrowing base", "kind": "output",
         "file": "upload/Borrowing base Larkfield 08.24.2026 reviewed.xlsx", "from": ["eligible-ar", "inventory", "loan-activity"],
         "notes": [{"id": "q3", "ref": "Base!C22", "text": "Sam changed the availability block from 500,000 to 750,000.",
                    "options": ["One-off for this week", "Standing rule from now on"], "default": 0}]},
        {"id": "funding", "name": "Funding request", "kind": "output",
         "file": "working/Funding request 08.24.2026 v2.xlsx", "from": ["borrowing-base"],
         "headline": "Requests $1.2M, $0.3M less than last week.",
         "notes": [{"ref": "", "text": "Uses the lender's waiver for this week.", "files": ["upload/Granite Point waiver.eml"]}]}
      ]
    }

**`log.jsonl`** has one line per event. `seq` orders the lines, and `by` is a person's name, "server" or "agent". The ops are `create`, `upload`, `point`, `item`, `note`, `unnote`, `remove`, `run`, `done`, `answer`, `steer`, `interrupt`, `close`, `abandon`, `duplicate`, `rename` and `reply`. `done` carries the run's model cost in USD. Here `point` means an item now shows a file:

    {"seq": 40, "at": "2026-08-24T15:02:00Z", "by": "alex", "op": "upload", "file": "upload/Larkfield AR aging 082426_2.xlsx", "pane": "in", "onto": null, "sha256": "9f2c…"}
    {"seq": 41, "at": "2026-08-24T15:02:00Z", "by": "server", "op": "point", "item": "u40", "file": "upload/Larkfield AR aging 082426_2.xlsx"}
    {"seq": 42, "at": "2026-08-24T15:02:02Z", "by": "server", "op": "run", "run": 4, "upto": 41}
    {"seq": 47, "at": "2026-08-24T15:09:30Z", "by": "agent", "op": "point", "item": "ar-aging", "file": "upload/Larkfield AR aging 082426_2.xlsx", "was": "upload/Larkfield AR aging 082426.xlsx"}
    {"seq": 48, "at": "2026-08-24T15:09:30Z", "by": "agent", "op": "remove", "item": "u40"}
    {"seq": 50, "at": "2026-08-24T15:14:12Z", "by": "server", "op": "done", "run": 4, "aborted": false, "seen": 41, "cost": 0.21, "summary": "AR aging replaced; borrowing base v3."}
    {"seq": 52, "at": "2026-08-24T15:20:00Z", "by": "sam", "op": "answer", "note": "q3", "choice": 1, "text": "Standing rule from now on"}
    {"seq": 60, "at": "2026-08-24T16:02:00Z", "by": "server", "op": "answer", "note": "q4", "choice": 0, "text": "Yes", "default": true}
    {"seq": 61, "at": "2026-08-24T16:02:00Z", "by": "alex", "op": "close"}

## The agent

- **One session per instance.** The server runs Pi in the series folder with the instructions in [prompt.md](prompt.md). Each run is one prompt into the instance's session, so within an instance the agent remembers its earlier runs. A new instance starts a new session, so whatever the next instance needs must be in the files.
- **Messages:** every prompt and steer reads `Instance <label> (folder <label>/), run <n>. New log entries:`, followed by the log lines, as JSON, that the agent hasn't been sent. The agent's own lines are left out.
- **What starts a run:** an upload, an answer or a Steer from a person, or a new instance whose parent had inputs the agent made (files in `working/`), so the fetched inputs arrive at once; its `create` entry carries `fetch`. Runs start 1.5 s after the last of a burst of uploads, so a multi-file drop starts one run.
  - **During a run,** the same events reach the agent as a steer. Pi delivers it after the current turn's tool calls, and with steering mode `all`, everything queued by then arrives together.
  - **Events for another instance of the series** wait for the current run to end.
- **The cursor:** the runner records the highest log seq the agent has actually received, which it knows when Pi starts the user message that carried it. When a run settles and people's events lie above the cursor, another run starts at once. They can get there through a steer sent as the run ended, or one cleared by Interrupt. After an Interrupt, the next run waits for the next event.
- **What a run does:**
  - It places new uploads. Each becomes a new item, a replacement for an item's file, or a person's revision of an output. It records a replacement by repointing the item, and says so in a note.
  - It starts from the instance in its `create` entry's `from`, and checks the other open instances for answers and rules that apply to its own. The system gives an arrow of direction, and the agent needn't follow it strictly. A file it needs from another open instance it copies into its own `working/`, noting where it came from, so its copy is the stable reference.
  - It can add inputs of its own, such as a table extracted from an emailed PDF, as files in `working/`.
  - In an instance whose outputs people supplied, such as an example being imported, it rebuilds each output from the inputs with scripts in `working/`. It then notes, item by item, how much it reproduced and what it couldn't derive.
  - In a new instance, it builds the outputs the examples have, from this instance's inputs and, where the work rolls forward, the previous instance's outputs. It starts from the scripts of the most recently closed instance, and notes what's missing, what it assumed, and each value it carried rather than computed, with where it came from.
  - After an input changes, it rebuilds the outputs that used it, as new files, and notes what changed.
  - After a person revises an output, it compares their version with its own and rebuilds the outputs that depend on it. It asks whether the change is a one-off or a standing rule.
  - It draws the graph: a handful of steps, each in a small file it writes, and each item's `from`, as its scripts actually read them.
  - It puts each step and output on the screen when it's ready, and ends every run with `rf put` and a one-line summary.
- **The agent makes the call.** Nothing in the system checks or scores outputs. The agent decides whether its work is right, and writes checks as scripts in `working/` when it judges it needs them.
- **Answers carry over.** Close logs the default of every unanswered question as an answer. The next instance's agent applies the answers given after the previous instance's last run, and folds standing rules into `process.md`.
- **Reads sources, never writes them.** People usually bring the files. When a person points the agent to a source instead, such as a database or a mailbox folder, the agent reads it, saves what it read in `working/` as the input's file with a `source`, and keeps the fetch as a script that later instances rerun. It reads the series folder, and writes only to its instance's `working/` and, through `rf`, its workspace.
  - People remain the executor: they post the entries and send the certificates.
  - Real systems and their credentials wait for the sandbox (M3).
  - On the host, these limits rest on the instructions alone; M3 enforces them with a sandbox.
- **History is the memory.** Rather than keep a standing script library, the agent copies and adapts the most recently closed instance's scripts. Each instance's `working/` is then a complete record of how its outputs were made. Nothing else is carried between instances.
- **One run at a time per series,** with a time limit (2 hours; `RF_LIMIT_MIN`).
- **Model:** one, set in the runner (`RF_MODEL`, default `openrouter/anthropic/claude-opus-5.5`, thinking `high`). Choosing a model per series comes later.

## Harness: Pi over RPC

The runner, [src/runner.ts](src/runner.ts), drives Pi through Pi's `RpcClient`, which runs Pi as a child process and exchanges JSON lines with it:

    pi --mode rpc --provider openrouter --model anthropic/claude-opus-5.5 --thinking high \
      --no-extensions --no-skills --no-mcp --no-context-files --no-prompt-templates \
      --tools read,bash,edit,write --append-system-prompt <app>/prompt.md \
      --session-dir "<label>/session" --session-id main

- **Advanced's controls are Pi's own commands.** `prompt` starts a run, and `steer` delivers mid-run events and Advanced's Steer. Interrupt is `clear_queue`, then `abort`.
- **Steering mode `all`** comes from the Pi settings the runner uses. The runner doesn't send `set_steering_mode`, which would save to the user's global settings.
  - On the host these are the user's own settings, which must say `all`. The Docker image sets it.
  - At M3 the sandbox gets its own Pi home, with `steeringMode` set to `all` and an API key.
- **One process per run.** The runner stops Pi at `agent_settled`, since RPC mode runs until its stdin closes. At the time limit, it aborts the run and stops Pi.
- **Sessions are found by working folder.** Pi reopens `main` only if the folder recorded in the session's first line is the series folder, so a series rename rewrites that line in every session of the series.
- **Credentials:** Pi uses the OpenRouter key from `OPENROUTER_API_KEY` or the user's Pi credentials. It works with `--no-extensions`, unlike a Claude subscription, which needs its auth extension loaded with `-e`.
- **Harness-specific code stays in one module,** the runner. `RpcClient` always starts `node <cliPath>`, so M3 needs a `cliPath` shim that runs `sbx exec -i <sandbox> -- pi …`. Pi's docs show only `pi -p` inside a sandbox, so RPC through `sbx exec` needs a test.
- **Not the AI SDK's `HarnessAgent`,** whose steering is experimental (`experimental_steerTurn`) and not supported by every adapter. **Not Docker Agent,** whose delegation isn't needed when agents talk through files; Docker's sandbox is still the M3 plan.

## Build order

The risk is whether an agent can learn a real deliverable from examples, so the agent comes first.

1. **M1, server and runner (built).** One Node process holds the store, the `rf` endpoint, the run queue and a JSON API for people's actions.
   - **Made-up series** ([demo/](demo/)): a generator makes a weekly borrowing base for a made-up housewares company: four example weeks, then five forward weeks with traps.
     - **08-09:** a wrong inventory file, replaced mid-run under a new name; the card receipts arriving late; a reviewer raising the availability block, answered as a standing rule that later weeks must apply.
     - **08-16:** people stop uploading the inventory and the lender's loan activity. A Steer points the agent to a warehouse database and a mailbox folder. A new customer is billed in EUR, converted at the ECB reference rate, which the agent fetches from the ECB's data API.
     - **08-23:** created while 08-16 is still open, so only 08-16 shows where the sources are. The lender's email arrives late, and a Steer asks for a refetch.
     - **A stray instance** is abandoned, so 08-30 must start from 08-23.
     - **08-30:** the warehouse snapshot is stale, and a lender email raises one customer's concentration limit for that week only.
     - **09-06:** open and empty in the image, for a person to drop the AR aging and card receipts into. The sources are the same; the loan email is dated Tuesday, as Monday 09-07 is Labor Day.

     A driver imports the examples one at a time, then stages each forward week only when the agent may see it. To test the build, it compares the agent's outputs with the generator's, and prints checks (ids, headlines, sources, citations, `process.md` size); that is test tooling, not part of the system.
   - **Environment:**
     - Node 26, which runs TypeScript directly, and `npm install`;
     - `uv venv .venv && uv pip install -r requirements.txt` (openpyxl, pandas, xlrd, extract-msg, defusedxml, requests, beautifulsoup4, lxml, matplotlib, pdfplumber, python-docx), with `.venv/bin` first on the agent's `PATH`;
     - LibreOffice, to recalculate scratch copies of formula workbooks.
     - Each series has its own `.pylib` on the agent's `PYTHONPATH`: Python packages the agent installs there with `pip install --target` stay with the series, in the data volume, and survive a new image.
     - The Docker image adds poppler, sqlite3, curl, git, jq, zip and CJK fonts. Its outbound network is open, and a run can reach every series; per-series capabilities (network, packages, sources, secrets) wait for the sandbox.
2. **M2, the page (built):** [web/index.html](web/index.html), over the same server:
   - the graph, tiles, notes, ops log and Advanced, which reads the agent's work from the instance's Pi session file;
   - phone layout: Outputs come first, then the other tiles, each saying what it's made from instead of lines; notes open as a bottom sheet;
   - it polls every 4 seconds rather than streaming events;
   - uploads, answers, Steer, Interrupt and Close as POSTs, refused when the browser marks them cross-site, so another web page can't steer an agent;
   - file downloads: attachments with a sandboxing CSP (images inline), and only files whose real path stays inside the instance, so an agent's link can't expose the server's files;
   - the name, asked once and kept in the browser.

   The demo can run behind `tailscale serve`, to try it from a phone.

   Then add a second series, such as a monthly rec whose day-2 GL listing arrives later.
3. **M3, hosting.** Sign-in, one workspace per client, and backups. Pi runs in Docker Sandboxes, built from Docker's Pi kit plus Python, the spreadsheet libraries and `rf`.
   - **A code gate (built, for an early demo):** once anyone has been invited, the server asks for a name and a TOTP code from an authenticator app before anything but `/agent/`; until then the site is open, for a run on localhost. Each person sets up their own secret from a one-time invite link, made and revoked with `node src/access.ts`; the list is `.access.json` in the data root. A right code sets a cookie for 7 days, signed with the person's secret, so revoking or re-inviting them ends it. Each wrong code doubles the wait before anyone's next try, up to 5 minutes. The browser takes its name for the log from the sign-in.
   - Each sandbox is a microVM. The series folder is mounted read-only; only the instance's `working/` and `session/` are writable.
   - **Network:** outbound traffic is denied except to the model API and the agent API. Docker's proxy adds the model key on the way out, so the key never enters the sandbox. The agent API is reached at `host.docker.internal` after `sbx policy allow network --sandbox <name> localhost:<port>`.
   - **The agent API gets its own port.** Each call carries a per-run token that is bound to one instance and expires when the run ends. A sandbox can then never reach another workspace through the server.
   - Local sandboxes are free, including for commercial use.

## Stack

- **TypeScript on Node,** with `node:http` and no framework or build step. The page will be one HTML file with plain JS. Pi's `RpcClient` is TypeScript, so the runner lives in the server.
- **Python** for the agent's own scripts, from `.venv`.

## Later (not in v0)

- Sort people's revisions into four kinds: input correction, one-off judgement, standing rule or agent bug. Standing rules then need an owner's approval; v0 only asks the person who made the change.
- When an input changes, show a redline of what moved in each output.
- A review copy of an output with the agent's notes as Excel comments. The deliverable itself never carries them.
- Per-user read state, and notifications by email or Teams.
- One series' output as another series' input.
- Deleting a wrong upload, such as another client's file, for real. In v0 the agent can only take it off the screen.
- **A super agent** (an end state, not yet tested with users). Like a finance system's super user, it can read every series and instance of a workspace. It makes no deliverables; it can only:
  - send a note to a series' agent, now or for its next instance;
  - alert a person, such as "someone else is doing X; cross-check with them."

  Its notes reach an instance as an event in that instance's log, signed "super", which starts or steers a run like any other. So agents talk only through the folders, and there's no messaging layer to build or audit.

## Decisions

1. **Name:** rollforward.
2. **Storage location:** on the host's disk.
3. **Agent's reach:** its own series, with all of that series' instances. A workspace-wide super agent comes later.
4. **Closing:** an explicit "Close instance".
5. **Stack:** TypeScript on Node.
6. **Model access:** through OpenRouter.
7. **Harness:** Pi over RPC.
8. **Mid-run drops** join the current run by steering, with the steering mode `all`.
9. **Files only:** the main screen has no typing or prompting, and doesn't show the agent at work. Inputs and outputs are file tiles that show whether a person or the agent made them. Notes are pinned to files, people can upload on both sides, and a new series is set up by dropping past inputs and outputs.
10. **Ops log and Advanced** are separate from the graph. Advanced shows the agent's work, can steer and interrupt, and expands over the graph rather than replacing it.
11. **Storage:**
    - `upload/` holds people's files, which nobody ever moves or changes; a repeated name gets `_2`.
    - `working/` is the agent's.
    - The screen, `workspace.json`, maps items to files, with notes. The server and the agent both write it.
    - The log records every event, and only the server writes it. The agent reads it to see what changed.
    - A replacement is the agent repointing an item.
12. **Names:** unit becomes **series**, and cycle becomes **instance**. Instances have labels rather than periods. They sort alphabetically, and by default only open ones show.
13. **Agent-made inputs:** the agent can create inputs too, as files in `working/`.
14. **Not files:** the screen and the log needn't be files the agent edits; any sync method will do, as long as who owns what stays the same.
15. **Review, then build:** two Opus 5.5 agents review the plan, the second validating the first, and then M1 is built.
16. **No pass bars or automatic checks** (15 Oct): agents make the call, and build checks as scripts if they need them. The product isn't aimed at finance, and shouldn't be over-explained.
17. **Key and additional inputs; evidence and working** (15 Oct). See Concepts.
18. **Direction** (15 Oct): each instance records its parent (`from`). The agent starts there and checks the open instances; no stricter rules.
19. **Sources** (15 Oct): the agent may read the sources people point it to, and never writes to them.
20. **Two end states** (15 Oct): Close or Abandon.
21. **Series visibility** (15 Oct): one way, granted by the publishing series, read-only for the reader; one workspace for now. People's roles per series (owner, member, visitor) come later.
22. **Duplicate and series settings** (15 Oct): a closed or abandoned instance can be duplicated into an open one. Each series has settings, for now its name and its visibility to other series.
23. **A TOTP gate for an early public demo** (16 Oct): codes from an authenticator app rather than a password, since codes expire and an enrolled phone is hard to pass on. One secret per person, set up from a one-time link, so one person can be revoked. The gate is one module, `src/access.ts`, and is off until someone is invited. Microsoft sign-in through oauth2-proxy is dropped for now, since the tenant's admin would have to consent.
24. **Workspaces** (16 Oct): the top-level folder is a workspace, such as a client's. The sidebar cascades workspace, series and instance, with each row's actions in its corner rather than as rows of their own. A workspace or a series can be archived, which hides it until it's restored; nothing in it changes, and its runs carry on.

25. **The graph** (17 Oct): the screen shows the process as a graph of inputs, steps and outputs, with Outputs in their own column so they never scroll away. What each item is made from is a hint for people: nothing runs it, and the agent needn't follow it. Drops are hints too, and the page doesn't show `process.md`, which points at the agent's scripts.

## Proposed by the agent (open to change)

1. People answer questions by clicking an option. If none fits, they fix the file and drop it back.
2. A drop is a hint: the server adds each upload as a new item at once, and the agent decides what it is.
3. If an item points at a person's upload, the agent repoints it to its own file only by asking first.
4. A person's revision starts a run that rebuilds the outputs that depend on it.
5. Notes stay out of the deliverable.
6. The agent changes the screen through `rf`, which rejects a stale or invalid put (decision 14).
7. A file the screen has shown is read-only, and the log keeps its hash.
8. The ops log is a side panel.
9. There is one Pi session per instance.
10. A series' name is its folder name.
11. A new instance starts from the most recently closed instance, by close time rather than label order.
12. The colour code: blue for what a person put in, black for what the agent made, red for notes ([docs/design.md](docs/design.md)).
13. The runner's cursor: events the agent never received start another run when the current one settles, except after an Interrupt.
14. Close logs each unanswered question's default as an answer, and the next instance applies it.
15. Past instances are imported one at a time, in label order.
16. In v0, the red dot is per browser, and the log has no read events.
17. A step is an intermediate result in a file, rather than an operation, so every tile opens in Preview and a dashed tile always means not there yet.

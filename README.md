# rollforward

Recurring tasks, files in and files out. People drop this period's input files into an instance of a series. An agent learns the transform from the closed instances, produces the output files, and pins notes and questions to the cells they're about. The screen shows the work as a graph, from the inputs through the agent's steps to the outputs. People answer by clicking an option, drop in a corrected file when one was wrong, and close the instance when it's done. There is no prompt box on the main screen.

![An instance: inputs, steps and outputs, joined by what each is made from](docs/screenshots/instance.png)

- **The agent** is [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), run over RPC with read, bash, edit and write tools, in the series folder. It copies and adapts the previous instance's scripts, so each instance's `working/` is a complete record of how its outputs were made.
- **Inputs** are uploads, or sources a person points the agent to, such as a database, a mailbox folder or a web API. The agent keeps a frozen copy of what it read, and the tile shows where it came from.
- **Workspaces hold series,** such as one client's. Each belongs to one person, who alone sees it, besides admins. A workspace or a series can be archived, which hides it until it's restored.
- **People sign in with Microsoft,** with one button.
- **Tool use:** a series can let its agent use company systems, such as E1, DMS or XTS, in a browser the server runs, signed in as a service account whose password the agent never sees. Each write waits for a person to approve it.
- **Series can share.** A series can let other series read it, one way.
- **Everything is files on disk.** Each instance has `upload/` (people's files), `working/` (the agent's), `workspace.json` (what the screen shows) and `log.jsonl` (every event).

| A tile's notes | Preview, compared with the file it replaced |
|---|---|
| ![Notes](docs/screenshots/notes.png) | ![Preview](docs/screenshots/preview.png) |
| **Advanced: the agent's work** | **Phone** |
| ![Advanced](docs/screenshots/advanced.png) | ![Phone](docs/screenshots/phone.png) |

## Try it

    cp .env.example .env          # set OPENROUTER_API_KEY
    docker compose up --build     # then open http://127.0.0.1:8780

The image comes with a demo series that is already populated: a weekly borrowing base for a made-up housewares company, nine weeks the agent has done.
- **Week 08-16:** the agent starts fetching the inventory from a warehouse database, the lender's figures from a mailbox and the EUR rate from the ECB.
- **Week 08-30:** it handles a stale snapshot and a one-week waiver from the lender.
- **Week 09-06:** open it and drop the two files from `demo/try/2026-09-06/`. The agent fetches the inventory from the warehouse database, the loan activity from the mailbox and the EUR rate from the ECB.
- **Things to open:** a tile, Preview, the ops log and Advanced.
- **Running the agent:** create an instance and drop files. A normal week costs about $0.20–0.60 with Claude Opus 5.5 through OpenRouter.

## Access

People sign in with one button, **Sign in with Microsoft**, and type nothing.

- **Demo (the default):** the button leads to a picker of two demo accounts: `admin@demo.test`, an admin, and `bob@demo.test`, a user. Anyone who reaches the site can be the demo admin, so keep it on localhost.
- **Your organisation's Microsoft accounts:** register an app in Microsoft Entra ID with the redirect address `RF_PUBLIC_URL/auth/callback` and a client secret, and set the four `RF_OIDC_*`/`RF_PUBLIC_URL` values in `.env` (see `.env.example`). The same button then goes to Microsoft. `RF_ADMINS` names the admins; `RF_ALLOWED_DOMAINS` and `RF_AUTO_PROVISION=0` narrow who may come in.
- **What people see:** each workspace has one owner. A user sees only the workspaces they own, with their series and files. Admins see every workspace, give one to someone in its settings, and manage people on the Users page. The same from a shell:

      docker compose exec rollforward node src/auth.ts /data list
      docker compose exec rollforward node src/auth.ts /data add alice@example.com [admin]
      docker compose exec rollforward node src/auth.ts /data disable alice@example.com   # her sessions end at once

Sessions last 12 hours (`RF_SESSION_HOURS`). The people, the owners and the session key are in `.rf/` in the data root.

## Tool use

A series picks which company systems its agent may use, under **Tool use** in its settings: E1, DMS and XTS are always offered, and choosing none is fine. Admins set each one up under **Systems**, at the foot of the sidebar, with its address and a service account the agent signs in as; until then it can be chosen, but the agent can't use it. Admins can add other systems there too.

- The agent works them through a browser the server runs (Playwright with Chromium). The server signs in, so the password stays in `.rf/` and the agent never sees it.
- Reading is free. A write (saving or submitting anything) is stopped until the agent proposes it and a person approves it from the instance's screen; then the server makes it and keeps a screenshot.
- By default every request but GET counts as a write. A system that also posts its searches needs its write requests named under Systems, such as `POST */save*`.

Without Docker, the browser needs `node node_modules/playwright/cli.js install chromium` once.

To reach it from the internet, run `tailscale funnel --bg 8780`, with Microsoft sign-in configured.

For a demo run in podman behind Tailscale Funnel, the justfile has `just invite EMAIL [admin]`, `just revoke EMAIL`, `just people`, `just logs`, and `just deploy`, which rebuilds it from the committed main branch.

**Security:** anyone signed in can steer the agents of their own workspaces, which run shell commands inside the container: they can read the model's API key and every series, and reach whatever the host can reach.

## Without Docker

You need Node 26 and uv. LibreOffice is optional, for recalculating formula workbooks.

    npm install
    uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
    node src/server.ts DATA_ROOT [PORT]

The [justfile](justfile) has these and more as recipes; `just` lists them.

- **Pi credentials:** Pi needs `OPENROUTER_API_KEY` or a Pi login.
- **Pi settings:** `"steeringMode": "all"` in `~/.pi/agent/settings.json`.
- **Environment variables:**
  - `RF_MODEL` (default `openrouter/anthropic/claude-opus-5.5`)
  - `RF_THINKING` (`high`)
  - `RF_LIMIT_MIN` (120)
  - `RF_PI_ARGS` (a JSON array of extra Pi arguments)
  - `RF_HOST` (`127.0.0.1`)

To build the demo from scratch (about $4 of model use; the generator needs the internet for the ECB rates):

    .venv/bin/python demo/make_demo.py demo/out
    .venv/bin/python demo/run_demo.py demo/out http://127.0.0.1:8780 DATA_ROOT

## More

- [PLAN.md](PLAN.md): the design and the decisions.
- [prompt.md](prompt.md): the agent's instructions.
- [docs/design.md](docs/design.md): the look.

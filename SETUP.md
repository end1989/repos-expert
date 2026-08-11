# Setup — start to finish

This gets you from nothing to asking questions about your own code. It takes about
fifteen minutes, most of which is waiting.

You do **not** need to be set up with GitHub. You do **not** need all your projects.
Start with the ten or twenty you actually care about.

---

## The short version

Install Node once, then two commands:

```powershell
npm install -g repos-expert
expert init
```

`expert init` writes your settings and adds the tool to Claude Desktop for you. Restart
Claude Desktop, and you're done — there is nothing to keep running. Claude starts the
tool itself when you open it.

To update later: `npm update -g repos-expert`.

**Working on the tool itself?** Clone it instead and run `.\scripts\setup.ps1`, which
installs prerequisites, builds from source, and connects the same way. The long version
below covers that route.

---

## What you need

| Thing | Needed? | Why |
| --- | --- | --- |
| **Node 20 or newer** | Yes | Runs the tool. |
| **A folder of code** | Yes | The projects to study. |
| **Claude Desktop** | To ask questions | The chat window you type into. |
| **Claude Code** | To write the docs | The studying step uses a model. Free with a Claude subscription. |
| **Git and GitHub CLI** | Optional | Only if you want your repos pulled from GitHub automatically. |

Nothing here needs an API key or a credit card if you already pay for Claude.

---

## The long version

### 1. Install the pieces

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git            # optional
winget install GitHub.cli         # optional
```

Close and reopen your terminal afterwards so it picks up the new commands.

### 2. Get the tool ready

```powershell
git clone <this-repo> repos-expert
cd repos-expert
npm ci
npm run build
```

### 3. Point it at your code

Open `expert.config.json` and set where your projects live:

```json
{
  "reposDir": "C:/dev/repos",
  "knowledgeDir": "./knowledge",
  "model": "claude-sonnet-5",
  "curateConcurrency": 2,
  "curateTimeoutMinutes": 25
}
```

That's it. `reposDir` is any folder containing project folders. If you also want repos
pulled down from GitHub, add `"githubUser": "your-username"` and run `node dist/cli/index.js sync`
— otherwise skip it entirely, and copy or clone project folders in yourself.

Check that it sees them:

```powershell
node dist/cli/index.js status
```

You should get one line per project, all saying `uncurated` — meaning "found it, haven't
studied it yet".

### 4. Study one project first

Always try one before doing many, so you find problems cheaply:

```powershell
node dist/cli/index.js refresh <one-project-name>
```

Two to four minutes later there will be four new documents under
`knowledge/repos/<project>/`. Open `card.md` and read it. If it describes your project
accurately, everything works.

### 5. Study the rest

```powershell
node dist/cli/index.js refresh <name> <name> <name>
```

Name the projects you want. Each takes a few minutes, two at a time. You can stop
anytime and pick up later — finished work is saved as it goes.

To study **everything** in the folder: `node dist/cli/index.js curate --stale`.
Be aware this can take hours on a large folder, and it uses your Claude allowance the
whole time. Naming projects is usually the better choice.

### 6. Connect it to Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (create it if missing):

```json
{
  "mcpServers": {
    "repos-expert": {
      "command": "node",
      "args": ["C:/full/path/to/repos-expert/dist/cli/index.js", "mcp"]
    }
  }
}
```

Use the real full path, and forward slashes. Restart Claude Desktop, and ask it
something like *"What projects do I have, and what do they do?"*

---

## Keeping it current

After you've changed some code:

```powershell
node dist/cli/index.js refresh          # re-studies only what changed
```

You don't have to remember to do this. Answers about out-of-date projects arrive with a
warning attached, so you'll be told when it's worth re-running.

---

## When something doesn't work

**"No git repositories found"** — `reposDir` is pointing at the wrong folder, or the
folders in it aren't git repositories. The tool prints the exact path it looked in.

**GitHub sync fails, or you never set it up** — that's fine and it says so. Everything
else keeps working on the folders already on disk.

**The studying step fails** — it needs Claude Code installed and signed in
(`claude` in a terminal should work), or an `ANTHROPIC_API_KEY` set. Searching and
reading code need neither.

**A project times out** — it was too big to finish in the time limit. Raise
`curateTimeoutMinutes`, or lower `curateConcurrency` to 1 so it gets more of the
machine.

**Claude Desktop doesn't show the tools** — the path in the config must be absolute,
and Claude Desktop must be fully restarted (quit from the tray, not just closed).

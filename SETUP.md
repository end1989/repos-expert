# Setup — start to finish

This gets you from nothing to asking questions about your own code. It takes about
fifteen minutes, most of which is waiting.

You do **not** need to be set up with GitHub. You do **not** need all your projects.
Start with the ten or twenty you actually care about.

---

## The short version

Install Node once, then:

```powershell
npm install -g repos-expert
expert init
```

`expert init` asks where your projects are, writes your settings, and adds the tool to
Claude Desktop for you. There is nothing to keep running — Claude starts the tool itself.

Then get your projects into that folder. Either way works:

```powershell
expert add https://github.com/acme/billing-api.git    # clones it, and remembers it
```

or copy/clone the folders in yourself — anything containing a `.git` is picked up
automatically.

Finally, study one and check the result:

```powershell
expert refresh billing-api
```

Restart Claude Desktop and ask *"what projects do I have?"*

To update later: `npm update -g repos-expert`.

### Where the list of projects lives

`repos.txt`, in your projects folder — the same folder `expert init` set up. It is plain
text, one git URL per line, and opening it in Notepad is a perfectly good way to edit it:

```
# Projects for repos-expert to study.
https://github.com/acme/billing-api.git
git@github.com:acme/checkout-service.git
billing = https://gitlab.com/acme/some-very-long-repository-name.git
```

`expert sync` clones anything on that list that isn't on disk yet, and fast-forwards the
ones that are — it never discards local commits, so listing a repo you actively work in
is safe. `expert add <url>` does the editing and the cloning in one step.

You do not have to use the list at all. It exists so there is one obvious place to answer
"how do I tell it about my services?" — but a folder you copied projects into works
exactly the same. To keep the list somewhere else, set `reposListFile` in your config.

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
git clone https://github.com/end1989/repos-expert.git repos-expert
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

That's it. `reposDir` is any folder containing project folders — it can be a folder you
already work in. Projects get there three ways, and you can mix them freely:

- copy or clone folders in yourself;
- list git URLs in `repos.txt` inside that folder, then `node dist/cli/index.js sync`;
- add `"githubUser": "your-username"` to pull a whole GitHub account on `sync`.

Set `reposListFile` if you would rather keep the list somewhere other than `repos.txt`.

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

Two to four minutes later there will be five new documents under
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

Or never run it at all — schedule it:

```powershell
.\scripts\schedule-refresh.ps1                       # Sundays at 03:00
.\scripts\schedule-refresh.ps1 -Day Wednesday -At 21:30
.\scripts\schedule-refresh.ps1 -Remove
```

It only re-studies repos whose code changed, skips the run if the machine is off (and
catches up next time it's available), and writes its output to
`%LOCALAPPDATA%\repos-expert\weekly-refresh.log`.

---

## Which model writes the documents (and who pays)

Serving needs no model at all — it is files and ripgrep. Only the *studying* step
uses one, and it never gets credentials from this tool: it launches Claude Code, which
authenticates itself. `expert doctor` tells you which of these is in force:

| What it says | What it means |
| --- | --- |
| Claude Code sign-in | Your Claude subscription. Nothing billed per repo. |
| ANTHROPIC_API_KEY | Billed per token, not from a subscription. |
| custom endpoint … | A local model or proxy. Nothing billed to Anthropic. |
| AWS Bedrock / Google Vertex | Billed by that cloud. |

### Using a local model

Run something that speaks the Anthropic message format in front of your local model —
LiteLLM and claude-code-router both do — then put the endpoint in your config:

```json
{
  "curatorEnv": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_AUTH_TOKEN": "local"
  }
}
```

Config rather than shell variables on purpose: the weekly scheduled refresh inherits
neither your terminal nor its environment, so a `$env:` setting would silently fall back
to your subscription at 3am. `expert doctor` prints `(via curatorEnv)` when the setting
is coming from the file.

**Read the first result before trusting the rest.** These documents are worth having
because the curator reads code and refuses to repeat the README — that discipline is the
whole product. Weaker models fail exactly there: they summarise the documentation they
find and hand you a confident description of a feature that does not exist, which is
worse than having no knowledge base at all. Study one repo you know well and check
`interfaces.md`. If its "Documented but not implemented" section is empty on a project
whose README you know overpromises, the model is not doing the job.

## When something doesn't work

**Start here:**

```powershell
expert doctor
```

It checks Node, the bundled search binary, model access, your config, whether the repos
folder exists and has anything in it, whether the knowledge folder is writable, and git —
then names the single first thing to fix. `expert` on its own tells you where your files
are and what to run next.

If your MCP client shows repos-expert as connected but every answer says it is "not set
up yet", that is the server telling you `expert init` was never run on this machine. It
starts anyway rather than showing you a dead server.

**"No projects found"** — `reposDir` is pointing at the wrong folder, or the folders in
it aren't git repositories. The tool prints the exact path it looked in. To move it, edit
`reposDir` in your config, or re-run `expert init --repos-dir "<path>" --force`.

**You have a folder with nothing but `CLAUDE.md` and `repos.txt` in it** — that is a
fresh, empty setup. Either it guessed the wrong folder (fix `reposDir` as above) or no
projects have been added yet (`expert add <url>`, or copy folders in).

**"Nothing to sync yet"** — `repos.txt` has no URLs in it and no `githubUser` is set.
That's not a failure; copying folders in by hand needs neither.

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

**You updated, but the assistant still behaves like the old version** — the client
launches whatever its config points at, not whatever you just installed. `expert doctor`
has a `claude desktop` line that says which version it would launch and where from;
`expert init` re-points it at the copy you have (your settings are left alone), then
restart Claude Desktop from the tray.

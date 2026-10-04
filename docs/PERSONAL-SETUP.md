# Personal ECC Setup

This fork adds a small personal layer on top of ECC so that your coding agents
(Claude Code, Codex, and OpenCode) only see the skills that fit the project you
are working in, instead of all 293. All of them also share one set of
instructions.

## How it works

| Layer | What it holds | When the agent sees it |
|---|---|---|
| 1. Global core | About 10 everyday skills (planning, test-first coding, verification, security review, code review, session save and resume), plus, for Claude Code, 5 agents, 5 commands, and the common rules | Every session, in every project |
| 2. Project set | Skills (and, for Claude Code, rules and reviewer agents) that match the project's stack, chosen by scanning the project | Only inside that project |
| 3. Library | Every other ECC skill | Only when a task needs one, through the `skill-library` router |

Agents already load a skill's full text only when a task matches it. This setup
keeps the list they choose from short and relevant, which makes their choices
better and saves context.

Everything runs as a plain Node.js script on your computer. It makes no network
calls, uses no AI credits, and never overwrites files you created yourself.

### Where each tool reads

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Global skills | `~/.claude/skills/` | `~/.agents/skills/` | reads both of those |
| Project skills | `<project>/.claude/skills/` | `<project>/.agents/skills/` | reads both of those |
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.config/opencode/AGENTS.md` |
| Project instructions | `CLAUDE.md`, which imports `AGENTS.md` | `AGENTS.md` | `AGENTS.md` |
| Rules, agents, slash commands | Yes | No (the rules are pointed to from `AGENTS.md`) | No |

OpenCode gets its own `.opencode/skills/` folder only when it is the only tool you
select. Skill copies for Codex and OpenCode have ECC-specific header fields
removed, because those tools accept only the standard skill fields.

### One shared set of instructions

- **Global:** `my-ecc/AGENTS.md` holds the instructions every agent should
  follow in every project (communication style, ways of working, safety rules).
  `global` copies it into each tool's global instruction file.
- **Private:** this repository is public, so anything personal goes in
  `my-ecc/private/AGENTS.md`. Git ignores that folder. Copy
  `my-ecc/AGENTS.private.example.md` there to start. `global` adds it after the
  shared text, on your machine only.
- **Per project:** `AGENTS.md` is the one shared file. `apply` creates it when it
  is missing and keeps a short block in it up to date: the detected stack, common
  commands, and where the project's rules and skills are. `CLAUDE.md` gets a
  line `@AGENTS.md` so Claude Code reads the same file. Write your own project
  notes in `AGENTS.md`, outside the block.

Everything the tool writes into an instruction file sits between
`<!-- ecc-personal:start -->` and `<!-- ecc-personal:end -->`. A re-run replaces
only that block, and `remove` takes it out again. Your own text is never changed.

## Before you start

- Install Node.js 18 or newer, Git, and the agents you use (Claude Code, Codex,
  OpenCode).
- If you previously installed ECC as a Claude plugin (`/plugin install ecc@ecc`),
  as a Codex plugin, or with `install.sh --profile full`, remove that first.
  Otherwise the agents see the same skills twice.

## Step 1: One-time setup on your laptop

macOS or Linux:

```bash
git clone https://github.com/rahulrao85/ECC4RR-.git ~/ecc
cd ~/ecc
node scripts/personal-setup.js check
node scripts/personal-setup.js global
```

Windows (PowerShell):

```powershell
git clone https://github.com/rahulrao85/ECC4RR-.git $HOME\ecc
cd $HOME\ecc
node scripts/personal-setup.js check
node scripts/personal-setup.js global
```

`check` confirms the profile matches this checkout. `global` installs layer 1,
the `skill-library` router, and the shared instructions for every tool listed in
`my-ecc/profile.json` (all three by default). To set up only some tools, add for
example `--tools claude,codex`.

Keep the checkout where you cloned it: the router points to that folder. If you
move it, run `global` again.

## Step 2: Set up your projects

Preview first. `scan` only reads; it writes nothing.

```bash
node scripts/personal-setup.js scan ~/Projects
```

On Windows, use your projects folder, for example `node scripts/personal-setup.js scan D:\Projects`.

Example output:

```text
1. invoice-api  [not installed]
   Stacks: python (pyproject.toml), fastapi (pyproject.toml contains 'fastapi'), docker (Dockerfile)
   Skills: python-patterns, python-testing, fastapi-patterns, api-design, docker-patterns, deployment-patterns
   Rules:  python  (Claude Code)
   Agents: python-reviewer, fastapi-reviewer  (Claude Code)
```

When the plan looks right, install it:

```bash
node scripts/personal-setup.js apply ~/Projects
```

You can also point `scan` and `apply` at a single project folder.

Run `apply` again whenever you start a new project or a project's stack changes.
It adds what is new, refreshes what is there, and removes what no longer fits.

Point the tool at your projects folder only. It refuses to scan a whole drive,
skips hidden folders and dependency folders such as `node_modules`, and looks
at most three folder levels deep (change this with `--depth`). It stops at the
first folder that looks like a project, so if your projects folder is itself a
Git repository, run `scan` and `apply` on each project folder instead.

## Step 3: Everyday use

- Open your agent inside a project folder: `claude`, `codex`, or `opencode`. It
  sees the global core plus that project's set, and reads the shared instructions.
- Ask in plain language. The agent picks a skill when a task matches; you can
  also name one ("use the tdd-workflow skill").
- For anything outside those sets, the agent uses the `skill-library` router to
  read one skill from the library for that task only.
- Claude Code also has these commands: `/plan`, `/code-review`, `/build-fix`,
  `/save-session`, `/resume-session`.
- To keep a library skill in one project permanently:

  ```bash
  node scripts/personal-setup.js apply ~/Projects/my-app --with deep-research
  ```

  Later `apply` runs keep it.

## Should the project files be committed?

`apply` writes `AGENTS.md` and `CLAUDE.md` in the project folder, and these
folders: `.claude/skills/`, `.claude/rules/ecc/`, `.claude/agents/`, and
`.agents/skills/`, each with an `ecc-personal-state.json`.

- Commit `AGENTS.md` and `CLAUDE.md`: they are useful to every agent and every
  machine.
- Commit the skill folders too if you want cloud sessions on that repository to
  have the same set. Otherwise add them to the project's `.gitignore`:

  ```text
  .claude/skills/
  .claude/rules/ecc/
  .claude/agents/
  .claude/ecc-personal-state.json
  .agents/
  ```

  If the project already commits its own skills under `.claude/skills/`, list the
  ECC skill folders individually instead of ignoring the whole folder.

## Customising

| To change | Edit |
|---|---|
| Which tools are set up | `my-ecc/profile.json`, `tools` (`claude`, `codex`, `opencode`) |
| Shared instructions for every agent | `my-ecc/AGENTS.md` (public) and `my-ecc/private/AGENTS.md` (private) |
| Whether `apply` touches `AGENTS.md` and `CLAUDE.md` | `my-ecc/profile.json`, `project.sharedInstructions` (or `--no-instructions` once) |
| The global core (skills, agents, commands, rules) | `my-ecc/profile.json`, section `global` |
| Reviewer agents added for each stack | `my-ecc/profile.json`, section `project.stackAgents` |
| Scan depth and ignored folder names | `my-ecc/profile.json`, section `scan` |
| How stacks are detected, or new stacks | `my-ecc/stack-mappings.json` |

`my-ecc/stack-mappings.json` uses the same format as
`config/project-stack-mappings.json`. A stack in your file with the same `id` as
an upstream stack replaces the upstream one, so upstream files never need editing.

After any change, run `check`, then `global` and `apply` again.

## Keeping up to date with upstream ECC

All personal changes are new files (`my-ecc/`, `scripts/personal-setup.js`,
`scripts/lib/personal-*.js`, their tests, and this guide), so merging upstream
updates does not conflict with them.

```bash
git remote add upstream https://github.com/affaan-m/ECC.git   # first time only
git fetch upstream
git merge upstream/main
node scripts/personal-setup.js check
node scripts/personal-setup.js global
node scripts/personal-setup.js apply ~/Projects
```

If `check` reports a name that no longer exists (for example, upstream renamed a
skill), update `my-ecc/profile.json` or `my-ecc/stack-mappings.json`.

## Undo

```bash
node scripts/personal-setup.js remove ~/Projects/my-app          # one project, all tools
node scripts/personal-setup.js remove ~/Projects/my-app --tools codex
node scripts/personal-setup.js remove --global                   # global core, router, instructions
node scripts/personal-setup.js remove --global --tools opencode
```

Only what this tool installed is removed. Instruction blocks are taken out of
`AGENTS.md` and `CLAUDE.md`, and a file the tool created is deleted only if you
never edited it. If a file or folder with the same name already existed, the tool
left it alone when installing and leaves it alone now.

## Command reference

| Command | What it does |
|---|---|
| `global [--tools <list>] [--dry-run]` | Install the global core, router, and shared instructions for each tool |
| `scan <folder> [--depth <n>] [--json]` | Show each project's planned set. Read-only |
| `apply <folder> [--with <skills>] [--tools <list>] [--no-instructions] [--dry-run] [--json]` | Install the planned sets and the shared `AGENTS.md`. `--with` works on a single project |
| `remove <project>` / `remove --global` (both accept `--tools`) | Remove what the tool installed |
| `check` | Confirm the profile and stack mappings match this checkout |

Every command also accepts `--profile <path>` to use a different profile file,
and `--home <folder>` to treat another folder as your home folder (for testing).
The tools' own settings are honoured otherwise: `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `OPENCODE_CONFIG_DIR`, and `XDG_CONFIG_HOME`.

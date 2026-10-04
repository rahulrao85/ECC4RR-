# Personal ECC Setup

This fork adds a small personal layer on top of ECC so that Claude only sees the
skills that fit the project you are working in, instead of all 293.

## How it works

| Layer | What it holds | Where it is installed | When Claude sees it |
|---|---|---|---|
| 1. Global core | About 10 everyday skills (planning, test-first coding, verification, security review, code review, session save and resume), 5 agents, 5 commands, and the common rules | Your Claude folder (`~/.claude`) | Every session |
| 2. Project set | Skills, rules, and reviewer agents that match the project's stack, chosen by scanning the project | `<project>/.claude` | Only inside that project |
| 3. Library | Every other ECC skill | This checkout | Only when a task needs one, through the `skill-library` router |

Claude Code already loads a skill's full text only when a task matches it. This
setup keeps the list it chooses from short and relevant, which makes its choices
better and saves context.

Everything runs as a plain Node.js script on your computer. It makes no network
calls, uses no AI credits, and never overwrites files you created yourself.

## Before you start

- Install Node.js 18 or newer, Git, and Claude Code.
- If you previously installed ECC as a plugin (`/plugin install ecc@ecc`) or with
  `install.sh --profile full`, remove that first. Otherwise Claude sees the same
  skills twice.

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

`check` confirms the personal profile matches this checkout. `global` installs
layer 1 and the `skill-library` router. Keep the checkout where you cloned it:
the router points to that folder. If you move it, run `global` again.

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
   Rules:  python
   Agents: python-reviewer, fastapi-reviewer
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

- Open Claude Code inside a project folder. It sees the global core plus that
  project's set.
- Claude picks a skill when a task matches; you do not need to name it.
- For anything outside those sets, Claude uses the `skill-library` router to read
  one skill from the library for that task only.
- Commands in the global core: `/plan`, `/code-review`, `/build-fix`,
  `/save-session`, `/resume-session`.
- To keep a library skill in one project permanently:

  ```bash
  node scripts/personal-setup.js apply ~/Projects/my-app --with deep-research
  ```

  Later `apply` runs keep it.

## Should the project files be committed?

`apply` writes into `<project>/.claude/`: `skills/`, `rules/ecc/`, `agents/`, and
`ecc-personal-state.json`.

- Commit them if you want Claude Code cloud sessions on that repository to have
  the same set.
- Otherwise add them to the project's `.gitignore`:

  ```text
  .claude/skills/
  .claude/rules/ecc/
  .claude/agents/
  .claude/ecc-personal-state.json
  ```

  If the project already commits its own skills under `.claude/skills/`, list the
  ECC skill folders individually instead of ignoring the whole folder.

## Customising

| To change | Edit |
|---|---|
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
`scripts/lib/personal-setup.js`, `scripts/lib/personal-router.js`, their tests,
and this guide), so merging upstream updates does not conflict with them.

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
node scripts/personal-setup.js remove ~/Projects/my-app   # one project
node scripts/personal-setup.js remove --global            # the global core and router
```

Only what this tool installed is removed. If a file or folder with the same name
already existed, the tool left it alone when installing and leaves it alone now.

## Command reference

| Command | What it does |
|---|---|
| `global [--home <folder>] [--dry-run]` | Install the global core and router into `~/.claude` (or `$CLAUDE_CONFIG_DIR`, or `--home`) |
| `scan <folder> [--depth <n>] [--json]` | Show each project's planned set. Read-only |
| `apply <folder> [--with <skills>] [--dry-run] [--json]` | Install the planned sets. `--with` works on a single project |
| `remove <project>` / `remove --global` | Remove what the tool installed |
| `check` | Confirm the profile and stack mappings match this checkout |

Every command also accepts `--profile <path>` to use a different profile file.

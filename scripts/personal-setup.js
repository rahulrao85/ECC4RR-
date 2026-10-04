#!/usr/bin/env node
'use strict';

/**
 * Personal ECC setup CLI: a small global core, per-project sets chosen by
 * scanning, and everything else kept in an on-demand skill library.
 * See docs/PERSONAL-SETUP.md.
 */

const path = require('path');
const setup = require('./lib/personal-setup');
const { buildSkillLibraryRouter } = require('./lib/personal-router');

const LIBRARY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PROFILE = path.join(LIBRARY_ROOT, 'my-ecc', 'profile.json');
const VALUE_FLAGS = new Set(['--with', '--depth', '--home', '--profile']);
const BOOLEAN_FLAGS = new Set(['--json', '--dry-run', '--allow-drive-root', '--global']);

const USAGE = `Personal ECC setup

Usage:
  node scripts/personal-setup.js global [--home <claude-folder>] [--dry-run]
  node scripts/personal-setup.js scan <folder> [--depth <n>] [--json]
  node scripts/personal-setup.js apply <folder> [--with <skill,skill>] [--dry-run] [--json]
  node scripts/personal-setup.js remove <project> [--dry-run]
  node scripts/personal-setup.js remove --global [--home <claude-folder>] [--dry-run]
  node scripts/personal-setup.js check

Commands:
  global  Install the global core (everyday skills, agents, commands, common rules) and the
          skill-library router into ~/.claude (or $CLAUDE_CONFIG_DIR, or --home).
  scan    Find projects under <folder> and show what each would get. Read-only.
  apply   Install each project's set into <project>/.claude. --with adds library skills
          to a single project; they are kept on later runs.
  remove  Remove what this tool installed in one project (or globally with --global).
  check   Report profile or stack-mapping names that no longer exist in this checkout.

Options:
  --profile <path>     Personal profile (default: my-ecc/profile.json)
  --depth <n>          Folder levels to search below <folder> (default from profile)
  --dry-run            Show what would change without writing anything
  --json               Machine-readable output (scan and apply)
  --allow-drive-root   Allow scanning a whole drive (not recommended)
`;

function parseArgs(argv) {
  const args = { command: argv[0], positional: [], flags: {} };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (BOOLEAN_FLAGS.has(arg)) {
      args.flags[arg.slice(2)] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      args.flags[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

function parseDepth(value) {
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth < 0) throw new Error(`--depth must be a whole number, got "${value}"`);
  return depth;
}

function listOrDash(values) {
  return values.length > 0 ? values.join(', ') : '-';
}

function formatPlan(plan, number) {
  const stacks = plan.stacks.length > 0
    ? plan.stacks.map(stack => `${stack.id} (${stack.evidence})`).join(', ')
    : 'none detected (global core only)';
  const lines = [
    `${number}. ${plan.name}  [${plan.status}]`,
    `   Folder: ${plan.project}`,
    `   Stacks: ${stacks}`,
    `   Skills: ${listOrDash(plan.skills)}`,
    `   Rules:  ${listOrDash(plan.rules)}`,
    `   Agents: ${listOrDash(plan.agents)}`,
  ];
  if (plan.missing.length > 0) lines.push(`   Not in library (skipped): ${plan.missing.join(', ')}`);
  return lines.join('\n');
}

function formatSync(result) {
  const lines = [`   Added ${result.added.length}, refreshed ${result.refreshed.length}, removed ${result.removed.length}`];
  if (result.skipped.length > 0) {
    lines.push(`   Left untouched (already there, not installed by this tool): ${result.skipped.join(', ')}`);
  }
  return lines.join('\n');
}

function scanPlans(args, context) {
  const root = setup.resolveScanRoot(args.positional[0], { allowDriveRoot: args.flags['allow-drive-root'] });
  const maxDepth = args.flags.depth === undefined ? context.profile.scan.maxDepth : parseDepth(args.flags.depth);
  const found = setup.findProjects(root, context.stacks, { ...context.profile.scan, maxDepth });
  const extras = args.flags.with ? args.flags.with.split(',').map(name => name.trim()).filter(Boolean) : [];
  if (extras.length > 0) {
    if (found.projects.length !== 1) throw new Error(`--with needs a single project folder; found ${found.projects.length} projects under ${root}`);
    const unknown = extras.filter(name => !context.library.has('skill', name));
    if (unknown.length > 0) throw new Error(`Unknown skill(s): ${unknown.join(', ')}`);
  }
  const plans = found.projects.map(project => setup.buildProjectPlan(project, context, { extras }));
  return { root, visited: found.visited, truncated: found.truncated, plans };
}

function printScanHeader(scan, context) {
  console.log(`Scanned ${scan.root} (${scan.visited} folders): ${scan.plans.length} project(s) found`);
  if (scan.truncated) console.log('Stopped early at the folder limit; point at a narrower folder or raise scan.maxDirectories.');
  console.log(`Global core (not repeated per project): ${listOrDash(context.profile.global.skills)}\n`);
}

function runScan(args, context) {
  const scan = scanPlans(args, context);
  if (args.flags.json) return console.log(JSON.stringify({ ...scan, globalCore: context.profile.global }, null, 2));
  printScanHeader(scan, context);
  scan.plans.forEach((plan, index) => console.log(`${formatPlan(plan, index + 1)}\n`));
  if (scan.plans.length > 0) console.log(`Next: node scripts/personal-setup.js apply "${scan.root}"`);
}

function runApply(args, context) {
  const scan = scanPlans(args, context);
  const dryRun = Boolean(args.flags['dry-run']);
  const outcomes = scan.plans.map(plan => {
    const target = setup.stateTarget(plan.project);
    const entries = setup.planEntries(plan, context.library);
    if (entries.length === 0) {
      const removed = setup.removeManagedInstall(target, { dryRun });
      return { plan, result: { added: [], refreshed: [], skipped: [], removed: removed.removed, managed: [] } };
    }
    const state = { library: LIBRARY_ROOT, stacks: plan.stacks.map(stack => stack.id), extras: plan.extras };
    return { plan, result: setup.syncManagedItems(target, entries, { dryRun, state }) };
  });
  if (args.flags.json) return console.log(JSON.stringify({ root: scan.root, dryRun, outcomes }, null, 2));
  printScanHeader(scan, context);
  outcomes.forEach(({ plan, result }, index) => console.log(`${formatPlan(plan, index + 1)}\n${formatSync(result)}\n`));
  console.log(dryRun ? 'Dry run: nothing was written.' : 'Done. Start Claude Code inside a project folder to use its set.');
}

function runGlobal(args, context) {
  const home = setup.resolveClaudeHome(args.flags.home);
  const dryRun = Boolean(args.flags['dry-run']);
  const router = buildSkillLibraryRouter({ libraryRoot: LIBRARY_ROOT, exclude: context.profile.global.skills });
  const { entries, missing } = setup.buildGlobalEntries(context, router.files);
  const result = setup.syncManagedItems(home, entries, { dryRun, state: { library: LIBRARY_ROOT } });
  console.log(`Global core -> ${home}`);
  console.log(formatSync(result));
  console.log(`   Skill library router: ${router.count} skills in ${router.groups} groups, loaded only on demand`);
  if (missing.length > 0) console.log(`   Not in library (skipped): ${missing.join(', ')}`);
  console.log(dryRun ? 'Dry run: nothing was written.' : 'Done. Restart Claude Code to pick up the changes.');
}

function runRemove(args) {
  const dryRun = Boolean(args.flags['dry-run']);
  let target;
  if (args.flags.global) {
    target = setup.resolveClaudeHome(args.flags.home);
  } else {
    if (!args.positional[0]) throw new Error('Missing project folder (or pass --global)');
    target = setup.stateTarget(path.resolve(setup.expandHome(args.positional[0])));
  }
  const result = setup.removeManagedInstall(target, { dryRun });
  if (!result.found) return console.log(`Nothing to remove: no personal setup state in ${target}`);
  console.log(`${dryRun ? 'Would remove' : 'Removed'} ${result.removed.length} item(s) from ${target}`);
}

function runCheck(context) {
  const problems = setup.validateContext(context);
  if (problems.length === 0) return console.log(`OK: profile and ${context.stacks.length} stack mappings match this checkout.`);
  problems.forEach(problem => console.log(`- ${problem}`));
  console.log(`\n${problems.length} problem(s). Edit my-ecc/profile.json or my-ecc/stack-mappings.json.`);
  process.exitCode = 1;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    console.log(USAGE);
    return;
  }
  const profilePath = args.flags.profile ? path.resolve(setup.expandHome(args.flags.profile)) : DEFAULT_PROFILE;
  const context = setup.loadContext({ libraryRoot: LIBRARY_ROOT, profilePath });
  const commands = {
    scan: () => runScan(args, context),
    apply: () => runApply(args, context),
    global: () => runGlobal(args, context),
    remove: () => runRemove(args),
    check: () => runCheck(context),
  };
  if (!commands[args.command]) throw new Error(`Unknown command: ${args.command}\n\n${USAGE}`);
  commands[args.command]();
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[personal-setup] ${error.message}`);
  process.exit(1);
}

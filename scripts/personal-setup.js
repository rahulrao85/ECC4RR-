#!/usr/bin/env node
'use strict';

/**
 * Personal ECC setup CLI: a small global core, per-project sets chosen by
 * scanning, everything else in an on-demand skill library, and one shared
 * instruction file, for Claude Code, Codex, and OpenCode.
 * See docs/PERSONAL-SETUP.md.
 */

const path = require('path');
const setup = require('./lib/personal-setup');
const { buildSkillLibraryRouter } = require('./lib/personal-router');

const LIBRARY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PROFILE = path.join(LIBRARY_ROOT, 'my-ecc', 'profile.json');
const VALUE_FLAGS = new Set(['--with', '--depth', '--home', '--profile', '--tools']);
const BOOLEAN_FLAGS = new Set(['--json', '--dry-run', '--allow-drive-root', '--global', '--no-instructions']);
const ROOT_LABELS = { claude: 'Claude Code (.claude)', agents: 'Codex and OpenCode (.agents)', opencode: 'OpenCode (.opencode)' };

const USAGE = `Personal ECC setup (Claude Code, Codex, OpenCode)

Usage:
  node scripts/personal-setup.js global [--tools <list>] [--dry-run]
  node scripts/personal-setup.js scan <folder> [--depth <n>] [--json]
  node scripts/personal-setup.js apply <folder> [--with <skill,skill>] [--tools <list>] [--no-instructions] [--dry-run] [--json]
  node scripts/personal-setup.js remove <project> [--tools <list>] [--dry-run]
  node scripts/personal-setup.js remove --global [--tools <list>] [--dry-run]
  node scripts/personal-setup.js check

Commands:
  global  Install the global core and the skill-library router for each tool, and copy
          my-ecc/AGENTS.md into each tool's global instruction file.
  scan    Find projects under <folder> and show what each would get. Read-only.
  apply   Install each project's set for each tool, and make AGENTS.md the shared
          project instruction file (CLAUDE.md imports it).
  remove  Remove what this tool installed in one project (or globally with --global).
  check   Report profile or stack-mapping names that no longer exist in this checkout.

Options:
  --tools <list>       Comma-separated: claude, codex, opencode (default from profile)
  --profile <path>     Personal profile (default: my-ecc/profile.json)
  --depth <n>          Folder levels to search below <folder> (default from profile)
  --no-instructions    apply: leave AGENTS.md and CLAUDE.md alone
  --dry-run            Show what would change without writing anything
  --json               Machine-readable output (scan and apply)
  --home <folder>      Treat <folder> as your home folder (for testing)
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
    `   Rules:  ${listOrDash(plan.rules)}  (Claude Code)`,
    `   Agents: ${listOrDash(plan.agents)}  (Claude Code)`,
  ];
  if (plan.missing.length > 0) lines.push(`   Not in library (skipped): ${plan.missing.join(', ')}`);
  return lines.join('\n');
}

function formatRoots(roots) {
  const lines = [];
  for (const [key, result] of Object.entries(roots)) {
    const removed = Array.isArray(result) ? result : result.removed;
    const counts = Array.isArray(result)
      ? `removed ${removed.length}`
      : `added ${result.added.length}, refreshed ${result.refreshed.length}, removed ${removed.length}`;
    lines.push(`   ${ROOT_LABELS[key]}: ${counts}`);
    if (!Array.isArray(result) && result.skipped.length > 0) {
      lines.push(`     Left untouched (already there, not installed by this tool): ${result.skipped.join(', ')}`);
    }
  }
  return lines;
}

function formatInstructions(instructions, labels) {
  if (!instructions) return [];
  const parts = Object.entries(instructions)
    .filter(([, value]) => value && (value.action || value) !== 'absent')
    .map(([key, value]) => `${labels[key] || key} ${value.action || value}`);
  return parts.length > 0 ? [`   Instructions: ${parts.join(', ')}`] : [];
}

function resolveTools(args, context) {
  return args.flags.tools ? setup.parseTools(args.flags.tools) : context.profile.tools;
}

function scanPlans(args, context) {
  const root = setup.resolveScanRoot(args.positional[0], { allowDriveRoot: args.flags['allow-drive-root'] });
  const maxDepth = args.flags.depth === undefined ? context.profile.scan.maxDepth : parseDepth(args.flags.depth);
  const found = setup.findProjects(root, context.stacks, { ...context.profile.scan, maxDepth, exclude: [LIBRARY_ROOT] });
  const extras = args.flags.with ? args.flags.with.split(',').map(name => name.trim()).filter(Boolean) : [];
  if (extras.length > 0) {
    if (found.projects.length !== 1) throw new Error(`--with needs a single project folder; found ${found.projects.length} projects under ${root}`);
    const unknown = extras.filter(name => !context.library.has('skill', name));
    if (unknown.length > 0) throw new Error(`Unknown skill(s): ${unknown.join(', ')}`);
  }
  const tools = resolveTools(args, context);
  const plans = found.projects.map(project => setup.buildProjectPlan(project, context, { extras, tools }));
  return { root, tools, visited: found.visited, truncated: found.truncated, skippedLibrary: found.skipped.length > 0, plans };
}

function printScanHeader(scan, context) {
  console.log(`Scanned ${scan.root} (${scan.visited} folders): ${scan.plans.length} project(s) found`);
  if (scan.truncated) console.log('Stopped early at the folder limit; point at a narrower folder or raise scan.maxDirectories.');
  if (scan.skippedLibrary) console.log(`Skipped the ECC library folder itself (${LIBRARY_ROOT}).`);
  console.log(`Tools: ${scan.tools.join(', ')}`);
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
  const outcomes = scan.plans.map(plan => ({
    plan,
    ...setup.applyProjectPlan(plan, context, { tools: scan.tools, dryRun, instructions: !args.flags['no-instructions'] }),
  }));
  if (args.flags.json) return console.log(JSON.stringify({ root: scan.root, dryRun, outcomes }, null, 2));
  printScanHeader(scan, context);
  for (const [index, outcome] of outcomes.entries()) {
    console.log([
      formatPlan(outcome.plan, index + 1),
      ...formatRoots(outcome.roots),
      ...formatInstructions(outcome.instructions, { agents: 'AGENTS.md', claude: 'CLAUDE.md' }),
      '',
    ].join('\n'));
  }
  console.log(dryRun ? 'Dry run: nothing was written.' : 'Done. Start your coding tool inside a project folder to use its set.');
}

function runGlobal(args, context) {
  const dryRun = Boolean(args.flags['dry-run']);
  const router = buildSkillLibraryRouter({ libraryRoot: LIBRARY_ROOT, exclude: context.profile.global.skills });
  const result = setup.applyGlobal(context, {
    tools: resolveTools(args, context),
    homes: setup.resolveToolHomes(args.flags.home),
    dryRun,
    routerFiles: router.files,
  });
  console.log('Global core');
  console.log(formatRoots(result.roots).join('\n'));
  console.log(formatInstructions(result.instructions, {
    claude: path.join(result.homes.claude, 'CLAUDE.md'),
    codex: path.join(result.homes.codex, 'AGENTS.md'),
    opencode: path.join(result.homes.opencode, 'AGENTS.md'),
  }).join('\n'));
  console.log(`   Skill library router: ${router.count} skills in ${router.groups} groups, loaded only on demand`);
  if (result.missing.length > 0) console.log(`   Not in library (skipped): ${result.missing.join(', ')}`);
  console.log(dryRun ? 'Dry run: nothing was written.' : 'Done. Restart your coding tools to pick up the changes.');
}

function runRemove(args) {
  const dryRun = Boolean(args.flags['dry-run']);
  const tools = args.flags.tools ? setup.parseTools(args.flags.tools) : undefined;
  let result;
  let where;
  if (args.flags.global) {
    result = setup.removeGlobal({ tools, homes: setup.resolveToolHomes(args.flags.home), dryRun });
    where = 'your user folders';
  } else {
    if (!args.positional[0]) throw new Error('Missing project folder (or pass --global)');
    where = path.resolve(setup.expandHome(args.positional[0]));
    result = setup.removeProject(where, { tools, dryRun });
  }
  const removedCount = Object.values(result.roots).reduce((total, removed) => total + removed.length, 0);
  const blocks = Object.values(result.instructions).filter(value => (value.action || value) !== 'absent').length;
  if (removedCount === 0 && blocks === 0) return console.log(`Nothing to remove in ${where}`);
  console.log(`${dryRun ? 'Would remove' : 'Removed'} ${removedCount} item(s) and ${blocks} instruction block(s) from ${where}`);
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

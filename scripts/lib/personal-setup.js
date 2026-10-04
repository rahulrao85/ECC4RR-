'use strict';

/**
 * Personal ECC setup helpers.
 *
 * Detects project stacks from indicator files, plans a lean per-project
 * surface (skills, rules, agents), and copies only the planned items into a
 * Claude config folder. Every copied path is recorded in a state file so a
 * re-run can refresh or remove exactly what this tool installed, and nothing
 * the user created by hand is ever overwritten.
 *
 * Used by scripts/personal-setup.js. See docs/PERSONAL-SETUP.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = 'ecc-personal-state.json';
const STATE_VERSION = 1;
const MAX_CONTAINS_BYTES = 1024 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const MANAGED_PREFIXES = ['skills/', 'rules/ecc/', 'agents/', 'commands/'];

const DEFAULT_SCAN = {
  maxDepth: 3,
  maxDirectories: 20000,
  ignoreDirs: ['node_modules', 'venv', '__pycache__', 'dist', 'build', 'target', 'vendor'],
};

const LAYOUT = {
  skill: { src: name => path.join('skills', name, 'SKILL.md'), copy: name => path.join('skills', name), dest: name => `skills/${name}` },
  rule: { src: name => path.join('rules', name), copy: name => path.join('rules', name), dest: name => `rules/ecc/${name}` },
  agent: { src: name => path.join('agents', `${name}.md`), copy: name => path.join('agents', `${name}.md`), dest: name => `agents/${name}.md` },
  command: { src: name => path.join('commands', `${name}.md`), copy: name => path.join('commands', `${name}.md`), dest: name => `commands/${name}.md` },
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function unique(values) {
  return [...new Set(values)];
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function asList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

/**
 * Library access for one ECC checkout (the folder that holds skills/, rules/, agents/, commands/).
 */
function createLibrary(root) {
  return {
    root,
    has(kind, name) {
      const layout = LAYOUT[kind];
      return Boolean(layout) && SAFE_NAME.test(name) && fs.existsSync(path.join(root, layout.src(name)));
    },
    source(kind, name) {
      return path.join(root, LAYOUT[kind].copy(name));
    },
  };
}

function normalizeProfile(raw) {
  const global = raw.global || {};
  const scan = raw.scan || {};
  return {
    global: {
      skills: asList(global.skills),
      agents: asList(global.agents),
      commands: asList(global.commands),
      rules: asList(global.rules),
    },
    stackAgents: (raw.project && raw.project.stackAgents) || {},
    scan: {
      maxDepth: Number.isInteger(scan.maxDepth) && scan.maxDepth >= 0 ? scan.maxDepth : DEFAULT_SCAN.maxDepth,
      maxDirectories: Number.isInteger(scan.maxDirectories) && scan.maxDirectories > 0 ? scan.maxDirectories : DEFAULT_SCAN.maxDirectories,
      ignoreDirs: Array.isArray(scan.ignoreDirs) ? scan.ignoreDirs : DEFAULT_SCAN.ignoreDirs,
    },
  };
}

/**
 * Merge upstream stack mappings with personal ones. A personal stack with the
 * same id replaces the upstream stack, so upstream files never need editing.
 */
function mergeStacks(upstream, personal) {
  const byId = new Map();
  for (const stack of [...upstream, ...personal]) {
    if (stack && typeof stack.id === 'string') byId.set(stack.id, stack);
  }
  return [...byId.values()];
}

function loadContext({ libraryRoot, profilePath }) {
  const raw = readJson(profilePath);
  const profile = normalizeProfile(raw);
  const upstream = readJson(path.join(libraryRoot, 'config', 'project-stack-mappings.json')).stacks || [];
  const personal = raw.stackMappings
    ? readJson(path.resolve(path.dirname(profilePath), raw.stackMappings)).stacks || []
    : [];
  return { profile, stacks: mergeStacks(upstream, personal), library: createLibrary(libraryRoot) };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function findIndicatorFiles(projectDir, filePattern) {
  const normalized = filePattern.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const dirParts = slash === -1 ? [] : normalized.slice(0, slash).split('/').filter(Boolean);
  const basePattern = normalized.slice(slash + 1);
  const dir = path.join(projectDir, ...dirParts);
  if (!/[*?]/.test(basePattern)) {
    const candidate = path.join(dir, basePattern);
    return fs.existsSync(candidate) ? [candidate] : [];
  }
  const matcher = globToRegExp(basePattern);
  return safeReadDir(dir).filter(entry => matcher.test(entry.name)).map(entry => path.join(dir, entry.name));
}

function fileContains(filePath, needle) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_CONTAINS_BYTES) return false;
    return fs.readFileSync(filePath, 'utf8').toLowerCase().includes(String(needle).toLowerCase());
  } catch {
    return false;
  }
}

function matchIndicator(projectDir, indicator) {
  if (!indicator || typeof indicator.file !== 'string') return null;
  for (const file of findIndicatorFiles(projectDir, indicator.file)) {
    const rel = toPosix(path.relative(projectDir, file));
    if (indicator.contains === undefined) return rel;
    if (fileContains(file, indicator.contains)) return `${rel} contains '${indicator.contains}'`;
  }
  return null;
}

function detectStacks(projectDir, stacks) {
  const matched = [];
  for (const stack of stacks) {
    for (const indicator of stack.indicators || []) {
      const evidence = matchIndicator(projectDir, indicator);
      if (evidence) {
        matched.push({ stack, evidence });
        break;
      }
    }
  }
  return matched;
}

function buildMarkerMatchers(stacks) {
  const patterns = new Set(['.git']);
  for (const stack of stacks) {
    for (const indicator of stack.indicators || []) {
      if (indicator && typeof indicator.file === 'string' && !/[\\/]/.test(indicator.file)) patterns.add(indicator.file);
    }
  }
  return [...patterns].map(globToRegExp);
}

function resolveScanRoot(input, { allowDriveRoot = false } = {}) {
  if (!input) throw new Error('Missing folder. Example: node scripts/personal-setup.js scan ~/Projects');
  const resolved = path.resolve(expandHome(input));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Folder not found: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${resolved}`);
  if (!allowDriveRoot && path.parse(resolved).root === resolved) {
    throw new Error(`Refusing to scan a whole drive (${resolved}). Point at your projects folder, or pass --allow-drive-root.`);
  }
  return resolved;
}

/**
 * Breadth-first walk that stops descending at the first folder that looks
 * like a project (has .git or a stack indicator file at its root).
 */
function findProjects(rootDir, stacks, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN.maxDepth;
  const maxDirectories = options.maxDirectories ?? DEFAULT_SCAN.maxDirectories;
  const ignore = new Set((options.ignoreDirs || DEFAULT_SCAN.ignoreDirs).map(name => name.toLowerCase()));
  const markers = buildMarkerMatchers(stacks);
  const queue = [{ dir: rootDir, depth: 0 }];
  const projects = [];
  let visited = 0;
  let truncated = false;

  for (let index = 0; index < queue.length; index += 1) {
    if (visited >= maxDirectories) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue[index];
    visited += 1;
    const entries = safeReadDir(dir);
    if (entries.some(entry => markers.some(marker => marker.test(entry.name)))) {
      projects.push(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ignore.has(entry.name.toLowerCase())) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return { projects: projects.sort(), visited, truncated };
}

function stateTarget(projectDir) {
  return path.join(projectDir, '.claude');
}

function readState(targetRoot) {
  try {
    const state = readJson(path.join(targetRoot, STATE_FILE));
    return state && Array.isArray(state.managed) ? state : null;
  } catch {
    return null;
  }
}

function isSafeManagedPath(targetRoot, rel) {
  if (typeof rel !== 'string' || !MANAGED_PREFIXES.some(prefix => rel.startsWith(prefix))) return false;
  const resolved = path.resolve(targetRoot, ...rel.split('/'));
  return resolved.startsWith(path.resolve(targetRoot) + path.sep);
}

function planEntries(plan, library) {
  return ['skill', 'rule', 'agent'].flatMap(kind => plan[`${kind}s`].map(name => ({
    dest: LAYOUT[kind].dest(name),
    copyFrom: library.source(kind, name),
  })));
}

/**
 * "up to date" when every planned path exists (installed by this tool or
 * already present and left alone) and nothing stale is still managed.
 */
function planStatus(plan, state, targetRoot) {
  const planned = ['skill', 'rule', 'agent'].flatMap(kind => plan[`${kind}s`].map(name => LAYOUT[kind].dest(name)));
  if (!state) return planned.length === 0 ? 'nothing to install' : 'not installed';
  const plannedSet = new Set(planned);
  const present = planned.every(dest => fs.existsSync(path.resolve(targetRoot, ...dest.split('/'))));
  const noStale = state.managed.every(dest => plannedSet.has(dest));
  return present && noStale ? 'up to date' : 'changes pending';
}

function buildProjectPlan(projectDir, context, options = {}) {
  const { profile, stacks, library } = context;
  const detected = detectStacks(projectDir, stacks);
  const state = readState(stateTarget(projectDir));
  const extras = unique([...asList(state && state.extras), ...asList(options.extras)]);
  const wanted = { skill: [], rule: [], agent: [] };
  for (const { stack } of detected) {
    wanted.skill.push(...asList(stack.skills));
    wanted.rule.push(...asList(stack.rules));
    wanted.agent.push(...asList(stack.agents), ...asList(profile.stackAgents[stack.id]));
  }
  wanted.skill.push(...extras);

  const missing = [];
  const pick = (kind, globalNames) => unique(wanted[kind]).filter(name => {
    if (globalNames.includes(name)) return false;
    if (!library.has(kind, name)) {
      missing.push(`${kind}:${name}`);
      return false;
    }
    return true;
  });
  const skills = pick('skill', profile.global.skills);
  const rules = pick('rule', profile.global.rules);
  const agents = pick('agent', profile.global.agents);

  const plan = {
    name: path.basename(projectDir),
    project: projectDir,
    stacks: detected.map(({ stack, evidence }) => ({ id: stack.id, name: stack.name || stack.id, evidence })),
    skills,
    rules,
    agents,
    extras,
    missing: unique(missing),
  };
  plan.status = planStatus(plan, state, stateTarget(projectDir));
  return plan;
}

function removePath(targetRoot, rel) {
  fs.rmSync(path.resolve(targetRoot, ...rel.split('/')), { recursive: true, force: true });
}

/**
 * Copy entries into targetRoot. Paths that exist but were not installed by
 * this tool are skipped; previously managed paths that are no longer wanted
 * are removed. entries: [{ dest, copyFrom } | { dest, files: { name: content } }]
 */
function syncManagedItems(targetRoot, entries, options = {}) {
  const previous = readState(targetRoot);
  const previouslyManaged = new Set((previous ? previous.managed : []).filter(rel => isSafeManagedPath(targetRoot, rel)));
  const result = { added: [], refreshed: [], skipped: [], removed: [], managed: [] };

  for (const entry of entries) {
    if (!isSafeManagedPath(targetRoot, entry.dest)) throw new Error(`Unsafe install path: ${entry.dest}`);
    const destAbs = path.resolve(targetRoot, ...entry.dest.split('/'));
    const wasManaged = previouslyManaged.has(entry.dest);
    if (fs.existsSync(destAbs) && !wasManaged) {
      result.skipped.push(entry.dest);
      continue;
    }
    result.managed.push(entry.dest);
    (wasManaged ? result.refreshed : result.added).push(entry.dest);
    if (options.dryRun) continue;
    fs.rmSync(destAbs, { recursive: true, force: true });
    if (entry.copyFrom) {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.cpSync(entry.copyFrom, destAbs, { recursive: true });
    } else {
      fs.mkdirSync(destAbs, { recursive: true });
      for (const [name, content] of Object.entries(entry.files || {})) {
        fs.writeFileSync(path.join(destAbs, name), content);
      }
    }
  }

  const keep = new Set(result.managed);
  for (const rel of previouslyManaged) {
    if (keep.has(rel)) continue;
    result.removed.push(rel);
    if (!options.dryRun) removePath(targetRoot, rel);
  }

  if (!options.dryRun) {
    fs.mkdirSync(targetRoot, { recursive: true });
    const state = { version: STATE_VERSION, tool: 'ecc-personal', updatedAt: new Date().toISOString(), ...options.state, managed: result.managed };
    fs.writeFileSync(path.join(targetRoot, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  }
  return result;
}

function removeManagedInstall(targetRoot, options = {}) {
  const previous = readState(targetRoot);
  if (!previous) return { found: false, removed: [] };
  const removed = previous.managed.filter(rel => isSafeManagedPath(targetRoot, rel));
  if (!options.dryRun) {
    for (const rel of removed) removePath(targetRoot, rel);
    fs.rmSync(path.join(targetRoot, STATE_FILE), { force: true });
    pruneEmptyContainers(targetRoot);
  }
  return { found: true, removed };
}

function pruneEmptyContainers(targetRoot) {
  for (const rel of ['skills', 'agents', 'commands', path.join('rules', 'ecc'), 'rules']) {
    const dir = path.join(targetRoot, rel);
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // Missing or not empty: leave it alone.
    }
  }
}

function buildGlobalEntries(context, routerFiles) {
  const { profile, library } = context;
  const entries = [];
  const missing = [];
  for (const [kind, names] of [['skill', profile.global.skills], ['agent', profile.global.agents], ['command', profile.global.commands], ['rule', profile.global.rules]]) {
    for (const name of names) {
      if (!library.has(kind, name)) {
        missing.push(`${kind}:${name}`);
        continue;
      }
      entries.push({ dest: LAYOUT[kind].dest(name), copyFrom: library.source(kind, name) });
    }
  }
  if (routerFiles) entries.push({ dest: 'skills/skill-library', files: routerFiles });
  return { entries, missing };
}

/**
 * Report profile and stack-mapping names that do not exist in the library
 * (for example after an upstream rename).
 */
function validateContext(context) {
  const { profile, stacks, library } = context;
  const missing = [];
  const check = (kind, names, where) => {
    for (const name of names) {
      if (!library.has(kind, name)) missing.push(`${where}: ${kind} "${name}" not found`);
    }
  };
  check('skill', profile.global.skills, 'global');
  check('agent', profile.global.agents, 'global');
  check('command', profile.global.commands, 'global');
  check('rule', profile.global.rules, 'global');
  for (const [stackId, agents] of Object.entries(profile.stackAgents)) check('agent', asList(agents), `stackAgents.${stackId}`);
  for (const stack of stacks) {
    check('skill', asList(stack.skills), `stack ${stack.id}`);
    check('rule', asList(stack.rules), `stack ${stack.id}`);
    check('agent', asList(stack.agents), `stack ${stack.id}`);
  }
  return missing;
}

function resolveClaudeHome(explicit) {
  if (explicit) return path.resolve(expandHome(explicit));
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(expandHome(process.env.CLAUDE_CONFIG_DIR));
  return path.join(os.homedir(), '.claude');
}

module.exports = {
  STATE_FILE,
  buildGlobalEntries,
  buildProjectPlan,
  createLibrary,
  detectStacks,
  expandHome,
  findProjects,
  loadContext,
  mergeStacks,
  normalizeProfile,
  planEntries,
  readState,
  removeManagedInstall,
  resolveClaudeHome,
  resolveScanRoot,
  stateTarget,
  syncManagedItems,
  validateContext,
};

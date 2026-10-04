'use strict';

/**
 * Personal ECC setup helpers.
 *
 * Detects project stacks from indicator files, plans a lean per-project
 * surface (skills, rules, agents), and copies only the planned items into the
 * folders each selected tool reads:
 *
 *   Claude Code  .claude/   (skills, rules, agents, commands)
 *   Codex        .agents/   (skills; OpenCode reads this folder too)
 *   OpenCode     .opencode/ (skills, only when neither of the above is selected,
 *                            because OpenCode also reads .claude/ and .agents/)
 *
 * Every copied path is recorded in a state file inside each folder so a re-run
 * can refresh or remove exactly what this tool installed, and nothing the user
 * created by hand is ever overwritten.
 *
 * Used by scripts/personal-setup.js. See docs/PERSONAL-SETUP.md.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const instructionsLib = require('./personal-instructions');

const STATE_FILE = 'ecc-personal-state.json';
const STATE_VERSION = 1;
const MAX_CONTAINS_BYTES = 1024 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const MANAGED_PREFIXES = ['skills/', 'rules/ecc/', 'agents/', 'commands/'];
const TOOLS = ['claude', 'codex', 'opencode'];
const TOOL_ROOTS = { claude: 'claude', codex: 'agents', opencode: 'opencode' };
const PROJECT_DIRS = { claude: '.claude', agents: '.agents', opencode: '.opencode' };
// Frontmatter keys defined by the Agent Skills format that Codex and OpenCode validate.
const PORTABLE_SKILL_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

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

function normalizeTools(value) {
  const tools = asList(value).filter(tool => TOOLS.includes(tool));
  return tools.length > 0 ? unique(tools) : [...TOOLS];
}

function parseTools(value) {
  const requested = String(value || '').split(',').map(tool => tool.trim()).filter(Boolean);
  const unknown = requested.filter(tool => !TOOLS.includes(tool));
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(`--tools must list one or more of ${TOOLS.join(', ')}${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}`);
  }
  return unique(requested);
}

function normalizeProfile(raw) {
  const global = raw.global || {};
  const scan = raw.scan || {};
  const project = raw.project || {};
  return {
    tools: normalizeTools(raw.tools),
    sharedInstructions: project.sharedInstructions !== false,
    global: {
      skills: asList(global.skills),
      agents: asList(global.agents),
      commands: asList(global.commands),
      rules: asList(global.rules),
    },
    stackAgents: project.stackAgents || {},
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
  const profileDir = path.dirname(profilePath);
  const instructions = raw.instructions || {};
  return {
    profile,
    stacks: mergeStacks(upstream, personal),
    library: createLibrary(libraryRoot),
    instructions: {
      shared: typeof instructions.shared === 'string' ? path.resolve(profileDir, instructions.shared) : null,
      private: typeof instructions.private === 'string' ? path.resolve(profileDir, instructions.private) : null,
    },
  };
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
 * like a project (has .git or a stack indicator file at its root). Folders in
 * options.exclude (such as the ECC library itself) are never reported.
 */
function findProjects(rootDir, stacks, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN.maxDepth;
  const maxDirectories = options.maxDirectories ?? DEFAULT_SCAN.maxDirectories;
  const ignore = new Set((options.ignoreDirs || DEFAULT_SCAN.ignoreDirs).map(name => name.toLowerCase()));
  const excluded = (options.exclude || []).map(dir => path.resolve(dir));
  const isExcluded = dir => excluded.some(item => dir === item || dir.startsWith(item + path.sep));
  const markers = buildMarkerMatchers(stacks);
  const queue = [{ dir: rootDir, depth: 0 }];
  const projects = [];
  const skipped = [];
  let visited = 0;
  let truncated = false;

  for (let index = 0; index < queue.length; index += 1) {
    if (visited >= maxDirectories) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue[index];
    if (isExcluded(path.resolve(dir))) {
      skipped.push(dir);
      continue;
    }
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
  return { projects: projects.sort(), skipped, visited, truncated };
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

/**
 * Keep only the frontmatter keys Codex and OpenCode accept, so a skill copied
 * into .agents/ or .opencode/ is not rejected for an ECC-specific key.
 */
function sanitizeSkillFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return content;
  const kept = [];
  let keep = true;
  for (const line of match[1].split(/\r?\n/)) {
    const key = line.match(/^([A-Za-z0-9_-]+):/);
    if (key) keep = PORTABLE_SKILL_KEYS.has(key[1]);
    if (keep) kept.push(line);
  }
  return `---\n${kept.join('\n')}\n---${match[2]}${content.slice(match[0].length)}`;
}

/**
 * Which tool folders receive skills. OpenCode reads .claude/ and .agents/
 * itself, so it gets its own folder only when it is the only tool selected.
 */
function skillRootKeys(tools) {
  const keys = [];
  if (tools.includes('claude')) keys.push('claude');
  if (tools.includes('codex')) keys.push('agents');
  if (tools.includes('opencode') && keys.length === 0) keys.push('opencode');
  return keys;
}

function portableSkillEntries(names, library) {
  return names.map(name => ({ dest: LAYOUT.skill.dest(name), copyFrom: library.source('skill', name), portable: true }));
}

function projectTargets(plan, library, tools) {
  return skillRootKeys(tools).map(key => ({
    key,
    dir: path.join(plan.project, PROJECT_DIRS[key]),
    entries: key === 'claude'
      ? ['skill', 'rule', 'agent'].flatMap(kind => plan[`${kind}s`].map(name => ({
        dest: LAYOUT[kind].dest(name),
        copyFrom: library.source(kind, name),
      })))
      : portableSkillEntries(plan.skills, library),
  }));
}

/**
 * "up to date" when, in every selected tool folder, each planned path exists
 * (installed by this tool or already present and left alone) and nothing
 * stale is still managed.
 */
function planStatus(targets) {
  const expected = targets.reduce((total, target) => total + target.entries.length, 0);
  const states = targets.map(target => readState(target.dir));
  if (states.every(state => !state)) return expected === 0 ? 'nothing to install' : 'not installed';
  const current = targets.every((target, index) => {
    const state = states[index];
    if (!state) return target.entries.length === 0;
    const planned = new Set(target.entries.map(entry => entry.dest));
    return target.entries.every(entry => fs.existsSync(path.resolve(target.dir, ...entry.dest.split('/'))))
      && state.managed.every(dest => planned.has(dest));
  });
  return current ? 'up to date' : 'changes pending';
}

function buildProjectPlan(projectDir, context, options = {}) {
  const { profile, stacks, library } = context;
  const tools = options.tools || profile.tools;
  const detected = detectStacks(projectDir, stacks);
  const savedExtras = Object.values(PROJECT_DIRS).flatMap(dir => asList((readState(path.join(projectDir, dir)) || {}).extras));
  const extras = unique([...savedExtras, ...asList(options.extras)]);
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
    tools,
    stacks: detected.map(({ stack, evidence }) => ({ id: stack.id, name: stack.name || stack.id, evidence, commands: stack.commands || {} })),
    skills,
    rules,
    agents,
    extras,
    missing: unique(missing),
  };
  plan.status = planStatus(projectTargets(plan, library, tools));
  return plan;
}

function removePath(targetRoot, rel) {
  fs.rmSync(path.resolve(targetRoot, ...rel.split('/')), { recursive: true, force: true });
}

function emptyResult(removed = []) {
  return { added: [], refreshed: [], skipped: [], removed, managed: [] };
}

/**
 * Copy entries into targetRoot. Paths that exist but were not installed by
 * this tool are skipped; previously managed paths that are no longer wanted
 * are removed. entries: [{ dest, copyFrom, portable? } | { dest, files: { name: content } }]
 */
function syncManagedItems(targetRoot, entries, options = {}) {
  const previous = readState(targetRoot);
  const previouslyManaged = new Set((previous ? previous.managed : []).filter(rel => isSafeManagedPath(targetRoot, rel)));
  const result = emptyResult();

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
      const skillFile = path.join(destAbs, 'SKILL.md');
      if (entry.portable && fs.existsSync(skillFile)) {
        fs.writeFileSync(skillFile, sanitizeSkillFrontmatter(fs.readFileSync(skillFile, 'utf8')));
      }
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
    pruneEmptyContainers(targetRoot, options.pruneRoot);
  }
  return { found: true, removed };
}

function pruneEmptyContainers(targetRoot, pruneRoot = false) {
  const dirs = ['skills', 'agents', 'commands', path.join('rules', 'ecc'), 'rules'];
  for (const rel of pruneRoot ? [...dirs, ''] : dirs) {
    const dir = path.join(targetRoot, rel);
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // Missing or not empty: leave it alone.
    }
  }
}

/**
 * Bring one project in line with its plan for the selected tools: sync each
 * tool folder, clean folders a selected tool no longer needs, and refresh the
 * shared AGENTS.md / CLAUDE.md instructions.
 */
function applyProjectPlan(plan, context, options = {}) {
  const tools = options.tools || plan.tools || context.profile.tools;
  const dryRun = Boolean(options.dryRun);
  const targets = new Map(projectTargets(plan, context.library, tools).map(target => [target.key, target]));
  const roots = {};
  for (const key of unique(tools.map(tool => TOOL_ROOTS[tool]))) {
    const dir = path.join(plan.project, PROJECT_DIRS[key]);
    const target = targets.get(key);
    if (target && target.entries.length > 0) {
      const state = { library: context.library.root, stacks: plan.stacks.map(stack => stack.id), extras: plan.extras };
      roots[key] = syncManagedItems(dir, target.entries, { dryRun, state });
    } else if (readState(dir)) {
      roots[key] = emptyResult(removeManagedInstall(dir, { dryRun, pruneRoot: true }).removed);
    }
  }
  let instructions = null;
  if (options.instructions !== false && context.profile.sharedInstructions) {
    const hasWork = plan.stacks.length > 0 || plan.extras.length > 0;
    instructions = hasWork
      ? instructionsLib.syncProjectInstructions(plan, { tools, dryRun })
      : instructionsLib.removeProjectInstructions(plan.project, { dryRun });
  }
  return { roots, instructions };
}

function removeProject(projectDir, options = {}) {
  const tools = options.tools || TOOLS;
  const dryRun = Boolean(options.dryRun);
  const roots = {};
  const keys = options.tools ? unique(tools.map(tool => TOOL_ROOTS[tool])) : Object.keys(PROJECT_DIRS);
  for (const key of keys) {
    const result = removeManagedInstall(path.join(projectDir, PROJECT_DIRS[key]), { dryRun, pruneRoot: true });
    if (result.found) roots[key] = result.removed;
  }
  const instructions = tools.includes('claude') || !options.tools
    ? instructionsLib.removeProjectInstructions(projectDir, { dryRun, includeAgents: !options.tools })
    : {};
  return { roots, instructions };
}

/**
 * Folders each tool reads at user level. With --home, every tool is placed
 * under that folder (useful for testing); otherwise the tools' own
 * environment variables are honoured.
 */
function resolveToolHomes(home, env = process.env) {
  const fromEnv = name => (env[name] ? path.resolve(expandHome(env[name])) : null);
  if (home) {
    const base = path.resolve(expandHome(home));
    return { claude: path.join(base, '.claude'), agents: path.join(base, '.agents'), codex: path.join(base, '.codex'), opencode: path.join(base, '.config', 'opencode') };
  }
  const base = os.homedir();
  const xdg = fromEnv('XDG_CONFIG_HOME');
  return {
    claude: fromEnv('CLAUDE_CONFIG_DIR') || path.join(base, '.claude'),
    agents: path.join(base, '.agents'),
    codex: fromEnv('CODEX_HOME') || path.join(base, '.codex'),
    opencode: fromEnv('OPENCODE_CONFIG_DIR') || (xdg ? path.join(xdg, 'opencode') : path.join(base, '.config', 'opencode')),
  };
}

function buildGlobalEntries(context, routerFiles, rootKey = 'claude') {
  const { profile, library } = context;
  const entries = [];
  const missing = [];
  const kinds = rootKey === 'claude'
    ? [['skill', profile.global.skills], ['agent', profile.global.agents], ['command', profile.global.commands], ['rule', profile.global.rules]]
    : [['skill', profile.global.skills]];
  for (const [kind, names] of kinds) {
    for (const name of names) {
      if (!library.has(kind, name)) {
        missing.push(`${kind}:${name}`);
        continue;
      }
      entries.push({ dest: LAYOUT[kind].dest(name), copyFrom: library.source(kind, name), portable: rootKey !== 'claude' });
    }
  }
  if (routerFiles) entries.push({ dest: 'skills/skill-library', files: routerFiles });
  return { entries, missing };
}

/**
 * Install the global core and router into every selected tool's user folder,
 * and the shared instructions into each tool's global instruction file.
 */
function applyGlobal(context, options = {}) {
  const tools = options.tools || context.profile.tools;
  const homes = options.homes || resolveToolHomes();
  const dryRun = Boolean(options.dryRun);
  const wanted = new Set(skillRootKeys(tools));
  const roots = {};
  let missing = [];
  for (const key of unique(tools.map(tool => TOOL_ROOTS[tool]))) {
    if (wanted.has(key)) {
      const built = buildGlobalEntries(context, options.routerFiles, key);
      missing = unique([...missing, ...built.missing]);
      roots[key] = syncManagedItems(homes[key], built.entries, { dryRun, state: { library: context.library.root } });
    } else if (readState(homes[key])) {
      roots[key] = emptyResult(removeManagedInstall(homes[key], { dryRun }).removed);
    }
  }
  const instructions = instructionsLib.syncGlobalInstructions(homes, tools, context.instructions, { dryRun });
  return { homes, roots, instructions, missing };
}

function removeGlobal(options = {}) {
  const tools = options.tools || TOOLS;
  const homes = options.homes || resolveToolHomes();
  const dryRun = Boolean(options.dryRun);
  const roots = {};
  const keys = options.tools ? unique(tools.map(tool => TOOL_ROOTS[tool])) : ['claude', 'agents', 'opencode'];
  for (const key of keys) {
    const result = removeManagedInstall(homes[key], { dryRun });
    if (result.found) roots[key] = result.removed;
  }
  const instructions = instructionsLib.removeGlobalInstructions(homes, tools, { dryRun });
  return { homes, roots, instructions };
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
  const shared = context.instructions && context.instructions.shared;
  if (shared && !fs.existsSync(shared)) missing.push(`instructions: shared file "${shared}" not found`);
  return missing;
}

module.exports = {
  PROJECT_DIRS,
  STATE_FILE,
  TOOLS,
  applyGlobal,
  applyProjectPlan,
  buildGlobalEntries,
  buildProjectPlan,
  createLibrary,
  detectStacks,
  expandHome,
  findProjects,
  loadContext,
  mergeStacks,
  normalizeProfile,
  parseTools,
  projectTargets,
  readState,
  removeGlobal,
  removeManagedInstall,
  removeProject,
  resolveScanRoot,
  resolveToolHomes,
  sanitizeSkillFrontmatter,
  skillRootKeys,
  syncManagedItems,
  validateContext,
};

/**
 * Tests for scripts/lib/personal-setup.js
 *
 * Run with: node tests/lib/personal-setup.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const setup = require('../../scripts/lib/personal-setup');

const repoRoot = path.join(__dirname, '..', '..');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function writeFile(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function skillMd(name) {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`;
}

function makeLibrary(root) {
  writeFile(path.join(root, 'config', 'project-stack-mappings.json'), {
    stacks: [
      { id: 'python', name: 'Python', indicators: [{ file: 'pyproject.toml' }, { file: 'requirements.txt' }], rules: ['common', 'python'], skills: ['python-patterns', 'tdd-workflow'] },
      { id: 'fastapi', name: 'FastAPI', indicators: [{ file: 'pyproject.toml', contains: 'FastAPI' }], rules: ['python'], skills: ['fastapi-patterns', 'python-patterns'] },
      { id: 'swift', name: 'Swift', indicators: [{ file: '*.xcodeproj' }], rules: ['swift'], skills: ['swift-patterns'] },
      { id: 'docker', name: 'Docker', indicators: [{ file: 'Dockerfile' }], rules: [], skills: ['docker-patterns', 'ghost-skill'] },
    ],
  });
  for (const name of ['python-patterns', 'tdd-workflow', 'fastapi-patterns', 'docker-patterns', 'swift-patterns', 'extra-skill']) {
    writeFile(path.join(root, 'skills', name, 'SKILL.md'), skillMd(name));
  }
  writeFile(path.join(root, 'skills', 'python-patterns', 'references', 'notes.md'), 'nested file');
  for (const name of ['common', 'python', 'swift']) writeFile(path.join(root, 'rules', name, 'coding-style.md'), `# ${name}`);
  for (const name of ['python-reviewer', 'planner']) writeFile(path.join(root, 'agents', `${name}.md`), `# ${name}`);
  writeFile(path.join(root, 'commands', 'plan.md'), '# plan');
  writeFile(path.join(root, 'my-ecc', 'profile.json'), {
    version: 1,
    tools: ['claude'],
    instructions: { shared: 'AGENTS.md', private: 'private/AGENTS.md' },
    stackMappings: 'stack-mappings.json',
    global: { skills: ['tdd-workflow'], agents: ['planner'], commands: ['plan'], rules: ['common'] },
    project: { stackAgents: { python: ['python-reviewer'] } },
    scan: { maxDepth: 3, maxDirectories: 1000, ignoreDirs: ['node_modules'] },
  });
  writeFile(path.join(root, 'my-ecc', 'AGENTS.md'), '<!-- maintainer note -->\n\n# Shared\n\n- Be concise.\n');
  writeFile(path.join(root, 'skills', 'odd-skill', 'SKILL.md'), '---\nname: odd-skill\ndescription: Odd one\norigin: ECC\ntags:\n  - a\n  - b\nmetadata:\n  version: 1\n---\n\n# Odd\n');
  writeFile(path.join(root, 'my-ecc', 'stack-mappings.json'), {
    stacks: [
      { id: 'prisma', name: 'Prisma', indicators: [{ file: 'prisma/schema.prisma' }], rules: [], skills: ['extra-skill'], agents: ['python-reviewer'] },
      { id: 'docker', name: 'Docker', indicators: [{ file: 'Dockerfile' }], rules: [], skills: ['docker-patterns'] },
    ],
  });
  return setup.loadContext({ libraryRoot: root, profilePath: path.join(root, 'my-ecc', 'profile.json') });
}

function runTests() {
  console.log('\n=== Testing personal-setup ===\n');

  let passed = 0;
  let failed = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-setup-test-'));
  const claudeDir = dir => path.join(dir, '.claude');
  const claudeEntries = plan => setup.projectTargets(plan, context.library, ['claude'])[0].entries;
  const libRoot = path.join(tmp, 'lib');
  const context = makeLibrary(libRoot);
  let projectCounter = 0;
  const newProject = (files = {}) => {
    projectCounter += 1;
    const dir = path.join(tmp, 'projects', `p${projectCounter}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
    return dir;
  };

  const tests = [
    ['loadContext merges personal stacks and lets them replace upstream ids', () => {
      const ids = context.stacks.map(stack => stack.id);
      assert.deepStrictEqual(ids, ['python', 'fastapi', 'swift', 'docker', 'prisma']);
      assert.deepStrictEqual(context.stacks.find(stack => stack.id === 'docker').skills, ['docker-patterns']);
    }],
    ['loadContext works without a stackMappings entry', () => {
      const profilePath = path.join(tmp, 'bare-profile.json');
      writeFile(profilePath, { global: {} });
      const bare = setup.loadContext({ libraryRoot: libRoot, profilePath });
      assert.strictEqual(bare.stacks.length, 4);
    }],
    ['mergeStacks ignores entries without an id', () => {
      const merged = setup.mergeStacks([{ id: 'a' }, null], [{ name: 'no id' }, { id: 'a', skills: ['x'] }]);
      assert.deepStrictEqual(merged, [{ id: 'a', skills: ['x'] }]);
    }],
    ['normalizeProfile fills defaults and rejects invalid scan values', () => {
      const profile = setup.normalizeProfile({ global: { skills: ['a', 3] }, scan: { maxDepth: -1, maxDirectories: 0 } });
      assert.deepStrictEqual(profile.global, { skills: ['a'], agents: [], commands: [], rules: [] });
      assert.deepStrictEqual(profile.tools, ['claude', 'codex', 'opencode']);
      assert.strictEqual(profile.sharedInstructions, true);
      assert.deepStrictEqual(setup.normalizeProfile({ tools: ['codex', 'nope', 'codex'], project: { sharedInstructions: false } }).tools, ['codex']);
      assert.strictEqual(setup.normalizeProfile({ project: { sharedInstructions: false } }).sharedInstructions, false);
      assert.strictEqual(profile.scan.maxDepth, 3);
      assert.strictEqual(profile.scan.maxDirectories, 20000);
      assert.ok(profile.scan.ignoreDirs.includes('node_modules'));
      assert.deepStrictEqual(profile.stackAgents, {});
    }],
    ['detectStacks matches plain files, case-insensitive contains, globs, and sub-paths', () => {
      const dir = newProject({
        'pyproject.toml': '[project]\ndependencies = ["fastapi"]\n',
        'App.xcodeproj/project.pbxproj': '',
        'prisma/schema.prisma': '',
      });
      const found = setup.detectStacks(dir, context.stacks).map(({ stack, evidence }) => `${stack.id}=${evidence}`);
      assert.deepStrictEqual(found, [
        'python=pyproject.toml',
        "fastapi=pyproject.toml contains 'FastAPI'",
        'swift=App.xcodeproj',
        'prisma=prisma/schema.prisma',
      ]);
    }],
    ['detectStacks returns nothing for an empty folder and ignores bad indicators', () => {
      const dir = newProject({ 'notes.txt': 'hello' });
      assert.deepStrictEqual(setup.detectStacks(dir, context.stacks), []);
      assert.deepStrictEqual(setup.detectStacks(dir, [{ id: 'bad', indicators: [null, { contains: 'x' }] }]), []);
    }],
    ['findProjects stops at project roots and skips ignored, hidden, and deep folders', () => {
      const root = path.join(tmp, 'walk');
      writeFile(path.join(root, 'a', 'pyproject.toml'));
      writeFile(path.join(root, 'a', 'sub', 'requirements.txt'));
      fs.mkdirSync(path.join(root, 'group', 'b', '.git'), { recursive: true });
      writeFile(path.join(root, 'node_modules', 'c', 'pyproject.toml'));
      writeFile(path.join(root, '.hidden', 'd', 'pyproject.toml'));
      writeFile(path.join(root, 'deep', 'l1', 'l2', 'l3', 'pyproject.toml'));
      writeFile(path.join(root, 'notes', 'readme.txt'));
      const shallow = setup.findProjects(root, context.stacks, { maxDepth: 3, ignoreDirs: ['node_modules'] });
      assert.deepStrictEqual(shallow.projects, [path.join(root, 'a'), path.join(root, 'group', 'b')]);
      assert.strictEqual(shallow.truncated, false);
      const deep = setup.findProjects(root, context.stacks, { maxDepth: 4, ignoreDirs: ['NODE_MODULES'] });
      assert.ok(deep.projects.includes(path.join(root, 'deep', 'l1', 'l2', 'l3')));
      assert.ok(!deep.projects.some(project => project.includes('node_modules')));
    }],
    ['findProjects never reports excluded folders such as the library itself', () => {
      const root = path.join(tmp, 'walk');
      const result = setup.findProjects(root, context.stacks, { maxDepth: 3, ignoreDirs: ['node_modules'], exclude: [path.join(root, 'group')] });
      assert.deepStrictEqual(result.projects, [path.join(root, 'a')]);
      assert.deepStrictEqual(result.skipped, [path.join(root, 'group')]);
      assert.deepStrictEqual(setup.findProjects(path.join(root, 'a'), context.stacks, { exclude: [root] }).projects, []);
    }],
    ['findProjects reports truncation and treats a project root as a single project', () => {
      const root = path.join(tmp, 'walk');
      const limited = setup.findProjects(root, context.stacks, { maxDirectories: 2 });
      assert.strictEqual(limited.truncated, true);
      assert.strictEqual(limited.visited, 2);
      const single = setup.findProjects(path.join(root, 'a'), context.stacks);
      assert.deepStrictEqual(single.projects, [path.join(root, 'a')]);
    }],
    ['resolveScanRoot validates the folder and refuses a whole drive', () => {
      assert.throws(() => setup.resolveScanRoot(''), /Missing folder/);
      assert.throws(() => setup.resolveScanRoot(path.join(tmp, 'nope')), /Folder not found/);
      writeFile(path.join(tmp, 'a-file.txt'), 'x');
      assert.throws(() => setup.resolveScanRoot(path.join(tmp, 'a-file.txt')), /Not a folder/);
      const driveRoot = path.parse(path.resolve(tmp)).root;
      assert.throws(() => setup.resolveScanRoot(driveRoot), /Refusing to scan a whole drive/);
      assert.strictEqual(setup.resolveScanRoot(driveRoot, { allowDriveRoot: true }), driveRoot);
      assert.strictEqual(setup.resolveScanRoot('~'), os.homedir());
    }],
    ['expandHome handles ~, ~/ and plain paths', () => {
      assert.strictEqual(setup.expandHome('~'), os.homedir());
      assert.strictEqual(setup.expandHome('~/x'), path.join(os.homedir(), 'x'));
      assert.strictEqual(setup.expandHome('/abs/path'), '/abs/path');
    }],
    ['buildProjectPlan unions stack items, drops global ones, and adds stack agents', () => {
      const dir = newProject({ 'pyproject.toml': 'fastapi', Dockerfile: 'FROM python' });
      const plan = setup.buildProjectPlan(dir, context);
      assert.deepStrictEqual(plan.stacks.map(stack => stack.id), ['python', 'fastapi', 'docker']);
      assert.deepStrictEqual(plan.skills, ['python-patterns', 'fastapi-patterns', 'docker-patterns']);
      assert.deepStrictEqual(plan.rules, ['python']);
      assert.deepStrictEqual(plan.agents, ['python-reviewer']);
      assert.deepStrictEqual(plan.missing, []);
      assert.strictEqual(plan.status, 'not installed');
    }],
    ['buildProjectPlan reports missing names and keeps valid extras', () => {
      const dir = newProject({ Dockerfile: '' });
      const ghostContext = { ...context, stacks: [{ id: 'x', indicators: [{ file: 'Dockerfile' }], skills: ['ghost'], rules: ['nope'] }] };
      const plan = setup.buildProjectPlan(dir, ghostContext, { extras: ['extra-skill', 'missing-extra'] });
      assert.deepStrictEqual(plan.skills, ['extra-skill']);
      assert.deepStrictEqual(plan.missing, ['skill:ghost', 'skill:missing-extra', 'rule:nope']);
      assert.deepStrictEqual(plan.extras, ['extra-skill', 'missing-extra']);
    }],
    ['buildProjectPlan marks a project with no stacks as nothing to install', () => {
      const dir = newProject({ 'readme.txt': '' });
      assert.strictEqual(setup.buildProjectPlan(dir, context).status, 'nothing to install');
    }],
    ['syncManagedItems installs the plan, records state, and reports up to date', () => {
      const dir = newProject({ 'pyproject.toml': '', Dockerfile: '' });
      const plan = setup.buildProjectPlan(dir, context);
      const target = claudeDir(dir);
      const result = setup.syncManagedItems(target, claudeEntries(plan), { state: { stacks: ['python'] } });
      assert.deepStrictEqual(result.added, ['skills/python-patterns', 'skills/docker-patterns', 'rules/ecc/python', 'agents/python-reviewer.md']);
      assert.ok(fs.existsSync(path.join(target, 'skills', 'python-patterns', 'references', 'notes.md')));
      assert.ok(fs.existsSync(path.join(target, 'rules', 'ecc', 'python', 'coding-style.md')));
      const state = setup.readState(target);
      assert.deepStrictEqual(state.stacks, ['python']);
      assert.strictEqual(state.tool, 'ecc-personal');
      assert.strictEqual(setup.buildProjectPlan(dir, context).status, 'up to date');
    }],
    ['syncManagedItems never overwrites files it did not install', () => {
      const dir = newProject({ 'pyproject.toml': 'fastapi', '.claude/skills/fastapi-patterns/SKILL.md': 'mine' });
      const plan = setup.buildProjectPlan(dir, context);
      const target = claudeDir(dir);
      const result = setup.syncManagedItems(target, claudeEntries(plan));
      assert.deepStrictEqual(result.skipped, ['skills/fastapi-patterns']);
      assert.strictEqual(fs.readFileSync(path.join(target, 'skills', 'fastapi-patterns', 'SKILL.md'), 'utf8'), 'mine');
      assert.strictEqual(setup.buildProjectPlan(dir, context).status, 'up to date');
    }],
    ['syncManagedItems refreshes current items and removes stale ones on re-run', () => {
      const dir = newProject({ 'pyproject.toml': '', Dockerfile: '' });
      const target = claudeDir(dir);
      setup.syncManagedItems(target, claudeEntries(setup.buildProjectPlan(dir, context)));
      fs.rmSync(path.join(dir, 'Dockerfile'));
      assert.strictEqual(setup.buildProjectPlan(dir, context).status, 'changes pending');
      const result = setup.syncManagedItems(target, claudeEntries(setup.buildProjectPlan(dir, context)));
      assert.deepStrictEqual(result.removed, ['skills/docker-patterns']);
      assert.ok(result.refreshed.includes('skills/python-patterns'));
      assert.ok(!fs.existsSync(path.join(target, 'skills', 'docker-patterns')));
    }],
    ['syncManagedItems dry run writes nothing', () => {
      const dir = newProject({ 'pyproject.toml': '' });
      const target = claudeDir(dir);
      const result = setup.syncManagedItems(target, claudeEntries(setup.buildProjectPlan(dir, context)), { dryRun: true });
      assert.ok(result.added.length > 0);
      assert.ok(!fs.existsSync(target));
    }],
    ['syncManagedItems writes generated files and rejects unsafe destinations', () => {
      const target = path.join(tmp, 'generated-home');
      setup.syncManagedItems(target, [{ dest: 'skills/router', files: { 'SKILL.md': 'router' } }]);
      assert.strictEqual(fs.readFileSync(path.join(target, 'skills', 'router', 'SKILL.md'), 'utf8'), 'router');
      assert.throws(() => setup.syncManagedItems(target, [{ dest: '../evil', files: {} }]), /Unsafe install path/);
      assert.throws(() => setup.syncManagedItems(target, [{ dest: 'skills/../../evil', files: {} }]), /Unsafe install path/);
    }],
    ['tampered state entries outside the target are ignored, never deleted', () => {
      const target = path.join(tmp, 'tampered', '.claude');
      const outside = path.join(tmp, 'tampered', 'keep.txt');
      writeFile(outside, 'keep');
      writeFile(path.join(target, 'skills', 'ok', 'SKILL.md'), 'ok');
      writeFile(path.join(target, setup.STATE_FILE), { managed: ['skills/../../keep.txt', '../keep.txt', 'skills/ok', 42] });
      const result = setup.syncManagedItems(target, []);
      assert.deepStrictEqual(result.removed, ['skills/ok']);
      assert.ok(fs.existsSync(outside));
    }],
    ['removeManagedInstall removes managed items, the state file, and empty folders', () => {
      const dir = newProject({ 'pyproject.toml': '', '.claude/skills/own/SKILL.md': 'own' });
      const target = claudeDir(dir);
      setup.syncManagedItems(target, claudeEntries(setup.buildProjectPlan(dir, context)));
      const dry = setup.removeManagedInstall(target, { dryRun: true });
      assert.ok(dry.removed.length > 0);
      assert.ok(fs.existsSync(path.join(target, setup.STATE_FILE)));
      const result = setup.removeManagedInstall(target);
      assert.strictEqual(result.found, true);
      assert.ok(!fs.existsSync(path.join(target, setup.STATE_FILE)));
      assert.ok(!fs.existsSync(path.join(target, 'agents')));
      assert.ok(!fs.existsSync(path.join(target, 'rules')));
      assert.ok(fs.existsSync(path.join(target, 'skills', 'own', 'SKILL.md')));
      assert.deepStrictEqual(setup.removeManagedInstall(target), { found: false, removed: [] });
    }],
    ['readState returns null for missing or malformed state', () => {
      const target = path.join(tmp, 'bad-state');
      assert.strictEqual(setup.readState(target), null);
      writeFile(path.join(target, setup.STATE_FILE), '{not json');
      assert.strictEqual(setup.readState(target), null);
      writeFile(path.join(target, setup.STATE_FILE), { managed: 'nope' });
      assert.strictEqual(setup.readState(target), null);
    }],
    ['buildGlobalEntries lists the global core plus the router and reports missing names', () => {
      const { entries, missing } = setup.buildGlobalEntries(context, { 'SKILL.md': 'router' });
      assert.deepStrictEqual(entries.map(entry => entry.dest), ['skills/tdd-workflow', 'agents/planner.md', 'commands/plan.md', 'rules/ecc/common', 'skills/skill-library']);
      assert.deepStrictEqual(missing, []);
      const portable = setup.buildGlobalEntries(context, null, 'agents');
      assert.deepStrictEqual(portable.entries.map(entry => [entry.dest, entry.portable]), [['skills/tdd-workflow', true]]);
      const broken = { ...context, profile: setup.normalizeProfile({ global: { skills: ['nope'], commands: ['../x'] } }) };
      const result = setup.buildGlobalEntries(broken);
      assert.deepStrictEqual(result.entries, []);
      assert.deepStrictEqual(result.missing, ['skill:nope', 'command:../x']);
    }],
    ['validateContext reports names that do not exist in the library', () => {
      assert.deepStrictEqual(setup.validateContext(context), []);
      const problems = setup.validateContext({
        ...context,
        stacks: [...context.stacks, { id: 'bad', skills: ['ghost'], rules: ['nope'], agents: ['who'] }],
        profile: { ...context.profile, stackAgents: { python: ['missing-agent'] } },
      });
      assert.deepStrictEqual(problems, [
        'stackAgents.python: agent "missing-agent" not found',
        'stack bad: skill "ghost" not found',
        'stack bad: rule "nope" not found',
        'stack bad: agent "who" not found',
      ]);
    }],
    ['resolveToolHomes uses --home for every tool, else each tool\'s environment variable', () => {
      const base = path.join(tmp, 'h');
      assert.deepStrictEqual(setup.resolveToolHomes(base), {
        claude: path.join(base, '.claude'),
        agents: path.join(base, '.agents'),
        codex: path.join(base, '.codex'),
        opencode: path.join(base, '.config', 'opencode'),
      });
      const fromEnv = setup.resolveToolHomes(undefined, {
        CLAUDE_CONFIG_DIR: path.join(tmp, 'c'),
        CODEX_HOME: path.join(tmp, 'x'),
        XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
      });
      assert.strictEqual(fromEnv.claude, path.join(tmp, 'c'));
      assert.strictEqual(fromEnv.codex, path.join(tmp, 'x'));
      assert.strictEqual(fromEnv.opencode, path.join(tmp, 'xdg', 'opencode'));
      assert.strictEqual(fromEnv.agents, path.join(os.homedir(), '.agents'));
      assert.strictEqual(setup.resolveToolHomes(undefined, { OPENCODE_CONFIG_DIR: path.join(tmp, 'oc'), XDG_CONFIG_HOME: path.join(tmp, 'xdg') }).opencode, path.join(tmp, 'oc'));
      const defaults = setup.resolveToolHomes(undefined, {});
      assert.strictEqual(defaults.claude, path.join(os.homedir(), '.claude'));
      assert.strictEqual(defaults.opencode, path.join(os.homedir(), '.config', 'opencode'));
    }],
    ['parseTools accepts known tools and rejects unknown or empty lists', () => {
      assert.deepStrictEqual(setup.parseTools('codex, claude,codex'), ['codex', 'claude']);
      assert.throws(() => setup.parseTools('claude,cursor'), /unknown: cursor/);
      assert.throws(() => setup.parseTools(''), /--tools must list/);
    }],
    ['skillRootKeys gives OpenCode its own folder only when it is the only tool', () => {
      assert.deepStrictEqual(setup.skillRootKeys(['claude', 'codex', 'opencode']), ['claude', 'agents']);
      assert.deepStrictEqual(setup.skillRootKeys(['codex', 'opencode']), ['agents']);
      assert.deepStrictEqual(setup.skillRootKeys(['claude', 'opencode']), ['claude']);
      assert.deepStrictEqual(setup.skillRootKeys(['opencode']), ['opencode']);
    }],
    ['sanitizeSkillFrontmatter keeps only portable keys and their nested lines', () => {
      const input = '---\r\nname: x\r\ndescription: d\r\norigin: ECC\r\ntags:\r\n  - a\r\nmetadata:\r\n  version: 1\r\n---\r\nBody\r\n';
      assert.strictEqual(setup.sanitizeSkillFrontmatter(input), '---\nname: x\ndescription: d\nmetadata:\n  version: 1\n---\r\nBody\r\n');
      assert.strictEqual(setup.sanitizeSkillFrontmatter('# No frontmatter'), '# No frontmatter');
    }],
    ['applyProjectPlan installs for Claude Code and Codex and writes shared instructions', () => {
      const dir = newProject({ 'pyproject.toml': '', '.git/HEAD': '' });
      const tools = ['claude', 'codex', 'opencode'];
      const plan = setup.buildProjectPlan(dir, context, { tools, extras: ['odd-skill'] });
      assert.strictEqual(plan.status, 'not installed');
      const outcome = setup.applyProjectPlan(plan, context, { tools });
      assert.deepStrictEqual(Object.keys(outcome.roots), ['claude', 'agents']);
      assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'python-reviewer.md')));
      assert.ok(fs.existsSync(path.join(dir, '.agents', 'skills', 'python-patterns', 'SKILL.md')));
      assert.ok(!fs.existsSync(path.join(dir, '.agents', 'agents')), 'Codex folder only receives skills');
      assert.ok(!fs.existsSync(path.join(dir, '.opencode')), 'OpenCode reads .claude and .agents itself');
      const portable = fs.readFileSync(path.join(dir, '.agents', 'skills', 'odd-skill', 'SKILL.md'), 'utf8');
      assert.ok(!portable.includes('origin:') && !portable.includes('tags:') && portable.includes('metadata:'));
      assert.ok(fs.readFileSync(path.join(dir, '.claude', 'skills', 'odd-skill', 'SKILL.md'), 'utf8').includes('origin: ECC'));
      assert.deepStrictEqual(outcome.instructions, { agents: 'created', claude: 'created' });
      assert.ok(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('@AGENTS.md'));
      assert.strictEqual(setup.buildProjectPlan(dir, context, { tools }).status, 'up to date');
      const again = setup.applyProjectPlan(setup.buildProjectPlan(dir, context, { tools }), context, { tools });
      assert.deepStrictEqual(again.instructions, { agents: 'unchanged', claude: 'unchanged' });
      assert.deepStrictEqual(setup.buildProjectPlan(dir, context, { tools }).extras, ['odd-skill']);
    }],
    ['applyProjectPlan respects tool subsets, --no-instructions, and cleans up when the stack is gone', () => {
      const dir = newProject({ 'pyproject.toml': '' });
      const codexOnly = setup.applyProjectPlan(setup.buildProjectPlan(dir, context, { tools: ['codex'] }), context, { tools: ['codex'], instructions: false });
      assert.deepStrictEqual(Object.keys(codexOnly.roots), ['agents']);
      assert.strictEqual(codexOnly.instructions, null);
      assert.ok(!fs.existsSync(path.join(dir, '.claude')));
      assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
      const opencodeOnly = setup.applyProjectPlan(setup.buildProjectPlan(dir, context, { tools: ['opencode'] }), context, { tools: ['opencode'] });
      assert.deepStrictEqual(Object.keys(opencodeOnly.roots), ['opencode']);
      assert.ok(fs.existsSync(path.join(dir, '.opencode', 'skills', 'python-patterns', 'SKILL.md')));
      assert.deepStrictEqual(opencodeOnly.instructions, { agents: 'created' });
      fs.rmSync(path.join(dir, 'pyproject.toml'));
      const cleaned = setup.applyProjectPlan(setup.buildProjectPlan(dir, context, { tools: ['opencode'] }), context, { tools: ['opencode'] });
      assert.ok(cleaned.roots.opencode.removed.length > 0);
      assert.ok(!fs.existsSync(path.join(dir, '.opencode')));
      assert.strictEqual(cleaned.instructions.agents, 'deleted');
      assert.ok(fs.existsSync(path.join(dir, '.agents', 'skills')), 'codex install from the earlier run is left alone');
    }],
    ['removeProject undoes everything, or only the named tools', () => {
      const dir = newProject({ 'pyproject.toml': '', 'CLAUDE.md': '# Mine\n' });
      const tools = ['claude', 'codex'];
      setup.applyProjectPlan(setup.buildProjectPlan(dir, context, { tools }), context, { tools });
      const partial = setup.removeProject(dir, { tools: ['codex'] });
      assert.deepStrictEqual(Object.keys(partial.roots), ['agents']);
      assert.deepStrictEqual(partial.instructions, {});
      assert.ok(!fs.existsSync(path.join(dir, '.agents')));
      assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills')));
      const full = setup.removeProject(dir);
      assert.deepStrictEqual(Object.keys(full.roots), ['claude']);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Mine\n');
      assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
      assert.ok(!fs.existsSync(path.join(dir, '.claude')));
    }],
    ['applyGlobal installs per tool and writes instructions; removeGlobal undoes it', () => {
      const homes = setup.resolveToolHomes(path.join(tmp, 'global-home'));
      writeFile(path.join(homes.codex, 'AGENTS.md'), '# My codex notes\n');
      writeFile(path.join(libRoot, 'my-ecc', 'private', 'AGENTS.md'), '<!-- note -->\n# Private\n\n- Time zone: test\n');
      const tools = ['claude', 'codex', 'opencode'];
      const result = setup.applyGlobal(context, { tools, homes, routerFiles: { 'SKILL.md': 'router' } });
      assert.deepStrictEqual(Object.keys(result.roots), ['claude', 'agents']);
      assert.ok(fs.existsSync(path.join(homes.claude, 'commands', 'plan.md')));
      assert.ok(fs.existsSync(path.join(homes.agents, 'skills', 'tdd-workflow', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(homes.agents, 'skills', 'skill-library', 'SKILL.md')));
      assert.ok(!fs.existsSync(path.join(homes.agents, 'commands')));
      const codexFile = fs.readFileSync(path.join(homes.codex, 'AGENTS.md'), 'utf8');
      assert.ok(codexFile.startsWith('# My codex notes'));
      assert.ok(codexFile.includes('- Be concise.') && codexFile.includes('- Time zone: test'));
      assert.ok(!codexFile.includes('maintainer note') && !codexFile.includes('<!-- note -->'));
      assert.deepStrictEqual(Object.values(result.instructions).map(item => item.action), ['created', 'updated', 'created']);
      const removed = setup.removeGlobal({ tools: ['opencode'], homes });
      assert.strictEqual(removed.instructions.opencode.action, 'deleted');
      assert.ok(fs.existsSync(path.join(homes.claude, 'CLAUDE.md')));
      const all = setup.removeGlobal({ homes });
      assert.deepStrictEqual(Object.keys(all.roots), ['claude', 'agents']);
      assert.strictEqual(fs.readFileSync(path.join(homes.codex, 'AGENTS.md'), 'utf8'), '# My codex notes\n');
      assert.ok(!fs.existsSync(path.join(homes.claude, 'CLAUDE.md')));
      fs.rmSync(path.join(libRoot, 'my-ecc', 'private'), { recursive: true, force: true });
    }],
    ['applyGlobal for OpenCode alone installs skills into the OpenCode folder', () => {
      const homes = setup.resolveToolHomes(path.join(tmp, 'opencode-home'));
      const result = setup.applyGlobal(context, { tools: ['opencode'], homes, dryRun: false });
      assert.deepStrictEqual(Object.keys(result.roots), ['opencode']);
      assert.ok(fs.existsSync(path.join(homes.opencode, 'skills', 'tdd-workflow', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(homes.opencode, 'AGENTS.md')));
      assert.ok(!fs.existsSync(homes.claude));
    }],
    ['validateContext reports a missing shared instructions file', () => {
      const broken = { ...context, instructions: { shared: path.join(tmp, 'missing.md'), private: null } };
      assert.ok(setup.validateContext(broken).some(problem => problem.includes('shared file')));
    }],
    ['shipped my-ecc profile and stack mappings only reference items in this checkout', () => {
      const real = setup.loadContext({ libraryRoot: repoRoot, profilePath: path.join(repoRoot, 'my-ecc', 'profile.json') });
      assert.deepStrictEqual(setup.validateContext(real), []);
      assert.ok(real.profile.global.skills.length > 0 && real.profile.global.skills.length <= 15, 'global core should stay small');
    }],
  ];

  for (const [name, fn] of tests) {
    if (test(name, fn)) passed += 1;
    else failed += 1;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

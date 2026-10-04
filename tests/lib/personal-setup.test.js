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
    stackMappings: 'stack-mappings.json',
    global: { skills: ['tdd-workflow'], agents: ['planner'], commands: ['plan'], rules: ['common'] },
    project: { stackAgents: { python: ['python-reviewer'] } },
    scan: { maxDepth: 3, maxDirectories: 1000, ignoreDirs: ['node_modules'] },
  });
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
      const target = setup.stateTarget(dir);
      const result = setup.syncManagedItems(target, setup.planEntries(plan, context.library), { state: { stacks: ['python'] } });
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
      const target = setup.stateTarget(dir);
      const result = setup.syncManagedItems(target, setup.planEntries(plan, context.library));
      assert.deepStrictEqual(result.skipped, ['skills/fastapi-patterns']);
      assert.strictEqual(fs.readFileSync(path.join(target, 'skills', 'fastapi-patterns', 'SKILL.md'), 'utf8'), 'mine');
      assert.strictEqual(setup.buildProjectPlan(dir, context).status, 'up to date');
    }],
    ['syncManagedItems refreshes current items and removes stale ones on re-run', () => {
      const dir = newProject({ 'pyproject.toml': '', Dockerfile: '' });
      const target = setup.stateTarget(dir);
      setup.syncManagedItems(target, setup.planEntries(setup.buildProjectPlan(dir, context), context.library));
      fs.rmSync(path.join(dir, 'Dockerfile'));
      assert.strictEqual(setup.buildProjectPlan(dir, context).status, 'changes pending');
      const result = setup.syncManagedItems(target, setup.planEntries(setup.buildProjectPlan(dir, context), context.library));
      assert.deepStrictEqual(result.removed, ['skills/docker-patterns']);
      assert.ok(result.refreshed.includes('skills/python-patterns'));
      assert.ok(!fs.existsSync(path.join(target, 'skills', 'docker-patterns')));
    }],
    ['syncManagedItems dry run writes nothing', () => {
      const dir = newProject({ 'pyproject.toml': '' });
      const target = setup.stateTarget(dir);
      const result = setup.syncManagedItems(target, setup.planEntries(setup.buildProjectPlan(dir, context), context.library), { dryRun: true });
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
      const target = setup.stateTarget(dir);
      setup.syncManagedItems(target, setup.planEntries(setup.buildProjectPlan(dir, context), context.library));
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
    ['resolveClaudeHome prefers explicit, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
      const saved = process.env.CLAUDE_CONFIG_DIR;
      try {
        assert.strictEqual(setup.resolveClaudeHome(path.join(tmp, 'explicit')), path.join(tmp, 'explicit'));
        process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'from-env');
        assert.strictEqual(setup.resolveClaudeHome(), path.join(tmp, 'from-env'));
        delete process.env.CLAUDE_CONFIG_DIR;
        assert.strictEqual(setup.resolveClaudeHome(), path.join(os.homedir(), '.claude'));
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = saved;
      }
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

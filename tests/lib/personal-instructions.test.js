/**
 * Tests for scripts/lib/personal-instructions.js
 *
 * Run with: node tests/lib/personal-instructions.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ins = require('../../scripts/lib/personal-instructions');

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

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function runTests() {
  console.log('\n=== Testing personal-instructions ===\n');

  let passed = 0;
  let failed = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-instructions-test-'));
  let counter = 0;
  const newProject = (files = {}) => {
    counter += 1;
    const dir = path.join(tmp, `p${counter}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
    return dir;
  };
  const planFor = (project, extra = {}) => ({
    project,
    stacks: [
      { id: 'python', name: 'Python', evidence: 'pyproject.toml', commands: { test: ['pytest'], lint: ['ruff check .'] } },
      { id: 'fastapi', name: 'FastAPI', evidence: "pyproject.toml contains 'fastapi'", commands: { test: ['pytest', 'python -m pytest'], weird: 'nope' } },
    ],
    skills: ['python-patterns'],
    rules: ['python'],
    ...extra,
  });

  const tests = [
    ['upsertBlock appends once, then replaces in place; stripBlock removes it', () => {
      const first = ins.upsertBlock('# Title\n\nText\n', 'one');
      assert.strictEqual(first, `# Title\n\nText\n\n${ins.BLOCK_START}\none\n${ins.BLOCK_END}\n`);
      const second = ins.upsertBlock(first, 'two $& $1');
      assert.ok(second.includes('two $& $1') && !second.includes('\none\n'));
      assert.strictEqual(ins.upsertBlock(null, 'x'), `${ins.BLOCK_START}\nx\n${ins.BLOCK_END}\n`);
      assert.strictEqual(ins.stripBlock(second), '# Title\n\nText\n');
      assert.strictEqual(ins.stripBlock('no block'), 'no block');
      assert.strictEqual(ins.stripBlock(ins.upsertBlock('', 'x')), '');
      assert.strictEqual(ins.hasBlock(null), false);
    }],
    ['projectBlockBody lists stacks, merged commands, rules, and skill folders per tool', () => {
      const body = ins.projectBlockBody(planFor('/p'), ['claude', 'codex']);
      assert.ok(body.includes('- Python (pyproject.toml)'));
      assert.ok(body.includes('- test: `pytest`, `python -m pytest`'));
      assert.ok(body.includes('- lint: `ruff check .`'));
      assert.ok(!body.includes('weird'));
      assert.ok(body.includes('`.claude/rules/ecc/` (python)'));
      assert.ok(body.includes('`.claude/skills/` and `.agents/skills/`'));
      const codexOnly = ins.projectBlockBody(planFor('/p'), ['codex']);
      assert.ok(!codexOnly.includes('.claude/'));
      const opencodeOnly = ins.projectBlockBody(planFor('/p', { skills: ['x'], rules: [], stacks: [] }), ['opencode']);
      assert.ok(opencodeOnly.includes('`.opencode/skills/`'));
      assert.ok(!opencodeOnly.includes('Common commands'));
    }],
    ['syncProjectInstructions creates AGENTS.md and a CLAUDE.md bridge when neither exists', () => {
      const dir = newProject();
      const result = ins.syncProjectInstructions(planFor(dir), { tools: ['claude', 'codex'] });
      assert.deepStrictEqual(result, { agents: 'created', claude: 'created' });
      assert.ok(read(path.join(dir, 'AGENTS.md')).startsWith(ins.AGENTS_SCAFFOLD));
      assert.strictEqual(read(path.join(dir, 'CLAUDE.md')), `${ins.BLOCK_START}\n@AGENTS.md\n${ins.BLOCK_END}\n`);
      assert.deepStrictEqual(ins.syncProjectInstructions(planFor(dir), { tools: ['claude', 'codex'] }), { agents: 'unchanged', claude: 'unchanged' });
    }],
    ['syncProjectInstructions keeps existing files and points a new AGENTS.md at CLAUDE.md', () => {
      const dir = newProject({ 'CLAUDE.md': '# Rules\n\nUse pnpm.\n' });
      const result = ins.syncProjectInstructions(planFor(dir), { tools: ['claude'] });
      assert.deepStrictEqual(result, { agents: 'created', claude: 'updated' });
      assert.ok(read(path.join(dir, 'AGENTS.md')).startsWith(ins.AGENTS_SCAFFOLD_WITH_CLAUDE));
      assert.ok(read(path.join(dir, 'CLAUDE.md')).startsWith('# Rules\n\nUse pnpm.\n\n'));
    }],
    ['syncProjectInstructions leaves CLAUDE.md alone when it already imports AGENTS.md, and skips it without Claude', () => {
      const dir = newProject({ 'AGENTS.md': '# Agents\n', 'CLAUDE.md': '@AGENTS.md\n\nMore.\n' });
      assert.deepStrictEqual(ins.syncProjectInstructions(planFor(dir), { tools: ['claude'] }), { agents: 'updated', claude: 'unchanged' });
      assert.strictEqual(read(path.join(dir, 'CLAUDE.md')), '@AGENTS.md\n\nMore.\n');
      assert.ok(read(path.join(dir, 'AGENTS.md')).startsWith('# Agents\n\n'));
      const other = newProject();
      assert.deepStrictEqual(ins.syncProjectInstructions(planFor(other), { tools: ['codex', 'opencode'] }), { agents: 'created' });
      assert.ok(!fs.existsSync(path.join(other, 'CLAUDE.md')));
    }],
    ['syncProjectInstructions dry run writes nothing', () => {
      const dir = newProject();
      assert.deepStrictEqual(ins.syncProjectInstructions(planFor(dir), { tools: ['claude'], dryRun: true }), { agents: 'created', claude: 'created' });
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    }],
    ['removeProjectInstructions deletes untouched scaffolds but keeps edited files', () => {
      const untouched = newProject();
      ins.syncProjectInstructions(planFor(untouched), { tools: ['claude'] });
      assert.deepStrictEqual(ins.removeProjectInstructions(untouched, { dryRun: true }), { claude: 'deleted', agents: 'deleted' });
      assert.ok(fs.existsSync(path.join(untouched, 'AGENTS.md')));
      assert.deepStrictEqual(ins.removeProjectInstructions(untouched), { claude: 'deleted', agents: 'deleted' });
      assert.deepStrictEqual(fs.readdirSync(untouched), []);

      const edited = newProject({ 'CLAUDE.md': '# Mine\n' });
      ins.syncProjectInstructions(planFor(edited), { tools: ['claude'] });
      writeFile(path.join(edited, 'AGENTS.md'), read(path.join(edited, 'AGENTS.md')).replace('## Project notes', '## Project notes\n\nReal notes.'));
      assert.deepStrictEqual(ins.removeProjectInstructions(edited), { claude: 'removed', agents: 'removed' });
      assert.strictEqual(read(path.join(edited, 'CLAUDE.md')), '# Mine\n');
      assert.ok(read(path.join(edited, 'AGENTS.md')).includes('Real notes.'));
      assert.ok(!ins.hasBlock(read(path.join(edited, 'AGENTS.md'))));
      assert.deepStrictEqual(ins.removeProjectInstructions(edited, { includeAgents: false }), { claude: 'absent' });
    }],
    ['readGlobalInstructions drops comments and appends private notes', () => {
      const shared = path.join(tmp, 'g', 'AGENTS.md');
      const privateFile = path.join(tmp, 'g', 'private', 'AGENTS.md');
      writeFile(shared, '<!-- note for me -->\n\n# Shared\n\n- Rule\n');
      assert.ok(ins.readGlobalInstructions({ shared, private: privateFile }).endsWith('# Shared\n\n- Rule'));
      writeFile(privateFile, '<!-- template -->\n');
      assert.ok(ins.readGlobalInstructions({ shared, private: privateFile }).endsWith('- Rule'));
      writeFile(privateFile, '# Private\n- Mine\n');
      const body = ins.readGlobalInstructions({ shared, private: privateFile });
      assert.ok(body.endsWith('# Private\n- Mine') && !body.includes('note for me'));
      assert.strictEqual(ins.readGlobalInstructions({ shared: path.join(tmp, 'none.md') }), null);
      assert.strictEqual(ins.readGlobalInstructions(null), null);
    }],
    ['syncGlobalInstructions writes one block per tool; removeGlobalInstructions takes it out', () => {
      const shared = path.join(tmp, 'g', 'AGENTS.md');
      const homes = { claude: path.join(tmp, 'home', '.claude'), codex: path.join(tmp, 'home', '.codex'), opencode: path.join(tmp, 'home', 'oc') };
      writeFile(path.join(homes.claude, 'CLAUDE.md'), '# Existing\n');
      const result = ins.syncGlobalInstructions(homes, ['claude', 'codex', 'bogus'], { shared });
      assert.deepStrictEqual(Object.keys(result), ['claude', 'codex']);
      assert.strictEqual(result.claude.action, 'updated');
      assert.strictEqual(result.codex.action, 'created');
      assert.ok(read(path.join(homes.claude, 'CLAUDE.md')).startsWith('# Existing\n\n'));
      assert.deepStrictEqual(ins.syncGlobalInstructions(homes, ['codex'], { shared: path.join(tmp, 'nope.md') }), {});
      const removed = ins.removeGlobalInstructions(homes, ['claude', 'codex', 'opencode', 'bogus']);
      assert.deepStrictEqual(Object.values(removed).map(item => item.action), ['removed', 'deleted', 'absent']);
      assert.strictEqual(read(path.join(homes.claude, 'CLAUDE.md')), '# Existing\n');
      assert.ok(!fs.existsSync(path.join(homes.codex, 'AGENTS.md')));
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

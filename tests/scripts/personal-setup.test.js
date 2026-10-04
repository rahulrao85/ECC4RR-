/**
 * Tests for scripts/personal-setup.js (CLI)
 *
 * Run with: node tests/scripts/personal-setup.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'personal-setup.js');
const STATE_FILE = 'ecc-personal-state.json';

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
  fs.writeFileSync(filePath, content);
}

function runTests() {
  console.log('\n=== Testing personal-setup CLI ===\n');

  let passed = 0;
  let failed = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-setup-cli-test-'));
  const fallbackHome = path.join(tmp, 'fallback-claude-home');
  const run = args => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: fallbackHome },
  });

  const projects = path.join(tmp, 'Projects');
  const pyProject = path.join(projects, 'py-api');
  const webProject = path.join(projects, 'web');
  writeFile(path.join(pyProject, 'pyproject.toml'), '[project]\ndependencies = ["fastapi"]\n');
  writeFile(path.join(webProject, 'package.json'), '{"dependencies":{"react":"18"},"devDependencies":{"typescript":"5"}}');
  fs.mkdirSync(path.join(projects, 'plain-repo', '.git'), { recursive: true });
  const home = path.join(tmp, 'claude-home');

  const tests = [
    ['help and no-argument runs print usage', () => {
      for (const args of [['--help'], ['help'], []]) {
        const result = run(args);
        assert.strictEqual(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes('Usage:'));
      }
    }],
    ['bad commands and options exit 1 with a clear message', () => {
      const cases = [
        [['bogus'], /Unknown command: bogus/],
        [['scan', projects, '--nope'], /Unknown option: --nope/],
        [['scan', projects, '--depth'], /--depth needs a value/],
        [['scan', projects, '--depth', 'two'], /--depth must be a whole number/],
        [['scan', path.parse(path.resolve(tmp)).root], /Refusing to scan a whole drive/],
        [['remove'], /Missing project folder/],
      ];
      for (const [args, pattern] of cases) {
        const result = run(args);
        assert.strictEqual(result.status, 1, `expected exit 1 for ${args.join(' ')}`);
        assert.ok(pattern.test(result.stderr), result.stderr);
      }
    }],
    ['check passes for the shipped profile', () => {
      const result = run(['check']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.startsWith('OK:'));
    }],
    ['check reports broken names and exits 1', () => {
      const profilePath = path.join(tmp, 'broken-profile.json');
      writeFile(profilePath, JSON.stringify({ global: { skills: ['does-not-exist'] } }));
      const result = run(['check', '--profile', profilePath]);
      assert.strictEqual(result.status, 1);
      assert.ok(result.stdout.includes('global: skill "does-not-exist" not found'));
    }],
    ['scan lists each project with stacks and is read-only', () => {
      const result = run(['scan', projects]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('3 project(s) found'));
      assert.ok(result.stdout.includes('py-api  [not installed]'));
      assert.ok(result.stdout.includes("fastapi (pyproject.toml contains 'fastapi')"));
      assert.ok(result.stdout.includes('plain-repo  [nothing to install]'));
      assert.ok(!fs.existsSync(path.join(pyProject, '.claude')));
    }],
    ['scan --json returns machine-readable plans', () => {
      const result = run(['scan', projects, '--json', '--depth', '1']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.plans.length, 3);
      const web = payload.plans.find(plan => plan.name === 'web');
      assert.ok(web.skills.includes('react-patterns'));
      assert.ok(web.agents.includes('react-reviewer'));
      assert.ok(Array.isArray(payload.globalCore.skills));
    }],
    ['apply --dry-run writes nothing', () => {
      const result = run(['apply', projects, '--dry-run']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('Dry run: nothing was written.'));
      assert.ok(!fs.existsSync(path.join(pyProject, '.claude')));
    }],
    ['apply installs each project set and scan then reports up to date', () => {
      const result = run(['apply', projects]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(path.join(pyProject, '.claude', 'skills', 'fastapi-patterns', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(pyProject, '.claude', 'rules', 'ecc', 'python')));
      assert.ok(fs.existsSync(path.join(webProject, '.claude', 'agents', 'react-reviewer.md')));
      assert.ok(!fs.existsSync(path.join(projects, 'plain-repo', '.claude')), 'projects with nothing to install stay untouched');
      const scan = run(['scan', projects]);
      assert.ok(scan.stdout.includes('py-api  [up to date]'));
      assert.ok(scan.stdout.includes('web  [up to date]'));
    }],
    ['apply --with adds library skills to one project and keeps them on later runs', () => {
      assert.strictEqual(run(['apply', projects, '--with', 'deep-research']).status, 1);
      const unknown = run(['apply', pyProject, '--with', 'no-such-skill']);
      assert.strictEqual(unknown.status, 1);
      assert.ok(unknown.stderr.includes('Unknown skill(s): no-such-skill'));
      const added = run(['apply', pyProject, '--with', 'deep-research', '--json']);
      assert.strictEqual(added.status, 0, added.stderr);
      const payload = JSON.parse(added.stdout);
      assert.deepStrictEqual(payload.outcomes[0].result.added, ['skills/deep-research']);
      const again = run(['apply', pyProject]);
      assert.strictEqual(again.status, 0, again.stderr);
      assert.ok(fs.existsSync(path.join(pyProject, '.claude', 'skills', 'deep-research', 'SKILL.md')));
      const state = JSON.parse(fs.readFileSync(path.join(pyProject, '.claude', STATE_FILE), 'utf8'));
      assert.deepStrictEqual(state.extras, ['deep-research']);
    }],
    ['apply cleans up a project whose stack no longer matches', () => {
      const gone = path.join(projects, 'gone');
      writeFile(path.join(gone, 'requirements.txt'), 'requests\n');
      assert.strictEqual(run(['apply', gone]).status, 0);
      assert.ok(fs.existsSync(path.join(gone, '.claude', STATE_FILE)));
      fs.rmSync(path.join(gone, 'requirements.txt'));
      fs.mkdirSync(path.join(gone, '.git'));
      const result = run(['apply', gone]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(!fs.existsSync(path.join(gone, '.claude', STATE_FILE)));
      assert.ok(!fs.existsSync(path.join(gone, '.claude', 'skills')));
    }],
    ['remove deletes what apply installed in one project', () => {
      const dry = run(['remove', webProject, '--dry-run']);
      assert.ok(dry.stdout.startsWith('Would remove'));
      const result = run(['remove', webProject]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.startsWith('Removed'));
      assert.ok(!fs.existsSync(path.join(webProject, '.claude', STATE_FILE)));
      assert.ok(run(['remove', webProject]).stdout.startsWith('Nothing to remove'));
    }],
    ['global installs the core and the skill-library router, and remove --global undoes it', () => {
      const dry = run(['global', '--home', home, '--dry-run']);
      assert.strictEqual(dry.status, 0, dry.stderr);
      assert.ok(!fs.existsSync(home));
      const result = run(['global', '--home', home]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(path.join(home, 'skills', 'tdd-workflow', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(home, 'commands', 'plan.md')));
      assert.ok(fs.existsSync(path.join(home, 'rules', 'ecc', 'common')));
      const router = fs.readFileSync(path.join(home, 'skills', 'skill-library', 'SKILL.md'), 'utf8');
      assert.ok(router.includes('name: skill-library'));
      assert.ok(!router.includes('tdd-workflow'), 'global core skills are not listed in the router');
      assert.ok(fs.existsSync(path.join(home, 'skills', 'skill-library', 'INDEX.md')));
      const rerun = run(['global', '--home', home]);
      assert.ok(rerun.stdout.includes('Added 0'));
      const removed = run(['remove', '--global', '--home', home]);
      assert.strictEqual(removed.status, 0, removed.stderr);
      assert.ok(!fs.existsSync(path.join(home, 'skills')));
      assert.ok(!fs.existsSync(fallbackHome), 'never writes to the default Claude folder when --home is given');
    }],
    ['global honours a custom profile', () => {
      const profilePath = path.join(tmp, 'tiny-profile.json');
      const tinyHome = path.join(tmp, 'tiny-home');
      writeFile(profilePath, JSON.stringify({ global: { skills: ['search-first', 'not-real'] } }));
      const result = run(['global', '--home', tinyHome, '--profile', profilePath]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('Not in library (skipped): skill:not-real'));
      assert.deepStrictEqual(fs.readdirSync(path.join(tinyHome, 'skills')).sort(), ['search-first', 'skill-library']);
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

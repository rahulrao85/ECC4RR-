/**
 * Tests for scripts/lib/personal-router.js
 *
 * Run with: node tests/lib/personal-router.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSkillLibraryRouter, listSkillGroups, readSkillDescription, shorten } = require('../../scripts/lib/personal-router');

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

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeLibrary(root, { withManifest = true } = {}) {
  const skills = {
    alpha: 'description: "Alpha does things"',
    beta: 'description: Beta helps',
    gamma: "description: 'Gamma quoted'",
    delta: 'name: delta',
  };
  for (const [name, line] of Object.entries(skills)) {
    writeFile(path.join(root, 'skills', name, 'SKILL.md'), `---\n${line}\n---\n\n# ${name}\n`);
  }
  fs.mkdirSync(path.join(root, 'skills', 'not-a-skill'), { recursive: true });
  if (withManifest) {
    writeFile(path.join(root, 'manifests', 'install-modules.json'), JSON.stringify({
      modules: [
        { id: 'core', description: 'Core skills.', paths: ['skills/alpha', 'skills/beta/', 'rules'] },
        { id: 'media', paths: ['skills/gamma', 'skills/alpha', 'skills/missing'] },
        { id: 'empty', paths: ['agents'] },
      ],
    }));
  }
}

function runTests() {
  console.log('\n=== Testing personal-router ===\n');

  let passed = 0;
  let failed = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-router-test-'));
  const libRoot = path.join(tmp, 'lib');
  makeLibrary(libRoot);

  const tests = [
    ['listSkillGroups groups skills by first owning module and collects the rest', () => {
      const groups = listSkillGroups(libRoot);
      assert.deepStrictEqual(groups.map(group => [group.id, group.skills]), [
        ['core', ['alpha', 'beta']],
        ['media', ['gamma']],
        ['other', ['delta']],
      ]);
      assert.strictEqual(groups[0].description, 'Core skills.');
      assert.strictEqual(groups[1].description, '');
    }],
    ['listSkillGroups puts every skill in "other" when the manifest is missing', () => {
      const bare = path.join(tmp, 'bare');
      makeLibrary(bare, { withManifest: false });
      assert.deepStrictEqual(listSkillGroups(bare).map(group => group.id), ['other']);
    }],
    ['readSkillDescription strips quotes and handles missing descriptions or files', () => {
      assert.strictEqual(readSkillDescription(path.join(libRoot, 'skills', 'alpha')), 'Alpha does things');
      assert.strictEqual(readSkillDescription(path.join(libRoot, 'skills', 'gamma')), 'Gamma quoted');
      assert.strictEqual(readSkillDescription(path.join(libRoot, 'skills', 'delta')), '');
      assert.strictEqual(readSkillDescription(path.join(libRoot, 'skills', 'nope')), '');
    }],
    ['shorten keeps short text and cuts long text at a word boundary', () => {
      assert.strictEqual(shorten('short text', 50), 'short text');
      assert.strictEqual(shorten('one two three four five', 12), 'one two...');
      assert.strictEqual(shorten('abcdefghijklmnop', 8), 'abcdefgh...');
    }],
    ['buildSkillLibraryRouter writes a small router page and a searchable index', () => {
      const router = buildSkillLibraryRouter({ libraryRoot: libRoot, exclude: ['beta'] });
      assert.strictEqual(router.count, 3);
      assert.strictEqual(router.groups, 3);
      const skillMd = router.files['SKILL.md'];
      assert.ok(skillMd.startsWith('---\nname: skill-library\ndescription: '));
      assert.ok(skillMd.includes(`- Library: \`${libRoot}\``));
      assert.ok(skillMd.includes(path.join(libRoot, 'skills', '<skill-name>', 'SKILL.md')));
      assert.ok(skillMd.includes('### core (1)\n\nCore skills.\n\nalpha'));
      assert.ok(skillMd.includes('### media (1)\n\ngamma'));
      assert.ok(!skillMd.includes('beta'));
      const indexMd = router.files['INDEX.md'];
      assert.ok(indexMd.includes('- `alpha` [core]: Alpha does things'));
      assert.ok(indexMd.includes('- `delta` [other]: (no description)'));
      assert.ok(!indexMd.includes('`beta`'));
    }],
    ['router for this checkout lists every non-excluded skill once and stays compact', () => {
      const excluded = ['tdd-workflow', 'verification-loop'];
      const router = buildSkillLibraryRouter({ libraryRoot: repoRoot, exclude: excluded });
      const allSkills = fs.readdirSync(path.join(repoRoot, 'skills'))
        .filter(name => fs.existsSync(path.join(repoRoot, 'skills', name, 'SKILL.md')));
      assert.strictEqual(router.count, allSkills.length - excluded.length);
      const indexLines = router.files['INDEX.md'].split('\n').filter(line => line.startsWith('- `'));
      assert.strictEqual(indexLines.length, router.count);
      assert.strictEqual(new Set(indexLines.map(line => line.split('`')[1])).size, router.count);
      assert.ok(router.files['SKILL.md'].length < 16000, `router page is ${router.files['SKILL.md'].length} chars`);
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

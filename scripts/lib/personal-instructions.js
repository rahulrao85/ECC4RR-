'use strict';

/**
 * Shared instruction files for every coding agent (Claude Code, Codex,
 * OpenCode) used by the personal setup.
 *
 * Everything this module writes into an instruction file sits between two
 * marker comments, so a re-run replaces only that block and `remove` can take
 * it out again without touching anything the user wrote.
 *
 * - Global: the text of my-ecc/AGENTS.md (plus my-ecc/private/AGENTS.md when
 *   present) goes into ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, and
 *   ~/.config/opencode/AGENTS.md.
 * - Project: AGENTS.md is the one shared file. It gets a refreshed block with
 *   the detected stack, and CLAUDE.md imports it with `@AGENTS.md`.
 *
 * Used by scripts/lib/personal-setup.js. See docs/PERSONAL-SETUP.md.
 */

const fs = require('fs');
const path = require('path');

const BLOCK_START = '<!-- ecc-personal:start -->';
const BLOCK_END = '<!-- ecc-personal:end -->';
const BLOCK_PATTERN = /<!-- ecc-personal:start -->[\s\S]*?<!-- ecc-personal:end -->/;

const SCAFFOLD_INTRO = [
  '# AGENTS.md',
  '',
  'Shared instructions for every AI coding agent in this project (Claude Code, Codex, OpenCode, and others).',
  'Claude Code reads this file through CLAUDE.md.',
  '',
];
const SCAFFOLD_NOTES = [
  '## Project notes',
  '',
  '<!-- Describe the project here: what it does, how to run it, conventions, and things to avoid. -->',
  '',
];
const AGENTS_SCAFFOLD = [...SCAFFOLD_INTRO, ...SCAFFOLD_NOTES].join('\n');
const AGENTS_SCAFFOLD_WITH_CLAUDE = [
  ...SCAFFOLD_INTRO,
  'The main project instructions are in CLAUDE.md. Read it before starting any task.',
  '',
  ...SCAFFOLD_NOTES,
].join('\n');

const GLOBAL_FILES = {
  claude: { home: 'claude', file: 'CLAUDE.md' },
  codex: { home: 'codex', file: 'AGENTS.md' },
  opencode: { home: 'opencode', file: 'AGENTS.md' },
};

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function hasBlock(content) {
  return typeof content === 'string' && BLOCK_PATTERN.test(content);
}

function upsertBlock(content, body) {
  const block = `${BLOCK_START}\n${body.trim()}\n${BLOCK_END}`;
  if (hasBlock(content)) return content.replace(BLOCK_PATTERN, () => block);
  const base = (content || '').replace(/\s+$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

function stripBlock(content) {
  if (!hasBlock(content)) return content;
  const stripped = content.replace(BLOCK_PATTERN, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  return stripped ? `${stripped}\n` : '';
}

/**
 * Write content to filePath only when it changed. Returns 'created',
 * 'updated', or 'unchanged'.
 */
function writeIfChanged(filePath, content, dryRun) {
  const current = readText(filePath);
  if (current === content) return 'unchanged';
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return current === null ? 'created' : 'updated';
}

/**
 * Take the managed block out of filePath. The file is deleted when nothing
 * else is left, or when what is left is one of the given scaffolds (the file
 * was created by this tool and never edited). Returns 'removed', 'deleted',
 * or 'absent'.
 */
function removeBlockFromFile(filePath, { dryRun = false, scaffolds = [] } = {}) {
  const current = readText(filePath);
  if (!hasBlock(current)) return 'absent';
  const remaining = stripBlock(current);
  const untouchedScaffold = scaffolds.some(scaffold => remaining.trim() === scaffold.trim());
  if (!remaining.trim() || untouchedScaffold) {
    if (!dryRun) fs.rmSync(filePath, { force: true });
    return 'deleted';
  }
  if (!dryRun) fs.writeFileSync(filePath, remaining);
  return 'removed';
}

// HTML comments in the source files are notes for the person editing them.
function withoutComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function readGlobalInstructions(instructions) {
  const shared = instructions && instructions.shared ? readText(instructions.shared) : null;
  if (shared === null) return null;
  const privateText = instructions.private ? readText(instructions.private) : null;
  const parts = [
    '<!-- Managed by scripts/personal-setup.js from my-ecc/AGENTS.md. Edit that file and run `global` again. -->',
    withoutComments(shared),
  ];
  if (privateText && withoutComments(privateText)) parts.push(withoutComments(privateText));
  return parts.join('\n\n');
}

function syncGlobalInstructions(homes, tools, instructions, { dryRun = false } = {}) {
  const body = readGlobalInstructions(instructions);
  const results = {};
  if (body === null) return results;
  for (const tool of tools) {
    const spec = GLOBAL_FILES[tool];
    if (!spec) continue;
    const filePath = path.join(homes[spec.home], spec.file);
    results[tool] = { file: filePath, action: writeIfChanged(filePath, upsertBlock(readText(filePath), body), dryRun) };
  }
  return results;
}

function removeGlobalInstructions(homes, tools, { dryRun = false } = {}) {
  const results = {};
  for (const tool of tools) {
    const spec = GLOBAL_FILES[tool];
    if (!spec) continue;
    const filePath = path.join(homes[spec.home], spec.file);
    results[tool] = { file: filePath, action: removeBlockFromFile(filePath, { dryRun }) };
  }
  return results;
}

function mergeCommands(stacks) {
  const merged = {};
  for (const stack of stacks) {
    for (const [kind, list] of Object.entries(stack.commands || {})) {
      if (!Array.isArray(list)) continue;
      merged[kind] = [...new Set([...(merged[kind] || []), ...list.filter(item => typeof item === 'string')])];
    }
  }
  return merged;
}

function projectBlockBody(plan, tools) {
  const lines = ['## Detected by scripts/personal-setup.js (refreshed on every `apply`)', ''];
  lines.push('Stack:');
  for (const stack of plan.stacks) lines.push(`- ${stack.name} (${stack.evidence})`);
  const commands = mergeCommands(plan.stacks);
  const kinds = ['build', 'test', 'lint', 'format'].filter(kind => commands[kind] && commands[kind].length > 0);
  if (kinds.length > 0) {
    lines.push('', 'Common commands for this stack (check which ones this project actually uses):');
    for (const kind of kinds) lines.push(`- ${kind}: ${commands[kind].map(command => `\`${command}\``).join(', ')}`);
  }
  const shared = [];
  if (tools.includes('claude') && plan.rules.length > 0) {
    shared.push(`- Coding rules: \`.claude/rules/ecc/\` (${plan.rules.join(', ')}). Read the matching files before writing code.`);
  }
  const skillDirs = [];
  if (tools.includes('claude')) skillDirs.push('`.claude/skills/`');
  if (tools.includes('codex')) skillDirs.push('`.agents/skills/`');
  if (tools.includes('opencode') && skillDirs.length === 0) skillDirs.push('`.opencode/skills/`');
  if (plan.skills.length > 0 && skillDirs.length > 0) {
    shared.push(`- Project skills (${plan.skills.join(', ')}): ${skillDirs.join(' and ')}`);
  }
  if (shared.length > 0) lines.push('', 'Shared resources:', ...shared);
  return lines.join('\n');
}

function referencesAgentsMd(content) {
  const outside = stripBlock(content || '');
  return /^\s*@(\.\/)?AGENTS\.md\s*$/m.test(outside);
}

/**
 * Make AGENTS.md the shared project file: create it if missing, refresh the
 * detected-stack block, and (for Claude Code) make CLAUDE.md import it.
 */
function syncProjectInstructions(plan, { tools, dryRun = false } = {}) {
  const agentsPath = path.join(plan.project, 'AGENTS.md');
  const claudePath = path.join(plan.project, 'CLAUDE.md');
  const agentsCurrent = readText(agentsPath);
  const claudeCurrent = readText(claudePath);
  const base = agentsCurrent !== null ? agentsCurrent : (claudeCurrent !== null ? AGENTS_SCAFFOLD_WITH_CLAUDE : AGENTS_SCAFFOLD);
  const result = { agents: writeIfChanged(agentsPath, upsertBlock(base, projectBlockBody(plan, tools)), dryRun) };

  if (tools.includes('claude')) {
    result.claude = referencesAgentsMd(claudeCurrent)
      ? 'unchanged'
      : writeIfChanged(claudePath, upsertBlock(claudeCurrent, '@AGENTS.md'), dryRun);
  }
  return result;
}

function removeProjectInstructions(projectDir, { dryRun = false, includeAgents = true } = {}) {
  const result = { claude: removeBlockFromFile(path.join(projectDir, 'CLAUDE.md'), { dryRun }) };
  if (includeAgents) {
    result.agents = removeBlockFromFile(path.join(projectDir, 'AGENTS.md'), {
      dryRun,
      scaffolds: [AGENTS_SCAFFOLD, AGENTS_SCAFFOLD_WITH_CLAUDE],
    });
  }
  return result;
}

module.exports = {
  AGENTS_SCAFFOLD,
  AGENTS_SCAFFOLD_WITH_CLAUDE,
  BLOCK_END,
  BLOCK_START,
  hasBlock,
  projectBlockBody,
  readGlobalInstructions,
  removeBlockFromFile,
  removeGlobalInstructions,
  removeProjectInstructions,
  stripBlock,
  syncGlobalInstructions,
  syncProjectInstructions,
  upsertBlock,
};

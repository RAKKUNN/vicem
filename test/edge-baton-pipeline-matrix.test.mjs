/**
 * @file test/edge-baton-pipeline-matrix.test.mjs
 * @description Exhaustive edge-case and stress matrix for GitCollector (Porcelain v2 & Non-Git fallback),
 * ContextFileRanker (4-Tier file relevance & 1-hop import graph), BatonIaBuilder (U-Shaped Primacy/Middle/Recency
 * layout across budgets & secret sealing), 3-Pillar Safety Guards (SkeletonWriteGuard, SecretCommitGuard,
 * StalenessDriftGuard, PreHandoffSnapshotStore), SmartPatchApplier / WebLandAdapter (4-strategy patching &
 * All-or-Nothing safety guard blocking), and QuotaRadar / PtyStreamInspector / PtyWrapController.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';

import {
  GitCollector,
  ContextFileRanker,
  BatonIaBuilder,
  PreHandoffSnapshotStore,
  SkeletonWriteGuard,
  SecretCommitGuard,
  StalenessDriftGuard,
  SafetyGuardEngine,
  SmartPatchApplier,
  WebLandAdapter,
  QuotaRadar,
  TtySanitizer,
  PtyStreamInspector,
  PtyWrapController,
  UxFormatter,
  SessionHistoryStack,
  CliLauncherAdapter,
  RuleMountAdapter,
  DietLedger,
} from '../vicem.mjs';

function makeTempDir(prefix = 'vicem-baton-pipe-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@vicem.dev'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Vicem Test'], { cwd: dir, stdio: 'ignore' });
}

// ============================================================================
// 1. GIT COLLECTOR PORCELAIN V2 & NON-GIT FALLBACK MATRIX
// ============================================================================

test('GitCollector — Porcelain v2 Status Parsing, Renames, Quoted Paths, and Non-Git Fallback', async (t) => {
  await t.test('1.1 Non-Git directory fallback sorts files by mtime and excludes NoiseGate paths', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });

      const f1 = path.join(tmp, 'src', 'older.js');
      const f2 = path.join(tmp, 'src', 'newer.js');
      const ignored = path.join(tmp, 'node_modules', 'pkg', 'index.js');
      const envFile = path.join(tmp, '.env');

      fs.writeFileSync(f1, 'export const a = 1;\n', 'utf8');
      const tOld = new Date(Date.now() - 20000);
      fs.utimesSync(f1, tOld, tOld);

      fs.writeFileSync(f2, 'export const b = 2;\n', 'utf8');
      fs.writeFileSync(ignored, 'module.exports = {};\n', 'utf8');
      fs.writeFileSync(envFile, 'SECRET=123\n', 'utf8');

      const res = GitCollector.collect(tmp);
      assert.equal(res.isGitRepo, false);
      assert.equal(res.branch, 'no-git');
      assert.equal(res.headCommit, 'none');
      assert.equal(res.modifiedFiles[0], path.join('src', 'newer.js'));
      assert.ok(res.modifiedFiles.includes(path.join('src', 'older.js')));
      assert.ok(!res.modifiedFiles.some((f) => f.includes('node_modules')));
      assert.ok(!res.modifiedFiles.some((f) => f.includes('.env')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('1.2 Git repository with initial commit, modified, staged, renamed, and untracked files', () => {
    const tmp = makeTempDir();
    try {
      initGitRepo(tmp);
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'orig.ts'), 'export const orig = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'src', 'mod.ts'), 'export const mod = 1;\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'feat: initial commit'], { cwd: tmp, stdio: 'ignore' });

      // Rename orig.ts -> renamed.ts
      execFileSync('git', ['mv', 'src/orig.ts', 'src/renamed.ts'], { cwd: tmp, stdio: 'ignore' });
      // Modify mod.ts
      fs.writeFileSync(path.join(tmp, 'src', 'mod.ts'), 'export const mod = 2;\n', 'utf8');
      // Add untracked file
      fs.writeFileSync(path.join(tmp, 'src', 'untracked.ts'), 'export const u = 3;\n', 'utf8');
      // Add ignored .env file (must be filtered by NoiseGate)
      fs.writeFileSync(path.join(tmp, '.env.local'), 'API_KEY=secret\n', 'utf8');

      const res = GitCollector.collect(tmp);
      assert.equal(res.isGitRepo, true);
      assert.ok(res.headCommit && res.headCommit !== 'unknown');
      assert.ok(res.modifiedFiles.includes('src/renamed.ts'));
      assert.ok(res.modifiedFiles.includes('src/mod.ts'));
      assert.ok(res.untrackedFiles.includes('src/untracked.ts'));
      assert.ok(!res.untrackedFiles.includes('.env.local'));
      assert.match(res.diffPatch, /export const mod = 2/);
      assert.equal(res.recentCommits.length, 1);
      assert.match(res.recentCommits[0], /feat: initial commit/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 2. CONTEXT FILE RANKER 4-TIER PRIORITY & 1-HOP IMPORT GRAPH MATRIX
// ============================================================================

test('ContextFileRanker — 4-Tier Relevance Scoring & 1-Hop Local Import Expansion', async (t) => {
  await t.test('2.1 Ranks Tier 1 (Error Log) > Tier 2 (Prompt Mention) > Tier 3 (Git Modified) > Tier 4 (1-Hop Import)', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'src', 'utils'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'src', 'crash.ts'),
        `import { helper } from './utils/helper';\nexport function crash() { return helper(); }\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'utils', 'helper.ts'),
        `export function helper() { return 42; }\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'prompted.ts'),
        `export const prompted = true;\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'modified.ts'),
        `export const modified = true;\n`,
        'utf8'
      );

      const ranked = ContextFileRanker.rankFiles({
        projectRoot: tmp,
        modifiedFiles: ['src/modified.ts'],
        errorLog: 'TypeError: fail at crash (src/crash.ts:2:15)',
        taskContext: {
          goal: 'Update src/prompted.ts and fix crash',
          immediateNext: [],
          userPrompts: ['Please check src/prompted.ts'],
        },
        maxFiles: 10,
      });

      assert.equal(ranked[0], 'src/crash.ts', 'Tier 1 error log file should be ranked #1 (+100)');
      assert.equal(ranked[1], 'src/prompted.ts', 'Tier 2 prompt-mentioned file should be ranked #2 (+80)');
      assert.equal(ranked[2], 'src/utils/helper.ts', '1-hop import of crashing file gets +65 priority');
      assert.equal(ranked[3], 'src/modified.ts', 'Unrelated git-modified file gets +50 priority');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('2.2 Expands Python relative imports and CommonJS require() while blocking path traversal', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'pkg', 'main.py'),
        `from .submod import run_task\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmp, 'pkg', 'submod.py'),
        `def run_task():\n    return True\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmp, 'pkg', 'cjs.js'),
        `const dep = require('./dep');\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmp, 'pkg', 'dep.js'),
        `module.exports = {};\n`,
        'utf8'
      );

      const ranked = ContextFileRanker.rankFiles({
        projectRoot: tmp,
        modifiedFiles: ['pkg/main.py', 'pkg/cjs.js', '../../../etc/passwd'],
        errorLog: 'Error in ../../../etc/shadow:1:1',
        taskContext: { goal: 'Check ../../secret.key' },
        maxFiles: 10,
      });

      assert.ok(ranked.includes('pkg/main.py'));
      assert.ok(ranked.includes('pkg/submod.py'));
      assert.ok(ranked.includes('pkg/cjs.js'));
      assert.ok(ranked.includes('pkg/dep.js'));
      assert.ok(!ranked.some((f) => f.includes('..') || f.includes('passwd') || f.includes('shadow')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 3. BATON IA BUILDER U-SHAPED ZONES, BUDGETS & SECRET SEALING MATRIX
// ============================================================================

test('BatonIaBuilder — U-Shaped Attention Zones, Token Budgets & Final Secret Sealing', async (t) => {
  const BUDGET_CASES = [300, 800, 2000, 4000, 12000];

  for (const budget of BUDGET_CASES) {
    await t.test(`3.1 BatonIaBuilder respects structure and seals secrets at budgetTokens=${budget}`, () => {
      const tmp = makeTempDir();
      try {
        initGitRepo(tmp);
        fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
        const longFnBody = Array.from({ length: 30 }, (_, i) => `  const step${i} = ${i} * 2;`).join('\n');
        fs.writeFileSync(
          path.join(tmp, 'src', 'engine.ts'),
          `export function computeHeavyMatrix(input: number): number {\n${longFnBody}\n  return input;\n}\n`,
          'utf8'
        );
        execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'init engine'], { cwd: tmp, stdio: 'ignore' });

        // Modify file with uncommitted diff
        fs.writeFileSync(
          path.join(tmp, 'src', 'engine.ts'),
          `export function computeHeavyMatrix(input: number): number {\n${longFnBody}\n  return input + 1;\n}\n`,
          'utf8'
        );

        const fakeKey = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4';
        const baton = BatonIaBuilder.build({
          projectRoot: tmp,
          sourceAgent: 'claude',
          targetAgent: 'codex',
          role: 'architect',
          budgetTokens: budget,
          errorLog: `Error: Auth failed with token ${fakeKey}\n    at computeHeavyMatrix (src/engine.ts:12:5)`,
          taskContext: {
            goal: `Fix auth token ${fakeKey} handling in computeHeavyMatrix`,
            immediateNext: [`Rotate ${fakeKey} and update unit tests`],
            done: [`Inspected legacy key ${fakeKey}`],
            userPrompts: ['Fix auth token handling'],
          },
        });

        // Verify U-Shaped 3-Zone headers exist in strict order
        const idxGoal = baton.markdown.indexOf('## 1. Goal');
        const idxNext = baton.markdown.indexOf('## 2. Immediate NEXT');
        const idxDone = baton.markdown.indexOf('## 3. Done');
        const idxWork = baton.markdown.indexOf('## 4. Work Evidence');
        const idxArch = baton.markdown.indexOf('## 5. Architectural Context');
        const idxLedger = baton.markdown.indexOf('## 6. Diet Ledger & Rehydration Index');
        const idxAnchor = baton.markdown.indexOf('EXECUTION ANCHOR:');

        assert.ok(idxGoal > 0);
        assert.ok(idxNext > idxGoal);
        assert.ok(idxDone > idxNext);
        assert.ok(idxWork > idxDone);
        assert.ok(idxArch > idxWork);
        assert.ok(idxLedger > idxArch);
        assert.ok(idxAnchor > idxLedger);

        // Role tag included
        assert.match(baton.markdown, /Role: ARCHITECT/);

        // Secret must be completely redacted from both markdown and baton.json
        assert.ok(!baton.markdown.includes(fakeKey), 'Raw secret must never appear in BATON.md');
        assert.ok(!JSON.stringify(baton.json).includes(fakeKey), 'Raw secret must never appear in baton.json');
        assert.ok(baton.redactedCount >= 1);

        // Verify files persisted on disk
        assert.ok(fs.existsSync(baton.batonMdPath));
        assert.ok(fs.existsSync(baton.batonJsonPath));
        assert.ok(fs.existsSync(path.join(tmp, '.vicem', 'ledger.json')));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

// ============================================================================
// 4. 3-PILLAR SAFETY GUARDS & SNAPSHOT RECOVERY MATRIX
// ============================================================================

const SKELETON_GUARD_MATRIX = [
  {
    name: '4.1 Blocks C_BLOCK_ELLIPSIS /* ... */ in added diff line of .ts file',
    input: `+++ b/src/service.ts\n@@ -10,2 +10,3 @@\n+function login() { /* ... */ }`,
    file: 'src/service.ts',
    shouldBlock: true,
    expectedRule: 'C_BLOCK_ELLIPSIS',
  },
  {
    name: '4.2 Blocks BRACE_ELLIPSIS { ... } in raw code snippet',
    input: `export class UserController {\n  async handle() { ... }\n}`,
    file: 'src/controller.js',
    shouldBlock: true,
    expectedRule: 'BRACE_ELLIPSIS',
  },
  {
    name: '4.3 Blocks VERTICAL_ELLIPSIS ⋮ in code',
    input: `def compute():\n    ⋮\n    return 0`,
    file: 'src/compute.py',
    shouldBlock: true,
    expectedRule: 'VERTICAL_ELLIPSIS',
  },
  {
    name: '4.4 Blocks COMMENT_OMITTED // ... rest of implementation',
    input: `function process() {\n  // ... rest of implementation\n}`,
    file: 'src/proc.ts',
    shouldBlock: true,
    expectedRule: 'COMMENT_OMITTED',
  },
  {
    name: '4.5 Blocks PYTHON_STUB_PASS def fn(): pass',
    input: `def authenticate_user(token):\n    pass # ...`,
    file: 'src/auth.py',
    shouldBlock: true,
    expectedRule: 'PYTHON_STUB_PASS',
  },
  {
    name: '4.6 Allows removed (-) diff lines containing /* ... */',
    input: `+++ b/src/clean.ts\n@@ -5,2 +5,2 @@\n-function old() { /* ... */ }\n+function old() { return true; }`,
    file: 'src/clean.ts',
    shouldBlock: false,
    expectedRule: null,
  },
  {
    name: '4.7 Exempts documentation files (.md, .txt, .rst, .adoc) from skeleton false positives',
    input: `+++ b/README.md\n@@ -1,2 +1,3 @@\n+Example skeleton: \`function foo() { /* ... */ }\``,
    file: 'README.md',
    shouldBlock: false,
    expectedRule: null,
  },
  {
    name: '4.8 Allows valid JavaScript object spread {...props} without spaces around ellipsis',
    input: `+++ b/src/App.tsx\n@@ -1,2 +1,2 @@\n+const merged = { ...defaults, ...override };`,
    file: 'src/App.tsx',
    shouldBlock: false,
    expectedRule: null,
  },
];

test('SafetyGuardEngine, SkeletonWriteGuard, SecretCommitGuard & PreHandoffSnapshotStore Matrix', async (t) => {
  for (const c of SKELETON_GUARD_MATRIX) {
    await t.test(c.name, () => {
      const violations = SkeletonWriteGuard.check(c.input, c.file);
      if (c.shouldBlock) {
        assert.ok(violations.length > 0, `Expected violation for ${c.name}`);
        assert.equal(violations[0].rule, c.expectedRule);
      } else {
        assert.equal(violations.length, 0, `Expected 0 violations for ${c.name}, got ${JSON.stringify(violations)}`);
      }
    });
  }

  await t.test('4.9 SecretCommitGuard blocks leaked ‹REDACTED:...› tokens and <!-- VICEM-BATON-START --> markers', () => {
    const diff = [
      '+++ b/src/config.ts',
      '@@ -1,2 +1,4 @@',
      '+const apiKey = "‹REDACTED:OPENAI_KEY:9f2a›";',
      '+// <!-- VICEM-BATON-START -->',
    ].join('\n');

    const v = SecretCommitGuard.check(diff);
    assert.equal(v.length, 2);
    assert.equal(v[0].type, 'REDACTED_TOKEN_LEAK');
    assert.equal(v[1].type, 'MOUNT_MARKER_LEAK');

    // Verify recovery messages and self-heal prompt formatting
    assert.match(UxFormatter.renderGuardRecovery(v[0], { NO_COLOR: '1' }), /Blocked leaked redaction token/);
    assert.match(UxFormatter.renderGuardRecovery(v[1], { NO_COLOR: '1' }), /Blocked temporary mount marker/);
    assert.match(
      UxFormatter.renderAgentSelfHealPrompt(
        { type: 'SKELETON_PLACEHOLDER', filePath: 'src/a.ts', line: 10, snippet: '/* ... */' },
        'myFunc'
      ),
      /vicem_rehydrate\("src\/a\.ts", "myFunc"\)/
    );
  });

  await t.test('4.10 SafetyGuardEngine auto-restores corrupted file from PreHandoffSnapshotStore', () => {
    const tmp = makeTempDir();
    try {
      initGitRepo(tmp);
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      const fileRel = 'src/critical.ts';
      const fileAbs = path.join(tmp, fileRel);
      const pristineCode = `export function calculateTax(amount: number): number {\n  return amount * 0.15;\n}\n`;
      fs.writeFileSync(fileAbs, pristineCode, 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'pristine'], { cwd: tmp, stdio: 'ignore' });

      // Save pre-handoff snapshot
      PreHandoffSnapshotStore.saveSnapshot(tmp, 'snap-test-01', [fileRel]);

      // Simulate lazy agent overwriting critical.ts with skeleton placeholder
      fs.writeFileSync(fileAbs, `export function calculateTax(amount: number): number { /* ... */ }\n`, 'utf8');

      // Run SafetyGuardEngine with autoRestore: true
      const checkRes = SafetyGuardEngine.verifyAndProtect(tmp, null, { autoRestore: true });
      assert.equal(checkRes.passed, false);
      assert.ok(checkRes.violations.length > 0);
      assert.ok(checkRes.restoredFiles.includes(fileRel));
      assert.equal(fs.readFileSync(fileAbs, 'utf8'), pristineCode);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.11 StalenessDriftGuard detects when git HEAD moves ahead of baton.json headCommit', () => {
    const tmp = makeTempDir();
    try {
      initGitRepo(tmp);
      fs.writeFileSync(path.join(tmp, 'a.js'), 'const a = 1;\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'c1'], { cwd: tmp, stdio: 'ignore' });

      BatonIaBuilder.build({
        projectRoot: tmp,
        sourceAgent: 'claude',
        targetAgent: 'codex',
        persist: true,
      });

      assert.equal(StalenessDriftGuard.check(tmp).drifted, false);

      // Create a new commit so HEAD changes
      fs.writeFileSync(path.join(tmp, 'a.js'), 'const a = 2;\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'c2'], { cwd: tmp, stdio: 'ignore' });

      const driftAfter = StalenessDriftGuard.check(tmp);
      assert.equal(driftAfter.drifted, true);
      assert.notEqual(driftAfter.batonHead, driftAfter.currentHead);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 5. SMART PATCH APPLIER & WEB LAND ADAPTER 4-STRATEGY MATRIX
// ============================================================================

test('SmartPatchApplier & WebLandAdapter — SEARCH/REPLACE, Unified Diff, Unique Symbol Splice & All-or-Nothing Guard', async (t) => {
  await t.test('5.1 Strategy 1: SEARCH/REPLACE blocks (exact and whitespace-normalized matching)', () => {
    const existing = [
      'export function greet(name) {',
      '  const msg = "Hello " + name;',
      '  return msg;',
      '}',
    ].join('\n');

    const patchBlock = [
      '<<<<<<< SEARCH',
      '  const msg = "Hello " + name;',
      '  return msg;',
      '=======',
      '  const msg = `Welcome, ${name}!`;',
      '  return msg.toUpperCase();',
      '>>>>>>> REPLACE',
    ].join('\n');

    const res = SmartPatchApplier.applySmart(existing, patchBlock, 'ts');
    assert.equal(res.applied, true);
    assert.equal(res.strategy, 'search_replace');
    assert.match(res.content, /Welcome, \$\{name\}!/);

    // Failed search block returns applied: false without corrupting existing content
    const badPatch = [
      '<<<<<<< SEARCH',
      '  nonExistentLine();',
      '=======',
      '  replaced();',
      '>>>>>>> REPLACE',
    ].join('\n');
    const badRes = SmartPatchApplier.applySmart(existing, badPatch, 'ts');
    assert.equal(badRes.applied, false);
    assert.equal(badRes.content, existing);
  });

  await t.test('5.2 Strategy 2: Unified Diff hunk application with shifted line offset tolerance', () => {
    const existing = [
      '// Header line 1',
      '// Header line 2',
      'function add(a, b) {',
      '  return a - b;',
      '}',
      'export default add;',
    ].join('\n');

    // Hunk header says line 1, but actual target is at line 3 (shifted by +2 lines)
    const unifiedDiff = [
      '@@ -1,3 +1,3 @@',
      ' function add(a, b) {',
      '-  return a - b;',
      '+  return a + b;',
      ' }',
    ].join('\n');

    const res = SmartPatchApplier.applySmart(existing, unifiedDiff, 'diff');
    assert.equal(res.applied, true);
    assert.equal(res.strategy, 'unified_diff');
    assert.match(res.content, /return a \+ b;/);
    assert.match(res.content, /\/\/ Header line 1/);
  });

  await t.test('5.3 Strategy 3: Unique Symbol Partial Function Splice vs Duplicate Symbol safety fallback', () => {
    const multiFnFile = [
      'import { log } from "./logger";',
      '',
      'export function alpha() {',
      '  log("alpha 1");',
      '  log("alpha 2");',
      '  return 1;',
      '}',
      '',
      'export function beta() {',
      '  log("beta old 1");',
      '  log("beta old 2");',
      '  return 2;',
      '}',
      '',
      'export function gamma() {',
      '  log("gamma 1");',
      '  log("gamma 2");',
      '  return 3;',
      '}',
    ].join('\n');

    const singleFnUpdate = [
      'export function beta() {',
      '  log("beta updated!");',
      '  return 200;',
      '}',
    ].join('\n');

    const res = SmartPatchApplier.applySmart(multiFnFile, singleFnUpdate, 'ts');
    assert.equal(res.applied, true);
    assert.equal(res.strategy, 'unique_symbol_splice');
    assert.equal(res.symbol, 'beta');
    assert.match(res.content, /export function alpha\(\)/);
    assert.match(res.content, /beta updated!/);
    assert.match(res.content, /export function gamma\(\)/);
  });

  await t.test('5.4 WebLandAdapter All-or-Nothing safety guard rejects entire payload if any block has a placeholder', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      const f1 = path.join(tmp, 'src', 'one.js');
      fs.writeFileSync(f1, 'export const one = 1;\n', 'utf8');

      const webAnswerWithViolation = [
        'Here are the two files:',
        '```js src/one.js',
        'export const one = 100;',
        '```',
        '```js src/two.js',
        'export function two() { /* ... */ }',
        '```',
      ].join('\n');

      const landBad = WebLandAdapter.land(tmp, webAnswerWithViolation, { applyFiles: true });
      assert.equal(landBad.guardPassed, false);
      assert.equal(landBad.appliedFiles.length, 0);
      // src/one.js must remain untouched because All-or-Nothing validation ran BEFORE writing disk!
      assert.equal(fs.readFileSync(f1, 'utf8'), 'export const one = 1;\n');

      const webAnswerClean = [
        '```js src/one.js',
        'export const one = 100;',
        '```',
        '```js',
        '// File: src/two.js',
        'export function two() { return 200; }',
        '```',
      ].join('\n');

      const landGood = WebLandAdapter.land(tmp, webAnswerClean, { applyFiles: true });
      assert.equal(landGood.guardPassed, true);
      assert.deepEqual(landGood.appliedFiles, ['src/one.js', 'src/two.js']);
      assert.match(fs.readFileSync(f1, 'utf8'), /100/);
      assert.match(fs.readFileSync(path.join(tmp, 'src', 'two.js'), 'utf8'), /return 200/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 6. QUOTA RADAR, PTY STREAM INSPECTOR & LIVE CHILD WRAPPER MATRIX
// ============================================================================

const QUOTA_RADAR_CASES = [
  {
    name: '6.1 Detects Claude usage limit banner after 500ms idle',
    chunk: "\x1b[31mYou've hit your limit · resets 4pm (America/Los_Angeles)\x1b[0m",
    idleMs: 600,
    expectTriggered: true,
    expectVendor: 'claude',
  },
  {
    name: '6.2 Detects Claude Prompt is too long banner',
    chunk: 'Error: Prompt is too long (212,400 tokens > 200,000 maximum)',
    idleMs: 500,
    expectTriggered: true,
    expectVendor: 'claude',
  },
  {
    name: '6.3 Detects OpenAI Codex usage/quota limit banner',
    chunk: "Error: You've hit your usage limit for this billing period.",
    idleMs: 550,
    expectTriggered: true,
    expectVendor: 'codex',
  },
  {
    name: '6.4 Detects Gemini RESOURCE_EXHAUSTED quota metric banner',
    chunk: 'Status: RESOURCE_EXHAUSTED: Quota exceeded for quota metric generate_content_requests',
    idleMs: 500,
    expectTriggered: true,
    expectVendor: 'gemini',
  },
  {
    name: '6.5 Detects GitHub Copilot token quota banner',
    chunk: 'Sorry, you have exceeded your Copilot token quota.',
    idleMs: 500,
    expectTriggered: true,
    expectVendor: 'copilot',
  },
  {
    name: '6.6 Ignores quota banner when stream is still actively outputting (< 500ms idle)',
    chunk: "You've hit your limit",
    idleMs: 120,
    expectTriggered: false,
    expectVendor: null,
  },
  {
    name: '6.7 Ignores user prompt echoes (> or $ or Human:) mentioning quota text',
    chunk: "> Why did it say You've hit your limit yesterday?\n$ echo You've hit your usage limit",
    idleMs: 800,
    expectTriggered: false,
    expectVendor: null,
  },
  {
    name: '6.8 Ignores generic HTTP 429 unit test logs',
    chunk: 'PASS test/rate-limit.test.js: expected status 429 Too Many Requests (12ms)',
    idleMs: 1000,
    expectTriggered: false,
    expectVendor: null,
  },
];

test('QuotaRadar, PtyStreamInspector, TtySanitizer & PtyWrapController Live Process Matrix', async (t) => {
  for (const qc of QUOTA_RADAR_CASES) {
    await t.test(qc.name, () => {
      const res = QuotaRadar.detectVendorLimit(qc.chunk, qc.idleMs);
      assert.equal(res.triggered, qc.expectTriggered);
      assert.equal(res.vendor, qc.expectVendor);
    });
  }

  await t.test('6.9 TtySanitizer writes full ANSI terminal reset sequence to stream', () => {
    const out = new PassThrough();
    let captured = '';
    out.on('data', (c) => {
      captured += c.toString('utf8');
    });
    const ok = TtySanitizer.sanitizeTerminal(out, false);
    assert.equal(ok, true);
    assert.equal(captured, TtySanitizer. getResetSequence());
    assert.ok(captured.includes('\x1b[?1049l'));
    assert.ok(captured.includes('\x1b[?25h'));
  });

  await t.test('6.10 PtyWrapController.wrapCommandAsync intercepts live child printing vendor limit and terminates child cleanly', async () => {
    const out = new PassThrough();
    let captured = '';
    out.on('data', (c) => {
      captured += c.toString('utf8');
    });

    const res = await PtyWrapController.wrapCommandAsync(
      process.execPath,
      ['-e', `process.stdout.write("Working...\\nYou've hit your limit\\n"); setTimeout(() => {}, 5000);`],
      {
        idleMs: 60,
        stdout: out,
        fallbackTarget: 'codex',
        env: { ...process.env, NO_COLOR: '1' },
      }
    );

    assert.equal(res.wrapped, true);
    assert.ok(res.intercepted);
    assert.equal(res.intercepted.vendor, 'claude');
    assert.equal(res.fallbackTarget, 'codex');
    assert.match(captured, /\[Vicem Wrap\].*Auto-passing baton to Codex/);
  });

  await t.test('6.11 SessionHistoryStack, CliLauncherAdapter & RuleMountAdapter round-trip', () => {
    const tmp = makeTempDir();
    try {
      // SessionHistoryStack push/pop caps at 20
      for (let i = 1; i <= 25; i++) {
        SessionHistoryStack.pushSession(tmp, { sourceAgent: 'claude', targetAgent: 'codex', seq: i });
      }
      const stack = SessionHistoryStack.loadStack(tmp);
      assert.equal(stack.length, 20);
      assert.equal(stack[stack.length - 1].seq, 25);

      const popped = SessionHistoryStack.popSession(tmp);
      assert.equal(popped.seq, 25);

      // CliLauncherAdapter specs for all CLI agents & modes
      assert.equal(CliLauncherAdapter.buildLaunchSpec('claude', null, { resumeSessionId: 'last' }).args[0], '-c');
      assert.deepEqual(
        CliLauncherAdapter.buildLaunchSpec('claude', null, { resumeSessionId: 'abc-123' }).args,
        ['--resume', 'abc-123']
      );
      assert.equal(CliLauncherAdapter.buildLaunchSpec('claude', null, { headless: true }).mode, 'headless');
      assert.deepEqual(
        CliLauncherAdapter.buildLaunchSpec('codex', null, { resumeSessionId: 'last' }).args,
        ['resume', '--last']
      );
      assert.deepEqual(CliLauncherAdapter.buildLaunchSpec('codex', null, { headless: true }).args, ['exec', '-']);
      assert.deepEqual(
        CliLauncherAdapter.buildLaunchSpec('gemini', null, { resumeSessionId: 'gem-1' }).args,
        ['--resume', 'gem-1']
      );
      assert.equal(CliLauncherAdapter.buildLaunchSpec('aider', null).args[0], '--message');
      assert.equal(CliLauncherAdapter.buildLaunchSpec('goose', null).args[0], 'run');

      // RuleMountAdapter preserves user edits made outside mount markers during unmount
      const agentsMd = path.join(tmp, 'AGENTS.md');
      fs.writeFileSync(agentsMd, '# Team Rules\nAlways write tests.\n', 'utf8');
      RuleMountAdapter.mount(tmp, 'codex', '# BATON: Test');
      // Simulate user adding a rule line above the mounted block
      const mountedContent = fs.readFileSync(agentsMd, 'utf8');
      fs.writeFileSync(agentsMd, '# Custom Header Added While Mounted\n' + mountedContent, 'utf8');

      RuleMountAdapter.unmount(tmp, 'codex');
      const afterUnmount = fs.readFileSync(agentsMd, 'utf8');
      assert.ok(afterUnmount.includes('# Custom Header Added While Mounted'));
      assert.ok(afterUnmount.includes('# Team Rules'));
      assert.ok(!afterUnmount.includes('VICEM-BATON-START'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 7. MCP SERVER ADAPTER JSON-RPC 2.0 & STDIO TRANSPORT MATRIX
// ============================================================================

const MCP_PROTOCOL_MATRIX = [
  {
    name: '7.1 initialize negotiates 2024-11-05 when requested by legacy client',
    req: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    check: (resp) => {
      assert.equal(resp.id, 1);
      assert.equal(resp.result.protocolVersion, '2024-11-05');
      assert.equal(resp.result.serverInfo.name, 'vicem-mcp');
    },
  },
  {
    name: '7.2 initialize defaults to 2025-11-25 for modern clients',
    req: { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    check: (resp) => {
      assert.equal(resp.id, 2);
      assert.equal(resp.result.protocolVersion, '2025-11-25');
    },
  },
  {
    name: '7.3 ping returns empty result object',
    req: { jsonrpc: '2.0', id: 'ping-1', method: 'ping' },
    check: (resp) => {
      assert.equal(resp.id, 'ping-1');
      assert.deepEqual(resp.result, {});
    },
  },
  {
    name: '7.4 tools/list exposes all 4 canonical Vicem MCP tools with JSON schemas',
    req: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    check: (resp) => {
      const names = resp.result.tools.map((t) => t.name);
      assert.deepEqual(names, [
        'vicem_create_baton',
        'vicem_read_baton',
        'vicem_rehydrate',
        'vicem_check_guard',
      ]);
    },
  },
  {
    name: '7.5 notifications (missing id or null id) return null (no stdout frame)',
    req: { jsonrpc: '2.0', method: 'notifications/initialized' },
    check: (resp) => {
      assert.equal(resp, null);
    },
  },
  {
    name: '7.6 unknown method returns JSON-RPC -32601 Method not found',
    req: { jsonrpc: '2.0', id: 99, method: 'resources/subscribe' },
    check: (resp) => {
      assert.equal(resp.id, 99);
      assert.equal(resp.error.code, -32601);
      assert.match(resp.error.message, /Method not found/);
    },
  },
  {
    name: '7.7 unknown tool in tools/call returns JSON-RPC -32601 Unknown tool',
    req: {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name: 'vicem_nonexistent_tool', arguments: {} },
    },
    check: (resp) => {
      assert.equal(resp.id, 100);
      assert.equal(resp.error.code, -32601);
      assert.match(resp.error.message, /Unknown tool/);
    },
  },
];

test('McpServerAdapter — JSON-RPC 2.0 Protocol, Tool Execution & Drift Warnings Matrix', async (t) => {
  const tmp = makeTempDir('vicem-mcp-pipe-');
  try {
    initGitRepo(tmp);
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const body = Array.from({ length: 18 }, (_, i) => `  const v${i} = ${i} + 10;`).join('\n');
    const secret = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
    const srcPath = path.join(tmp, 'src', 'auth.ts');
    fs.writeFileSync(
      srcPath,
      `export function verifyOAuth(token: string): boolean {\n  const s = "${secret}";\n${body}\n  return token === s;\n}\n`,
      'utf8'
    );
    execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init auth'], { cwd: tmp, stdio: 'ignore' });

    // Modify file so GitCollector includes it in modifiedFiles
    fs.writeFileSync(
      srcPath,
      `export function verifyOAuth(token: string): boolean {\n  const s = "${secret}";\n${body}\n  return Boolean(token && s);\n}\n`,
      'utf8'
    );

    const { McpServerAdapter, AtomicFs } = await import('../vicem.mjs');
    const mcp = new McpServerAdapter(tmp);

    for (const item of MCP_PROTOCOL_MATRIX) {
      await t.test(item.name, async () => {
        const resp = await mcp.handleRequest(item.req);
        item.check(resp);
      });
    }

    await t.test('7.8 vicem_read_baton before creation returns isError: true', async () => {
      const resp = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'vicem_read_baton', arguments: {} },
      });
      assert.equal(resp.result.isError, true);
      assert.match(resp.result.content[0].text, /No \.vicem\/BATON\.md found/);
    });

    await t.test('7.9 vicem_create_baton builds BATON.md and populates ledger.json', async () => {
      const resp = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'vicem_create_baton',
          arguments: {
            goal: 'Harden OAuth token verification',
            targetAgent: 'codex',
            budgetTokens: 4000,
          },
        },
      });
      assert.equal(resp.result.isError, false);
      assert.match(resp.result.content[0].text, /# BATON: Harden OAuth token verification/);
      assert.ok(!resp.result.content[0].text.includes(secret));
    });

    await t.test('7.10 vicem_rehydrate supports snake_case and camelCase args, redacts secrets, and detects disk drift', async () => {
      const r1 = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'vicem_rehydrate',
          arguments: { file_path: 'src/auth.ts', symbol_name: 'verifyOAuth' },
        },
      });
      assert.equal(r1.result.isError, false);
      assert.match(r1.result.content[0].text, /export function verifyOAuth/);
      assert.ok(!r1.result.content[0].text.includes(secret));

      // Modify src/auth.ts on disk after ledger snapshot -> triggers disk drift warning
      fs.writeFileSync(
        srcPath,
        `export function verifyOAuth(token: string): boolean {\n  return token.length > 999;\n}\n`,
        'utf8'
      );
      const rDrift = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'vicem_rehydrate',
          arguments: { filePath: 'src/auth.ts', symbolName: 'verifyOAuth' },
        },
      });
      assert.equal(rDrift.result.isError, false);
      assert.match(rDrift.result.content[0].text, /STALENESS DRIFT WARNING/);

      // Missing symbol returns isError: true
      const rMissing = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'vicem_rehydrate',
          arguments: { file_path: 'src/auth.ts', symbol_name: 'nonExistentSymbol' },
        },
      });
      assert.equal(rMissing.result.isError, true);
    });

    await t.test('7.11 vicem_check_guard returns OK on clean diff and self-heal prompt on skeleton violation', async () => {
      const rClean = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: 'vicem_check_guard',
          arguments: { diff_text: '+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n+export const x = 1;' },
        },
      });
      assert.equal(rClean.result.isError, false);
      assert.match(rClean.result.content[0].text, /All 3 Safety Guards passed/);

      const rBad = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: 'vicem_check_guard',
          arguments: { diff_text: '+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n+function broken() { /* ... */ }' },
        },
      });
      assert.equal(rBad.result.isError, true);
      assert.match(rBad.result.content[0].text, /\[VICEM SELF-HEAL\]/);
    });

    await t.test('7.12 startStdio processes newline-delimited JSON-RPC frames and returns -32700 on invalid JSON', async () => {
      const inStream = new PassThrough();
      const outStream = new PassThrough();
      const frames = [];
      outStream.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
          frames.push(JSON.parse(line));
        }
      });

      const rl = mcp.startStdio(inStream, outStream);
      inStream.write('{"jsonrpc":"2.0","id":201,"method":"ping"}\n');
      inStream.write('{THIS IS BROKEN JSON\n');
      inStream.end();

      await new Promise((r) => setTimeout(r, 80));
      rl.close();

      assert.equal(frames.length, 2);
      assert.equal(frames[0].id, 201);
      assert.equal(frames[1].error.code, -32700);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 8. PRE-HANDOFF SNAPSHOT STORE & ATOMIC FS BOUNDARY / CONCURRENCY MATRIX
// ============================================================================

test('PreHandoffSnapshotStore & AtomicFs — Pruning, Tie-Breaking, Lock Recovery & Path Security Matrix', async (t) => {
  await t.test('8.1 PreHandoffSnapshotStore prunes beyond 5 snapshots, skips >2MB & credential files, and tie-breaks same-ms mtime', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'small.ts'), 'export const s = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmp, '.env'), 'SECRET=123\n', 'utf8');
      const hugePath = path.join(tmp, 'src', 'huge.bin');
      fs.writeFileSync(hugePath, Buffer.alloc(2.2 * 1024 * 1024, 0x41));

      // Create 7 snapshots -> pruneOldSnapshots keeps latest 5
      const fixedTime = new Date();
      for (let i = 1; i <= 7; i++) {
        const id = `snap-0${i}`;
        const res = PreHandoffSnapshotStore.saveSnapshot(tmp, id, ['src/small.ts', '.env', 'src/huge.bin', '../escape.ts']);
        assert.deepEqual(res.savedFiles, ['src/small.ts']);
        const dir = PreHandoffSnapshotStore.getSnapshotDir(tmp, id);
        if (fs.existsSync(dir)) {
          fs.utimesSync(dir, fixedTime, fixedTime);
        }
      }

      const snapsRoot = path.join(tmp, '.vicem', 'snapshots');
      const remaining = fs.readdirSync(snapsRoot).sort();
      assert.equal(remaining.length, 5);
      // Deterministic lexicographical tie-breaker when mtime is identical
      assert.equal(PreHandoffSnapshotStore.getLatestSnapshotId(tmp), 'snap-07');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 9. ATOMIC FS LOCK RECOVERY, MICRO TUI SELECTOR & VICEM APP E2E MATRIX
// ============================================================================

test('AtomicFs Lock Recovery, MicroTuiSelector & VicemApp Multi-Subcommand Matrix', async (t) => {
  const { AtomicFs, MicroTuiSelector, VicemApp } = await import('../vicem.mjs');

  await t.test('9.1 AtomicFs.acquireLock recovers from stale dead-PID lockfile and releases cleanly', () => {
    const tmp = makeTempDir();
    try {
      const vicemDir = AtomicFs.ensureVicemDir(tmp);
      const lockPath = path.join(vicemDir, 'lock');
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 99999991, timestamp: Date.now() - 120000 }),
        'utf8'
      );

      const acquired = AtomicFs.acquireLock(tmp, 500);
      assert.equal(acquired, lockPath);
      assert.ok(fs.existsSync(lockPath));

      AtomicFs.releaseLock(tmp);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('9.2 AtomicFs.isSafeRepoFilePath rejects null bytes, UNC paths, Windows drive letters, .git internals, and escaping symlinks', () => {
    const tmp = makeTempDir();
    const outside = makeTempDir('outside-');
    try {
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'src/valid.ts'), true);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, ''), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, null), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'src/bad\0file.ts'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '\\Windows\\System32\\cmd.exe'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '\\\\server\\share\\file.txt'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'C:\\Windows\\win.ini'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '../outside.txt'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.git/config'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.git/hooks/pre-commit'), false);

      // Symlink pointing outside repo must be rejected
      const outsideFile = path.join(outside, 'secret.txt');
      fs.writeFileSync(outsideFile, 'top-secret\n', 'utf8');
      const linkPath = path.join(tmp, 'evil-link.txt');
      fs.symlinkSync(outsideFile, linkPath);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'evil-link.txt'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test('9.3 MicroTuiSelector returns recommended target immediately in non-TTY mode', async () => {
    const chosen = await MicroTuiSelector.selectTarget({
      sourceAgent: 'claude',
      recommended: 'codex',
      candidates: ['codex', 'antigravity', 'web', 'self'],
      isTTY: false,
    });
    assert.equal(chosen, 'codex');
  });

  const CLI_WORKFLOW_MATRIX = [
    {
      name: '9.4 VicemApp init installs pre-commit hook and .vicem directory',
      args: ['init'],
      verify: (res, tmp) => {
        assert.equal(res.exitCode, 0);
        assert.ok(fs.existsSync(path.join(tmp, '.git', 'hooks', 'pre-commit')));
      },
    },
    {
      name: '9.5 VicemApp doctor runs zero-spawn environment diagnostics',
      args: ['doctor'],
      verify: (res) => {
        assert.equal(res.exitCode, 0);
        assert.match(res.stdout, /Vicem Doctor Diagnostics/);
      },
    },
    {
      name: '9.6 VicemApp self builds self-compaction baton',
      args: ['self', '--goal', 'Compact context window for current session'],
      verify: (res, tmp) => {
        assert.equal(res.exitCode, 0);
        assert.ok(fs.existsSync(path.join(tmp, '.vicem', 'BATON.md')));
        assert.match(fs.readFileSync(path.join(tmp, '.vicem', 'BATON.md'), 'utf8'), /Target: self/);
      },
    },
    {
      name: '9.7 VicemApp build creates builder role baton',
      args: ['build', 'codex', '--goal', 'Implement high-throughput parser'],
      verify: (res, tmp) => {
        assert.equal(res.exitCode, 0);
        const md = fs.readFileSync(path.join(tmp, '.vicem', 'BATON.md'), 'utf8');
        assert.match(md, /Role: BUILDER/);
      },
    },
    {
      name: '9.8 VicemApp review creates reviewer role baton',
      args: ['review', 'claude', '--goal', 'Audit security boundaries'],
      verify: (res, tmp) => {
        assert.equal(res.exitCode, 0);
        const md = fs.readFileSync(path.join(tmp, '.vicem', 'BATON.md'), 'utf8');
        assert.match(md, /Role: REVIEWER/);
      },
    },
    {
      name: '9.9 VicemApp fan-out and fan-in orchestrate multi-agent parallel batons without self-inclusion',
      args: ['fan-out', 'claude,codex,gemini', '--goal', 'Parallel subsystem refactor'],
      verify: async (res, tmp) => {
        assert.equal(res.exitCode, 0);
        assert.ok(fs.existsSync(path.join(tmp, '.vicem', 'BATON.claude.md')));
        assert.ok(fs.existsSync(path.join(tmp, '.vicem', 'BATON.codex.md')));
        assert.ok(fs.existsSync(path.join(tmp, '.vicem', 'BATON.gemini.md')));

        const fanInRes = await VicemApp.run(['fan-in'], {
          projectRoot: tmp,
          skipLaunch: true,
          env: { ...process.env, NO_COLOR: '1' },
        });
        assert.equal(fanInRes.exitCode, 0);
        assert.equal(fanInRes.mergedCount, 3);
        const mergedMd = fs.readFileSync(path.join(tmp, '.vicem', 'BATON.md'), 'utf8');
        assert.match(mergedMd, /<!-- SOURCE: BATON\.claude\.md -->/);
        assert.match(mergedMd, /<!-- SOURCE: BATON\.codex\.md -->/);
        assert.match(mergedMd, /<!-- SOURCE: BATON\.gemini\.md -->/);
      },
    },
    {
      name: '9.10 VicemApp export-team writes sanitized TEAM_BATON.md without machine-local paths',
      args: ['export-team'],
      verify: (res, tmp) => {
        assert.equal(res.exitCode, 0);
        const teamPath = path.join(tmp, '.vicem', 'TEAM_BATON.md');
        assert.ok(fs.existsSync(teamPath));
        const content = fs.readFileSync(teamPath, 'utf8');
        assert.ok(!content.includes(os.homedir()));
      },
    },
    {
      name: '9.11 VicemApp mount and unmount manage target rule files cleanly',
      args: ['mount', 'cursor'],
      verify: async (res, tmp) => {
        assert.equal(res.exitCode, 0);
        assert.ok(fs.existsSync(path.join(tmp, '.cursorrules')));
        const unRes = await VicemApp.run(['unmount'], {
          projectRoot: tmp,
          skipLaunch: true,
          env: { ...process.env, NO_COLOR: '1' },
        });
        assert.equal(unRes.exitCode, 0);
        assert.equal(fs.existsSync(path.join(tmp, '.cursorrules')), false);
      },
    },
    {
      name: '9.12 VicemApp guard passes on clean working tree',
      args: ['guard'],
      verify: (res) => {
        assert.equal(res.exitCode, 0);
      },
    },
  ];

  const tmpRepo = makeTempDir('vicem-cli-e2e-');
  try {
    initGitRepo(tmpRepo);
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'index.ts'), 'export const v = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, stdio: 'ignore' });

    for (const step of CLI_WORKFLOW_MATRIX) {
      await t.test(step.name, async () => {
        let stdout = '';
        let stderr = '';
        const res = await VicemApp.run(step.args, {
          projectRoot: tmpRepo,
          skipLaunch: true,
          env: { ...process.env, NO_COLOR: '1' },
          stdout: { write: (s) => { stdout += s; } },
          stderr: { write: (s) => { stderr += s; } },
        });
        await step.verify({ ...res, stdout, stderr }, tmpRepo);
      });
    }
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

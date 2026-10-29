import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {
  AtomicFs,
  CodeSkeletonizer,
  DietLedger,
  GitCollector,
  SafetyGuardEngine,
  SkeletonWriteGuard,
  RuleMountAdapter,
  VicemApp,
} from '../vicem.mjs';

test('Phase 8.5 - BUG-01: SafetyGuardEngine inspects STAGED git diff so `git add . && vicem guard` never bypasses protection', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p85-bug01-'));
  try {
    childProcess.execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: tmpDir, stdio: 'ignore' });

    const srcFile = path.join(tmpDir, 'auth.ts');
    fs.writeFileSync(srcFile, 'export function verify() {\n  return true;\n}\n', 'utf8');
    childProcess.execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'ignore' });

    // Write skeleton placeholder AND stage it via `git add .` (so unstaged diff is empty!)
    fs.writeFileSync(srcFile, 'export function verify() { /* ... */ }\n', 'utf8');
    childProcess.execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });

    const res = SafetyGuardEngine.verifyAndProtect(tmpDir, null, { autoRestore: false });
    assert.equal(res.passed, false, 'Staged placeholder write MUST be caught by SafetyGuardEngine');
    assert.ok(res.violations.some((v) => v.type === 'SKELETON_PLACEHOLDER'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8.5 - BUG-02 & BUG-03: CodeSkeletonizer handles nested template literals `${`...`}` and preserves multiline function signatures in Ledger', () => {
  const ledger = new DietLedger();
  const complexTs = [
    'export async function processOrder(',
    '  orderId: string,',
    '  items: Array<{ id: string; qty: number }>,',
    '  onProgress?: (pct: number) => void',
    '): Promise<string> {',
    '  const nestedMsg = `Order ${orderId}: ${items.map((it) => `{${it.id}:${it.qty}}`).join(", ")}`;',
    '  const line7 = 7;',
    '  const line8 = 8;',
    '  const line9 = 9;',
    '  const line10 = 10;',
    '  const line11 = 11;',
    '  const line12 = 12;',
    '  const line13 = 13;',
    '  return nestedMsg;',
    '}',
    '',
    'export class AfterClass {',
    '  keepMe() { return 42; }',
    '}',
  ].join('\n');

  const { skeleton } = CodeSkeletonizer.skeletonize('src/order.ts', complexTs, { ledger });
  assert.ok(skeleton.includes('/* ... */'), 'Multiline function with arrow callback param must be skeletonized');
  assert.ok(skeleton.includes('export class AfterClass'), 'Subsequent class after nested template literal must remain intact');

  // Verify Ledger preserved the ENTIRE multiline signature starting from `export async function processOrder(`
  const rehydrated = ledger.getEntry('src/order.ts', 'processOrder');
  assert.ok(rehydrated, 'processOrder must be registered in DietLedger');
  assert.ok(
    rehydrated.startsWith('export async function processOrder('),
    `Rehydrated code must include the first line of multiline signature, got: ${rehydrated.slice(0, 60)}`
  );
  assert.ok(rehydrated.includes('return nestedMsg;'));
});

test('Phase 8.5 - BUG-04: GitCollector accurately parses file paths containing spaces', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p85-bug04-'));
  try {
    childProcess.execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: tmpDir, stdio: 'ignore' });

    const subDir = path.join(tmpDir, 'src', 'my component');
    fs.mkdirSync(subDir, { recursive: true });
    const spacedFile = path.join(subDir, 'user view.tsx');
    fs.writeFileSync(spacedFile, 'export const v = 1;\n', 'utf8');
    childProcess.execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    // Modify file with spaces in path
    fs.writeFileSync(spacedFile, 'export const v = 2;\n', 'utf8');
    const git = GitCollector.collect(tmpDir);
    assert.ok(
      git.modifiedFiles.includes('src/my component/user view.tsx'),
      `Expected full spaced path, got: ${JSON.stringify(git.modifiedFiles)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8.5 - BUG-05: RuleMountAdapter.unmount preserves external user edits made while baton was mounted', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p85-bug05-'));
  try {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# Original Rules\nRule 1\n', 'utf8');

    RuleMountAdapter.mount(tmpDir, 'antigravity', '# BATON\nGoal: Test');

    // Simulate user adding "Rule 2 (User Edit)" while the baton is mounted
    const current = fs.readFileSync(agentsPath, 'utf8');
    const userEdited = current.replace('Rule 1\n', 'Rule 1\nRule 2 (Added by User while mounted)\n');
    fs.writeFileSync(agentsPath, userEdited, 'utf8');

    // Unmount and verify user's edit is preserved while baton markers are stripped
    RuleMountAdapter.unmount(tmpDir, 'antigravity');
    const finalContent = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(!finalContent.includes('<!-- VICEM-BATON-START -->'), 'Baton marker must be removed');
    assert.ok(
      finalContent.includes('Rule 2 (Added by User while mounted)'),
      'User edits made outside markers while mounted MUST be preserved'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8.5 - BUG-06, BUG-08, BUG-09: Worktree .git file exclude, Doc file guard exemption, and `vicem harvest` / `resume` routing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p85-misc-'));
  try {
    // 1. Simulate Git Worktree where `.git` is a file pointing to a real gitdir
    const fakeGitDir = path.join(tmpDir, 'real_git_dir');
    fs.mkdirSync(path.join(fakeGitDir, 'info'), { recursive: true });
    const worktreeRoot = path.join(tmpDir, 'worktree');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${fakeGitDir}\n`, 'utf8');

    const okExclude = AtomicFs.ensureGitInfoExclude(worktreeRoot);
    assert.equal(okExclude, true, 'Must resolve worktree .git file pointer');
    assert.ok(fs.readFileSync(path.join(fakeGitDir, 'info', 'exclude'), 'utf8').includes('.vicem/'));

    // 2. BUG-08: Markdown docs (.md) must not trigger SkeletonWriteGuard false positives
    const docDiff = `+++ b/docs/guide.md\n@@ -1,1 +1,2 @@\n+Example skeleton: \`function foo() { /* ... */ }\``;
    const docViolations = SkeletonWriteGuard.check(docDiff);
    assert.equal(docViolations.length, 0, 'Markdown files must be exempt from SkeletonWriteGuard');

    // 3. BUG-09: `vicem harvest` and `vicem resume --dry-run` subcommands
    let out = '';
    const stdout = { write: (s) => (out += s) };
    const harvRes = await VicemApp.run(['harvest'], {
      projectRoot: worktreeRoot,
      env: { NO_COLOR: '1' },
      stdout,
    });
    assert.equal(harvRes.exitCode, 0);
    assert.equal(harvRes.mode, 'harvest');
    assert.ok(out.includes('[Vicem Harvest]'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

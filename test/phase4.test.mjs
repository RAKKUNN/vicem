import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  BatonIaBuilder,
  PreHandoffSnapshotStore,
  SkeletonWriteGuard,
  SecretCommitGuard,
  SafetyGuardEngine,
} from '../vicem.mjs';

test('TC-UX-04: BatonIaBuilder constructs U-Shaped Attention IA (Top Primacy, Middle Evidence, Bottom Recency Anchor) and masks secrets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p4-ia-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const authFile = path.join(srcDir, 'auth.ts');
    const longMethodLines = [
      'export class AuthService {',
      '  public async verifySessionToken(token: string): Promise<boolean> {',
      '    const apiKey = "sk-proj-abcde12345abcde12345abcde12345abcde12345abcde";',
      '    if (!token) return false;',
      '    const parts = token.split(".");',
      '    if (parts.length !== 3) return false;',
      '    const header = parts[0];',
      '    const payload = parts[1];',
      '    const signature = parts[2];',
      '    if (!header || !payload || !signature) return false;',
      '    const valid = signature.length > 5;',
      '    const isNotExpired = true;',
      '    const isAllowed = valid && isNotExpired;',
      '    return isAllowed;',
      '  }',
      '}',
    ];
    fs.writeFileSync(authFile, longMethodLines.join('\n'), 'utf8');

    const baton = BatonIaBuilder.build({
      projectRoot: tmpDir,
      sourceAgent: 'claude',
      targetAgent: 'codex',
      taskContext: {
        goal: 'Implement secure session verification in src/auth.ts',
        done: ['Created AuthService class skeleton'],
        immediateNext: ['Add unit tests for verifySessionToken', 'Run npm test'],
      },
      gitContext: {
        isGitRepo: true,
        branch: 'feat/auth',
        headCommit: 'a1b2c3d',
        modifiedFiles: ['src/auth.ts'],
        untrackedFiles: [],
        diffSummary: '1 file changed',
        diffPatch: '@@ -1,3 +1,5 @@\n+export class AuthService {}',
      },
      budgetTokens: 4000,
    });

    const md = baton.markdown;
    const len = md.length;

    // 1. Top Primacy Zone: Goal and Immediate NEXT must appear near the very top
    const goalIdx = md.indexOf('## 1. Goal');
    const nextIdx = md.indexOf('## 2. Immediate NEXT');
    const doneIdx = md.indexOf('## 3. Done');
    const evidenceIdx = md.indexOf('## 4. Work Evidence');
    const archIdx = md.indexOf('## 5. Architectural Context');
    const anchorIdx = md.indexOf('⚡ **EXECUTION ANCHOR:**');

    assert.ok(goalIdx > 0 && goalIdx < len * 0.25, 'Goal must be in Top Primacy Zone');
    assert.ok(nextIdx > goalIdx && nextIdx < doneIdx, 'Immediate NEXT must precede Done');
    assert.ok(doneIdx < evidenceIdx && evidenceIdx < archIdx, 'Middle Evidence Zone ordered properly');
    assert.ok(anchorIdx > archIdx && anchorIdx > len * 0.75, 'Execution Anchor must be in Bottom Recency Zone');

    // 2. Secret Redactor must have masked the OpenAI key
    assert.equal(md.includes('sk-proj-abcde12345'), false);
    assert.ok(baton.redactedCount >= 1);

    // 3. Files written atomically to .vicem/BATON.md and .vicem/baton.json
    assert.ok(fs.existsSync(baton.batonMdPath));
    assert.ok(fs.existsSync(baton.batonJsonPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-GUARD-01: SkeletonWriteGuard detects placeholder writes and PreHandoffSnapshotStore restores uncommitted work without loss', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p4-guard-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const targetFile = path.join(srcDir, 'auth.ts');

    // Developer has 50 lines of UNCOMMITTED valid code before handoff
    const uncommittedValidCode = Array.from(
      { length: 50 },
      (_, i) => `export const validLine_${i + 1} = "uncommitted_work_${i + 1}";`
    ).join('\n');
    fs.writeFileSync(targetFile, uncommittedValidCode, 'utf8');

    // Save pre-handoff snapshot
    const batonId = 'baton-snap-test';
    PreHandoffSnapshotStore.saveSnapshot(tmpDir, batonId, ['src/auth.ts']);

    // Now the target AI agent hallucinates and overwrites src/auth.ts with a skeleton placeholder /* ... */
    const corruptedCode = `export function verifyToken() { /* ... */ }\n`;
    fs.writeFileSync(targetFile, corruptedCode, 'utf8');

    const diffPatch = [
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,50 +1,1 @@',
      '+export function verifyToken() { /* ... */ }',
    ].join('\n');

    const report = SafetyGuardEngine.verifyAndProtect(tmpDir, diffPatch, {
      autoRestore: true,
      batonId,
    });

    assert.equal(report.passed, false);
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].type, 'SKELETON_PLACEHOLDER');
    assert.ok(report.restoredFiles.includes('src/auth.ts'));

    // Verify all 50 uncommitted valid lines are 100% restored!
    const restoredContent = fs.readFileSync(targetFile, 'utf8');
    assert.equal(restoredContent, uncommittedValidCode);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-GUARD-02: SecretCommitGuard blocks leaked ‹REDACTED› tokens and temporary mount markers', () => {
  const diffWithLeaks = [
    '+++ b/src/config.ts',
    '@@ -10,1 +10,2 @@',
    '+const key = "‹REDACTED:OPENAI:1a2b›";',
    '+<!-- VICEM-BATON-START -->',
  ].join('\n');

  const violations = SecretCommitGuard.check(diffWithLeaks);
  assert.equal(violations.length, 2);
  assert.equal(violations[0].type, 'REDACTED_TOKEN_LEAK');
  assert.equal(violations[1].type, 'MOUNT_MARKER_LEAK');
});

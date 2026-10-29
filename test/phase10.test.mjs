import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WebLandAdapter,
  PtyStreamInspector,
  PtyWrapController,
} from '../vicem.mjs';

test('Phase 10 - TC-ADV-03 (Fix 10-B): WebLandAdapter enforces 2-Phase Atomic All-or-Nothing Guard and supports Unique Symbol Splice, SEARCH/REPLACE, and Unified Diff', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p10-land-'));
  try {
    const authFile = path.join(tmpDir, 'src/auth.ts');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });

    const originalCode = [
      'export interface AuthUser {',
      '  id: string;',
      '  role: string;',
      '}',
      '',
      'export function validateSession(token: string): boolean {',
      '  if (!token) return false;',
      '  return token.startsWith("old_");',
      '}',
      '',
      'export function formatUser(u: AuthUser): string {',
      '  return `${u.id}:${u.role}`;',
      '}',
    ].join('\n');
    fs.writeFileSync(authFile, originalCode, 'utf8');

    // 1. Test Unique Symbol Partial Function Splice:
    // Web AI replies with ONLY the updated `validateSession` function (4 lines vs 14-line file).
    const partialReply = [
      'Here is the updated function:',
      '```ts src/auth.ts',
      'export function validateSession(token: string): boolean {',
      '  if (!token || token.length < 10) return false;',
      '  return token.startsWith("v2_");',
      '}',
      '```',
    ].join('\n');

    const res1 = WebLandAdapter.land(tmpDir, partialReply, { applyFiles: true });
    assert.equal(res1.guardPassed, true);
    assert.equal(res1.strategies[0].strategy, 'unique_symbol_splice');

    const afterSplice = fs.readFileSync(authFile, 'utf8');
    assert.ok(afterSplice.includes('export interface AuthUser'), 'Top interface must be preserved');
    assert.ok(afterSplice.includes('token.startsWith("v2_")'), 'Target function must be updated');
    assert.ok(afterSplice.includes('export function formatUser'), 'Bottom function must be preserved');

    // 2. Test SEARCH / REPLACE block strategy
    const srReply = [
      '```ts src/auth.ts',
      '<<<<<<< SEARCH',
      '  return `${u.id}:${u.role}`;',
      '=======',
      '  return `[${u.role}] ${u.id}`;',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n');
    const res2 = WebLandAdapter.land(tmpDir, srReply, { applyFiles: true });
    assert.equal(res2.strategies[0].strategy, 'search_replace');
    assert.ok(fs.readFileSync(authFile, 'utf8').includes('return `[${u.role}] ${u.id}`;'));

    // 3. Test 2-Phase Atomic All-or-Nothing Abort when Block #2 has a skeleton placeholder (`/* ... */`)
    const beforeAbortContent = fs.readFileSync(authFile, 'utf8');
    const multiBlockPoisoned = [
      '```ts src/auth.ts',
      'export const cleanChange = 1;',
      '```',
      '```ts src/other.ts',
      'export function broken() { /* ... */ }',
      '```',
    ].join('\n');

    const res3 = WebLandAdapter.land(tmpDir, multiBlockPoisoned, { applyFiles: true });
    assert.equal(res3.guardPassed, false, 'Must fail guard check');
    assert.equal(res3.appliedFiles.length, 0, '0 files must be modified when any block fails guard');
    assert.equal(
      fs.readFileSync(authFile, 'utf8'),
      beforeAbortContent,
      'Block #1 file must remain completely untouched when Block #2 fails guard'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 10 - TC-ADV-04 (Fix 10-A): PtyStreamInspector ignores user prompt echoes (`> ...`) and PtyWrapController intercepts real vendor limit banners asynchronously', async () => {
  // 1. User prompt echo (`> You've hit your limit`) must NOT false-trigger QuotaRadar
  let triggeredCount = 0;
  const inspector = new PtyStreamInspector({
    idleMs: 20,
    onLimitDetected: () => {
      triggeredCount++;
    },
  });

  inspector.pushChunk(`> Why did it say "You've hit your limit" yesterday?\n`);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(triggeredCount, 0, 'User prompt echo starting with `> ` must not trigger QuotaRadar');

  // 2. Real vendor banner triggers after idleMs
  inspector.pushChunk(`Error: You've hit your limit for Claude Opus.\n`);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(triggeredCount, 1, 'Real vendor limit banner must trigger after idle threshold');
  inspector.dispose();

  // 3. Async child process wrapper test
  let capturedOut = '';
  const mockOut = { write: (s) => (capturedOut += s) };
  const wrapRes = await PtyWrapController.wrapCommandAsync(
    process.execPath,
    ['-e', `process.stdout.write("You've hit your usage limit for Codex.\\n");`],
    {
      idleMs: 20,
      stdout: mockOut,
      env: { ...process.env, NO_COLOR: '1' },
      fallbackTarget: 'claude',
    }
  );
  assert.ok(wrapRes.intercepted, 'Async PTY wrapper must intercept vendor limit');
  assert.equal(wrapRes.intercepted.vendor, 'codex');
  assert.ok(capturedOut.includes('[Vicem Wrap]'), 'Must print countdown prompt after child termination');
});

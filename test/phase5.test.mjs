import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UxFormatter,
  SessionHistoryStack,
  CliLauncherAdapter,
  RuleMountAdapter,
  ClipboardAdapter,
  UrlPrefillAdapter,
  WebLandAdapter,
} from '../vicem.mjs';

test('Phase 5 - TC-DELIV-01: RuleMountAdapter mounts and unmounts AGENTS.md with 0-byte diff', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p5-mount-'));
  try {
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    const originalContent = `# Project Instructions\nAlways use strict TypeScript and run tests before committing.\n`;
    fs.writeFileSync(agentsPath, originalContent, 'utf8');

    const batonMd = `# BATON: Fix Auth\n## 1. Goal\nFix JWT expiration bug.`;
    const mountRes = RuleMountAdapter.mount(tmpDir, 'antigravity', batonMd);
    assert.equal(mountRes.mounted, true);

    const mountedContent = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(mountedContent.includes(originalContent), 'Must preserve existing AGENTS.md content');
    assert.ok(mountedContent.includes('<!-- VICEM-BATON-START -->'), 'Must contain start marker');
    assert.ok(mountedContent.includes('# BATON: Fix Auth'), 'Must contain baton markdown');
    assert.ok(mountedContent.includes('<!-- VICEM-BATON-END -->'), 'Must contain end marker');

    // Unmount and verify byte-exact restoration
    const unmountRes = RuleMountAdapter.unmount(tmpDir, 'antigravity');
    assert.equal(unmountRes.unmounted, true);
    const restoredContent = fs.readFileSync(agentsPath, 'utf8');
    assert.equal(
      Buffer.compare(Buffer.from(originalContent, 'utf8'), Buffer.from(restoredContent, 'utf8')),
      0,
      'Restored AGENTS.md must match original byte-for-byte'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 5 - TC-DELIV-02: ClipboardAdapter encodes 1.5MB payload into <= 512KiB OSC 52 chunks with tmux passthrough', () => {
  const payload = 'A'.repeat(1.5 * 1024 * 1024); // 1.5 MiB
  const stdChunks = ClipboardAdapter.encodeOsc52Chunks(payload, {});
  assert.ok(stdChunks.length >= 4, `Expected >= 4 chunks for 1.5MB payload, got ${stdChunks.length}`);

  for (const seq of stdChunks) {
    assert.ok(seq.startsWith('\x1b]52;c;'), 'Standard OSC 52 must start with ESC ] 52 ; c ;');
    assert.ok(seq.endsWith('\x07'), 'Standard OSC 52 must end with BEL');
    const b64Part = seq.slice('\x1b]52;c;'.length, -1);
    assert.ok(
      b64Part.length <= ClipboardAdapter.MAX_OSC52_CHUNK_BYTES,
      `Base64 payload (${b64Part.length}) must not exceed 512 KiB (${ClipboardAdapter.MAX_OSC52_CHUNK_BYTES})`
    );
  }

  // Verify tmux DCS passthrough wrapping when TMUX env var is set
  const tmuxChunks = ClipboardAdapter.encodeOsc52Chunks('hello tmux', { TMUX: '/tmp/tmux-1000/default,123,0' });
  assert.equal(tmuxChunks.length, 1);
  assert.ok(
    tmuxChunks[0].startsWith('\x1bPtmux;\x1b\x1b]52;c;'),
    'tmux OSC 52 must wrap in DCS tmux passthrough prefix'
  );
  assert.ok(tmuxChunks[0].endsWith('\x07\x1b\\'), 'tmux OSC 52 must end with BEL + ST');
});

test('Phase 5 - TC-DELIV-03: UrlPrefillAdapter switches between url_prefill (<=2000 chars) and clipboard_fallback (>2000 chars)', () => {
  const shortBaton = '# BATON: Short Task\nFix the login button alignment.';
  const shortRes = UrlPrefillAdapter.deliverWeb(shortBaton, 'chatgpt', { dryRun: true });
  assert.equal(shortRes.mode, 'url_prefill');
  assert.equal(shortRes.copiedToClipboard, false);
  assert.ok(shortRes.url.startsWith('https://chatgpt.com/?q='));

  const longBaton = '# BATON: Long Task\n' + 'x'.repeat(2500);
  const longRes = UrlPrefillAdapter.deliverWeb(longBaton, 'chatgpt', { dryRun: true });
  assert.equal(longRes.mode, 'clipboard_fallback');
  assert.equal(longRes.copiedToClipboard, true);
  assert.equal(longRes.url, 'https://chatgpt.com/');
});

test('Phase 5 - TC-UX-02 & TC-UX-03: UxFormatter 1-line receipt, NO_COLOR accessibility, and Guard/Self-Heal messages', () => {
  const colorReceipt = UxFormatter.renderReceipt(
    {
      sourceAgent: 'claude',
      targetAgent: 'codex',
      rawTokens: 48200,
      dietTokens: 2800,
      redactedCount: 2,
      undoCommand: 'vicem back',
    },
    {}
  );
  assert.equal(colorReceipt.split('\n').length, 1, 'Receipt must be strictly 1 line');
  assert.ok(colorReceipt.includes('Claude → Codex'));
  assert.ok(colorReceipt.includes('48.2k → 2.8k (-94%)'));
  assert.ok(colorReceipt.includes('2 secrets'));
  assert.ok(colorReceipt.includes('vicem back'));

  // NO_COLOR=1 accessibility check (TC-UX-03)
  const noColorReceipt = UxFormatter.renderReceipt(
    {
      sourceAgent: 'claude',
      targetAgent: 'codex',
      rawTokens: 48200,
      dietTokens: 2800,
      redactedCount: 2,
      undoCommand: 'vicem back',
    },
    { NO_COLOR: '1' }
  );
  assert.ok(!/\x1b\[/.test(noColorReceipt), 'NO_COLOR receipt must contain 0 ANSI escape sequences');
  assert.ok(noColorReceipt.startsWith('[OK] [Vicem]'), 'NO_COLOR receipt must use text badge [OK]');

  // Guard Recovery & Self-Heal (TC-UX-05)
  const violation = {
    type: 'SKELETON_PLACEHOLDER',
    filePath: 'src/auth.ts',
    line: 42,
    snippet: '/* ... */',
  };
  const humanMsg = UxFormatter.renderGuardRecovery(violation, { NO_COLOR: '1' });
  assert.ok(humanMsg.includes('[ERR] [Vicem Guard]'));
  assert.ok(humanMsg.includes('src/auth.ts:42'));
  assert.ok(humanMsg.includes('vicem rollback'));

  const agentHeal = UxFormatter.renderAgentSelfHealPrompt(violation, 'verifyJwt');
  assert.ok(agentHeal.includes('vicem_rehydrate("src/auth.ts", "verifyJwt")'));
});

test('Phase 5 - CliLauncherAdapter interactive vs headless vs resume & SessionHistoryStack', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p5-cli-'));
  try {
    // Interactive default mode preserves TTY (`stdio: 'inherit'`)
    const interactiveSpec = CliLauncherAdapter.buildLaunchSpec('codex', { markdown: '# BATON' });
    assert.equal(interactiveSpec.mode, 'interactive');
    assert.equal(interactiveSpec.stdio, 'inherit');
    assert.equal(interactiveSpec.command, 'codex');

    // Headless mode uses `codex exec -` with pipe
    const headlessSpec = CliLauncherAdapter.buildLaunchSpec(
      'codex',
      { markdown: '# BATON' },
      { headless: true }
    );
    assert.equal(headlessSpec.mode, 'headless');
    assert.deepEqual(headlessSpec.args, ['exec', '-']);
    assert.equal(headlessSpec.input, '# BATON');

    // Resume mode uses `--resume <id>`
    const resumeSpec = CliLauncherAdapter.buildLaunchSpec(
      'claude',
      {},
      { resumeSessionId: 'sess-999' }
    );
    assert.equal(resumeSpec.mode, 'resume');
    assert.deepEqual(resumeSpec.args, ['--resume', 'sess-999']);

    // SessionHistoryStack push/pop
    SessionHistoryStack.pushSession(tmpDir, { agent: 'claude', sessionId: 'sess-101' });
    SessionHistoryStack.pushSession(tmpDir, { agent: 'claude', sessionId: 'sess-202' });
    const popped = SessionHistoryStack.popSession(tmpDir);
    assert.equal(popped.sessionId, 'sess-202');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

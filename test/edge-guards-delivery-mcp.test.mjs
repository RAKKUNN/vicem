import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import {
  PreHandoffSnapshotStore,
  BatonIaBuilder,
  SkeletonWriteGuard,
  SecretCommitGuard,
  StalenessDriftGuard,
  SafetyGuardEngine,
  UxFormatter,
  SessionHistoryStack,
  CliLauncherAdapter,
  RuleMountAdapter,
  ClipboardAdapter,
  UrlPrefillAdapter,
  SmartPatchApplier,
  WebLandAdapter,
  StudioHydrationAdapter,
  McpServerAdapter,
  QuotaRadar,
  PtyStreamInspector,
  GitHookInstaller,
  DoctorDiagnostics,
  VicemApp,
} from '../vicem.mjs';

function makeTempGitRepo(prefix = 'vicem-edge-guard-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync('git init -b main', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.email "test@vicem.dev"', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.name "Vicem Test"', { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

describe('Edge Suite 4A: 3-Pillar Safety Guards, Snapshot Store & U-Shaped Baton Builder', () => {
  it('PreHandoffSnapshotStore saves and restores uncommitted working tree files while blocking credential files and path traversal', () => {
    const tmp = makeTempGitRepo();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), 'export const v = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmp, '.env'), 'SECRET=nope\n', 'utf8');

      const saved = PreHandoffSnapshotStore.saveSnapshot(tmp, 'snap-01', [
        'src/app.ts',
        '.env',
        '../outside.txt',
      ]);
      assert.deepEqual(saved.savedFiles, ['src/app.ts']);
      assert.equal(PreHandoffSnapshotStore.getLatestSnapshotId(tmp), 'snap-01');

      // Corrupt working tree file and restore from snapshot
      fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), 'export const v = { /* ... */ };\n', 'utf8');
      const restoreRes = PreHandoffSnapshotStore.restoreSnapshot(tmp, 'snap-01', 'src/app.ts');
      assert.equal(restoreRes.restored, true);
      assert.deepEqual(restoreRes.restoredFiles, ['src/app.ts']);
      assert.equal(fs.readFileSync(path.join(tmp, 'src', 'app.ts'), 'utf8'), 'export const v = 1;\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SkeletonWriteGuard catches all 5 placeholder patterns in code diffs while exempting .md/.txt/.rst documentation files', () => {
    assert.deepEqual(SkeletonWriteGuard.check(''), []);
    assert.deepEqual(SkeletonWriteGuard.check(null), []);

    // Documentation files (.md, .txt, .rst) with `/* ... */` or `⋮` must NOT trigger false positives
    const docDiff = [
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,2 +1,4 @@',
      '+Example skeleton: function foo() { /* ... */ }',
      '+Vertical ellipsis: ⋮',
    ].join('\n');
    assert.deepEqual(SkeletonWriteGuard.check(docDiff), []);

    // Code file diff with all 5 placeholder types MUST be caught
    const codeDiff = [
      '--- a/src/service.ts',
      '+++ b/src/service.ts',
      '@@ -10,1 +10,5 @@',
      '+function a() { /* ... */ }',
      '+function b() { … }',
      '+// ... rest of implementation',
      '+⋮ [Vicem CodeSkeletonizer]',
      '+++ b/src/worker.py',
      '@@ -1,1 +1,2 @@',
      '+def compute(x): pass',
    ].join('\n');

    const violations = SkeletonWriteGuard.check(codeDiff);
    assert.equal(violations.length, 5);
    assert.equal(violations[0].filePath, 'src/service.ts');
    assert.equal(violations[0].rule, 'C_BLOCK_ELLIPSIS');
    assert.equal(violations[4].filePath, 'src/worker.py');
    assert.equal(violations[4].rule, 'PYTHON_STUB_PASS');
  });

  it('SecretCommitGuard blocks leaked ‹REDACTED:...› tokens and <!-- VICEM-BATON-START --> markers in added lines', () => {
    const diff = [
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1,2 +1,4 @@',
      '-<!-- VICEM-BATON-START -->',
      '+const key = "‹REDACTED:OPENAI_KEY:a1b2›";',
      '+<!-- VICEM-BATON-START -->',
    ].join('\n');

    const v = SecretCommitGuard.check(diff);
    // Removed line (-) is ignored; both added lines (+) are flagged
    assert.equal(v.length, 2);
    assert.equal(v[0].type, 'REDACTED_TOKEN_LEAK');
    assert.equal(v[1].type, 'MOUNT_MARKER_LEAK');
  });

  it('StalenessDriftGuard detects git HEAD commit drift and returns modified files in driftedFiles', () => {
    const tmp = makeTempGitRepo();
    try {
      fs.writeFileSync(path.join(tmp, 'file.js'), 'console.log(1);\n', 'utf8');
      execSync('git add . && git commit -m "c1"', { cwd: tmp, stdio: 'ignore' });

      // Build baton at commit c1
      BatonIaBuilder.build({ projectRoot: tmp, sourceAgent: 'claude', targetAgent: 'codex' });
      const check1 = StalenessDriftGuard.check(tmp);
      assert.equal(check1.drifted, false);
      assert.equal(Array.isArray(check1.driftedFiles), true);

      // Make second commit c2 and modify file.js
      fs.writeFileSync(path.join(tmp, 'file.js'), 'console.log(2);\n', 'utf8');
      execSync('git add . && git commit -m "c2"', { cwd: tmp, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmp, 'file.js'), 'console.log(3);\n', 'utf8');

      const check2 = StalenessDriftGuard.check(tmp);
      assert.equal(check2.drifted, true);
      assert.notEqual(check2.batonHead, check2.currentHead);
      assert.equal(check2.driftedFiles.includes('file.js'), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SafetyGuardEngine.verifyAndProtect inspects both staged and unstaged diffs and auto-restores corrupted files from snapshot', () => {
    const tmp = makeTempGitRepo();
    try {
      fs.writeFileSync(path.join(tmp, 'index.js'), 'export function run() {\n  return "clean";\n}\n', 'utf8');
      execSync('git add . && git commit -m "init"', { cwd: tmp, stdio: 'ignore' });

      // Create snapshot via BatonIaBuilder
      fs.writeFileSync(path.join(tmp, 'index.js'), 'export function run() {\n  return "v2-uncommitted";\n}\n', 'utf8');
      BatonIaBuilder.build({ projectRoot: tmp, sourceAgent: 'claude', targetAgent: 'codex' });

      // Simulate agent writing a skeleton placeholder and staging it with git add
      fs.writeFileSync(path.join(tmp, 'index.js'), 'export function run() { /* ... */ }\n', 'utf8');
      execSync('git add index.js', { cwd: tmp, stdio: 'ignore' });

      const guardRes = SafetyGuardEngine.verifyAndProtect(tmp, null, { autoRestore: true });
      assert.equal(guardRes.passed, false);
      assert.equal(guardRes.violations.length, 1);
      assert.equal(guardRes.restoredFiles.includes('index.js'), true);
      assert.equal(
        fs.readFileSync(path.join(tmp, 'index.js'), 'utf8'),
        'export function run() {\n  return "v2-uncommitted";\n}\n'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Edge Suite 4B: RuleMountAdapter, ClipboardAdapter, SmartPatchApplier & WebLandAdapter', () => {
  it('RuleMountAdapter mounts idempotently and unmounts with 0-byte diff while preserving external user edits', () => {
    const tmp = makeTempGitRepo();
    try {
      const agentsMd = path.join(tmp, 'AGENTS.md');
      const original = '# Project Rules\nAlways run tests before committing.\n';
      fs.writeFileSync(agentsMd, original, 'utf8');

      // Mount twice idempotently
      RuleMountAdapter.mount(tmp, 'codex', '## Baton Payload 1');
      RuleMountAdapter.mount(tmp, 'codex', '## Baton Payload 2');
      const mountedContent = fs.readFileSync(agentsMd, 'utf8');
      assert.equal(mountedContent.includes('## Baton Payload 2'), true);
      assert.equal(mountedContent.includes('## Baton Payload 1'), false);

      // Unmount restores byte-exact original content
      const unm1 = RuleMountAdapter.unmount(tmp, 'codex');
      assert.equal(unm1.unmounted, true);
      assert.equal(fs.readFileSync(agentsMd, 'utf8'), original);

      // Mount when rule file did not exist previously, then user adds custom rule while mounted
      RuleMountAdapter.mount(tmp, 'cursor', '## Cursor Baton');
      const cursorRules = path.join(tmp, '.cursorrules');
      fs.appendFileSync(cursorRules, '\nCustom user rule added during session\n', 'utf8');
      RuleMountAdapter.unmount(tmp, 'cursor');
      assert.equal(fs.existsSync(cursorRules), true);
      assert.equal(
        fs.readFileSync(cursorRules, 'utf8').trim(),
        'Custom user rule added during session'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ClipboardAdapter encodes OSC 52 chunks <= 512 KiB and wraps in tmux DCS passthrough when TMUX is set', () => {
    const emptyChunks = ClipboardAdapter.encodeOsc52Chunks('', {});
    assert.equal(emptyChunks.length, 1);
    assert.equal(emptyChunks[0], '\x1b]52;c;\x07');

    const tmuxEmpty = ClipboardAdapter.encodeOsc52Chunks('', { TMUX: '/tmp/tmux-1000/default,123,0' });
    assert.equal(tmuxEmpty[0].startsWith('\x1bPtmux;\x1b\x1b]52;c;'), true);

    // 450 KiB payload should split into 2 safe chunks (each <= 512 KiB base64)
    const bigText = 'A'.repeat(450 * 1024);
    const chunks = ClipboardAdapter.encodeOsc52Chunks(bigText, {});
    assert.equal(chunks.length, 2);
    for (const c of chunks) {
      assert.equal(Buffer.byteLength(c, 'utf8') <= ClipboardAdapter.MAX_OSC52_CHUNK_BYTES + 64, true);
    }
  });

  it('SmartPatchApplier applies SEARCH/REPLACE blocks, unified diffs, and full-file replacements while WebLandAdapter rolls back atomically on guard violation', () => {
    const tmp = makeTempGitRepo();
    try {
      const fileA = path.join(tmp, 'a.ts');
      const fileB = path.join(tmp, 'b.ts');
      fs.writeFileSync(fileA, 'export function alpha() {\n  return 1;\n}\n', 'utf8');
      fs.writeFileSync(fileB, 'export function beta() {\n  return 2;\n}\n', 'utf8');

      // 1. Valid multi-block reply with SEARCH/REPLACE on a.ts and full replacement on b.ts
      const validReply = [
        '```ts',
        '// filepath: a.ts',
        '<<<<<<< SEARCH',
        '  return 1;',
        '=======',
        '  return 100;',
        '>>>>>>> REPLACE',
        '```',
        '',
        '```ts',
        '// filepath: b.ts',
        'export function beta() {',
        '  return 200;',
        '}',
        '```',
      ].join('\n');

      const landOk = WebLandAdapter.land(tmp, validReply, { applyFiles: true });
      assert.equal(landOk.guardPassed, true);
      assert.deepEqual(landOk.appliedFiles, ['a.ts', 'b.ts']);
      assert.equal(fs.readFileSync(fileA, 'utf8').includes('return 100;'), true);
      assert.equal(fs.readFileSync(fileB, 'utf8').includes('return 200;'), true);

      // 2. Reply where Block 1 is valid but Block 2 contains a forbidden skeleton placeholder -> Neither must be applied!
      const badReply = [
        '```ts',
        '// filepath: a.ts',
        'export function alpha() {',
        '  return 999;',
        '}',
        '```',
        '```ts',
        '// filepath: b.ts',
        'export function beta() { /* ... */ }',
        '```',
      ].join('\n');

      const landBlocked = WebLandAdapter.land(tmp, badReply, { applyFiles: true });
      assert.equal(landBlocked.guardPassed, false);
      assert.equal(landBlocked.appliedFiles.length, 0);
      // Verify fileA was NOT mutated by Block 1!
      assert.equal(fs.readFileSync(fileA, 'utf8').includes('return 100;'), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Edge Suite 4C: McpServerAdapter — Dual-Era JSON-RPC 2.0 Framing, Batching, Drift & Error Codes', () => {
  it('handles JSON-RPC initialize, notifications, tools/list, tools/call (rehydrate, read_baton, create_baton, check_guard), and error codes', async () => {
    const tmp = makeTempGitRepo();
    try {
      const code = [
        'export function calculateTax(amount) {',
        '  const rate = 0.15;',
        '  const base = Math.max(0, amount);',
        '  const tax = base * rate;',
        '  const rounded = Math.round(tax * 100) / 100;',
        '  const total = base + rounded;',
        '  const label = `tax-${rounded}`;',
        '  const note = `total-${total}`;',
        '  const ok = Boolean(total >= base);',
        '  const tag = ok ? "VALID" : "INVALID";',
        '  const audit = `${label}:${note}:${tag}`;',
        '  return { base, rounded, total, audit };',
        '}',
      ].join('\n');
      fs.writeFileSync(path.join(tmp, 'tax.js'), code, 'utf8');
      execSync('git add . && git commit -m "init tax"', { cwd: tmp, stdio: 'ignore' });

      BatonIaBuilder.build({
        projectRoot: tmp,
        sourceAgent: 'claude',
        targetAgent: 'codex',
        gitContext: { branch: 'main', headCommit: 'abc1234', modifiedFiles: ['tax.js'] },
      });

      const mcp = new McpServerAdapter(tmp);

      // 1. Legacy protocol version negotiation
      const initLegacy = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      });
      assert.equal(initLegacy.result.protocolVersion, '2024-11-05');

      // 2. Notification returns null (no response frame)
      assert.equal(await mcp.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

      // 3. Rehydrate symbol
      const rehydrateRes = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'vicem_rehydrate',
          arguments: { file_path: 'tax.js', symbol_name: 'calculateTax' },
        },
      });
      assert.equal(rehydrateRes.result.isError, false);
      assert.equal(rehydrateRes.result.content[0].text.includes('const rate = 0.15;'), true);

      // 4. Modify tax.js on disk after Baton creation -> vicem_rehydrate must prepend live disk drift warning!
      fs.writeFileSync(
        path.join(tmp, 'tax.js'),
        code.replace('const rate = 0.15;', 'const rate = 0.25;'),
        'utf8'
      );
      const driftedRes = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'vicem_rehydrate',
          arguments: { file_path: 'tax.js', symbol_name: 'calculateTax' },
        },
      });
      assert.equal(
        driftedRes.result.content[0].text.includes('STALENESS DRIFT WARNING'),
        true
      );

      // 5. Missing symbol returns isError: true
      const missingSym = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'vicem_rehydrate', arguments: { file_path: 'tax.js', symbol_name: 'doesNotExist' } },
      });
      assert.equal(missingSym.result.isError, true);

      // 6. Unknown tool returns -32601
      const unknownTool = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      });
      assert.equal(unknownTool.error.code, -32601);

      // 7. Unknown RPC method returns -32601
      const unknownMethod = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'unknown/method',
      });
      assert.equal(unknownMethod.error.code, -32601);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Edge Suite 4D: QuotaRadar, GitHookInstaller, DoctorDiagnostics & VicemApp CLI Router', () => {
  it('QuotaRadar and PtyStreamInspector detect rate-limit / token-exhaustion signals while ignoring normal code lines', () => {
    assert.equal(QuotaRadar.detectVendorLimit('', 500).triggered, false);
    assert.equal(
      QuotaRadar.detectVendorLimit('const status = 429; // HTTP_TOO_MANY_REQUESTS constant', 500).triggered,
      false
    );
    assert.equal(
      QuotaRadar.detectVendorLimit("You've hit your limit for Claude Opus", 500).triggered,
      true
    );
    assert.equal(
      QuotaRadar.detectVendorLimit('RESOURCE_EXHAUSTED: quota exceeded', 500).triggered,
      true
    );
    // Active stream (< 500ms idle) does not false-trigger
    assert.equal(
      QuotaRadar.detectVendorLimit("You've hit your limit", 100).triggered,
      false
    );

    const events = [];
    const inspector = new PtyStreamInspector({
      idleMs: 500,
      onLimitDetected: (det) => events.push(det),
    });
    inspector.pushChunk('Normal output line 1\n');
    inspector.pushChunk("You've hit your usage limit\n");
    inspector.evaluateIdle(600);
    inspector.evaluateIdle(600); // Idempotent: should not fire a second time
    inspector.dispose();
    assert.equal(events.length, 1);
    assert.equal(events[0].vendor, 'codex');
  });

  it('GitHookInstaller installs, chains existing user hooks without overwriting them, and uninstalls cleanly', () => {
    const tmp = makeTempGitRepo();
    try {
      const hooksDir = path.join(tmp, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const preCommit = path.join(hooksDir, 'pre-commit');
      fs.writeFileSync(preCommit, '#!/bin/sh\necho "Custom user linter"\n', { mode: 0o755 });

      const inst = GitHookInstaller.install(tmp);
      assert.equal(inst.installed, true);
      assert.equal(GitHookInstaller.isInstalled(tmp), true);
      const hookedText = fs.readFileSync(preCommit, 'utf8');
      assert.equal(hookedText.includes('Custom user linter'), true);
      assert.equal(hookedText.includes('VICEM-GUARD-HOOK-START'), true);

      const uninst = GitHookInstaller.uninstall(tmp);
      assert.equal(uninst.uninstalled, true);
      assert.equal(GitHookInstaller.isInstalled(tmp), false);
      assert.equal(fs.readFileSync(preCommit, 'utf8').includes('Custom user linter'), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('VicemApp.parseCliArgs supports both --budget N and --budget=N syntax and clamps invalid values', () => {
    const p1 = VicemApp.parseCliArgs(['codex', '--budget=6500', '--profile=/tmp/p1', '--role=reviewer', '--dry-run']);
    assert.equal(p1.positional[0], 'codex');
    assert.equal(p1.flags.budgetTokens, 6500);
    assert.equal(p1.flags.profile, '/tmp/p1');
    assert.equal(p1.flags.role, 'reviewer');
    assert.equal(p1.flags.dryRun, true);

    const pInvalid = VicemApp.parseCliArgs(['--budget=-500']);
    assert.equal(pInvalid.flags.budgetTokens, 4000);
  });

  it('VicemApp.run sanitizes fan-out target names to prevent path traversal outside .vicem/', async () => {
    const tmp = makeTempGitRepo();
    try {
      let out = '';
      const stdout = { write: (s) => (out += s) };
      const res = await VicemApp.run(['fan-out', '../../evil,codex,claude'], {
        projectRoot: tmp,
        stdout,
        skipLaunch: true,
      });
      assert.equal(res.exitCode, 0);
      assert.equal(fs.existsSync(path.join(tmp, '..', 'BATON.evil.md')), false);
      for (const r of res.results) {
        assert.equal(path.dirname(r.file), path.join(tmp, '.vicem'));
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

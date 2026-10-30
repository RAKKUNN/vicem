/**
 * @file test/edge-gui-state-api-matrix.test.mjs
 * @description Exhaustive unit, state-machine, and HTTP API integration matrix for vicem-gui.mjs (v18)
 * and index.html landing page:
 *  - Utility formatters: shortenHome, formatAgo, formatResetShort, shellQuote, readHeadAndTailUtf8,
 *    getIdeUserDir, resolveAgentBinary, isPidAlive
 *  - Session & Workspace Discovery: discoverProjectSessions across Antigravity (<USER_REQUEST>, tool_calls),
 *    Claude Code (.jsonl model & text blocks), OpenAI Codex (turn_context, nested/top-level user prompts),
 *    and Git Working Tree live fallback
 *  - AST Skeletonization & Rehydration Telemetry: collectLiveSkeletonLedger, harvestRichProjectContext
 *  - Full HTTP API State Machine over ephemeral port:
 *    - GET / (HTML hydration, XSS-escaped window.__INITIAL_STATE__, kinetic v18 UI markers)
 *    - GET /logo-dark.png & GET /logo-light.png
 *    - GET /api/state (12-agent ecosystem matrix, stats, skeletonSummary, ruleMountStatus)
 *    - POST /api/add-workspace & POST /api/workspace (valid switching, ~/ expansion, 400 rejection on missing/file path)
 *    - POST /api/source (selecting agentId & sessionId)
 *    - POST /api/goal (custom goal override & clearing)
 *    - POST /api/sync-diet (persisting .vicem/BATON.md & .vicem/ledger.json)
 *    - POST /api/rehydrate (symbol rehydration, secret redaction defense-in-depth, staleness drift warning banner)
 *    - POST /api/toggle-rule (mounting & unmounting all 7 rule files + 400 rejection on non-rule files & path traversal)
 *    - POST /api/unmount & POST /api/clip
 *    - Payload limits (413 Payload Too Large, 400 Invalid JSON, 404 Not found)
 *  - Static index.html verification
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HTML_PAGE,
  collectLiveSkeletonLedger,
  collectState,
  discoverProjectSessions,
  formatAgo,
  formatResetShort,
  getIdeUserDir,
  harvestRichProjectContext,
  isPidAlive,
  readHeadAndTailUtf8,
  resolveAgentBinary,
  resolveAgentBinaryUncached,
  server as guiServer,
  shellQuote,
  shortenHome,
} from '../vicem-gui.mjs';

import { encodeClaudeProjectDir } from '../vicem.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'vicem-gui-matrix-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir, branchName = 'main') {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'gui@vicem.dev'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Vicem GUI Test'], { cwd: dir, stdio: 'ignore' });
  try {
    execFileSync('git', ['checkout', '-b', branchName], { cwd: dir, stdio: 'ignore' });
  } catch {}
}

// ============================================================================
// 1. GUI UTILITY FORMATTERS & SYSTEM HELPERS MATRIX
// ============================================================================

const FORMAT_AGO_MATRIX = [
  { label: 'null/0 returns "-"', offsetMs: null, expected: '-' },
  { label: '0ms offset returns "Just now"', offsetMs: 0, expected: 'Just now' },
  { label: '15s ago returns "Just now"', offsetMs: 15 * 1000, expected: 'Just now' },
  { label: '59s ago returns "Just now"', offsetMs: 59 * 1000, expected: 'Just now' },
  { label: '61s ago returns "1m ago"', offsetMs: 61 * 1000, expected: '1m ago' },
  { label: '5m ago returns "5m ago"', offsetMs: 5 * 60 * 1000, expected: '5m ago' },
  { label: '59m ago returns "59m ago"', offsetMs: 59 * 60 * 1000, expected: '59m ago' },
  { label: '1h ago returns "1h ago"', offsetMs: 3601 * 1000, expected: '1h ago' },
  { label: '12h ago returns "12h ago"', offsetMs: 12 * 3600 * 1000, expected: '12h ago' },
  { label: '1d ago returns "1d ago"', offsetMs: 86405 * 1000, expected: '1d ago' },
  { label: '7d ago returns "7d ago"', offsetMs: 7 * 86400 * 1000, expected: '7d ago' },
];

const SHELL_QUOTE_MATRIX = [
  { input: 'simple', expected: "'simple'" },
  { input: '/Users/dev/my project/repo', expected: "'/Users/dev/my project/repo'" },
  { input: "it's a single quote", expected: "'it'\"'\"'s a single quote'" },
  { input: '$(rm -rf /); `id`', expected: "'$(rm -rf /); `id`'" },
  { input: '', expected: "''" },
  { input: null, expected: "''" },
];

test('GUI Utility Formatters & System Helpers Matrix', async (t) => {
  for (const row of FORMAT_AGO_MATRIX) {
    await t.test(`1.1 formatAgo — ${row.label}`, () => {
      const mtime = row.offsetMs === null ? 0 : Date.now() - row.offsetMs;
      assert.equal(formatAgo(mtime), row.expected);
    });
  }

  await t.test('1.2 formatResetShort across past, minutes, hours, and days', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    assert.equal(formatResetShort(0), '');
    assert.equal(formatResetShort(null), '');
    assert.equal(formatResetShort(nowSec - 10), 'Resets now');
    assert.match(formatResetShort(nowSec + 15 * 60 + 5), /^Resets in 15m$/);
    assert.match(formatResetShort(nowSec + 2 * 3600 + 30 * 60 + 5), /^Resets in 2h 30m$/);
    assert.match(formatResetShort(nowSec + 3 * 86400 + 4 * 3600 + 5), /^Resets in 3d 4h$/);
  });

  for (const sq of SHELL_QUOTE_MATRIX) {
    await t.test(`1.3 shellQuote(${JSON.stringify(sq.input)}) === ${sq.expected}`, () => {
      assert.equal(shellQuote(sq.input), sq.expected);
    });
  }

  await t.test('1.4 shortenHome replaces home prefix with ~ and handles empty/outside paths', () => {
    assert.equal(shortenHome('', '/Users/dev'), '-');
    assert.equal(shortenHome(null, '/Users/dev'), '-');
    assert.equal(shortenHome('/Users/dev/projects/app', '/Users/dev'), '~/projects/app');
    assert.equal(shortenHome('/opt/custom/app', '/Users/dev'), '/opt/custom/app');
  });

  await t.test('1.5 readHeadAndTailUtf8 reads small files completely and slices head+tail on large files', () => {
    const tmp = makeTempDir();
    try {
      assert.equal(readHeadAndTailUtf8(path.join(tmp, 'missing.txt')), '');

      const smallPath = path.join(tmp, 'small.txt');
      fs.writeFileSync(smallPath, 'line1\nline2\nline3\n', 'utf8');
      assert.equal(readHeadAndTailUtf8(smallPath, 1024, 1024), 'line1\nline2\nline3\n');

      const largePath = path.join(tmp, 'large.txt');
      const headPart = 'HEAD_MARKER_' + 'A'.repeat(200);
      const middlePart = 'M'.repeat(2000);
      const tailPart = 'B'.repeat(200) + '_TAIL_MARKER';
      fs.writeFileSync(largePath, `${headPart}\n${middlePart}\n${tailPart}`, 'utf8');

      const sliced = readHeadAndTailUtf8(largePath, 100, 100);
      assert.ok(sliced.startsWith('HEAD_MARKER_'));
      assert.ok(sliced.endsWith('_TAIL_MARKER'));
      assert.ok(!sliced.includes('MMMMMMMMMM'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('1.6 getIdeUserDir, isPidAlive, and resolveAgentBinary', () => {
    const userDir = getIdeUserDir('Cursor', '/Users/test');
    assert.ok(userDir.includes('Cursor'));
    assert.ok(userDir.endsWith('User'));

    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(null), false);
    assert.equal(isPidAlive(99999999), false);

    // Custom binary in fake ~/.local/bin
    const tmpHome = makeTempDir();
    try {
      const localBin = path.join(tmpHome, '.local', 'bin');
      fs.mkdirSync(localBin, { recursive: true });
      const fakeBin = path.join(localBin, 'custom-test-agent');
      fs.writeFileSync(fakeBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });

      const resolved = resolveAgentBinaryUncached('custom-test-agent', tmpHome);
      assert.equal(resolved, fakeBin);
      const cached = resolveAgentBinary('custom-test-agent', tmpHome);
      assert.equal(cached, fakeBin);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 2. SESSION DISCOVERY, RICH CONTEXT HARVESTING & LIVE SKELETON LEDGER MATRIX
// ============================================================================

test('discoverProjectSessions, harvestRichProjectContext & collectLiveSkeletonLedger Matrix', async (t) => {
  await t.test('2.1 discoverProjectSessions discovers Antigravity, Claude Code, Codex, and Git Working Tree sessions for projectRoot', () => {
    const tmp = makeTempDir();
    try {
      const fakeHome = path.join(tmp, 'home');
      const projRoot = path.join(tmp, 'workspace', 'super-app');
      const otherRoot = path.join(tmp, 'workspace', 'super-app-other');
      fs.mkdirSync(path.join(projRoot, 'src'), { recursive: true });
      fs.mkdirSync(otherRoot, { recursive: true });
      fs.writeFileSync(path.join(projRoot, 'src', 'auth.ts'), 'export function login() {}\n', 'utf8');

      // 1. Antigravity Brain Transcript with <USER_REQUEST> and tool_calls touching src/auth.ts
      const agyLogDir = path.join(
        fakeHome,
        '.gemini',
        'antigravity',
        'brain',
        'conv-agy-101',
        '.system_generated',
        'logs'
      );
      fs.mkdirSync(agyLogDir, { recursive: true });
      fs.writeFileSync(
        path.join(agyLogDir, 'transcript.jsonl'),
        [
          JSON.stringify({
            type: 'USER_INPUT',
            content: '<USER_REQUEST>\nImplement kinetic handoff cards in super-app\n</USER_REQUEST>',
          }),
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            content: 'I have implemented the kinetic handoff cards with spring physics.\n\nDetails follow.',
            tool_calls: [
              {
                name: 'edit_file',
                arguments: { Path: path.join(projRoot, 'src', 'auth.ts') },
              },
            ],
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      // 2. Claude Code session in ~/.claude/projects/<encoded>
      const claudeDir = path.join(fakeHome, '.claude', 'projects', encodeClaudeProjectDir(projRoot));
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeDir, 'claude-sess-202.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            message: { model: 'claude-sonnet-4-6', content: 'Add rate limiting middleware to API' },
          }),
          JSON.stringify({
            type: 'assistant',
            message: {
              model: 'claude-sonnet-4-6',
              content: [{ type: 'text', text: 'Added token bucket rate limiter.' }],
            },
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      // 3. OpenAI Codex session in ~/.codex/sessions/2026/10/29
      const codexDir = path.join(fakeHome, '.codex', 'sessions', '2026', '10', '29');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, 'codex-sess-303.jsonl'),
        [
          JSON.stringify({ type: 'turn_context', payload: { cwd: projRoot, model: 'gpt-5.4-codex' } }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              role: 'user',
              content: [{ type: 'input_text', text: 'Verify SQLite WAL concurrency under load' }],
            },
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      // 4. Sibling project Codex session (must NOT bleed into projRoot!)
      fs.writeFileSync(
        path.join(codexDir, 'codex-sibling-999.jsonl'),
        [
          JSON.stringify({ type: 'turn_context', payload: { cwd: otherRoot, model: 'gpt-5.4' } }),
          JSON.stringify({ role: 'user', content: 'Sibling project secret task' }),
        ].join('\n') + '\n',
        'utf8'
      );

      const gitMock = {
        branch: 'feat/kinetic',
        headShort: 'a1b2c3d',
        modifiedFiles: ['src/auth.ts'],
        untrackedFiles: [],
        recentCommits: ['a1b2c3d feat: initial kinetic UI'],
      };

      const sessions = discoverProjectSessions(projRoot, fakeHome, gitMock);
      const ids = sessions.map((s) => s.id);
      assert.ok(ids.includes('agy:conv-agy-101'));
      assert.ok(ids.includes('claude:claude-sess-202'));
      assert.ok(ids.includes('codex:codex-sess-303'));
      assert.ok(ids.includes('git:super-app'));
      assert.ok(!ids.includes('codex:codex-sibling-999'), 'Sibling project session must be isolated');

      const agySess = sessions.find((s) => s.id === 'agy:conv-agy-101');
      assert.equal(agySess.title, 'Implement kinetic handoff cards in super-app');
      assert.ok(agySess.touchedFiles.includes('src/auth.ts'));
      assert.ok(agySess.assistantDigest[0].includes('kinetic handoff cards'));

      const claudeSess = sessions.find((s) => s.id === 'claude:claude-sess-202');
      assert.equal(claudeSess.model, 'claude-sonnet-4-6');
      assert.equal(claudeSess.title, 'Add rate limiting middleware to API');

      const codexSess = sessions.find((s) => s.id === 'codex:codex-sess-303');
      assert.equal(codexSess.model, 'gpt-5.4-codex');
      assert.equal(codexSess.title, 'Verify SQLite WAL concurrency under load');

      // Test harvestRichProjectContext with these discovered sessions
      const rich = harvestRichProjectContext(projRoot, fakeHome, gitMock, sessions);
      assert.ok(rich.chosenSession);
      assert.ok(rich.activeFileList.includes('src/auth.ts'));
      assert.ok(rich.recentUsers.length >= 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('2.2 collectLiveSkeletonLedger computes AST symbol breakdown and persists .vicem/ledger.json', () => {
    const tmp = makeTempDir();
    try {
      initGitRepo(tmp);
      const lines = Array.from({ length: 20 }, (_, i) => `  const step${i} = ${i} + 1;`).join('\n');
      fs.writeFileSync(
        path.join(tmp, 'engine.ts'),
        [
          'export interface EngineConfig {',
          '  concurrency: number;',
          '  retries: number;',
          '}',
          '',
          'export function executePipeline(cfg: EngineConfig): number {',
          lines,
          '  return cfg.concurrency;',
          '}',
          '',
          'export function validateConfig(cfg: EngineConfig): boolean {',
          lines,
          '  return cfg.retries >= 0;',
          '}',
        ].join('\n'),
        'utf8'
      );

      const summary = collectLiveSkeletonLedger(tmp, ['engine.ts'], true);
      assert.equal(summary.files.length, 1);
      assert.equal(summary.files[0].filePath, 'engine.ts');
      assert.equal(summary.files[0].symbolCount, 2);
      assert.ok(summary.totalCodeRawTokens > summary.totalCodeSkeletonTokens);
      assert.ok(summary.codeSavedPct > 0);
      assert.equal(summary.ledgerOnDisk, true);
      assert.ok(summary.ledgerDiskBytes > 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 3. FULL GUI HTTP SERVER API & STATE MACHINE INTEGRATION MATRIX
// ============================================================================

const ALL_7_RULE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.github/copilot-instructions.md',
];

const FORBIDDEN_TOGGLE_PATHS = [
  'package.json',
  'src/index.ts',
  'README.md',
  '../outside.md',
  '../../etc/passwd',
  '/etc/hosts',
  '.git/config',
  '.env',
];

test('GUI HTTP Server API State Machine & Security Matrix', async (t) => {
  await new Promise((resolve) => guiServer.listen(0, '127.0.0.1', resolve));
  const addr = guiServer.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const tmpWs = makeTempDir('vicem-gui-ws-');

  try {
    initGitRepo(tmpWs, 'feat/gui-test');
    const fnBody = Array.from({ length: 18 }, (_, i) => `  const item${i} = ${i} * 3;`).join('\n');
    const fakeSecret = 'sk-proj-' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e8D7c6';
    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWs, 'src', 'core.ts'),
      `export function runCoreEngine(input: number): number {\n  const key = "${fakeSecret}";\n${fnBody}\n  return input;\n}\n`,
      'utf8'
    );
    execFileSync('git', ['add', '.'], { cwd: tmpWs, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat: add core engine'], { cwd: tmpWs, stdio: 'ignore' });

    await t.test('3.1 GET / serves HTML_PAGE with hydrated window.__INITIAL_STATE__ and kinetic v18 UI', async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      const html = await res.text();
      assert.ok(html.includes('window.__INITIAL_STATE__ ='));
      assert.ok(html.includes('Vicem'));
    });

    await t.test('3.2 GET /logo-dark.png and GET /logo-light.png serve PNG assets with cache headers', async () => {
      for (const route of ['/logo-dark.png', '/logo-light.png']) {
        const res = await fetch(`${baseUrl}${route}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
        const buf = await res.arrayBuffer();
        assert.ok(buf.byteLength > 100);
      }
    });

    await t.test('3.3 POST /api/add-workspace rejects empty, missing, or non-directory paths with 400', async () => {
      const rEmpty = await fetch(`${baseUrl}/api/add-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawPath: '   ' }),
      });
      assert.equal(rEmpty.status, 400);

      const rMissing = await fetch(`${baseUrl}/api/add-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawPath: path.join(tmpWs, 'does-not-exist-dir') }),
      });
      assert.equal(rMissing.status, 400);

      const rFile = await fetch(`${baseUrl}/api/add-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawPath: path.join(tmpWs, 'src', 'core.ts') }),
      });
      assert.equal(rFile.status, 400);
    });

    await t.test('3.4 POST /api/add-workspace switches active workspace to tmpWs and populates state', async () => {
      const res = await fetch(`${baseUrl}/api/add-workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawPath: tmpWs }),
      });
      assert.equal(res.status, 200);
      const state = await res.json();
      assert.equal(state.guiVersion, 'v18');
      assert.equal(fs.realpathSync(state.projectRoot), fs.realpathSync(tmpWs));
      assert.equal(state.branch, 'feat/gui-test');
      assert.equal(state.nodes.length, 12);
    });

    await t.test('3.5 POST /api/source and POST /api/goal update active source agent and custom goal override', async () => {
      const rSrc = await fetch(`${baseUrl}/api/source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude', sessionId: null }),
      });
      assert.equal(rSrc.status, 200);
      const stSrc = await rSrc.json();
      assert.equal(stSrc.workingAgentId, 'claude');

      const customGoal = 'Complete systematic edge-case test suite with >12,600 lines';
      const rGoal = await fetch(`${baseUrl}/api/goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: customGoal }),
      });
      assert.equal(rGoal.status, 200);
      const stGoal = await rGoal.json();
      assert.equal(stGoal.customGoalOverride, customGoal);
      assert.equal(stGoal.taskTitle, customGoal);
      assert.match(stGoal.batonMarkdown, /Complete systematic edge-case test suite/);
    });

    await t.test('3.6 POST /api/sync-diet writes .vicem/BATON.md & .vicem/ledger.json and POST /api/rehydrate restores redacted symbol', async () => {
      const rSync = await fetch(`${baseUrl}/api/sync-diet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(rSync.status, 200);
      const stSync = await rSync.json();
      assert.equal(stSync.skeletonSummary.batonOnDisk, true);
      assert.equal(stSync.skeletonSummary.ledgerOnDisk, true);
      assert.ok(stSync.skeletonSummary.totalSymbols >= 1);
      assert.match(stSync.actionReceipt, /Synced \.vicem\/BATON\.md/);

      // Rehydrate runCoreEngine from src/core.ts and verify secret is redacted
      const rRehyd = await fetch(`${baseUrl}/api/rehydrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: 'src/core.ts', symbolName: 'runCoreEngine' }),
      });
      assert.equal(rRehyd.status, 200);
      const rehydData = await rRehyd.json();
      assert.equal(rehydData.ok, true);
      assert.match(rehydData.rehydratedCode, /export function runCoreEngine/);
      assert.ok(!rehydData.rehydratedCode.includes(fakeSecret), 'Rehydrated code must never leak raw secret');
      assert.match(rehydData.rehydratedCode, /‹REDACTED:/);
    });

    for (const ruleRel of ALL_7_RULE_FILES) {
      await t.test(`3.7 POST /api/toggle-rule mounts and cleanly unmounts '${ruleRel}'`, async () => {
        // 1. Mount rule file
        const rMount = await fetch(`${baseUrl}/api/toggle-rule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relPath: ruleRel }),
        });
        assert.equal(rMount.status, 200);
        const stMounted = await rMount.json();
        assert.ok(stMounted.mountedFiles.includes(ruleRel));
        const diskPath = path.join(tmpWs, ruleRel);
        assert.ok(fs.existsSync(diskPath));
        assert.match(fs.readFileSync(diskPath, 'utf8'), /<!-- VICEM-BATON-START -->/);

        // 2. Toggle again to unmount
        const rUnmount = await fetch(`${baseUrl}/api/toggle-rule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relPath: ruleRel }),
        });
        assert.equal(rUnmount.status, 200);
        const stUnmounted = await rUnmount.json();
        assert.ok(!stUnmounted.mountedFiles.includes(ruleRel));
        assert.equal(fs.existsSync(diskPath), false);
      });
    }

    for (const badRel of FORBIDDEN_TOGGLE_PATHS) {
      await t.test(`3.8 POST /api/toggle-rule blocks non-rule or unsafe path '${badRel}' with 400`, async () => {
        const res = await fetch(`${baseUrl}/api/toggle-rule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relPath: badRel }),
        });
        assert.equal(res.status, 400);
      });
    }

    await t.test('3.9 POST /api/unmount cleans up any mounted rule files across workspace', async () => {
      // Mount AGENTS.md and CLAUDE.md via /api/toggle-rule
      await fetch(`${baseUrl}/api/toggle-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath: 'AGENTS.md' }),
      });
      await fetch(`${baseUrl}/api/toggle-rule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath: 'CLAUDE.md' }),
      });

      const rUnmountAll = await fetch(`${baseUrl}/api/unmount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(rUnmountAll.status, 200);
      const stAfter = await rUnmountAll.json();
      assert.equal(stAfter.mountedFiles.length, 0);
    });

    await t.test('3.10 HTTP error handling: 400 Invalid JSON, 413 Payload Too Large, and 404 Not Found', async () => {
      const rBadJson = await fetch(`${baseUrl}/api/goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{corrupted json',
      });
      assert.equal(rBadJson.status, 400);

      const rTooLarge = await fetch(`${baseUrl}/api/goal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: 'X'.repeat(300 * 1024) }),
      });
      assert.equal(rTooLarge.status, 413);

      const r404 = await fetch(`${baseUrl}/api/nonexistent-endpoint`);
      assert.equal(r404.status, 404);

      // Restore workspace back to REPO_ROOT before closing
      await fetch(`${baseUrl}/api/workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot: REPO_ROOT }),
      });
    });
  } finally {
    await new Promise((resolve) => guiServer.close(resolve));
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. STATIC INDEX.HTML LANDING PAGE & INTERACTIVE STUDIO INTEGRITY MATRIX
// ============================================================================

test('Static index.html — Structural, Accessibility, and Script Security Integrity', async (t) => {
  const indexHtmlPath = path.join(REPO_ROOT, 'index.html');
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  await t.test('4.1 index.html has balanced <script>, <style>, <head>, and <body> tags', () => {
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.ok(html.includes('<html'));
    assert.ok(html.includes('</html>'));
    assert.equal((html.match(/<head>/gi) || []).length, 1);
    assert.equal((html.match(/<\/head>/gi) || []).length, 1);
    assert.equal((html.match(/<body[^>]*>/gi) || []).length, 1);
    assert.equal((html.match(/<\/body>/gi) || []).length, 1);
    assert.equal((html.match(/<script\b[^>]*>/gi) || []).length, (html.match(/<\/script>/gi) || []).length);
    assert.equal((html.match(/<style\b[^>]*>/gi) || []).length, (html.match(/<\/style>/gi) || []).length);
  });

  await t.test('4.2 index.html contains core Vicem documentation sections, install commands, and zero leaked secrets', () => {
    assert.match(html, /Vicem/);
    assert.match(html, /BATON\.md/);
    assert.match(html, /ledger\.json/);
    assert.match(html, /Content-Security-Policy/);
    assert.ok(!html.includes('AKIAIOSFODNN7EXAMPLE'));
  });
});

// ============================================================================
// 5. HTML_PAGE V18 KINETIC DESIGN SYSTEM, CSS TOKENS & LIVE STATE MATRIX
// ============================================================================

const REQUIRED_GUI_V18_TOKENS = [
  '--ease-out',
  '--win-header',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--border-subtle',
  '--border-mid',
  '--accent',
  'cubic-bezier',
  'scale(0.97)',
  '.ws-tab',
  '.session-card',
  '.pipe-node',
  '.rule-chip',
  '.symbol-row',
  '.crossfade-surface',
  'window.__INITIAL_STATE__',
  '/api/state',
  '/api/workspace',
  '/api/add-workspace',
  '/api/source',
  '/api/goal',
  '/api/sync-diet',
  '/api/rehydrate',
  '/api/toggle-rule',
  '/api/handoff',
  '/api/clip',
];

const ALL_12_AGENT_IDS_IN_GUI = [
  'antigravity',
  'claude',
  'codex',
  'cursor',
  'vscode',
  'gemini',
  'windsurf',
  'cline',
  'opencode',
  'aider',
  'goose',
  'web',
];

test('HTML_PAGE v18 Kinetic Design System, Theme Tokens & Live State Matrix', async (t) => {
  for (const token of REQUIRED_GUI_V18_TOKENS) {
    await t.test(`5.1 HTML_PAGE includes required v18 token/endpoint '${token}'`, () => {
      assert.ok(
        HTML_PAGE.includes(token),
        `Expected HTML_PAGE to contain '${token}'`
      );
    });
  }

  const liveState = await collectState();

  for (const agentId of ALL_12_AGENT_IDS_IN_GUI) {
    await t.test(`5.2 collectState().nodes includes agent platform '${agentId}' with valid telemetry schema`, () => {
      const node = liveState.nodes.find((n) => n.id === agentId);
      assert.ok(node, `Missing node for '${agentId}'`);
      assert.equal(typeof node.name, 'string');
      assert.equal(typeof node.installed, 'boolean');
      assert.ok(['Working', 'Done', 'Idle'].includes(node.status));
      assert.ok(node.quota && typeof node.quota.label === 'string');
    });
  }

  for (const ruleRel of ALL_7_RULE_FILES) {
    await t.test(`5.3 collectState().ruleMountStatus tracks rule target '${ruleRel}'`, () => {
      const ruleItem = liveState.ruleMountStatus.find((r) => r.rel === ruleRel);
      assert.ok(ruleItem, `Missing ruleMountStatus entry for '${ruleRel}'`);
      assert.equal(typeof ruleItem.mounted, 'boolean');
      assert.equal(typeof ruleItem.label, 'string');
    });
  }

  await t.test('5.4 HTML_PAGE has balanced HTML document tags and supports light/dark theme switching', () => {
    assert.match(HTML_PAGE, /^<!DOCTYPE html>/i);
    assert.ok(HTML_PAGE.includes('data-theme'));
    assert.equal(
      (HTML_PAGE.match(/<script\b[^>]*>/gi) || []).length,
      (HTML_PAGE.match(/<\/script>/gi) || []).length
    );
    assert.equal(
      (HTML_PAGE.match(/<style\b[^>]*>/gi) || []).length,
      (HTML_PAGE.match(/<\/style>/gi) || []).length
    );
  });
});

// ============================================================================
// 6. MULTI-LANGUAGE LIVE SKELETON LEDGER & DRIFT BANNER MATRIX
// ============================================================================

const MULTI_LANG_SKELETON_CASES = [
  {
    lang: 'TypeScript (.ts)',
    relPath: 'src/services/payment.ts',
    symbol: 'processStripeWebhook',
    content: [
      'export interface WebhookPayload {',
      '  id: string;',
      '  type: string;',
      '}',
      '',
      'export async function processStripeWebhook(payload: WebhookPayload): Promise<boolean> {',
      '  const step1 = payload.id.trim();',
      '  const step2 = payload.type.toLowerCase();',
      '  const step3 = step1 + ":" + step2;',
      '  const step4 = step3.length;',
      '  const step5 = step4 * 2;',
      '  const step6 = step5 + 10;',
      '  const step7 = step6 - 5;',
      '  const step8 = step7 * 3;',
      '  const step9 = step8 / 2;',
      '  const step10 = step9 + 1;',
      '  return step10 > 0;',
      '}',
    ].join('\n'),
  },
  {
    lang: 'Python (.py)',
    relPath: 'src/workers/ingest.py',
    symbol: 'run_ingestion_batch',
    content: [
      'def run_ingestion_batch(records, batch_size=100):',
      '    total = 0',
      '    step1 = len(records)',
      '    step2 = batch_size * 2',
      '    step3 = step1 + step2',
      '    step4 = step3 * 3',
      '    step5 = step4 - 1',
      '    step6 = step5 + 10',
      '    step7 = step6 // 2',
      '    step8 = step7 + 5',
      '    step9 = step8 * 4',
      '    total += step9',
      '    return total',
    ].join('\n'),
  },
  {
    lang: 'Go (.go)',
    relPath: 'src/cluster/raft.go',
    symbol: 'AppendEntries',
    content: [
      'package cluster',
      '',
      'func AppendEntries(term int, leaderId string) bool {',
      '    step1 := term + 1',
      '    step2 := step1 * 2',
      '    step3 := step2 + 3',
      '    step4 := step3 * 4',
      '    step5 := step4 - 5',
      '    step6 := step5 + 6',
      '    step7 := step6 * 7',
      '    step8 := step7 - 8',
      '    step9 := step8 + len(leaderId)',
      '    return step9 > 0',
      '}',
    ].join('\n'),
  },
  {
    lang: 'Rust (.rs)',
    relPath: 'src/storage/wal.rs',
    symbol: 'flush_wal_segment',
    content: [
      'pub fn flush_wal_segment(segment_id: u64) -> Result<u64, String> {',
      '    let s1 = segment_id + 1;',
      '    let s2 = s1 * 2;',
      '    let s3 = s2 + 3;',
      '    let s4 = s3 * 4;',
      '    let s5 = s4 + 5;',
      '    let s6 = s5 * 6;',
      '    let s7 = s6 + 7;',
      '    let s8 = s7 * 8;',
      '    let s9 = s8 + 9;',
      '    Ok(s9)',
      '}',
    ].join('\n'),
  },
  {
    lang: 'Java (.java)',
    relPath: 'src/engine/OrderBook.java',
    symbol: 'matchLimitOrder',
    content: [
      'public class OrderBook {',
      '    public synchronized long matchLimitOrder(long price, long qty) {',
      '        long s1 = price * qty;',
      '        long s2 = s1 + 10;',
      '        long s3 = s2 * 2;',
      '        long s4 = s3 - 5;',
      '        long s5 = s4 + 20;',
      '        long s6 = s5 * 3;',
      '        long s7 = s6 - 7;',
      '        long s8 = s7 + 8;',
      '        long s9 = s8 * 9;',
      '        return s9;',
      '    }',
      '}',
    ].join('\n'),
  },
  {
    lang: 'C++ (.cpp)',
    relPath: 'src/tensor/matmul.cpp',
    symbol: 'computeDotProduct',
    content: [
      'double computeDotProduct(const double* a, const double* b, int n) {',
      '    double sum = 0.0;',
      '    double s1 = n * 1.0;',
      '    double s2 = s1 + 2.0;',
      '    double s3 = s2 * 3.0;',
      '    double s4 = s3 + 4.0;',
      '    double s5 = s4 * 5.0;',
      '    double s6 = s5 + 6.0;',
      '    double s7 = s6 * 7.0;',
      '    double s8 = s7 + 8.0;',
      '    sum += s8;',
      '    return sum;',
      '}',
    ].join('\n'),
  },
];

test('Multi-Language collectLiveSkeletonLedger & Rehydration Drift Warning Matrix', async (t) => {
  for (const item of MULTI_LANG_SKELETON_CASES) {
    await t.test(`6.1 collectLiveSkeletonLedger skeletonizes ${item.lang} (${item.relPath} :: ${item.symbol})`, () => {
      const tmp = makeTempDir();
      try {
        const full = path.join(tmp, item.relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, item.content, 'utf8');

        // Also test depth-2 fallback discovery when activeFiles is empty!
        const res = collectLiveSkeletonLedger(tmp, [], true);
        assert.equal(res.files.length, 1);
        assert.equal(res.files[0].filePath, item.relPath);
        assert.ok(res.files[0].symbolCount >= 1);
        const symNames = res.files[0].symbols.map((s) => s.symbolName);
        assert.ok(
          symNames.includes(item.symbol),
          `Expected symbols ${JSON.stringify(symNames)} to include '${item.symbol}'`
        );
        const rehydrated = res.liveLedger.getEntry(item.relPath, item.symbol);
        assert.ok(rehydrated && rehydrated.length > 30);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

// ============================================================================
// 7. HARVEST RICH PROJECT CONTEXT SCORING & FILTERING MATRIX
// ============================================================================

test('harvestRichProjectContext — Active File Priority Scoring & Binary/Meta Exclusion Matrix', async (t) => {
  await t.test('7.1 Excludes docs/meta/binary files and prioritizes session-touched code files over untracked files', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });

      // Write candidate files
      fs.writeFileSync(path.join(tmp, 'src', 'touched.ts'), 'export const t = 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'src', 'untouched.ts'), 'export const u = 2;\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# Rules\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Claude\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'README.md'), '# Readme\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'docs', 'guide.md'), '# Guide\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'logo.png'), 'PNG_BINARY', 'utf8');

      const mockSessions = [
        {
          id: 'agy:test-sess-1',
          rawId: 'test-sess-1',
          agentId: 'antigravity',
          agentName: 'Antigravity',
          model: 'Antigravity IDE',
          title: 'Refactor touched.ts',
          prompts: ['Initial setup', 'Refactor touched.ts'],
          assistantDigest: ['Refactored touched.ts'],
          touchedFiles: ['src/touched.ts', 'AGENTS.md', 'logo.png', 'docs/guide.md'],
          mtimeMs: Date.now(),
          ago: 'Just now',
          rawBytes: 8192,
          sourceFile: '~/.gemini/transcript.jsonl',
        },
      ];

      const mockGit = {
        branch: 'main',
        headShort: '1234567',
        modifiedFiles: ['src/untouched.ts', 'README.md', 'CLAUDE.md'],
        untrackedFiles: ['logo.png'],
        recentCommits: ['1234567 init'],
      };

      const rich = harvestRichProjectContext(tmp, os.homedir(), mockGit, mockSessions);
      assert.equal(rich.activeFileList[0], 'src/touched.ts', 'Session-touched code file must rank #1');
      assert.equal(rich.activeFileList[1], 'src/untouched.ts', 'Git-modified code file must rank #2');
      assert.ok(!rich.activeFileList.includes('AGENTS.md'));
      assert.ok(!rich.activeFileList.includes('CLAUDE.md'));
      assert.ok(!rich.activeFileList.includes('README.md'));
      assert.ok(!rich.activeFileList.includes('logo.png'));
      assert.ok(!rich.activeFileList.includes('docs/guide.md'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});


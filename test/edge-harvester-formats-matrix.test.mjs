/**
 * @file test/edge-harvester-formats-matrix.test.mjs
 * @description Exhaustive edge-case and format matrix test suite for all 10 Session Harvesters,
 * SQLite WAL Database Snapshot Isolation, Reverse JSONL Head/Tail Readers, Project Path Boundary
 * Isolation, DeterministicTaskExtractor 4-Source Heuristics, and FuzzyTargetMatcher / SmartInferenceEngine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readWalDatabaseSnapshot,
  readJsonlHead,
  readJsonlTail,
  getGeminiProjectHash,
  encodeClaudeProjectDir,
  matchesProjectPathBoundary,
  DeterministicTaskExtractor,
  SessionHarvester,
  ClaudeHarvester,
  CodexHarvester,
  GeminiHarvester,
  AiderHarvester,
  AntigravityHarvester,
  CursorHarvester,
  VSCodeCopilotHarvester,
  ClineHarvester,
  OpenCodeHarvester,
  WebExportHarvester,
  FuzzyTargetMatcher,
  SmartInferenceEngine,
} from '../vicem.mjs';

function makeTempDir(prefix = 'vicem-harv-matrix-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// 1. PROJECT PATH BOUNDARY & ENCODING / HASHING EDGE CASES
// ============================================================================

test('Project Path Boundary & Encoding Matrix — strict prefix isolation vs sibling directories', async (t) => {
  await t.test('1.1 matchesProjectPathBoundary isolates /repo/app from /repo/app-v2 and /repo/application', () => {
    const root = '/Users/dev/workspace/app';
    const validCases = [
      '{"cwd":"/Users/dev/workspace/app"}',
      '{"file":"file:///Users/dev/workspace/app/src/index.ts"}',
      'path: /Users/dev/workspace/app/package.json\n',
      'cwd="/Users/dev/workspace/app"',
      "cwd='/Users/dev/workspace/app'",
      'in /Users/dev/workspace/app\r\n',
      'at (/Users/dev/workspace/app)',
      'root=/Users/dev/workspace/app',
    ];
    for (const text of validCases) {
      assert.equal(
        matchesProjectPathBoundary(text, root),
        true,
        `Expected true for valid boundary: ${text}`
      );
    }

    const invalidSiblingCases = [
      '{"cwd":"/Users/dev/workspace/app-v2"}',
      '{"cwd":"/Users/dev/workspace/app_backup"}',
      '{"cwd":"/Users/dev/workspace/application/src/index.ts"}',
      '{"cwd":"/Users/dev/workspace/app2"}',
      '{"cwd":"/Users/dev/workspace/app.old/main.js"}',
      '{"cwd":"/Users/dev/workspace/other"}',
      '',
    ];
    for (const text of invalidSiblingCases) {
      assert.equal(
        matchesProjectPathBoundary(text, root),
        false,
        `Expected false for sibling collision: ${text}`
      );
    }
  });

  await t.test('1.2 matchesProjectPathBoundary handles regex special characters in projectRoot', () => {
    const weirdRoots = [
      '/Users/dev/my+project (v1.0) [beta]',
      '/Users/dev/project$1^2.test',
      '/Users/dev/c++_engine',
    ];
    for (const root of weirdRoots) {
      assert.equal(matchesProjectPathBoundary(`{"cwd":"${root}/src/main.cpp"}`, root), true);
      assert.equal(matchesProjectPathBoundary(`{"cwd":"${root}-other/src/main.cpp"}`, root), false);
    }
  });

  await t.test('1.3 matchesProjectPathBoundary handles null/empty inputs gracefully', () => {
    assert.equal(matchesProjectPathBoundary(null, '/tmp/a'), false);
    assert.equal(matchesProjectPathBoundary('some text', null), false);
    assert.equal(matchesProjectPathBoundary('', ''), false);
  });

  await t.test('1.4 encodeClaudeProjectDir and getGeminiProjectHash determinism', () => {
    const p1 = '/Users/syslab/Documents/antigravity/delightful-euclid';
    const encoded = encodeClaudeProjectDir(p1);
    assert.equal(encoded, '-Users-syslab-Documents-antigravity-delightful-euclid');
    assert.ok(!encoded.includes('/'));

    const h1 = getGeminiProjectHash(p1);
    const h2 = getGeminiProjectHash(p1);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// 2. JSONL HEAD & TAIL READER BOUNDARY & CORRUPTION MATRIX
// ============================================================================

test('readJsonlHead & readJsonlTail — Byte Offset, Mid-Line Split, and Corruption Matrix', async (t) => {
  await t.test('2.1 readJsonlHead and readJsonlTail on missing, empty, or whitespace-only files', () => {
    const tmp = makeTempDir();
    try {
      assert.deepEqual(readJsonlHead(null), []);
      assert.deepEqual(readJsonlTail(null), []);
      assert.deepEqual(readJsonlHead(path.join(tmp, 'nonexistent.jsonl')), []);
      assert.deepEqual(readJsonlTail(path.join(tmp, 'nonexistent.jsonl')), []);

      const emptyFile = path.join(tmp, 'empty.jsonl');
      fs.writeFileSync(emptyFile, '', 'utf8');
      assert.deepEqual(readJsonlHead(emptyFile), []);
      assert.deepEqual(readJsonlTail(emptyFile), []);

      const blankLinesFile = path.join(tmp, 'blank.jsonl');
      fs.writeFileSync(blankLinesFile, '\n\r\n   \n\t\n', 'utf8');
      assert.deepEqual(readJsonlHead(blankLinesFile), []);
      assert.deepEqual(readJsonlTail(blankLinesFile), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('2.2 readJsonlHead respects maxLines and maxBytes and skips corrupted JSON lines', () => {
    const tmp = makeTempDir();
    try {
      const f = path.join(tmp, 'mixed.jsonl');
      const lines = [
        JSON.stringify({ seq: 1, role: 'user', content: 'First valid line' }),
        '{ THIS IS CORRUPTED JSON LINE WITHOUT CLOSING BRACE',
        JSON.stringify({ seq: 2, role: 'assistant', content: 'Second valid line' }),
        '<<<INVALID>>>',
        JSON.stringify({ seq: 3, role: 'user', content: 'Third valid line' }),
        JSON.stringify({ seq: 4, role: 'assistant', content: 'Fourth valid line' }),
        JSON.stringify({ seq: 5, role: 'user', content: 'Fifth valid line' }),
      ];
      fs.writeFileSync(f, lines.join('\r\n') + '\r\n', 'utf8');

      const head3 = readJsonlHead(f, 3);
      assert.equal(head3.length, 3);
      assert.deepEqual(head3.map((x) => x.seq), [1, 2, 3]);

      // Small maxBytes truncates mid-line on later events without throwing
      const headSmallBytes = readJsonlHead(f, 10, 140);
      assert.ok(headSmallBytes.length >= 1);
      assert.equal(headSmallBytes[0].seq, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('2.3 readJsonlTail skips partial first line when file size > maxBytes', () => {
    const tmp = makeTempDir();
    try {
      const f = path.join(tmp, 'large.jsonl');
      const totalLines = 300;
      const rows = [];
      for (let i = 1; i <= totalLines; i++) {
        rows.push(JSON.stringify({ idx: i, role: 'user', text: 'x'.repeat(200) + ` line-${i}` }));
      }
      fs.writeFileSync(f, rows.join('\n') + '\n', 'utf8');

      // Read tail with 8KB window and maxLines=15
      const tail = readJsonlTail(f, 15, 8192);
      assert.equal(tail.length, 15);
      assert.equal(tail[tail.length - 1].idx, 300);
      assert.equal(tail[0].idx, 286);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 3. SQLITE WAL DATABASE SNAPSHOT READER MATRIX
// ============================================================================

test('readWalDatabaseSnapshot — Live WAL Mode, Uncheckpointed Writes, and Error Handling', async (t) => {
  await t.test('3.1 readWalDatabaseSnapshot returns null for missing file or null path', async () => {
    assert.equal(await readWalDatabaseSnapshot(null, () => 42), null);
    assert.equal(await readWalDatabaseSnapshot('/nonexistent/sqlite/file.db', () => 42), null);
  });

  await t.test('3.2 readWalDatabaseSnapshot reads live WAL-mode database without locking writer', async () => {
    const tmp = makeTempDir();
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(tmp, 'live.vscdb');
      const writerDb = new DatabaseSync(dbPath);
      writerDb.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO ItemTable (key, value) VALUES ('aiService.prompts', '[{"text":"Initial WAL prompt"}]');
      `);

      // Perform an additional write while writerDb connection remains open
      writerDb
        .prepare(`INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)`)
        .run('aiService.prompts', JSON.stringify([{ text: 'Uncheckpointed live WAL prompt' }]));

      const snapResult = await readWalDatabaseSnapshot(dbPath, (snapDb) => {
        const row = snapDb.prepare(`SELECT value FROM ItemTable WHERE key = 'aiService.prompts'`).get();
        return JSON.parse(row.value);
      });

      assert.ok(Array.isArray(snapResult));
      assert.equal(snapResult[0].text, 'Uncheckpointed live WAL prompt');

      writerDb.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 4. ALL 10 SESSION HARVESTERS EXHAUSTIVE MATRIX
// ============================================================================

test('SessionHarvester Base & ClaudeHarvester Matrix', async (t) => {
  await t.test('4.1 SessionHarvester base class defaults', async () => {
    const base = new SessionHarvester('/tmp/proj');
    assert.equal(base.getAgentName(), 'unknown');
    assert.equal(await base.getProjectScopedLatestMtime(), 0);
    assert.equal(await base.harvestSession(), null);
  });

  await t.test('4.2 ClaudeHarvester selects newest .jsonl session strictly for projectRoot', async () => {
    const tmp = makeTempDir();
    try {
      const projA = path.join(tmp, 'proj-alpha');
      const projB = path.join(tmp, 'proj-beta');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });

      const claudeConfig = path.join(tmp, '.claude');
      const dirA = path.join(claudeConfig, 'projects', encodeClaudeProjectDir(projA));
      const dirB = path.join(claudeConfig, 'projects', encodeClaudeProjectDir(projB));
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      const oldFileA = path.join(dirA, 'sess-old.jsonl');
      const newFileA = path.join(dirA, 'sess-new.jsonl');
      const newerFileB = path.join(dirB, 'sess-beta.jsonl');

      fs.writeFileSync(
        oldFileA,
        JSON.stringify({ role: 'user', content: 'Old alpha task' }) + '\n',
        'utf8'
      );
      const tOld = new Date(Date.now() - 60000);
      fs.utimesSync(oldFileA, tOld, tOld);

      fs.writeFileSync(
        newFileA,
        [
          JSON.stringify({ role: 'user', content: 'Implement OAuth2 PKCE flow in proj-alpha' }),
          JSON.stringify({ role: 'assistant', content: 'Working on PKCEverifier.' }),
        ].join('\n') + '\n',
        'utf8'
      );
      const tNew = new Date(Date.now() - 10000);
      fs.utimesSync(newFileA, tNew, tNew);

      fs.writeFileSync(
        newerFileB,
        JSON.stringify({ role: 'user', content: 'Unrelated beta project task' }) + '\n',
        'utf8'
      );

      const harvA = new ClaudeHarvester(projA, { CLAUDE_CONFIG_DIR: claudeConfig });
      assert.equal(harvA.getAgentName(), 'claude');
      const mtimeA = await harvA.getProjectScopedLatestMtime();
      assert.ok(mtimeA > 0);

      const sessionA = await harvA.harvestSession();
      assert.equal(sessionA.agent, 'claude');
      assert.equal(sessionA.sessionId, 'sess-new');
      assert.equal(sessionA.rawEvents.length, 2);
      assert.match(sessionA.rawEvents[0].content, /OAuth2 PKCE/);

      // Uninitialized project returns 0 / null
      const harvEmpty = new ClaudeHarvester(path.join(tmp, 'proj-none'), {
        CLAUDE_CONFIG_DIR: claudeConfig,
      });
      assert.equal(await harvEmpty.getProjectScopedLatestMtime(), 0);
      assert.equal(await harvEmpty.harvestSession(), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test('CodexHarvester — JSONL Nested Directory Walk & SQLite state_5.sqlite Fallback Matrix', async (t) => {
  await t.test('4.3 CodexHarvester walks nested YYYY/MM/DD rollout JSONL and filters by cwd', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('codex-proj-'));
      const otherRoot = '/Users/other/unrelated-repo';
      const codexHome = path.join(tmp, '.codex');
      const dayDir = path.join(codexHome, 'sessions', '2026', '10', '29');
      fs.mkdirSync(dayDir, { recursive: true });

      const unrelatedRollout = path.join(dayDir, 'rollout-unrelated.jsonl');
      fs.writeFileSync(
        unrelatedRollout,
        [
          JSON.stringify({ type: 'session_meta', payload: { cwd: otherRoot } }),
          JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'Other project' } }),
        ].join('\n') + '\n',
        'utf8'
      );

      const matchingRollout = path.join(dayDir, 'rollout-target.jsonl');
      fs.writeFileSync(
        matchingRollout,
        [
          JSON.stringify({ type: 'session_meta', payload: { cwd: projRoot, model: 'gpt-5.4' } }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              role: 'user',
              content: [{ type: 'input_text', text: 'Optimize WebSocket frame parser in target repo' }],
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'edit_file',
              arguments: JSON.stringify({ file_path: 'src/ws.ts' }),
            },
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      const harv = new CodexHarvester(projRoot, { CODEX_HOME: codexHome });
      assert.equal(harv.getAgentName(), 'codex');
      const mtime = await harv.getProjectScopedLatestMtime();
      assert.ok(mtime > 0);

      const session = await harv.harvestSession();
      assert.ok(session);
      assert.equal(session.agent, 'codex');
      assert.equal(session.sessionId, 'rollout-target');

      const extracted = DeterministicTaskExtractor.extract(session.rawEvents);
      assert.match(extracted.goal, /Optimize WebSocket frame parser/);
      assert.ok(extracted.done.some((d) => d.includes('src/ws.ts')));

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.4 CodexHarvester falls back to state_5.sqlite threads table when no JSONL exists', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('codex-sql-proj-'));
      const codexHome = path.join(tmp, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });

      const { DatabaseSync } = await import('node:sqlite');
      const sqlitePath = path.join(codexHome, 'state_5.sqlite');
      const db = new DatabaseSync(sqlitePath);
      db.exec(`
        CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, updated_at INTEGER);
      `);
      // Insert epoch seconds (< 1e12) to test second-to-ms conversion
      const epochSec = Math.floor(Date.now() / 1000) - 5;
      db.prepare(`INSERT INTO threads (id, cwd, title, updated_at) VALUES (?, ?, ?, ?)`).run(
        'thread-sql-99',
        projRoot,
        'Refactor SQLite WAL reader in Codex SQLite fallback',
        epochSec
      );
      db.close();

      const harv = new CodexHarvester(projRoot, { CODEX_HOME: codexHome });
      const mtime = await harv.getProjectScopedLatestMtime();
      assert.equal(mtime, epochSec * 1000);

      const session = await harv.harvestSession();
      assert.ok(session);
      assert.equal(session.sessionId, 'thread-sql-99');
      assert.equal(session.rawEvents[0].content, 'Refactor SQLite WAL reader in Codex SQLite fallback');

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test('GeminiHarvester, AiderHarvester, and AntigravityHarvester Matrix', async (t) => {
  await t.test('4.5 GeminiHarvester supports both .jsonl and .json (messages array & root array)', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('gemini-proj-'));
      const geminiHome = path.join(tmp, '.gemini');
      const chatsDir = path.join(geminiHome, 'tmp', getGeminiProjectHash(projRoot), 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });

      const jsonFile = path.join(chatsDir, 'chat-json.json');
      fs.writeFileSync(
        jsonFile,
        JSON.stringify({
          messages: [
            { role: 'user', content: 'Build Gemini JSON session support' },
            { role: 'model', content: 'Implemented JSON session parser.' },
          ],
        }),
        'utf8'
      );

      const harv = new GeminiHarvester(projRoot, { GEMINI_CLI_HOME: geminiHome });
      assert.equal(harv.getAgentName(), 'gemini');
      assert.ok((await harv.getProjectScopedLatestMtime()) > 0);

      const sess1 = await harv.harvestSession();
      assert.equal(sess1.sessionId, 'chat-json');
      assert.equal(sess1.rawEvents.length, 2);

      // Now write a newer .jsonl file and verify it takes precedence
      const jsonlFile = path.join(chatsDir, 'chat-jsonl.jsonl');
      fs.writeFileSync(
        jsonlFile,
        JSON.stringify({ role: 'user', content: 'Newer JSONL Gemini prompt' }) + '\n',
        'utf8'
      );
      const futureTime = new Date(Date.now() + 5000);
      fs.utimesSync(jsonlFile, futureTime, futureTime);

      const sess2 = await harv.harvestSession();
      assert.equal(sess2.sessionId, 'chat-jsonl');
      assert.equal(sess2.rawEvents[0].content, 'Newer JSONL Gemini prompt');

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.6 AiderHarvester extracts #### markdown user headings from .aider.chat.history.md', async () => {
    const tmp = makeTempDir();
    try {
      const harv = new AiderHarvester(tmp);
      assert.equal(harv.getAgentName(), 'aider');
      assert.equal(await harv.getProjectScopedLatestMtime(), 0);
      assert.equal(await harv.harvestSession(), null);

      const historyPath = path.join(tmp, '.aider.chat.history.md');
      fs.writeFileSync(
        historyPath,
        [
          '# aider chat started at 2026-10-29',
          '#### /add src/parser.js',
          'Added src/parser.js to the chat.',
          '#### Fix the off-by-one token index bug in src/parser.js',
          'Here is the SEARCH/REPLACE block...',
          '#### Run unit tests and verify exit code 0',
        ].join('\n'),
        'utf8'
      );

      assert.ok((await harv.getProjectScopedLatestMtime()) > 0);
      const sess = await harv.harvestSession();
      assert.equal(sess.agent, 'aider');
      assert.equal(sess.sessionId, 'aider-history');
      assert.equal(sess.rawEvents.length, 3);
      assert.equal(sess.rawEvents[1].content, 'Fix the off-by-one token index bug in src/parser.js');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.7 AntigravityHarvester scans brain transcripts and isolates by project boundary', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('agy-proj-'));
      const siblingRoot = `${projRoot}-sibling`;
      const brainDir = path.join(tmp, 'brain');

      const convSibling = path.join(brainDir, 'conv-sibling', '.system_generated', 'logs');
      const convTarget = path.join(brainDir, 'conv-target', '.system_generated', 'logs');
      fs.mkdirSync(convSibling, { recursive: true });
      fs.mkdirSync(convTarget, { recursive: true });

      fs.writeFileSync(
        path.join(convSibling, 'transcript.jsonl'),
        JSON.stringify({
          type: 'USER_INPUT',
          content: `Working in file://${siblingRoot}/index.js`,
        }) + '\n',
        'utf8'
      );

      fs.writeFileSync(
        path.join(convTarget, 'transcript.jsonl'),
        [
          JSON.stringify({
            type: 'USER_INPUT',
            content: `Workspace: file://${projRoot}\nImplement kinetic spring animations in GUI`,
          }),
          JSON.stringify({
            type: 'PLANNER_RESPONSE',
            content: 'Updated spring physics constants.',
          }),
          JSON.stringify({
            role: 'tool',
            content: 'ok',
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      const harv = new AntigravityHarvester(projRoot, { ANTIGRAVITY_BRAIN_DIR: brainDir });
      assert.equal(harv.getAgentName(), 'antigravity');
      assert.ok((await harv.getProjectScopedLatestMtime()) > 0);

      const sess = await harv.harvestSession();
      assert.equal(sess.agent, 'antigravity');
      assert.equal(sess.sessionId, 'conv-target');
      assert.equal(sess.rawEvents.length, 3);
      assert.equal(sess.rawEvents[0].role, 'user');
      assert.equal(sess.rawEvents[1].role, 'assistant');

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test('CursorHarvester, VSCodeCopilotHarvester, ClineHarvester, OpenCodeHarvester & WebExportHarvester Matrix', async (t) => {
  await t.test('4.8 CursorHarvester parses both aiService.prompts array and aichat.chatdata tabs/bubbles', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('cursor-proj-'));
      const wsBase = path.join(tmp, 'workspaceStorage');
      const wsDir = path.join(wsBase, 'ws-hash-123');
      fs.mkdirSync(wsDir, { recursive: true });

      // Test URL-encoded workspace.json folder URI
      const encodedUri = `file://${projRoot.replace(/\//g, '%2F')}`;
      fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: encodedUri }), 'utf8');

      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(wsDir, 'state.vscdb');
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);`);
      db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run(
        'aiService.prompts',
        JSON.stringify([{ text: 'Cursor prompt 1: add dark mode token' }])
      );
      db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run(
        'workbench.panel.aichat.view.aichat.chatdata',
        JSON.stringify({
          tabs: [
            {
              bubbles: [
                { type: 'user', text: 'Cursor bubble user prompt' },
                { type: 'ai', rawText: 'Cursor bubble assistant reply' },
              ],
            },
          ],
        })
      );
      db.close();

      const harv = new CursorHarvester(projRoot, { CURSOR_WORKSPACE_STORAGE_DIR: wsBase });
      assert.equal(harv.getAgentName(), 'cursor');
      assert.ok((await harv.getProjectScopedLatestMtime()) > 0);

      const sess = await harv.harvestSession();
      assert.equal(sess.agent, 'cursor');
      assert.equal(sess.sessionId, 'cursor-ws-hash-123');
      assert.equal(sess.rawEvents.length, 3);
      assert.equal(sess.rawEvents[0].content, 'Cursor prompt 1: add dark mode token');
      assert.equal(sess.rawEvents[1].content, 'Cursor bubble user prompt');
      assert.equal(sess.rawEvents[2].role, 'assistant');

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.9 VSCodeCopilotHarvester parses both .json requests and .jsonl chatSessions', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('vscode-proj-'));
      const wsBase = path.join(tmp, 'vscodeStorage');
      const wsDir = path.join(wsBase, 'ws-vsc-01');
      const chatDir = path.join(wsDir, 'chatSessions');
      fs.mkdirSync(chatDir, { recursive: true });

      fs.writeFileSync(
        path.join(wsDir, 'workspace.json'),
        JSON.stringify({ folder: `file://${projRoot}` }),
        'utf8'
      );

      const jsonSession = path.join(chatDir, 'copilot-1.json');
      fs.writeFileSync(
        jsonSession,
        JSON.stringify({
          requests: [
            { message: { text: 'Copilot JSON request 1' } },
            { message: 'Copilot JSON request 2 string' },
          ],
        }),
        'utf8'
      );

      const harv = new VSCodeCopilotHarvester(projRoot, { VSCODE_WORKSPACE_STORAGE_DIR: wsBase });
      assert.equal(harv.getAgentName(), 'vscode');
      const sessJson = await harv.harvestSession();
      assert.equal(sessJson.sessionId, 'copilot-1');
      assert.equal(sessJson.rawEvents.length, 2);

      // Add newer .jsonl session
      const jsonlSession = path.join(chatDir, 'copilot-2.jsonl');
      fs.writeFileSync(
        jsonlSession,
        [
          JSON.stringify({ role: 'user', message: { text: 'Copilot JSONL prompt' } }),
          JSON.stringify({ role: 'assistant', content: 'Copilot JSONL response' }),
        ].join('\n') + '\n',
        'utf8'
      );
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(jsonlSession, future, future);

      const sessJsonl = await harv.harvestSession();
      assert.equal(sessJsonl.sessionId, 'copilot-2');
      assert.equal(sessJsonl.rawEvents.length, 2);

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.10 ClineHarvester and OpenCodeHarvester project-scoped harvesting', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('cline-open-proj-'));
      const tasksDir = path.join(tmp, 'cline-tasks');
      const task1 = path.join(tasksDir, 'task-001');
      fs.mkdirSync(task1, { recursive: true });

      fs.writeFileSync(
        path.join(task1, 'ui_messages.json'),
        JSON.stringify([
          { say: 'text', text: `Working in ${projRoot}/src/app.ts: implement retry backoff` },
          { say: 'user_feedback', text: 'Add jitter to exponential backoff' },
        ]),
        'utf8'
      );

      const clineHarv = new ClineHarvester(projRoot, { CLINE_TASKS_DIR: tasksDir });
      assert.equal(clineHarv.getAgentName(), 'cline');
      assert.ok((await clineHarv.getProjectScopedLatestMtime()) > 0);
      const clineSess = await clineHarv.harvestSession();
      assert.equal(clineSess.sessionId, 'task-001');
      assert.equal(clineSess.rawEvents.length, 2);

      // OpenCode SQLite database
      const openCodeDir = path.join(tmp, 'opencode');
      fs.mkdirSync(openCodeDir, { recursive: true });
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(openCodeDir, 'opencode.db'));
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, updated_at INTEGER);`);
      db.prepare(`INSERT INTO session (id, directory, title, updated_at) VALUES (?, ?, ?, ?)`).run(
        'oc-sess-77',
        projRoot,
        'OpenCode session: build zero-dependency parser',
        Date.now()
      );
      db.close();

      const ocHarv = new OpenCodeHarvester(projRoot, { OPENCODE_DATA_DIR: openCodeDir });
      assert.equal(ocHarv.getAgentName(), 'opencode');
      assert.ok((await ocHarv.getProjectScopedLatestMtime()) > 0);
      const ocSess = await ocHarv.harvestSession();
      assert.equal(ocSess.sessionId, 'oc-sess-77');
      assert.equal(ocSess.rawEvents[0].content, 'OpenCode session: build zero-dependency parser');

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.11 WebExportHarvester parses ChatGPT mapping tree, Claude.ai chat_messages, and generic messages', () => {
    assert.deepEqual(WebExportHarvester.parseExportJson(null), []);
    assert.deepEqual(WebExportHarvester.parseExportJson('not valid json{{{'), []);
    assert.deepEqual(WebExportHarvester.parseExportJson('12345'), []);

    // ChatGPT conversations.json format
    const chatGptExport = JSON.stringify([
      {
        title: 'ChatGPT Arch Review',
        mapping: {
          node1: {
            message: {
              author: { role: 'system' },
              content: { parts: ['System initialization'] },
            },
          },
          node2: {
            message: {
              author: { role: 'user' },
              content: { parts: ['Design a U-shaped context baton architecture', 'Include safety guards'] },
            },
          },
          node3: {
            message: {
              author: { role: 'assistant' },
              content: { parts: ['Here is the 3-zone U-shaped layout...'] },
            },
          },
        },
      },
    ]);
    const parsedGpt = WebExportHarvester.parseExportJson(chatGptExport);
    assert.equal(parsedGpt.length, 2);
    assert.equal(parsedGpt[0].role, 'user');
    assert.match(parsedGpt[0].content, /Design a U-shaped context baton/);
    assert.equal(parsedGpt[1].role, 'assistant');

    // Claude.ai export format
    const claudeExport = {
      chat_messages: [
        { sender: 'human', text: 'Review AST skeletonizer edge cases' },
        { sender: 'assistant', content: [{ text: 'Checked TypeScript generics and Python decorators.' }] },
      ],
    };
    const parsedClaude = WebExportHarvester.parseExportJson(claudeExport);
    assert.equal(parsedClaude.length, 2);
    assert.equal(parsedClaude[0].role, 'user');
    assert.equal(parsedClaude[1].role, 'assistant');
    assert.match(parsedClaude[1].content, /Checked TypeScript generics/);

    // Generic messages array
    const genericExport = { messages: [{ role: 'user', content: 'Hello generic' }] };
    assert.equal(WebExportHarvester.parseExportJson(genericExport).length, 1);
  });
});

// ============================================================================
// 5. DETERMINISTIC TASK EXTRACTOR 4-SOURCE PERMUTATION MATRIX
// ============================================================================

const TASK_EXTRACTOR_CASES = [
  {
    name: '5.1 TodoWrite / update_plan overrides with completed, in_progress, and pending items',
    events: [
      { role: 'user', content: 'Build full authentication middleware and rate limiter' },
      {
        role: 'assistant',
        tool_calls: [
          {
            name: 'TodoWrite',
            arguments: JSON.stringify({
              todos: [
                { content: 'Create JWT verifier', status: 'completed' },
                { content: 'Add Redis sliding window limiter', status: 'in_progress' },
                { content: 'Write integration tests', status: 'pending' },
              ],
            }),
          },
        ],
      },
    ],
    git: null,
    expectGoal: /Build full authentication middleware/,
    expectDoneIncludes: 'Create JWT verifier',
    expectNextFirst: '[IN PROGRESS] Add Redis sliding window limiter',
  },
  {
    name: '5.2 Trivial confirmation prompts ("yes", "ok", "continue", "lgtm") are skipped for Goal',
    events: [
      { role: 'user', content: 'ok' },
      { role: 'user', content: 'yes' },
      { role: 'user', content: 'Refactor the database connection pool to support automatic failover' },
      { role: 'assistant', content: 'Started refactoring pool.ts' },
      { role: 'user', content: 'continue' },
    ],
    git: null,
    expectGoal: /Refactor the database connection pool/,
    expectDoneIncludes: null,
    expectNextFirst: null,
  },
  {
    name: '5.3 Unanswered non-trivial user prompt becomes Immediate NEXT #1 (interrupted request)',
    events: [
      { role: 'user', content: 'Initial setup of payment webhook handler in src/webhook.ts' },
      { role: 'assistant', content: 'Created src/webhook.ts' },
      { role: 'user', content: 'Verify Stripe signature header using timingSafeEqual before parsing body' },
    ],
    git: null,
    expectGoal: /Initial setup of payment webhook/,
    expectDoneIncludes: null,
    expectNextFirst: /Fulfill interrupted user request: "Verify Stripe signature header/,
  },
  {
    name: '5.4 Failed bash command followed by non-recovering state prioritizes fixing the command',
    events: [
      { role: 'user', content: 'Run the test suite and fix any broken snapshots' },
      {
        type: 'tool_use',
        name: 'bash',
        input: { command: 'npm run test:unit' },
        exitCode: 2,
        output: 'AssertionError: expected 200 to equal 401',
      },
    ],
    git: null,
    expectGoal: /Run the test suite and fix any broken snapshots/,
    expectDoneIncludes: null,
    expectNextFirst: "Fix failing command 'npm run test:unit' (exit code 2)",
  },
  {
    name: '5.5 Failed bash command cleared by subsequent exitCode 0 bash command',
    events: [
      { role: 'user', content: 'Run tests until green' },
      {
        type: 'tool_use',
        name: 'bash',
        input: { command: 'npm test' },
        exitCode: 1,
      },
      {
        type: 'tool_use',
        name: 'bash',
        input: { command: 'npm test' },
        exitCode: 0,
      },
    ],
    git: { branch: 'feat/green', modifiedFiles: ['src/index.ts'], recentCommits: ['abc1234 init'] },
    expectGoal: /Run tests until green/,
    expectDoneIncludes: 'Recent commit: abc1234 init',
    expectNextFirst: 'Verify and complete uncommitted changes in: src/index.ts',
  },
  {
    name: '5.6 Claude content block tool_use and tool_result error extraction',
    events: [
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: 'Migrate schema to v5 and run migration script' }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Editing migration file' },
            { type: 'tool_use', name: 'edit_file', input: { path: 'db/migrate_v5.sql' } },
          ],
        },
      },
      {
        type: 'tool_result',
        tool_name: 'psql -f db/migrate_v5.sql',
        is_error: true,
        exit_code: 127,
        content: 'syntax error at or near "ALTER"',
      },
    ],
    git: null,
    expectGoal: /Migrate schema to v5/,
    expectDoneIncludes: 'Modified file: db/migrate_v5.sql',
    expectNextFirst: "Fix failing command 'psql -f db/migrate_v5.sql' (exit code 127)",
  },
  {
    name: '5.7 Empty session events fall back cleanly to gitContext branch and commits',
    events: [],
    git: {
      branch: 'hotfix/memory-leak',
      recentCommits: ['9f8e7d6 fix listener leak'],
      modifiedFiles: ['src/bus.js', 'src/worker.js'],
    },
    expectGoal: /Continue development on branch 'hotfix\/memory-leak'/,
    expectDoneIncludes: 'Recent commit: 9f8e7d6 fix listener leak',
    expectNextFirst: 'Verify and complete uncommitted changes in: src/bus.js, src/worker.js',
  },
];

test('DeterministicTaskExtractor — 4-Source Heuristics Matrix', async (t) => {
  for (const tc of TASK_EXTRACTOR_CASES) {
    await t.test(tc.name, () => {
      const res = DeterministicTaskExtractor.extract(tc.events, tc.git);
      assert.match(res.goal, tc.expectGoal);
      if (tc.expectDoneIncludes) {
        assert.ok(
          res.done.some((d) => d.includes(tc.expectDoneIncludes)),
          `Expected done to include '${tc.expectDoneIncludes}', got: ${JSON.stringify(res.done)}`
        );
      }
      if (tc.expectNextFirst) {
        if (tc.expectNextFirst instanceof RegExp) {
          assert.match(res.immediateNext[0], tc.expectNextFirst);
        } else {
          assert.equal(res.immediateNext[0], tc.expectNextFirst);
        }
      }
    });
  }
});

// ============================================================================
// 6. FUZZY TARGET MATCHER & SMART INFERENCE ENGINE MATRIX
// ============================================================================

const FUZZY_MATCH_MATRIX = [
  // Exact canonical matches
  { input: 'codex', expected: 'codex', via: 'exact' },
  { input: 'claude', expected: 'claude', via: 'exact' },
  { input: 'gemini', expected: 'gemini', via: 'exact' },
  { input: 'antigravity', expected: 'antigravity', via: 'exact' },
  { input: 'vscode', expected: 'vscode', via: 'exact' },
  { input: 'cursor', expected: 'cursor', via: 'exact' },
  { input: 'windsurf', expected: 'windsurf', via: 'exact' },
  { input: 'cline', expected: 'cline', via: 'exact' },
  { input: 'aider', expected: 'aider', via: 'exact' },
  { input: 'opencode', expected: 'opencode', via: 'exact' },
  { input: 'goose', expected: 'goose', via: 'exact' },
  { input: 'web', expected: 'web', via: 'exact' },
  { input: 'self', expected: 'self', via: 'exact' },
  // Explicit aliases
  { input: 'cdx', expected: 'codex', via: 'alias' },
  { input: 'cx', expected: 'codex', via: 'alias' },
  { input: 'openai', expected: 'codex', via: 'alias' },
  { input: 'cld', expected: 'claude', via: 'alias' },
  { input: 'cc', expected: 'claude', via: 'alias' },
  { input: 'anthropic', expected: 'claude', via: 'alias' },
  { input: 'agy', expected: 'antigravity', via: 'alias' },
  { input: 'anti', expected: 'antigravity', via: 'alias' },
  { input: 'ide', expected: 'antigravity', via: 'alias' },
  { input: 'gui', expected: 'antigravity', via: 'alias' },
  { input: 'vsc', expected: 'vscode', via: 'alias' },
  { input: 'code', expected: 'vscode', via: 'alias' },
  { input: 'copilot', expected: 'vscode', via: 'alias' },
  { input: 'cur', expected: 'cursor', via: 'alias' },
  { input: 'ws', expected: 'windsurf', via: 'alias' },
  { input: 'wind', expected: 'windsurf', via: 'alias' },
  { input: 'gem', expected: 'gemini', via: 'alias' },
  { input: 'chat', expected: 'web', via: 'alias' },
  { input: 'chatgpt', expected: 'web', via: 'alias' },
  { input: 'browser', expected: 'web', via: 'alias' },
  // Typos (length >= 5, edit distance <= 2)
  { input: 'claud', expected: 'claude', via: 'fuzzy' },
  { input: 'claudee', expected: 'claude', via: 'fuzzy' },
  { input: 'codexx', expected: 'codex', via: 'fuzzy' },
  { input: 'gemni', expected: 'gemini', via: 'fuzzy' },
  { input: 'cursr', expected: 'cursor', via: 'fuzzy' },
  { input: 'windsrff', expected: 'windsurf', via: 'fuzzy' },
  { input: 'antigravty', expected: 'antigravity', via: 'fuzzy' },
  // Short non-matching words (length <= 4) must NOT falsely match 'web' or 'self'
  { input: 'cat', expected: null, via: 'none' },
  { input: 'git', expected: null, via: 'none' },
  { input: 'foo', expected: null, via: 'none' },
  { input: 'bar', expected: null, via: 'none' },
  { input: '', expected: null, via: 'none' },
  { input: '   ', expected: null, via: 'none' },
  { input: 'completely-unknown-agent-xyz', expected: null, via: 'none' },
];

test('FuzzyTargetMatcher & SmartInferenceEngine Matrix', async (t) => {
  for (const row of FUZZY_MATCH_MATRIX) {
    await t.test(`6.1 FuzzyTargetMatcher.match('${row.input}') -> ${row.expected} (${row.via})`, () => {
      const res = FuzzyTargetMatcher.match(row.input);
      assert.equal(res.matched, row.expected);
      assert.equal(res.via, row.via);
    });
  }

  await t.test('6.2 SmartInferenceEngine.autoDetectSource picks newest agent across harvesters', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('infer-proj-'));
      const claudeConfig = path.join(tmp, '.claude');
      const claudeDir = path.join(claudeConfig, 'projects', encodeClaudeProjectDir(projRoot));
      fs.mkdirSync(claudeDir, { recursive: true });

      const claudeSess = path.join(claudeDir, 'c1.jsonl');
      fs.writeFileSync(claudeSess, JSON.stringify({ role: 'user', content: 'Claude older' }) + '\n', 'utf8');
      const oldTime = new Date(Date.now() - 30000);
      fs.utimesSync(claudeSess, oldTime, oldTime);

      // Write newer Aider history in projRoot
      const aiderPath = path.join(projRoot, '.aider.chat.history.md');
      fs.writeFileSync(aiderPath, '#### Newer Aider task in project\n', 'utf8');

      const detected = await SmartInferenceEngine.autoDetectSource(projRoot, {
        HOME: tmp,
        CLAUDE_CONFIG_DIR: claudeConfig,
      });
      assert.equal(detected.agent, 'aider');
      assert.ok(detected.mtimeMs > oldTime.getTime());

      // Recommend next target never recommends the source agent itself
      for (const src of ['claude', 'codex', 'antigravity', 'gemini', 'web']) {
        const rec = SmartInferenceEngine.recommendNextTarget(src);
        assert.notEqual(rec, src);
      }

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 7. SMART INFERENCE ENGINE PREVIOUS SOURCE & INSTALLED SUBSET MATRIX
// ============================================================================

const INSTALLED_SUBSET_MATRIX = [
  {
    name: '7.1 Only [codex, web] installed: fuzzy "cdx" resolves to codex, "claude" returns null',
    installed: ['codex', 'web'],
    input: 'cdx',
    expected: 'codex',
  },
  {
    name: '7.2 Only [codex, web] installed: "claude" is not in installed candidates so returns null',
    installed: ['codex', 'web'],
    input: 'claude',
    expected: null,
  },
  {
    name: '7.3 Only [antigravity, gemini] installed: alias "ide" resolves to antigravity',
    installed: ['antigravity', 'gemini'],
    input: 'ide',
    expected: 'antigravity',
  },
  {
    name: '7.4 Only [antigravity, gemini] installed: typo "gemni" resolves to gemini',
    installed: ['antigravity', 'gemini'],
    input: 'gemni',
    expected: 'gemini',
  },
  {
    name: '7.5 Only [vscode, cursor, windsurf] installed: alias "copilot" resolves to vscode',
    installed: ['vscode', 'cursor', 'windsurf'],
    input: 'copilot',
    expected: 'vscode',
  },
  {
    name: '7.6 Only [vscode, cursor, windsurf] installed: alias "ws" resolves to windsurf',
    installed: ['vscode', 'cursor', 'windsurf'],
    input: 'ws',
    expected: 'windsurf',
  },
];

test('SmartInferenceEngine — getPreviousSource, Installed Subset Resolution & Corrupted Store Resilience', async (t) => {
  for (const item of INSTALLED_SUBSET_MATRIX) {
    await t.test(item.name, () => {
      const res = SmartInferenceEngine.resolveTarget(item.input, item.installed);
      assert.equal(res.matched, item.expected);
    });
  }

  await t.test('7.7 SmartInferenceEngine.getPreviousSource reads .vicem/baton.json and handles missing/corrupted files', () => {
    const tmp = makeTempDir();
    try {
      // 1. Missing .vicem/baton.json returns null
      assert.equal(SmartInferenceEngine.getPreviousSource(tmp), null);

      // 2. Corrupted .vicem/baton.json returns null without throwing
      const vicemDir = path.join(tmp, '.vicem');
      fs.mkdirSync(vicemDir, { recursive: true });
      const batonJsonPath = path.join(vicemDir, 'baton.json');
      fs.writeFileSync(batonJsonPath, '{corrupted json', 'utf8');
      assert.equal(SmartInferenceEngine.getPreviousSource(tmp), null);

      // 3. Valid .vicem/baton.json returns source agent, sessionId, previousTarget, and mountedRuleFile
      fs.writeFileSync(
        batonJsonPath,
        JSON.stringify({
          source: { agent: 'claude', sessionId: 'sess-abc' },
          target: { agent: 'codex', mountedRuleFile: 'AGENTS.md' },
        }),
        'utf8'
      );
      const prev = SmartInferenceEngine.getPreviousSource(tmp);
      assert.deepEqual(prev, {
        agent: 'claude',
        sessionId: 'sess-abc',
        previousTarget: 'codex',
        mountedRuleFile: 'AGENTS.md',
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('7.8 All 9 harvesters tolerate corrupted JSON/SQLite files without throwing', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = fs.realpathSync(makeTempDir('corrupt-proj-'));
      const claudeDir = path.join(tmp, '.claude', 'projects', encodeClaudeProjectDir(projRoot));
      const codexDir = path.join(tmp, '.codex', 'sessions');
      const geminiDir = path.join(tmp, '.gemini', 'tmp', getGeminiProjectHash(projRoot), 'chats');
      const agyDir = path.join(tmp, 'brain', 'c1', '.system_generated', 'logs');
      const cursorDir = path.join(tmp, 'cursorWs', 'w1');
      const vscodeDir = path.join(tmp, 'vscodeWs', 'w1', 'chatSessions');
      const clineDir = path.join(tmp, 'clineTasks', 't1');
      const opencodeDir = path.join(tmp, 'opencode');

      for (const d of [claudeDir, codexDir, geminiDir, agyDir, cursorDir, vscodeDir, clineDir, opencodeDir]) {
        fs.mkdirSync(d, { recursive: true });
      }

      // Write corrupted files into every harvester's storage location
      fs.writeFileSync(path.join(claudeDir, 'bad.jsonl'), '<<<NOT_JSON>>>\n', 'utf8');
      fs.writeFileSync(path.join(codexDir, 'bad.jsonl'), '<<<NOT_JSON>>>\n', 'utf8');
      fs.writeFileSync(path.join(tmp, '.codex', 'state_5.sqlite'), 'NOT_A_SQLITE_DB', 'utf8');
      fs.writeFileSync(path.join(geminiDir, 'bad.json'), '{broken', 'utf8');
      fs.writeFileSync(path.join(agyDir, 'transcript.jsonl'), '{broken\n', 'utf8');
      fs.writeFileSync(path.join(cursorDir, 'workspace.json'), JSON.stringify({ folder: `file://${projRoot}` }), 'utf8');
      fs.writeFileSync(path.join(cursorDir, 'state.vscdb'), 'NOT_A_SQLITE_DB', 'utf8');
      fs.writeFileSync(path.join( tmp, 'vscodeWs', 'w1', 'workspace.json'), JSON.stringify({ folder: `file://${projRoot}` }), 'utf8');
      fs.writeFileSync(path.join(vscodeDir, 'bad.json'), '{broken', 'utf8');
      fs.writeFileSync(path.join(clineDir, 'ui_messages.json'), `{broken ${projRoot}`, 'utf8');
      fs.writeFileSync(path.join(opencodeDir, 'opencode.db'), 'NOT_A_SQLITE_DB', 'utf8');

      const env = {
        HOME: tmp,
        CLAUDE_CONFIG_DIR: path.join(tmp, '.claude'),
        CODEX_HOME: path.join(tmp, '.codex'),
        GEMINI_CLI_HOME: path.join(tmp, '.gemini'),
        ANTIGRAVITY_BRAIN_DIR: path.join(tmp, 'brain'),
        CURSOR_WORKSPACE_STORAGE_DIR: path.join(tmp, 'cursorWs'),
        VSCODE_WORKSPACE_STORAGE_DIR: path.join(tmp, 'vscodeWs'),
        CLINE_TASKS_DIR: path.join(tmp, 'clineTasks'),
        OPENCODE_DATA_DIR: opencodeDir,
      };

      const harvesters = SmartInferenceEngine.createHarvesters(projRoot, env);
      for (const h of harvesters) {
        const mtime = await h.getProjectScopedLatestMtime();
        assert.equal(typeof mtime, 'number');
        const sess = await h.harvestSession();
        assert.ok(sess === null || typeof sess === 'object');
      }

      fs.rmSync(projRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

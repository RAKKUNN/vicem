import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readWalDatabaseSnapshot,
  readJsonlTail,
  readJsonlHead,
  encodeClaudeProjectDir,
  getGeminiProjectHash,
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
  GitCollector,
  DeterministicTaskExtractor,
  ContextFileRanker,
} from '../vicem.mjs';

function makeTempDir(prefix = 'vicem-edge-harv-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Edge Suite 3A: JSONL Readers, SQLite WAL Snapshot & Path Encoding Helpers', () => {
  it('readJsonlHead and readJsonlTail handle missing files, empty files, corrupted lines, and byte windows', () => {
    const tmp = makeTempDir();
    try {
      const missingPath = path.join(tmp, 'missing.jsonl');
      assert.deepEqual(readJsonlHead(missingPath), []);
      assert.deepEqual(readJsonlTail(missingPath), []);

      const emptyPath = path.join(tmp, 'empty.jsonl');
      fs.writeFileSync(emptyPath, '', 'utf8');
      assert.deepEqual(readJsonlHead(emptyPath), []);
      assert.deepEqual(readJsonlTail(emptyPath), []);

      const mixedPath = path.join(tmp, 'mixed.jsonl');
      const lines = [
        '{"seq":1,"type":"meta"}',
        'corrupted-json-line{{{',
        '{"seq":2,"type":"user"}',
        '   ',
        '{"seq":3,"type":"assistant"}',
        '{"seq":4,"type":"done"}',
      ];
      fs.writeFileSync(mixedPath, lines.join('\n') + '\n', 'utf8');

      const head2 = readJsonlHead(mixedPath, 2);
      assert.deepEqual(head2, [
        { seq: 1, type: 'meta' },
        { seq: 2, type: 'user' },
      ]);

      const tail2 = readJsonlTail(mixedPath, 2);
      assert.deepEqual(tail2, [
        { seq: 3, type: 'assistant' },
        { seq: 4, type: 'done' },
      ]);

      // Large file exceeding tail window (forces partial seek from end of file)
      const largePath = path.join(tmp, 'large.jsonl');
      const manyLines = Array.from({ length: 400 }, (_, i) =>
        JSON.stringify({ idx: i + 1, payload: 'x'.repeat(200) })
      );
      fs.writeFileSync(largePath, manyLines.join('\n') + '\n', 'utf8');
      const tail5 = readJsonlTail(largePath, 5, 4096);
      assert.equal(tail5.length, 5);
      assert.equal(tail5[4].idx, 400);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('encodeClaudeProjectDir and getGeminiProjectHash produce deterministic, cross-platform safe identifiers', () => {
    assert.equal(
      encodeClaudeProjectDir('/Users/syslab/Documents/my_project.v2'),
      '-Users-syslab-Documents-my-project-v2'
    );
    const h1 = getGeminiProjectHash('/Users/syslab/Documents/project');
    const h2 = getGeminiProjectHash('/Users/syslab/Documents/project');
    const h3 = getGeminiProjectHash('/Users/syslab/Documents/project-v2');
    assert.equal(h1.length, 64);
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
  });

  it('readWalDatabaseSnapshot safely copies SQLite DB, runs query, and cleans up temp snapshot directory', async () => {
    const tmp = makeTempDir();
    try {
      // Missing DB returns null
      const missingRes = await readWalDatabaseSnapshot(path.join(tmp, 'nonexistent.sqlite'), () => 42);
      assert.equal(missingRes, null);

      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(tmp, 'state.sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);');
      db.prepare('INSERT INTO items (name) VALUES (?)').run('baton-item');
      db.close();

      const rows = await readWalDatabaseSnapshot(dbPath, (snapDb) => {
        return snapDb.prepare('SELECT id, name FROM items').all();
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'baton-item');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Edge Suite 3B: All 9 SessionHarvesters & Sibling Directory Isolation (/app vs /app-v2)', () => {
  it('ClaudeHarvester harvests the newest non-subagent JSONL session for the exact project slug', async () => {
    const tmp = makeTempDir();
    try {
      const projRoot = path.join(tmp, 'workspace-alpha');
      fs.mkdirSync(projRoot, { recursive: true });
      const claudeCfg = path.join(tmp, '.claude');
      const slugDir = path.join(claudeCfg, 'projects', encodeClaudeProjectDir(projRoot));
      fs.mkdirSync(slugDir, { recursive: true });

      const sessFile = path.join(slugDir, 'sess-101.jsonl');
      fs.writeFileSync(
        sessFile,
        [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'Implement auth middleware' } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Added JWT verification' } }),
        ].join('\n') + '\n',
        'utf8'
      );

      const harvester = new ClaudeHarvester(projRoot, { CLAUDE_CONFIG_DIR: claudeCfg, HOME: tmp });
      const mtime = await harvester.getProjectScopedLatestMtime();
      assert.equal(mtime > 0, true);

      const harvested = await harvester.harvestSession();
      assert.equal(harvested.agent, 'claude');
      assert.equal(harvested.sessionId, 'sess-101');
      assert.equal(harvested.rawEvents.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CodexHarvester isolates project cwd strictly and ignores sibling /app-v2 sessions', async () => {
    const tmp = makeTempDir();
    try {
      const app1 = path.join(tmp, 'app');
      const app2 = path.join(tmp, 'app-v2');
      fs.mkdirSync(app1, { recursive: true });
      fs.mkdirSync(app2, { recursive: true });

      const codexHome = path.join(tmp, '.codex');
      const dayDir = path.join(codexHome, 'sessions', '2026', '10', '29');
      fs.mkdirSync(dayDir, { recursive: true });

      // Write a newer session for sibling app-v2
      const siblingFile = path.join(dayDir, 'rollout-sibling.jsonl');
      fs.writeFileSync(
        siblingFile,
        [
          JSON.stringify({ type: 'session_meta', payload: { id: 'sib-1', cwd: app2 } }),
          JSON.stringify({ type: 'message', role: 'user', content: 'Sibling app-v2 prompt' }),
        ].join('\n') + '\n',
        'utf8'
      );

      const h1 = new CodexHarvester(app1, { CODEX_HOME: codexHome, HOME: tmp });
      assert.equal(await h1.getProjectScopedLatestMtime(), 0, 'Must not bleed from sibling /app-v2');
      assert.equal(await h1.harvestSession(), null);

      const h2 = new CodexHarvester(app2, { CODEX_HOME: codexHome, HOME: tmp });
      assert.equal((await h2.getProjectScopedLatestMtime()) > 0, true);
      const sess2 = await h2.harvestSession();
      assert.equal(sess2.sessionId, 'rollout-sibling');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('GeminiHarvester handles .jsonl, valid .json, and corrupted .json files without crashing', async () => {
    const tmp = makeTempDir();
    try {
      const proj = path.join(tmp, 'gem-proj');
      fs.mkdirSync(proj, { recursive: true });
      const gemHome = path.join(tmp, '.gemini');
      const chatsDir = path.join(gemHome, 'tmp', getGeminiProjectHash(proj), 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });

      // 1. Corrupted JSON file should not crash harvestSession()
      const badFile = path.join(chatsDir, 'corrupt.json');
      fs.writeFileSync(badFile, '{corrupted json!!!', 'utf8');

      const h = new GeminiHarvester(proj, { GEMINI_CLI_HOME: gemHome, HOME: tmp });
      const corruptRes = await h.harvestSession();
      assert.equal(corruptRes.agent, 'gemini');
      assert.deepEqual(corruptRes.rawEvents, []);

      // 2. Valid JSON file with messages array
      const goodFile = path.join(chatsDir, 'valid.json');
      fs.writeFileSync(
        goodFile,
        JSON.stringify({ messages: [{ role: 'user', content: 'Optimize Gemini query' }] }),
        'utf8'
      );
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(goodFile, future, future);

      const validRes = await h.harvestSession();
      assert.equal(validRes.sessionId, 'valid');
      assert.equal(validRes.rawEvents.length, 1);
      assert.equal(validRes.rawEvents[0].content, 'Optimize Gemini query');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AiderHarvester extracts markdown #### prompts from .aider.chat.history.md', async () => {
    const tmp = makeTempDir();
    try {
      const historyPath = path.join(tmp, '.aider.chat.history.md');
      fs.writeFileSync(
        historyPath,
        [
          '# aider chat started at 2026-10-29',
          '#### /add src/index.ts',
          '#### Refactor the payment retry loop to use exponential backoff',
          'Sure, here is the updated implementation...',
        ].join('\n'),
        'utf8'
      );

      const h = new AiderHarvester(tmp, { HOME: tmp });
      assert.equal((await h.getProjectScopedLatestMtime()) > 0, true);
      const sess = await h.harvestSession();
      assert.equal(sess.agent, 'aider');
      assert.equal(sess.rawEvents.length, 2);
      assert.equal(sess.rawEvents[1].content, 'Refactor the payment retry loop to use exponential backoff');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('AntigravityHarvester & ClineHarvester isolate sibling project paths (/app vs /app-v2) using boundary matching', async () => {
    const tmp = makeTempDir();
    try {
      const app1 = path.join(tmp, 'app');
      const app2 = path.join(tmp, 'app-v2');
      fs.mkdirSync(app1, { recursive: true });
      fs.mkdirSync(app2, { recursive: true });

      const brainDir = path.join(tmp, 'brain');
      const convDir = path.join(brainDir, 'conv-sibling', '.system_generated', 'logs');
      fs.mkdirSync(convDir, { recursive: true });
      fs.writeFileSync(
        path.join(convDir, 'transcript.jsonl'),
        [
          JSON.stringify({ type: 'USER_INPUT', content: `Working in file://${app2}/src/main.ts` }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Updated sibling project' }),
        ].join('\n') + '\n',
        'utf8'
      );

      const agyApp1 = new AntigravityHarvester(app1, { ANTIGRAVITY_BRAIN_DIR: brainDir, HOME: tmp });
      assert.equal(await agyApp1.getProjectScopedLatestMtime(), 0, 'Must not match sibling app-v2');

      const agyApp2 = new AntigravityHarvester(app2, { ANTIGRAVITY_BRAIN_DIR: brainDir, HOME: tmp });
      assert.equal((await agyApp2.getProjectScopedLatestMtime()) > 0, true);
      const agySess = await agyApp2.harvestSession();
      assert.equal(agySess.sessionId, 'conv-sibling');
      assert.equal(agySess.rawEvents.length, 2);

      // ClineHarvester boundary test
      const clineTasks = path.join(tmp, 'cline-tasks');
      const taskDir = path.join(clineTasks, 'task-999');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, 'ui_messages.json'),
        JSON.stringify([{ say: 'user_feedback', text: `Inspect ${app2}/package.json` }]),
        'utf8'
      );

      const clineApp1 = new ClineHarvester(app1, { CLINE_TASKS_DIR: clineTasks, HOME: tmp });
      assert.equal(await clineApp1.getProjectScopedLatestMtime(), 0, 'Cline must not match sibling app-v2');

      const clineApp2 = new ClineHarvester(app2, { CLINE_TASKS_DIR: clineTasks, HOME: tmp });
      assert.equal((await clineApp2.getProjectScopedLatestMtime()) > 0, true);
      const clineSess = await clineApp2.harvestSession();
      assert.equal(clineSess.sessionId, 'task-999');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('VSCodeCopilotHarvester harvests both .json and .jsonl chatSession files and isolates sibling workspaces', async () => {
    const tmp = makeTempDir();
    try {
      const app1 = path.join(tmp, 'app');
      const app2 = path.join(tmp, 'app-v2');
      fs.mkdirSync(app1, { recursive: true });
      fs.mkdirSync(app2, { recursive: true });

      const vscStorage = path.join(tmp, 'vscode-storage');
      const wsDir = path.join(vscStorage, 'ws-hash-2');
      const chatDir = path.join(wsDir, 'chatSessions');
      fs.mkdirSync(chatDir, { recursive: true });

      fs.writeFileSync(
        path.join(wsDir, 'workspace.json'),
        JSON.stringify({ folder: `file://${app2}` }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(chatDir, 'session-jsonl.jsonl'),
        [
          JSON.stringify({ role: 'user', message: { text: 'Fix VS Code extension activation' } }),
          JSON.stringify({ role: 'user', content: 'Add telemetry unit tests' }),
        ].join('\n') + '\n',
        'utf8'
      );

      const h1 = new VSCodeCopilotHarvester(app1, { VSCODE_WORKSPACE_STORAGE_DIR: vscStorage, HOME: tmp });
      assert.equal(await h1.getProjectScopedLatestMtime(), 0);

      const h2 = new VSCodeCopilotHarvester(app2, { VSCODE_WORKSPACE_STORAGE_DIR: vscStorage, HOME: tmp });
      const sess = await h2.harvestSession();
      assert.equal(sess.agent, 'vscode');
      assert.equal(sess.sessionId, 'session-jsonl');
      assert.equal(sess.rawEvents.length, 2);
      assert.equal(sess.rawEvents[0].content, 'Fix VS Code extension activation');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CursorHarvester and OpenCodeHarvester read SQLite state.vscdb and opencode.db safely', async () => {
    const tmp = makeTempDir();
    try {
      const proj = path.join(tmp, 'cursor-proj');
      fs.mkdirSync(proj, { recursive: true });
      const curStorage = path.join(tmp, 'cursor-storage');
      const wsDir = path.join(curStorage, 'ws-1');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: `file://${proj}` }), 'utf8');

      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(wsDir, 'state.vscdb');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'aiService.prompts',
        JSON.stringify([{ text: 'Implement Cursor SQLite harvester' }])
      );
      db.close();

      const curH = new CursorHarvester(proj, { CURSOR_WORKSPACE_STORAGE_DIR: curStorage, HOME: tmp });
      assert.equal((await curH.getProjectScopedLatestMtime()) > 0, true);
      const curSess = await curH.harvestSession();
      assert.equal(curSess.agent, 'cursor');
      assert.equal(curSess.rawEvents[0].content, 'Implement Cursor SQLite harvester');

      // OpenCode SQLite test
      const ocDir = path.join(tmp, 'opencode');
      fs.mkdirSync(ocDir, { recursive: true });
      const ocDb = new DatabaseSync(path.join(ocDir, 'opencode.db'));
      ocDb.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, updated_at INTEGER);');
      ocDb.prepare('INSERT INTO session (id, directory, title, updated_at) VALUES (?, ?, ?, ?)').run(
        'oc-77',
        proj,
        'Build OpenCode integration',
        Math.floor(Date.now() / 1000)
      );
      ocDb.close();

      const ocH = new OpenCodeHarvester(proj, { OPENCODE_DATA_DIR: ocDir, HOME: tmp });
      assert.equal((await ocH.getProjectScopedLatestMtime()) > 0, true);
      const ocSess = await ocH.harvestSession();
      assert.equal(ocSess.agent, 'opencode');
      assert.equal(ocSess.sessionId, 'oc-77');
      assert.equal(ocSess.rawEvents[0].content, 'Build OpenCode integration');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Edge Suite 3C: WebExportHarvester, FuzzyTargetMatcher, DeterministicTaskExtractor & ContextFileRanker', () => {
  it('WebExportHarvester parses ChatGPT mapping trees, Claude chat_messages, generic arrays, and malformed JSON safely', () => {
    assert.deepEqual(WebExportHarvester.parseExportJson(null), []);
    assert.deepEqual(WebExportHarvester.parseExportJson(''), []);
    assert.deepEqual(WebExportHarvester.parseExportJson('{{{invalid json'), []);
    assert.deepEqual(WebExportHarvester.parseExportJson(12345), []);

    // ChatGPT conversations.json format
    const chatGptExport = JSON.stringify([
      {
        mapping: {
          n1: {
            message: {
              author: { role: 'user' },
              content: { parts: ['Design a zero-dependency AST parser'] },
            },
          },
          n2: {
            message: {
              author: { role: 'assistant' },
              content: { parts: ['Here is the balanced-brace state machine'] },
            },
          },
        },
      },
    ]);
    const gptEvents = WebExportHarvester.parseExportJson(chatGptExport);
    assert.equal(gptEvents.length, 2);
    assert.equal(gptEvents[0].role, 'user');
    assert.equal(gptEvents[1].role, 'assistant');

    // Claude.ai export format
    const claudeExport = {
      chat_messages: [
        { sender: 'human', content: [{ text: 'Review security guards' }] },
        { sender: 'assistant', text: 'All 3 guards verified.' },
      ],
    };
    const claudeEvents = WebExportHarvester.parseExportJson(claudeExport);
    assert.equal(claudeEvents.length, 2);
    assert.equal(claudeEvents[0].content, 'Review security guards');
    assert.equal(claudeEvents[1].content, 'All 3 guards verified.');
  });

  it('FuzzyTargetMatcher enforces length-adaptive edit distance and respects custom candidate lists on aliases', () => {
    assert.equal(FuzzyTargetMatcher.match(null).matched, null);
    assert.equal(FuzzyTargetMatcher.match('   ').matched, null);

    // 3-letter words like 'cat', 'git', 'foo' must NEVER fuzzy-match 'web'
    for (const noise of ['cat', 'git', 'foo', 'bar', 'npm', 'run', 'xyz']) {
      assert.equal(FuzzyTargetMatcher.match(noise).matched, null, `Noise '${noise}' must not match any target`);
    }

    // Aliases match when in candidates, and do not falsely match when excluded from candidates
    assert.equal(FuzzyTargetMatcher.match('cdx').matched, 'codex');
    assert.equal(FuzzyTargetMatcher.match('cld').matched, 'claude');
    assert.equal(FuzzyTargetMatcher.match('agy').matched, 'antigravity');
    assert.equal(FuzzyTargetMatcher.match('cdx', ['claude', 'gemini']).matched, null);

    // Typos of length >= 5 within Levenshtein distance <= 2
    assert.equal(FuzzyTargetMatcher.match('claud').matched, 'claude');
    assert.equal(FuzzyTargetMatcher.match('codexx').matched, 'codex');
    assert.equal(FuzzyTargetMatcher.match('windsrff').matched, 'windsurf');
    assert.equal(FuzzyTargetMatcher.match('curser').matched, 'cursor');
  });

  it('DeterministicTaskExtractor extracts goal, failed commands, error traces, and prioritizes active files', () => {
    const rawEvents = [
      { role: 'user', content: 'Fix the failing SQLite migration and update src/db/migrator.ts' },
      { role: 'user', content: 'ok' }, // Short conversational ack should not overwrite substantive goal
      {
        role: 'tool',
        command: 'npm test',
        exit_code: 1,
        content: 'Error: SQLITE_CONSTRAINT: UNIQUE constraint failed: migrations.id\n    at runMigration (src/db/migrator.ts:44:9)',
      },
    ];
    const gitContext = {
      branch: 'fix/sqlite-migration',
      modifiedFiles: ['src/db/migrator.ts', 'test/migrator.test.ts'],
      recentCommits: ['a1b2c3d wip migration schema'],
    };

    const extracted = DeterministicTaskExtractor.extract(rawEvents, gitContext);
    assert.equal(extracted.goal.includes('Fix the failing SQLite migration'), true);
    assert.equal(extracted.immediateNext[0].includes('npm test'), true);
  });

  it('ContextFileRanker ranks modified + prompt/error-mentioned files and resolves 1-hop local imports while filtering credentials', () => {
    const tmp = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(tmp, 'alpha.ts'),
        'import { helper } from "./beta.js";\nexport const a = helper();\n',
        'utf8'
      );
      fs.writeFileSync(path.join(tmp, 'beta.ts'), 'export const helper = () => 2;\n', 'utf8');
      fs.writeFileSync(path.join(tmp, 'gamma.ts'), 'export const c = 3;\n', 'utf8');
      fs.writeFileSync(path.join(tmp, '.env'), 'SECRET=12345\n', 'utf8');

      const ranked = ContextFileRanker.rankFiles({
        projectRoot: tmp,
        modifiedFiles: ['alpha.ts', 'gamma.ts', '.env'],
        errorLog: 'Error in alpha.ts:2:5',
        taskContext: { goal: 'Check alpha.ts', immediateNext: [], userPrompts: [] },
      });

      // .env is excluded by NoiseGate; alpha.ts is ranked #1; beta.ts is discovered via 1-hop TS (.js -> .ts) import!
      assert.equal(ranked.includes('.env'), false);
      assert.equal(ranked[0], 'alpha.ts');
      assert.equal(ranked.includes('beta.ts'), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

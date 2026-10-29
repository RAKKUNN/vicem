import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  GitCollector,
  readWalDatabaseSnapshot,
  getGeminiProjectHash,
  encodeClaudeProjectDir,
  ClaudeHarvester,
  DeterministicTaskExtractor,
  FuzzyTargetMatcher,
  SmartInferenceEngine,
} from '../vicem.mjs';

test('TC-HARV-01: ClaudeHarvester reverse JSONL parsing scoped to project directory', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p3-claude-'));
  const fakeHome = path.join(tmpRoot, 'home');
  const projectDir = path.join(tmpRoot, 'my-project');
  fs.mkdirSync(projectDir, { recursive: true });

  const encoded = encodeClaudeProjectDir(projectDir);
  const claudeProjDir = path.join(fakeHome, '.claude', 'projects', encoded);
  fs.mkdirSync(claudeProjDir, { recursive: true });

  const sessionEvents = [
    { role: 'user', content: 'Implement JWT authentication middleware in src/auth.ts' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will set up the plan and edit src/auth.ts.' },
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Create JWT verifier function', status: 'completed' },
              { content: 'Add refresh token rotation', status: 'in_progress' },
            ],
          },
        },
      ],
    },
  ];
  const sessionFile = path.join(claudeProjDir, 'session-uuid-111.jsonl');
  fs.writeFileSync(sessionFile, sessionEvents.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  try {
    const harvester = new ClaudeHarvester(projectDir, { HOME: fakeHome });
    const harvested = await harvester.harvestSession();
    assert.ok(harvested);
    assert.equal(harvested.agent, 'claude');
    assert.equal(harvested.sessionId, 'session-uuid-111');
    assert.equal(harvested.rawEvents.length, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('TC-HARV-02: SQLite WAL Live Database Snapshot integrity read via node:sqlite backup()', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p3-wal-'));
  const dbPath = path.join(tmpDir, 'live.db');

  const { DatabaseSync } = await import('node:sqlite');
  const writerDb = new DatabaseSync(dbPath);
  try {
    writerDb.exec('PRAGMA journal_mode = WAL;');
    writerDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, updated_at INTEGER);');
    writerDb.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('t1', '/Users/dev/proj', Date.now());

    // While writerDb is still open in WAL mode, read snapshot via readWalDatabaseSnapshot
    const result = await readWalDatabaseSnapshot(dbPath, (snapDb) => {
      return snapDb.prepare('SELECT id, cwd FROM threads WHERE id = ?').get('t1');
    });

    assert.ok(result);
    assert.equal(result.id, 't1');
    assert.equal(result.cwd, '/Users/dev/proj');
  } finally {
    writerDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-HARV-03: Gemini CLI project hash matches SHA-256 of resolved project path', () => {
  const samplePath = '/Users/syslab/Documents/project';
  const expected = crypto.createHash('sha256').update(path.resolve(samplePath)).digest('hex');
  assert.equal(getGeminiProjectHash(samplePath), expected);
  assert.equal(getGeminiProjectHash(samplePath).length, 64);
});

test('TC-INFER-01: Project-Scoped Source auto-detection prevents cross-project bleed from newer sessions in other repos', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p3-infer-'));
  const fakeHome = path.join(tmpRoot, 'home');
  const projectA = path.join(tmpRoot, 'Project-A');
  const projectB = path.join(tmpRoot, 'Project-B');
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  // 1. Project-A has a Claude session modified 5 minutes ago
  const claudeDirA = path.join(fakeHome, '.claude', 'projects', encodeClaudeProjectDir(projectA));
  fs.mkdirSync(claudeDirA, { recursive: true });
  const claudeFileA = path.join(claudeDirA, 'claude-a.jsonl');
  fs.writeFileSync(claudeFileA, JSON.stringify({ role: 'user', content: 'Work on Project A' }) + '\n');
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(claudeFileA, fiveMinAgo, fiveMinAgo);

  // 2. Project-B has a Codex session modified 1 second ago (much newer globally, but belongs to Project-B!)
  const codexDir = path.join(fakeHome, '.codex', 'sessions');
  fs.mkdirSync(codexDir, { recursive: true });
  const codexFileB = path.join(codexDir, 'codex-b.jsonl');
  fs.writeFileSync(
    codexFileB,
    JSON.stringify({ cwd: projectB, role: 'user', content: 'Work on Project B' }) + '\n'
  );

  try {
    // Run autoDetectSource inside Project-A
    const detected = await SmartInferenceEngine.autoDetectSource(projectA, { HOME: fakeHome });
    assert.equal(
      detected.agent,
      'claude',
      'Must select Project-A Claude session (5m ago) and ignore Project-B Codex session (1s ago)'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('TC-INFER-02: Round-Trip vicem back previous source resolution from .vicem/baton.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p3-back-'));
  try {
    const vicemDir = path.join(tmpDir, '.vicem');
    fs.mkdirSync(vicemDir, { recursive: true });
    fs.writeFileSync(
      path.join(vicemDir, 'baton.json'),
      JSON.stringify({
        version: '5.3',
        source: { agent: 'claude', sessionId: 'session-999' },
        target: { agent: 'codex' },
      }),
      'utf8'
    );

    const prev = SmartInferenceEngine.getPreviousSource(tmpDir);
    assert.ok(prev);
    assert.equal(prev.agent, 'claude');
    assert.equal(prev.sessionId, 'session-999');
    assert.equal(prev.previousTarget, 'codex');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-INFER-03: Zero-LLM DeterministicTaskExtractor extracts Goal, Done, and Immediate NEXT from TodoWrite and failed Bash', () => {
  const rawEvents = [
    { role: 'user', content: 'ok' }, // Trivial prompt -> skipped for Goal
    { role: 'user', content: 'Build the payment webhook signature verifier and unit tests' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Implement HMAC SHA-256 signature verification', status: 'completed' },
              { content: 'Wire webhook route handler', status: 'completed' },
              { content: 'Fix replay attack timestamp check', status: 'in_progress' },
            ],
          },
        },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'npm test' },
          exit_code: 1,
        },
      ],
    },
  ];

  const extracted = DeterministicTaskExtractor.extract(rawEvents, null);
  assert.equal(extracted.goal, 'Build the payment webhook signature verifier and unit tests');
  assert.equal(extracted.done.length, 2);
  assert.ok(extracted.done.includes('Implement HMAC SHA-256 signature verification'));
  assert.ok(extracted.immediateNext.some((n) => n.includes("Fix failing command 'npm test'")));
  assert.ok(extracted.immediateNext.some((n) => n.includes('Fix replay attack timestamp check')));
});

test('TC-UX-01: Length-Adaptive FuzzyTargetMatcher resolves aliases & typos while preventing short-word over-matching', () => {
  // Aliases
  assert.equal(FuzzyTargetMatcher.match('cdx').matched, 'codex');
  assert.equal(FuzzyTargetMatcher.match('cld').matched, 'claude');
  assert.equal(FuzzyTargetMatcher.match('agy').matched, 'antigravity');
  assert.equal(FuzzyTargetMatcher.match('anti').matched, 'antigravity');
  assert.equal(FuzzyTargetMatcher.match('vsc').matched, 'vscode');
  assert.equal(FuzzyTargetMatcher.match('ide').matched, 'antigravity');

  // Typos (distance <= 2 on >= 5-char words)
  assert.equal(FuzzyTargetMatcher.match('codexx').matched, 'codex');
  assert.equal(FuzzyTargetMatcher.match('claud').matched, 'claude');
  assert.equal(FuzzyTargetMatcher.match('gemni').matched, 'gemini');
  assert.equal(FuzzyTargetMatcher.match('windsrff').matched, 'windsurf');

  // Over-matching prevention on unrelated 3-letter words
  assert.equal(FuzzyTargetMatcher.match('cat').matched, null);
  assert.equal(FuzzyTargetMatcher.match('git').matched, null);
  assert.equal(FuzzyTargetMatcher.match('foo').matched, null);
});

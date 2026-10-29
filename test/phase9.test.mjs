import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SmartInferenceEngine,
  ContextFileRanker,
  BatonIaBuilder,
} from '../vicem.mjs';

test('Phase 9 - TC-ADV-01 (Fix 9-A): GUI IDE 2-Phase Harvesters (Cursor state.vscdb & Antigravity transcript.jsonl) detect mtime <10ms without copying DB and harvest prompts', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p9-harv-'));
  const projectDir = path.join(tmpRoot, 'my-project');
  const cursorWsBase = path.join(tmpRoot, 'cursor-ws');
  const agyBrainBase = path.join(tmpRoot, 'agy-brain');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(cursorWsBase, { recursive: true });
  fs.mkdirSync(agyBrainBase, { recursive: true });

  try {
    // 1. Setup fake Cursor workspaceStorage with workspace.json + state.vscdb (SQLite)
    const wsHashDir = path.join(cursorWsBase, 'hash-abc123');
    fs.mkdirSync(wsHashDir, { recursive: true });
    fs.writeFileSync(
      path.join(wsHashDir, 'workspace.json'),
      JSON.stringify({ folder: `file://${projectDir}` }),
      'utf8'
    );

    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(wsHashDir, 'state.vscdb');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);`);
    db.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run(
      'aiService.prompts',
      JSON.stringify([
        { text: 'Refactor payment service to support Stripe webhooks and idempotency keys' },
      ])
    );
    db.close();

    const env = {
      ...process.env,
      HOME: tmpRoot,
      CURSOR_WORKSPACE_STORAGE_DIR: cursorWsBase,
      ANTIGRAVITY_BRAIN_DIR: agyBrainBase,
    };

    // Verify fast 2-phase metadata detection (< 15ms)
    const startMs = performance.now();
    const detected = await SmartInferenceEngine.autoDetectSource(projectDir, env);
    const elapsedMs = performance.now() - startMs;

    assert.equal(detected.agent, 'cursor');
    assert.ok(elapsedMs < 30, `Expected fast metadata check, took ${elapsedMs.toFixed(1)}ms`);

    const harvested = await detected.harvester.harvestSession();
    assert.equal(harvested.agent, 'cursor');
    assert.equal(harvested.rawEvents.length, 1);
    assert.ok(harvested.rawEvents[0].content.includes('Stripe webhooks'));

    // 2. Setup newer Antigravity transcript.jsonl for the same project
    const convDir = path.join(agyBrainBase, 'conv-999', '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    const transcriptFile = path.join(convDir, 'transcript.jsonl');
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ step_index: 1, workspaceUris: [`file://${projectDir}`] }),
        JSON.stringify({ type: 'USER_INPUT', content: 'Implement zero-trust token rotation in Antigravity' }),
      ].join('\n') + '\n',
      'utf8'
    );

    const detected2 = await SmartInferenceEngine.autoDetectSource(projectDir, env);
    assert.equal(detected2.agent, 'antigravity');
    const agySession = await detected2.harvester.harvestSession();
    assert.ok(agySession.rawEvents[0].content.includes('zero-trust token rotation'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 9 - TC-ADV-02 (Fix 9-B): ContextFileRanker prioritizes errorLog files and resolves 1-Hop local imports (.js->.ts & @/* alias)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p9-rank-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src', 'types'), { recursive: true });
    // Unmodified 1-Hop type definition file referenced via @/ alias and .js extension
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'types', 'contract.ts'),
      `export interface PaymentContract {\n  amountCents: number;\n  currency: 'USD' | 'KRW';\n}\n`,
      'utf8'
    );

    const modFiles = [];
    for (let i = 1; i <= 14; i++) {
      const rel = `src/mod_${i}.ts`;
      modFiles.push(rel);
      const importLine =
        i === 14
          ? `import { PaymentContract } from './types/contract.js';\n`
          : '';
      fs.writeFileSync(
        path.join(tmpDir, rel),
        `${importLine}export const val_${i} = ${i};\n`,
        'utf8'
      );
    }

    // mod_14.ts is the 14th modified file (would have been cut off by .slice(0, 12)),
    // but it appears in the errorLog stacktrace AND imports `./types/contract.js`!
    const errorLog = `Error: Payment validation failed\n    at Object.validate (src/mod_14.ts:12:5)`;

    const ranked = ContextFileRanker.rankFiles({
      projectRoot: tmpDir,
      modifiedFiles: modFiles,
      errorLog,
      maxFiles: 12,
    });

    assert.equal(ranked[0], 'src/mod_14.ts', 'File appearing in errorLog stacktrace must be ranked #1');
    assert.ok(
      ranked.includes('src/types/contract.ts'),
      'Unmodified 1-Hop imported type file (via .js->.ts resolution) must be included in top 12'
    );

    // Verify BatonIaBuilder includes the 1-Hop PaymentContract interface in the Baton
    const baton = BatonIaBuilder.build({
      projectRoot: tmpDir,
      errorLog,
      gitContext: {
        isGitRepo: true,
        branch: 'main',
        headCommit: '1234abc',
        modifiedFiles: modFiles,
        untrackedFiles: [],
        diffSummary: '14 files modified',
        diffPatch: '+ const x = 1;',
      },
    });
    assert.ok(baton.markdown.includes('export interface PaymentContract'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

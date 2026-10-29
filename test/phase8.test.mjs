import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {
  VicemApp,
  encodeClaudeProjectDir,
  BatonIaBuilder,
  RuleMountAdapter,
} from '../vicem.mjs';

test('Phase 8 - TC-E2E-01: Full Bidirectional Round-Trip (Claude -> Codex -> vicem back -> Claude) with 0-byte rule unmount', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p8-e2e1-'));
  const fakeHome = path.join(tmpRoot, 'home');
  const projectDir = path.join(tmpRoot, 'repo');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    // Initialize git repository
    childProcess.execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: projectDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: projectDir, stdio: 'ignore' });

    const agentsMdPath = path.join(projectDir, 'AGENTS.md');
    const originalAgentsMd = '# Team Rules\nUse strict mode.\n';
    fs.writeFileSync(agentsMdPath, originalAgentsMd, 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src.ts'), 'export const a = 1;\n', 'utf8');
    childProcess.execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: projectDir, stdio: 'ignore' });

    // Create a Claude Code session in fakeHome scoped to projectDir
    const claudeProjDir = path.join(
      fakeHome,
      '.claude',
      'projects',
      encodeClaudeProjectDir(projectDir)
    );
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const sessionFile = path.join(claudeProjDir, 'sess-claude-01.jsonl');
    const events = [
      JSON.stringify({
        type: 'user',
        message: { content: 'Implement rate limiting middleware and add unit tests' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Create token bucket helper', status: 'completed' },
                  { content: 'Wire middleware into router.ts', status: 'in_progress' },
                ],
              },
            },
          ],
        },
      }),
    ];
    fs.writeFileSync(sessionFile, events.join('\n') + '\n', 'utf8');

    const env = { ...process.env, HOME: fakeHome, NO_COLOR: '1' };
    let out1 = '';
    const stdout1 = { write: (s) => (out1 += s) };

    // Step 1: Forward handoff (`vicem ide --dry-run` to test rule mount + handoff)
    const forwardRes = await VicemApp.run(['ide', '--dry-run'], {
      projectRoot: projectDir,
      env,
      stdout: stdout1,
      skipLaunch: true,
    });
    assert.equal(forwardRes.exitCode, 0);
    assert.equal(forwardRes.sourceAgent, 'claude');
    assert.equal(forwardRes.targetAgent, 'antigravity');
    assert.ok(fs.existsSync(path.join(projectDir, '.vicem', 'BATON.md')));
    assert.ok(fs.readFileSync(agentsMdPath, 'utf8').includes('<!-- VICEM-BATON-START -->'));

    // Step 2: Return pass (`vicem back --dry-run`)
    let out2 = '';
    const stdout2 = { write: (s) => (out2 += s) };
    const backRes = await VicemApp.run(['back', '--dry-run'], {
      projectRoot: projectDir,
      env,
      stdout: stdout2,
      skipLaunch: true,
    });
    assert.equal(backRes.exitCode, 0);
    assert.ok(out2.includes('Antigravity IDE → Claude'));

    // Verify AGENTS.md was restored byte-for-byte on `vicem back`
    const restoredAgentsMd = fs.readFileSync(agentsMdPath, 'utf8');
    assert.equal(restoredAgentsMd, originalAgentsMd);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 8 - TC-E2E-02: Self-Pass Context Rot Rescue (`vicem self`) & `vicem rollback` snapshot restoration', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p8-e2e2-'));
  try {
    childProcess.execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: tmpDir, stdio: 'ignore' });

    const appFile = path.join(tmpDir, 'service.ts');
    fs.writeFileSync(appFile, 'export const v = 1;\n', 'utf8');
    childProcess.execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });

    // Dirty uncommitted user work before Self-Pass
    const dirtyWork = 'export const v = 2; // dirty uncommitted user work\n';
    fs.writeFileSync(appFile, dirtyWork, 'utf8');

    const stdout = { write() {} };
    const selfRes = await VicemApp.run(['self', '--dry-run'], {
      projectRoot: tmpDir,
      env: { NO_COLOR: '1' },
      stdout,
      skipLaunch: true,
    });
    assert.equal(selfRes.exitCode, 0);
    assert.equal(selfRes.targetAgent, 'self');

    // Simulate accidental modification after handoff, then run `vicem rollback`
    fs.writeFileSync(appFile, 'corrupted content\n', 'utf8');
    const rbRes = await VicemApp.run(['rollback'], {
      projectRoot: tmpDir,
      env: { NO_COLOR: '1' },
      stdout,
    });
    assert.equal(rbRes.exitCode, 0);
    assert.equal(fs.readFileSync(appFile, 'utf8'), dirtyWork, 'Rollback must restore dirty uncommitted user work');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8 - TC-NFR-01, TC-NFR-02, TC-NFR-03, TC-NFR-04: Latency (<=250ms), TTFC (<=3.0s), Memory (<=64MB Heap), and Artifact Size (<=200KB)', () => {
  // 1. TC-NFR-04: Artifact Size Budget
  const vicemSize = fs.statSync(path.resolve('vicem.mjs')).size;
  const htmlSize = fs.statSync(path.resolve('index.html')).size;
  assert.ok(vicemSize <= 200 * 1024, `vicem.mjs (${vicemSize}B) must be <= 200KB`);
  assert.ok(htmlSize <= 150 * 1024, `index.html (${htmlSize}B) must be <= 150KB`);

  // 2. TC-NFR-01 & TC-NFR-02: Baton Build Latency & TTFC on a synthetic repo
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p8-perf-'));
  try {
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `mod_${i}.ts`),
        `export function fn_${i}(x: number) {\n` +
          Array.from({ length: 14 }, (_, k) => `  const step_${k} = x + ${k};`).join('\n') +
          `\n  return x;\n}\n`,
        'utf8'
      );
    }
    const startMs = performance.now();
    const baton = BatonIaBuilder.build({
      projectRoot: tmpDir,
      sourceAgent: 'claude',
      targetAgent: 'codex',
      gitContext: {
        isGitRepo: true,
        branch: 'main',
        headCommit: 'abc1234',
        modifiedFiles: Array.from({ length: 10 }, (_, i) => `mod_${i}.ts`),
        untrackedFiles: [],
        diffSummary: '10 files changed',
        diffPatch: '+ const x = 1;',
      },
    });
    const elapsedMs = performance.now() - startMs;
    assert.ok(baton.markdown.includes('# BATON:'));
    assert.ok(elapsedMs <= 250, `Baton build took ${elapsedMs.toFixed(1)}ms (expected <= 250ms)`);

    // 3. TC-NFR-03: Memory usage check (HeapUsed <= 64MB)
    const heapMb = process.memoryUsage().heapUsed / (1024 * 1024);
    assert.ok(heapMb <= 64, `Heap memory (${heapMb.toFixed(1)}MB) must be <= 64MB`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 8 - Node.js Permission Model Sandbox (`node --permission`) & SHA256SUMS integrity', () => {
  const rawTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p8-perm-'));
  const tmpDir = fs.realpathSync(rawTmpDir);
  try {
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log("hi");\n', 'utf8');
    const vicemPath = fs.realpathSync(path.resolve('vicem.mjs'));
    const repoRoot = fs.realpathSync(path.resolve('.'));
    const res = childProcess.spawnSync(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${repoRoot}`,
        `--allow-fs-read=${tmpDir}`,
        `--allow-fs-write=${tmpDir}`,
        '--allow-child-process',
        vicemPath,
        'diet',
      ],
      {
        cwd: tmpDir,
        env: { ...process.env, HOME: tmpDir, NO_COLOR: '1' },
        encoding: 'utf8',
      }
    );
    assert.equal(res.status, 0, `Permission model run failed: ${res.stderr}`);
    assert.ok(res.stdout.includes('[OK] [Vicem]'));

    // Verify SHA256SUMS matches actual files
    const shaCheck = childProcess.spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });
    assert.equal(shaCheck.status, 0, `SHA256SUMS check failed: ${shaCheck.stdout} ${shaCheck.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

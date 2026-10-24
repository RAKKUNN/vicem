import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DietEngine,
  McpServerAdapter,
  QuotaRadar,
  TtySanitizer,
  PtyWrapController,
  VicemApp,
} from '../vicem.mjs';

test('Phase 6 - TC-GUARD-03: McpServerAdapter handles initialize (2024-11-05 & 2025-11-25), tools/list, and vicem_rehydrate with SecretRedactor', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p6-mcp-'));
  try {
    // 1. Populate DietEngine ledger with a skeletonized function >= 12 lines containing a secret
    const engine = new DietEngine(tmpDir);
    const tsCode = [
      'export async function verifyJwt(token: string) {',
      '  const secret = "sk-proj-99887766554433221100aabbccddeeff";',
      '  const line3 = 3;',
      '  const line4 = 4;',
      '  const line5 = 5;',
      '  const line6 = 6;',
      '  const line7 = 7;',
      '  const line8 = 8;',
      '  const line9 = 9;',
      '  const line10 = 10;',
      '  const line11 = 11;',
      '  return token === secret;',
      '}',
    ].join('\n');
    engine.dietCode('src/auth.ts', tsCode);
    engine.ledger.save(tmpDir);

    const mcp = new McpServerAdapter(tmpDir);

    // 2. Test Dual-Era protocol negotiation
    const init2024 = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(init2024.result.protocolVersion, '2024-11-05');

    const init2025 = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    assert.equal(init2025.result.protocolVersion, '2025-11-25');

    // 3. Notifications (no id) must return null (zero stdout response)
    const notifResp = await mcp.handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.equal(notifResp, null);

    // 4. tools/list
    const listResp = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    const toolNames = listResp.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes('vicem_rehydrate'));
    assert.ok(toolNames.includes('vicem_create_baton'));

    // 5. tools/call -> vicem_rehydrate
    const rehydrateResp = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'vicem_rehydrate',
        arguments: {
          file_path: 'src/auth.ts',
          symbol_name: 'verifyJwt',
        },
      },
    });
    assert.equal(rehydrateResp.result.isError, false);
    const rehydratedText = rehydrateResp.result.content[0].text;
    assert.ok(rehydratedText.includes('export async function verifyJwt'));
    assert.ok(rehydratedText.includes('return token === secret;'));
    assert.ok(
      !rehydratedText.includes('sk-proj-99887766554433221100aabbccddeeff'),
      'vicem_rehydrate must NEVER leak unredacted secrets to external agents'
    );
    assert.ok(rehydratedText.includes('‹REDACTED:OPENAI:'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 6 - TC-UX-07: QuotaRadar ignores generic "429" test logs & triggers only on vendor banner + >=500ms idle', () => {
  // 1. Generic "429" inside user test output must NOT trigger false positive
  const testOutput = `PASS src/rateLimiter.test.ts\n  ✓ returns HTTP 429 Too Many Requests when rate limit exceeded (12ms)`;
  const falseCheck = QuotaRadar.detectVendorLimit(testOutput, 1000);
  assert.equal(falseCheck.triggered, false, 'Must not false-trigger on user test log containing 429');

  // 2. Vendor banner while output is still actively streaming (< 500ms idle) must wait
  const claudeBanner = `Error: You've hit your limit for Claude Opus. Resets at 5pm.`;
  const activeStreamCheck = QuotaRadar.detectVendorLimit(claudeBanner, 120);
  assert.equal(activeStreamCheck.triggered, false, 'Must not trigger before 500ms idle threshold');

  // 3. Vendor banner + >= 500ms idle triggers accurately
  const idleCheck = QuotaRadar.detectVendorLimit(claudeBanner, 600);
  assert.equal(idleCheck.triggered, true);
  assert.equal(idleCheck.vendor, 'claude');

  // 4. Countdown prompt and TtySanitizer reset sequence
  const prompt = PtyWrapController.renderCountdownPrompt(idleCheck.reason, 'codex', 3, { NO_COLOR: '1' });
  assert.ok(prompt.includes('Enter: Now / Esc: Cancel'));

  const resetSeq = TtySanitizer.getResetSequence();
  assert.ok(resetSeq.includes('\x1b[?1049l'), 'Must exit alternate screen buffer');
  assert.ok(resetSeq.includes('\x1b[?25h'), 'Must restore cursor visibility');
});

test('Phase 6 - Task 6.3: SKILL.md and AGENTS.snippet.md exist and contain valid frontmatter & safety rules', () => {
  const skillPath = path.resolve('.agents/skills/vicem/SKILL.md');
  const snippetPath = path.resolve('AGENTS.snippet.md');
  assert.ok(fs.existsSync(skillPath), '.agents/skills/vicem/SKILL.md must exist');
  assert.ok(fs.existsSync(snippetPath), 'AGENTS.snippet.md must exist');

  const skillText = fs.readFileSync(skillPath, 'utf8');
  assert.ok(skillText.startsWith('---\nname: vicem\ndescription:'));
  assert.ok(skillText.includes('vicem_rehydrate'));

  const snippetText = fs.readFileSync(snippetPath, 'utf8');
  assert.ok(snippetText.includes('SkeletonWriteGuard'));
});

test('Phase 6 - VicemApp CLI router handles fuzzy target correction, mount/unmount, and guard in dry-run mode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p6-cli-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export const x = 1;\n', 'utf8');
    let output = '';
    const mockStdout = {
      write(str) {
        output += str;
      },
    };

    const res = await VicemApp.run(['codexx', '--dry-run'], {
      projectRoot: tmpDir,
      stdout: mockStdout,
      env: { NO_COLOR: '1' },
      skipLaunch: true,
    });

    assert.equal(res.exitCode, 0);
    assert.equal(res.targetAgent, 'codex');
    assert.ok(output.includes("Auto-corrected 'codexx' → 'codex'"));
    assert.ok(fs.existsSync(path.join(tmpDir, '.vicem', 'BATON.md')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

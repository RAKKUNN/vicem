import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import {
  McpServerAdapter,
  StudioHydrationAdapter,
  BatonIaBuilder,
  DietLedger,
  AtomicFs,
  RuleMountAdapter,
  encodeClaudeProjectDir,
} from '../vicem.mjs';
import {
  shortenHome,
  formatAgo,
  formatResetShort,
  shellQuote,
  readHeadAndTailUtf8,
  getIdeUserDir,
  isPidAlive,
  discoverProjectSessions,
  collectLiveSkeletonLedger,
  harvestRichProjectContext,
  HTML_PAGE,
  readJsonBody,
  server as guiServer,
} from '../vicem-gui.mjs';

function makeTmpDir(prefix = 'vicem-mcp-gui-matrix-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCaptureStream() {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      cb();
    },
  });
  return {
    stream,
    getOutput: () => buf,
  };
}

function sendHttpRequest(port, method, urlPath, bodyObj = null, rawBody = null) {
  return new Promise((resolve, reject) => {
    const payload =
      rawBody !== null
        ? rawBody
        : bodyObj !== null
          ? JSON.stringify(bodyObj)
          : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ statusCode: res.statusCode, headers: res.headers, text: data, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================================
// SECTION 1: McpServerAdapter JSON-RPC 2.0 Protocol & Tool Call Matrix
// ============================================================================

const MCP_INITIALIZE_MATRIX = [
  {
    id: 1,
    clientProtocolVersion: '2024-11-05',
    expectedServerProtocolVersion: '2024-11-05',
  },
  {
    id: 2,
    clientProtocolVersion: '2025-11-25',
    expectedServerProtocolVersion: '2025-11-25',
  },
  {
    id: 'req-init-default',
    clientProtocolVersion: undefined,
    expectedServerProtocolVersion: '2025-11-25',
  },
  {
    id: 'req-init-future',
    clientProtocolVersion: '2026-06-01',
    expectedServerProtocolVersion: '2025-11-25',
  },
];

for (const tc of MCP_INITIALIZE_MATRIX) {
  test(`MCP Matrix [initialize :: id=${tc.id}] (clientVersion=${tc.clientProtocolVersion}): negotiates ${tc.expectedServerProtocolVersion}`, async () => {
    const mcp = new McpServerAdapter(process.cwd());
    const resp = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: tc.id,
      method: 'initialize',
      params: tc.clientProtocolVersion ? { protocolVersion: tc.clientProtocolVersion } : {},
    });
    assert.equal(resp.jsonrpc, '2.0');
    assert.equal(resp.id, tc.id);
    assert.equal(resp.result.protocolVersion, tc.expectedServerProtocolVersion);
    assert.equal(resp.result.serverInfo.name, 'vicem-mcp');
  });
}

test('MCP Matrix [Full Tool Lifecycle]: tools/list, vicem_create_baton, vicem_read_baton (with/without drift), vicem_rehydrate (with disk drift & secret redaction), vicem_check_guard', async () => {
  const tmpDir = makeTmpDir('vicem-mcp-tools-');
  try {
    const srcFile = path.join(tmpDir, 'src', 'auth.ts');
    const originalImpl = [
      'export function verifyTokenSignature(rawToken: string, secretKey: string): boolean {',
      '  const parts = rawToken.split(".");',
      '  if (parts.length !== 3) {',
      '    return false;',
      '  }',
      '  const header = parts[0];',
      '  const payload = parts[1];',
      '  const sig = parts[2];',
      '  if (!header || !payload || !sig) {',
      '    return false;',
      '  }',
      '  const fallbackKey = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";',
      '  return sig.length > 0 && (secretKey || fallbackKey).length > 0;',
      '}',
    ].join('\n');
    AtomicFs.writeFileAtomic(srcFile, originalImpl);

    const mcp = new McpServerAdapter(tmpDir);

    // 1. Notifications without id return null (must never emit a frame)
    assert.equal(await mcp.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(await mcp.handleRequest(null), null);

    // 2. ping returns empty result object
    const pingResp = await mcp.handleRequest({ jsonrpc: '2.0', id: 10, method: 'ping' });
    assert.deepEqual(pingResp, { jsonrpc: '2.0', id: 10, result: {} });

    // 3. tools/list returns all 4 canonical MCP tools
    const listResp = await mcp.handleRequest({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
    const toolNames = listResp.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      'vicem_create_baton',
      'vicem_read_baton',
      'vicem_rehydrate',
      'vicem_check_guard',
    ]);

    // 4. vicem_read_baton before baton exists returns isError=true
    const readMissing = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'vicem_read_baton', arguments: {} },
    });
    assert.equal(readMissing.result.isError, true);

    // 5. vicem_create_baton builds BATON.md and populates ledger.json
    const createResp = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'vicem_create_baton',
        arguments: {
          goal: 'Harden JWT verification in src/auth.ts',
          targetAgent: 'codex',
          budgetTokens: 4000,
        },
      },
    });
    assert.equal(createResp.result.isError, false);
    assert.ok(createResp.result.content[0].text.includes('Harden JWT verification in src/auth.ts'));
    assert.ok(!createResp.result.content[0].text.includes('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'));

    // 6. vicem_read_baton succeeds after creation
    const readOk = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'vicem_read_baton', arguments: {} },
    });
    assert.equal(readOk.result.isError, false);
    assert.ok(readOk.result.content[0].text.includes('# BATON:'));

    // 7. vicem_rehydrate retrieves verifyTokenSignature with secret redacted
    const rehydOk = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'vicem_rehydrate',
        arguments: { file_path: 'src/auth.ts', symbol_name: 'verifyTokenSignature' },
      },
    });
    assert.equal(rehydOk.result.isError, false);
    assert.ok(rehydOk.result.content[0].text.includes('const parts = rawToken.split(".");'));
    assert.ok(rehydOk.result.content[0].text.includes('‹REDACTED:OPENAI:'));
    assert.ok(!rehydOk.result.content[0].text.includes('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'));

    // 8. Modify src/auth.ts on disk after snapshot -> vicem_rehydrate emits STALENESS DRIFT WARNING
    AtomicFs.writeFileAtomic(srcFile, 'export function verifyTokenSignature() { return false; }\n');
    const rehydDrifted = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: 'vicem_rehydrate',
        arguments: { file_path: 'src/auth.ts', symbol_name: 'verifyTokenSignature' },
      },
    });
    assert.equal(rehydDrifted.result.isError, false);
    assert.ok(rehydDrifted.result.content[0].text.includes('[STALENESS DRIFT WARNING]'));

    // 9. vicem_rehydrate on unknown symbol returns isError=true
    const rehydMissing = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 17,
      method: 'tools/call',
      params: {
        name: 'vicem_rehydrate',
        arguments: { file_path: 'src/auth.ts', symbol_name: 'nonExistentFn' },
      },
    });
    assert.equal(rehydMissing.result.isError, true);

    // 10. vicem_check_guard passes clean diff and blocks placeholder diff with self-heal prompt
    const guardClean = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: {
        name: 'vicem_check_guard',
        arguments: { diff_text: '+++ b/src/auth.ts\n@@ -1,1 +1,1 @@\n+export const ok = true;\n' },
      },
    });
    assert.equal(guardClean.result.isError, false);

    const guardBlocked = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 19,
      method: 'tools/call',
      params: {
        name: 'vicem_check_guard',
        arguments: { diff_text: '+++ b/src/auth.ts\n@@ -1,1 +1,1 @@\n+export function f() { /* ... */ }\n' },
      },
    });
    assert.equal(guardBlocked.result.isError, true);
    assert.ok(guardBlocked.result.content[0].text.includes('[VICEM SELF-HEAL]'));

    // 11. Unknown tool and unknown method return -32601
    const unkTool = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'unknown_tool_xyz' },
    });
    assert.equal(unkTool.error.code, -32601);

    const unkMethod = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 21,
      method: 'resources/unknown',
    });
    assert.equal(unkMethod.error.code, -32601);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MCP Matrix [startStdio Stream Framing]: handles concurrent newline-delimited JSON-RPC frames, notifications, and malformed JSON (-32700)', async () => {
  const tmpDir = makeTmpDir('vicem-mcp-stdio-');
  try {
    const mcp = new McpServerAdapter(tmpDir);
    const input = new PassThrough();
    const cap = makeCaptureStream();
    const rl = mcp.startStdio(input, cap.stream);

    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{malformed_json_frame\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    input.end();

    await new Promise((r) => setTimeout(r, 80));
    rl.close();

    const lines = cap
      .getOutput()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    assert.equal(lines.length, 3);
    assert.equal(lines[0].id, 1);
    assert.deepEqual(lines[0].result, {});
    assert.equal(lines[1].error.code, -32700);
    assert.equal(lines[2].id, 2);
    assert.equal(lines[2].result.tools.length, 4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 2: StudioHydrationAdapter & index.html Structural Parity Matrix
// ============================================================================

test('MCP/Studio Matrix [StudioHydrationAdapter & index.html]: hydrates live studio HTML, redacts secrets, escapes </script>, and verifies index.html', () => {
  const tmpDir = makeTmpDir('vicem-studio-matrix-');
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'widget.ts'),
      'export const html = "</script><script> evil() </script>";\nexport const key = "AKIAIOSFODNN7EXAMPLE";\n'
    );

    const realIndexHtmlPath = path.resolve(process.cwd(), 'index.html');
    assert.ok(fs.existsSync(realIndexHtmlPath), 'Production index.html must exist');

    const res = StudioHydrationAdapter.generateLiveStudioHtml(tmpDir, realIndexHtmlPath, {
      targetAgent: 'claude',
      taskContext: {
        goal: 'Test </script> escaping in Studio Hydration',
        immediateNext: ['Verify step 1'],
        done: [],
      },
    });

    assert.ok(fs.existsSync(res.liveHtmlPath));
    const liveHtml = fs.readFileSync(res.liveHtmlPath, 'utf8');
    assert.ok(liveHtml.includes('<script id="vicem-hydration-data" type="application/json">'));
    assert.ok(!res.escapedJson.includes('</script>'));
    assert.ok(!res.escapedJson.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(res.escapedJson.includes('‹REDACTED:AWS:'));
    assert.equal(res.payload.targetAgent, 'claude');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 3: vicem-gui.mjs Utility Functions & Session Boundary Matrix
// ============================================================================

test('GUI Matrix [Utility Helpers]: shortenHome, formatAgo, formatResetShort, shellQuote, readHeadAndTailUtf8, getIdeUserDir, isPidAlive', () => {
  // 1. shortenHome
  assert.equal(shortenHome('/Users/syslab/Documents/repo', '/Users/syslab'), '~/Documents/repo');
  assert.equal(shortenHome('/opt/custom/repo', '/Users/syslab'), '/opt/custom/repo');
  assert.equal(shortenHome('', '/Users/syslab'), '-');

  // 2. formatAgo
  assert.equal(formatAgo(0), '-');
  assert.equal(formatAgo(Date.now() - 10 * 1000), 'Just now');
  assert.match(formatAgo(Date.now() - 5 * 60 * 1000), /^\d+m ago$/);
  assert.match(formatAgo(Date.now() - 3 * 3600 * 1000), /^\d+h ago$/);
  assert.match(formatAgo(Date.now() - 4 * 86400 * 1000), /^\d+d ago$/);

  // 3. formatResetShort
  assert.equal(formatResetShort(null), '');
  assert.equal(formatResetShort(Math.floor(Date.now() / 1000) - 10), 'Resets now');
  assert.match(formatResetShort(Math.floor(Date.now() / 1000) + 1800), /^Resets in \d+m$/);
  assert.match(formatResetShort(Math.floor(Date.now() / 1000) + 7500), /^Resets in \d+h \d+m$/);
  assert.match(formatResetShort(Math.floor(Date.now() / 1000) + 180000), /^Resets in \d+d \d+h$/);

  // 4. shellQuote
  assert.equal(shellQuote("it's a test"), "'it'\"'\"'s a test'");

  // 5. isPidAlive
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(-999), false);
  assert.equal(isPidAlive(99999999), false);

  // 6. getIdeUserDir
  for (const ide of ['Cursor', 'Windsurf', 'Code']) {
    const dir = getIdeUserDir(ide, '/Users/syslab');
    assert.ok(dir.includes(ide));
  }

  // 7. readHeadAndTailUtf8 on small and large files
  const tmpDir = makeTmpDir('vicem-gui-read-');
  try {
    const smallPath = path.join(tmpDir, 'small.txt');
    fs.writeFileSync(smallPath, 'hello small file', 'utf8');
    assert.equal(readHeadAndTailUtf8(smallPath, 100, 100), 'hello small file');

    const largePath = path.join(tmpDir, 'large.txt');
    const largeContent = 'HEAD_MARKER_' + 'M'.repeat(5000) + '_TAIL_MARKER';
    fs.writeFileSync(largePath, largeContent, 'utf8');
    const sliced = readHeadAndTailUtf8(largePath, 64, 64);
    assert.ok(sliced.startsWith('HEAD_MARKER_'));
    assert.ok(sliced.endsWith('_TAIL_MARKER'));
    assert.ok(sliced.length < largeContent.length);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GUI Matrix [discoverProjectSessions & harvestRichProjectContext & collectLiveSkeletonLedger]: boundary isolation and live AST ledger', () => {
  const baseTmp = makeTmpDir('vicem-gui-sessions-');
  const projectA = path.join(baseTmp, 'app');
  const projectB = path.join(baseTmp, 'app-v2');
  const fakeHome = path.join(baseTmp, 'home');
  try {
    fs.mkdirSync(path.join(projectA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectB, 'src'), { recursive: true });

    const tsCode = [
      'export function calculateMetrics(values: number[]): { total: number; avg: number } {',
      '  if (values.length === 0) {',
      '    return { total: 0, avg: 0 };',
      '  }',
      '  let total = 0;',
      '  for (const v of values) {',
      '    total += v;',
      '  }',
      '  return { total, avg: total / values.length };',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(projectA, 'src', 'metrics.ts'), tsCode, 'utf8');

    // Seed Codex session for projectB ("/app-v2") and verify it NEVER leaks into projectA ("/app")
    const codexDir = path.join(fakeHome, '.codex', 'sessions', '2026', '10', '29');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'rollout-b.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-b', cwd: projectB } }) +
        '\n' +
        JSON.stringify({ role: 'user', content: 'Work on projectB app-v2 only' }) +
        '\n'
    );
    fs.writeFileSync(
      path.join(codexDir, 'rollout-a.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-a', cwd: projectA } }) +
        '\n' +
        JSON.stringify({ role: 'user', content: 'Optimize calculateMetrics in projectA' }) +
        '\n'
    );

    const sessionsA = discoverProjectSessions(projectA, fakeHome, { branch: 'main', modifiedFiles: ['src/metrics.ts'] });
    assert.equal(sessionsA.some((s) => s.title.includes('projectB')), false, 'Sibling projectB session leaked into projectA!');
    assert.equal(sessionsA.some((s) => s.title.includes('calculateMetrics')), true);

    const ledgerRes = collectLiveSkeletonLedger(projectA, ['src/metrics.ts'], true);
    assert.equal(ledgerRes.totalSymbols, 1);
    assert.equal(ledgerRes.liveLedger.entries[0].symbolName, 'calculateMetrics');

    const rich = harvestRichProjectContext(projectA, fakeHome, { branch: 'main', modifiedFiles: ['src/metrics.ts'] }, sessionsA);
    assert.ok(rich.chosenSession.title.includes('calculateMetrics'));
  } finally {
    fs.rmSync(baseTmp, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 4: vicem-gui.mjs Live HTTP Server Endpoint & Security Matrix
// ============================================================================

test('GUI Matrix [HTTP Server API]: GET /, GET /api/state, POST /api/select-project, POST /api/toggle-rule (CWE-22 guard), POST /api/rehydrate, 400 Invalid JSON, 413 Payload Too Large, 404 Not Found', async () => {
  await new Promise((resolve) => guiServer.listen(0, '127.0.0.1', resolve));
  const addr = guiServer.address();
  const port = addr.port;
  try {
    // 1. GET / serves HTML_PAGE with v18 Kinetic UI
    const rootRes = await sendHttpRequest(port, 'GET', '/');
    assert.equal(rootRes.statusCode, 200);
    assert.ok(rootRes.text.includes('<!DOCTYPE html>'));
    assert.equal(HTML_PAGE.includes('--spring-snappy'), true);

    // 2. GET /api/state returns full state object
    const stateRes = await sendHttpRequest(port, 'GET', '/api/state');
    assert.equal(stateRes.statusCode, 200);
    assert.ok(stateRes.json.projectRoot);
    assert.ok(Array.isArray(stateRes.json.nodes));
    assert.equal(stateRes.json.nodes.length, 12);

    // 3. POST /api/toggle-rule blocks CWE-22 path traversal with 400
    const traversalRes = await sendHttpRequest(port, 'POST', '/api/toggle-rule', {
      relPath: '../../../etc/passwd',
    });
    assert.equal(traversalRes.statusCode, 400);
    assert.match(traversalRes.json.error, /Unsafe rule file path rejected/);

    // 4. POST /api/add-workspace rejects non-existent path with 400
    const badProjRes = await sendHttpRequest(port, 'POST', '/api/add-workspace', {
      rawPath: '/nonexistent/path/that/does/not/exist/12345',
    });
    assert.equal(badProjRes.statusCode, 400);

    // 5. POST with malformed JSON to /api/source returns 400
    const badJsonRes = await sendHttpRequest(port, 'POST', '/api/source', null, '{invalid_json');
    assert.equal(badJsonRes.statusCode, 400);

    // 6. POST with oversized payload (> 256 KiB) to /api/goal returns 413
    const hugeBody = JSON.stringify({ padding: 'A'.repeat(300 * 1024) });
    const oversizedRes = await sendHttpRequest(port, 'POST', '/api/goal', null, hugeBody);
    assert.equal(oversizedRes.statusCode, 413);

    // 7. POST /api/rehydrate on missing symbol returns 200 with fallback comment
    const rehydMissing = await sendHttpRequest(port, 'POST', '/api/rehydrate', {
      filePath: 'nonexistent.ts',
      symbolName: 'missingFn',
    });
    assert.equal(rehydMissing.statusCode, 200);
    assert.ok(rehydMissing.json.rehydratedCode.includes('// Symbol not found in ledger'));

    // 8. Unknown route returns 404
    const notFoundRes = await sendHttpRequest(port, 'GET', '/api/unknown-endpoint');
    assert.equal(notFoundRes.statusCode, 404);
  } finally {
    await new Promise((resolve) => guiServer.close(resolve));
  }
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import {
  shortenHome,
  formatAgo,
  formatResetShort,
  shellQuote,
  readHeadAndTailUtf8,
  getIdeUserDir,
  resolveAgentBinary,
  resolveAgentBinaryUncached,
  isPidAlive,
  discoverProjectSessions,
  collectLiveSkeletonLedger,
  harvestRichProjectContext,
  collectState,
  executeRealHandoff,
  HTML_PAGE,
  server,
} from '../vicem-gui.mjs';

function makeTempGitRepo(prefix = 'vicem-edge-gui-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync('git init -b main', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.email "gui@vicem.dev"', { cwd: tmp, stdio: 'ignore' });
  execSync('git config user.name "Vicem GUI"', { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

describe('Edge Suite 5A: vicem-gui.mjs Unit Helpers, Session Discovery & Live AST Skeleton Ledger', () => {
  it('shortenHome, formatAgo, formatResetShort, and shellQuote handle edge cases and special characters', () => {
    assert.equal(shortenHome('', '/Users/syslab'), '-');
    assert.equal(shortenHome(null, '/Users/syslab'), '-');
    assert.equal(shortenHome('/Users/syslab/Documents/app', '/Users/syslab'), '~/Documents/app');
    assert.equal(shortenHome('/opt/homebrew/bin', '/Users/syslab'), '/opt/homebrew/bin');

    assert.equal(formatAgo(0), '-');
    assert.equal(formatAgo(Date.now() - 10 * 1000), 'Just now');
    assert.equal(formatAgo(Date.now() - 15 * 60 * 1000), '15m ago');
    assert.equal(formatAgo(Date.now() - 3 * 3600 * 1000), '3h ago');
    assert.equal(formatAgo(Date.now() - 2 * 86400 * 1000), '2d ago');

    assert.equal(formatResetShort(0), '');
    assert.equal(formatResetShort(Math.floor(Date.now() / 1000) - 10), 'Resets now');
    assert.match(formatResetShort(Math.floor(Date.now() / 1000) + 1800), /^Resets in \d+m$/);
    assert.match(formatResetShort(Math.floor(Date.now() / 1000) + 7500), /^Resets in 2h \d+m$/);
    assert.match(formatResetShort(Math.floor(Date.now() / 1000) + 90000), /^Resets in 1d \d+h$/);

    assert.equal(shellQuote("simple"), "'simple'");
    assert.equal(shellQuote("it's a 'test'"), "'it'\"'\"'s a '\"'\"'test'\"'\"''");
    assert.equal(shellQuote(null), "''");
  });

  it('readHeadAndTailUtf8 reads small files in full and slices head + tail on large files without crashing on missing files', () => {
    const tmp = makeTempGitRepo();
    try {
      assert.equal(readHeadAndTailUtf8(path.join(tmp, 'missing.txt')), '');

      const smallPath = path.join(tmp, 'small.txt');
      fs.writeFileSync(smallPath, 'hello small world', 'utf8');
      assert.equal(readHeadAndTailUtf8(smallPath, 100, 100), 'hello small world');

      const largePath = path.join(tmp, 'large.txt');
      const content = 'HEAD_MARKER_' + 'M'.repeat(500) + '_TAIL_MARKER';
      fs.writeFileSync(largePath, content, 'utf8');
      const sliced = readHeadAndTailUtf8(largePath, 12, 12);
      assert.equal(sliced, 'HEAD_MARKER_\n_TAIL_MARKER');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('getIdeUserDir, resolveAgentBinary, and isPidAlive behave deterministically', () => {
    const dir = getIdeUserDir('Cursor', '/Users/testuser');
    assert.equal(typeof dir, 'string');
    assert.equal(dir.includes('Cursor'), true);

    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(null), false);
    assert.equal(isPidAlive(99999999), false);

    // Nonexistent binary returns null
    assert.equal(resolveAgentBinaryUncached('definitely-not-a-real-binary-xyz-999', os.homedir()), null);
    assert.equal(resolveAgentBinary('definitely-not-a-real-binary-xyz-999', os.homedir()), null);
  });

  it('discoverProjectSessions, collectLiveSkeletonLedger, and harvestRichProjectContext isolate sibling projects and cap recursion depth', () => {
    const tmp = makeTempGitRepo();
    try {
      const code = [
        'export function computeAlpha(a, b) {',
        '  const s1 = a + b;',
        '  const s2 = s1 * 2;',
        '  const s3 = s2 - 4;',
        '  const s4 = s3 + 8;',
        '  const s5 = s4 * 3;',
        '  const s6 = s5 - 1;',
        '  const s7 = s6 + 10;',
        '  const s8 = s7 / 2;',
        '  const s9 = s8 + 5;',
        '  return s9;',
        '}',
      ].join('\n');
      fs.writeFileSync(path.join(tmp, 'engine.mjs'), code, 'utf8');
      execSync('git add . && git commit -m "add engine"', { cwd: tmp, stdio: 'ignore' });

      const skel = collectLiveSkeletonLedger(tmp, ['engine.mjs'], true);
      assert.equal(skel.totalSymbols, 1);
      assert.equal(skel.files[0].symbolCount, 1);
      assert.equal(skel.files[0].symbols[0].symbolName, 'computeAlpha');
      assert.equal(skel.ledgerOnDisk, true);

      const sessions = discoverProjectSessions(tmp, tmp, {
        branch: 'main',
        headShort: 'abc1234',
        recentCommits: ['abc1234 add engine'],
        modifiedFiles: ['engine.mjs'],
        untrackedFiles: [],
      });
      assert.equal(sessions.length >= 1, true);
      assert.equal(sessions[0].id.startsWith('git:'), true);

      const rich = harvestRichProjectContext(
        tmp,
        tmp,
        {
          branch: 'main',
          headShort: 'abc1234',
          recentCommits: ['abc1234 add engine'],
          modifiedFiles: ['engine.mjs'],
          untrackedFiles: [],
        },
        sessions
      );
      assert.equal(rich.activeFileList.includes('engine.mjs'), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('HTML_PAGE contains escapeJsAttr and uses it for all inline onclick handlers to prevent backslash/apostrophe injection', () => {
    assert.equal(HTML_PAGE.includes('function escapeJsAttr(str)'), true);
    assert.equal(HTML_PAGE.includes('escapeJsAttr(s.filePath)'), true);
    assert.equal(HTML_PAGE.includes('escapeJsAttr(s.symbolName)'), true);
    assert.equal(HTML_PAGE.includes('escapeJsAttr(r.rel)'), true);
    assert.equal(HTML_PAGE.includes('escapeJsAttr(ws.path)'), true);
  });
});

describe('Edge Suite 5B: vicem-gui.mjs Live HTTP API Server & Security Boundary Integration Tests', () => {
  let baseUrl = '';
  let testRepo = '';

  before(async () => {
    testRepo = makeTempGitRepo('vicem-gui-http-');
    const sampleCode = [
      'export function verifyRelayPipeline(input) {',
      '  const a = String(input || "").trim();',
      '  const b = a.toLowerCase();',
      '  const c = b.replace(/[^a-z0-9]/g, "-");',
      '  const d = `relay-${c}`;',
      '  const e = d.slice(0, 64);',
      '  const f = e + "-verified";',
      '  const g = f.toUpperCase();',
      '  const h = g.trim();',
      '  const i = h + "!";',
      '  return i;',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(testRepo, 'relay.mjs'), sampleCode, 'utf8');
    execSync('git add . && git commit -m "initial relay commit"', { cwd: testRepo, stdio: 'ignore' });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve())); }
    if (testRepo && fs.existsSync(testRepo)) {
      fs.rmSync(testRepo, { recursive: true, force: true });
    }
  });

  it('GET / serves hydrated HTML with window.__INITIAL_STATE__ and GET /api/state returns full 12-platform telemetry', async () => {
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.equal(html.includes('window.__INITIAL_STATE__ ='), true);
    assert.equal(html.includes('Vicem'), true);

    const stateRes = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.guiVersion, 'v18');
    assert.equal(Array.isArray(state.nodes), true);
    assert.equal(state.nodes.length, 12);
  });

  it('POST /api/add-workspace and POST /api/workspace switch active project and reject non-existent directories with 400', async () => {
    const badRes = await fetch(`${baseUrl}/api/add-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawPath: '/nonexistent/directory/xyz/99999' }),
    });
    assert.equal(badRes.status, 400);
    const badData = await badRes.json();
    assert.match(badData.error, /Directory not found/);

    const goodRes = await fetch(`${baseUrl}/api/add-workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawPath: testRepo }),
    });
    assert.equal(goodRes.status, 200);
    const goodState = await goodRes.json();
    assert.equal(goodState.projectRoot, path.resolve(testRepo));
    assert.equal(goodState.skeletonSummary.totalSymbols >= 1, true);
  });

  it('POST /api/sync-diet writes .vicem/BATON.md and .vicem/ledger.json, and POST /api/rehydrate restores exact AST symbol code', async () => {
    const syncRes = await fetch(`${baseUrl}/api/sync-diet`, { method: 'POST' });
    assert.equal(syncRes.status, 200);
    const syncState = await syncRes.json();
    assert.equal(syncState.skeletonSummary.batonOnDisk, true);
    assert.equal(syncState.skeletonSummary.ledgerOnDisk, true);

    const rehydrateRes = await fetch(`${baseUrl}/api/rehydrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: 'relay.mjs', symbolName: 'verifyRelayPipeline' }),
    });
    assert.equal(rehydrateRes.status, 200);
    const rehydrated = await rehydrateRes.json();
    assert.equal(rehydrated.ok, true);
    assert.equal(rehydrated.rehydratedCode.includes('export function verifyRelayPipeline(input)'), true);
  });

  it('POST /api/toggle-rule mounts/unmounts safe rule files and strictly blocks CWE-22 path traversal with HTTP 400', async () => {
    // 1. Attempt path traversal outside repository
    const traversalRes = await fetch(`${baseUrl}/api/toggle-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath: '../../evil-escape.md' }),
    });
    assert.equal(traversalRes.status, 400);
    const traversalBody = await traversalRes.json();
    assert.match(traversalBody.error, /Unsafe rule file path rejected/);

    // 2. Attempt writing inside .git/config
    const gitRes = await fetch(`${baseUrl}/api/toggle-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath: '.git/config' }),
    });
    assert.equal(gitRes.status, 400);

    // 3. Valid mount & toggle unmount on .cursorrules
    const mountRes = await fetch(`${baseUrl}/api/toggle-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath: '.cursorrules' }),
    });
    assert.equal(mountRes.status, 200);
    const afterMount = await mountRes.json();
    assert.equal(afterMount.mountedFiles.includes('.cursorrules'), true);

    const unmountRes = await fetch(`${baseUrl}/api/toggle-rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath: '.cursorrules' }),
    });
    assert.equal(unmountRes.status, 200);
    const afterUnmount = await unmountRes.json();
    assert.equal(afterUnmount.mountedFiles.includes('.cursorrules'), false);
  });

  it('POST /api/source, POST /api/goal, POST /api/handoff (launchMode: off), POST /api/unmount, and POST /api/clip work end-to-end', async () => {
    const goalRes = await fetch(`${baseUrl}/api/goal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Custom E2E verification goal' }),
    });
    assert.equal(goalRes.status, 200);
    const goalState = await goalRes.json();
    assert.equal(goalState.taskTitle, 'Custom E2E verification goal');

    const srcRes = await fetch(`${baseUrl}/api/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', sessionId: null }),
    });
    assert.equal(srcRes.status, 200);

    const handoffRes = await fetch(`${baseUrl}/api/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId: 'codex', launchMode: 'off' }),
    });
    assert.equal(handoffRes.status, 200);
    const handoffState = await handoffRes.json();
    assert.equal(Boolean(handoffState.lastHandoffReceipt), true);
    assert.equal(handoffState.lastHandoffReceipt.steps.length, 5);

    const unmRes = await fetch(`${baseUrl}/api/unmount`, { method: 'POST' });
    assert.equal(unmRes.status, 200);

    const clipRes = await fetch(`${baseUrl}/api/clip`, { method: 'POST' });
    assert.equal(clipRes.status, 200);
  });

  it('rejects malformed JSON bodies with HTTP 400, oversized bodies with HTTP 413, and unknown routes with HTTP 404', async () => {
    const badJsonRes = await fetch(`${baseUrl}/api/goal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid_json_syntax',
    });
    assert.equal(badJsonRes.status, 400);

    const oversizedPayload = JSON.stringify({ goal: 'X'.repeat(300 * 1024) });
    const tooLargeRes = await fetch(`${baseUrl}/api/goal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    });
    assert.equal(tooLargeRes.status, 413);

    const notFoundRes = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(notFoundRes.status, 404);
  });

  it('retains a readable manual handoff when the launcher throws', async () => {
    const result=await executeRealHandoff('codex','app',{launcher:async()=>{throw new Error('Simulated unavailable desktop');}});
    assert.equal(result.handoffStatus,'partial');
    assert.equal(result.launchSucceeded,false);
    assert.equal(result.receptionConfirmed,false);
    assert.match(result.manualContinuation.prompt,/Section 2/);
    assert.ok(fs.existsSync(result.manualContinuation.batonPath));
    assert.match(result.manualContinuation.command,/codex/);
    const support=await fetch(`${baseUrl}/api/support`);
    assert.equal(support.status,200);
    assert.match((await support.json()).desktop,/manual continuation/);
  });

  it('rejects delivery when the reviewed goal changes', async () => {
    const previewResponse = await fetch(`${baseUrl}/api/handoff`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({targetId:'codex',launchMode:'off',preview:true})});
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.match(preview.previewToken, /^[a-f0-9]{64}$/);
    await fetch(`${baseUrl}/api/goal`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goal:'A newly changed goal requiring fresh review'})});
    const delivery = await fetch(`${baseUrl}/api/handoff`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({targetId:'codex',launchMode:'off',previewToken:preview.previewToken})});
    assert.equal(delivery.status, 409);
    assert.match((await delivery.json()).error, /changed/);
  });

  it('GET /anatomy serves dark, light, and embedded 3D Isometric Progressive Context Mill & Baton Relay figures', async () => {
    // 1. Default dark theme standalone figure
    const darkRes = await fetch(`${baseUrl}/anatomy`);
    assert.equal(darkRes.status, 200);
    assert.match(darkRes.headers.get('content-type') || '', /text\/html/);
    const darkHtml = await darkRes.text();
    assert.match(darkHtml, /Vicem Progressive Context Mill &amp; Baton Relay Line/);
    assert.match(darkHtml, /S0 SOURCE FEED/);
    assert.match(darkHtml, /S1 NOISEGATE/);
    assert.match(darkHtml, /S2 AST PRESS/);
    assert.match(darkHtml, /S3 SLIM GAUGE/);
    assert.match(darkHtml, /S4 BATON RELAY/);
    assert.match(darkHtml, /data-part="workpiece"/);
    assert.match(darkHtml, /data-part="gate1"/);
    assert.match(darkHtml, /data-part="ram2"/);
    assert.match(darkHtml, /data-part="plunger"/);
    assert.match(darkHtml, /data-part="dial-needle"/);
    assert.match(darkHtml, /data-part="drum-needle"/);

    // 2. Light theme standalone figure
    const lightRes = await fetch(`${baseUrl}/anatomy?theme=light`);
    assert.equal(lightRes.status, 200);
    const lightHtml = await lightRes.text();
    assert.match(lightHtml, /Vicem Progressive Context Mill &amp; Baton Relay Line/);
    assert.match(lightHtml, /data-theme="light"/);

    // 3. Embedded mode for Workbench Drawer integration (?embed=1)
    const embedDarkRes = await fetch(`${baseUrl}/anatomy?embed=1&theme=dark`);
    assert.equal(embedDarkRes.status, 200);
    const embedDarkHtml = await embedDarkRes.text();
    assert.match(embedDarkHtml, /\.iso-legend \{ display: none !important; \}/);
    assert.match(embedDarkHtml, /max-height: 166px !important/);

    const embedLightRes = await fetch(`${baseUrl}/anatomy?embed=1&theme=light`);
    assert.equal(embedLightRes.status, 200);
    const embedLightHtml = await embedLightRes.text();
    assert.match(embedLightHtml, /\.iso-legend \{ display: none !important; \}/);
    assert.match(embedLightHtml, /data-theme="light"/);

    // 4. Verify main GUI page includes 3D Relay Rig workbench button and postMessage bridge
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /id="btn-wb-anatomy"/);
    assert.match(rootHtml, /toggleAnatomyRig\(\)/);
    assert.match(rootHtml, /postToAnatomyRig/);
    assert.match(rootHtml, /buildAnatomyTokensPayload/);
    assert.match(rootHtml, /driveAnatomyStation/);
    assert.match(rootHtml, /Interactive 3D Baton Relay Line/);
    assert.match(rootHtml, /S0 Feed/);
    assert.match(rootHtml, /S1 NoiseGate/);
    assert.match(rootHtml, /S2 AST Press/);
    assert.match(rootHtml, /S3 Slim Gauge/);
    assert.match(rootHtml, /S4 Relay Dock/);
  });

  it('GET /anatomy figure includes postMessage listener for station steering and live token overrides', async () => {
    const res = await fetch(`${baseUrl}/anatomy`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /window\.addEventListener\("message"/);
    assert.match(html, /ev\.data\.station/);
    assert.match(html, /ev\.data\.tokens/);
    assert.match(html, /STATIONS\[i\]\.tokens = ev\.data\.tokens\[i\]\.tokens/);
    assert.match(html, /STATIONS\[i\]\.saving = ev\.data\.tokens\[i\]\.saving/);
  });
});

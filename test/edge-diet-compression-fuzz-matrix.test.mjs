/**
 * @file test/edge-diet-compression-fuzz-matrix.test.mjs
 * @description Comprehensive edge-case, boundary, and fuzz matrix for the 4-Stage Context Diet Suite
 * (NoiseGate, LogSlimmer, DataSampler, DietLedger, DietEngine), TokenEstimator & Unicode Display Width
 * alignment, ClipboardAdapter (OSC 52 512 KiB chunking + tmux DCS passthrough), UrlPrefillAdapter
 * (2,000-char safe threshold), StudioHydrationAdapter & safeJsonForHtmlScript (Local XSS prevention),
 * GitHookInstaller, and DoctorDiagnostics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  NoiseGate,
  LogSlimmer,
  DataSampler,
  DietLedger,
  DietEngine,
  TokenEstimator,
  ClipboardAdapter,
  UrlPrefillAdapter,
  StudioHydrationAdapter,
  safeJsonForHtmlScript,
  stripAnsi,
  isFullWidthCodePoint,
  getDisplayWidth,
  padDisplayColumn,
  DoctorDiagnostics,
  GitHookInstaller,
  isCredentialFile,
  BatonIaBuilder,
  RuleMountAdapter,
  UxFormatter,
} from '../vicem.mjs';

function makeTempDir(prefix = 'vicem-diet-fuzz-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// 1. NOISE GATE: LOCKFILES, IGNORED DIRS, IGNORED EXTS, .GITIGNORE & BINARY/MINIFIED
// ============================================================================

const NOISE_GATE_IGNORED_MATRIX = [
  // Lockfiles
  'package-lock.json',
  'frontend/package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'pubspec.lock',
  'Podfile.lock',
  // Ignored directories
  'node_modules/react/index.js',
  'packages/web/node_modules/lodash/index.js',
  'dist/bundle.js',
  'build/output.js',
  '.next/server/pages/index.js',
  '.nuxt/App.js',
  'out/main.js',
  'coverage/lcov-report/index.html',
  '.git/config',
  '.vicem/BATON.md',
  '__pycache__/mod.cpython-311.pyc',
  '.pytest_cache/v/cache/lastfailed',
  '.venv/lib/site.py',
  'venv/bin/activate',
  'target/debug/app',
  'vendor/autoload.php',
  '.turbo/turbo-build.log',
  '.cache/webpack/0.pack',
  // Ignored extensions & bundles
  'public/app.min.js',
  'styles/main.min.css',
  'dist/vendor.bundle.js',
  'dist/app.js.map',
  'assets/logo.png',
  'assets/photo.jpg',
  'assets/banner.jpeg',
  'assets/anim.gif',
  'assets/hero.webp',
  'assets/favicon.ico',
  'docs/manual.pdf',
  'releases/archive.zip',
  'releases/pkg.tar',
  'releases/pkg.gz',
  'releases/pkg.tgz',
  'releases/pkg.7z',
  'fonts/inter.woff',
  'fonts/inter.woff2',
  'fonts/mono.ttf',
  'fonts/mono.eot',
  'fonts/mono.otf',
  'media/audio.mp3',
  'media/demo.mp4',
  'media/clip.mov',
  'media/clip.avi',
  'wasm/crypto.wasm',
  'native/addon.so',
  'native/addon.dylib',
  'native/addon.dll',
  'bin/tool.exe',
  'bin/firmware.bin',
  'data/local.sqlite',
  'data/local.sqlite3',
  'data/state.db',
  'data/state.db-wal',
  'data/state.db-shm',
  'data/state.vscdb',
  'app.asar',
  // Credential files
  '.env',
  '.env.production',
  'config/secrets.yaml',
  'certs/server.pem',
  'ssh/id_ed25519',
];

const NOISE_GATE_ALLOWED_MATRIX = [
  'src/index.ts',
  'src/components/Button.tsx',
  'lib/parser.mjs',
  'app/models/user.py',
  'cmd/server/main.go',
  'src/lib.rs',
  'src/Main.java',
  'include/engine.h',
  'src/engine.cpp',
  'README.md',
  'package.json',
  'tsconfig.json',
  '.env.example',
  '.env.template',
];

test('NoiseGate — Lockfiles, Build Artifacts, Binary/Minified Detection & .gitignore Globbing', async (t) => {
  for (const ignoredPath of NOISE_GATE_IGNORED_MATRIX) {
    await t.test(`1.1 NoiseGate.isIgnored('${ignoredPath}') === true`, () => {
      assert.equal(NoiseGate.isIgnored(ignoredPath), true);
    });
  }

  for (const allowedPath of NOISE_GATE_ALLOWED_MATRIX) {
    await t.test(`1.2 NoiseGate.isIgnored('${allowedPath}') === false`, () => {
      assert.equal(NoiseGate.isIgnored(allowedPath), false);
    });
  }

  await t.test('1.3 NoiseGate custom .gitignore glob patterns (*.log, temp/*, coverage-custom/)', () => {
    const tmp = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(tmp, '.gitignore'),
        [
          '# Comment line',
          '',
          '*.customlog',
          'generated/**',
          '/local-artifacts/',
          '!important.customlog',
        ].join('\n'),
        'utf8'
      );

      const gate = new NoiseGate(tmp);
      assert.equal(gate.isIgnored('debug.customlog'), true);
      assert.equal(gate.isIgnored('sub/error.customlog'), true);
      assert.equal(gate.isIgnored('generated/schema/types.ts'), true);
      assert.equal(gate.isIgnored('local-artifacts/dump.json'), true);
      assert.equal(gate.isIgnored('src/real-code.ts'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('1.4 NoiseGate.isMinifiedOrBinaryContent detects NUL bytes and >500 avg line length', () => {
    assert.equal(NoiseGate.isMinifiedOrBinaryContent(''), false);
    assert.equal(NoiseGate.isMinifiedOrBinaryContent(null), false);
    assert.equal(NoiseGate.isMinifiedOrBinaryContent('export const x = 1;\nexport const y = 2;\n'), false);
    // Binary NUL byte
    assert.equal(NoiseGate.isMinifiedOrBinaryContent('ELF\x00\x01\x02binary'), true);
    // Minified single-line JS > 2000 chars
    const minifiedJs = 'var a=1;' + 'function f(){return 42;}'.repeat(120);
    assert.equal(NoiseGate.isMinifiedOrBinaryContent(minifiedJs), true);
  });
});

// ============================================================================
// 2. LOG SLIMMER: ANSI STRIPPING, STACK FRAME COLLAPSING, DEDUP & BASE64 OMISSION
// ============================================================================

test('LogSlimmer — Passing Line Stripping, Internal Frame Collapsing, Deduplication & Truncation', async (t) => {
  await t.test('2.1 Strips passing tests, progress bars, ANSI escapes, and base64 blobs while keeping root cause', () => {
    const tmp = makeTempDir();
    try {
      const longBase64 = 'A'.repeat(120);
      const rawLog = [
        '\x1b[32mPASS\x1b[0m test/unit/a.test.js',
        '✓ should add numbers (2ms)',
        '✔ should multiply numbers (1ms)',
        'ok 1 - tap test pass',
        'Downloading https://registry.npmjs.org/pkg.tgz',
        'Installing dependencies...',
        '[12/40] Compiling serde v1.0.197',
        'Progress 10%\rProgress 50%\rProgress 100%',
        'FAIL test/unit/auth.test.js',
        'AssertionError: expected 401 to equal 200',
        `Inline image: data:image/png;base64,${longBase64}`,
        '    at verifyToken (src/auth.ts:44:11)',
        '    at Object.<anonymous> (node_modules/jest-runner/build/index.js:120:5)',
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
        '    at runMicrotasks (<anonymous>)',
        'Retry warning: connection refused',
        'Retry warning: connection refused',
        'Retry warning: connection refused',
        'Retry warning: connection refused',
      ].join('\n');

      const slimmed = LogSlimmer.slim(rawLog, { projectRoot: tmp });

      // Raw log backed up to .vicem/raw/last_build.log
      assert.ok(fs.existsSync(path.join(tmp, '.vicem', 'raw', 'last_build.log')));

      // Passing lines omitted summary
      assert.match(slimmed, /\[LogSlimmer: 7 passing\/progress lines omitted\]/);
      // Root cause preserved
      assert.match(slimmed, /FAIL test\/unit\/auth\.test\.js/);
      assert.match(slimmed, /AssertionError: expected 401 to equal 200/);
      assert.match(slimmed, /at verifyToken \(src\/auth\.ts:44:11\)/);
      // Base64 omitted
      assert.match(slimmed, /data:\.\.\.;base64,\[OMITTED\]/);
      assert.ok(!slimmed.includes(longBase64));
      // Internal frames collapsed
      assert.match(slimmed, /\[3 internal\/library stack frames omitted\]/);
      assert.ok(!slimmed.includes('jest-runner'));
      // Consecutive identical lines deduplicated
      assert.match(slimmed, /\[previous line repeated 3 more times\]/);
      // Carriage return progress overwritten cleanly
      assert.ok(!slimmed.includes('Progress 10%'));
      assert.ok(slimmed.includes('Progress 100%'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('2.2 Enforces maxChars budget with head (65%) + tail (30%) preservation', () => {
    const lines = [];
    for (let i = 1; i <= 200; i++) {
      lines.push(`Error line ${i}: unique failure detail ${i * 17}`);
    }
    const bigLog = lines.join('\n');
    const slimmed = LogSlimmer.slim(bigLog, { maxChars: 600 });
    assert.match(slimmed, /Error line 1:/);
    assert.match(slimmed, /\[LogSlimmer truncated \d+ chars\]/);
    assert.match(slimmed, /Error line 200:/);
  });
});

// ============================================================================
// 3. DATA SAMPLER: JSON, CSV, AND SQL DUMP COMPRESSION MATRIX
// ============================================================================

test('DataSampler — Auto-Detection & Schema-Preserving Sampling for JSON, CSV, and SQL', async (t) => {
  await t.test('3.1 JSON sampling truncates long arrays, deep nesting (>6), >40 object keys, and long strings', () => {
    const bigObj = {};
    for (let i = 0; i < 50; i++) {
      bigObj[`key_${i}`] = i;
    }
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: 'too deep' } } } } } } } };
    const payload = JSON.stringify({
      users: [
        { id: 1, bio: 'x'.repeat(200) },
        { id: 2, bio: 'short' },
        { id: 3, bio: 'omitted 1' },
        { id: 4, bio: 'omitted 2' },
        { id: 5, bio: 'omitted 3' },
      ],
      wide: bigObj,
      deep,
    });

    const sampled = DataSampler.sample(payload);
    assert.match(sampled, /\/\* \.\.\. 3 items truncated \*\//);
    assert.match(sampled, /\.\.\.\[truncated\]/);
    assert.match(sampled, /"__more_keys__": "10 keys omitted"/);
    assert.match(sampled, /\[MaxDepthReached\]/);

    // Invalid partial JSON gracefully falls back to slice
    const badJson = '{"unclosed": [1, 2, 3';
    const sampledBad = DataSampler.sample(badJson, 'json');
    assert.match(sampledBad, /truncated invalid\/partial JSON/);
  });

  await t.test('3.2 CSV sampling preserves header + 3 rows and reports total row count', () => {
    const csvLines = ['id,name,email,role'];
    for (let i = 1; i <= 25; i++) {
      csvLines.push(`${i},User${i},user${i}@example.com,member`);
    }
    const sampled = DataSampler.sample(csvLines.join('\n'));
    assert.match(sampled, /^id,name,email,role/m);
    assert.match(sampled, /1,User1/);
    assert.match(sampled, /3,User3/);
    assert.ok(!sampled.includes('4,User4'));
    assert.match(sampled, /# \.\.\. 22 rows truncated \(Total rows: 25\)/);
  });

  await t.test('3.3 SQL dump sampling keeps CREATE/ALTER/DROP DDL and omits bulk INSERT/COPY statements', () => {
    const sql = [
      '-- Database schema dump',
      'CREATE TABLE accounts (id SERIAL PRIMARY KEY, email TEXT NOT NULL);',
      'INSERT INTO accounts (email) VALUES (\'a@b.com\');',
      'INSERT INTO accounts (email) VALUES (\'c@d.com\');',
      'COPY accounts FROM stdin;',
      'ALTER TABLE accounts ADD COLUMN created_at TIMESTAMP;',
    ].join('\n');

    const sampled = DataSampler.sample(sql);
    assert.match(sampled, /CREATE TABLE accounts/);
    assert.match(sampled, /ALTER TABLE accounts/);
    assert.ok(!sampled.includes("VALUES ('a@b.com')"));
    assert.match(sampled, /\[3 INSERT\/COPY data statements omitted by DataSampler\]/);
  });
});

// ============================================================================
// 4. DIET LEDGER, DIET ENGINE, TOKEN ESTIMATOR & UNICODE DISPLAY WIDTH MATRIX
// ============================================================================

test('DietLedger, DietEngine, TokenEstimator & Unicode Display Width Matrix', async (t) => {
  await t.test('4.1 DietLedger redacts secrets on addEntry, deduplicates entries, and supports partial symbol lookup', () => {
    const tmp = makeTempDir();
    try {
      const ledger = new DietLedger('baton-ledger-test');
      const secretKey = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
      ledger.addEntry({
        filePath: 'src\\auth\\github.ts',
        symbolName: 'verifyGithubToken',
        startLine: 10,
        endLine: 30,
        content: `export function verifyGithubToken() {\n  const token = "${secretKey}";\n  return token;\n}`,
      });
      // Overwrite same filePath + symbolName + startLine
      ledger.addEntry({
        filePath: 'src\\auth\\github.ts',
        symbolName: 'verifyGithubToken',
        startLine: 10,
        endLine: 30,
        content: `export function verifyGithubToken() {\n  const token = "${secretKey}";\n  return Boolean(token);\n}`,
      });

      assert.equal(ledger.entries.length, 1);
      assert.ok(ledger.redactedCount >= 2);
      assert.ok(!ledger.entries[0].content.includes(secretKey));

      ledger.save(tmp);
      const loaded = DietLedger.load(tmp);
      assert.equal(loaded.batonId, 'baton-ledger-test');

      // Exact lookup with normalized forward slashes
      assert.match(loaded.getEntry('src/auth/github.ts', 'verifyGithubToken'), /Boolean\(token\)/);
      // Suffix path match + case-insensitive partial symbol match
      assert.match(loaded.getEntry('github.ts', 'githubtoken'), /Boolean\(token\)/);
      // Whole-file lookup (symbolName = null)
      assert.match(loaded.getEntry('src/auth/github.ts', null), /Boolean\(token\)/);
      // Non-existent lookup returns null
      assert.equal(loaded.getEntry('nonexistent.ts', 'foo'), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.2 DietEngine orchestrates dietCode, dietLog, and dietData seamlessly', () => {
    const tmp = makeTempDir();
    try {
      const engine = new DietEngine(tmp);
      // Ignored file returns omitted: true
      const ignoredRes = engine.dietCode('node_modules/pkg/index.js', 'function f() {}');
      assert.equal(ignoredRes.omitted, true);

      const codeLines = Array.from({ length: 20 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      const codeRes = engine.dietCode('src/calc.ts', `export function calc() {\n${codeLines}\n  return 0;\n}`, {
        minLines: 8,
      });
      assert.ok(!codeRes.omitted);
      assert.match(codeRes.skeleton, /\/\* \.\.\. \*\//);
      assert.equal(engine.ledger.entries.length, 1);

      const logRes = engine.dietLog('PASS a.test.js\nFAIL b.test.js\nError: boom');
      assert.match(logRes, /FAIL b\.test\.js/);

      const dataRes = engine.dietData('[{"a":1},{"a":2},{"a":3},{"a":4}]', 'json');
      assert.match(dataRes, /items truncated/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await t.test('4.3 TokenEstimator and Unicode CJK / Emoji display width & column padding', () => {
    assert.equal(TokenEstimator.estimate(''), 0);
    assert.equal(TokenEstimator.estimate(null), 0);
    const asciiTokens = TokenEstimator.estimate('const x = 12345;');
    const cjkTokens = TokenEstimator.estimate('한글 테스트 문자열입니다');
    assert.ok(asciiTokens > 0);
    assert.ok(cjkTokens > 0);

    assert.equal(TokenEstimator.formatCount(500), '500');
    assert.equal(TokenEstimator.formatCount(1500), '1.5k');
    assert.equal(TokenEstimator.formatCount(42000), '42.0k');

    assert.equal(stripAnsi('\x1b[32;1mHello\x1b[0m'), 'Hello');
    assert.equal(isFullWidthCodePoint('한'.codePointAt(0)), true);
    assert.equal(isFullWidthCodePoint('A'.codePointAt(0)), false);
    assert.equal(getDisplayWidth('ABC'), 3);
    assert.equal(getDisplayWidth('한글'), 4);
    assert.equal(padDisplayColumn('한글', 6), '한글  ');
  });
});

// ============================================================================
// 5. CLIPBOARD OSC 52, URL PREFILL, STUDIO HYDRATION XSS & GIT HOOKS MATRIX
// ============================================================================

test('ClipboardAdapter OSC 52, UrlPrefillAdapter, StudioHydrationAdapter & GitHookInstaller Matrix', async (t) => {
  await t.test('5.1 ClipboardAdapter.encodeOsc52Chunks chunks large payloads <= 512 KiB and wraps tmux DCS', () => {
    // Empty string
    const emptyPlain = ClipboardAdapter.encodeOsc52Chunks('', {});
    assert.equal(emptyPlain[0], '\x1b]52;c;\x07');

    const emptyTmux = ClipboardAdapter.encodeOsc52Chunks('', { TMUX: '/tmp/tmux-1000/default,123,0' });
    assert.equal(emptyTmux[0], '\x1bPtmux;\x1b\x1b]52;c;\x07\x1b\\');

    // Multi-chunk payload (> 384 KiB raw -> 2 base64 chunks)
    const bigPayload = 'A'.repeat(420 * 1024);
    const outStream = new PassThrough();
    const res = ClipboardAdapter.writeOsc52(bigPayload, {}, outStream);
    assert.equal(res.chunksCount, 2);
    for (const c of res.chunks) {
      assert.ok(c.length <= ClipboardAdapter.MAX_OSC52_CHUNK_BYTES + 32);
    }
  });

  await t.test('5.2 UrlPrefillAdapter uses URL prefill <= 2000 chars and falls back to clipboard > 2000 chars', () => {
    const shortMd = '# BATON: Short context';
    const rChat = UrlPrefillAdapter.deliverWeb(shortMd, 'chatgpt', { dryRun: true });
    assert.equal(rChat.mode, 'url_prefill');
    assert.match(rChat.url, /^https:\/\/chatgpt\.com\/\?q=/);

    const rClaude = UrlPrefillAdapter.deliverWeb(shortMd, 'claude', { dryRun: true });
    assert.match(rClaude.url, /^https:\/\/claude\.ai\/new\?q=/);

    const rAiStudio = UrlPrefillAdapter.deliverWeb(shortMd, 'aistudio', { dryRun: true });
    assert.match(rAiStudio.url, /^https:\/\/aistudio\.google\.com\/prompts\/new_chat\?prompt=/);

    const longMd = '# BATON: ' + 'X'.repeat(2500);
    const rFallback = UrlPrefillAdapter.deliverWeb(longMd, 'chatgpt', { dryRun: true });
    assert.equal(rFallback.mode, 'clipboard_fallback');
    assert.equal(rFallback.url, 'https://chatgpt.com/');
  });

  await t.test('5.3 safeJsonForHtmlScript and StudioHydrationAdapter neutralize </script>, <!--, U+2028, U+2029', () => {
    const malicious = {
      xss: '</script><script>alert("pwned")</script><!-- comment -->',
      lineSeps: 'line1\u2028line2\u2029line3 & more',
    };
    const serialized = safeJsonForHtmlScript(malicious);
    assert.ok(!serialized.includes('</script>'));
    assert.ok(!serialized.includes('<script>'));
    assert.ok(!serialized.includes('<!--'));
    assert.ok(!serialized.includes('\u2028'));
    assert.ok(!serialized.includes('\u2029'));
    assert.deepEqual(JSON.parse(serialized), malicious);
  });

  await t.test('5.4 GitHookInstaller installs, preserves user hooks, and uninstalls cleanly', () => {
    const tmp = makeTempDir();
    try {
      const hooksDir = path.join(tmp, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'pre-commit');
      fs.writeFileSync(hookPath, '#!/bin/sh\necho "Existing team lint hook"\n', 'utf8');

      const inst = GitHookInstaller.install(tmp);
      assert.equal(inst.installed, true);
      const content = fs.readFileSync(hookPath, 'utf8');
      assert.match(content, /Existing team lint hook/);
      assert.match(content, /VICEM-GUARD-HOOK-START/);

      // Installing again is idempotent
      GitHookInstaller.install(tmp);
      const content2 = fs.readFileSync(hookPath, 'utf8');
      assert.equal(content, content2);

      // Uninstalling restores existing team hook without deleting file
      const uninst = GitHookInstaller.uninstall(tmp);
      assert.equal(uninst.uninstalled, true);
      const after = fs.readFileSync(hookPath, 'utf8');
      assert.match(after, /Existing team lint hook/);
      assert.ok(!after.includes('VICEM-GUARD-HOOK-START'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 6. UX FORMATTER, TERMINAL RECEIPT & DOCTOR DIAGNOSTICS MATRIX
// ============================================================================

const AGENT_CAPITALIZATION_MATRIX = [
  { raw: 'claude', expected: 'Claude' },
  { raw: 'CLAUDE', expected: 'Claude' },
  { raw: 'codex', expected: 'Codex' },
  { raw: 'gemini', expected: 'Gemini' },
  { raw: 'antigravity', expected: 'Antigravity IDE' },
  { raw: 'vscode', expected: 'VS Code' },
  { raw: 'cursor', expected: 'Cursor' },
  { raw: 'windsurf', expected: 'Windsurf' },
  { raw: 'cline', expected: 'Cline' },
  { raw: 'aider', expected: 'Aider' },
  { raw: 'opencode', expected: 'OpenCode' },
  { raw: 'goose', expected: 'Goose' },
  { raw: 'web', expected: 'Web AI' },
  { raw: 'self', expected: 'Self-Pass' },
  { raw: 'git', expected: 'Git' },
  { raw: 'custom-agent', expected: 'custom-agent' },
];

const RECEIPT_COMBINATIONS_MATRIX = [
  {
    name: '6.2 Standard Claude -> Codex receipt with ANSI colors',
    opts: {
      sourceAgent: 'claude',
      targetAgent: 'codex',
      rawTokens: 48000,
      dietTokens: 2400,
      redactedCount: 3,
      undoCommand: 'vicem back',
    },
    env: {},
    expectMatch: /Claude → Codex.*Diet: 48\.0k → 2\.4k \(-95%\).*🔒 3 secrets.*↩ Undo: vicem back/,
  },
  {
    name: '6.3 NO_COLOR=1 accessibility receipt without ANSI or emoji',
    opts: {
      sourceAgent: 'antigravity',
      targetAgent: 'claude',
      rawTokens: 12000,
      dietTokens: 3000,
      redactedCount: 0,
      undoCommand: 'vicem back',
    },
    env: { NO_COLOR: '1' },
    expectMatch: /^\[OK\] \[Vicem\] Antigravity IDE → Claude \| Diet: 12\.0k → 3\.0k \(-75%\) \| Redacted: 0 secrets \| Undo: vicem back$/,
  },
  {
    name: '6.4 TERM=dumb accessibility receipt with fuzzy correction and extraNote',
    opts: {
      sourceAgent: 'codex',
      targetAgent: 'windsurf',
      rawTokens: 500,
      dietTokens: 500,
      redactedCount: 1,
      fuzzyCorrectedFrom: 'windsrff',
      extraNote: 'Mounted .windsurfrules',
    },
    env: { TERM: 'dumb' },
    expectMatch: /Auto-corrected 'windsrff' → 'windsurf' \| Mounted \.windsurfrules/,
  },
];

test('UxFormatter, Terminal Receipt & DoctorDiagnostics Matrix', async (t) => {
  for (const row of AGENT_CAPITALIZATION_MATRIX) {
    await t.test(`6.1 UxFormatter.capitalizeAgent('${row.raw}') === '${row.expected}'`, () => {
      assert.equal(UxFormatter.capitalizeAgent(row.raw), row.expected);
    });
  }

  for (const rc of RECEIPT_COMBINATIONS_MATRIX) {
    await t.test(rc.name, () => {
      const line = UxFormatter.renderReceipt(rc.opts, rc.env);
      assert.ok(!line.includes('\n'), 'Receipt must be strictly single-line');
      assert.match(line, rc.expectMatch);
    });
  }

  await t.test('6.5 DoctorDiagnostics.runDiagnostics and formatReport across clean and populated environments', () => {
    const tmp = makeTempDir();
    try {
      const fakeHome = path.join(tmp, 'home');
      const binDir = path.join(tmp, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(fakeHome, '.claude', 'projects'), { recursive: true });
      fs.mkdirSync(path.join(fakeHome, '.codex', 'sessions'), { recursive: true });

      for (const cmd of ['claude', 'codex', 'gemini', 'aider', 'goose', 'opencode']) {
        const p = path.join(binDir, cmd);
        fs.writeFileSync(p, '#!/bin/sh\necho ok\n', { mode: 0o755 });
      }

      const diag = DoctorDiagnostics.runDiagnostics(tmp, {
        HOME: fakeHome,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      });
      assert.equal(diag.sqliteSupported, true);
      assert.equal(diag.agentChecks.length, 8);

      const claudeCheck = diag.agentChecks.find((c) => c.id === 'claude');
      assert.equal(claudeCheck.binFound, true);
      assert.equal(claudeCheck.hasStorage, true);

      const reportPlain = DoctorDiagnostics.formatReport(diag, { NO_COLOR: '1' });
      assert.match(reportPlain, /Vicem Doctor Diagnostics/);
      assert.match(reportPlain, /\[OK\] Found/);

      const reportColor = DoctorDiagnostics.formatReport(diag, {});
      assert.match(reportColor, /Vicem Doctor Diagnostics/);
      assert.match(reportColor, /✓ Found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 7. STUDIO HYDRATION ADAPTER & LIVE STUDIO HTML GENERATION MATRIX
// ============================================================================

test('StudioHydrationAdapter — Payload Discovery, Secret Redaction & Live HTML Injection Matrix', async (t) => {
  await t.test('7.1 StudioHydrationAdapter discovers fallback source files, redacts secrets, and injects JSON safely', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      const rawKey = 'sk-ant-api03-' + 'A'.repeat(48);
      fs.writeFileSync(
        path.join(tmp, 'src', 'app.ts'),
        `export const key = "${rawKey}";\nexport const html = "</script><script>alert(1)</script>";\n`,
        'utf8'
      );

      const templatePath = path.join(tmp, 'template.html');
      fs.writeFileSync(
        templatePath,
        '<!DOCTYPE html><html><body><script>console.log("boot");</script></body></html>',
        'utf8'
      );

      const res = StudioHydrationAdapter.generateLiveStudioHtml(tmp, templatePath, {
        targetAgent: 'claude',
      });

      assert.ok(fs.existsSync(res.liveHtmlPath));
      const htmlContent = fs.readFileSync(res.liveHtmlPath, 'utf8');
      assert.ok(htmlContent.includes('id="vicem-hydration-data"'));
      assert.ok(!htmlContent.includes(rawKey), 'Raw Anthropic key must be redacted in Studio hydration HTML');
      assert.ok(!res.escapedJson.includes('</script>'), 'Escaped JSON must neutralize </script> breakout');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 8. END-TO-END 6-HOP MULTI-AGENT RELAY & REHYDRATION CONTINUITY MATRIX
// ============================================================================

const RELAY_HOPS = [
  {
    hop: 1,
    source: 'antigravity',
    target: 'claude',
    role: 'architect',
    goal: 'Hop 1: Design distributed rate limiter schema in src/limiter.ts',
    codeEdit: [
      'export interface RateLimitConfig {',
      '  windowMs: number;',
      '  maxRequests: number;',
      '}',
      '',
      'export function evaluateRateLimit(clientId: string, cfg: RateLimitConfig): boolean {',
      '  const now = Date.now();',
      '  const bucket = Math.floor(now / cfg.windowMs);',
      '  const key = `${clientId}:${bucket}`;',
      '  const len = key.length;',
      '  const limit = cfg.maxRequests;',
      '  const allowed = len < limit * 100;',
      '  const audit = `${key}=${allowed}`;',
      '  const ttl = Math.ceil(cfg.windowMs / 1000);',
      '  const remaining = Math.max(0, limit - 1);',
      '  if (ttl <= 0 || remaining < 0) return false;',
      '  if (!audit) return false;',
      '  return allowed;',
      '}',
    ].join('\n'),
  },
  {
    hop: 2,
    source: 'claude',
    target: 'codex',
    role: 'implementer',
    goal: 'Hop 2: Add sliding window Redis adapter and unit tests',
    codeEdit: [
      'export interface RateLimitConfig {',
      '  windowMs: number;',
      '  maxRequests: number;',
      '  redisPrefix: string;',
      '}',
      '',
      'export function evaluateRateLimit(clientId: string, cfg: RateLimitConfig): boolean {',
      '  const now = Date.now();',
      '  const bucket = Math.floor(now / cfg.windowMs);',
      '  const key = `${cfg.redisPrefix}:${clientId}:${bucket}`;',
      '  const len = key.length;',
      '  const limit = cfg.maxRequests;',
      '  const allowed = len < limit * 100;',
      '  const audit = `${key}=${allowed}`;',
      '  const ttl = Math.ceil(cfg.windowMs / 1000);',
      '  const remaining = Math.max(0, limit - 1);',
      '  if (ttl <= 0 || remaining < 0) return false;',
      '  if (!audit) return false;',
      '  return allowed;',
      '}',
    ].join('\n'),
  },
  {
    hop: 3,
    source: 'codex',
    target: 'cursor',
    role: 'reviewer',
    goal: 'Hop 3: Audit security headers and mounted .cursorrules',
    codeEdit: null,
  },
  {
    hop: 4,
    source: 'cursor',
    target: 'gemini',
    role: 'debugger',
    goal: 'Hop 4: Verify GEMINI.md rule mount and token compression ratio',
    codeEdit: null,
  },
  {
    hop: 5,
    source: 'gemini',
    target: 'vscode',
    role: 'implementer',
    goal: 'Hop 5: Mount .github/copilot-instructions.md for VS Code Copilot',
    codeEdit: null,
  },
  {
    hop: 6,
    source: 'vscode',
    target: 'windsurf',
    role: 'reviewer',
    goal: 'Hop 6: Final pre-release verification in Windsurf (.windsurfrules)',
    codeEdit: null,
  },
];

test('End-to-End 6-Hop Multi-Agent Relay & Rehydration Continuity Matrix', async (t) => {
  const tmp = makeTempDir('vicem-6hop-relay-');
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const srcFile = path.join(tmp, 'src', 'limiter.ts');
    fs.writeFileSync(srcFile, 'export const init = true;\n', 'utf8');

    for (const step of RELAY_HOPS) {
      await t.test(`8.${step.hop} Relay Hop #${step.hop}: ${step.source} -> ${step.target} (${step.role})`, () => {
        if (step.codeEdit) {
          fs.writeFileSync(srcFile, step.codeEdit + '\n', 'utf8');
        }

        const baton = BatonIaBuilder.build({
          projectRoot: tmp,
          sourceAgent: step.source,
          targetAgent: step.target,
          role: step.role,
          persist: true,
          taskContext: {
            goal: step.goal,
            immediateNext: [`Execute hop ${step.hop} in ${step.target}`],
            done: [`Completed previous hop from ${step.source}`],
            userPrompts: [step.goal],
          },
          gitContext: {
            isGitRepo: true,
            branch: 'feat/relay',
            headCommit: `commit-hop-${step.hop}`,
            modifiedFiles: ['src/limiter.ts'],
            untrackedFiles: [],
            diffSummary: '1 file changed',
            diffPatch: '+evaluateRateLimit',
            recentCommits: [`commit-hop-${step.hop} relay update`],
          },
        });

        assert.ok(baton.markdown.includes(step.goal));
        assert.match(baton.markdown, new RegExp(`Role: ${step.role.toUpperCase()}`));

        // Mount rule file for target agent, verify marker, then unmount cleanly
        const mountRes = RuleMountAdapter.mount(tmp, step.target, baton.markdown);
        assert.equal(mountRes.mounted, true);
        assert.ok(fs.existsSync(mountRes.absPath));
        assert.match(fs.readFileSync(mountRes.absPath, 'utf8'), /<!-- VICEM-BATON-START -->/);

        // Verify DietLedger can rehydrate evaluateRateLimit at every hop
        const ledger = DietLedger.load(tmp);
        const rehydrated = ledger.getEntry('src/limiter.ts', 'evaluateRateLimit');
        assert.ok(rehydrated, 'evaluateRateLimit must be rehydratable from .vicem/ledger.json at every hop');
        assert.match(rehydrated, /export function evaluateRateLimit/);

        const unmountRes = RuleMountAdapter.unmount(tmp, step.target);
        assert.equal(unmountRes.unmounted, true);
      });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

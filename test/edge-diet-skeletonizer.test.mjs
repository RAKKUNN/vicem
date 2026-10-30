import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  NoiseGate,
  LogSlimmer,
  DataSampler,
  DietLedger,
  CodeSkeletonizer,
  DietEngine,
} from '../vicem.mjs';

function makeTempDir(prefix = 'vicem-edge-diet-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Edge Suite 2A: NoiseGate & LogSlimmer — Path Filtering, ANSI Stripping & Stack-Frame Compression', () => {
  it('NoiseGate filters build artifacts, lockfiles, minified bundles, binary extensions, and credential files', () => {
    const ignoredPaths = [
      '',
      null,
      undefined,
      'node_modules/react/index.js',
      'apps/web/node_modules/lodash/fp.js',
      '.git/config',
      'dist/bundle.js',
      'build/output.css',
      '.next/server/pages/index.js',
      'target/debug/app',
      '__pycache__/main.cpython-311.pyc',
      '.venv/lib/python3.11/site-packages/pip/__init__.py',
      'vendor/autoload.php',
      '.vicem/BATON.md',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lockb',
      'Cargo.lock',
      'poetry.lock',
      'Gemfile.lock',
      'composer.lock',
      'go.sum',
      'assets/app.min.js',
      'assets/styles.min.css',
      'assets/app.js.map',
      'assets/logo.png',
      'assets/demo.mp4',
      'assets/font.woff2',
      'assets/archive.tar.gz',
      'db/local.sqlite3',
      '.env',
      '.env.production',
      '.ssh/id_ed25519',
    ];
    for (const p of ignoredPaths) {
      assert.equal(NoiseGate.isIgnored(p), true, `Expected path to be ignored by NoiseGate: ${p}`);
    }

    const allowedPaths = [
      'vicem.mjs',
      'vicem-gui.mjs',
      'index.html',
      'src/components/App.tsx',
      'pkg/server/handler.go',
      'crates/core/src/lib.rs',
      'scripts/deploy.py',
      '.env.example',
      'README.md',
    ];
    for (const p of allowedPaths) {
      assert.equal(NoiseGate.isIgnored(p), false, `Expected path to pass NoiseGate: ${p}`);
    }
  });

  it('LogSlimmer deduplicates consecutive lines, collapses node_modules stack frames, and elides middle lines', () => {
    assert.equal(LogSlimmer.slim(''), '');
    assert.equal(LogSlimmer.slim(null), '');

    const noisyLog = [
      '\x1b[32m✓ PASS\x1b[0m test/unit/a.test.js',
      'Downloading https://registry.npmjs.org/foo/-/foo-1.0.0.tgz',
      'Compiling crate v0.1.0',
      'Retrying connection to 127.0.0.1:5432...',
      'Retrying connection to 127.0.0.1:5432...',
      'Retrying connection to 127.0.0.1:5432...',
      'Error: Database timeout',
      '    at Client.connect (/app/src/db.ts:42:11)',
      '    at Object.run (/app/node_modules/pg/lib/client.js:110:5)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at async Runner.exec (/app/node_modules/vitest/dist/runner.js:400:12)',
      '    at async main (/app/src/index.ts:15:3)',
    ].join('\n');

    const slimmed = LogSlimmer.slim(noisyLog);
    assert.equal(slimmed.includes('\x1b['), false, 'ANSI escape codes must be stripped');
    assert.equal(slimmed.includes('✓ PASS'), false, 'Passing test noise must be removed');
    assert.equal(slimmed.includes('Downloading https://'), false, 'Download progress noise must be removed');
    assert.match(slimmed, /previous line repeated 2 more times/);
    assert.equal(slimmed.includes('at Client.connect (/app/src/db.ts:42:11)'), true);
    assert.equal(slimmed.includes('at async main (/app/src/index.ts:15:3)'), true);
    assert.match(slimmed, /\[3 internal\/library stack frames omitted\]/);
  });

  it('LogSlimmer elides logs exceeding maxChars while preserving head and tail context', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `Unique error event #${i + 1}: code E_${i + 1}`);
    const slimmed = LogSlimmer.slim(lines.join('\n'), { maxChars: 600 });
    assert.equal(slimmed.includes('Unique error event #1: code E_1'), true);
    assert.match(slimmed, /\[LogSlimmer truncated \d+ chars\]/);
    assert.equal(slimmed.includes('Unique error event #120: code E_120'), true);
  });
});

describe('Edge Suite 2B: DataSampler — JSON Deep Nesting, SQL Comments + DDL + COPY, and CSV Sampling', () => {
  it('DataSampler.sampleJson truncates arrays > 2 items and objects > 40 keys while handling invalid JSON gracefully', () => {
    assert.match(DataSampler.sampleJson('not valid json {{{', 2), /truncated invalid\/partial JSON/);

    const bigPayload = {
      users: [
        { id: 1, name: 'Alice', bio: 'x'.repeat(250) },
        { id: 2, name: 'Bob', bio: 'y'.repeat(250) },
        { id: 3, name: 'Charlie' },
        { id: 4, name: 'Diana' },
        { id: 5, name: 'Eve' },
      ],
      wideObject: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`key_${i}`, i])),
    };

    const sampledText = DataSampler.sampleJson(JSON.stringify(bigPayload));
    assert.match(sampledText, /\/\* \.\.\. 3 items truncated \*\//);
    assert.match(sampledText, /\.\.\.\[truncated\]/);
    assert.match(sampledText, /5 keys omitted/);
  });

  it('DataSampler.sampleSql preserves DDL statements (even after leading -- or /* */ comments) and omits INSERT/COPY blocks', () => {
    assert.equal(DataSampler.sampleSql(''), '');

    const sqlDump = [
      '-- PostgreSQL database dump',
      '/* Multi-line header comment',
      '   describing the schema */',
      'CREATE TABLE users (',
      '  id SERIAL PRIMARY KEY,',
      '  email TEXT NOT NULL UNIQUE',
      ');',
      '',
      '-- Index creation comment',
      'CREATE INDEX idx_users_email ON users (email);',
      '',
      'ALTER TABLE users ADD COLUMN created_at TIMESTAMPTZ;',
      '',
      "COMMENT ON TABLE users IS 'Registered users';",
      '',
      '-- Data dump section',
      "INSERT INTO users VALUES (1, 'a@example.com');",
      "INSERT INTO users VALUES (2, 'b@example.com');",
      "INSERT INTO users VALUES (3, 'c@example.com');",
      '',
      '/* Another data block */',
      'COPY audit_logs (id, action) FROM stdin;',
    ].join('\n');

    const sampled = DataSampler.sampleSql(sqlDump);
    assert.equal(sampled.includes('CREATE TABLE users'), true);
    assert.equal(sampled.includes('CREATE INDEX idx_users_email'), true);
    assert.equal(sampled.includes('ALTER TABLE users'), true);
    assert.equal(sampled.includes('COMMENT ON TABLE users'), true);
    assert.equal(sampled.includes("INSERT INTO users VALUES (1, 'a@example.com');"), false);
    assert.equal(sampled.includes('COPY audit_logs'), false);
    assert.match(sampled, /\[4 INSERT\/COPY data statements omitted by DataSampler\]/);
  });

  it('DataSampler.sampleCsv and DataSampler.sample dispatch by content and typeHint accurately', () => {
    const csvLines = ['id,name,score', ...Array.from({ length: 25 }, (_, i) => `${i + 1},user_${i + 1},100`)];
    const sampledCsv = DataSampler.sample(csvLines.join('\n'), 'csv');
    const outLines = sampledCsv.split('\n');
    assert.equal(outLines[0], 'id,name,score');
    assert.equal(outLines.length, 5); // header + 3 rows + truncation comment
    assert.match(outLines[4], /# \.\.\. 22 rows truncated/);

    // Short CSV is untouched
    const shortCsv = 'id,name\n1,Alice\n2,Bob';
    assert.equal(DataSampler.sample(shortCsv, 'csv'), shortCsv);

    // Plain text is returned cleanly
    const txt = 'Plain text content';
    assert.equal(DataSampler.sample(txt, 'text'), txt);
  });
});

describe('Edge Suite 2C: DietLedger & CodeSkeletonizer — Complex JS/TS/Py/Go/Rust AST Edge Cases', () => {
  it('DietLedger handles null/empty filePath safely, normalizes Windows backslashes, and persists/loads atomically', () => {
    const tmp = makeTempDir();
    try {
      const ledger = new DietLedger('baton-edge-1');
      ledger.addEntry({
        filePath: 'src\\utils\\math.ts',
        symbolName: 'computeMatrix',
        startLine: 10,
        endLine: 42,
        content: 'export function computeMatrix() {\n  return 42;\n}',
      });
      ledger.addEntry({
        filePath: 'src/utils/math.ts',
        symbolName: 'invertMatrix',
        startLine: 45,
        endLine: 80,
        content: 'export function invertMatrix() {\n  return -1;\n}',
      });

      // Null / empty safety
      assert.equal(ledger.getEntry(null, 'computeMatrix'), null);
      assert.equal(ledger.getEntry(undefined, 'computeMatrix'), null);
      assert.equal(ledger.getEntry('', 'computeMatrix'), null);

      // Lookup by POSIX or Windows path or suffix
      assert.match(ledger.getEntry('src/utils/math.ts', 'computeMatrix'), /return 42/);
      assert.match(ledger.getEntry('src\\utils\\math.ts', 'computeMatrix'), /return 42/);
      assert.match(ledger.getEntry('math.ts', 'invertMatrix'), /return -1/);

      // Whole-file lookup when symbolName is omitted
      const allSymbols = ledger.getEntry('src/utils/math.ts');
      assert.equal(allSymbols.includes('computeMatrix'), true);
      assert.equal(allSymbols.includes('invertMatrix'), true);

      // Save & reload from disk
      const savedPath = ledger.save(tmp);
      assert.equal(fs.existsSync(savedPath), true);
      const loaded = DietLedger.load(tmp);
      assert.equal(loaded.batonId, 'baton-edge-1');
      assert.equal(loaded.entries.length, 2);
      assert.match(loaded.getEntry('src/utils/math.ts', 'computeMatrix'), /return 42/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CodeSkeletonizer handles deeply nested template literals (`outer ${ `inner ${ fn({ a: 1 }) }` }`) and regex literals with braces', () => {
    const trickyTsCode = [
      'export async function renderComplexTemplate(user: { name: string }, count = 5): Promise<string> {',
      '  const regexWithUnmatchedBraces = /\\{\\{\\{[a-z]+/g;',
      '  const divCheck = count / 2 > 1 ? /\\}\\}/ : /\\{/ ;',
      '  const nestedTpl = `Level 1 ${',
      '    `Level 2 ${{ braceInObj: "}}}{{{", tpl: `Level 3 ${user.name}` }.tpl}`',
      '  } done`;',
      '  // Single line comment with {{{ and }}}',
      '  /* Multi-line comment with {{{{',
      '     and }}}} inside */',
      '  return nestedTpl.replace(regexWithUnmatchedBraces, "");',
      '}',
      '',
      'export function afterFunctionMustSurvive(x: number): number {',
      '  const a = x + 1;',
      '  const b = a * 2;',
      '  const c = b - 3;',
      '  const d = c + 4;',
      '  const e = d * 5;',
      '  return e;',
      '}',
    ].join('\n');

    const ledger = new DietLedger('test-tpl');
    const { skeleton, ledgerEntries } = CodeSkeletonizer.skeletonize('src/tpl.ts', trickyTsCode, {
      ledger,
      minLines: 6,
    });

    assert.equal(ledgerEntries.length, 2);
    assert.equal(ledgerEntries[0].symbolName, 'renderComplexTemplate');
    assert.equal(ledgerEntries[1].symbolName, 'afterFunctionMustSurvive');
    assert.equal(skeleton.includes('export async function renderComplexTemplate'), true);
    assert.equal(skeleton.includes('export function afterFunctionMustSurvive'), true);
    // Exact lossless rehydration
    assert.equal(
      ledger.getEntry('src/tpl.ts', 'renderComplexTemplate').includes('Level 3 ${user.name}'),
      true
    );
  });

  it('CodeSkeletonizer handles default parameter strings containing parentheses and generator/Go/Rust methods', () => {
    const jsWithParenInDefault = [
      'export class StreamParser {',
      '  *parseChunks(delimiter = ")))", quote = "(((") {',
      '    let buf = "";',
      '    buf += delimiter;',
      '    buf += quote;',
      '    buf += "line 4";',
      '    buf += "line 5";',
      '    yield buf;',
      '  }',
      '  async *streamAsync(prefix = "{([") {',
      '    let out = prefix;',
      '    out += "step 1";',
      '    out += "step 2";',
      '    out += "step 3";',
      '    out += "step 4";',
      '    yield out;',
      '  }',
      '}',
    ].join('\n');

    const { skeleton, ledgerEntries } = CodeSkeletonizer.skeletonize('src/parser.js', jsWithParenInDefault, {
      minLines: 5,
    });
    const names = ledgerEntries.map((e) => e.symbolName);
    assert.equal(names.includes('parseChunks'), true);
    assert.equal(names.includes('streamAsync'), true);
    assert.equal(skeleton.includes('export class StreamParser {'), true);

    const goCode = [
      'package server',
      '',
      'func (s *HttpServer) HandleRequest(w ResponseWriter, r *Request) error {',
      '  line1 := 1',
      '  line2 := 2',
      '  line3 := 3',
      '  line4 := 4',
      '  line5 := 5',
      '  return nil',
      '}',
    ].join('\n');

    const goRes = CodeSkeletonizer.skeletonize('server.go', goCode, { minLines: 5 });
    assert.equal(goRes.ledgerEntries.length, 1);
    assert.equal(goRes.ledgerEntries[0].symbolName, 'HandleRequest');
  });

  it('CodeSkeletonizer.parsePython handles multi-line signatures with # colons and unindented triple-quoted strings inside functions', () => {
    const pyCode = [
      'class DataPipeline:',
      '    async def transform_records(',
      '        self,',
      '        items: list[dict],  # Note: items must be validated: see spec',
      '        threshold: float = 0.75,',
      '    ) -> list[str]:',
      '        """Docstring for transform_records."""',
      '        sql_query = """',
      'SELECT id, name',
      'FROM users',
      'WHERE active = true',
      '"""',
      '        results = []',
      '        for item in items:',
      '            if item.get("score", 0) >= threshold:',
      '                results.append(item["name"])',
      '        return results',
      '',
      '    def second_method(self, value: int) -> int:',
      '        a = value + 1',
      '        b = a * 2',
      '        c = b + 3',
      '        d = c * 4',
      '        e = d + 5',
      '        return e',
    ].join('\n');

    const ledger = new DietLedger('py-test');
    const { skeleton, ledgerEntries } = CodeSkeletonizer.skeletonize('pipeline.py', pyCode, {
      ledger,
      minLines: 6,
    });

    assert.equal(ledgerEntries.length, 2);
    assert.equal(ledgerEntries[0].symbolName, 'transform_records');
    assert.equal(ledgerEntries[1].symbolName, 'second_method');
    // Ensure the unindented SQL triple-quoted string did NOT prematurely terminate transform_records!
    const rehydrated = ledger.getEntry('pipeline.py', 'transform_records');
    assert.equal(rehydrated.includes('SELECT id, name'), true);
    assert.equal(rehydrated.includes('return results'), true);
    assert.equal(skeleton.includes('def second_method(self, value: int) -> int:'), true);
  });

  it('CodeSkeletonizer preserves CRLF line endings when the input file uses CRLF', () => {
    const crlfCode = [
      'import fs from "node:fs";',
      'export const VERSION = "1.0.0";',
      'export function crlfExample(a, b) {',
      '  const x = a + b;',
      '  const y = x * 2;',
      '  const z = y - 1;',
      '  const w = z + 10;',
      '  const q = w / 2;',
      '  return q;',
      '}',
    ].join('\r\n');

    const { skeleton } = CodeSkeletonizer.skeletonize('win.js', crlfCode, { minLines: 5 });
    assert.equal(skeleton.includes('\r\n'), true);
  });

  it('DietEngine runs all 4 stages end-to-end and records compressed files + ledger entries', () => {
    const engine = new DietEngine();
    assert.equal(engine.dietCode('node_modules/pkg/index.js', 'console.log(1);').omitted, true);
    assert.equal(engine.dietCode('.env.production', 'SECRET=topsecret').omitted, true);

    const sqlOut = engine.dietData(
      [
        'CREATE TABLE items (id INT);',
        'INSERT INTO items VALUES (1);',
        'INSERT INTO items VALUES (2);',
      ].join('\n'),
      'sql'
    );
    assert.equal(sqlOut.includes('CREATE TABLE items'), true);

    const codeRes = engine.dietCode(
      'src/service.ts',
      [
        'export function processOrder(orderId: string) {',
        '  const step1 = orderId.trim();',
        '  const step2 = step1.toUpperCase();',
        '  const step3 = `ORD-${step2}`;',
        '  const step4 = step3.slice(0, 12);',
        '  const step5 = step4 + "-OK";',
        '  const step6 = step5.toLowerCase();',
        '  return step6;',
        '}',
      ].join('\n'),
      { minLines: 5 }
    );
    assert.equal(codeRes.omitted, undefined);
    assert.equal(engine.ledger.entries.length, 1);
    assert.equal(engine.ledger.entries[0].symbolName, 'processOrder');
  });
});

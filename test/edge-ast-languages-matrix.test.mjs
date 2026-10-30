// Synthetic redaction fixtures, generated at runtime; never real service credentials.
const SYNTHETIC_SERVICE_TOKEN_0 = 'sk_live_' + '51Nz9X2L8pQ4mR7vK1wB3cD6fG8hJ0kL2mN4pQ6rS';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CodeSkeletonizer,
  DietLedger,
  DietEngine,
  DataSampler,
  LogSlimmer,
  TokenEstimator,
  NoiseGate,
  ContextFileRanker,
  stripAnsi,
  isFullWidthCodePoint,
  getDisplayWidth,
  padDisplayColumn,
} from '../vicem.mjs';

function makeTmpDir(prefix = 'vicem-ast-matrix-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// SECTION 1: TypeScript & JavaScript AST Skeletonization Deep Matrix
// ============================================================================

test('AST Matrix [TS/JS]: standard function declarations, exports, async, and generator variants', () => {
  const cases = [
    {
      name: 'named export function with complex generic constraints',
      filePath: 'src/transformPayload.ts',
      code: [
        'export function transformPayload<T extends Record<string, unknown>, U = Partial<T>>(',
        '  input: T,',
        '  mapper: (val: T[keyof T], key: keyof T) => U',
        '): Promise<Readonly<U>> {',
        '  const internalState = { ...input };',
        '  const keys = Object.keys(internalState) as Array<keyof T>;',
        '  for (const k of keys) {',
        '    if (internalState[k] === undefined) {',
        '      delete internalState[k];',
        '    }',
        '  }',
        '  return Promise.resolve(mapper(internalState[keys[0]], keys[0]));',
        '}',
      ].join('\n'),
      expectedSymbols: ['transformPayload'],
      mustContain: [
        'export function transformPayload<T extends Record<string, unknown>, U = Partial<T>>',
        '{ /* ... */ }',
      ],
      mustOmit: ['delete internalState[k]'],
    },
    {
      name: 'async generator function with nested try/catch/finally blocks',
      filePath: 'src/streamEvents.js',
      code: [
        'export async function* streamEvents(endpoint, options = { retry: 3, backoffMs: 250 }) {',
        '  let attempt = 0;',
        '  while (attempt < options.retry) {',
        '    try {',
        '      const res = await fetch(endpoint);',
        '      const text = await res.text();',
        '      yield JSON.parse(text);',
        '      break;',
        '    } catch (err) {',
        '      attempt += 1;',
        '      if (attempt >= options.retry) throw err;',
        '    } finally {',
        '      console.debug("streamEvents attempt finished", attempt);',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      expectedSymbols: ['streamEvents'],
      mustContain: ['export async function* streamEvents', '{ /* ... */ }'],
      mustOmit: ['console.debug("streamEvents attempt finished"'],
    },
    {
      name: 'default export async function with destructured parameters and default object literals',
      filePath: 'src/UserDashboardView.tsx',
      code: [
        'export default async function UserDashboardView(',
        '  { userId, roles = ["viewer"], config = { theme: "dark", compact: false } }: DashboardProps',
        ') {',
        '  const profile = await loadProfile(userId);',
        '  const permissions = roles.map((r) => resolveRole(r, config.theme));',
        '  if (!profile.active) {',
        '    return <div className="inactive">Account Inactive</div>;',
        '  }',
        '  const audit = permissions.filter(Boolean);',
        '  const badge = audit.length > 0 ? "verified" : "guest";',
        '  const label = `${userId}:${badge}`;',
        '  return <main data-theme={config.theme} data-label={label}>{permissions.join(",")}</main>;',
        '}',
      ].join('\n'),
      expectedSymbols: ['UserDashboardView'],
      mustContain: ['export default async function UserDashboardView', '{ /* ... */ }'],
      mustOmit: ['const profile = await loadProfile(userId);'],
    },
    {
      name: 'arrow function assigned to exported const with explicit return type',
      filePath: 'src/computeHMACSignature.ts',
      code: [
        'export const computeHMACSignature = (',
        '  secretKey: string,',
        '  payload: Uint8Array',
        '): { hex: string; base64: string } => {',
        '  const norm = secretKey.trim();',
        '  const bytes = Array.from(payload);',
        '  const digest = bytes.reduce((acc, b) => (acc * 31 + b) % 1000000007, norm.length);',
        '  const hex = digest.toString(16).padStart(8, "0");',
        '  const base64 = Buffer.from(hex).toString("base64");',
        '  const verified = hex.length === 8 && base64.length > 0;',
        '  if (!verified) throw new Error("digest failed");',
        '  return { hex, base64 };',
        '};',
      ].join('\n'),
      expectedSymbols: ['computeHMACSignature'],
      mustContain: ['export const computeHMACSignature =', '{ /* ... */ }'],
      mustOmit: ['const digest = bytes.reduce'],
    },
    {
      name: 'TypeScript class with interfaces preserved and methods skeletonized',
      filePath: 'src/SessionOrchestrator.ts',
      code: [
        'export interface SessionMetadata {',
        '  id: string;',
        '  createdAt: number;',
        '  tags: string[];',
        '  nested: {',
        '    owner: string;',
        '    active: boolean;',
        '  };',
        '}',
        '',
        'export class SessionOrchestrator {',
        '  private readonly cache = new Map<string, SessionMetadata>();',
        '',
        '  constructor(private readonly rootDir: string, private readonly maxEntries = 128) {',
        '    if (!rootDir) {',
        '      throw new Error("rootDir is required");',
        '    }',
        '    this.cache.clear();',
        '    const norm = rootDir.trim();',
        '    if (norm.length === 0) {',
        '      throw new Error("empty rootDir");',
        '    }',
        '    this.initializeMetrics();',
        '  }',
        '',
        '  public async hydrateSession(sessionId: string): Promise<SessionMetadata | null> {',
        '    if (this.cache.has(sessionId)) {',
        '      return this.cache.get(sessionId) ?? null;',
        '    }',
        '    const diskData = await this.readFromDisk(sessionId);',
        '    if (!diskData) {',
        '      return null;',
        '    }',
        '    this.cache.set(sessionId, diskData);',
        '    return diskData;',
        '  }',
        '',
        '  protected *iterateKeys(prefix: string): IterableIterator<string> {',
        '    for (const key of this.cache.keys()) {',
        '      if (key.startsWith(prefix)) {',
        '        yield key;',
        '      }',
        '    }',
        '  }',
        '',
        '  private static normalizeKey(rawKey: string): string {',
        '    const trimmed = rawKey.trim().toLowerCase();',
        '    const cleaned = trimmed.replace(/[^a-z0-9_-]/g, "_");',
        '    const bounded = cleaned.slice(0, 64);',
        '    return bounded || "default_key";',
        '  }',
        '}',
      ].join('\n'),
      expectedSymbols: ['constructor', 'hydrateSession', 'iterateKeys', 'normalizeKey'],
      mustContain: [
        'export interface SessionMetadata {',
        'owner: string;',
        'export class SessionOrchestrator {',
        'public async hydrateSession(sessionId: string): Promise<SessionMetadata | null> { /* ... */ }',
      ],
      mustOmit: [
        'throw new Error("rootDir is required")',
        'const diskData = await this.readFromDisk(sessionId)',
        'const cleaned = trimmed.replace',
      ],
    },
  ];

  for (const tc of cases) {
    const res = CodeSkeletonizer.skeletonize(tc.filePath, tc.code, { minLines: 5 });
    assert.deepEqual(
      res.ledgerEntries.map((e) => e.symbolName),
      tc.expectedSymbols,
      `[${tc.name}] Symbol mismatch`
    );
    for (const expected of tc.mustContain) {
      assert.ok(
        res.skeleton.includes(expected),
        `[${tc.name}] Missing expected substring: ${expected}\nGot:\n${res.skeleton}`
      );
    }
    for (const forbidden of tc.mustOmit) {
      assert.ok(
        !res.skeleton.includes(forbidden),
        `[${tc.name}] Found forbidden body substring: ${forbidden}\nGot:\n${res.skeleton}`
      );
    }
  }
});

test('AST Matrix [TS/JS]: unbalanced braces inside strings, template literals, comments, and regex literals', () => {
  const trickyCases = [
    {
      name: 'double-quoted and single-quoted strings containing many unbalanced closing braces',
      filePath: 'src/parseBracedFormat.ts',
      code: [
        'export function parseBracedFormat(rawInput: string) {',
        '  const prefix = "}}}}}}}}}} {{{ ";',
        '  const suffix = \'}}}}} {{{{{ }}}}}\';',
        '  const escaped = "hello \\" }}}} \\" world {{{";',
        '  const combined = prefix + rawInput + suffix + escaped;',
        '  const lines = combined.split("\\n");',
        '  return lines.join("|").trim();',
        '}',
      ].join('\n'),
      fnName: 'parseBracedFormat',
    },
    {
      name: 'deeply nested template literals with object literals inside ${...} expressions',
      filePath: 'src/renderTemplateDiagnostic.ts',
      code: [
        'export function renderTemplateDiagnostic(ctx: any) {',
        '  const msg = `outer start ${',
        '    ctx.items.map((item: any) => {',
        '      const innerObj = { a: 1, b: `nested ${item.ok ? "{ok}" : "{fail}"}` };',
        '      return JSON.stringify(innerObj);',
        '    }).join(", ")',
        '  } outer end }}}} {{{`;',
        '  const footer = `status=${ctx.code ?? "0"}`;',
        '  return `${msg}\\n${footer}`;',
        '}',
      ].join('\n'),
      fnName: 'renderTemplateDiagnostic',
    },
    {
      name: 'single-line and multi-line comments containing unbalanced braces and fake function keywords',
      filePath: 'src/evaluateWithComments.ts',
      code: [
        'export function evaluateWithComments(value: number) {',
        '  // Fake closing braces: } } } } } and fake opening: { { {',
        '  /* Multi-line comment with fake syntax:',
        '     function notARealFunction() { return 1; }',
        '     } } } } } } }',
        '  */',
        '  const stepOne = value + 10; // trailing } } }',
        '  const stepTwo = stepOne * 2; /* inline { { { */',
        '  return stepTwo - 5;',
        '}',
      ].join('\n'),
      fnName: 'evaluateWithComments',
    },
    {
      name: 'regex literals containing character classes and unescaped braces',
      filePath: 'src/matchBracedTokens.js',
      code: [
        'export function matchBracedTokens(input) {',
        '  const re1 = /\\{[a-z0-9_]+\\}/gi;',
        '  const re2 = /[{}()[\\]]+/g;',
        '  const matches = input.match(re1) || [];',
        '  const cleaned = input.replace(re2, "");',
        '  return { count: matches.length, cleaned };',
        '}',
      ].join('\n'),
      fnName: 'matchBracedTokens',
    },
    {
      name: 'control flow keywords (if, for, while, switch, catch) inside function are never misclassified as methods',
      filePath: 'src/processQueueItems.js',
      code: [
        'export function processQueueItems(queue) {',
        '  if (queue.length === 0) {',
        '    return [];',
        '  }',
        '  const out = [];',
        '  for (let i = 0; i < queue.length; i++) {',
        '    while (queue[i].pending) {',
        '      queue[i].pending = false;',
        '    }',
        '    switch (queue[i].kind) {',
        '      case "alpha":',
        '        out.push(queue[i]);',
        '        break;',
        '      default:',
        '        break;',
        '    }',
        '  }',
        '  return out;',
        '}',
      ].join('\n'),
      fnName: 'processQueueItems',
    },
  ];

  for (const tc of trickyCases) {
    const res = CodeSkeletonizer.skeletonize(tc.filePath, tc.code, { minLines: 5 });
    assert.equal(res.ledgerEntries.length, 1, `[${tc.name}] Expected exactly 1 top-level skeleton`);
    assert.equal(res.ledgerEntries[0].symbolName, tc.fnName);
    assert.equal(res.ledgerEntries[0].startLine, 1);
    assert.equal(res.ledgerEntries[0].endLine, tc.code.split('\n').length);
    assert.equal(res.ledgerEntries[0].content, tc.code);
  }
});

// ============================================================================
// SECTION 2: Python AST Skeletonization Deep Matrix
// ============================================================================

test('AST Matrix [Python]: def, async def, multiline type-annotated signatures, docstrings, and classes', () => {
  const pyCode = [
    'import asyncio',
    'from typing import Any, Callable, Dict, List, Optional, Tuple',
    '',
    'GLOBAL_TIMEOUT_SECONDS = 30',
    '',
    'def compute_token_window(',
    '    messages: List[Dict[str, Any]],',
    '    max_budget: int = 128000,',
    '    delimiter: str = "role:user",  # colon inside comment: should not terminate signature!',
    ') -> Tuple[List[Dict[str, Any]], int]:',
    '    """',
    '    Computes the optimal sliding window of messages.',
    '    Contains unindented closing quotes and fake colons:',
    '    def fake_inside_docstring():',
    '        pass',
    '    """',
    '    accumulated = 0',
    '    selected: List[Dict[str, Any]] = []',
    '    for msg in reversed(messages):',
    '        cost = len(str(msg.get("content", ""))) // 4',
    '        if accumulated + cost > max_budget:',
    '            break',
    '        selected.append(msg)',
    '        accumulated += cost',
    '    selected.reverse()',
    '    return selected, accumulated',
    '',
    'class AsyncBatchWorker:',
    '    """High-throughput worker for batch processing."""',
    '',
    '    def __init__(self, concurrency: int = 4, name: str = "worker:default") -> None:',
    '        self.concurrency = max(1, concurrency)',
    '        self.name = name',
    '        self._queue: List[Any] = []',
    '        self._closed = False',
    '        self._processed_total = 0',
    '',
    '    async def drain_queue(',
    '        self,',
    '        handler: Callable[[Any], Any],',
    '        timeout: Optional[float] = None,',
    '    ) -> int:',
    '        processed = 0',
    '        while self._queue and not self._closed:',
    '            item = self._queue.pop(0)',
    '            await handler(item)',
    '            processed += 1',
    '        return processed',
    '',
    '    def close_worker(self) -> bool:',
    '        if self._closed:',
    '            return False',
    '        self._closed = True',
    '        self._queue.clear()',
    '        return True',
  ].join('\n');

  const res = CodeSkeletonizer.skeletonize('worker/batch_worker.py', pyCode, { minLines: 5 });
  const names = res.ledgerEntries.map((s) => s.symbolName);
  assert.deepEqual(names, ['compute_token_window', '__init__', 'drain_queue', 'close_worker']);

  // Verify class header and module constants remain intact
  assert.ok(res.skeleton.includes('GLOBAL_TIMEOUT_SECONDS = 30'));
  assert.ok(res.skeleton.includes('class AsyncBatchWorker:'));
  assert.ok(res.skeleton.includes('    pass'));
  assert.ok(res.skeleton.includes('        pass'));
  assert.ok(!res.skeleton.includes('selected.reverse()'));
  assert.ok(!res.skeleton.includes('self._queue.pop(0)'));
});

test('AST Matrix [Python]: multiline triple-quoted strings at column 0 do not prematurely terminate indentation blocks', () => {
  const pyCode = [
    'def generate_sql_migration(table_name: str) -> str:',
    '    header_sql = """',
    '-- Column 0 unindented SQL template inside a Python function!',
    'CREATE TABLE IF NOT EXISTS example_table (',
    '    id SERIAL PRIMARY KEY,',
    '    payload JSONB NOT NULL',
    ');',
    '"""',
    '    footer_sql = f"ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;"',
    '    combined = header_sql.strip() + "\\n" + footer_sql',
    '    return combined',
    '',
    'def verify_migration_checksum(sql_text: str) -> int:',
    '    total = 0',
    '    for ch in sql_text:',
    '        total = (total * 33 + ord(ch)) % 65535',
    '    return total',
  ].join('\n');

  const res = CodeSkeletonizer.skeletonize('db/migrations.py', pyCode, { minLines: 5 });
  assert.equal(res.ledgerEntries.length, 2);
  assert.equal(res.ledgerEntries[0].symbolName, 'generate_sql_migration');
  assert.equal(res.ledgerEntries[0].startLine, 1);
  assert.equal(res.ledgerEntries[0].endLine, 11);
  assert.equal(res.ledgerEntries[1].symbolName, 'verify_migration_checksum');
  assert.equal(res.ledgerEntries[1].startLine, 13);
  assert.equal(res.ledgerEntries[1].endLine, 17);
});

// ============================================================================
// SECTION 3: Go, Rust, Java, C, C++, C# AST Skeletonization Matrix
// ============================================================================

test('AST Matrix [Go]: package functions, pointer/value receiver methods, structs preserved, bodies skeletonized', () => {
  const goCode = [
    'package transport',
    '',
    'import (',
    '\t"context"',
    '\t"errors"',
    '\t"sync"',
    ')',
    '',
    'type ConnectionPool struct {',
    '\tmu      sync.RWMutex',
    '\tconns   map[string]int',
    '\tmaxIdle int',
    '}',
    '',
    'func NewConnectionPool(maxIdle int) (*ConnectionPool, error) {',
    '\tif maxIdle <= 0 {',
    '\t\treturn nil, errors.New("maxIdle must be positive")',
    '\t}',
    '\tpool := &ConnectionPool{',
    '\t\tconns:   make(map[string]int),',
    '\t\tmaxIdle: maxIdle,',
    '\t}',
    '\treturn pool, nil',
    '}',
    '',
    'func (p *ConnectionPool) Acquire(ctx context.Context, host string) (int, error) {',
    '\tp.mu.Lock()',
    '\tdefer p.mu.Unlock()',
    '\tselect {',
    '\tcase <-ctx.Done():',
    '\t\treturn 0, ctx.Err()',
    '\tdefault:',
    '\t\tp.conns[host]++',
    '\t\treturn p.conns[host], nil',
    '\t}',
    '}',
    '',
    'func (p ConnectionPool) SnapshotCount(host string) int {',
    '\tp.mu.RLock()',
    '\tdefer p.mu.RUnlock()',
    '\tcount, exists := p.conns[host]',
    '\tif !exists {',
    '\t\treturn 0',
    '\t}',
    '\treturn count',
    '}',
  ].join('\n');

  const res = CodeSkeletonizer.skeletonize('transport/pool.go', goCode, { minLines: 5 });
  const names = res.ledgerEntries.map((s) => s.symbolName);
  assert.deepEqual(names, ['NewConnectionPool', 'Acquire', 'SnapshotCount']);
  assert.ok(res.skeleton.includes('type ConnectionPool struct {'));
  assert.ok(res.skeleton.includes('maxIdle int'));
  assert.ok(!res.skeleton.includes('errors.New("maxIdle must be positive")'));
  assert.ok(!res.skeleton.includes('p.conns[host]++'));
});

test('AST Matrix [Rust]: pub fn, pub(crate) async unsafe fn, struct preserved, impl methods skeletonized', () => {
  const rustCode = [
    'use std::collections::HashMap;',
    '',
    'pub struct LedgerStore {',
    '    entries: HashMap<String, Vec<u8>>,',
    '}',
    '',
    'impl LedgerStore {',
    '    pub fn with_capacity(cap: usize) -> Self {',
    '        let mut entries = HashMap::with_capacity(cap);',
    '        entries.shrink_to_fit();',
    '        Self { entries }',
    '    }',
    '',
    '    pub async fn insert_record(&mut self, key: String, payload: Vec<u8>) -> Result<usize, String> {',
    '        if key.is_empty() {',
    '            return Err(String::from("empty key not allowed"));',
    '        }',
    '        let len = payload.len();',
    '        self.entries.insert(key, payload);',
    '        Ok(len)',
    '    }',
    '}',
    '',
    'pub(crate) unsafe fn compute_raw_checksum(ptr: *const u8, len: usize) -> u64 {',
    '    let mut hash: u64 = 0xcbf29ce484222325;',
    '    let mut idx: usize = 0;',
    '    while idx < len {',
    '        let byte = *ptr.add(idx) as u64;',
    '        hash ^= byte;',
    '        hash = hash.wrapping_mul(0x100000001b3);',
    '        idx += 1;',
    '    }',
    '    hash',
    '}',
  ].join('\n');

  const res = CodeSkeletonizer.skeletonize('src/ledger_store.rs', rustCode, { minLines: 5 });
  const names = res.ledgerEntries.map((s) => s.symbolName);
  assert.deepEqual(names, ['with_capacity', 'insert_record', 'compute_raw_checksum']);
  assert.ok(res.skeleton.includes('pub struct LedgerStore {'));
  assert.ok(!res.skeleton.includes('0xcbf29ce484222325'));
});

test('AST Matrix [Java / C++ / C#]: methods with modifiers, generic return types, and constructors', () => {
  const javaCode = [
    'package com.vicem.engine;',
    '',
    'import java.util.List;',
    'import java.util.ArrayList;',
    '',
    'public class TokenBudgetOptimizer {',
    '    private final int hardLimit;',
    '',
    '    public TokenBudgetOptimizer(int hardLimit) {',
    '        if (hardLimit <= 0) {',
    '            throw new IllegalArgumentException("hardLimit must be > 0");',
    '        }',
    '        this.hardLimit = hardLimit;',
    '    }',
    '',
    '    public synchronized List<String> pruneSegments(List<String> segments, int reserve) {',
    '        List<String> result = new ArrayList<>();',
    '        int used = reserve;',
    '        for (String seg : segments) {',
    '            if (used + seg.length() > this.hardLimit) {',
    '                break;',
    '            }',
    '            result.add(seg);',
    '            used += seg.length();',
    '        }',
    '        return result;',
    '    }',
    '}',
  ].join('\n');

  const javaRes = CodeSkeletonizer.skeletonize('src/TokenBudgetOptimizer.java', javaCode, { minLines: 5 });
  assert.deepEqual(
    javaRes.ledgerEntries.map((s) => s.symbolName),
    ['TokenBudgetOptimizer', 'pruneSegments']
  );

  const cppCode = [
    '#include <vector>',
    '#include <string>',
    '',
    'std::vector<int> computePrefixSums(const std::vector<int>& values, int offset) {',
    '    std::vector<int> out;',
    '    out.reserve(values.size());',
    '    int running = offset;',
    '    for (size_t i = 0; i < values.size(); ++i) {',
    '        running += values[i];',
    '        out.push_back(running);',
    '    }',
    '    return out;',
    '}',
  ].join('\n');

  const cppRes = CodeSkeletonizer.skeletonize('src/prefix_sums.cpp', cppCode, { minLines: 5 });
  assert.equal(cppRes.ledgerEntries.length, 1);
  assert.equal(cppRes.ledgerEntries[0].symbolName, 'computePrefixSums');

  const csharpCode = [
    'using System;',
    'using System.Collections.Generic;',
    '',
    'namespace Vicem.Runtime {',
    '    public class BatonSerializer {',
    '        public static Dictionary<string, string> ParseHeaders(string rawText) {',
    '            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);',
    '            if (string.IsNullOrWhiteSpace(rawText)) {',
    '                return map;',
    '            }',
    '            foreach (var line in rawText.Split(\'\\n\')) {',
    '                var idx = line.IndexOf(\':\');',
    '                if (idx > 0) {',
    '                    map[line.Substring(0, idx).Trim()] = line.Substring(idx + 1).Trim();',
    '                }',
    '            }',
    '            return map;',
    '        }',
    '    }',
    '}',
  ].join('\n');

  const csRes = CodeSkeletonizer.skeletonize('src/BatonSerializer.cs', csharpCode, { minLines: 5 });
  assert.equal(csRes.ledgerEntries.length, 1);
  assert.equal(csRes.ledgerEntries[0].symbolName, 'ParseHeaders');
});

// ============================================================================
// SECTION 4: DietLedger Persistence, Redaction & Rehydration Round-Trip Matrix
// ============================================================================

test('AST Matrix [DietLedger & DietEngine]: multi-language persistence, secret sanitization, and symbol lookup', () => {
  const tmpDir = makeTmpDir();
  try {
    const engine = new DietEngine(tmpDir);

    const fixtures = [
      {
        relPath: 'src/math.ts',
        content: [
          'export function fibonacciIterative(n: number): number {',
          '  if (n <= 1) return n;',
          '  let prev = 0;',
          '  let curr = 1;',
          '  for (let i = 2; i <= n; i++) {',
          '    const next = prev + curr;',
          '    prev = curr;',
          '    curr = next;',
          '  }',
          '  return curr;',
          '}',
          '',
          'export function gcdEuclidean(a: number, b: number): number {',
          '  let x = Math.abs(a);',
          '  let y = Math.abs(b);',
          '  while (y !== 0) {',
          '    const t = y;',
          '    y = x % y;',
          '    x = t;',
          '  }',
          '  return x;',
          '}',
        ].join('\n'),
      },
      {
        relPath: 'src/text_utils.py',
        content: [
          'def slugify_heading(title: str) -> str:',
          '    cleaned = title.strip().lower()',
          '    parts = [p for p in cleaned.split(" ") if p]',
          '    joined = "-".join(parts)',
          '    return joined or "section"',
          '',
          'def count_code_fences(markdown_body: str) -> int:',
          '    count = 0',
          '    for line in markdown_body.splitlines():',
          '        if line.strip().startswith("```"):',
          '            count += 1',
          '    return count',
        ].join('\n'),
      },
      {
        relPath: 'pkg/retry/retry.go',
        content: [
          'package retry',
          '',
          'func BackoffDurationMs(attempt int, baseMs int, maxMs int) int {',
          '\tif attempt <= 0 {',
          '\t\treturn baseMs',
          '\t}',
          '\tdelay := baseMs << uint(attempt)',
          '\tif delay > maxMs {',
          '\t\treturn maxMs',
          '\t}',
          '\treturn delay',
          '}',
        ].join('\n'),
      },
    ];

    for (const fix of fixtures) {
      const res = engine.dietCode(fix.relPath, fix.content, { minLines: 5 });
      assert.ok(!res.omitted);
      assert.ok(res.ledgerEntries.length >= 1);
    }

    // Save ledger to disk and reload
    const savedPath = engine.ledger.save(tmpDir);
    assert.ok(fs.existsSync(savedPath));
    const reloaded = DietLedger.load(tmpDir);
    assert.equal(reloaded.entries.length, engine.ledger.entries.length);

    // Verify exact symbol lookup, partial symbol lookup, and suffix path lookup
    assert.ok(reloaded.getEntry('src/math.ts', 'fibonacciIterative').includes('let prev = 0;'));
    assert.ok(reloaded.getEntry('math.ts', 'gcd').includes('while (y !== 0)'));
    assert.ok(reloaded.getEntry('text_utils.py', 'slugify_heading').includes('joined = "-".join(parts)'));
    assert.ok(reloaded.getEntry('pkg/retry/retry.go', 'BackoffDurationMs').includes('delay := baseMs'));

    // Verify full-file rehydration when symbolName is omitted
    const allMath = reloaded.getEntry('src/math.ts');
    assert.ok(allMath.includes('fibonacciIterative') && allMath.includes('gcdEuclidean'));

    // Verify UC-15 Zero-Leakage inside DietLedger: secrets inside function bodies are redacted before storage
    const secretFn = [
      'export function connectStripe() {',
      '  const key = "' + SYNTHETIC_SERVICE_TOKEN_0 + '";',
      '  return key;',
      '}',
    ].join('\n');
    reloaded.addEntry({
      filePath: 'src/billing.ts',
      symbolName: 'connectStripe',
      startLine: 1,
      endLine: 4,
      content: secretFn,
    });
    const storedBilling = reloaded.getEntry('src/billing.ts', 'connectStripe');
    assert.ok(!storedBilling.includes('' + SYNTHETIC_SERVICE_TOKEN_0 + ''));
    assert.ok(storedBilling.includes('‹REDACTED:STRIPE:'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 5: DataSampler, LogSlimmer, NoiseGate & TokenEstimator Matrix
// ============================================================================

test('AST Matrix [DataSampler]: JSON arrays, nested objects, depth limits, CSV, and SQL DDL/DML', () => {
  // 1. JSON Array with > maxArrayItems elements
  const largeArray = Array.from({ length: 45 }, (_, idx) => ({
    id: idx + 1,
    username: `user_${idx + 1}`,
    tags: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
    bio: 'A'.repeat(240),
  }));
  const sampledJsonArr = DataSampler.sample(JSON.stringify(largeArray, null, 2));
  assert.match(sampledJsonArr, /\/\* \.\.\. 43 items truncated \*\//);
  assert.match(sampledJsonArr, /\/\* \.\.\. 4 items truncated \*\//);
  assert.match(sampledJsonArr, /\.\.\.\[truncated\]/);

  // 2. JSON Object with > 40 keys
  const manyKeysObj = {};
  for (let i = 0; i < 55; i++) {
    manyKeysObj[`field_key_${String(i).padStart(2, '0')}`] = `value_${i}`;
  }
  const sampledObj = JSON.parse(DataSampler.sampleJson(JSON.stringify(manyKeysObj)));
  assert.equal(sampledObj.__more_keys__, '15 keys omitted');

  // 3. Deeply nested JSON object > depth 6 hits [MaxDepthReached]
  const deepObj = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: 'deep' } } } } } } } };
  const sampledDeep = DataSampler.sampleJson(JSON.stringify(deepObj));
  assert.ok(sampledDeep.includes('[MaxDepthReached]'));

  // 4. Invalid JSON falls back to safe slice truncation
  const brokenJson = '{ "unclosed": [' + '1, 2, 3, '.repeat(250);
  const sampledBroken = DataSampler.sampleJson(brokenJson);
  assert.match(sampledBroken, /truncated invalid\/partial JSON/);

  // 5. CSV with > 4 rows
  const csvRows = ['id,name,score', ...Array.from({ length: 25 }, (_, i) => `${i},item_${i},${i * 10}`)].join('\n');
  const sampledCsv = DataSampler.sample(csvRows);
  assert.match(sampledCsv, /# \.\.\. 22 rows truncated \(Total rows: 25\)/);

  // 6. SQL with leading comments, DDL (CREATE/ALTER/DROP/COMMENT ON), and DML (INSERT/COPY)
  const sqlScript = [
    '-- Header migration comment',
    'CREATE TABLE audit_logs (',
    '  id BIGSERIAL PRIMARY KEY,',
    '  actor TEXT NOT NULL,',
    '  created_at TIMESTAMPTZ DEFAULT NOW()',
    ');',
    '',
    '/* Multi-line comment before index */',
    'CREATE INDEX idx_audit_actor ON audit_logs (actor);',
    '',
    '-- Seed data statements that should be omitted by DataSampler:',
    "INSERT INTO audit_logs (actor) VALUES ('system_init');",
    "INSERT INTO audit_logs (actor) VALUES ('admin_seed');",
    'COPY audit_logs (actor) FROM stdin;',
    '',
    'ALTER TABLE audit_logs ADD COLUMN metadata JSONB;',
  ].join('\n');
  const sampledSql = DataSampler.sampleSql(sqlScript);
  assert.ok(sampledSql.includes('CREATE TABLE audit_logs'));
  assert.ok(sampledSql.includes('CREATE INDEX idx_audit_actor'));
  assert.ok(sampledSql.includes('ALTER TABLE audit_logs ADD COLUMN metadata JSONB'));
  assert.ok(!sampledSql.includes("VALUES ('system_init')"));
  assert.match(sampledSql, /3 INSERT\/COPY data statements omitted by DataSampler/);
});

test('AST Matrix [LogSlimmer]: ANSI stripping, progress bar CR collapsing, stack frame pruning, and line deduplication', () => {
  const tmpDir = makeTmpDir();
  try {
    const noisyLog = [
      '\x1b[32mPASS\x1b[0m test/unit/a.test.ts',
      '✓ test case 1 passed (2ms)',
      '✔ test case 2 passed (1ms)',
      'Downloading https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
      'Progress 10%\rProgress 50%\rProgress 100%',
      '\x1b[31mFAIL\x1b[0m test/unit/auth.test.ts',
      'AssertionError: expected 401 to equal 200',
      '    at Object.<anonymous> (src/auth.test.ts:42:15)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at runTest (node_modules/jest-runner/build/runTest.js:400:10)',
      '    at async Promise.all (index 0)',
      'Retry warning: connection reset',
      'Retry warning: connection reset',
      'Retry warning: connection reset',
      'Inline screenshot: data:image/png;base64,' + 'A'.repeat(120),
    ].join('\n');

    const slimmed = LogSlimmer.slim(noisyLog, { projectRoot: tmpDir });
    assert.ok(slimmed.includes('[LogSlimmer: 4 passing/progress lines omitted]'));
    assert.ok(slimmed.includes('Progress 100%'));
    assert.ok(!slimmed.includes('Progress 10%'));
    assert.ok(slimmed.includes('AssertionError: expected 401 to equal 200'));
    assert.ok(slimmed.includes('src/auth.test.ts:42:15'));
    assert.ok(slimmed.includes('[2 internal/library stack frames omitted]'));
    assert.ok(slimmed.includes('[previous line repeated 2 more times]'));
    assert.ok(slimmed.includes('data:...;base64,[OMITTED]'));
    assert.ok(fs.existsSync(path.join(tmpDir, '.vicem', 'raw', 'last_build.log')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AST Matrix [NoiseGate & TokenEstimator & DisplayWidth]: full classification, gitignore globs, and CJK/Emoji padding', () => {
  const tmpDir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '# Custom ignore\n*.generated.ts\ncustom_out/\n!important.generated.ts\n');
    const gate = new NoiseGate(tmpDir);

    const ignoredPaths = [
      'node_modules/react/index.js',
      '.git/config',
      'dist/bundle.min.js',
      'build/output.css.map',
      'pnpm-lock.yaml',
      'package-lock.json',
      'Cargo.lock',
      'assets/hero.webp',
      'db/local.sqlite3',
      'fonts/inter.woff2',
      'archive/release.tar.gz',
      '.env.production',
      'src/schema.generated.ts',
      'custom_out/data.json',
    ];
    for (const p of ignoredPaths) {
      assert.equal(gate.isIgnored(p), true, `Expected ${p} to be ignored by NoiseGate`);
    }

    const allowedPaths = [
      'src/index.ts',
      'lib/server.py',
      'cmd/main.go',
      'README.md',
      'migrations/001_init.sql',
      'config/settings.yaml',
      '.env.example',
    ];
    for (const p of allowedPaths) {
      assert.equal(gate.isIgnored(p), false, `Expected ${p} to be allowed by NoiseGate`);
    }

    // Minified or binary content checks
    assert.equal(NoiseGate.isMinifiedOrBinaryContent('hello\0world'), true);
    assert.equal(NoiseGate.isMinifiedOrBinaryContent('var a=1;'.repeat(400)), true);
    assert.equal(NoiseGate.isMinifiedOrBinaryContent('export const x = 1;\nexport const y = 2;\n'), false);

    // TokenEstimator & Unicode Display Width
    assert.equal(TokenEstimator.formatCount(-50), '0');
    assert.equal(TokenEstimator.formatCount(0), '0');
    assert.equal(TokenEstimator.formatCount(999), '999');
    assert.equal(TokenEstimator.formatCount(1500), '1.5k');
    assert.equal(TokenEstimator.formatCount(1250000), '1.3M');

    assert.equal(stripAnsi('\x1b[32mGreen\x1b[0m \x1b]52;c;aGVsbG8=\x07'), 'Green ');
    assert.equal(isFullWidthCodePoint('한'.codePointAt(0)), true);
    assert.equal(isFullWidthCodePoint('A'.codePointAt(0)), false);
    assert.equal(getDisplayWidth('한글AB'), 6);
    assert.equal(getDisplayWidth( padDisplayColumn('한글', 8) ), 8);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 6: Exhaustive Parameterized Multi-Language Function Corpus (120+ Permutations)
// ============================================================================

const LANGUAGE_CORPUS_MATRIX = [
  // TypeScript Permutations
  {
    id: 'TS-01',
    file: 'src/ts01.ts',
    symbol: 'validateJwtClaims',
    header: 'export function validateJwtClaims(token: string, issuer: string): boolean {',
    bodyLines: [
      '  const parts = token.split(".");',
      '  if (parts.length !== 3) return false;',
      '  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));',
      '  if (payload.iss !== issuer) return false;',
      '  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return false;',
      '  return true;',
    ],
    footer: '}',
  },
  {
    id: 'TS-02',
    file: 'src/ts02.ts',
    symbol: 'mergeDeepConfig',
    header: 'export const mergeDeepConfig = <T extends object>(base: T, patch: Partial<T>): T => {',
    bodyLines: [
      '  const out: any = Array.isArray(base) ? [...base] : { ...base };',
      '  for (const [k, v] of Object.entries(patch || {})) {',
      '    if (v && typeof v === "object" && !Array.isArray(v)) {',
      '      out[k] = mergeDeepConfig(out[k] || {}, v);',
      '    } else {',
      '      out[k] = v;',
      '    }',
      '  }',
      '  return out as T;',
    ],
    footer: '};',
  },
  {
    id: 'TS-03',
    file: 'src/ts03.ts',
    symbol: 'retryWithJitter',
    header: 'export async function retryWithJitter<R>(task: () => Promise<R>, maxAttempts = 4): Promise<R> {',
    bodyLines: [
      '  let lastErr: unknown = null;',
      '  for (let attempt = 1; attempt <= maxAttempts; attempt++) {',
      '    try {',
      '      return await task();',
      '    } catch (err) {',
      '      lastErr = err;',
      '    }',
      '  }',
      '  throw lastErr;',
    ],
    footer: '}',
  },
  {
    id: 'TS-04',
    file: 'src/ts04.ts',
    symbol: 'paginateCursor',
    header: 'export function* paginateCursor<T>(items: T[], pageSize: number): Generator<T[], void, unknown> {',
    bodyLines: [
      '  const step = Math.max(1, pageSize);',
      '  let offset = 0;',
      '  while (offset < items.length) {',
      '    const slice = items.slice(offset, offset + step);',
      '    yield slice;',
      '    offset += step;',
      '  }',
    ],
    footer: '}',
  },
  {
    id: 'TS-05',
    file: 'src/ts05.ts',
    symbol: 'normalizeHeaderMap',
    header: 'function normalizeHeaderMap(rawHeaders: Record<string, string | string[] | undefined>): Map<string, string> {',
    bodyLines: [
      '  const map = new Map<string, string>();',
      '  for (const key of Object.keys(rawHeaders)) {',
      '    const val = rawHeaders[key];',
      '    if (Array.isArray(val)) map.set(key.toLowerCase(), val.join(", "));',
      '    else if (typeof val === "string") map.set(key.toLowerCase(), val.trim());',
      '  }',
      '  return map;',
    ],
    footer: '}',
  },
  // JavaScript Permutations
  {
    id: 'JS-01',
    file: 'lib/js01.js',
    symbol: 'debounceAsync',
    header: 'export function debounceAsync(fn, waitMs = 100) {',
    bodyLines: [
      '  let timer = null;',
      '  return function debounced(...args) {',
      '    if (timer) clearTimeout(timer);',
      '    return new Promise((resolve) => {',
      '      timer = setTimeout(() => resolve(fn.apply(this, args)), waitMs);',
      '    });',
      '  };',
    ],
    footer: '}',
  },
  {
    id: 'JS-02',
    file: 'lib/js02.mjs',
    symbol: 'topoSortGraph',
    header: 'export const topoSortGraph = (edges) => {',
    bodyLines: [
      '  const inDegree = new Map();',
      '  const adj = new Map();',
      '  for (const [u, v] of edges) {',
      '    if (!adj.has(u)) adj.set(u, []);',
      '    adj.get(u).push(v);',
      '    inDegree.set(v, (inDegree.get(v) || 0) + 1);',
      '    if (!inDegree.has(u)) inDegree.set(u, 0);',
      '  }',
      '  return Array.from(inDegree.keys());',
    ],
    footer: '};',
  },
  {
    id: 'JS-03',
    file: 'lib/js03.cjs',
    symbol: 'parseQueryPairs',
    header: 'function parseQueryPairs(searchStr) {',
    bodyLines: [
      '  const clean = String(searchStr || "").replace(/^\\?/, "");',
      '  const out = {};',
      '  for (const part of clean.split("&")) {',
      '    if (!part) continue;',
      '    const [k, v = ""] = part.split("=");',
      '    out[decodeURIComponent(k)] = decodeURIComponent(v);',
      '  }',
      '  return out;',
    ],
    footer: '}',
  },
  // Go Permutations
  {
    id: 'GO-01',
    file: 'internal/go01.go',
    symbol: 'ComputeMovingAverage',
    header: 'func ComputeMovingAverage(series []float64, window int) []float64 {',
    bodyLines: [
      '\tif window <= 0 || len(series) == 0 {',
      '\t\treturn nil',
      '\t}',
      '\tout := make([]float64, 0, len(series))',
      '\tvar sum float64',
      '\tfor i, v := range series {',
      '\t\tsum += v',
      '\t\tif i >= window {',
      '\t\t\tsum -= series[i-window]',
      '\t\t}',
      '\t\tout = append(out, sum)',
      '\t}',
      '\treturn out',
    ],
    footer: '}',
  },
  {
    id: 'GO-02',
    file: 'internal/go02.go',
    symbol: 'ValidateBatchIDs',
    header: 'func (s *BatchService) ValidateBatchIDs(ids []string) ([]string, error) {',
    bodyLines: [
      '\tseen := make(map[string]struct{}, len(ids))',
      '\tvalid := make([]string, 0, len(ids))',
      '\tfor _, id := range ids {',
      '\t\tif id == "" {',
      '\t\t\tcontinue',
      '\t\t}',
      '\t\tif _, ok := seen[id]; !ok {',
      '\t\t\tseen[id] = struct{}{}',
      '\t\t\tvalid = append(valid, id)',
      '\t\t}',
      '\t}',
      '\treturn valid, nil',
    ],
    footer: '}',
  },
  // Rust Permutations
  {
    id: 'RS-01',
    file: 'src/rs01.rs',
    symbol: 'encode_varint',
    header: 'pub fn encode_varint(mut value: u64) -> Vec<u8> {',
    bodyLines: [
      '    let mut buf = Vec::with_capacity(10);',
      '    while value >= 0x80 {',
      '        buf.push(((value as u8) & 0x7f) | 0x80);',
      '        value >>= 7;',
      '    }',
      '    buf.push(value as u8);',
      '    buf',
    ],
    footer: '}',
  },
  {
    id: 'RS-02',
    file: 'src/rs02.rs',
    symbol: 'decode_varint',
    header: 'pub fn decode_varint(bytes: &[u8]) -> Option<(u64, usize)> {',
    bodyLines: [
      '    let mut result: u64 = 0;',
      '    let mut shift: u32 = 0;',
      '    for (idx, &b) in bytes.iter().enumerate() {',
      '        let slice = (b & 0x7f) as u64;',
      '        result |= slice << shift;',
      '        if (b & 0x80) == 0 {',
      '            return Some((result, idx + 1));',
      '        }',
      '        shift += 7;',
      '    }',
      '    None',
    ],
    footer: '}',
  },
  // Java Permutations
  {
    id: 'JV-01',
    file: 'src/Jv01.java',
    symbol: 'binarySearchRange',
    header: 'public static int binarySearchRange(int[] sorted, int target) {',
    bodyLines: [
      '    int low = 0;',
      '    int high = sorted.length - 1;',
      '    while (low <= high) {',
      '        int mid = (low + high) >>> 1;',
      '        if (sorted[mid] < target) low = mid + 1;',
      '        else if (sorted[mid] > target) high = mid - 1;',
      '        else return mid;',
      '    }',
      '    return -(low + 1);',
    ],
    footer: '}',
  },
  // C / C++ Permutations
  {
    id: 'CPP-01',
    file: 'src/cpp01.cpp',
    symbol: 'clampMatrixValues',
    header: 'void clampMatrixValues(std::vector<double>& data, double minVal, double maxVal) {',
    bodyLines: [
      '    for (size_t i = 0; i < data.size(); ++i) {',
      '        if (data[i] < minVal) {',
      '            data[i] = minVal;',
      '        } else if (data[i] > maxVal) {',
      '            data[i] = maxVal;',
      '        }',
      '    }',
    ],
    footer: '}',
  },
  // C# Permutations
  {
    id: 'CS-01',
    file: 'src/Cs01.cs',
    symbol: 'ComputeLevenshteinDistance',
    header: 'public static int ComputeLevenshteinDistance(string source, string target) {',
    bodyLines: [
      '    if (string.IsNullOrEmpty(source)) return target?.Length ?? 0;',
      '    if (string.IsNullOrEmpty(target)) return source.Length;',
      '    int[,] dp = new int[source.Length + 1, target.Length + 1];',
      '    for (int i = 0; i <= source.Length; i++) dp[i, 0] = i;',
      '    for (int j = 0; j <= target.Length; j++) dp[0, j] = j;',
      '    return dp[source.Length, target.Length];',
    ],
    footer: '}',
  },
];

for (const item of LANGUAGE_CORPUS_MATRIX) {
  test(`AST Corpus [${item.id}] (${item.file} :: ${item.symbol}): skeletonize, minLines threshold, and ledger rehydration`, () => {
    const fullSource = [item.header, ...item.bodyLines, item.footer].join('\n');
    const totalLines = fullSource.split('\n').length;

    // 1. When minLines is <= totalLines, function is skeletonized and stored in ledger
    const ledger = new DietLedger(`corpus-${item.id}`);
    const skelRes = CodeSkeletonizer.skeletonize(item.file, fullSource, {
      ledger,
      minLines: 4,
    });
    assert.equal(skelRes.ledgerEntries.length, 1);
    assert.equal(skelRes.ledgerEntries[0].symbolName, item.symbol);
    assert.equal(skelRes.ledgerEntries[0].startLine, 1);
    assert.equal(skelRes.ledgerEntries[0].endLine, totalLines);
    assert.ok(skelRes.skeleton.includes('{ /* ... */ }'));
    const expectedLedgerSlice = fullSource.replace(/;\s*$/, '');
    assert.equal(ledger.getEntry(item.file, item.symbol), expectedLedgerSlice);

    // 2. When minLines is > totalLines, function is preserved verbatim without skeletonization
    const highThresholdRes = CodeSkeletonizer.skeletonize(item.file, fullSource, {
      minLines: totalLines + 10,
    });
    assert.equal(highThresholdRes.ledgerEntries.length, 0);
    assert.equal(highThresholdRes.skeleton, fullSource);
  });
}

// ============================================================================
// SECTION 7: ContextFileRanker 1-Hop Import & Priority Scoring Matrix
// ============================================================================

test('AST Matrix [ContextFileRanker]: TS ESM .js->.ts remapping, @/* and ~/* aliases, directory index, Python relative imports, and traversal block', () => {
  const tmpDir = makeTmpDir('vicem-ranker-matrix-');
  try {
    fs.mkdirSync(path.join(tmpDir, 'src', 'types'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'services'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'pkg', 'models'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'types', 'contracts.ts'),
      'export interface OrderContract { id: string; amount: number; }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'utils', 'index.ts'),
      'export const formatCents = (n: number) => `$${(n / 100).toFixed(2)}`;\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'services', 'checkout.ts'),
      [
        'import type { OrderContract } from "../types/contracts.js";',
        'import { formatCents } from "@/utils";',
        'const helper = require("../types/contracts");',
        'export function runCheckout(order: OrderContract) {',
        '  return formatCents(order.amount);',
        '}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'pkg', 'models', 'user.py'),
      'class UserRecord:\n    pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'pkg', 'models', 'service.py'),
      'from .user import UserRecord\nfrom ....outside import Evil\n'
    );

    // 1. Direct TS import resolution with .js -> .ts remapping
    const resolvedContract = ContextFileRanker.resolveImportCandidate(
      tmpDir,
      'src/services/checkout.ts',
      '../types/contracts.js'
    );
    assert.equal(resolvedContract, 'src/types/contracts.ts');

    // 2. Alias @/utils resolving to directory index src/utils/index.ts
    const resolvedIndex = ContextFileRanker.resolveImportCandidate(
      tmpDir,
      'src/services/checkout.ts',
      '@/utils'
    );
    assert.equal(resolvedIndex, 'src/utils/index.ts');

    // 3. Path traversal specifier outside projectRoot is rejected (returns null)
    const traversal = ContextFileRanker.resolveImportCandidate(
      tmpDir,
      'src/services/checkout.ts',
      '../../../../etc/passwd'
    );
    assert.equal(traversal, null);

    // 4. Bare npm package specifier returns null
    assert.equal(
      ContextFileRanker.resolveImportCandidate(tmpDir, 'src/services/checkout.ts', 'react/jsx-runtime'),
      null
    );

    // 5. Python relative import resolution
    const pyImports = ContextFileRanker.extractLocalImports(
      tmpDir,
      'pkg/models/service.py',
      fs.readFileSync(path.join(tmpDir, 'pkg', 'models', 'service.py'), 'utf8')
    );
    assert.deepEqual(pyImports, ['pkg/models/user.py']);

    // 6. Full rankFiles priority order: errorLog (+100) + prompt (+80) + modified (+50) + 1-hop imports (+65)
    const ranked = ContextFileRanker.rankFiles({
      projectRoot: tmpDir,
      modifiedFiles: ['src/services/checkout.ts', 'pkg/models/service.py'],
      errorLog: 'TypeError at src/services/checkout.ts:4:10',
      taskContext: {
        goal: 'Fix checkout calculation in checkout.ts',
        immediateNext: ['Verify OrderContract'],
        userPrompts: [],
      },
      maxFiles: 10,
    });

    assert.equal(ranked[0], 'src/services/checkout.ts');
    assert.ok(ranked.includes('src/types/contracts.ts'));
    assert.ok(ranked.includes('src/utils/index.ts'));
    assert.ok(ranked.includes('pkg/models/service.py'));
    assert.ok(ranked.includes('pkg/models/user.py'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 8: Python & Cross-Platform CRLF / Unicode / Nested Scope Corpus Matrix
// ============================================================================

const PYTHON_CORPUS_MATRIX = [
  {
    id: 'PY-01',
    file: 'app/services/auth.py',
    symbol: 'verify_totp_code',
    lines: [
      'def verify_totp_code(secret: str, code: str, window: int = 1) -> bool:',
      '    clean_secret = secret.strip().upper()',
      '    clean_code = code.strip()',
      '    if len(clean_code) != 6 or not clean_code.isdigit():',
      '        return False',
      '    for offset in range(-window, window + 1):',
      '        candidate = str((len(clean_secret) * 123456 + offset) % 1000000).zfill(6)',
      '        if candidate == clean_code:',
      '            return True',
      '    return False',
    ],
  },
  {
    id: 'PY-02',
    file: 'app/services/pipeline.py',
    symbol: 'run_etl_stage',
    lines: [
      'async def run_etl_stage(',
      '    records: list,',
      '    batch_size: int = 50,',
      '    strict: bool = True,  # trailing comment: with colon!',
      ') -> dict:',
      '    processed = 0',
      '    failed = 0',
      '    for idx in range(0, len(records), batch_size):',
      '        chunk = records[idx : idx + batch_size]',
      '        if not chunk and strict:',
      '            failed += 1',
      '        else:',
      '            processed += len(chunk)',
      '    return {"processed": processed, "failed": failed}',
    ],
  },
  {
    id: 'PY-03',
    file: 'app/services/report.py',
    symbol: 'render_markdown_summary',
    lines: [
      'def render_markdown_summary(title: str, rows: list) -> str:',
      '    template = """',
      '# Report Header at Column 0',
      '| Column A | Column B |',
      '| -------- | -------- |',
      '"""',
      '    body_lines = [template.strip()]',
      '    for r in rows:',
      '        body_lines.append(f"| {r[0]} | {r[1]} |")',
      '    return f"## {title}\\n" + "\\n".join(body_lines)',
    ],
  },
  {
    id: 'PY-04',
    file: 'app/services/serializer.py',
    symbol: 'encode_compact_frame',
    lines: [
      'def encode_compact_frame(headers: dict, payload: bytes) -> bytes:',
      '    parts = []',
      '    for k, v in sorted(headers.items()):',
      '        line = f"{k.lower()}:{v}".encode("utf-8")',
      '        parts.append(line)',
      '    header_blob = b"\\n".join(parts)',
      '    return header_blob + b"\\n\\n" + payload',
    ],
  },
  {
    id: 'PY-05',
    file: 'app/services/cache.py',
    symbol: 'evict_expired_keys',
    lines: [
      'def evict_expired_keys(store: dict, now_ts: float) -> int:',
      '    expired = []',
      '    for key, entry in store.items():',
      '        if entry.get("expires_at", 0) <= now_ts:',
      '            expired.append(key)',
      '    for key in expired:',
      '        del store[key]',
      '    return len(expired)',
    ],
  },
];

for (const pyCase of PYTHON_CORPUS_MATRIX) {
  test(`AST Python Corpus [${pyCase.id}] (${pyCase.file} :: ${pyCase.symbol}): LF and CRLF parity + ledger rehydration`, () => {
    const lfText = pyCase.lines.join('\n');
    const crlfText = pyCase.lines.join('\r\n');

    const lfLedger = new DietLedger(`lf-${pyCase.id}`);
    const lfRes = CodeSkeletonizer.skeletonize(pyCase.file, lfText, {
      ledger: lfLedger,
      minLines: 4,
    });
    assert.equal(lfRes.ledgerEntries.length, 1);
    assert.equal(lfRes.ledgerEntries[0].symbolName, pyCase.symbol);
    assert.equal(lfRes.ledgerEntries[0].startLine, 1);
    assert.equal(lfRes.ledgerEntries[0].endLine, pyCase.lines.length);
    assert.ok(lfRes.skeleton.endsWith('    pass'));
    assert.equal(lfLedger.getEntry(pyCase.file, pyCase.symbol), lfText);

    const crlfLedger = new DietLedger(`crlf-${pyCase.id}`);
    const crlfRes = CodeSkeletonizer.skeletonize(pyCase.file, crlfText, {
      ledger: crlfLedger,
      minLines: 4,
    });
    assert.equal(crlfRes.ledgerEntries.length, 1);
    assert.equal(crlfRes.ledgerEntries[0].symbolName, pyCase.symbol);
    assert.equal(crlfLedger.getEntry(pyCase.file, pyCase.symbol), lfText);
  });
}

test('AST Matrix [Edge Inputs]: null, undefined, empty strings, whitespace-only, and comment-only files', () => {
  assert.deepEqual(CodeSkeletonizer.skeletonize('src/empty.ts', ''), {
    skeleton: '',
    ledgerEntries: [],
  });
  assert.deepEqual(CodeSkeletonizer.skeletonize('src/null.ts', null), {
    skeleton: '',
    ledgerEntries: [],
  });
  assert.deepEqual(CodeSkeletonizer.skeletonize('src/undef.py', undefined), {
    skeleton: '',
    ledgerEntries: [],
  });

  const commentsOnly = [
    '// Header comment line 1',
    '// Header comment line 2',
    '/* Block comment with { unbalanced brace */',
    '',
  ].join('\n');
  const commentRes = CodeSkeletonizer.skeletonize('src/comments.ts', commentsOnly, { minLines: 1 });
  assert.equal(commentRes.ledgerEntries.length, 0);
  assert.equal(commentRes.skeleton, commentsOnly);
});

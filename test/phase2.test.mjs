import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NoiseGate,
  LogSlimmer,
  DataSampler,
  CodeSkeletonizer,
  DietLedger,
  TokenEstimator,
} from '../vicem.mjs';

test('TC-DIET-01: C-Family brace balancing, Type/Interface 100% preservation, and MIN_SKELETON_LINES=12 threshold', () => {
  const tsInput = `
export interface UserProfile {
  id: string;
  roles: Array<{ name: string; level: number }>;
  metadata: {
    created: string;
    flags: { active: boolean; beta: boolean };
  };
  city: string;
  country: string;
  zipCode: string;
  phone: string;
  avatarUrl: string;
}

export class UserService {
  private secret = "nested { brace } string";

  // Short 4-line helper (< 12 lines) -> MUST stay intact!
  public isValidId(id: string): boolean {
    const regex = /\\{[0-9]+\\}/g;
    return Boolean(id) && !regex.test(id);
  }

  // Long method (>= 12 lines) -> MUST be skeletonized and recorded in Ledger!
  public async getUser(id: string): Promise<UserProfile> {
    const regex = /\\{[0-9]+\\}/g;
    const tpl = \`template { with { nested } braces } \${id}\`;
    if (!id) {
      throw new Error("Invalid ID { brace in error }");
    }
    const row = await this.queryDb(id);
    if (!row) {
      throw new Error("Not found");
    }
    const roles = row.roles || [];
    const active = Boolean(row.active);
    return {
      id: row.id,
      roles,
      metadata: { created: "now", flags: { active, beta: false } },
      city: "Seoul",
      country: "KR",
      zipCode: "01234",
      phone: "010-0000-0000",
      avatarUrl: tpl,
    };
  }
}
`.trim();

  const ledger = new DietLedger('test-baton');
  const { skeleton } = CodeSkeletonizer.skeletonize('src/user.ts', tsInput, { ledger, minLines: 12 });

  // 1. UserProfile interface (>12 lines) MUST be 100% preserved!
  assert.ok(skeleton.includes('export interface UserProfile {'));
  assert.ok(skeleton.includes('flags: { active: boolean; beta: boolean };'));
  assert.ok(skeleton.includes('avatarUrl: string;'));

  // 2. Short helper isValidId (<12 lines) MUST be 100% preserved!
  assert.ok(skeleton.includes('public isValidId(id: string): boolean {'));
  assert.ok(skeleton.includes('return Boolean(id) && !regex.test(id);'));

  // 3. Long method getUser (>=12 lines) signature preserved, body replaced with /* ... */
  assert.ok(skeleton.includes('public async getUser(id: string): Promise<UserProfile> { /* ... */ }'));
  assert.equal(skeleton.includes('city: "Seoul"'), false);

  // 4. Ledger contains the full implementation of getUser for on-demand rehydration
  const restored = ledger.getEntry('src/user.ts', 'getUser');
  assert.ok(restored);
  assert.ok(restored.includes('city: "Seoul"'));
});

test('TC-DIET-02: Python indentation-based skeletonization with docstrings and minLines threshold', () => {
  const pyInput = `
class AuthProcessor:
    def short_helper(self, x: int) -> int:
        return x + 1

    async def verify_session(self, token: str) -> dict:
        """
        Multi-line docstring with colons:
        and indentation inside.
        """
        if not token:
            raise ValueError("Missing token")
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("Malformed JWT")
        header = parts[0]
        payload = parts[1]
        sig = parts[2]
        result = {"header": header, "payload": payload, "sig": sig}
        return result
`.trim();

  const ledger = new DietLedger('py-baton');
  const { skeleton } = CodeSkeletonizer.skeletonize('app/auth.py', pyInput, { ledger, minLines: 10 });

  // short_helper preserved
  assert.ok(skeleton.includes('return x + 1'));
  // verify_session skeletonized to pass
  assert.ok(skeleton.includes('async def verify_session(self, token: str) -> dict:\n        pass'));
  assert.equal(skeleton.includes('Malformed JWT'), false);

  // Ledger holds original verify_session
  const raw = ledger.getEntry('app/auth.py', 'verify_session');
  assert.ok(raw && raw.includes('Malformed JWT'));
});

test('TC-DIET-03: Jest/Vitest error log slimming removes ANSI, passing tests, and internal frames (>90% reduction)', () => {
  const lines = [];
  for (let i = 1; i <= 150; i++) {
    lines.push(`\x1b[32m✓\x1b[0m test suite #${i} passed (12ms)`);
  }
  lines.push('\x1b[31mFAIL\x1b[0m src/auth.test.ts > should reject expired token');
  lines.push('AssertionError: expected 200 to deeply equal 401');
  lines.push('    at Object.<anonymous> (src/auth.test.ts:42:18)');
  for (let i = 0; i < 60; i++) {
    lines.push(`    at processTicksAndRejections (node:internal/process/task_queues:95:5)`);
    lines.push(`    at runTest (/Users/dev/app/node_modules/vitest/dist/runner.js:${i}:12)`);
  }

  const rawLog = lines.join('\n');
  const slimmed = LogSlimmer.slim(rawLog);

  assert.equal(/\x1b\[/.test(slimmed), false, 'ANSI escape codes must be stripped');
  assert.equal(slimmed.includes('test suite #50 passed'), false, 'Passing tests must be stripped');
  assert.ok(slimmed.includes('FAIL src/auth.test.ts > should reject expired token'));
  assert.ok(slimmed.includes('AssertionError: expected 200 to deeply equal 401'));
  assert.ok(slimmed.includes('src/auth.test.ts:42:18'));
  assert.ok(slimmed.includes('internal/library stack frames omitted'));

  const rawTokens = TokenEstimator.estimate(rawLog);
  const slimTokens = TokenEstimator.estimate(slimmed);
  assert.ok(slimTokens < rawTokens * 0.1, `Expected >90% token reduction: ${rawTokens} -> ${slimTokens}`);
});

test('TC-DIET-04: Large JSON array and SQL dump sampling (>95% reduction)', () => {
  const items = [];
  for (let i = 0; i < 1000; i++) {
    items.push({ id: i, name: `User_${i}`, email: `user${i}@example.com`, active: true });
  }
  const bigJson = JSON.stringify({ status: 'ok', count: 1000, users: items }, null, 2);
  const sampled = DataSampler.sampleJson(bigJson);

  assert.ok(sampled.includes('"status": "ok"'));
  assert.ok(sampled.includes('"User_0"'));
  assert.ok(sampled.includes('"User_1"'));
  assert.equal(sampled.includes('"User_2"'), false);
  assert.ok(sampled.includes('/* ... 998 items truncated */'));
  assert.ok(Buffer.byteLength(sampled) <= 2048);

  const sqlDump = `
CREATE TABLE users (id INT PRIMARY KEY, name TEXT);
INSERT INTO users VALUES (1, 'a');
INSERT INTO users VALUES (2, 'b');
INSERT INTO users VALUES (3, 'c');
  `.trim();
  const sampledSql = DataSampler.sampleSql(sqlDump);
  assert.ok(sampledSql.includes('CREATE TABLE users'));
  assert.equal(sampledSql.includes("INSERT INTO users VALUES (1, 'a')"), false);
  assert.ok(sampledSql.includes('3 INSERT/COPY data statements omitted'));
});

test('TC-DIET-05: NoiseGate filters lockfiles, build artifacts, and credential files', () => {
  assert.equal(NoiseGate.isIgnored('package-lock.json'), true);
  assert.equal(NoiseGate.isIgnored('frontend/pnpm-lock.yaml'), true);
  assert.equal(NoiseGate.isIgnored('backend/Cargo.lock'), true);
  assert.equal(NoiseGate.isIgnored('dist/bundle.js'), true);
  assert.equal(NoiseGate.isIgnored('.next/static/chunks/app.js'), true);
  assert.equal(NoiseGate.isIgnored('src/vendor.min.js'), true);
  assert.equal(NoiseGate.isIgnored('.env.local'), true);
  assert.equal(NoiseGate.isIgnored('src/services/user.ts'), false);
});

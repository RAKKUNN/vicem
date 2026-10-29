import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AtomicFs,
  TokenEstimator,
  getDisplayWidth,
  padDisplayColumn,
  SecretRedactor,
  isCredentialFile,
} from '../vicem.mjs';

test('Task 1.1: AtomicFs writes atomically, manages locks, and protects .git/info/exclude without dirtying .gitignore', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-test-p1-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
    const vicemDir = AtomicFs.ensureVicemDir(tmpDir);
    assert.ok(fs.existsSync(vicemDir));
    assert.ok(fs.existsSync(path.join(vicemDir, 'raw')));
    assert.ok(fs.existsSync(path.join(vicemDir, 'snapshots')));

    // Verify .git/info/exclude contains .vicem/ and does NOT create .gitignore
    const excludeContent = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(excludeContent.includes('.vicem/'));
    assert.ok(excludeContent.includes('CLAUDE.local.md'));
    assert.equal(fs.existsSync(path.join(tmpDir, '.gitignore')), false);

    // Idempotency check
    AtomicFs.ensureGitInfoExclude(tmpDir);
    const excludeContentAfter = fs.readFileSync(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(excludeContentAfter, excludeContent);

    // Lock acquisition & release
    const lockPath = AtomicFs.acquireLock(tmpDir);
    assert.ok(fs.existsSync(lockPath));
    AtomicFs.releaseLock(tmpDir);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC-EST-01: Calibrated TokenEstimator accuracy across English, Code, and Korean/CJK', () => {
  assert.equal(TokenEstimator.estimate(''), 0);

  const tsSample = `export async function verifyUserToken(token: string): Promise<boolean> {\n  if (!token) return false;\n  return true;\n}`;
  const tsEst = TokenEstimator.estimate(tsSample);
  // Real o200k/cl100k token count for this snippet is ~26-30 tokens
  assert.ok(tsEst >= 22 && tsEst <= 36, `Expected TS tokens in [22, 36], got ${tsEst}`);

  const cjkSample = `${'\uac00\ub098\ub2e4\ub77c\ub9c8\ubc14\uc0ac\uc544\uc790\ucc28\uce74\ud0c0\ud30c\ud558 '.repeat(3)}(Vicem) CJK token estimation test.`;
  const koEst = TokenEstimator.estimate(cjkSample);
  assert.ok(koEst >= 25 && koEst <= 50, `Expected CJK tokens in [25, 50], got ${koEst}`);

  assert.equal(TokenEstimator.formatCount(3420), '3.4k');
  assert.equal(TokenEstimator.formatCount(850), '850');
});

test('UX-06: CJK / Full-width terminal display width alignment', () => {
  const twoFullWidth = '\ubcf4\uc548';
  assert.equal(getDisplayWidth('abc'), 3);
  assert.equal(getDisplayWidth(twoFullWidth), 4); // 2 full-width syllables = 4 columns
  assert.equal(getDisplayWidth(`\x1b[32m${twoFullWidth}\x1b[0m OK`), 7); // 4 + 1 + 2 = 7
  const padded = padDisplayColumn(twoFullWidth, 8);
  assert.equal(getDisplayWidth(padded), 8);
});

test('TC-SEC-01: Multi-provider API keys, Private Keys, and High-Entropy secrets are 100% masked', () => {
  const rawInput = [
    'AWS_ACCESS_KEY_ID=' + 'AKIA' + 'IOSFODNN7EXAMPLE',
    'GITHUB_TOKEN=' + 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz',
    'OPENAI_API_KEY=' + 'sk-proj-' + 'abcde12345abcde12345abcde12345abcde12345abcde',
    'ANTHROPIC_API_KEY=' + 'sk-ant-' + 'api03-1234567890abcdefghijklmnopqrstuvwxyz',
    'GOOGLE_KEY=' + 'AIza' + 'SyDaGmWKa4JsXZ-0123456789abcdefghij',
    'SLACK_TOKEN=' + 'xoxb-' + '123456789012-1234567890123-abcdefABCDEF1234567890',
    'STRIPE_KEY=' + 'sk_live_' + '51H1234567890abcdefghijklmnop',
    '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA0123456789\n-----END RSA PRIVATE KEY-----',
    'const api_secret = "9zK8xP2mQ7vL4nJ1wR5tY6uI0oP3aS8dF";',
  ].join('\n');

  const { sanitized, redactedCount } = SecretRedactor.redact(rawInput);

  assert.ok(redactedCount >= 9, `Expected >= 9 redactions, got ${redactedCount}`);
  assert.equal(sanitized.includes('AKIA' + 'IOSFODNN7EXAMPLE'), false);
  assert.equal(sanitized.includes('ghp_' + '1234567890'), false);
  assert.equal(sanitized.includes('sk-proj-' + 'abcde12345'), false);
  assert.equal(sanitized.includes('sk-ant-' + 'api03'), false);
  assert.equal(sanitized.includes('AIza' + 'SyDaGmWKa4JsXZ'), false);
  assert.equal(sanitized.includes('xoxb-' + '123456789012'), false);
  assert.equal(sanitized.includes('sk_live_' + '51H12345'), false);
  assert.equal(sanitized.includes('MIIEowIBAAKCAQEA0123456789'), false);
  assert.equal(sanitized.includes('9zK8xP2mQ7vL4nJ1wR5tY6uI0oP3aS8dF'), false);
  assert.ok(sanitized.includes('‹REDACTED:AWS:'));
  assert.ok(sanitized.includes('‹REDACTED:GITHUB:'));
  assert.ok(sanitized.includes('‹REDACTED:OPENAI:'));
  assert.ok(sanitized.includes('‹REDACTED:ANTHROPIC:'));
  assert.ok(sanitized.includes('‹REDACTED:PRIVATE_KEY:'));
});

test('TC-SEC-02: Zero-Network static verification & Credential file blacklist', () => {
  assert.equal(isCredentialFile('.env'), true);
  assert.equal(isCredentialFile('.env.production'), true);
  assert.equal(isCredentialFile('/Users/test/.claude/auth.json'), true);
  assert.equal(isCredentialFile('/Users/test/.ssh/id_ed25519'), true);
  assert.equal(isCredentialFile('src/auth.ts'), false);

  const src = fs.readFileSync(new URL('../vicem.mjs', import.meta.url), 'utf8');
  assert.equal(/node:(?:http|https|net|dgram|tls|dns)/.test(src), false);
});

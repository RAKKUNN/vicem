// Synthetic redaction fixtures, generated at runtime; never real service credentials.
const SYNTHETIC_SERVICE_TOKEN_0 = 'xoxb-' + '123456789012-987654321098-AbCdEfGhIjKlMnOpQrStUvWx';
const SYNTHETIC_SERVICE_TOKEN_1 = 'xoxp-' + '112233445566-778899001122-ZyXwVuTsRqPoNmLkJiHgFeDc';
const SYNTHETIC_SERVICE_TOKEN_2 = 'sk_live_' + '51Nz9X2L8pQ4mR7vK1wB3cD6fG8hJ0kL2mN4pQ6rS';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CREDENTIAL_BLACKLIST_PATTERNS,
  isCredentialFile,
  matchesProjectPathBoundary,
  AtomicFs,
  SecretRedactor,
  SkeletonWriteGuard,
  SecretCommitGuard,
  StalenessDriftGuard,
  SafetyGuardEngine,
  PreHandoffSnapshotStore,
  SmartPatchApplier,
  WebLandAdapter,
  GitHookInstaller,
  safeJsonForHtmlScript,
} from '../vicem.mjs';

function makeTmpDir(prefix = 'vicem-sec-matrix-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// SECTION 1: Exhaustive SecretRedactor Provider & High-Entropy Matrix
// ============================================================================

const SECRET_PROVIDER_CORPUS = [
  {
    id: 'SEC-PK-01',
    provider: 'PRIVATE_KEY',
    raw: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7V1234567890abcdef\n-----END RSA PRIVATE KEY-----',
    context: 'const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7V1234567890abcdef\n-----END RSA PRIVATE KEY-----`;',
  },
  {
    id: 'SEC-PK-02',
    provider: 'PRIVATE_KEY',
    raw: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----',
    context: 'ssh_key: |\n  -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----',
  },
  {
    id: 'SEC-PK-03',
    provider: 'PRIVATE_KEY',
    raw: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEII890123456789abcdef\n-----END EC PRIVATE KEY-----',
    context: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEII890123456789abcdef\n-----END EC PRIVATE KEY-----',
  },
  {
    id: 'SEC-AWS-01',
    provider: 'AWS',
    raw: 'AKIAIOSFODNN7EXAMPLE',
    context: 'export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"',
  },
  {
    id: 'SEC-AWS-02',
    provider: 'AWS',
    raw: 'ASIAQWER1234TYUI5678',
    context: '{"awsSessionKey": "ASIAQWER1234TYUI5678"}',
  },
  {
    id: 'SEC-GH-01',
    provider: 'GITHUB',
    raw: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    context: 'Authorization: Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyz',
  },
  {
    id: 'SEC-GH-02',
    provider: 'GITHUB',
    raw: 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    context: 'const oauthToken = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";',
  },
  {
    id: 'SEC-GH-03',
    provider: 'GITHUB',
    raw: 'ghu_9876543210zyxwvutsrqponmlkjihgfedcba',
    context: 'token=ghu_9876543210zyxwvutsrqponmlkjihgfedcba',
  },
  {
    id: 'SEC-GH-04',
    provider: 'GITHUB',
    raw: 'ghs_abcdef1234567890ABCDEF1234567890abcd',
    context: 'GH_SERVER_TOKEN=ghs_abcdef1234567890ABCDEF1234567890abcd',
  },
  {
    id: 'SEC-GH-05',
    provider: 'GITHUB',
    raw: 'github_pat_' + 'A1b2C3d4_'.repeat(9) + 'Z',
    context: `fine_grained=${'github_pat_' + 'A1b2C3d4_'.repeat(9) + 'Z'}`,
  },
  {
    id: 'SEC-ANT-01',
    provider: 'ANTHROPIC',
    raw: 'sk-ant-api03-9X8y7Z6w5V4u3T2s1R0q9P8o7N6m5L4k',
    context: 'ANTHROPIC_API_KEY=sk-ant-api03-9X8y7Z6w5V4u3T2s1R0q9P8o7N6m5L4k',
  },
  {
    id: 'SEC-OAI-01',
    provider: 'OPENAI',
    raw: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    context: 'OPENAI_API_KEY="sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"',
  },
  {
    id: 'SEC-OAI-02',
    provider: 'OPENAI',
    raw: 'sk-svcacct-ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210',
    context: 'serviceAccountKey: "sk-svcacct-ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210"',
  },
  {
    id: 'SEC-GOOG-01',
    provider: 'GOOGLE',
    raw: 'AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe',
    context: 'const firebaseKey = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe";',
  },
  {
    id: 'SEC-SLK-01',
    provider: 'SLACK',
    raw: '' + SYNTHETIC_SERVICE_TOKEN_0 + '',
    context: 'SLACK_BOT_TOKEN=' + SYNTHETIC_SERVICE_TOKEN_0 + '',
  },
  {
    id: 'SEC-SLK-02',
    provider: 'SLACK',
    raw: '' + SYNTHETIC_SERVICE_TOKEN_1 + '',
    context: 'SLACK_USER_TOKEN=' + SYNTHETIC_SERVICE_TOKEN_1 + '',
  },
  {
    id: 'SEC-STR-01',
    provider: 'STRIPE',
    raw: '' + SYNTHETIC_SERVICE_TOKEN_2 + '',
    context: 'stripeSecret = "' + SYNTHETIC_SERVICE_TOKEN_2 + '"',
  },
  {
    id: 'SEC-STR-02',
    provider: 'STRIPE',
    raw: 'rk_test_99AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSs',
    context: 'restrictedKey = "rk_test_99AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSs"',
  },
  {
    id: 'SEC-JWT-01',
    provider: 'JWT',
    raw: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    context: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  },
];

for (const item of SECRET_PROVIDER_CORPUS) {
  test(`Security Matrix [SecretRedactor :: ${item.id}] (${item.provider}): deterministic redaction and idempotency`, () => {
    const res = SecretRedactor.redact(item.context);
    assert.ok(res.redactedCount >= 1, `Expected redaction count >= 1 for ${item.id}`);
    assert.ok(res.providers.includes(item.provider), `Expected provider ${item.provider} in ${res.providers}`);
    assert.ok(!res.sanitized.includes(item.raw), `Raw secret leaked in ${item.id}: ${res.sanitized}`);
    assert.ok(res.sanitized.includes(`‹REDACTED:${item.provider}:`), `Missing mask tag in ${res.sanitized}`);

    // Idempotency: re-running SecretRedactor.redact on already-sanitized output must not double-redact
    const secondPass = SecretRedactor.redact(res.sanitized);
    assert.equal(secondPass.sanitized, res.sanitized);
  });
}

test('Security Matrix [SecretRedactor False-Positive Immunity]: normal identifiers, file paths, imports, and UUIDs are preserved', () => {
  const safeSnippets = [
    'import { SessionHistoryStack, DeterministicTaskExtractor } from "./vicem.mjs";',
    'const relativeFilePath = "src/components/AuthenticationProviderButton/index.tsx";',
    'const snakeIdentifier = "user_authentication_session_configuration_manager";',
    'const camelIdentifier = "calculateMaximumAllowedContextTokenBudgetThreshold";',
    'const gitCommitMessage = "feat(security): enforce strict boundary validation on project paths";',
    'const normalPasswordLabel = "password: string";',
    'const shortTokenAssignment = "token = \\"abc123\\"";',
    'const urlPath = "https://example.com/docs/getting-started/installation-guide";',
  ];

  for (const snippet of safeSnippets) {
    const res = SecretRedactor.redact(snippet);
    assert.equal(res.redactedCount, 0, `False-positive redaction on safe snippet: ${snippet}\nGot: ${res.sanitized}`);
    assert.equal(res.sanitized, snippet);
  }
});

// ============================================================================
// SECTION 2: Exhaustive Credential File Blacklist Matrix (POSIX & Windows Paths)
// ============================================================================

const CREDENTIAL_FILE_MATRIX = [
  // Blocked credential files
  { path: '.env', blocked: true },
  { path: '.env.local', blocked: true },
  { path: '.env.development', blocked: true },
  { path: '.env.production', blocked: true },
  { path: '.env.staging', blocked: true },
  { path: 'apps/web/.env.test', blocked: true },
  { path: 'C:\\Users\\dev\\project\\.env', blocked: true },
  { path: 'C:\\Users\\dev\\project\\.env.production', blocked: true },
  { path: '.envrc', blocked: true },
  { path: 'certs/server.pem', blocked: true },
  { path: 'certs/private.key', blocked: true },
  { path: 'certs/keystore.p12', blocked: true },
  { path: 'certs/certificate.pfx', blocked: true },
  { path: 'certs/truststore.jks', blocked: true },
  { path: 'certs/ca.crt', blocked: true },
  { path: 'certs/root.cer', blocked: true },
  { path: 'certs/binary.der', blocked: true },
  { path: '/Users/dev/.ssh/id_rsa', blocked: true },
  { path: '/Users/dev/.ssh/id_ed25519', blocked: true },
  { path: '/Users/dev/.ssh/id_ecdsa', blocked: true },
  { path: '/Users/dev/.ssh/id_dsa', blocked: true },
  { path: '/Users/dev/.aws/credentials', blocked: true },
  { path: 'C:\\Users\\dev\\.aws\\config', blocked: true },
  { path: '/Users/dev/.kube/config', blocked: true },
  { path: '/Users/dev/.gcloud/application_default_credentials.json', blocked: true },
  { path: '/Users/dev/.docker/config.json', blocked: true },
  { path: '.npmrc', blocked: true },
  { path: '.pypirc', blocked: true },
  { path: '.netrc', blocked: true },
  { path: '.htpasswd', blocked: true },
  { path: 'config/credentials.json', blocked: true },
  { path: 'config/client_secret_12345.json', blocked: true },
  { path: 'config/service-account-prod.json', blocked: true },
  { path: 'config/service_account_key.key', blocked: true },
  { path: 'config/secrets.yaml', blocked: true },
  { path: 'config/secrets.yml', blocked: true },
  { path: 'config/secrets.json', blocked: true },
  { path: 'config/secrets.toml', blocked: true },
  { path: 'config/secrets.ini', blocked: true },
  // Explicitly allowed template & source files
  { path: '.env.example', blocked: false },
  { path: '.env.sample', blocked: false },
  { path: '.env.template', blocked: false },
  { path: 'config/.ENV.EXAMPLE', blocked: false },
  { path: 'C:\\repo\\.env.sample', blocked: false },
  { path: 'src/auth/credentials_helper.ts', blocked: false },
  { path: 'src/crypto/key_derivation.py', blocked: false },
  { path: 'README.md', blocked: false },
  { path: 'package.json', blocked: false },
];

for (const tc of CREDENTIAL_FILE_MATRIX) {
  test(`Security Matrix [isCredentialFile]: "${tc.path}" -> blocked=${tc.blocked}`, () => {
    assert.equal(isCredentialFile(tc.path), tc.blocked);
  });
}

// ============================================================================
// SECTION 3: CWE-22 Path Traversal & Project Boundary Matrix
// ============================================================================

test('Security Matrix [AtomicFs.isSafeRepoFilePath]: blocks traversal, absolute paths, Windows drives, .git internals, and symlink escapes', () => {
  const tmpDir = makeTmpDir('vicem-cwe22-');
  const outsideDir = makeTmpDir('vicem-outside-');
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP_SECRET');

    const symlinkPath = path.join(tmpDir, 'src', 'escaped_link.txt');
    try {
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), symlinkPath);
    } catch {
      // Ignore if OS restricts symlinks
    }

    const unsafeVectors = [
      null,
      undefined,
      '',
      '   ',
      '../outside.ts',
      '../../etc/passwd',
      'src/../../../etc/shadow',
      '/etc/passwd',
      '\\Windows\\System32\\drivers\\etc\\hosts',
      'C:\\Windows\\System32\\cmd.exe',
      'D:/secrets/key.pem',
      '.git',
      '.git/config',
      '.git/hooks/pre-commit',
      'sub/../../.git/HEAD',
      'file\0name.ts',
    ];

    for (const vec of unsafeVectors) {
      assert.equal(
        AtomicFs.isSafeRepoFilePath(tmpDir, vec),
        false,
        `Expected unsafe vector "${String(vec)}" to be blocked`
      );
    }

    if (fs.existsSync(symlinkPath)) {
      assert.equal(
        AtomicFs.isSafeRepoFilePath(tmpDir, 'src/escaped_link.txt'),
        false,
        'Expected symlink escaping projectRoot to be blocked'
      );
    }

    const safeVectors = [
      'src/index.ts',
      'src/components/Button.tsx',
      'README.md',
      '.cursorrules',
      '.github/copilot-instructions.md',
      '.vicem/baton.md',
    ];

    for (const vec of safeVectors) {
      assert.equal(
        AtomicFs.isSafeRepoFilePath(tmpDir, vec),
        true,
        `Expected safe repo path "${vec}" to be allowed`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('Security Matrix [matchesProjectPathBoundary]: prevents prefix collision between sibling project directories', () => {
  const projectRoot = '/Users/syslab/workspace/my-app';

  // True matches: exact match, trailing slash, subdirectory path, JSON-quoted path, file:// URI
  const positiveHaystacks = [
    '/Users/syslab/workspace/my-app',
    '/Users/syslab/workspace/my-app/',
    '/Users/syslab/workspace/my-app/src/index.ts',
    '{"cwd":"/Users/syslab/workspace/my-app"}',
    '{"folderUri":"file:///Users/syslab/workspace/my-app/pkg"}',
    'workspace_path=/Users/syslab/workspace/my-app\nstatus=ok',
  ];
  for (const h of positiveHaystacks) {
    assert.equal(
      matchesProjectPathBoundary(h, projectRoot),
      true,
      `Expected positive boundary match for: ${h}`
    );
  }

  // False matches: sibling folders with shared prefix (-v2, _backup, .old, alphanumeric continuation)
  const negativeHaystacks = [
    '/Users/syslab/workspace/my-app-v2',
    '/Users/syslab/workspace/my-app-v2/src/index.ts',
    '/Users/syslab/workspace/my-app_backup',
    '/Users/syslab/workspace/my-app.bak',
    '/Users/syslab/workspace/my-application',
    '{"cwd":"/Users/syslab/workspace/my-app-staging"}',
    '',
    null,
    undefined,
  ];
  for (const h of negativeHaystacks) {
    assert.equal(
      matchesProjectPathBoundary(h, projectRoot),
      false,
      `Expected negative boundary match for sibling path: ${h}`
    );
  }
});

// ============================================================================
// SECTION 4: 3-Pillar Safety Guards & Auto-Healing Snapshot Rollback Matrix
// ============================================================================

test('Security Matrix [SkeletonWriteGuard & SecretCommitGuard]: detects all placeholder patterns, redacted tokens, mount markers, and exempts docs', () => {
  // 1. SkeletonWriteGuard detections across code files
  const badDiffs = [
    {
      name: 'C_BLOCK_ELLIPSIS in TypeScript diff',
      diff: '+++ b/src/service.ts\n@@ -10,3 +10,3 @@\n+export function run() { /* ... */ }',
      expectedRule: 'C_BLOCK_ELLIPSIS',
    },
    {
      name: 'BRACE_ELLIPSIS with unicode ellipsis',
      diff: '+++ b/src/handler.js\n@@ -1,2 +1,2 @@\n+function handle() { … }',
      expectedRule: 'BRACE_ELLIPSIS',
    },
    {
      name: 'VERTICAL_ELLIPSIS in code block',
      diff: '+++ b/src/main.rs\n@@ -5,2 +5,2 @@\n+    ⋮',
      expectedRule: 'VERTICAL_ELLIPSIS',
    },
    {
      name: 'COMMENT_OMITTED lazy AI comment',
      diff: '+++ b/src/controller.ts\n@@ -1,2 +1,2 @@\n+  // ... rest of implementation omitted',
      expectedRule: 'COMMENT_OMITTED',
    },
    {
      name: 'PYTHON_STUB_PASS in Python file',
      diff: '+++ b/app/worker.py\n@@ -4,2 +4,2 @@\n+    pass # ...',
      expectedRule: 'PYTHON_STUB_PASS',
    },
  ];

  for (const tc of badDiffs) {
    const v = SkeletonWriteGuard.check(tc.diff);
    assert.equal(v.length, 1, `[${tc.name}] Expected 1 violation`);
    assert.equal(v[0].rule, tc.expectedRule);
  }

  // 2. Documentation files (.md, .txt, .rst, .adoc) are exempt from SkeletonWriteGuard
  const docDiff = [
    '+++ b/docs/architecture.md',
    '@@ -1,3 +1,5 @@',
    '+Here is an example of a skeletonized function:',
    '+`function demo() { /* ... */ }`',
    '+// ... rest of implementation',
  ].join('\n');
  assert.equal(SkeletonWriteGuard.check(docDiff).length, 0);

  // 3. SecretCommitGuard detects both ‹REDACTED:...› and <!-- VICEM-BATON-START -->
  const leakDiff = [
    '+++ b/src/config.ts',
    '@@ -1,2 +1,4 @@',
    '+const apiKey = "‹REDACTED:OPENAI:4a1b›";',
    '+<!-- VICEM-BATON-START -->',
    '-const old = "‹REDACTED:AWS:99ff›";', // removed lines (-) must be ignored!
  ].join('\n');
  const secViolations = SecretCommitGuard.check(leakDiff);
  assert.equal(secViolations.length, 2);
  assert.equal(secViolations[0].type, 'REDACTED_TOKEN_LEAK');
  assert.equal(secViolations[1].type, 'MOUNT_MARKER_LEAK');
});

test('Security Matrix [SafetyGuardEngine + PreHandoffSnapshotStore]: end-to-end auto-restore when AI corrupts file with skeleton placeholders', () => {
  const tmpDir = makeTmpDir('vicem-guard-restore-');
  try {
    const relFile = 'src/payment.ts';
    const fullPath = path.join(tmpDir, relFile);
    const originalCleanCode = [
      'export function chargeCard(amountCents: number): boolean {',
      '  if (amountCents <= 0) return false;',
      '  return true;',
      '}',
    ].join('\n');
    AtomicFs.writeFileAtomic(fullPath, originalCleanCode);

    // Save pre-handoff snapshot
    const snap = PreHandoffSnapshotStore.saveSnapshot(tmpDir, 'baton-snap-001', [relFile]);
    assert.equal(snap.savedFiles.length, 1);

    // Simulate AI overwriting file with lazy skeleton placeholder AND redacted token leak
    const corruptedCode = 'export function chargeCard(amountCents: number): boolean { /* ... */ }\nconst k = "‹REDACTED:STRIPE:1234›";\n';
    AtomicFs.writeFileAtomic(fullPath, corruptedCode);

    const simulatedDiff = [
      `+++ b/${relFile}`,
      '@@ -1,4 +1,2 @@',
      '+export function chargeCard(amountCents: number): boolean { /* ... */ }',
      '+const k = "‹REDACTED:STRIPE:1234›";',
    ].join('\n');

    const guardRes = SafetyGuardEngine.verifyAndProtect(tmpDir, simulatedDiff, {
      autoRestore: true,
      batonId: 'baton-snap-001',
    });

    assert.equal(guardRes.passed, false);
    assert.equal(guardRes.violations.length, 2);
    assert.deepEqual(guardRes.restoredFiles, [relFile]);

    // Verify file on disk was automatically restored to originalCleanCode!
    const diskAfterRestore = fs.readFileSync(fullPath, 'utf8');
    assert.equal(diskAfterRestore, originalCleanCode);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 5: SmartPatchApplier & WebLandAdapter All-or-Nothing Atomic Matrix
// ============================================================================

test('Security Matrix [SmartPatchApplier]: SEARCH/REPLACE, Unified Diff with shifted line offset, Unique-Symbol Splice, and Non-Unique Symbol Rejection', () => {
  // 1. SEARCH / REPLACE with CRLF normalization
  const baseFile = 'export const a = 1;\r\nexport const b = 2;\r\nexport const c = 3;\r\n';
  const srPatch = [
    '<<<<<<< SEARCH',
    'export const b = 2;',
    '=======',
    'export const b = 200;',
    '>>>>>>> REPLACE',
  ].join('\r\n');
  const srRes = SmartPatchApplier.applySmart(baseFile, srPatch, 'ts');
  assert.equal(srRes.applied, true);
  assert.equal(srRes.strategy, 'search_replace');
  assert.ok(srRes.content.includes('export const b = 200;'));

  // 2. Unified Diff with slightly shifted line numbers (+/- 3 lines)
  const existingLines = [
    '// extra header 1',
    '// extra header 2',
    'export function greet(name) {',
    '  return "Hello " + name;',
    '}',
  ].join('\n');
  const unifiedPatch = [
    '@@ -1,3 +1,3 @@',
    ' export function greet(name) {',
    '-  return "Hello " + name;',
    '+  return `Welcome, ${name}!`;',
    ' }',
  ].join('\n');
  const diffRes = SmartPatchApplier.applySmart(existingLines, unifiedPatch, 'diff');
  assert.equal(diffRes.applied, true);
  assert.equal(diffRes.strategy, 'unified_diff');
  assert.ok(diffRes.content.includes('return `Welcome, ${name}!`;'));

  // 3. Unique-Symbol Partial Function Splice preserves surrounding functions in a multi-function file
  const multiFnFile = [
    'export function alphaHelper() {',
    '  return "alpha";',
    '}',
    '',
    'export function targetCompute(x: number) {',
    '  const old = x + 1;',
    '  return old;',
    '}',
    '',
    'export function omegaHelper() {',
    '  return "omega";',
    '}',
  ].join('\n');
  const singleFnSnippet = [
    'export function targetCompute(x: number) {',
    '  const updated = x * 100;',
    '  return updated;',
    '}',
  ].join('\n');
  const spliceRes = SmartPatchApplier.applySmart(multiFnFile, singleFnSnippet, 'ts');
  assert.equal(spliceRes.applied, true);
  assert.equal(spliceRes.strategy, 'unique_symbol_splice');
  assert.equal(spliceRes.symbol, 'targetCompute');
  assert.ok(spliceRes.content.includes('export function alphaHelper()'));
  assert.ok(spliceRes.content.includes('const updated = x * 100;'));
  assert.ok(spliceRes.content.includes('export function omegaHelper()'));
});

test('Security Matrix [WebLandAdapter]: All-or-Nothing atomic rejection when 2nd block contains skeleton placeholder or secret leak', () => {
  const tmpDir = makeTmpDir('vicem-webland-atomic-');
  try {
    const fileA = path.join(tmpDir, 'src', 'a.ts');
    AtomicFs.writeFileAtomic(fileA, 'export const a = "original_a";\n');

    // Markdown response with 2 code blocks: block 1 is valid, block 2 has a lazy skeleton placeholder `{ /* ... */ }`
    const aiResponse = [
      'Here are the updates:',
      '```ts src/a.ts',
      'export const a = "modified_a";',
      '```',
      '',
      '```ts src/b.ts',
      'export function b() { /* ... */ }',
      '```',
    ].join('\n');

    const landRes = WebLandAdapter.land(tmpDir, aiResponse, { applyFiles: true });
    assert.equal(landRes.guardPassed, false);
    assert.equal(landRes.appliedFiles.length, 0);
    assert.equal(landRes.violations.length, 1);

    // Crucial: src/a.ts MUST NOT have been modified because block 2 failed guard inspection!
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'export const a = "original_a";\n');
    assert.equal(fs.existsSync(path.join(tmpDir, 'src', 'b.ts')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Security Matrix [safeJsonForHtmlScript & GitHookInstaller]: XSS script breakout prevention and non-destructive hook chaining', () => {
  // 1. XSS breakout payload in Studio JSON state
  const xssPayload = {
    goal: '</script><script>alert("xss")</script><!-- comment -->',
    lineSep: 'line1\u2028line2\u2029line3',
  };
  const serialized = safeJsonForHtmlScript(xssPayload);
  assert.ok(!serialized.includes('</script>'));
  assert.ok(!serialized.includes('<!--'));
  assert.ok(!serialized.includes('\u2028'));
  assert.ok(!serialized.includes('\u2029'));
  assert.deepEqual(JSON.parse(serialized), xssPayload);

  // 2. GitHookInstaller preserves existing Husky/user pre-commit hook and cleanly uninstalls
  const tmpDir = makeTmpDir('vicem-hooks-');
  try {
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommitPath = path.join(hooksDir, 'pre-commit');
    const existingUserHook = '#!/bin/sh\necho "Running custom linter"\n';
    fs.writeFileSync(preCommitPath, existingUserHook, { mode: 0o755 });

    const installRes = GitHookInstaller.install(tmpDir);
    assert.equal(installRes.installed, true);
    const combinedContent = fs.readFileSync(preCommitPath, 'utf8');
    assert.ok(combinedContent.includes('echo "Running custom linter"'));
    assert.ok(combinedContent.includes(GitHookInstaller.HOOK_START));

    // Installing a second time is idempotent
    GitHookInstaller.install(tmpDir);
    const secondContent = fs.readFileSync(preCommitPath, 'utf8');
    assert.equal(
      secondContent.split(GitHookInstaller.HOOK_START).length - 1,
      1,
      'Expected Vicem hook block to appear exactly once'
    );

    // Uninstalling removes only the Vicem block while preserving the user hook
    const uninstallRes = GitHookInstaller.uninstall(tmpDir);
    assert.equal(uninstallRes.uninstalled, true);
    const afterUninstall = fs.readFileSync(preCommitPath, 'utf8');
    assert.ok(afterUninstall.includes('echo "Running custom linter"'));
    assert.ok(!afterUninstall.includes(GitHookInstaller.HOOK_START));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 6: High-Entropy Assignment & Standalone Token Redaction Matrix
// ============================================================================

const HIGH_ENTROPY_ASSIGNMENT_CORPUS = [
  {
    id: 'ENT-01',
    input: 'const API_KEY = "aB3$dE6^gH9*jK2!mN5@pQ8&sT1(vW4)";',
    expectRedacted: true,
  },
  {
    id: 'ENT-02',
    input: 'auth_token: "Zy9_Xw8-Vu7+Ts6=Rq5/Po4_Nm3-Lk2+Ji1"',
    expectRedacted: true,
  },
  {
    id: 'ENT-03',
    input: 'client_secret = "9aB8cD7eF6gH5iJ4kL3mN2oP1qR0sT9uV8wX"',
    expectRedacted: true,
  },
  {
    id: 'ENT-04',
    input: 'private_key: "M1n2B3v4C5x6Z7l8K9j0H1g2F3d4S5a6P7o8"',
    expectRedacted: true,
  },
  {
    id: 'ENT-05',
    input: 'access_key="Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8"',
    expectRedacted: true,
  },
  {
    id: 'ENT-06',
    input: 'passwd = "X9y8Z7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"',
    expectRedacted: true,
  },
  {
    id: 'ENT-SAFE-01',
    input: 'const password = "passwordpasswordpasswordpassword";', // low Shannon entropy (< 4.0)
    expectRedacted: false,
  },
  {
    id: 'ENT-SAFE-02',
    input: 'const api_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";', // zero Shannon entropy
    expectRedacted: false,
  },
  {
    id: 'ENT-SAFE-03',
    input: 'const secret = "short_val";', // < 20 chars
    expectRedacted: false,
  },
];

for (const item of HIGH_ENTROPY_ASSIGNMENT_CORPUS) {
  test(`Security Matrix [High-Entropy Assignment :: ${item.id}]: expectRedacted=${item.expectRedacted}`, () => {
    const res = SecretRedactor.redact(item.input);
    if (item.expectRedacted) {
      assert.ok(res.redactedCount >= 1, `Expected redaction for ${item.id}: ${item.input}`);
      assert.ok(res.sanitized.includes('‹REDACTED:'));
    } else {
      assert.equal(res.redactedCount, 0, `Expected no redaction for ${item.id}: ${item.input}`);
      assert.equal(res.sanitized, item.input);
    }
  });
}

// ============================================================================
// SECTION 7: AtomicFs Lock Lifecycle, Git Worktree Resolution & Snapshot Pruning
// ============================================================================

test('Security Matrix [AtomicFs Lock & Worktree .git Resolution]: stale lock recovery, active PID collision, and git worktree commondir', () => {
  const tmpDir = makeTmpDir('vicem-lock-worktree-');
  try {
    // 1. Acquire and release lock cleanly
    const lockPath = AtomicFs.acquireLock(tmpDir);
    assert.ok(fs.existsSync(lockPath));
    AtomicFs.releaseLock(tmpDir);
    assert.equal(fs.existsSync(lockPath), false);

    // 2. Stale lock held by another PID (> staleMs old) is automatically overwritten
    AtomicFs.ensureVicemDir(tmpDir);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, timestamp: Date.now() - 60 * 60 * 1000 }),
      'utf8'
    );
    const recoveredLock = AtomicFs.acquireLock(tmpDir, 1000);
    assert.ok(fs.existsSync(recoveredLock));
    AtomicFs.releaseLock(tmpDir);

    // 3. Git worktree `.git` pointer file (`gitdir: ...`) + `commondir` resolution
    const mainGitCommon = path.join(tmpDir, 'main-repo-git');
    const worktreeGitDir = path.join(mainGitCommon, 'worktrees', 'feature-wt');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(path.join(mainGitCommon, 'info'), { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');

    const worktreeWorkspace = path.join(tmpDir, 'wt-workspace');
    fs.mkdirSync(worktreeWorkspace, { recursive: true });
    fs.writeFileSync(path.join(worktreeWorkspace, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');

    const resolvedGit = AtomicFs.resolveGitDir(worktreeWorkspace);
    assert.equal(resolvedGit, worktreeGitDir);

    const hooksDir = GitHookInstaller.resolveHooksDir(worktreeWorkspace);
    assert.equal(hooksDir, path.join(mainGitCommon, 'hooks'));

    const hookInstall = GitHookInstaller.install(worktreeWorkspace);
    assert.equal(hookInstall.installed, true);
    assert.equal(GitHookInstaller.isInstalled(worktreeWorkspace), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Security Matrix [PreHandoffSnapshotStore Pruning]: keeps only latest N snapshots and skips credentials & oversized files', () => {
  const tmpDir = makeTmpDir('vicem-snap-prune-');
  try {
    AtomicFs.writeFileAtomic(path.join(tmpDir, 'src', 'app.ts'), 'export const v = 1;\n');
    AtomicFs.writeFileAtomic(path.join(tmpDir, '.env'), 'SECRET=123\n');

    // Create 8 sequential snapshots
    for (let i = 1; i <= 8; i++) {
      const id = `snap-${String(i).padStart(2, '0')}`;
      const res = PreHandoffSnapshotStore.saveSnapshot(tmpDir, id, ['src/app.ts', '.env', '../escape.ts']);
      // Only src/app.ts should be saved (.env and ../escape.ts are blocked)
      assert.deepEqual(res.savedFiles, ['src/app.ts']);
    }

    PreHandoffSnapshotStore.pruneOldSnapshots(tmpDir, 5);
    const remainingDirs = fs.readdirSync(path.join(tmpDir, '.vicem', 'snapshots'));
    assert.equal(remainingDirs.length, 5);
    assert.equal(PreHandoffSnapshotStore.getLatestSnapshotId(tmpDir), 'snap-08');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 8: Parameterized SmartPatchApplier & WebLandAdapter Edge-Case Corpus
// ============================================================================

const PATCH_STRATEGY_CORPUS = [
  {
    id: 'PATCH-01',
    desc: 'Multiple SEARCH/REPLACE blocks in a single patch',
    existing: [
      'export const host = "localhost";',
      'export const port = 3000;',
      'export const tls = false;',
    ].join('\n'),
    patch: [
      '<<<<<<< SEARCH',
      'export const host = "localhost";',
      '=======',
      'export const host = "0.0.0.0";',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'export const tls = false;',
      '=======',
      'export const tls = true;',
      '>>>>>>> REPLACE',
    ].join('\n'),
    lang: 'ts',
    expectedStrategy: 'search_replace',
    mustContain: ['export const host = "0.0.0.0";', 'export const port = 3000;', 'export const tls = true;'],
  },
  {
    id: 'PATCH-02',
    desc: 'SEARCH/REPLACE fails gracefully when target block does not exist',
    existing: 'export const version = 1;\n',
    patch: [
      '<<<<<<< SEARCH',
      'export const nonExistent = 999;',
      '=======',
      'export const nonExistent = 1000;',
      '>>>>>>> REPLACE',
    ].join('\n'),
    lang: 'ts',
    expectedStrategy: 'search_replace_failed',
    expectApplied: false,
    mustContain: ['export const version = 1;'],
  },
  {
    id: 'PATCH-03',
    desc: 'Unified diff with multiple hunks across a file',
    existing: [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
    ].join('\n'),
    patch: [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line 2 updated',
      ' line 3',
      '@@ -6,3 +6,3 @@',
      ' line 6',
      '-line 7',
      '+line 7 updated',
      ' line 8',
    ].join('\n'),
    lang: 'diff',
    expectedStrategy: 'unified_diff',
    mustContain: ['line 2 updated', 'line 7 updated'],
  },
  {
    id: 'PATCH-04',
    desc: 'Unified diff fails gracefully when context lines do not match',
    existing: 'alpha\nbeta\ngamma\n',
    patch: [
      '@@ -1,3 +1,3 @@',
      ' completely_different_1',
      '-completely_different_2',
      '+replacement',
      ' completely_different_3',
    ].join('\n'),
    lang: 'diff',
    expectedStrategy: 'unified_diff_failed',
    expectApplied: false,
    mustContain: ['alpha'],
  },
  {
    id: 'PATCH-05',
    desc: 'Non-unique symbol in existing file falls back to full_write instead of ambiguous splice',
    existing: [
      '// Duplicate helper declarations in separate namespaces/scopes',
      'function renderItem() {',
      '  return 1;',
      '}',
      '// padding line 1',
      '// padding line 2',
      '// padding line 3',
      '// padding line 4',
      'function renderItem() {',
      '  return 2;',
      '}',
    ].join('\n'),
    patch: 'function renderItem() {\n  return 3;\n}',
    lang: 'js',
    expectedStrategy: 'full_write',
    mustContain: ['return 3;'],
  },
];

for (const tc of PATCH_STRATEGY_CORPUS) {
  test(`Security Matrix [SmartPatchApplier :: ${tc.id}] (${tc.desc})`, () => {
    const res = SmartPatchApplier.applySmart(tc.existing, tc.patch, tc.lang);
    const expectedApplied = tc.expectApplied ?? true;
    assert.equal(res.applied, expectedApplied);
    assert.equal(res.strategy, tc.expectedStrategy);
    for (const sub of tc.mustContain) {
      assert.ok(res.content.includes(sub), `Expected "${sub}" in:\n${res.content}`);
    }
  });
}

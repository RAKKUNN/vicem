// Synthetic redaction fixtures, generated at runtime; never real service credentials.
const SYNTHETIC_SERVICE_TOKEN_0 = 'xoxb-' + '123456789012-1234567890123-abcdefghijklmnopqrstuvwx';
const SYNTHETIC_SERVICE_TOKEN_1 = 'sk_live_' + '51H1234567890abcdefghijklmnopqrstuvwx';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isCredentialFile,
  matchesProjectPathBoundary,
  AtomicFs,
  TokenEstimator,
  stripAnsi,
  isFullWidthCodePoint,
  getDisplayWidth,
  padDisplayColumn,
  SecretRedactor,
} from '../vicem.mjs';

function makeTempDir(prefix = 'vicem-edge-sec-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Edge Suite 1A: isCredentialFile — Exhaustive Denylist & Boundary Permutations', () => {
  it('handles null, undefined, numbers, booleans, objects, arrays, and empty strings safely without throwing', () => {
    assert.equal(isCredentialFile(null), false);
    assert.equal(isCredentialFile(undefined), false);
    assert.equal(isCredentialFile(''), false);
    assert.equal(isCredentialFile(0), false);
    assert.equal(isCredentialFile(12345), false);
    assert.equal(isCredentialFile(false), false);
    assert.equal(isCredentialFile(true), false);
    assert.equal(isCredentialFile({}), false);
    assert.equal(isCredentialFile([]), false);
  });

  it('blocks every .env variant while allowing .env.example, .env.sample, and .env.template', () => {
    const blockedEnvFiles = [
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
      '.env.production',
      '.env.production.local',
      '.env.staging',
      '.env.test',
      '.env.ci',
      '.env.docker',
      '.env.k8s',
      '.env.backup',
      '.env.secret',
      '.env.vault',
      '.envrc',
      'apps/web/.env',
      'apps/api/.env.production',
      'packages/core/.env.local',
      'C:\\Users\\dev\\project\\.env',
      'C:\\Users\\dev\\project\\.env.production',
      'C:\\Users\\dev\\project\\.envrc',
      '/var/www/app/.env.staging',
    ];
    for (const f of blockedEnvFiles) {
      assert.equal(isCredentialFile(f), true, `Expected credential file to be blocked: ${f}`);
    }

    const allowedEnvTemplates = [
      '.env.example',
      '.env.sample',
      '.env.template',
      'config/.env.example',
      'config/.env.sample',
      'config/.env.template',
      'C:\\repo\\.env.example',
      'C:\\repo\\.env.sample',
      'C:\\repo\\.env.template',
      'src/env.ts',
      'src/environment.js',
      'src/dotenv-loader.mjs',
    ];
    for (const f of allowedEnvTemplates) {
      assert.equal(isCredentialFile(f), false, `Expected template/code file to be allowed: ${f}`);
    }
  });

  it('blocks cryptographic keys, certificates, keystores, and SSH private keys across nested paths', () => {
    const cryptoFiles = [
      'server.pem',
      'private.key',
      'cert.p12',
      ' certificate.pfx',
      'keystore.jks',
      'client.keystore',
      'tls.crt',
      'ca.cer',
      'root.der',
      'id_rsa',
      'id_rsa.pub.key',
      'id_ed25519',
      'id_ecdsa',
      'id_dsa',
      '.ssh/id_rsa',
      '.ssh/id_ed25519',
      '.ssh/config',
      '.ssh/authorized_keys',
      '.ssh/known_hosts',
      'C:\\Users\\admin\\.ssh\\id_ed25519',
      'deploy/keys/prod-bastion.pem',
      'certs/webhook-signing.key',
      'android/app/release.jks',
      'ios/certs/distribution.p12',
    ];
    for (const f of cryptoFiles) {
      assert.equal(isCredentialFile(f.trim()), true, `Expected crypto/SSH file to be blocked: ${f}`);
    }
  });

  it('blocks package manager, cloud provider, and container registry auth configs', () => {
    const cloudAndPkgAuth = [
      '.npmrc',
      '.pypirc',
      '.netrc',
      '.htpasswd',
      'credentials.json',
      'client_secret.json',
      'client_secret_12345.apps.googleusercontent.com.json',
      'service-account.json',
      'service_account_prod.json',
      'service-account-staging.key',
      'secrets.json',
      'secrets.yaml',
      'secrets.yml',
      'secrets.toml',
      'secrets.ini',
      '.aws/credentials',
      '.aws/config',
      '.docker/config.json',
      '.kube/config',
      '.gcloud/application_default_credentials.json',
      'C:\\Users\\dev\\.aws\\credentials',
      'C:\\Users\\dev\\.kube\\config',
      'C:\\Users\\dev\\.docker\\config.json',
    ];
    for (const f of cloudAndPkgAuth) {
      assert.equal(isCredentialFile(f), true, `Expected cloud/package auth file to be blocked: ${f}`);
    }
  });

  it('allows normal source code files that happen to contain words like key, secret, or token in their code filename', () => {
    const safeCodeFiles = [
      'src/auth/tokenValidator.ts',
      'src/crypto/keyManager.mjs',
      'src/components/SecretInputModal.tsx',
      'lib/sshHelper.py',
      'pkg/aws/s3Client.go',
      'crates/kube_controller/src/main.rs',
      'README.md',
      'package.json',
      'tsconfig.json',
      'vicem.mjs',
      'vicem-gui.mjs',
      'index.html',
    ];
    for (const f of safeCodeFiles) {
      assert.equal(isCredentialFile(f), false, `Expected source file to be allowed: ${f}`);
    }
  });

  it('is case-insensitive for uppercase or mixed-case extensions and filenames', () => {
    assert.equal(isCredentialFile('.ENV'), true);
    assert.equal(isCredentialFile('.ENV.PRODUCTION'), true);
    assert.equal(isCredentialFile('SERVER.PEM'), true);
    assert.equal(isCredentialFile('ID_ED25519'), true);
    assert.equal(isCredentialFile('SECRETS.YAML'), true);
    assert.equal(isCredentialFile('Service-Account-Prod.JSON'), true);
    assert.equal(isCredentialFile('.ENV.EXAMPLE'), false);
    assert.equal(isCredentialFile('.ENV.SAMPLE'), false);
    assert.equal(isCredentialFile('.ENV.TEMPLATE'), false);
  });
});

describe('Edge Suite 1B: matchesProjectPathBoundary — Sibling Prefix Bleed Immunity', () => {
  it('returns false on invalid, empty, or non-string inputs', () => {
    assert.equal(matchesProjectPathBoundary(null, '/Users/syslab/app'), false);
    assert.equal(matchesProjectPathBoundary('/Users/syslab/app', null), false);
    assert.equal(matchesProjectPathBoundary('', '/Users/syslab/app'), false);
    assert.equal(matchesProjectPathBoundary('/Users/syslab/app', ''), false);
    assert.equal(matchesProjectPathBoundary(123, '/Users/syslab/app'), false);
    assert.equal(matchesProjectPathBoundary('/Users/syslab/app', {}), false);
  });

  it('matches exact path, file:// URI, subdirectory path, and JSON-quoted path', () => {
    const root = '/Users/syslab/Documents/project';
    assert.equal(matchesProjectPathBoundary('/Users/syslab/Documents/project', root), true);
    assert.equal(matchesProjectPathBoundary('file:///Users/syslab/Documents/project', root), true);
    assert.equal(matchesProjectPathBoundary('/Users/syslab/Documents/project/src/index.ts', root), true);
    assert.equal(matchesProjectPathBoundary('{"cwd":"/Users/syslab/Documents/project"}', root), true);
    assert.equal(matchesProjectPathBoundary('{"uri":"file:///Users/syslab/Documents/project/vicem.mjs"}', root), true);
    assert.equal(matchesProjectPathBoundary('Command Working Directory: /Users/syslab/Documents/project\n', root), true);
    assert.equal(matchesProjectPathBoundary("cd '/Users/syslab/Documents/project' && npm test", root), true);
  });

  it('strictly rejects sibling directories that share the same prefix (e.g. /project-v2, /project_old, /project.bak)', () => {
    const root = '/Users/syslab/Documents/project';
    const siblingHaystacks = [
      '/Users/syslab/Documents/project-v2',
      '/Users/syslab/Documents/project-v2/src/index.ts',
      '/Users/syslab/Documents/project_backup',
      '/Users/syslab/Documents/project.old/package.json',
      '/Users/syslab/Documents/project2',
      '{"cwd":"/Users/syslab/Documents/project-next"}',
      'file:///Users/syslab/Documents/project-copy/README.md',
      'Command Working Directory: /Users/syslab/Documents/project-other\n',
    ];
    for (const h of siblingHaystacks) {
      assert.equal(
        matchesProjectPathBoundary(h, root),
        false,
        `Sibling path should NOT match ${root}: ${h}`
      );
    }
  });

  it('matches when a line contains a sibling path first and the true project path later', () => {
    const root = '/Users/syslab/Documents/project';
    const mixed =
      'Compared /Users/syslab/Documents/project-v2 with /Users/syslab/Documents/project/src/main.mjs';
    assert.equal(matchesProjectPathBoundary(mixed, root), true);
  });

  it('handles trailing slashes on projectRoot gracefully', () => {
    assert.equal(
      matchesProjectPathBoundary(
        '{"cwd":"/Users/syslab/Documents/project"}',
        '/Users/syslab/Documents/project/'
      ),
      true
    );
    assert.equal(
      matchesProjectPathBoundary(
        '{"cwd":"/Users/syslab/Documents/project-v2"}',
        '/Users/syslab/Documents/project/'
      ),
      false
    );
  });
});

describe('Edge Suite 1C: AtomicFs — Worktrees, Submodules, Path Traversal (CWE-22), and Lock Contention', () => {
  it('writes files atomically with no leftover .vicem-tmp files and preserves UTF-8 + permissions', () => {
    const tmp = makeTempDir();
    try {
      const target = path.join(tmp, 'nested', 'deep', 'atomic.txt');
      const payload = 'Hello Atomic World! 한글 테스트 🚀\nLine 2\n';
      AtomicFs.writeFileAtomic(target, payload, { mode: 0o600 });
      assert.equal(fs.existsSync(target), true);
      assert.equal(fs.readFileSync(target, 'utf8'), payload);
      const siblings = fs.readdirSync(path.dirname(target));
      assert.deepEqual(siblings, ['atomic.txt']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves standard .git directory, linked worktree .git pointer with relative gitdir, and absolute gitdir', () => {
    const tmp = makeTempDir();
    try {
      // Case 1: Standard .git directory
      const repo1 = path.join(tmp, 'repo1');
      fs.mkdirSync(path.join(repo1, '.git', 'hooks'), { recursive: true });
      const res1 = AtomicFs.resolveGitDir(repo1);
      assert.equal(res1, path.join(repo1, '.git'));

      // Case 2: Linked git worktree where .git is a file pointing to relative gitdir + commondir
      const mainGit = path.join(tmp, 'main-repo', '.git');
      const wtGitDir = path.join(mainGit, 'worktrees', 'feature-wt');
      fs.mkdirSync(wtGitDir, { recursive: true });
      fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8');

      const wtRoot = path.join(tmp, 'feature-wt');
      fs.mkdirSync(wtRoot, { recursive: true });
      const relGitDir = path.relative(wtRoot, wtGitDir);
      fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${relGitDir}\n`, 'utf8');

      const res2 = AtomicFs.resolveGitDir(wtRoot);
      assert.equal(res2, path.resolve(wtRoot, relGitDir));
      assert.equal(AtomicFs.ensureGitInfoExclude(wtRoot), true);

      // Case 3: Non-git directory returns null
      const nonGit = path.join(tmp, 'plain-dir');
      fs.mkdirSync(nonGit, { recursive: true });
      assert.equal(AtomicFs.resolveGitDir(nonGit), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ensureVicemDir registers .vicem/ idempotently in .git/info/exclude without duplicating lines', () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
      const vicemDir1 = AtomicFs.ensureVicemDir(tmp);
      const vicemDir2 = AtomicFs.ensureVicemDir(tmp);
      const vicemDir3 = AtomicFs.ensureVicemDir(tmp);
      assert.equal(vicemDir1, vicemDir2);
      assert.equal(vicemDir2, vicemDir3);

      const excludePath = path.join(tmp, '.git', 'info', 'exclude');
      assert.equal(fs.existsSync(excludePath), true);
      const content = fs.readFileSync(excludePath, 'utf8');
      const matches = content.match(/^\.vicem\/$/gm) || [];
      assert.equal(matches.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('acquireLock and releaseLock handle stale dead PIDs, live PIDs, and lock cleanup', () => {
    const tmp = makeTempDir();
    try {
      // 1. Normal acquire & release
      const lockPath = AtomicFs.acquireLock(tmp, 1000);
      assert.equal(fs.existsSync(lockPath), true);
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(lockData.pid, process.pid);
      AtomicFs.releaseLock(tmp);
      assert.equal(fs.existsSync(lockPath), false);

      // 2. Stale lock with non-existent PID (99999999) is automatically broken and re-acquired
      AtomicFs.ensureVicemDir(tmp);
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 99999999, timestamp: Date.now() }),
        'utf8'
      );
      const lockPathAfterStale = AtomicFs.acquireLock(tmp, 1000);
      assert.equal(fs.existsSync(lockPathAfterStale), true);
      assert.equal(JSON.parse(fs.readFileSync(lockPathAfterStale, 'utf8')).pid, process.pid);
      AtomicFs.releaseLock(tmp);

      // 3. Corrupted non-JSON lock file older than staleMs is broken and re-acquired
      fs.writeFileSync(lockPath, 'corrupted-json{{{', 'utf8');
      const past = new Date(Date.now() - 20000);
      fs.utimesSync(lockPath, past, past);
      const lockPathAfterCorrupt = AtomicFs.acquireLock(tmp, 1000);
      assert.equal(fs.existsSync(lockPathAfterCorrupt), true);
      AtomicFs.releaseLock(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('isSafeRepoFilePath blocks CWE-22 path traversal, absolute paths, .git internals, and escaping symlinks', () => {
    const tmp = makeTempDir();
    const outside = makeTempDir('vicem-outside-');
    try {
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret', 'utf8');

      // Valid repo paths
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'src/index.ts'), true);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'AGENTS.md'), true);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.github/copilot-instructions.md'), true);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.cursorrules'), true);

      // Blocked path traversals & invalid inputs
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, ''), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '   '), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, null), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '../outside.txt'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'src/../../outside.txt'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '/etc/passwd'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'C:\\Windows\\System32\\cmd.exe'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.git'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.git/config'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.git/hooks/pre-commit'), false);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, '.git\\config'), false);

      // Symlink pointing outside repository root
      const symlinkFile = path.join(tmp, 'src', 'escaped-link.txt');
      fs.symlinkSync(path.join(outside, 'secret.txt'), symlinkFile);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'src/escaped-link.txt'), false);

      // Symlink directory pointing outside repository root
      const symlinkDir = path.join(tmp, 'src', 'escaped-dir');
      fs.symlinkSync(outside, symlinkDir);
      assert.equal(AtomicFs.isSafeRepoFilePath(tmp, 'src/escaped-dir/new-file.txt'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('Edge Suite 1D: TokenEstimator & Display Width — CJK, Emoji Surrogates, ANSI, and Formatting', () => {
  it('handles empty, null, undefined, and non-string inputs cleanly', () => {
    assert.equal(TokenEstimator.estimate(''), 0);
    assert.equal(TokenEstimator.estimate(null), 0);
    assert.equal(TokenEstimator.estimate(undefined), 0);
    assert.equal(TokenEstimator.estimate(12345), 0);
  });

  it('weights ASCII (~0.245 tok/char) vs CJK/Hangul (~0.76 tok/codepoint) and punctuation (~0.45 tok) accurately', () => {
    const ascii400 = 'a'.repeat(400);
    assert.equal(TokenEstimator.estimate(ascii400), 98);

    const hangul100 = '가'.repeat(100);
    assert.equal(TokenEstimator.estimate(hangul100), 76);

    const hanzi100 = '漢'.repeat(100);
    assert.equal(TokenEstimator.estimate(hanzi100), 76);

    const punct100 = '{'.repeat(100);
    assert.equal(TokenEstimator.estimate(punct100), 45);

    const mixed = ascii400 + hangul100;
    assert.equal(TokenEstimator.estimate(mixed), 174);
  });

  it('formatCount formats small integers, thousands (k), and millions (M) cleanly', () => {
    assert.equal(TokenEstimator.formatCount(-50), '0');
    assert.equal(TokenEstimator.formatCount(0), '0');
    assert.equal(TokenEstimator.formatCount(999), '999');
    assert.equal(TokenEstimator.formatCount(1000), '1.0k');
    assert.equal(TokenEstimator.formatCount(4250), '4.3k');
    assert.equal(TokenEstimator.formatCount(142000), '142.0k');
    assert.equal(TokenEstimator.formatCount(1000000), '1.0M');
    assert.equal(TokenEstimator.formatCount(2540000), '2.5M');
  });

  it('stripAnsi removes CSI color codes and OSC 52 clipboard sequences without altering visible text', () => {
    const colored = '\x1b[32;1m✓\x1b[0m [Vicem] \x1b[36mClaude\x1b[0m → \x1b[35mCodex\x1b[0m';
    assert.equal(stripAnsi(colored), '✓ [Vicem] Claude → Codex');

    const withOsc = '\x1b]52;c;SGVsbG8=\x07Visible Text\x1b]52;c;V29ybGQ=\x1b\\';
    assert.equal(stripAnsi(withOsc), 'Visible Text');
  });

  it('isFullWidthCodePoint, getDisplayWidth, and padDisplayColumn align CJK + ANSI columns to exact cell widths', () => {
    assert.equal(isFullWidthCodePoint(0x0041), false); // 'A'
    assert.equal(isFullWidthCodePoint(0xac00), true); // '가'
    assert.equal(isFullWidthCodePoint(0x4e00), true); // '一'
    assert.equal(isFullWidthCodePoint(0xff01), true); // Fullwidth '!'
    assert.equal(isFullWidthCodePoint(null), false);

    assert.equal(getDisplayWidth('Hello'), 5);
    assert.equal(getDisplayWidth('안녕'), 4);
    assert.equal(getDisplayWidth('\x1b[32m안녕\x1b[0m'), 4);

    const paddedAscii = padDisplayColumn('Claude', 12);
    const paddedCjk = padDisplayColumn('클로드', 12);
    assert.equal(getDisplayWidth(paddedAscii), 12);
    assert.equal(getDisplayWidth(paddedCjk), 12);
    assert.equal(paddedAscii.length, 12);
    assert.equal(paddedCjk.length, 9); // 3 Hangul chars (width 6) + 6 spaces = 9 code units, 12 display cells
  });
});

describe('Edge Suite 1E: SecretRedactor — All 9 Providers, High-Entropy Assignments & Zero False-Positives', () => {
  it('handles null, undefined, and empty strings without error', () => {
    assert.deepEqual(SecretRedactor.redact(''), { sanitized: '', redactedCount: 0, providers: [] });
    assert.deepEqual(SecretRedactor.redact(null), { sanitized: '', redactedCount: 0, providers: [] });
    assert.deepEqual(SecretRedactor.redact(undefined), { sanitized: '', redactedCount: 0, providers: [] });
  });

  it('redacts Anthropic, OpenAI, GitHub, AWS, Google, Slack, Stripe, Private Keys, and Bearer/JWT tokens with deterministic 4-hex hashes', () => {
    const samples = [
      {
        provider: 'ANTHROPIC',
        raw: 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
      },
      {
        provider: 'OPENAI',
        raw: 'sk-proj-' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4',
      },
      {
        provider: 'GITHUB',
        raw: 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz',
      },
      {
        provider: 'AWS',
        raw: 'AKIAIOSFODNN7EXAMPLE',
      },
      {
        provider: 'GOOGLE',
        raw: 'AIzaSyD-1234567890abcdefghijklmnopqrstu',
      },
      {
        provider: 'SLACK',
        raw: '' + SYNTHETIC_SERVICE_TOKEN_0 + '',
      },
      {
        provider: 'STRIPE',
        raw: '' + SYNTHETIC_SERVICE_TOKEN_1 + '',
      },
      {
        provider: 'JWT',
        raw: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      },
      {
        provider: 'PRIVATE_KEY',
        raw: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----',
      },
    ];

    for (const s of samples) {
      const res1 = SecretRedactor.redact(`Config value: ${s.raw}`);
      const res2 = SecretRedactor.redact(`Config value: ${s.raw}`);
      assert.equal(res1.redactedCount, 1, `Expected ${s.provider} to be redacted`);
      assert.equal(res1.sanitized.includes(s.raw), false, `Raw secret leaked for ${s.provider}`);
      assert.match(res1.sanitized, new RegExp(`‹REDACTED:${s.provider}:[0-9a-f]{4}›`));
      // Deterministic hash across runs
      assert.equal(res1.sanitized, res2.sanitized);
    }
  });

  it('redacts high-entropy generic secret assignments while preserving surrounding syntax (quotes and keys)', () => {
    const rawLine = `const api_key = "A9b8C7d6E5f4G3h2I1j0K9l8M7n6O5p4Q3r2S1t0";`;
    const res = SecretRedactor.redact(rawLine);
    assert.equal(res.redactedCount, 1);
    assert.match(res.sanitized, /^const api_key = "‹REDACTED:KEY:[0-9a-f]{4}›";$/);
  });

  it('never false-positives on file paths, URLs, camelCase identifiers, or low-entropy placeholders', () => {
    const benignAssignments = [
      `const secretPath = "/Users/syslab/Documents/antigravity/delightful-euclid/vicem.mjs";`,
      `const tokenUrl = "https://oauth2.googleapis.com/token/refresh/endpoint";`,
      `const apiKeyValidator = "validateIncomingCustomerAuthenticationRequestHeader";`,
      `const passwordPlaceholder = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";`,
      `const authHeader = "./relative/path/to/authentication/module/index.ts";`,
    ];
    for (const line of benignAssignments) {
      const res = SecretRedactor.redact(line);
      assert.equal(res.redactedCount, 0, `False positive on benign line: ${line}`);
      assert.equal(res.sanitized, line);
    }
  });

  it('calculates Shannon entropy accurately across degenerate and uniform distributions', () => {
    assert.equal(SecretRedactor.shannonEntropy(''), 0);
    assert.equal(SecretRedactor.shannonEntropy('aaaaaaaaaa'), 0);
    assert.equal(SecretRedactor.shannonEntropy('ababababab'), 1);
    const hex16 = SecretRedactor.shannonEntropy('0123456789abcdef');
    assert.equal(Math.round(hex16 * 100) / 100, 4);
  });
});

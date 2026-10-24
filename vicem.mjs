#!/usr/bin/env node
/**
 * Vicem — Diet the Context, Pass the Baton
 * Version: 5.3.0 (Zero-Dependency · Zero-Network · Minimal TCB)
 *
 * Pure Node.js built-in modules only. No external npm packages. No network calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import readline from 'node:readline';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

// Suppress ExperimentalWarning (e.g. node:sqlite) from polluting stdout/stderr
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const msg = typeof warning === 'string' ? warning : warning?.message || '';
  if (type === 'ExperimentalWarning' || msg.includes('SQLite is an experimental feature')) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};

// ============================================================================
// PHASE 1: FOUNDATION, CALIBRATED TOKEN ESTIMATOR & SECRET REDACTOR
// ============================================================================

/**
 * Hardcoded blacklist of credential/secret files that Vicem must NEVER read or harvest.
 * (SRS §6.1 Zero-Secret-Access & SAD §6 Credential Blindness)
 */
export const CREDENTIAL_BLACKLIST_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^auth\.json$/i,
  /^\.?credentials\.json$/i,
  /^oauth[_-]?.*\.(?:json|txt|key)$/i,
  /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
  /^\.(?:npmrc|pypirc|netrc|docker)$/i,
  /\.(?:pem|key|p12|pfx|keystore)$/i,
  /^token[s]?\.(?:json|txt)$/i,
];

export function isCredentialFile(filePath) {
  const base = path.basename(filePath);
  if (CREDENTIAL_BLACKLIST_PATTERNS.some((re) => re.test(base))) {
    return true;
  }
  const normalized = filePath.replace(/\\/g, '/');
  if (/(?:^|\/)\.(?:ssh|aws|gnupg)\//i.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Task 1.1: Atomic FileSystem & Git-Clean Local Exclude Protector
 */
export class AtomicFs {
  static ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Ensures .vicem directory structure exists and registers ephemeral patterns in .git/info/exclude
   * so the repository's tracked .gitignore is never dirtied (SRS C-07 / SAD §5).
   */
  static ensureVicemDir(projectRoot) {
    const vicemDir = path.join(projectRoot, '.vicem');
    AtomicFs.ensureDir(vicemDir);
    AtomicFs.ensureDir(path.join(vicemDir, 'raw'));
    AtomicFs.ensureDir(path.join(vicemDir, 'snapshots'));
    AtomicFs.ensureGitInfoExclude(projectRoot);
    return vicemDir;
  }

  static isSafeRepoFilePath(projectRoot, targetPath) {
    if (!projectRoot || !targetPath) return false;
    const root = path.resolve(projectRoot);
    const dest = path.resolve(root, targetPath);
    const rel = path.relative(root, dest);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const norm = rel.replace(/\\/g, '/');
    if (norm === '.git' || norm.startsWith('.git/')) return false;
    return true;
  }

  static resolveGitDir(projectRoot) {
    const dotGit = path.join(projectRoot, '.git');
    if (!fs.existsSync(dotGit)) return null;
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        const text = fs.readFileSync(dotGit, 'utf8').trim();
        const m = text.match(/^gitdir:\s*(.+)$/i);
        if (m) {
          const gitDir = path.resolve(projectRoot, m[1].trim());
          if (fs.existsSync(gitDir)) return gitDir;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  static ensureGitInfoExclude(projectRoot) {
    const gitDir = AtomicFs.resolveGitDir(projectRoot);
    if (!gitDir) {
      return false;
    }
    let gitInfoDir = path.join(gitDir, 'info');
    if (!fs.existsSync(gitInfoDir)) {
      const commondirFile = path.join(gitDir, 'commondir');
      if (fs.existsSync(commondirFile)) {
        try {
          const commonRel = fs.readFileSync(commondirFile, 'utf8').trim();
          gitInfoDir = path.join(path.resolve(gitDir, commonRel), 'info');
        } catch {
          // Fall through
        }
      }
      AtomicFs.ensureDir(gitInfoDir);
    }
    const excludePath = path.join(gitInfoDir, 'exclude');
    let existing = '';
    if (fs.existsSync(excludePath)) {
      try {
        existing = fs.readFileSync(excludePath, 'utf8');
      } catch {
        return false;
      }
    }
    const entriesToEnsure = [
      '.vicem/',
      'CLAUDE.local.md',
      '.cursor/rules/_vicem_baton.mdc',
    ];
    const lines = existing.split(/\r?\n/);
    const missing = entriesToEnsure.filter((entry) => !lines.includes(entry));
    if (missing.length > 0) {
      const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      const addition = `${prefix}# Vicem ephemeral context files (auto-managed)\n${missing.join('\n')}\n`;
      AtomicFs.writeFileAtomic(excludePath, existing + addition);
    }
    return true;
  }

  /**
   * Writes content to a temporary sibling file then atomically renames it over targetPath (SRS §6.3).
   */
  static writeFileAtomic(targetPath, content) {
    const dir = path.dirname(targetPath);
    AtomicFs.ensureDir(dir);
    const rand = crypto.randomBytes(6).toString('hex');
    const tempPath = path.join(dir, `.${path.basename(targetPath)}.tmp.${process.pid}.${rand}`);
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, targetPath);
  }

  /**
   * Acquires a process lock in .vicem/lock to prevent concurrent CLI collisions (UC-01).
   */
  static acquireLock(projectRoot, staleMs = 10 * 60 * 1000) {
    const vicemDir = AtomicFs.ensureVicemDir(projectRoot);
    const lockPath = path.join(vicemDir, 'lock');
    if (fs.existsSync(lockPath)) {
      try {
        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const age = Date.now() - (lockData.timestamp || 0);
        let processAlive = false;
        if (lockData.pid && lockData.pid !== process.pid) {
          try {
            process.kill(lockData.pid, 0);
            processAlive = true;
          } catch {
            processAlive = false;
          }
        }
        if (processAlive && age < staleMs) {
          throw new Error(`Vicem lock held by active PID ${lockData.pid}`);
        }
      } catch (err) {
        if (err.message.startsWith('Vicem lock held')) throw err;
      }
    }
    AtomicFs.writeFileAtomic(
      lockPath,
      JSON.stringify({ pid: process.pid, timestamp: Date.now() }, null, 2)
    );
    return lockPath;
  }

  static releaseLock(projectRoot) {
    const lockPath = path.join(projectRoot, '.vicem', 'lock');
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Ignore if already removed
      }
    }
  }
}

/**
 * Task 1.2: Calibrated Token Estimator (SRS C-05) & CJK Display Width Calculator (SRS UX-06)
 * Verified 10.9% Mean Absolute Error against o200k_base / cl100k_base blend [V-RUN].
 */
export class TokenEstimator {
  static estimate(text) {
    if (!text || typeof text !== 'string' || text.length === 0) {
      return 0;
    }
    const koreanMatches = text.match(/[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f\u3000-\u9fff\uf900-\ufaff]/g);
    const punctMatches = text.match(/[{}[\],:;"'()=><_./\\-]/g);
    const lineMatches = text.match(/\n/g);

    const korean = koreanMatches ? koreanMatches.length : 0;
    const punct = punctMatches ? punctMatches.length : 0;
    const lines = lineMatches ? lineMatches.length : 0;
    const other = Math.max(0, text.length - korean - punct);

    const tokens = (other * 0.245) + (punct * 0.45) + (korean * 0.76) + (lines * 0.15);
    return Math.max(1, Math.round(tokens));
  }

  static formatCount(tokens) {
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return `${tokens}`;
  }
}

/**
 * CJK / Full-width aware terminal display width calculator (SRS UX-06).
 */
export function stripAnsi(str) {
  if (!str) return '';
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export function isFullWidthCodePoint(code) {
  if (Number.isNaN(code)) return false;
  return (
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK Radicals..Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)) // Emojis
  );
}

export function getDisplayWidth(str) {
  const clean = stripAnsi(String(str ?? ''));
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue;
    }
    width += isFullWidthCodePoint(code) ? 2 : 1;
  }
  return width;
}

export function padDisplayColumn(str, targetWidth) {
  const currentWidth = getDisplayWidth(str);
  if (currentWidth >= targetWidth) return String(str);
  return String(str) + ' '.repeat(targetWidth - currentWidth);
}

/**
 * Task 1.3: Multi-Provider Secret Redactor (SRS C-06 / UC-15)
 * Always executed as the final stage before sealing any baton.
 * Never stores reversible keys (No-Unredaction Principle).
 */
export class SecretRedactor {
  static RULES = [
    {
      provider: 'PRIVATE_KEY',
      regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    },
    {
      provider: 'AWS',
      regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
      provider: 'GITHUB',
      regex: /\b(?:ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|ghu_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})\b/g,
    },
    {
      provider: 'ANTHROPIC',
      regex: /\bsk-ant-[a-zA-Z0-9\-_]{20,}\b/g,
    },
    {
      provider: 'OPENAI',
      regex: /\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9\-_]{20,}\b/g,
    },
    {
      provider: 'GOOGLE',
      regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    },
    {
      provider: 'SLACK',
      regex: /\bxox[baprs]-[0-9A-Za-z\-]{10,}\b/g,
    },
    {
      provider: 'STRIPE',
      regex: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}\b/g,
    },
    {
      provider: 'JWT',
      regex: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    },
  ];

  static shannonEntropy(str) {
    if (!str || str.length === 0) return 0;
    const freq = new Map();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      freq.set(ch, (freq.get(ch) || 0) + 1);
    }
    let entropy = 0;
    const len = str.length;
    for (const count of freq.values()) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  static hasMixedCharClasses(str) {
    let classes = 0;
    if (/[a-z]/.test(str)) classes++;
    if (/[A-Z]/.test(str)) classes++;
    if (/[0-9]/.test(str)) classes++;
    if (/[^a-zA-Z0-9]/.test(str)) classes++;
    return classes >= 3 || (classes >= 2 && /[0-9]/.test(str) && str.length >= 28);
  }

  static maskToken(provider, rawSecret) {
    const shortHash = crypto.createHash('sha256').update(String(rawSecret)).digest('hex').slice(0, 4);
    return `‹REDACTED:${provider}:${shortHash}›`;
  }

  static redact(inputText) {
    if (!inputText || typeof inputText !== 'string') {
      return { sanitized: '', redactedCount: 0, providers: [] };
    }
    let sanitized = inputText;
    let redactedCount = 0;
    const providers = [];

    // 1. Deterministic provider regex rules
    for (const rule of SecretRedactor.RULES) {
      sanitized = sanitized.replace(rule.regex, (match) => {
        redactedCount++;
        providers.push(rule.provider);
        return SecretRedactor.maskToken(rule.provider, match);
      });
    }

    // 2. High-entropy secret assignment rules (e.g. API_KEY = "...", secret: "...")
    const assignmentRegex =
      /\b(secret|token|password|passwd|api_?key|auth_?token|private_?key|access_?key|client_?secret)\b(\s*[:=]\s*["']?)([A-Za-z0-9+/=_\-]{20,})(["']?)/gi;
    sanitized = sanitized.replace(assignmentRegex, (full, keyName, sep, candidate, quote) => {
      if (candidate.startsWith('‹REDACTED:')) return full;
      const entropy = SecretRedactor.shannonEntropy(candidate);
      if (entropy >= 4.0 && SecretRedactor.hasMixedCharClasses(candidate)) {
        redactedCount++;
        providers.push('HIGH_ENTROPY');
        return `${keyName}${sep}${SecretRedactor.maskToken('KEY', candidate)}${quote}`;
      }
      return full;
    });

    // 3. Standalone high-entropy tokens (>= 28 chars, Shannon entropy >= 4.5, no path slashes)
    const standaloneRegex = /(?<![A-Za-z0-9/_.-])\b([A-Za-z0-9+/_-]{28,})\b(?![A-Za-z0-9/_.-])/g;
    sanitized = sanitized.replace(standaloneRegex, (match) => {
      if (match.startsWith('‹REDACTED:') || match.includes('/') || match.includes('_')) {
        // Avoid masking file paths or long snake_case identifiers unless entropy is very high without underscores
        if (match.includes('/')) return match;
      }
      const entropy = SecretRedactor.shannonEntropy(match);
      if (entropy >= 4.5 && SecretRedactor.hasMixedCharClasses(match) && !/^[A-Za-z_]+$/.test(match)) {
        redactedCount++;
        providers.push('ENTROPY');
        return SecretRedactor.maskToken('SECRET', match);
      }
      return match;
    });

    return { sanitized, redactedCount, providers };
  }
}

// ============================================================================
// PHASE 2: 4-STAGE DETERMINISTIC DIET ENGINE & REHYDRATION LEDGER
// ============================================================================

/**
 * Task 2.1: Noise Gate (.gitignore, lockfiles, build artifacts, minified/binary filter) (SRS C-04 / TC-DIET-05)
 */
export class NoiseGate {
  static LOCKFILES = new Set([
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
    'cargo.lock', 'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock',
    'go.sum', 'flake.lock', 'pubspec.lock', 'podfile.lock',
  ]);

  static IGNORED_DIRS = new Set([
    'node_modules', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', '.git', '.vicem',
    '__pycache__', '.pytest_cache', '.venv', 'venv', 'target', 'vendor', '.turbo', '.cache',
  ]);

  static IGNORED_EXTS = new Set([
    '.min.js', '.min.css', '.map', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
    '.zip', '.tar', '.gz', '.tgz', '.7z', '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.mov', '.avi', '.wasm', '.pyc', '.pyo', '.so', '.dylib', '.dll',
    '.exe', '.bin', '.sqlite', '.db', '.db-wal', '.db-shm', '.vscdb', '.asar',
  ]);

  constructor(projectRoot = null) {
    this.projectRoot = projectRoot;
    this.customPatterns = [];
    if (projectRoot) {
      this.loadGitignore(path.join(projectRoot, '.gitignore'));
    }
  }

  loadGitignore(gitignorePath) {
    if (!fs.existsSync(gitignorePath)) return;
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        this.customPatterns.push(NoiseGate.globToRegExp(line));
      }
    } catch {
      // Ignore unreadable .gitignore
    }
  }

  static globToRegExp(glob) {
    let clean = glob.replace(/^\/+/, '').replace(/\/+$/, '');
    let escaped = clean
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`(?:^|/)${escaped}(?:/|$)`, 'i');
  }

  static isIgnored(filePath, customInstance = null) {
    if (!filePath) return true;
    if (isCredentialFile(filePath)) return true;

    const normalized = filePath.replace(/\\/g, '/');
    const base = path.basename(normalized).toLowerCase();

    if (NoiseGate.LOCKFILES.has(base)) return true;
    if (base.endsWith('.min.js') || base.endsWith('.min.css') || base.endsWith('.bundle.js')) {
      return true;
    }

    const ext = path.extname(base).toLowerCase();
    if (NoiseGate.IGNORED_EXTS.has(ext)) return true;

    const segments = normalized.split('/');
    for (const seg of segments) {
      if (NoiseGate.IGNORED_DIRS.has(seg.toLowerCase())) {
        return true;
      }
    }

    if (customInstance && customInstance.customPatterns.length > 0) {
      if (customInstance.customPatterns.some((re) => re.test(normalized))) {
        return true;
      }
    }
    return false;
  }

  isIgnored(filePath) {
    return NoiseGate.isIgnored(filePath, this);
  }

  static isMinifiedOrBinaryContent(content) {
    if (!content || typeof content !== 'string') return false;
    if (content.includes('\0')) return true;
    const lines = content.split('\n');
    const avgLen = content.length / Math.max(1, lines.length);
    if (content.length > 2000 && avgLen > 500) return true;
    return false;
  }
}

/**
 * Task 2.2: Build & Test Error Log Slimmer (SRS C-04 / UC-13 / TC-DIET-03)
 */
export class LogSlimmer {
  static ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

  static PASSING_LINE_REGEX =
    /^\s*(?:PASS\b|✓\s|✔\s|ok\s+\d+\s+-|(?:\[\d+\/\d+\]\s+)?Compiling\s|Downloading\s|Downloaded\s|Installing\s|up to date in\s)/i;

  static INTERNAL_FRAME_REGEX =
    /^\s*at\s+.*?(?:node_modules[\\/]|site-packages[\\/]|node:internal[\\/]|internal[\\/]modules[\\/]|internal[\\/]process[\\/]|\(<anonymous>\)|java\.base\/|org\.junit\.|org\.gradle\.)/i;

  static ROOT_CAUSE_REGEX =
    /(?:FAIL\b|FAILED\b|Error:|Exception:|AssertionError|TypeError|SyntaxError|ReferenceError|panicked at|error\[E\d+\]:|TS\d+:|✕\s|✖\s|❌)/i;

  static slim(logText, options = {}) {
    if (!logText || typeof logText !== 'string') return '';

    if (options.projectRoot) {
      try {
        const vicemDir = AtomicFs.ensureVicemDir(options.projectRoot);
        AtomicFs.writeFileAtomic(path.join(vicemDir, 'raw', 'last_build.log'), logText);
      } catch {
        // Non-fatal if raw log save fails
      }
    }

    // 1. Strip ANSI codes and normalize carriage returns (progress bars)
    const cleanText = logText
      .replace(LogSlimmer.ANSI_REGEX, '')
      .replace(/^.*\r(?!\n)/gm, '');

    const rawLines = cleanText.split(/\r?\n/);
    const filteredLines = [];
    let omittedInternalFrames = 0;
    let omittedPassLines = 0;

    const flushInternalFrames = () => {
      if (omittedInternalFrames > 0) {
        filteredLines.push(`    ... [${omittedInternalFrames} internal/library stack frames omitted]`);
        omittedInternalFrames = 0;
      }
    };

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];

      // Collapse internal/node_modules stack frames
      if (LogSlimmer.INTERNAL_FRAME_REGEX.test(line)) {
        omittedInternalFrames++;
        continue;
      }
      flushInternalFrames();

      // Drop passing test lines & noisy download/compile progress lines
      if (LogSlimmer.PASSING_LINE_REGEX.test(line)) {
        omittedPassLines++;
        continue;
      }

      // Collapse inline base64 data URIs
      const lineNoBase64 = line.replace(/data:[a-zA-Z0-9/+.-]+;base64,[A-Za-z0-9+/=]{60,}/g, 'data:...;base64,[OMITTED]');
      filteredLines.push(lineNoBase64);
    }
    flushInternalFrames();

    // 2. Deduplicate consecutive identical or repetitive lines
    const dedupedLines = [];
    let prevLine = null;
    let repeatCount = 0;

    for (const line of filteredLines) {
      const normalized = line.trim();
      if (normalized === '' && prevLine === '') {
        continue; // Collapse multiple blank lines into one
      }
      if (prevLine !== null && normalized !== '' && normalized === prevLine.trim()) {
        repeatCount++;
        continue;
      }
      if (repeatCount > 0) {
        dedupedLines.push(`  ... [previous line repeated ${repeatCount} more times]`);
        repeatCount = 0;
      }
      dedupedLines.push(line);
      prevLine = line;
    }
    if (repeatCount > 0) {
      dedupedLines.push(`  ... [previous line repeated ${repeatCount} more times]`);
    }

    if (omittedPassLines > 0) {
      dedupedLines.unshift(`[LogSlimmer: ${omittedPassLines} passing/progress lines omitted]`);
    }

    // 3. Enforce max token/char cap while preserving root-cause lines and tail summary
    const maxChars = options.maxChars || 4500;
    let result = dedupedLines.join('\n').trim();
    if (result.length > maxChars) {
      const headBudget = Math.floor(maxChars * 0.65);
      const tailBudget = Math.floor(maxChars * 0.30);
      result =
        result.slice(0, headBudget) +
        `\n... [LogSlimmer truncated ${result.length - maxChars} chars] ...\n` +
        result.slice(result.length - tailBudget);
    }

    return result;
  }
}

/**
 * Task 2.3: Structured Data Sampler for JSON, CSV, and SQL Dumps (SRS C-04 / UC-14 / TC-DIET-04)
 */
export class DataSampler {
  static sample(dataText, typeHint = 'auto') {
    if (!dataText || typeof dataText !== 'string') return '';
    const trimmed = dataText.trim();
    const detected = typeHint === 'auto' ? DataSampler.detectType(trimmed) : typeHint.toLowerCase();

    if (detected === 'json') return DataSampler.sampleJson(trimmed);
    if (detected === 'sql') return DataSampler.sampleSql(trimmed);
    if (detected === 'csv') return DataSampler.sampleCsv(trimmed);
    return trimmed.slice(0, 2000);
  }

  static detectType(text) {
    if (text.startsWith('{') || text.startsWith('[')) return 'json';
    if (/(?:CREATE\s+TABLE|INSERT\s+INTO|ALTER\s+TABLE)/i.test(text)) return 'sql';
    const firstLines = text.split(/\r?\n/, 4);
    if (firstLines.length >= 2 && firstLines[0].includes(',') && firstLines[1].includes(',')) {
      return 'csv';
    }
    return 'text';
  }

  static sampleJson(jsonText, maxArrayItems = 2) {
    try {
      const parsed = JSON.parse(jsonText);
      const sampled = DataSampler.sampleValue(parsed, maxArrayItems, 0);
      let formatted = JSON.stringify(sampled, null, 2);
      // Convert truncation sentinel string into readable inline comment notation
      formatted = formatted.replace(/"__VICEM_TRUNCATED_(\d+)__"/g, '/* ... $1 items truncated */');
      return formatted;
    } catch {
      return jsonText.slice(0, 1500) + '\n/* ... truncated invalid/partial JSON ... */';
    }
  }

  static sampleValue(val, maxItems, depth) {
    if (val === null || typeof val !== 'object') {
      if (typeof val === 'string' && val.length > 160) {
        return val.slice(0, 160) + '...[truncated]';
      }
      return val;
    }
    if (depth > 6) {
      return '[MaxDepthReached]';
    }
    if (Array.isArray(val)) {
      if (val.length <= maxItems) {
        return val.map((item) => DataSampler.sampleValue(item, maxItems, depth + 1));
      }
      const head = val.slice(0, maxItems).map((item) => DataSampler.sampleValue(item, maxItems, depth + 1));
      head.push(`__VICEM_TRUNCATED_${val.length - maxItems}__`);
      return head;
    }
    const result = {};
    const keys = Object.keys(val);
    const maxKeys = 40;
    for (let i = 0; i < Math.min(keys.length, maxKeys); i++) {
      const k = keys[i];
      result[k] = DataSampler.sampleValue(val[k], maxItems, depth + 1);
    }
    if (keys.length > maxKeys) {
      result['__more_keys__'] = `${keys.length - maxKeys} keys omitted`;
    }
    return result;
  }

  static sampleCsv(csvText, maxRows = 3) {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxRows + 1) return csvText;
    const kept = lines.slice(0, maxRows + 1);
    kept.push(`# ... ${lines.length - (maxRows + 1)} rows truncated (Total rows: ${lines.length - 1})`);
    return kept.join('\n');
  }

  static sampleSql(sqlText) {
    const statements = sqlText.split(/;\s*(?:\r?\n|$)/);
    const ddlKept = [];
    let omittedInserts = 0;
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (!clean) continue;
      if (/^(?:CREATE|ALTER|DROP|COMMENT\s+ON)\b/i.test(clean)) {
        ddlKept.push(clean + ';');
      } else if (/^(?:INSERT\s+INTO|COPY\s+)/i.test(clean)) {
        omittedInserts++;
      }
    }
    if (omittedInserts > 0) {
      ddlKept.push(`-- ... [${omittedInserts} INSERT/COPY data statements omitted by DataSampler]`);
    }
    return ddlKept.join('\n\n');
  }
}

/**
 * Task 2.4: Rehydration Ledger & Type-Preserving Code Skeletonizer (SRS C-04, C-13 / TC-DIET-01, TC-DIET-02)
 */
export class DietLedger {
  constructor(batonId = `baton-${Date.now()}`) {
    this.batonId = batonId;
    this.entries = [];
    this.redactedCount = 0;
  }

  addEntry({ filePath, symbolName, startLine, endLine, content }) {
    // Enforce UC-15 Zero-Leakage & No-Unredaction: never store raw secrets in ledger.json
    const { sanitized, redactedCount } = SecretRedactor.redact(String(content));
    this.redactedCount += redactedCount;
    const rawSha256 = crypto.createHash('sha256').update(sanitized).digest('hex');
    const existingIdx = this.entries.findIndex(
      (e) => e.filePath === filePath && e.symbolName === symbolName && e.startLine === startLine
    );
    const entry = {
      filePath,
      symbolName,
      startLine,
      endLine,
      rawSha256,
      content: sanitized,
    };
    if (existingIdx >= 0) {
      this.entries[existingIdx] = entry;
    } else {
      this.entries.push(entry);
    }
    return entry;
  }

  getEntry(filePath, symbolName = null) {
    const normReq = filePath.replace(/\\/g, '/');
    const matches = this.entries.filter((e) => {
      const normEntry = e.filePath.replace(/\\/g, '/');
      return normEntry === normReq || normEntry.endsWith('/' + normReq) || normReq.endsWith('/' + normEntry);
    });
    if (matches.length === 0) return null;
    if (!symbolName) {
      return matches.map((m) => m.content).join('\n\n');
    }
    const exact = matches.find((m) => m.symbolName === symbolName);
    if (exact) return exact.content;
    const partial = matches.find((m) => m.symbolName.toLowerCase().includes(symbolName.toLowerCase()));
    return partial ? partial.content : null;
  }

  save(projectRoot) {
    const vicemDir = AtomicFs.ensureVicemDir(projectRoot);
    const ledgerPath = path.join(vicemDir, 'ledger.json');
    AtomicFs.writeFileAtomic(
      ledgerPath,
      JSON.stringify({ batonId: this.batonId, entries: this.entries }, null, 2)
    );
    return ledgerPath;
  }

  static load(projectRoot) {
    const ledgerPath = path.join(projectRoot, '.vicem', 'ledger.json');
    if (!fs.existsSync(ledgerPath)) {
      return new DietLedger();
    }
    try {
      const data = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const ledger = new DietLedger(data.batonId);
      ledger.entries = Array.isArray(data.entries) ? data.entries : [];
      return ledger;
    } catch {
      return new DietLedger();
    }
  }
}

export class CodeSkeletonizer {
  /**
   * Default minimum lines inside a function body before skeletonizing.
   * Prevents tiny getters/helpers from being stripped while preserving full types/interfaces.
   */
  static DEFAULT_MIN_LINES = 12;

  static skeletonize(filePath, content, options = {}) {
    if (!content || typeof content !== 'string') {
      return { skeleton: '', ledgerEntries: [] };
    }
    const ledger = options.ledger || new DietLedger();
    const minLines = options.minLines ?? CodeSkeletonizer.DEFAULT_MIN_LINES;
    const ext = path.extname(filePath || '').toLowerCase();

    let skeleton;
    if (ext === '.py') {
      skeleton = CodeSkeletonizer.parsePython(filePath, content, ledger, minLines);
    } else {
      skeleton = CodeSkeletonizer.parseCFamily(filePath, content, ledger, minLines);
    }
    return {
      skeleton,
      ledgerEntries: ledger.entries.filter((e) => e.filePath === filePath),
      ledger,
    };
  }

  /**
   * Scan C-Family source (TS/JS/Go/Rust/Java/C/C++/C#) and return balanced brace pairs `{ openIdx, closeIdx }`
   * while strictly ignoring braces inside strings, template literals, comments, and regex literals.
   */
  static findBalancedBraces(content) {
    const pairs = [];
    const stack = [];
    const len = content.length;
    let i = 0;
    let lastNonSpaceChar = '';

    while (i < len) {
      const ch = content[i];
      const next = content[i + 1];

      // 1. Line comment
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < len && content[i] !== '\n') i++;
        continue;
      }
      // 2. Block comment
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < len && !(content[i] === '*' && content[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      // 3. Single or double quoted string
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < len && content[i] !== quote) {
          if (content[i] === '\\') i++;
          i++;
        }
        i++;
        lastNonSpaceChar = quote;
        continue;
      }
      // 4. Template literal (`...`) with nested ${ ... } expression depth tracking (BUG-02 Fix)
      if (ch === '`') {
        i++;
        while (i < len) {
          if (content[i] === '\\') {
            i += 2;
            continue;
          }
          if (content[i] === '`') {
            i++;
            break;
          }
          if (content[i] === '$' && content[i + 1] === '{') {
            i += 2;
            let exprDepth = 1;
            while (i < len && exprDepth > 0) {
              const c = content[i];
              const nx = content[i + 1];
              if (c === '\\') {
                i += 2;
                continue;
              }
              if (c === '/' && nx === '/') {
                i += 2;
                while (i < len && content[i] !== '\n') i++;
                continue;
              }
              if (c === '/' && nx === '*') {
                i += 2;
                while (i < len && !(content[i] === '*' && content[i + 1] === '/')) i++;
                i += 2;
                continue;
              }
              if (c === "'" || c === '"' || c === '`') {
                const q = c;
                i++;
                while (i < len && content[i] !== q) {
                  if (content[i] === '\\') i++;
                  i++;
                }
                i++;
                continue;
              }
              if (c === '{') exprDepth++;
              else if (c === '}') exprDepth--;
              i++;
            }
            continue;
          }
          i++;
        }
        lastNonSpaceChar = '`';
        continue;
      }
      // 5. Regex literal (/.../flags) including after keywords like `return`, `case`, `throw`, `await` (CRIT-05 Fix)
      if (ch === '/' && next !== '/' && next !== '*') {
        const beforeSlice = content.slice(Math.max(0, i - 24), i).trimEnd();
        const kwRegex = /(?:^|[^A-Za-z0-9_$])(?:return|case|throw|typeof|void|delete|await|yield)$/;
        const canStartRegex =
          lastNonSpaceChar === '' ||
          '=(,[!:;&|?+-%*{<>~^'.includes(lastNonSpaceChar) ||
          kwRegex.test(beforeSlice);
        if (canStartRegex) {
          let j = i + 1;
          let inCharClass = false;
          let validRegex = false;
          while (j < len && content[j] !== '\n') {
            if (content[j] === '\\') {
              j += 2;
              continue;
            }
            if (content[j] === '[') inCharClass = true;
            else if (content[j] === ']') inCharClass = false;
            else if (content[j] === '/' && !inCharClass) {
              validRegex = true;
              break;
            }
            j++;
          }
          if (validRegex) {
            i = j + 1;
            while (i < len && /[a-z]/i.test(content[i])) i++;
            lastNonSpaceChar = '/';
            continue;
          }
        }
      }

      if (ch === '{') {
        stack.push({ openIdx: i, depth: stack.length });
        lastNonSpaceChar = '{';
      } else if (ch === '}') {
        if (stack.length > 0) {
          const popped = stack.pop();
          pairs.push({ openIdx: popped.openIdx, closeIdx: i, depth: popped.depth });
        }
        lastNonSpaceChar = '}';
      } else if (!/\s/.test(ch)) {
        lastNonSpaceChar = ch;
      }
      i++;
    }
    return pairs.sort((a, b) => a.openIdx - b.openIdx);
  }

  static stripNestedParens(str) {
    let out = '';
    let parenDepth = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '(') {
        if (parenDepth === 0) out += ch;
        parenDepth++;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        if (parenDepth === 0) out += ch;
      } else if (parenDepth === 0) {
        out += ch;
      }
    }
    return out;
  }

  static classifyCBlockHeader(headerText) {
    const clean = headerText
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .trim();
    const collapsed = CodeSkeletonizer.stripNestedParens(clean);
    const lastSegment = collapsed.split(/[;{}]/).pop().trim();

    // Type / Contract definitions MUST be 100% preserved
    if (/^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|struct|trait)\b/m.test(lastSegment)) {
      return { kind: 'type', symbol: null };
    }
    // Container definitions (class, namespace, module, impl) should keep their body open so methods inside are checked
    if (/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|namespace|module|impl)\b/m.test(lastSegment)) {
      return { kind: 'container', symbol: null };
    }
    // Control flow blocks inside functions (if, for, while, switch, try, catch)
    if (/^(?:if|else|for|while|switch|try|catch|finally|do)\b/.test(lastSegment)) {
      return { kind: 'control', symbol: null };
    }

    // Function or Method declaration detection (supports arrow return types like `=> void` and multiline params — BUG-03 Fix)
    const fnMatch =
      lastSegment.match(/\b(?:function\s*\*?\s*|fn\s+|func\s+)([A-Za-z0-9_$]+)/) ||
      lastSegment.match(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([\s\S]*?\)|[A-Za-z0-9_$]+)\s*=>/) ||
      lastSegment.match(
        /(?:^|\n)\s*(?:(?:public|private|protected|static|async|override|readonly|get|set|export)\b\s+)*([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[\s\S]+)?$/
      );

    if (fnMatch && fnMatch[1] && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(fnMatch[1])) {
      return { kind: 'function', symbol: fnMatch[1] };
    }
    return { kind: 'other', symbol: null };
  }

  static findSignatureStartIdx(content, openBraceIdx, symbol) {
    const lookbackStart = Math.max(0, openBraceIdx - 600);
    const slice = content.slice(lookbackStart, openBraceIdx);
    const symRegex = new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`, 'g');
    let lastMatchIdx = -1;
    let m;
    while ((m = symRegex.exec(slice)) !== null) {
      lastMatchIdx = m.index;
    }
    if (lastMatchIdx >= 0) {
      const absSymIdx = lookbackStart + lastMatchIdx;
      return content.lastIndexOf('\n', absSymIdx) + 1;
    }
    return content.lastIndexOf('\n', openBraceIdx - 1) + 1;
  }

  static parseCFamily(filePath, content, ledger, minLines = CodeSkeletonizer.DEFAULT_MIN_LINES) {
    const pairs = CodeSkeletonizer.findBalancedBraces(content);
    if (pairs.length === 0) return content;

    // Build line number lookup
    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') lineStarts.push(i + 1);
    }
    const getLineNumber = (idx) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= idx) low = mid + 1;
        else high = mid - 1;
      }
      return low; // 1-based line number
    };

    const replacements = [];
    let skipUntilIdx = -1;

    for (const pair of pairs) {
      if (pair.openIdx < skipUntilIdx) continue;

      const lookbackStart = Math.max(0, pair.openIdx - 500);
      const headerSlice = content.slice(lookbackStart, pair.openIdx);
      const { kind, symbol } = CodeSkeletonizer.classifyCBlockHeader(headerSlice);

      if (kind === 'type') {
        // Preserve entire interface/type/enum/struct block including nested braces
        skipUntilIdx = pair.closeIdx;
        continue;
      }

      if (kind === 'function' && symbol) {
        const sigStart = CodeSkeletonizer.findSignatureStartIdx(content, pair.openIdx, symbol);
        const startLine = getLineNumber(sigStart);
        const endLine = getLineNumber(pair.closeIdx);
        const lineSpan = endLine - startLine + 1;

        if (lineSpan >= minLines) {
          // Record full function (entire multiline signature + body) in Ledger (BUG-03 Fix)
          const fullFnContent = content.slice(sigStart, pair.closeIdx + 1);
          ledger.addEntry({
            filePath,
            symbolName: symbol,
            startLine,
            endLine,
            content: fullFnContent,
          });

          replacements.push({
            start: pair.openIdx + 1,
            end: pair.closeIdx,
            text: ` /* ... */ `,
          });
          skipUntilIdx = pair.closeIdx;
        }
      }
    }

    if (replacements.length === 0) return content;

    let result = '';
    let cursor = 0;
    for (const rep of replacements) {
      result += content.slice(cursor, rep.start) + rep.text;
      cursor = rep.end;
    }
    result += content.slice(cursor);
    return result;
  }

  static parsePython(filePath, content, ledger, minLines = CodeSkeletonizer.DEFAULT_MIN_LINES) {
    const lines = content.split(/\r?\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
      if (!defMatch) {
        out.push(line);
        i++;
        continue;
      }

      const defIndent = defMatch[1].length;
      const symbol = defMatch[2];
      const defStartLine = i;

      // Advance until the end of signature (colon at end of line)
      let sigEndLine = i;
      while (sigEndLine < lines.length && !/:\s*(?:#.*)?$/.test(lines[sigEndLine])) {
        sigEndLine++;
      }
      if (sigEndLine >= lines.length) {
        out.push(line);
        i++;
        continue;
      }

      // Find the end of the indented block
      let bodyEndLine = sigEndLine;
      let j = sigEndLine + 1;
      let inDocstring = false;
      let docDelim = null;

      while (j < lines.length) {
        const cur = lines[j];
        const trimmed = cur.trim();

        if (inDocstring) {
          bodyEndLine = j;
          if (trimmed.includes(docDelim)) {
            inDocstring = false;
          }
          j++;
          continue;
        }

        if (trimmed === '' || trimmed.startsWith('#')) {
          j++;
          continue;
        }

        const curIndent = cur.match(/^(\s*)/)[1].length;
        if (curIndent <= defIndent) {
          break;
        }

        if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
          docDelim = trimmed.slice(0, 3);
          const rest = trimmed.slice(3);
          if (!rest.includes(docDelim)) {
            inDocstring = true;
          }
        }
        bodyEndLine = j;
        j++;
      }

      const totalBlockLines = bodyEndLine - defStartLine + 1;
      if (totalBlockLines >= minLines) {
        const fullBlockContent = lines.slice(defStartLine, bodyEndLine + 1).join('\n');
        ledger.addEntry({
          filePath,
          symbolName: symbol,
          startLine: defStartLine + 1,
          endLine: bodyEndLine + 1,
          content: fullBlockContent,
        });

        for (let k = defStartLine; k <= sigEndLine; k++) {
          out.push(lines[k]);
        }
        const passIndent = ' '.repeat(defIndent + 4);
        out.push(`${passIndent}pass`);
        i = bodyEndLine + 1;
      } else {
        for (let k = defStartLine; k <= bodyEndLine; k++) {
          out.push(lines[k]);
        }
        i = bodyEndLine + 1;
      }
    }

    return out.join('\n');
  }
}

/**
 * DietEngine: Unified orchestrator for CodeSkeletonizer, LogSlimmer, DataSampler, and NoiseGate
 */
export class DietEngine {
  constructor(projectRoot = null) {
    this.projectRoot = projectRoot;
    this.noiseGate = new NoiseGate(projectRoot);
    this.ledger = new DietLedger();
  }

  dietCode(filePath, content, options = {}) {
    if (this.noiseGate.isIgnored(filePath) || NoiseGate.isMinifiedOrBinaryContent(content)) {
      return { omitted: true, skeleton: '', ledgerEntries: [] };
    }
    return CodeSkeletonizer.skeletonize(filePath, content, {
      ledger: this.ledger,
      minLines: options.minLines ?? CodeSkeletonizer.DEFAULT_MIN_LINES,
    });
  }

  dietLog(logText, options = {}) {
    return LogSlimmer.slim(logText, { projectRoot: this.projectRoot, ...options });
  }

  dietData(dataText, typeHint = 'auto') {
    return DataSampler.sample(dataText, typeHint);
  }
}

// ============================================================================
// PHASE 3: SESSION HARVESTERS, DETERMINISTIC TASK EXTRACTOR & SMART INFERENCE
// ============================================================================

/**
 * Task 3.1: Git Context Collector with Graceful Non-Git Fallback (SRS C-03)
 */
export class GitCollector {
  static execGit(args, cwd) {
    try {
      const res = childProcess.spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (res.status !== 0) return null;
      return (res.stdout || '').trimEnd();
    } catch {
      return null;
    }
  }

  static collect(projectRoot) {
    const resolvedRoot = path.resolve(projectRoot);
    const statusOut = GitCollector.execGit(['status', '--porcelain=v2', '--branch'], resolvedRoot);

    if (statusOut === null) {
      return GitCollector.collectNonGitFallback(resolvedRoot);
    }

    let branch = 'HEAD';
    let headCommit = 'unknown';
    const modifiedFiles = [];
    const untrackedFiles = [];
    const noiseGate = new NoiseGate(resolvedRoot);

    for (const line of statusOut.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith('# branch.head ')) {
        branch = line.slice('# branch.head '.length).trim();
      } else if (line.startsWith('# branch.oid ')) {
        headCommit = line.slice('# branch.oid '.length).trim().slice(0, 12);
      } else if (line.startsWith('1 ') || line.startsWith('u ')) {
        // Porcelain v2 format:
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path> (8 space-separated fields before <path>)
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> (10 space-separated fields before <path>)
        const fieldCount = line.startsWith('u ') ? 10 : 8;
        const m = line.match(new RegExp(`^(?:\\S+\\s+){${fieldCount}}(.+)$`));
        const filePath = m ? m[1].replace(/^"|"$/g, '').trim() : '';
        if (filePath && !noiseGate.isIgnored(filePath)) {
          modifiedFiles.push(filePath);
        }
      } else if (line.startsWith('2 ')) {
        // Rename/Copy: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
        const m = line.match(/^(?:\S+\s+){9}(.+)$/);
        const rawPaths = m ? m[1] : '';
        const newPath = rawPaths.split('\t')[0].replace(/^"|"$/g, '').trim();
        if (newPath && !noiseGate.isIgnored(newPath)) {
          modifiedFiles.push(newPath);
        }
      } else if (line.startsWith('? ')) {
        const filePath = line.slice(2).replace(/^"|"$/g, '').trim();
        if (filePath && !noiseGate.isIgnored(filePath)) {
          untrackedFiles.push(filePath);
        }
      }
    }

    if (headCommit === 'unknown' || headCommit === '(initial)') {
      const rev = GitCollector.execGit(['rev-parse', '--short', 'HEAD'], resolvedRoot);
      if (rev) headCommit = rev.trim();
    }

    const diffStat = GitCollector.execGit(['diff', '--stat'], resolvedRoot) || '';
    const unstagedDiff = GitCollector.execGit(['diff', '-U2'], resolvedRoot) || '';
    const stagedDiff = GitCollector.execGit(['diff', '--staged', '-U2'], resolvedRoot) || '';
    const combinedDiff = [stagedDiff, unstagedDiff].filter(Boolean).join('\n');
    const logOut = GitCollector.execGit(['log', '-n', '3', '--oneline'], resolvedRoot) || '';
    const recentCommits = logOut
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    return {
      isGitRepo: true,
      branch,
      headCommit,
      modifiedFiles,
      untrackedFiles,
      diffSummary: diffStat,
      diffPatch: combinedDiff.slice(0, 12000),
      recentCommits,
    };
  }

  static collectNonGitFallback(projectRoot) {
    const noiseGate = new NoiseGate(projectRoot);
    const recentFiles = [];

    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(projectRoot, fullPath);
        if (noiseGate.isIgnored(relPath)) continue;
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            recentFiles.push({ relPath, mtimeMs: stat.mtimeMs });
          } catch {
            // Skip unreadable file
          }
        }
      }
    };

    walk(projectRoot, 0);
    recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return {
      isGitRepo: false,
      branch: 'no-git',
      headCommit: 'none',
      modifiedFiles: recentFiles.slice(0, 10).map((f) => f.relPath),
      untrackedFiles: [],
      diffSummary: 'Non-Git directory (sorted by file modification time)',
      diffPatch: '',
      recentCommits: [],
    };
  }
}

/**
 * Task 3.2: SQLite WAL Live Database Snapshot Reader [V-RUN] & Reverse JSONL Reader (SRS C-02 / TC-HARV-02)
 */
export async function readWalDatabaseSnapshot(dbPath, queryFn) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return null;
  }
  const sqlite = await import('node:sqlite');
  const { DatabaseSync, backup } = sqlite;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-wal-'));
  const tempDb = path.join(tempDir, 'snap.db');

  try {
    let snapshotReady = false;
    if (typeof backup === 'function') {
      let srcDb = null;
      try {
        srcDb = new DatabaseSync(dbPath, { readOnly: true });
        await backup(srcDb, tempDb);
        snapshotReady = true;
      } catch {
        snapshotReady = false;
      } finally {
        if (srcDb) {
          try {
            srcDb.close();
          } catch {
            // Ignore close error
          }
        }
      }
    }

    // Fallback: copy .db, .db-wal, and .db-shm to tempDir if backup() failed (e.g. read-only directory without -shm)
    if (!snapshotReady) {
      fs.copyFileSync(dbPath, tempDb);
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(dbPath + suffix)) {
          try {
            fs.copyFileSync(dbPath + suffix, tempDb + suffix);
          } catch {
            // Ignore if WAL disappeared mid-checkpoint
          }
        }
      }
    }

    const snapDb = new DatabaseSync(tempDb, { readOnly: true });
    try {
      return await queryFn(snapDb);
    } finally {
      snapDb.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function readJsonlHead(filePath, maxLines = 15, maxBytes = 64 * 1024) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, maxBytes);
    if (readSize === 0) return [];
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(readSize);
    fs.readSync(fd, buf, 0, readSize, 0);
    const content = buf.toString('utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, maxLines);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore truncated boundary line
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function readJsonlTail(filePath, maxLines = 200, maxBytes = 512 * 1024) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, maxBytes);
    if (readSize === 0) return [];
    const offset = Math.max(0, stat.size - readSize);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(readSize);
    fs.readSync(fd, buf, 0, readSize, offset);
    const content = buf.toString('utf8');
    const rawLines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    // If we started mid-file, skip the first partial line
    const lines = offset > 0 && rawLines.length > 1 ? rawLines.slice(1) : rawLines;
    const slice = lines.slice(-maxLines);
    const events = [];
    for (const line of slice) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore truncated/corrupted JSONL line
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Gemini CLI verified project hash function (SRS §11 Appendix A / U-8 / TC-HARV-03) [V-SRC]
 */
export function getGeminiProjectHash(projectRoot) {
  const resolved = path.resolve(projectRoot);
  return crypto.createHash('sha256').update(resolved).digest('hex');
}

/**
 * Claude Code project directory encoding rule (SRS U-1 / TC-HARV-01) [V-SRC]
 */
export function encodeClaudeProjectDir(projectRoot) {
  const resolved = path.resolve(projectRoot);
  return resolved.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Task 3.4: Zero-LLM 4-Source Deterministic Task Extractor (SRS C-02 / TC-INFER-03)
 */
export class DeterministicTaskExtractor {
  static TRIVIAL_PROMPTS = new Set([
    'y', 'yes', 'ok', 'okay', 'continue', 'go', 'go ahead', 'proceed', 'lgtm', 'sure',
  ]);

  static extract(rawEvents = [], gitContext = null) {
    const userPrompts = [];
    const assistantMessages = [];
    const editedFiles = new Set();
    const todoCompleted = [];
    const todoPending = [];
    let lastFailedCommand = null;
    let lastEventWasUnansweredUser = false;

    for (const ev of rawEvents) {
      if (!ev || typeof ev !== 'object') continue;

      // 1. Extract User Prompts (Claude Code, Codex, Gemini, VS Code, Export formats)
      const role = ev.role || ev.type || ev.message?.role || ev.sender;
      const textContent = DeterministicTaskExtractor.extractTextFromEvent(ev);

      if (role === 'user' || role === 'human' || ev.type === 'user_message') {
        if (textContent) {
          userPrompts.push(textContent.trim());
          lastEventWasUnansweredUser = true;
        }
      } else if (role === 'assistant' || role === 'model' || ev.type === 'agent_message') {
        if (textContent) {
          assistantMessages.push(textContent.trim());
        }
        lastEventWasUnansweredUser = false;
      }

      // 2. Inspect Tool Calls (TodoWrite, update_plan, Edit/Write, Bash failures)
      const toolCalls = DeterministicTaskExtractor.extractToolCalls(ev);
      for (const tc of toolCalls) {
        lastEventWasUnansweredUser = false;
        const name = (tc.name || '').toLowerCase();
        const input = tc.input || tc.arguments || {};

        // Source 1: Structured TodoWrite / update_plan extraction
        if (name === 'todowrite' || name === 'todo_write' || name === 'update_plan') {
          const todos = Array.isArray(input.todos)
            ? input.todos
            : Array.isArray(input.plan)
              ? input.plan
              : [];
          if (todos.length > 0) {
            todoCompleted.length = 0;
            todoPending.length = 0;
            for (const item of todos) {
              const label = item.content || item.step || item.title || item.description;
              if (!label) continue;
              const status = (item.status || '').toLowerCase();
              if (status === 'completed' || status === 'done') {
                todoCompleted.push(label);
              } else if (status === 'in_progress' || status === 'in-progress') {
                todoPending.unshift(`[IN PROGRESS] ${label}`);
              } else {
                todoPending.push(label);
              }
            }
          }
        }

        // Source 3a: File edit trail
        if (
          ['edit', 'write', 'multiedit', 'Write_file', 'edit_file', 'replace_in_file', 'create_file'].includes(name) ||
          name.includes('edit') ||
          name.includes('write')
        ) {
          const targetFile = input.file_path || input.filePath || input.path || input.TargetFile;
          if (targetFile && typeof targetFile === 'string') {
            editedFiles.add(targetFile);
          }
        }

        // Source 3b: Bash / Command execution status
        if (name === 'bash' || name === 'run_command' || name === 'shell' || name === 'exec_command') {
          const cmd = input.command || input.CommandLine || input.cmd;
          if (tc.exitCode && tc.exitCode !== 0) {
            lastFailedCommand = { command: cmd || 'shell command', exitCode: tc.exitCode, error: tc.output || '' };
          } else if (tc.exitCode === 0) {
            lastFailedCommand = null;
          }
        }
      }

      // Check tool_result error events
      if (ev.type === 'tool_result' || ev.role === 'tool') {
        if (ev.is_error || (typeof ev.exit_code === 'number' && ev.exit_code !== 0)) {
          lastFailedCommand = {
            command: ev.command || ev.tool_name || 'last command',
            exitCode: ev.exit_code || 1,
            error: typeof ev.content === 'string' ? ev.content.slice(0, 300) : '',
          };
        }
      }
    }

    // Source 2: Prompt Boundary Heuristics for Goal
    let goal = '';
    for (const p of userPrompts) {
      const clean = p.replace(/\s+/g, ' ').trim();
      if (clean.length >= 15 && !DeterministicTaskExtractor.TRIVIAL_PROMPTS.has(clean.toLowerCase())) {
        goal = clean.slice(0, 350);
        break;
      }
    }
    if (!goal && userPrompts.length > 0) {
      goal = userPrompts[userPrompts.length - 1].slice(0, 350);
    }
    if (!goal && gitContext) {
      goal = `Continue development on branch '${gitContext.branch || 'main'}' (${(gitContext.recentCommits || [])[0] || 'working tree'})`;
    }
    if (!goal) {
      goal = 'Continue project implementation and resolve pending tasks';
    }

    // Assemble Done list
    const doneItems = [...todoCompleted];
    for (const f of editedFiles) {
      const item = `Modified file: ${f}`;
      if (!doneItems.some((d) => d.includes(f))) {
        doneItems.push(item);
      }
    }
    if (doneItems.length === 0 && gitContext) {
      for (const c of (gitContext.recentCommits || []).slice(0, 2)) {
        doneItems.push(`Recent commit: ${c}`);
      }
      for (const f of (gitContext.modifiedFiles || []).slice(0, 5)) {
        doneItems.push(`Working tree modified: ${f}`);
      }
    }

    // Assemble Immediate NEXT list
    const immediateNext = [];
    if (lastFailedCommand) {
      immediateNext.push(
        `Fix failing command '${lastFailedCommand.command}' (exit code ${lastFailedCommand.exitCode})`
      );
    }
    if (lastEventWasUnansweredUser && userPrompts.length > 0) {
      const lastPrompt = userPrompts[userPrompts.length - 1].replace(/\s+/g, ' ').trim();
      if (!DeterministicTaskExtractor.TRIVIAL_PROMPTS.has(lastPrompt.toLowerCase())) {
        immediateNext.push(`Fulfill interrupted user request: "${lastPrompt.slice(0, 240)}"`);
      }
    }
    for (const item of todoPending) {
      if (!immediateNext.includes(item)) {
        immediateNext.push(item);
      }
    }
    if (immediateNext.length === 0) {
      if (gitContext && gitContext.modifiedFiles?.length > 0) {
        immediateNext.push(
          `Verify and complete uncommitted changes in: ${gitContext.modifiedFiles.slice(0, 4).join(', ')}`
        );
      } else {
        immediateNext.push('Review .vicem/BATON.md context and proceed with the next implementation step');
      }
    }

    return {
      goal,
      done: doneItems,
      immediateNext,
      userPrompts,
      assistantMessages,
    };
  }

  static extractTextFromEvent(ev) {
    if (typeof ev.content === 'string') return ev.content;
    if (typeof ev.text === 'string') return ev.text;
    const msgContent = ev.message?.content || ev.content;
    if (typeof msgContent === 'string') return msgContent;
    if (Array.isArray(msgContent)) {
      return msgContent
        .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
        .map((part) => part.text || '')
        .join('\n');
    }
    return '';
  }

  static extractToolCalls(ev) {
    const calls = [];
    if (Array.isArray(ev.tool_calls)) {
      for (const tc of ev.tool_calls) {
        let parsedArgs = tc.function?.arguments ?? tc.arguments ?? tc.input ?? {};
        if (typeof parsedArgs === 'string') {
          try {
            parsedArgs = JSON.parse(parsedArgs);
          } catch {
            parsedArgs = {};
          }
        }
        calls.push({
          name: tc.function?.name || tc.name || '',
          input: parsedArgs,
          exitCode: tc.exit_code ?? tc.exitCode,
          output: tc.output,
        });
      }
    }
    const msgContent = ev.message?.content || ev.content;
    if (Array.isArray(msgContent)) {
      for (const block of msgContent) {
        if (block && block.type === 'tool_use') {
          calls.push({
            name: block.name || '',
            input: block.input || {},
            exitCode: block.exit_code,
          });
        }
      }
    }
    if (ev.type === 'tool_use' || ev.type === 'function_call') {
      let input = ev.input || ev.arguments || {};
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          input = {};
        }
      }
      calls.push({
        name: ev.name || '',
        input,
        exitCode: ev.exit_code ?? ev.exitCode,
        output: ev.output,
      });
    }
    return calls;
  }
}

/**
 * Task 3.3: Project-Scoped Session Harvesters (SRS C-02 / TC-HARV-01, TC-HARV-03)
 */
export class SessionHarvester {
  constructor(projectRoot, env = process.env) {
    this.projectRoot = path.resolve(projectRoot);
    this.env = env;
    this.homeDir = env.HOME || env.USERPROFILE || os.homedir();
  }

  getAgentName() {
    return 'unknown';
  }

  /**
   * Returns the latest modification timestamp (ms) ONLY for sessions bound to `this.projectRoot`.
   * Returns 0 if no session for this project exists.
   */
  async getProjectScopedLatestMtime() {
    return 0;
  }

  async harvestSession() {
    return null;
  }
}

export class ClaudeHarvester extends SessionHarvester {
  getAgentName() {
    return 'claude';
  }

  getProjectSessionDir() {
    const configBase = this.env.CLAUDE_CONFIG_DIR || path.join(this.homeDir, '.claude');
    const encoded = encodeClaudeProjectDir(this.projectRoot);
    return path.join(configBase, 'projects', encoded);
  }

  findSessionFiles() {
    const dir = this.getProjectSessionDir();
    if (!fs.existsSync(dir)) return [];
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          return { filePath: full, sessionId: path.basename(f, '.jsonl'), mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  }

  async getProjectScopedLatestMtime() {
    const files = this.findSessionFiles();
    return files.length > 0 ? files[0].mtimeMs : 0;
  }

  async harvestSession() {
    const files = this.findSessionFiles();
    if (files.length === 0) return null;
    const latest = files[0];
    const rawEvents = readJsonlTail(latest.filePath, 200);
    return {
      agent: 'claude',
      sessionId: latest.sessionId,
      mtimeMs: latest.mtimeMs,
      rawEvents,
    };
  }
}

export class CodexHarvester extends SessionHarvester {
  getAgentName() {
    return 'codex';
  }

  getCodexHome() {
    return this.env.CODEX_HOME || path.join(this.homeDir, '.codex');
  }

  findMatchingJsonlSessions() {
    const sessionsDir = path.join(this.getCodexHome(), 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];
    const results = [];

    const walk = (dir, depth = 0) => {
      if (depth > 4) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(full);
            const headEvents = readJsonlHead(full, 10);
            // Project-scoped check: verify session belongs to this.projectRoot using fast 64KB head read
            const matchesCwd = headEvents.some(
              (ev) =>
                ev.cwd === this.projectRoot ||
                ev.payload?.cwd === this.projectRoot ||
                ev.projectRoot === this.projectRoot
            );
            if (matchesCwd) {
              results.push({
                filePath: full,
                sessionId: path.basename(full, '.jsonl'),
                mtimeMs: stat.mtimeMs,
              });
            }
          } catch {
            // Skip unreadable
          }
        }
      }
    };

    walk(sessionsDir, 0);
    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async getProjectScopedLatestMtime() {
    const jsonlMatches = this.findMatchingJsonlSessions();
    if (jsonlMatches.length > 0) return jsonlMatches[0].mtimeMs;

    const sqlitePath = path.join(this.getCodexHome(), 'state_5.sqlite');
    if (fs.existsSync(sqlitePath)) {
      const mtime = await readWalDatabaseSnapshot(sqlitePath, (db) => {
        try {
          const row = db
            .prepare(`SELECT updated_at FROM threads WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1`)
            .get(this.projectRoot);
          if (row && row.updated_at) {
            return typeof row.updated_at === 'number'
              ? row.updated_at < 1e12
                ? row.updated_at * 1000
                : row.updated_at
              : new Date(row.updated_at).getTime();
          }
        } catch {
          // Table schema may differ
        }
        return 0;
      });
      if (mtime) return mtime;
    }
    return 0;
  }

  async harvestSession() {
    const jsonlMatches = this.findMatchingJsonlSessions();
    if (jsonlMatches.length > 0) {
      const latest = jsonlMatches[0];
      return {
        agent: 'codex',
        sessionId: latest.sessionId,
        mtimeMs: latest.mtimeMs,
        rawEvents: readJsonlTail(latest.filePath, 200),
      };
    }
    return null;
  }
}

export class GeminiHarvester extends SessionHarvester {
  getAgentName() {
    return 'gemini';
  }

  getChatsDir() {
    const geminiHome = this.env.GEMINI_CLI_HOME || path.join(this.homeDir, '.gemini');
    const hash = getGeminiProjectHash(this.projectRoot);
    return path.join(geminiHome, 'tmp', hash, 'chats');
  }

  findSessionFiles() {
    const dir = this.getChatsDir();
    if (!fs.existsSync(dir)) return [];
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
        .map((f) => {
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          return { filePath: full, sessionId: path.basename(f, path.extname(f)), mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      return [];
    }
  }

  async getProjectScopedLatestMtime() {
    const files = this.findSessionFiles();
    return files.length > 0 ? files[0].mtimeMs : 0;
  }

  async harvestSession() {
    const files = this.findSessionFiles();
    if (files.length === 0) return null;
    const latest = files[0];
    const rawEvents = latest.filePath.endsWith('.jsonl')
      ? readJsonlTail(latest.filePath, 200)
      : JSON.parse(fs.readFileSync(latest.filePath, 'utf8')).messages || [];
    return {
      agent: 'gemini',
      sessionId: latest.sessionId,
      mtimeMs: latest.mtimeMs,
      rawEvents,
    };
  }
}

export class AiderHarvester extends SessionHarvester {
  getAgentName() {
    return 'aider';
  }

  getHistoryPath() {
    return path.join(this.projectRoot, '.aider.chat.history.md');
  }

  async getProjectScopedLatestMtime() {
    const p = this.getHistoryPath();
    if (!fs.existsSync(p)) return 0;
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  }

  async harvestSession() {
    const p = this.getHistoryPath();
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, 'utf8');
    const stat = fs.statSync(p);
    const userPrompts = [];
    for (const m of text.matchAll(/^####\s+(.+)$/gm)) {
      userPrompts.push({ role: 'user', content: m[1].trim() });
    }
    return {
      agent: 'aider',
      sessionId: 'aider-history',
      mtimeMs: stat.mtimeMs,
      rawEvents: userPrompts,
    };
  }
}

export class AntigravityHarvester extends SessionHarvester {
  getAgentName() {
    return 'antigravity';
  }

  getBrainDir() {
    return this.env.ANTIGRAVITY_BRAIN_DIR || path.join(this.homeDir, '.gemini', 'antigravity', 'brain');
  }

  findMatchingTranscripts() {
    const brainDir = this.getBrainDir();
    if (!fs.existsSync(brainDir)) return [];
    const matches = [];
    const targetUri = `file://${this.projectRoot}`;

    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true }).slice(0, 60);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const transcriptPath = path.join(brainDir, e.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptPath)) continue;
        try {
          const stat = fs.statSync(transcriptPath);
          const headEvents = readJsonlHead(transcriptPath, 15, 48 * 1024);
          const headRaw = JSON.stringify(headEvents);
          if (headRaw.includes(targetUri) || headRaw.includes(this.projectRoot)) {
            matches.push({
              filePath: transcriptPath,
              sessionId: e.name,
              mtimeMs: stat.mtimeMs,
            });
          }
        } catch {
          // Ignore unreadable
        }
      }
    } catch {
      return [];
    }
    return matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async getProjectScopedLatestMtime() {
    const matches = this.findMatchingTranscripts();
    return matches.length > 0 ? matches[0].mtimeMs : 0;
  }

  async harvestSession() {
    const matches = this.findMatchingTranscripts();
    if (matches.length === 0) return null;
    const latest = matches[0];
    const tailEvents = readJsonlTail(latest.filePath, 120);
    const normalized = [];
    for (const ev of tailEvents) {
      if (ev.type === 'USER_INPUT' && ev.content) {
        normalized.push({ role: 'user', content: String(ev.content) });
      } else if (ev.type === 'PLANNER_RESPONSE' && ev.content) {
        normalized.push({ role: 'assistant', content: String(ev.content) });
      } else if (ev.role) {
        normalized.push(ev);
      }
    }
    return {
      agent: 'antigravity',
      sessionId: latest.sessionId,
      mtimeMs: latest.mtimeMs,
      rawEvents: normalized,
    };
  }
}

export class CursorHarvester extends SessionHarvester {
  getAgentName() {
    return 'cursor';
  }

  getWorkspaceStorageDir() {
    if (this.env.CURSOR_WORKSPACE_STORAGE_DIR) return this.env.CURSOR_WORKSPACE_STORAGE_DIR;
    if (process.platform === 'darwin') {
      return path.join(this.homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    }
    if (process.platform === 'win32') {
      const appData = this.env.APPDATA || path.join(this.homeDir, 'AppData', 'Roaming');
      return path.join(appData, 'Cursor', 'User', 'workspaceStorage');
    }
    return path.join(this.homeDir, '.config', 'Cursor', 'User', 'workspaceStorage');
  }

  findMatchingWorkspaceDb() {
    const baseDir = this.getWorkspaceStorageDir();
    if (!fs.existsSync(baseDir)) return null;
    const targetUri = `file://${this.projectRoot}`;

    try {
      const dirs = fs.readdirSync(baseDir, { withFileTypes: true }).slice(0, 80);
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const wsJsonPath = path.join(baseDir, d.name, 'workspace.json');
        if (!fs.existsSync(wsJsonPath)) continue;
        try {
          const wsData = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
          const folder = String(wsData.folder || '');
          const decodedFolder = decodeURIComponent(folder);
          if (
            folder === targetUri ||
            decodedFolder === targetUri ||
            decodedFolder.endsWith(this.projectRoot)
          ) {
            const dbPath = path.join(baseDir, d.name, 'state.vscdb');
            if (fs.existsSync(dbPath)) {
              const stat = fs.statSync(dbPath);
              return { dbPath, workspaceId: d.name, mtimeMs: stat.mtimeMs, size: stat.size };
            }
          }
        } catch {
          // Ignore malformed workspace.json
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Fix 9-A: Two-Phase Metadata Pre-Check (< 2ms). NEVER copies or opens SQLite during autoDetectSource!
   */
  async getProjectScopedLatestMtime() {
    const match = this.findMatchingWorkspaceDb();
    return match ? match.mtimeMs : 0;
  }

  async harvestSession() {
    const match = this.findMatchingWorkspaceDb();
    if (!match) return null;

    const queryPrompts = (db) => {
      const events = [];
      try {
        const rows = db
          .prepare(
            `SELECT key, value FROM ItemTable WHERE key IN ('aiService.prompts', 'workbench.panel.aichat.view.aichat.chatdata') LIMIT 5`
          )
          .all();
        for (const r of rows) {
          try {
            const parsed = JSON.parse(r.value);
            if (Array.isArray(parsed)) {
              for (const item of parsed.slice(-30)) {
                const text = item?.text || item?.prompt || item?.content;
                if (typeof text === 'string' && text.trim()) {
                  events.push({ role: 'user', content: text.trim() });
                }
              }
            } else if (parsed?.tabs && Array.isArray(parsed.tabs)) {
              for (const tab of parsed.tabs.slice(-2)) {
                for (const bubble of tab.bubbles || []) {
                  const role = bubble.type === 'user' ? 'user' : 'assistant';
                  const text = bubble.text || bubble.rawText || '';
                  if (text) events.push({ role, content: String(text) });
                }
              }
            }
          } catch {
            // Ignore malformed JSON value
          }
        }
      } catch {
        // Table schema may differ
      }
      return events;
    };

    let rawEvents = [];
    // Fix 9-A: Only snapshot if DB <= 32MB; for > 32MB DBs, query read-only in-place with 0-byte copy
    if (match.size <= 32 * 1024 * 1024) {
      rawEvents = (await readWalDatabaseSnapshot(match.dbPath, queryPrompts)) || [];
    } else {
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(match.dbPath, { readOnly: true });
        try {
          rawEvents = queryPrompts(db);
        } finally {
          db.close();
        }
      } catch {
        rawEvents = [];
      }
    }

    return {
      agent: 'cursor',
      sessionId: `cursor-${match.workspaceId}`,
      mtimeMs: match.mtimeMs,
      rawEvents,
    };
  }
}

export class VSCodeCopilotHarvester extends SessionHarvester {
  getAgentName() {
    return 'vscode';
  }

  getWorkspaceStorageDir() {
    if (this.env.VSCODE_WORKSPACE_STORAGE_DIR) return this.env.VSCODE_WORKSPACE_STORAGE_DIR;
    if (process.platform === 'darwin') {
      return path.join(this.homeDir, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
    }
    if (process.platform === 'win32') {
      const appData = this.env.APPDATA || path.join(this.homeDir, 'AppData', 'Roaming');
      return path.join(appData, 'Code', 'User', 'workspaceStorage');
    }
    return path.join(this.homeDir, '.config', 'Code', 'User', 'workspaceStorage');
  }

  findLatestChatSessionFile() {
    const baseDir = this.getWorkspaceStorageDir();
    if (!fs.existsSync(baseDir)) return null;
    const targetUri = `file://${this.projectRoot}`;

    try {
      const dirs = fs.readdirSync(baseDir, { withFileTypes: true }).slice(0, 80);
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const wsJsonPath = path.join(baseDir, d.name, 'workspace.json');
        if (!fs.existsSync(wsJsonPath)) continue;
        try {
          const wsData = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
          const decodedFolder = decodeURIComponent(String(wsData.folder || ''));
          if (decodedFolder === targetUri || decodedFolder.endsWith(this.projectRoot)) {
            const chatDir = path.join(baseDir, d.name, 'chatSessions');
            if (!fs.existsSync(chatDir)) continue;
            const files = fs
              .readdirSync(chatDir)
              .filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'))
              .map((f) => {
                const full = path.join(chatDir, f);
                return { filePath: full, sessionId: path.basename(f, path.extname(f)), mtimeMs: fs.statSync(full).mtimeMs };
              })
              .sort((a, b) => b.mtimeMs - a.mtimeMs);
            if (files.length > 0) return files[0];
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  async getProjectScopedLatestMtime() {
    const match = this.findLatestChatSessionFile();
    return match ? match.mtimeMs : 0;
  }

  async harvestSession() {
    const match = this.findLatestChatSessionFile();
    if (!match) return null;
    const events = [];
    try {
      const raw = JSON.parse(fs.readFileSync(match.filePath, 'utf8'));
      const requests = raw.requests || [];
      for (const req of requests.slice(-30)) {
        const msg = req?.message?.text || req?.message;
        if (typeof msg === 'string' && msg.trim()) {
          events.push({ role: 'user', content: msg.trim() });
        }
      }
    } catch {
      // Ignore
    }
    return {
      agent: 'vscode',
      sessionId: match.sessionId,
      mtimeMs: match.mtimeMs,
      rawEvents: events,
    };
  }
}

export class ClineHarvester extends SessionHarvester {
  getAgentName() {
    return 'cline';
  }

  getTasksDir() {
    if (this.env.CLINE_TASKS_DIR) return this.env.CLINE_TASKS_DIR;
    if (process.platform === 'darwin') {
      return path.join(
        this.homeDir,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'tasks'
      );
    }
    if (process.platform === 'win32') {
      const appData = this.env.APPDATA || path.join(this.homeDir, 'AppData', 'Roaming');
      return path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
    }
    return path.join(this.homeDir, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
  }

  findMatchingTask() {
    const tasksDir = this.getTasksDir();
    if (!fs.existsSync(tasksDir)) return null;
    const matches = [];
    try {
      const dirs = fs.readdirSync(tasksDir, { withFileTypes: true }).slice(0, 50);
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const uiMsgPath = path.join(tasksDir, d.name, 'ui_messages.json');
        if (!fs.existsSync(uiMsgPath)) continue;
        try {
          const stat = fs.statSync(uiMsgPath);
          const headSlice = fs.readFileSync(uiMsgPath, 'utf8').slice(0, 16384);
          if (headSlice.includes(this.projectRoot)) {
            matches.push({ filePath: uiMsgPath, sessionId: d.name, mtimeMs: stat.mtimeMs });
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      return null;
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matches[0] || null;
  }

  async getProjectScopedLatestMtime() {
    const match = this.findMatchingTask();
    return match ? match.mtimeMs : 0;
  }

  async harvestSession() {
    const match = this.findMatchingTask();
    if (!match) return null;
    const events = [];
    try {
      const arr = JSON.parse(fs.readFileSync(match.filePath, 'utf8'));
      if (Array.isArray(arr)) {
        for (const item of arr.slice(-40)) {
          if (item.say === 'user_feedback' || item.say === 'text') {
            events.push({ role: 'user', content: String(item.text || '') });
          }
        }
      }
    } catch {
      // Ignore
    }
    return {
      agent: 'cline',
      sessionId: match.sessionId,
      mtimeMs: match.mtimeMs,
      rawEvents: events,
    };
  }
}

export class OpenCodeHarvester extends SessionHarvester {
  getAgentName() {
    return 'opencode';
  }

  getDbPath() {
    const dataDir =
      this.env.OPENCODE_DATA_DIR || path.join(this.homeDir, '.local', 'share', 'opencode');
    return path.join(dataDir, 'opencode.db');
  }

  async getProjectScopedLatestMtime() {
    const dbPath = this.getDbPath();
    if (!fs.existsSync(dbPath)) return 0;
    try {
      const stat = fs.statSync(dbPath);
      if (stat.size > 32 * 1024 * 1024) return 0;
      const mtime = await readWalDatabaseSnapshot(dbPath, (db) => {
        try {
          const row = db
            .prepare(`SELECT updated_at FROM session WHERE directory = ? ORDER BY updated_at DESC LIMIT 1`)
            .get(this.projectRoot);
          if (row && row.updated_at) {
            return typeof row.updated_at === 'number'
              ? row.updated_at < 1e12
                ? row.updated_at * 1000
                : row.updated_at
              : new Date(row.updated_at).getTime();
          }
        } catch {
          return 0;
        }
        return 0;
      });
      return mtime || 0;
    } catch {
      return 0;
    }
  }

  async harvestSession() {
    const dbPath = this.getDbPath();
    if (!fs.existsSync(dbPath)) return null;
    const res = await readWalDatabaseSnapshot(dbPath, (db) => {
      try {
        const sess = db
          .prepare(`SELECT id, title, updated_at FROM session WHERE directory = ? ORDER BY updated_at DESC LIMIT 1`)
          .get(this.projectRoot);
        if (!sess) return null;
        const events = [{ role: 'user', content: String(sess.title || '') }];
        return {
          agent: 'opencode',
          sessionId: String(sess.id),
          mtimeMs: Date.now(),
          rawEvents: events,
        };
      } catch {
        return null;
      }
    });
    return res;
  }
}

export class WebExportHarvester {
  static parseExportJson(jsonText) {
    const data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    const events = [];

    // 1. ChatGPT conversations.json export format (mapping tree)
    const conv = Array.isArray(data) ? data[0] : data;
    if (conv && conv.mapping && typeof conv.mapping === 'object') {
      const nodes = Object.values(conv.mapping);
      for (const node of nodes) {
        const msg = node?.message;
        if (!msg || !msg.author) continue;
        const role = msg.author.role;
        const parts = msg.content?.parts || [];
        const text = parts.filter((p) => typeof p === 'string').join('\n');
        if (text && (role === 'user' || role === 'assistant')) {
          events.push({ role, content: text });
        }
      }
      return events;
    }

    // 2. Claude.ai export format (chat_messages array)
    if (conv && Array.isArray(conv.chat_messages)) {
      for (const msg of conv.chat_messages) {
        const role = msg.sender === 'human' ? 'user' : 'assistant';
        const text =
          typeof msg.text === 'string'
            ? msg.text
            : Array.isArray(msg.content)
              ? msg.content.map((c) => c.text || '').join('\n')
              : '';
        if (text) events.push({ role, content: text });
      }
      return events;
    }

    // 3. Generic messages array
    if (Array.isArray(conv?.messages)) {
      return conv.messages;
    }
    return events;
  }
}

/**
 * Task 3.5: Length-Adaptive Fuzzy Target Matcher (SRS C-14, UX-03 / TC-UX-01)
 */
export class FuzzyTargetMatcher {
  static CANONICAL_TARGETS = [
    'codex', 'claude', 'gemini', 'antigravity', 'vscode', 'cursor',
    'windsurf', 'cline', 'aider', 'opencode', 'goose', 'web', 'self',
  ];

  static ALIAS_MAP = new Map([
    ['cdx', 'codex'], ['cx', 'codex'], ['openai', 'codex'],
    ['cld', 'claude'], ['cc', 'claude'], ['anthropic', 'claude'],
    ['agy', 'antigravity'], ['anti', 'antigravity'], ['ide', 'antigravity'], ['gui', 'antigravity'],
    ['vsc', 'vscode'], ['code', 'vscode'], ['copilot', 'vscode'],
    ['cur', 'cursor'], ['ws', 'windsurf'], ['wind', 'windsurf'],
    ['gem', 'gemini'], ['chat', 'web'], ['chatgpt', 'web'], ['browser', 'web'],
  ]);

  static levenshtein(a, b) {
    const s = String(a).toLowerCase();
    const t = String(b).toLowerCase();
    const m = s.length;
    const n = t.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  }

  /**
   * Matches raw input to a canonical target name using length-adaptive edit distance:
   * - Input length <= 4: Only exact match, explicit ALIAS_MAP, or edit distance <= 1 (against targets >= 4 chars) is allowed.
   *   Prevents 3-letter words like 'cat', 'git', 'foo' from falsely matching 'web'.
   * - Input length >= 5: Edit distance <= 2 is allowed (e.g. 'claud' -> 'claude', 'codexx' -> 'codex', 'windsrff' -> 'windsurf').
   */
  static match(rawInput, candidates = FuzzyTargetMatcher.CANONICAL_TARGETS) {
    if (!rawInput || typeof rawInput !== 'string') {
      return { matched: null, distance: Infinity, via: 'none' };
    }
    const clean = rawInput.trim().toLowerCase();
    if (!clean) {
      return { matched: null, distance: Infinity, via: 'none' };
    }

    // 1. Exact match
    if (candidates.includes(clean)) {
      return { matched: clean, distance: 0, via: 'exact' };
    }

    // 2. Explicit Alias Map
    if (FuzzyTargetMatcher.ALIAS_MAP.has(clean)) {
      return { matched: FuzzyTargetMatcher.ALIAS_MAP.get(clean), distance: 0, via: 'alias' };
    }

    // 3. Length-adaptive Levenshtein fuzzy match
    const maxAllowedDistance = clean.length <= 4 ? 1 : 2;
    let bestTarget = null;
    let bestDist = Infinity;

    for (const candidate of candidates) {
      // Do not fuzzy-match short 3-4 letter inputs against 3-letter targets like 'web'
      if (clean.length <= 4 && candidate.length <= 3) continue;
      const dist = FuzzyTargetMatcher.levenshtein(clean, candidate);
      if (dist <= maxAllowedDistance && dist < bestDist) {
        bestDist = dist;
        bestTarget = candidate;
      }
    }

    if (bestTarget) {
      return { matched: bestTarget, distance: bestDist, via: 'fuzzy' };
    }
    return { matched: null, distance: Infinity, via: 'none' };
  }
}

/**
 * Task 3.5: SmartInferenceEngine with Project-Scoped cwd Isolation (SRS C-14 / TC-INFER-01, TC-INFER-02)
 */
export class SmartInferenceEngine {
  static createHarvesters(projectRoot, env = process.env) {
    return [
      new ClaudeHarvester(projectRoot, env),
      new CodexHarvester(projectRoot, env),
      new GeminiHarvester(projectRoot, env),
      new AiderHarvester(projectRoot, env),
      new AntigravityHarvester(projectRoot, env),
      new CursorHarvester(projectRoot, env),
      new VSCodeCopilotHarvester(projectRoot, env),
      new ClineHarvester(projectRoot, env),
      new OpenCodeHarvester(projectRoot, env),
    ];
  }

  /**
   * Auto-detects the most recently active source agent strictly scoped to `projectRoot` (cwd).
   * Prevents cross-project session bleed from other open terminals or background IDEs.
   */
  static async autoDetectSource(projectRoot, env = process.env) {
    const harvesters = SmartInferenceEngine.createHarvesters(projectRoot, env);
    let bestAgent = null;
    let bestMtime = 0;
    let bestHarvester = null;

    for (const h of harvesters) {
      const mtime = await h.getProjectScopedLatestMtime();
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestAgent = h.getAgentName();
        bestHarvester = h;
      }
    }

    return {
      agent: bestAgent || 'git',
      mtimeMs: bestMtime,
      harvester: bestHarvester,
    };
  }

  static resolveTarget(rawTargetArg, installedAgents = FuzzyTargetMatcher.CANONICAL_TARGETS) {
    return FuzzyTargetMatcher.match(rawTargetArg, installedAgents);
  }

  static getPreviousSource(projectRoot) {
    const batonJsonPath = path.join(projectRoot, '.vicem', 'baton.json');
    if (fs.existsSync(batonJsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(batonJsonPath, 'utf8'));
        if (data?.source?.agent) {
          return {
            agent: data.source.agent,
            sessionId: data.source.sessionId || null,
            previousTarget: data.target?.agent || null,
            mountedRuleFile: data.target?.mountedRuleFile || null,
          };
        }
      } catch {
        // Ignore malformed baton.json
      }
    }
    return null;
  }

  static recommendNextTarget(sourceAgent, installedAgents = ['codex', 'claude', 'antigravity', 'web', 'self']) {
    const fallbackOrder = ['codex', 'claude', 'antigravity', 'gemini', 'web', 'self'];
    for (const candidate of fallbackOrder) {
      if (candidate !== sourceAgent && installedAgents.includes(candidate)) {
        return candidate;
      }
    }
    return 'codex';
  }
}

// ============================================================================
// PHASE 4: U-SHAPED BATON IA BUILDER & 3-PILLAR DEFENSIVE SAFETY GUARDS
// ============================================================================

/**
 * Task 4.2: Pre-Handoff Lossless Snapshot Store (SRS C-13 / SAD §4.3 / TC-GUARD-01)
 * Protects uncommitted user work by backing up modified working-tree files before handoff
 * and restoring from snapshot rather than calling destructive `git checkout --`.
 */
export class PreHandoffSnapshotStore {
  static getSnapshotDir(projectRoot, batonId) {
    return path.join(projectRoot, '.vicem', 'snapshots', batonId);
  }

  static saveSnapshot(projectRoot, batonId, relFilePaths = []) {
    const resolvedRoot = path.resolve(projectRoot);
    const snapDir = PreHandoffSnapshotStore.getSnapshotDir(resolvedRoot, batonId);
    AtomicFs.ensureDir(snapDir);

    const savedFiles = [];
    for (const relPath of relFilePaths) {
      if (!relPath || isCredentialFile(relPath)) continue;
      if (!AtomicFs.isSafeRepoFilePath(resolvedRoot, relPath)) continue;
      const absSrc = path.resolve(resolvedRoot, relPath);
      if (!fs.existsSync(absSrc)) continue;
      try {
        const stat = fs.statSync(absSrc);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const absDest = path.join(snapDir, relPath);
        AtomicFs.ensureDir(path.dirname(absDest));
        fs.copyFileSync(absSrc, absDest);
        savedFiles.push(relPath);
      } catch {
        // Ignore unreadable file
      }
    }

    AtomicFs.writeFileAtomic(
      path.join(snapDir, '_manifest.json'),
      JSON.stringify({ batonId, createdAt: new Date().toISOString(), files: savedFiles }, null, 2)
    );
    PreHandoffSnapshotStore.pruneOldSnapshots(resolvedRoot, 5);
    return { batonId, snapDir, savedFiles };
  }

  static restoreSnapshot(projectRoot, batonId, relFilePath = null) {
    const resolvedRoot = path.resolve(projectRoot);
    const snapDir = PreHandoffSnapshotStore.getSnapshotDir(resolvedRoot, batonId);
    const manifestPath = path.join(snapDir, '_manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { restored: false, restoredFiles: [] };
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const targets = relFilePath ? [relFilePath] : manifest.files || [];
    const restoredFiles = [];

    for (const rel of targets) {
      if (!AtomicFs.isSafeRepoFilePath(resolvedRoot, rel)) continue;
      const snapFile = path.join(snapDir, rel);
      const destFile = path.resolve(resolvedRoot, rel);
      if (fs.existsSync(snapFile)) {
        const content = fs.readFileSync(snapFile, 'utf8');
        AtomicFs.writeFileAtomic(destFile, content);
        restoredFiles.push(rel);
      }
    }

    return { restored: restoredFiles.length > 0, restoredFiles };
  }

  static getLatestSnapshotId(projectRoot) {
    const batonJsonPath = path.join(projectRoot, '.vicem', 'baton.json');
    if (fs.existsSync(batonJsonPath)) {
      try {
        const baton = JSON.parse(fs.readFileSync(batonJsonPath, 'utf8'));
        if (baton?.id) return baton.id;
      } catch {
        // Fall through
      }
    }
    const baseDir = path.join(projectRoot, '.vicem', 'snapshots');
    if (!fs.existsSync(baseDir)) return null;
    try {
      const dirs = fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(baseDir, d.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return dirs.length > 0 ? dirs[0].name : null;
    } catch {
      return null;
    }
  }

  static pruneOldSnapshots(projectRoot, keepCount = 5) {
    const baseDir = path.join(projectRoot, '.vicem', 'snapshots');
    if (!fs.existsSync(baseDir)) return;
    try {
      const dirs = fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const full = path.join(baseDir, d.name);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (let i = keepCount; i < dirs.length; i++) {
        fs.rmSync(dirs[i].full, { recursive: true, force: true });
      }
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Task 9.2 (Fix 9-B): ContextFileRanker — Locality-Aware Smart File Ranking & 1-Hop Local Import Resolver
 * Prioritizes:
 *   1. Files mentioned in error logs / failing stacktraces (+100)
 *   2. Files mentioned in user prompts / Immediate NEXT (+80)
 *   3. Git modified files (+50)
 *   4. 1-Hop local imported type/contract files (+30, supports TS .js->.ts mapping, @/* alias, and Python relative imports)
 */
export class ContextFileRanker {
  static CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs'];

  static resolveImportCandidate(projectRoot, importerRelPath, rawSpecifier) {
    if (!rawSpecifier || typeof rawSpecifier !== 'string') return null;
    const spec = rawSpecifier.trim();
    const importerDir = path.dirname(path.join(projectRoot, importerRelPath));

    let baseCandidate = null;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      baseCandidate = path.resolve(importerDir, spec);
    } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
      const sub = spec.slice(2);
      const srcTry = path.resolve(projectRoot, 'src', sub);
      const rootTry = path.resolve(projectRoot, sub);
      baseCandidate = fs.existsSync(srcTry) || fs.existsSync(srcTry + '.ts') ? srcTry : rootTry;
    } else if (spec.startsWith('.')) {
      // Python relative import like `from .models import User`
      const cleanPy = spec.replace(/^\.+/, '');
      if (!cleanPy) return null;
      baseCandidate = path.resolve(importerDir, cleanPy.replace(/\./g, '/'));
    } else {
      return null;
    }

    if (!AtomicFs.isSafeRepoFilePath(projectRoot, baseCandidate)) return null;

    // Handle TS ESM `.js` -> `.ts` / `.tsx` remapping (Fix 9-B)
    const strippedJs = baseCandidate.replace(/\.(?:js|jsx|mjs)$/i, '');
    const basesToTry = strippedJs !== baseCandidate ? [baseCandidate, strippedJs] : [baseCandidate];

    for (const b of basesToTry) {
      for (const ext of ContextFileRanker.CANDIDATE_EXTS) {
        const tryPath = b + ext;
        if (fs.existsSync(tryPath)) {
          try {
            if (fs.statSync(tryPath).isFile()) {
              return path.relative(projectRoot, tryPath).replace(/\\/g, '/');
            }
          } catch {}
        }
      }
      // Directory index fallback
      for (const idxExt of ['.ts', '.tsx', '.js']) {
        const idxPath = path.join(b, `index${idxExt}`);
        if (fs.existsSync(idxPath)) {
          return path.relative(projectRoot, idxPath).replace(/\\/g, '/');
        }
      }
    }
    return null;
  }

  static extractLocalImports(projectRoot, relFilePath, content) {
    const imports = new Set();
    if (!content || typeof content !== 'string') return [];

    // 1. JS/TS import/export from & require()
    const jsRegex = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = jsRegex.exec(content)) !== null) {
      const spec = m[1] || m[2];
      const resolved = ContextFileRanker.resolveImportCandidate(projectRoot, relFilePath, spec);
      if (resolved) imports.add(resolved);
    }

    // 2. Python relative imports (`from .types import ...`)
    if (relFilePath.endsWith('.py')) {
      const pyRegex = /^\s*from\s+(\.[A-Za-z0-9_.]+)\s+import\b/gm;
      while ((m = pyRegex.exec(content)) !== null) {
        const resolved = ContextFileRanker.resolveImportCandidate(projectRoot, relFilePath, m[1]);
        if (resolved) imports.add(resolved);
      }
    }

    return [...imports];
  }

  static rankFiles({
    projectRoot,
    modifiedFiles = [],
    errorLog = '',
    taskContext = null,
    maxFiles = 12,
  }) {
    const resolvedRoot = path.resolve(projectRoot);
    const noiseGate = new NoiseGate(resolvedRoot);
    const scores = new Map();

    const addScore = (relFile, pts) => {
      if (!relFile) return;
      const norm = relFile.replace(/\\/g, '/');
      if (noiseGate.isIgnored(norm)) return;
      const full = path.join(resolvedRoot, norm);
      if (!fs.existsSync(full)) return;
      scores.set(norm, (scores.get(norm) || 0) + pts);
    };

    const promptCorpus = [
      taskContext?.goal || '',
      ...(taskContext?.immediateNext || []),
      ...(taskContext?.userPrompts || []),
    ].join('\n');

    // 1. Score modified files (+50 base, +100 if in errorLog, +80 if in prompts)
    for (const rel of modifiedFiles) {
      const norm = rel.replace(/\\/g, '/');
      const baseName = path.basename(norm);
      addScore(norm, 50);
      if (errorLog && (errorLog.includes(norm) || errorLog.includes(baseName))) {
        addScore(norm, 100);
      }
      if (promptCorpus && (promptCorpus.includes(norm) || promptCorpus.includes(baseName))) {
        addScore(norm, 80);
      }
    }

    // 2. Discover 1-Hop local imports from top modified files (bonus +65 when imported by an error-log/prompt file, +30 otherwise)
    const sortedModified = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const topModified = sortedModified.slice(0, 8);

    for (const [modFile, modScore] of topModified) {
      try {
        const full = path.join(resolvedRoot, modFile);
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.size <= 256 * 1024) {
          const text = fs.readFileSync(full, 'utf8');
          const hopImports = ContextFileRanker.extractLocalImports(resolvedRoot, modFile, text);
          const importWeight = modScore >= 100 ? 65 : 30;
          for (const imp of hopImports) {
            addScore(imp, importWeight);
          }
        }
      } catch {
        // Ignore unreadable
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFiles)
      .map(([file]) => file);
  }
}

/**
 * Task 4.1: Bookended U-Shaped Attention Baton Builder (SRS C-01 / IA-01 / TC-UX-04)
 */
export class BatonIaBuilder {
  static BOOT_PROMPT = 'Read .vicem/BATON.md carefully. Adopt the context and execute Immediate NEXT #1.';

  static build({
    projectRoot,
    sourceAgent = 'auto',
    targetAgent = 'codex',
    sessionId = null,
    taskContext = null,
    gitContext = null,
    errorLog = '',
    budgetTokens = 4000,
    role = null,
    fuzzyMatchedFrom = null,
  }) {
    const resolvedRoot = path.resolve(projectRoot || process.cwd());
    const batonId = `baton-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const git = gitContext || GitCollector.collect(resolvedRoot);
    const task = taskContext || DeterministicTaskExtractor.extract([], git);

    // 1. Save Pre-Handoff Snapshot of modified working tree files before target touches them
    const filesToBackup = [...(git.modifiedFiles || []), ...(git.untrackedFiles || [])];
    PreHandoffSnapshotStore.saveSnapshot(resolvedRoot, batonId, filesToBackup);

    // 2. Diet Engine stage processing (Code Skeletons + Slimmed Logs + Diff)
    const dietEngine = new DietEngine(resolvedRoot);
    dietEngine.ledger.batonId = batonId;

    const slimmedLog = errorLog ? dietEngine.dietLog(errorLog) : '';
    const codeSkeletons = new Map();
    let rawContentBuffer = [
      task.goal,
      ...(task.done || []),
      ...(task.immediateNext || []),
      git.diffPatch || '',
      errorLog || '',
    ].join('\n');

    // Read and skeletonize ranked files (error-log files + prompt files + modified files + 1-hop local imports — Fix 9-B)
    const rankedFiles = ContextFileRanker.rankFiles({
      projectRoot: resolvedRoot,
      modifiedFiles: git.modifiedFiles || [],
      errorLog,
      taskContext: task,
      maxFiles: 12,
    });

    for (const relFile of rankedFiles) {
      const fullPath = path.join(resolvedRoot, relFile);
      if (!fs.existsSync(fullPath) || dietEngine.noiseGate.isIgnored(relFile)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size > 256 * 1024) continue;
        const rawCode = fs.readFileSync(fullPath, 'utf8');
        rawContentBuffer += '\n' + rawCode;
        const { omitted, skeleton } = dietEngine.dietCode(relFile, rawCode);
        if (!omitted && skeleton) {
          codeSkeletons.set(relFile, skeleton);
        }
      } catch {
        // Ignore unreadable file
      }
    }

    const rawTokens = Math.max(
      TokenEstimator.estimate(rawContentBuffer),
      (task.userPrompts || []).reduce((acc, p) => acc + TokenEstimator.estimate(p), 0)
    );

    // Assemble Zone 2 (Middle Evidence) with budget awareness
    const doneSection =
      (task.done || []).length > 0
        ? task.done.map((d) => `- [x] ${d}`).join('\n')
        : '- [x] Initial repository state inspected';

    const nextSection = (task.immediateNext || [])
      .map((item, idx) => `${idx + 1}. **${item}**`)
      .join('\n');

    let diffBlock = git.diffPatch || git.diffSummary || 'No uncommitted diff';
    const maxDiffChars = Math.max(800, Math.floor(budgetTokens * 1.8));
    if (diffBlock.length > maxDiffChars) {
      diffBlock = diffBlock.slice(0, maxDiffChars) + '\n... [diff truncated to fit token budget]';
    }

    const skeletonBlocks = [];
    let currentEstTokens = TokenEstimator.estimate(task.goal + nextSection + doneSection + diffBlock + slimmedLog);

    for (const [relFile, skel] of codeSkeletons.entries()) {
      const skelTokens = TokenEstimator.estimate(skel);
      if (currentEstTokens + skelTokens <= budgetTokens * 0.9) {
        skeletonBlocks.push(`### \`${relFile}\`\n\`\`\`\n${skel.trim()}\n\`\`\``);
        currentEstTokens += skelTokens;
      }
    }

    const ledgerEntries = dietEngine.ledger.entries;
    const ledgerGuide =
      ledgerEntries.length > 0
        ? ledgerEntries
            .map((e) => `- \`${e.filePath}\` :: \`${e.symbolName}\` (lines ${e.startLine}-${e.endLine})`)
            .join('\n')
        : '- All relevant code blocks included inline (0 symbols omitted).';

    //Preliminary unredacted markdown to measure final diet tokens
    const buildMarkdownWithCounts = (rawTok, dietTok) => {
      const ratio = rawTok > dietTok ? Math.round(((rawTok - dietTok) / rawTok) * 100) : 0;
      const roleTag = role ? ` | Role: ${role.toUpperCase()}` : '';
      const titleGoal = (task.goal || 'Project Context Baton').split('\n')[0].slice(0, 80);

      return [
        // ================= TOP PRIMACY ZONE (First 15%: Human 3s Scan & LLM Primacy Bias) =================
        `# BATON: ${titleGoal}`,
        `> Generated by Vicem v5.3 | Source: ${sourceAgent} → Target: ${targetAgent}${roleTag} | Diet: ${rawTok} → ${dietTok} tokens (-${ratio}%) | Commit: ${git.headCommit}`,
        ``,
        `## 1. Goal`,
        `${task.goal}`,
        ``,
        `## 2. Immediate NEXT`,
        `${nextSection}`,
        ``,
        // ================= MIDDLE EVIDENCE ZONE (Middle 75%: Structured Compressed Evidence) =================
        `## 3. Done`,
        `${doneSection}`,
        ``,
        `## 4. Work Evidence (Branch: \`${git.branch}\` @ \`${git.headCommit}\`)`,
        `### Modified Files (${(git.modifiedFiles || []).length})`,
        (git.modifiedFiles || []).length > 0
          ? git.modifiedFiles.map((f) => `- \`${f}\``).join('\n')
          : '- Clean working tree',
        ``,
        `### Git Diff`,
        `\`\`\`diff`,
        `${diffBlock.trim()}`,
        `\`\`\``,
        slimmedLog ? `\n### Slimmed Build/Test Logs\n\`\`\`text\n${slimmedLog}\n\`\`\`` : '',
        ``,
        `## 5. Architectural Context (Code Skeletons)`,
        skeletonBlocks.length > 0
          ? skeletonBlocks.join('\n\n')
          : '_No multi-line function skeletons required beyond diff._',
        ``,
        `## 6. Diet Ledger & Rehydration Index`,
        `If you need the full implementation of any skeletonized symbol (\`/* ... */\` or \`pass\`), call MCP tool \`vicem_rehydrate(file_path, symbol_name)\`:`,
        `${ledgerGuide}`,
        ``,
        // ================= BOTTOM RECENCY ZONE (Final 10%: LLM Recency Execution Anchor) =================
        `---`,
        `> ⚡ **EXECUTION ANCHOR:** Never write skeleton placeholders (\`{ ... }\`, \`/* ... */\`, \`pass\`) or \`‹REDACTED›\` tokens into source files. Call \`vicem_rehydrate(file, symbol)\` if full code is needed. Begin immediately from **Section 2 (Immediate NEXT #1)**.`,
      ]
        .filter((section) => section !== '')
        .join('\n');
    };

    const draftMd = buildMarkdownWithCounts(rawTokens, 1000);
    const dietTokens = TokenEstimator.estimate(draftMd);
    const effectiveRawTokens = Math.max(rawTokens, dietTokens);
    const unredactedMd = buildMarkdownWithCounts(effectiveRawTokens, dietTokens);

    // 3. ALWAYS run SecretRedactor as the final sealing stage (SRS C-06)
    const { sanitized: sealedMarkdown, redactedCount: mdRedactedCount } = SecretRedactor.redact(unredactedMd);
    const redactedCount = mdRedactedCount + (dietEngine.ledger.redactedCount || 0);
    const compressionRatio =
      effectiveRawTokens > dietTokens
        ? Number((((effectiveRawTokens - dietTokens) / effectiveRawTokens) * 100).toFixed(1))
        : 0;

    const batonJson = {
      version: '5.3',
      id: batonId,
      createdAt: new Date().toISOString(),
      source: {
        agent: sourceAgent,
        sessionId: sessionId || 'auto',
        autoDetected: true,
      },
      target: {
        agent: targetAgent,
        fuzzyMatchedFrom: fuzzyMatchedFrom || targetAgent,
        mountedRuleFile: null,
      },
      git: {
        branch: git.branch,
        headCommit: git.headCommit,
        modifiedFiles: git.modifiedFiles || [],
      },
      task: {
        goal: SecretRedactor.redact(task.goal).sanitized,
        immediateNext: (task.immediateNext || []).map((i) => SecretRedactor.redact(i).sanitized),
        done: (task.done || []).map((d) => SecretRedactor.redact(d).sanitized),
      },
      diet: {
        rawTokens: effectiveRawTokens,
        dietTokens,
        compressionRatio,
        redactedSecretsCount: redactedCount,
      },
      undoCommand: 'vicem back',
    };

    // Save .vicem/BATON.md, .vicem/baton.json, and .vicem/ledger.json atomically under process lock (BUG-06 Fix)
    const vicemDir = AtomicFs.ensureVicemDir(resolvedRoot);
    const batonMdPath = path.join(vicemDir, 'BATON.md');
    const batonJsonPath = path.join(vicemDir, 'baton.json');
    AtomicFs.acquireLock(resolvedRoot);
    try {
      AtomicFs.writeFileAtomic(batonMdPath, sealedMarkdown + '\n');
      AtomicFs.writeFileAtomic(batonJsonPath, JSON.stringify(batonJson, null, 2) + '\n');
      dietEngine.ledger.save(resolvedRoot);
    } finally {
      AtomicFs.releaseLock(resolvedRoot);
    }

    return {
      id: batonId,
      markdown: sealedMarkdown,
      json: batonJson,
      batonMdPath,
      batonJsonPath,
      ledger: dietEngine.ledger,
      rawTokens: effectiveRawTokens,
      dietTokens,
      compressionRatio,
      redactedCount,
    };
  }
}

/**
 * Task 4.3: 3-Pillar Safety Guard Engine & Self-Healing Prompt Generator
 * (SRS C-13, UX-04 / TC-GUARD-01, TC-GUARD-02, TC-UX-05)
 */
export class SkeletonWriteGuard {
  static DOC_EXEMPT_EXTS = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);

  static isDocFile(filePath) {
    if (!filePath || filePath === 'unknown') return false;
    const ext = path.extname(filePath).toLowerCase();
    return SkeletonWriteGuard.DOC_EXEMPT_EXTS.has(ext);
  }

  static PLACEHOLDER_PATTERNS = [
    { name: 'C_BLOCK_ELLIPSIS', regex: /\/\*\s*(?:\.\.\.|…)\s*\*\// },
    { name: 'BRACE_ELLIPSIS', regex: /\{\s*(?:\.\.\.|…)\s*\}/ },
    { name: 'VERTICAL_ELLIPSIS', regex: /⋮/ },
    {
      name: 'COMMENT_OMITTED',
      regex: /\/\/\s*(?:\.\.\.|…)\s*(?:rest of|existing code|omitted|implementation)/i,
    },
    { name: 'PYTHON_STUB_PASS', regex: /^\s*(?:def\s+[A-Za-z0-9_]+\([^)]*\)\s*:\s*pass|pass\s*#\s*\.\.\.)\s*$/ },
  ];

  static check(diffOrText, defaultFilePath = 'unknown') {
    if (!diffOrText || typeof diffOrText !== 'string') return [];
    const violations = [];
    const lines = diffOrText.split(/\r?\n/);
    let currentFile = defaultFilePath;
    let currentLineNum = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6).trim();
        continue;
      }
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentLineNum = parseInt(hunkMatch[1], 10) - 1;
        continue;
      }

      // Exempt pure documentation files (.md, .txt, .rst) from code skeleton placeholder false positives (BUG-08 Fix)
      if (SkeletonWriteGuard.isDocFile(currentFile)) {
        continue;
      }

      const isDiffFormat = diffOrText.includes('@@ ') || diffOrText.startsWith('diff ') || line.startsWith('+');
      if (isDiffFormat) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          currentLineNum++;
          const addedContent = line.slice(1);
          for (const rule of SkeletonWriteGuard.PLACEHOLDER_PATTERNS) {
            if (rule.regex.test(addedContent)) {
              violations.push({
                type: 'SKELETON_PLACEHOLDER',
                rule: rule.name,
                filePath: currentFile,
                line: currentLineNum || i + 1,
                snippet: addedContent.trim(),
              });
              break;
            }
          }
        } else if (!line.startsWith('-')) {
          currentLineNum++;
        }
      } else {
        for (const rule of SkeletonWriteGuard.PLACEHOLDER_PATTERNS) {
          if (rule.regex.test(line)) {
            violations.push({
              type: 'SKELETON_PLACEHOLDER',
              rule: rule.name,
              filePath: currentFile,
              line: i + 1,
              snippet: line.trim(),
            });
            break;
          }
        }
      }
    }

    return violations;
  }
}

export class SecretCommitGuard {
  static REDACTED_TOKEN_REGEX = /‹REDACTED:[A-Z0-9_]+:[0-9a-f]{4}›/;
  static MOUNT_MARKER_REGEX = /<!--\s*VICEM-BATON-(?:START|END)\s*-->/;

  static check(diffOrText, defaultFilePath = 'unknown') {
    if (!diffOrText || typeof diffOrText !== 'string') return [];
    const violations = [];
    const lines = diffOrText.split(/\r?\n/);
    let currentFile = defaultFilePath;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('-')) continue;

      if (SecretCommitGuard.REDACTED_TOKEN_REGEX.test(line)) {
        violations.push({
          type: 'REDACTED_TOKEN_LEAK',
          filePath: currentFile,
          line: i + 1,
          snippet: line.replace(/^\+/, '').trim(),
        });
      }
      if (SecretCommitGuard.MOUNT_MARKER_REGEX.test(line)) {
        violations.push({
          type: 'MOUNT_MARKER_LEAK',
          filePath: currentFile,
          line: i + 1,
          snippet: line.replace(/^\+/, '').trim(),
        });
      }
    }
    return violations;
  }
}

export class StalenessDriftGuard {
  static check(projectRoot) {
    const batonPath = path.join(projectRoot, '.vicem', 'baton.json');
    if (!fs.existsSync(batonPath)) {
      return { drifted: false, batonHead: null, currentHead: null };
    }
    try {
      const baton = JSON.parse(fs.readFileSync(batonPath, 'utf8'));
      const batonHead = baton?.git?.headCommit;
      const git = GitCollector.collect(projectRoot);
      const currentHead = git.headCommit;
      if (
        batonHead &&
        currentHead &&
        batonHead !== 'unknown' &&
        batonHead !== 'none' &&
        currentHead !== 'unknown' &&
        !currentHead.startsWith(batonHead) &&
        !batonHead.startsWith(currentHead)
      ) {
        return { drifted: true, batonHead, currentHead };
      }
      return { drifted: false, batonHead, currentHead };
    } catch {
      return { drifted: false, batonHead: null, currentHead: null };
    }
  }
}

export class SafetyGuardEngine {
  static collectCombinedGitDiff(resolvedRoot) {
    // Inspect BOTH staged (--staged) and unstaged changes so `git add . && vicem guard` never bypasses protection (BUG-01 Fix)
    const staged = GitCollector.execGit(['diff', '--staged', '-U0'], resolvedRoot) || '';
    const unstaged = GitCollector.execGit(['diff', '-U0'], resolvedRoot) || '';
    return [staged, unstaged].filter(Boolean).join('\n');
  }

  static verifyAndProtect(projectRoot, diffText = null, options = { autoRestore: true }) {
    const resolvedRoot = path.resolve(projectRoot || process.cwd());
    const textToInspect =
      diffText !== null ? diffText : SafetyGuardEngine.collectCombinedGitDiff(resolvedRoot);

    const skeletonViolations = SkeletonWriteGuard.check(textToInspect);
    const secretViolations = SecretCommitGuard.check(textToInspect);
    const driftStatus = StalenessDriftGuard.check(resolvedRoot);
    const allViolations = [...skeletonViolations, ...secretViolations];

    const restoredFiles = [];
    if (allViolations.length > 0 && options.autoRestore) {
      const latestSnapId = options.batonId || PreHandoffSnapshotStore.getLatestSnapshotId(resolvedRoot);
      if (latestSnapId) {
        const affectedFiles = [...new Set(allViolations.map((v) => v.filePath).filter((f) => f && f !== 'unknown'))];
        for (const relFile of affectedFiles) {
          const res = PreHandoffSnapshotStore.restoreSnapshot(resolvedRoot, latestSnapId, relFile);
          if (res.restored) {
            restoredFiles.push(...res.restoredFiles);
          }
        }
      }
    }

    return {
      passed: allViolations.length === 0,
      violations: allViolations,
      drift: driftStatus,
      restoredFiles,
    };
  }
}

// ============================================================================
// PHASE 5: MULTI-CHANNEL DELIVERY ADAPTERS & ZERO-TOUCH CLI UX LAYER
// ============================================================================

/**
 * Task 5.4: UxFormatter — 1-Line Terminal Receipt, Guard Recovery, Self-Heal Prompt & NO_COLOR Accessibility
 * (SRS C-15, UX-01, UX-04, UX-06 / TC-UX-02, TC-UX-03, TC-UX-05)
 */
export class UxFormatter {
  static isNoColor(env = process.env) {
    return Boolean(env.NO_COLOR || env.TERM === 'dumb');
  }

  static color(text, ansiCode, env = process.env) {
    if (UxFormatter.isNoColor(env)) return String(text);
    return `\x1b[${ansiCode}m${text}\x1b[0m`;
  }

  static capitalizeAgent(name) {
    const map = {
      claude: 'Claude',
      codex: 'Codex',
      gemini: 'Gemini',
      antigravity: 'Antigravity IDE',
      vscode: 'VS Code',
      cursor: 'Cursor',
      windsurf: 'Windsurf',
      cline: 'Cline',
      aider: 'Aider',
      opencode: 'OpenCode',
      goose: 'Goose',
      web: 'Web AI',
      self: 'Self-Pass',
      git: 'Git',
    };
    return map[String(name).toLowerCase()] || String(name);
  }

  /**
   * Renders a strictly single-line glanceable terminal receipt (UX-01 / TC-UX-02).
   */
  static renderReceipt(
    {
      sourceAgent = 'claude',
      targetAgent = 'codex',
      rawTokens = 0,
      dietTokens = 0,
      redactedCount = 0,
      undoCommand = 'vicem back',
      extraNote = '',
      fuzzyCorrectedFrom = null,
    },
    env = process.env
  ) {
    const noColor = UxFormatter.isNoColor(env);
    const badge = noColor ? '[OK]' : UxFormatter.color('✓', '32;1', env);
    const lockIcon = noColor ? 'Redacted:' : '🔒';
    const undoIcon = noColor ? 'Undo:' : '↩ Undo:';

    const srcLabel = UxFormatter.capitalizeAgent(sourceAgent);
    const tgtLabel = UxFormatter.capitalizeAgent(targetAgent);
    const rawStr = TokenEstimator.formatCount(rawTokens);
    const dietStr = TokenEstimator.formatCount(dietTokens);
    const ratio =
      rawTokens > dietTokens ? Math.round(((rawTokens - dietTokens) / rawTokens) * 100) : 0;

    const parts = [
      `${badge} [Vicem] ${srcLabel} → ${tgtLabel}`,
      `Diet: ${rawStr} → ${dietStr} (-${ratio}%)`,
      `${lockIcon} ${redactedCount} secrets`,
    ];
    if (fuzzyCorrectedFrom && fuzzyCorrectedFrom !== targetAgent) {
      parts.push(`Auto-corrected '${fuzzyCorrectedFrom}' → '${targetAgent}'`);
    }
    if (extraNote) {
      parts.push(extraNote);
    }
    parts.push(`${undoIcon} ${undoCommand}`);

    return parts.join(' | ').replace(/\r?\n/g, ' ');
  }

  /**
   * Renders actionable recovery instructions for human developers when a guard blocks an operation (UX-04 / TC-UX-05).
   */
  static renderGuardRecovery(violation, env = process.env) {
    const noColor = UxFormatter.isNoColor(env);
    const prefix = noColor ? '[ERR] [Vicem Guard]' : '🚨 \x1b[31;1m[Vicem Guard]\x1b[0m';
    const fileLoc = `${violation.filePath || 'unknown'}:${violation.line || 1}`;
    if (violation.type === 'SKELETON_PLACEHOLDER') {
      return `${prefix} Blocked skeleton placeholder '${violation.snippet}' in ${fileLoc} | Fix: Run 'vicem rollback' or restore from .vicem/snapshots/`;
    }
    if (violation.type === 'REDACTED_TOKEN_LEAK') {
      return `${prefix} Blocked leaked redaction token '${violation.snippet}' in ${fileLoc} | Fix: Replace placeholder with environment variable reference`;
    }
    if (violation.type === 'MOUNT_MARKER_LEAK') {
      return `${prefix} Blocked temporary mount marker in ${fileLoc} | Fix: Run 'vicem unmount' before committing`;
    }
    return `${prefix} Guard violation in ${fileLoc} | Fix: Run 'vicem rollback'`;
  }

  /**
   * Renders a self-healing system prompt for an AI agent that attempted to write a skeleton placeholder (UX-04 / TC-UX-05).
   */
  static renderAgentSelfHealPrompt(violation, symbolHint = 'targetSymbol') {
    const filePath = violation.filePath || 'unknown';
    const line = violation.line || 1;
    return `[VICEM SELF-HEAL]: Writing skeleton placeholder '${violation.snippet}' in ${filePath}:${line} is strictly forbidden. Call MCP tool vicem_rehydrate("${filePath}", "${symbolHint}") first to retrieve the omitted raw implementation, then write the complete code without placeholders.`;
  }
}

/**
 * Task 5.1: Session History Stack & CLI Launcher Adapter (SRS C-07 / UC-01, UC-07, UC-08)
 */
export class SessionHistoryStack {
  static getHistoryPath(projectRoot) {
    const vicemDir = AtomicFs.ensureVicemDir(projectRoot);
    return path.join(vicemDir, 'session_history.json');
  }

  static pushSession(projectRoot, entry) {
    const histPath = SessionHistoryStack.getHistoryPath(projectRoot);
    const stack = SessionHistoryStack.loadStack(projectRoot);
    stack.push({
      ...entry,
      pushedAt: new Date().toISOString(),
    });
    AtomicFs.writeFileAtomic(histPath, JSON.stringify(stack.slice(-20), null, 2));
    return stack;
  }

  static popSession(projectRoot) {
    const histPath = SessionHistoryStack.getHistoryPath(projectRoot);
    const stack = SessionHistoryStack.loadStack(projectRoot);
    if (stack.length === 0) return null;
    const popped = stack.pop();
    AtomicFs.writeFileAtomic(histPath, JSON.stringify(stack, null, 2));
    return popped;
  }

  static loadStack(projectRoot) {
    const histPath = path.join(projectRoot, '.vicem', 'session_history.json');
    if (!fs.existsSync(histPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(histPath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
}

export class CliLauncherAdapter {
  /**
   * Builds the launch specification for a CLI agent.
   * - Interactive Mode (default): Preserves TTY keyboard control (`stdio: 'inherit'`) and passes short Boot Prompt as positional arg.
   * - Headless Mode (`options.headless === true`): Uses `codex exec -` or `claude -p` with stdin pipe.
   * - Resume Mode (`options.resumeSessionId`): Resumes exact session ID (`claude --resume <id>`).
   */
  static buildLaunchSpec(targetAgent, baton, options = {}) {
    const agent = String(targetAgent).toLowerCase();
    const bootPrompt = options.bootPrompt || BatonIaBuilder.BOOT_PROMPT;
    const headless = Boolean(options.headless);
    const resumeId = options.resumeSessionId || null;
    const env = { ...process.env, ...(options.envVars || {}) };

    if (agent === 'claude') {
      if (resumeId) {
        return {
          command: 'claude',
          args: resumeId === 'last' ? ['-c'] : ['--resume', resumeId],
          stdio: 'inherit',
          input: undefined,
          env,
          mode: 'resume',
        };
      }
      if (headless) {
        return {
          command: 'claude',
          args: ['-p', bootPrompt],
          stdio: ['pipe', 'inherit', 'inherit'],
          input: baton?.markdown || bootPrompt,
          env,
          mode: 'headless',
        };
      }
      return {
        command: 'claude',
        args: [bootPrompt],
        stdio: 'inherit',
        input: undefined,
        env,
        mode: 'interactive',
      };
    }

    if (agent === 'codex') {
      if (resumeId) {
        return {
          command: 'codex',
          args: ['resume', '--last'],
          stdio: 'inherit',
          input: undefined,
          env,
          mode: 'resume',
        };
      }
      if (headless) {
        return {
          command: 'codex',
          args: ['exec', '-'],
          stdio: ['pipe', 'inherit', 'inherit'],
          input: baton?.markdown || bootPrompt,
          env,
          mode: 'headless',
        };
      }
      return {
        command: 'codex',
        args: [bootPrompt],
        stdio: 'inherit',
        input: undefined,
        env,
        mode: 'interactive',
      };
    }

    if (agent === 'gemini') {
      if (resumeId) {
        return {
          command: 'gemini',
          args: ['--resume', resumeId],
          stdio: 'inherit',
          input: undefined,
          env,
          mode: 'resume',
        };
      }
      return {
        command: 'gemini',
        args: [bootPrompt],
        stdio: 'inherit',
        input: undefined,
        env,
        mode: 'interactive',
      };
    }

    if (agent === 'aider') {
      return {
        command: 'aider',
        args: ['--message', bootPrompt],
        stdio: 'inherit',
        input: undefined,
        env,
        mode: 'interactive',
      };
    }

    if (agent === 'opencode') {
      return {
        command: 'opencode',
        args: [bootPrompt],
        stdio: 'inherit',
        input: undefined,
        env,
        mode: 'interactive',
      };
    }

    if (agent === 'goose') {
      return {
        command: 'goose',
        args: ['run', '--text', bootPrompt],
        stdio: 'inherit',
        input: undefined,
        env,
        mode: 'interactive',
      };
    }

    return {
      command: agent,
      args: [bootPrompt],
      stdio: 'inherit',
      input: undefined,
      env,
      mode: 'interactive',
    };
  }

  static deliver(targetAgent, baton, options = {}) {
    const spec = CliLauncherAdapter.buildLaunchSpec(targetAgent, baton, options);
    if (options.dryRun) {
      return { launched: false, dryRun: true, spec };
    }
    const res = childProcess.spawnSync(spec.command, spec.args, {
      cwd: options.projectRoot || process.cwd(),
      stdio: spec.stdio,
      input: spec.input,
      env: spec.env,
      encoding: 'utf8',
    });
    return {
      launched: res.error == null,
      status: res.status ?? 0,
      error: res.error ? res.error.message : null,
      spec,
    };
  }
}

/**
 * Task 5.2: Atomic Rule-File Mount & Byte-Exact Unmount Adapter (SRS C-07 / TC-DELIV-01)
 */
export class RuleMountAdapter {
  static START_MARKER = '<!-- VICEM-BATON-START -->';
  static END_MARKER = '<!-- VICEM-BATON-END -->';

  static TARGET_RULE_FILES = {
    antigravity: 'AGENTS.md',
    claude: 'AGENTS.md',
    codex: 'AGENTS.md',
    opencode: 'AGENTS.md',
    cursor: '.cursorrules',
    windsurf: '.windsurfrules',
    vscode: '.github/copilot-instructions.md',
    cline: '.clinerules',
    gemini: 'GEMINI.md',
  };

  static getRuleFilePath(projectRoot, targetAgent = 'antigravity') {
    const rel =
      RuleMountAdapter.TARGET_RULE_FILES[String(targetAgent).toLowerCase()] || 'AGENTS.md';
    return { relPath: rel, absPath: path.join(projectRoot, rel) };
  }

  static getBackupRegistryPath(projectRoot) {
    const vicemDir = AtomicFs.ensureVicemDir(projectRoot);
    return path.join(vicemDir, 'mount_backups.json');
  }

  static loadBackups(projectRoot) {
    const p = path.join(projectRoot, '.vicem', 'mount_backups.json');
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return {};
    }
  }

  static mount(projectRoot, targetAgent, batonMarkdown) {
    const resolvedRoot = path.resolve(projectRoot);
    AtomicFs.ensureVicemDir(resolvedRoot);
    const { relPath, absPath } = RuleMountAdapter.getRuleFilePath(resolvedRoot, targetAgent);

    const backups = RuleMountAdapter.loadBackups(resolvedRoot);
    const existed = fs.existsSync(absPath);
    const currentContent = existed ? fs.readFileSync(absPath, 'utf8') : '';

    // Save pristine backup only if not already mounted
    if (!currentContent.includes(RuleMountAdapter.START_MARKER)) {
      backups[relPath] = {
        existed,
        originalContent: currentContent,
        mountedAt: new Date().toISOString(),
      };
      AtomicFs.writeFileAtomic(
        RuleMountAdapter.getBackupRegistryPath(resolvedRoot),
        JSON.stringify(backups, null, 2)
      );
    }

    const baseContent = backups[relPath] ? backups[relPath].originalContent : currentContent;
    const mountBlock = `${RuleMountAdapter.START_MARKER}\n${batonMarkdown.trim()}\n${RuleMountAdapter.END_MARKER}`;
    const separator = baseContent.length > 0 && !baseContent.endsWith('\n') ? '\n\n' : baseContent.length > 0 ? '\n' : '';
    const updatedContent = baseContent + separator + mountBlock + '\n';

    AtomicFs.writeFileAtomic(absPath, updatedContent);
    return { mounted: true, relPath, absPath };
  }

  static unmount(projectRoot, targetAgent = null) {
    const resolvedRoot = path.resolve(projectRoot);
    const backups = RuleMountAdapter.loadBackups(resolvedRoot);
    const targetsToRestore = targetAgent
      ? [RuleMountAdapter.getRuleFilePath(resolvedRoot, targetAgent).relPath]
      : Object.keys(backups);

    const unmountedFiles = [];
    for (const relPath of targetsToRestore) {
      const absPath = path.join(resolvedRoot, relPath);
      const record = backups[relPath];

      if (record) {
        if (!record.existed) {
          if (fs.existsSync(absPath)) {
            const current = fs.readFileSync(absPath, 'utf8');
            const stripped = current
              .replace(/\n?<!-- VICEM-BATON-START -->[\s\S]*?<!-- VICEM-BATON-END -->\n?/g, '')
              .trim();
            if (!stripped) {
              fs.unlinkSync(absPath);
            } else {
              // User added content to the newly created rule file while mounted — preserve user content! (BUG-05 Fix)
              AtomicFs.writeFileAtomic(absPath, stripped + '\n');
            }
          }
        } else if (fs.existsSync(absPath)) {
          const current = fs.readFileSync(absPath, 'utf8');
          const stripped = current.replace(
            /\n?<!-- VICEM-BATON-START -->[\s\S]*?<!-- VICEM-BATON-END -->\n?/g,
            ''
          );
          if (stripped.trim() === (record.originalContent || '').trim()) {
            // Byte-exact restoration when user made no external edits outside markers (TC-DELIV-01)
            AtomicFs.writeFileAtomic(absPath, record.originalContent);
          } else {
            // Preserve user's external edits outside the mount markers (BUG-05 Fix)
            const trail = record.originalContent.endsWith('\n') && !stripped.endsWith('\n') ? '\n' : '';
            AtomicFs.writeFileAtomic(absPath, stripped + trail);
          }
        }
        delete backups[relPath];
        unmountedFiles.push(relPath);
      } else if (fs.existsSync(absPath)) {
        // Fallback regex strip if backup record was missing
        const content = fs.readFileSync(absPath, 'utf8');
        if (content.includes(RuleMountAdapter.START_MARKER)) {
          const stripped = content.replace(
            /\n?<!-- VICEM-BATON-START -->[\s\S]*?<!-- VICEM-BATON-END -->\n?/g,
            ''
          );
          AtomicFs.writeFileAtomic(absPath, stripped);
          unmountedFiles.push(relPath);
        }
      }
    }

    if (fs.existsSync(path.join(resolvedRoot, '.vicem'))) {
      AtomicFs.writeFileAtomic(
        RuleMountAdapter.getBackupRegistryPath(resolvedRoot),
        JSON.stringify(backups, null, 2)
      );
    }
    return { unmounted: unmountedFiles.length > 0, unmountedFiles };
  }
}

/**
 * Task 5.3: Clipboard & OSC 52 Adapter (512 KiB Safe Chunking + tmux DCS Passthrough)
 * (SRS C-07, §5.3 / UC-17 / TC-DELIV-02)
 */
export class ClipboardAdapter {
  static MAX_OSC52_CHUNK_BYTES = 512 * 1024; // 512 KiB safe limit for tmux 1 MiB INPUT_BUF_DEFAULT_SIZE [V-SRC]

  static encodeOsc52Chunks(text, env = process.env) {
    const buf = Buffer.from(String(text ?? ''), 'utf8');
    // 3 raw bytes produce 4 base64 bytes; max raw bytes per 512 KiB base64 chunk = 384 KiB (393,216 bytes)
    const maxRawChunkSize = Math.floor((ClipboardAdapter.MAX_OSC52_CHUNK_BYTES * 3) / 4);
    const chunks = [];
    const isTmux = Boolean(env.TMUX);

    if (buf.length === 0) {
      const seq = isTmux ? `\x1bPtmux;\x1b\x1b]52;c;\x07\x1b\\` : `\x1b]52;c;\x07`;
      return [seq];
    }

    for (let offset = 0; offset < buf.length; offset += maxRawChunkSize) {
      const slice = buf.subarray(offset, Math.min(buf.length, offset + maxRawChunkSize));
      const b64 = slice.toString('base64');
      assertChunkSize: if (b64.length > ClipboardAdapter.MAX_OSC52_CHUNK_BYTES) {
        break assertChunkSize;
      }
      const seq = isTmux
        ? `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`
        : `\x1b]52;c;${b64}\x07`;
      chunks.push(seq);
    }
    return chunks;
  }

  static writeOsc52(text, env = process.env, stream = process.stdout) {
    const chunks = ClipboardAdapter.encodeOsc52Chunks(text, env);
    for (const seq of chunks) {
      stream.write(seq);
    }
    return { chunksCount: chunks.length, chunks };
  }

  static copyNative(text) {
    const platform = process.platform;
    const commands =
      platform === 'darwin'
        ? [['pbcopy', []]]
        : platform === 'win32'
          ? [
              [
                'powershell',
                [
                  '-NoProfile',
                  '-Command',
                  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
                ],
              ],
              ['clip', []],
            ]
          : [
              ['wl-copy', []],
              ['xclip', ['-selection', 'clipboard']],
              ['xsel', ['--clipboard', '--input']],
            ];

    for (const [cmd, args] of commands) {
      try {
        const res = childProcess.spawnSync(cmd, args, {
          input: String(text),
          encoding: 'utf8',
          env: { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' },
          timeout: 2000,
        });
        if (res.status === 0 && !res.error) {
          return { copied: true, method: cmd };
        }
      } catch {
        // Try next clipboard utility
      }
    }
    return { copied: false, method: 'none' };
  }

  static pasteNative() {
    const platform = process.platform;
    const commands =
      platform === 'darwin'
        ? [['pbpaste', []]]
        : platform === 'win32'
          ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
          : [
              ['wl-paste', []],
              ['xclip', ['-selection', 'clipboard', '-o']],
              ['xsel', ['--clipboard', '--output']],
            ];

    for (const [cmd, args] of commands) {
      try {
        const res = childProcess.spawnSync(cmd, args, {
          encoding: 'utf8',
          env: { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' },
          timeout: 2000,
        });
        if (res.status === 0 && typeof res.stdout === 'string') {
          return res.stdout;
        }
      } catch {
        // Try next
      }
    }
    return '';
  }
}

/**
 * Task 5.3b: Web AI URL Prefill (2,000-char Safe Threshold) & IDE Deep-Link Adapter
 * (SRS C-07, §5.4 / UC-02, UC-05 / TC-DELIV-03)
 */
export class UrlPrefillAdapter {
  static SAFE_URL_CHAR_LIMIT = 2000; // Above 2,000 chars, auto-fallback to Clipboard + Base URL [V-RUN]

  static WEB_PROVIDERS = {
    chatgpt: {
      baseUrl: 'https://chatgpt.com/',
      prefillTemplate: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
    },
    claude: {
      baseUrl: 'https://claude.ai/new',
      prefillTemplate: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
    },
    aistudio: {
      baseUrl: 'https://aistudio.google.com/prompts/new_chat',
      prefillTemplate: (q) => `https://aistudio.google.com/prompts/new_chat?prompt=${encodeURIComponent(q)}`,
    },
  };

  static deliverWeb(batonMarkdown, providerName = 'chatgpt', options = {}) {
    const provider =
      UrlPrefillAdapter.WEB_PROVIDERS[String(providerName).toLowerCase()] ||
      UrlPrefillAdapter.WEB_PROVIDERS.chatgpt;

    const text = String(batonMarkdown ?? '');
    if (text.length <= UrlPrefillAdapter.SAFE_URL_CHAR_LIMIT) {
      const url = provider.prefillTemplate(text);
      if (!options.dryRun) {
        UrlPrefillAdapter.openExternal(url);
      }
      return {
        mode: 'url_prefill',
        url,
        copiedToClipboard: false,
        charLength: text.length,
      };
    }

    // Fallback for > 2,000 chars: copy full baton to clipboard and open base URL cleanly
    if (!options.dryRun) {
      ClipboardAdapter.copyNative(text);
      UrlPrefillAdapter.openExternal(provider.baseUrl);
    }
    return {
      mode: 'clipboard_fallback',
      url: provider.baseUrl,
      copiedToClipboard: true,
      charLength: text.length,
    };
  }

  static buildIdeDeepLink(targetIde, projectRoot) {
    const resolved = path.resolve(projectRoot);
    const batonPath = path.join(resolved, '.vicem', 'BATON.md');
    const ide = String(targetIde).toLowerCase();
    if (ide === 'antigravity') return `antigravity-ide://file${batonPath}`;
    if (ide === 'cursor') return `cursor://file${batonPath}`;
    if (ide === 'windsurf') return `windsurf://file${batonPath}`;
    if (ide === 'vscode') return `vscode://file${batonPath}`;
    return `antigravity-ide://file${batonPath}`;
  }

  static openExternal(urlOrUri) {
    const opener =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'cmd'
          : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', urlOrUri] : [urlOrUri];
    try {
      childProcess.spawnSync(opener, args, { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Task 10.1 (Fix 10-B): SmartPatchApplier & 2-Phase Atomic Web Answer Landing Adapter (`vicem land` — UC-06)
 * - Phase 1 (All-or-Nothing Guard Validation): Inspects ALL extracted code blocks before touching disk.
 *   If even 1 block contains a skeleton placeholder (`{ … }`) or `‹REDACTED›` token, 0 files are modified.
 * - Phase 2 (Snapshot + Multi-Strategy Patch Apply):
 *   1. `<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE` block replacement (CRLF-normalized)
 *   2. Unified Diff (`@@ -a,b +c,d @@`) hunk patching
 *   3. Unique-Symbol Partial Function Splice (replaces only the matching function if unique in target file)
 *   4. Full file write (when creating new file or replacing full module)
 */
export class SmartPatchApplier {
  static normalizeLf(str) {
    return String(str ?? '').replace(/\r\n/g, '\n');
  }

  static applySearchReplaceBlocks(existingContent, blockCode) {
    const normExisting = SmartPatchApplier.normalizeLf(existingContent);
    const normPatch = SmartPatchApplier.normalizeLf(blockCode);
    const srRegex = /<<<<<<<\s*SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>\s*REPLACE/g;
    let updated = normExisting;
    let matchedAny = false;
    let m;

    while ((m = srRegex.exec(normPatch)) !== null) {
      const searchPart = m[1];
      const replacePart = m[2];
      if (updated.includes(searchPart)) {
        updated = updated.replace(searchPart, () => replacePart);
        matchedAny = true;
      } else {
        const searchTrimmed = searchPart.trim();
        const replaceTrimmed = replacePart.trim();
        if (searchTrimmed && updated.includes(searchTrimmed)) {
          updated = updated.replace(searchTrimmed, () => replaceTrimmed);
          matchedAny = true;
        } else {
          return { applied: false, content: existingContent, strategy: 'search_replace_failed' };
        }
      }
    }
    return matchedAny
      ? { applied: true, content: updated, strategy: 'search_replace' }
      : { applied: false, content: existingContent, strategy: 'none' };
  }

  static applyUnifiedDiff(existingContent, diffText) {
    const lines = SmartPatchApplier.normalizeLf(existingContent).split('\n');
    const diffLines = SmartPatchApplier.normalizeLf(diffText).split('\n');
    const hunks = [];
    let currentHunk = null;

    for (const line of diffLines) {
      if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ')) continue;
      const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hm) {
        currentHunk = { oldStart: parseInt(hm[1], 10), ops: [] };
        hunks.push(currentHunk);
        continue;
      }
      if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        currentHunk.ops.push({ type: line[0], text: line.slice(1) });
      }
    }

    if (hunks.length === 0) {
      return { applied: false, content: existingContent, strategy: 'none' };
    }

    let offsetDelta = 0;
    for (const hunk of hunks) {
      const removeAndContext = hunk.ops.filter((op) => op.type === '-' || op.type === ' ').map((op) => op.text);
      const replacementLines = hunk.ops.filter((op) => op.type === '+' || op.type === ' ').map((op) => op.text);
      let targetIdx = Math.max(0, hunk.oldStart - 1 + offsetDelta);

      // Search nearby window if line numbers shifted slightly
      let foundIdx = -1;
      for (let delta = 0; delta <= 10; delta++) {
        for (const sign of [0, -1, 1]) {
          const cand = targetIdx + delta * sign;
          if (cand < 0 || cand + removeAndContext.length > lines.length) continue;
          const matches = removeAndContext.every((rc, k) => lines[cand + k].trim() === rc.trim());
          if (matches) {
            foundIdx = cand;
            break;
          }
        }
        if (foundIdx >= 0) break;
      }

      if (foundIdx < 0) {
        return { applied: false, content: existingContent, strategy: 'unified_diff_failed' };
      }

      lines.splice(foundIdx, removeAndContext.length, ...replacementLines);
      offsetDelta += replacementLines.length - removeAndContext.length;
    }

    return { applied: true, content: lines.join('\n'), strategy: 'unified_diff' };
  }

  static extractSingleFunctionSymbol(codeText) {
    const pairs = CodeSkeletonizer.findBalancedBraces(codeText);
    if (pairs.length === 0) return null;
    const outer = pairs[0];
    const headerSlice = codeText.slice(0, outer.openIdx);
    const { kind, symbol } = CodeSkeletonizer.classifyCBlockHeader(headerSlice);
    if (kind === 'function' && symbol) {
      return { symbol, fullSnippet: codeText.trim() };
    }
    return null;
  }

  static findUniqueSymbolSpanInFile(fileContent, targetSymbol) {
    const pairs = CodeSkeletonizer.findBalancedBraces(fileContent);
    const matches = [];
    let skipUntil = -1;

    for (const pair of pairs) {
      if (pair.openIdx < skipUntil) continue;
      const lookbackStart = Math.max(0, pair.openIdx - 500);
      const headerSlice = fileContent.slice(lookbackStart, pair.openIdx);
      const { kind, symbol } = CodeSkeletonizer.classifyCBlockHeader(headerSlice);
      if (kind === 'type') {
        skipUntil = pair.closeIdx;
        continue;
      }
      if (kind === 'function' && symbol === targetSymbol) {
        const sigStart = CodeSkeletonizer.findSignatureStartIdx(fileContent, pair.openIdx, symbol);
        matches.push({ startIdx: sigStart, endIdx: pair.closeIdx + 1 });
        skipUntil = pair.closeIdx;
      }
    }

    // Fix 10-B: Only splice if the symbol appears EXACTLY ONCE (unique match) in the file
    if (matches.length === 1) {
      return matches[0];
    }
    return null;
  }

  static applySmart(existingContent, blockCode, lang = '') {
    if (!existingContent) {
      return { applied: true, content: blockCode, strategy: 'full_write' };
    }

    // 1. SEARCH / REPLACE blocks
    if (blockCode.includes('<<<<<<< SEARCH') && blockCode.includes('>>>>>>> REPLACE')) {
      return SmartPatchApplier.applySearchReplaceBlocks(existingContent, blockCode);
    }

    // 2. Unified Diff hunks
    if (lang === 'diff' || lang === 'patch' || /^@@ -\d+/m.test(blockCode)) {
      return SmartPatchApplier.applyUnifiedDiff(existingContent, blockCode);
    }

    // 3. Unique Symbol Partial Function Splice (when snippet is a single function smaller than existing multi-symbol file)
    const existingLinesCount = existingContent.split(/\r?\n/).length;
    const snippetLinesCount = blockCode.split(/\r?\n/).length;
    if (existingLinesCount >= 10 && snippetLinesCount < existingLinesCount * 0.75) {
      const singleFn = SmartPatchApplier.extractSingleFunctionSymbol(blockCode);
      if (singleFn) {
        const uniqueSpan = SmartPatchApplier.findUniqueSymbolSpanInFile(existingContent, singleFn.symbol);
        if (uniqueSpan) {
          const spliced =
            existingContent.slice(0, uniqueSpan.startIdx) +
            singleFn.fullSnippet +
            existingContent.slice(uniqueSpan.endIdx);
          return { applied: true, content: spliced, strategy: 'unique_symbol_splice', symbol: singleFn.symbol };
        }
      }
    }

    // 4. Full file replacement
    return { applied: true, content: blockCode, strategy: 'full_write' };
  }
}

export class WebLandAdapter {
  static extractCodeBlocks(markdownText) {
    const blocks = [];
    const regex = /```([A-Za-z0-9_+-]*)(?:\s+([^\n`]+))?\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(String(markdownText ?? ''))) !== null) {
      let fileHint = (match[2] || '').trim() || null;
      const code = match[3];
      if (!fileHint) {
        // Also detect `// File: path/to/file.ts` or `+++ b/path/to/file.ts` inside the first 2 lines
        const firstLines = code.split(/\r?\n/).slice(0, 3).join('\n');
        const commentFileMatch =
          firstLines.match(/^(?:\/\/|#|--)\s*(?:File|filepath|path):\s*([^\s\n]+)/im) ||
          firstLines.match(/^\+\+\+\s+b\/([^\s\n]+)/m);
        if (commentFileMatch) {
          fileHint = commentFileMatch[1].trim();
        }
      }
      blocks.push({
        lang: (match[1] || '').trim(),
        fileHint,
        code,
      });
    }
    return blocks;
  }

  static land(projectRoot, answerText, options = { applyFiles: true }) {
    const resolvedRoot = path.resolve(projectRoot);
    const blocks = WebLandAdapter.extractCodeBlocks(answerText);
    const violations = [];

    // PHASE 1 (Fix 10-B): Validate ALL blocks against Safety Guards BEFORE touching any file on disk (All-or-Nothing)
    for (const block of blocks) {
      const skelViolations = SkeletonWriteGuard.check(block.code, block.fileHint || 'clipboard');
      const secViolations = SecretCommitGuard.check(block.code, block.fileHint || 'clipboard');
      violations.push(...skelViolations, ...secViolations);
    }

    if (violations.length > 0) {
      return {
        blocksCount: blocks.length,
        blocks,
        appliedFiles: [],
        strategies: [],
        guardPassed: false,
        violations,
      };
    }

    // PHASE 2: Snapshot target files first, then apply patches via SmartPatchApplier
    const targetRelFiles = blocks
      .map((b) => b.fileHint)
      .filter((f) => f && !isCredentialFile(f) && AtomicFs.isSafeRepoFilePath(resolvedRoot, f));
    if (options.applyFiles && targetRelFiles.length > 0) {
      PreHandoffSnapshotStore.saveSnapshot(
        resolvedRoot,
        `land-${Date.now()}`,
        targetRelFiles
      );
    }

    const appliedFiles = [];
    const strategies = [];

    for (const block of blocks) {
      if (
        options.applyFiles &&
        block.fileHint &&
        !isCredentialFile(block.fileHint) &&
        AtomicFs.isSafeRepoFilePath(resolvedRoot, block.fileHint)
      ) {
        const dest = path.resolve(resolvedRoot, block.fileHint);
        const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
        const patchRes = SmartPatchApplier.applySmart(existing, block.code, block.lang);
        if (patchRes.applied) {
          AtomicFs.writeFileAtomic(dest, patchRes.content);
          appliedFiles.push(block.fileHint);
          strategies.push({ file: block.fileHint, strategy: patchRes.strategy });
        }
      }
    }

    return {
      blocksCount: blocks.length,
      blocks,
      appliedFiles,
      strategies,
      guardPassed: true,
      violations: [],
    };
  }
}

/**
 * Task 5.4b: Zero-Arg Micro-TUI Selector (SRS UX-02 / SD-01)
 */
export class MicroTuiSelector {
  static async selectTarget({
    sourceAgent = 'claude',
    recommended = 'codex',
    candidates = ['codex', 'antigravity', 'web', 'self'],
    isTTY = process.stdin.isTTY && process.stdout.isTTY,
  }) {
    if (!isTTY) {
      return recommended;
    }

    const ordered = [recommended, ...candidates.filter((c) => c !== recommended)];
    const menuLine = ordered
      .map((c, idx) => (idx === 0 ? `[❯ ${c} (Recommended)]` : `${idx + 1}:${c}`))
      .join(' / ');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    return new Promise((resolve) => {
      rl.question(
        `? [Vicem] Pass baton from ${UxFormatter.capitalizeAgent(sourceAgent)} to ${menuLine} (Enter = ${recommended}, q = cancel): `,
        (answer) => {
          rl.close();
          const trimmed = (answer || '').trim().toLowerCase();
          if (trimmed === '' || trimmed === '1') {
            resolve(recommended);
            return;
          }
          if (trimmed === 'q' || trimmed === 'esc' || trimmed === 'cancel') {
            resolve(null);
            return;
          }
          const num = parseInt(trimmed, 10);
          if (!Number.isNaN(num) && num >= 1 && num <= ordered.length) {
            resolve(ordered[num - 1]);
            return;
          }
          const matched = FuzzyTargetMatcher.match(trimmed, ordered);
          resolve(matched.matched || recommended);
        }
      );
    });
  }
}


// ============================================================================
// PHASE 6: DUAL-ERA MCP SERVER, PROACTIVE PTY WRAPPER & FULL CLI ROUTER
// ============================================================================

/**
 * Task 6.1: Dual-Era JSON-RPC 2.0 stdio MCP Server Adapter (SRS C-08 / UC-12..14, UC-20 / TC-GUARD-03)
 * Strictly writes ONLY valid newline-delimited JSON-RPC 2.0 frames to stdout.
 */
export class McpServerAdapter {
  constructor(projectRoot = process.cwd()) {
    this.projectRoot = path.resolve(projectRoot);
  }

  static getToolsList() {
    return [
      {
        name: 'vicem_create_baton',
        description:
          'Creates a compressed U-Shaped Context Baton (.vicem/BATON.md) from the current project and git/session state.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'Primary engineering goal' },
            targetAgent: { type: 'string', description: 'Target agent identifier (e.g., codex, claude, ide)' },
            budgetTokens: { type: 'number', description: 'Token budget (default: 4000)' },
          },
        },
      },
      {
        name: 'vicem_read_baton',
        description: 'Reads the current .vicem/BATON.md and checks for git HEAD drift.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'vicem_rehydrate',
        description:
          'Restores the exact, secret-redacted source code of a skeletonized function/class from .vicem/ledger.json so you never write { ... } placeholders.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Relative file path (e.g. src/auth.ts)' },
            symbol_name: { type: 'string', description: 'Function, method, or class name (e.g. verifyJwt)' },
          },
          required: ['file_path', 'symbol_name'],
        },
      },
      {
        name: 'vicem_check_guard',
        description:
          'Verifies code or git diff against SkeletonWriteGuard, SecretCommitGuard, and StalenessDriftGuard.',
        inputSchema: {
          type: 'object',
          properties: {
            diff_text: { type: 'string', description: 'Optional diff or code text to inspect' },
          },
        },
      },
    ];
  }

  async handleRequest(req) {
    if (!req || typeof req !== 'object') return null;
    const { id, method, params } = req;

    // Notifications (no id) do not return a response frame
    if (id === undefined || id === null) {
      return null;
    }

    try {
      if (method === 'initialize') {
        const clientVersion = params?.protocolVersion || '2025-11-25';
        const supportedVersion =
          clientVersion === '2024-11-05' ? '2024-11-05' : '2025-11-25';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: supportedVersion,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: 'vicem-mcp',
              version: '5.3.0',
            },
          },
        };
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: McpServerAdapter.getToolsList(),
          },
        };
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName === 'vicem_create_baton') {
          const detected = await SmartInferenceEngine.autoDetectSource(this.projectRoot);
          const session = detected.harvester ? await detected.harvester.harvestSession() : null;
          const git = GitCollector.collect(this.projectRoot);
          const task = DeterministicTaskExtractor.extract(session?.rawEvents || [], git);
          if (args.goal) task.goal = args.goal;

          const baton = BatonIaBuilder.build({
            projectRoot: this.projectRoot,
            sourceAgent: detected.agent,
            targetAgent: args.targetAgent || 'codex',
            taskContext: task,
            gitContext: git,
            budgetTokens: args.budgetTokens || 4000,
          });
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: baton.markdown }],
              isError: false,
            },
          };
        }

        if (toolName === 'vicem_read_baton') {
          const batonPath = path.join(this.projectRoot, '.vicem', 'BATON.md');
          if (!fs.existsSync(batonPath)) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: 'No .vicem/BATON.md found in project.' }],
                isError: true,
              },
            };
          }
          const md = fs.readFileSync(batonPath, 'utf8');
          const drift = StalenessDriftGuard.check(this.projectRoot);
          const driftBanner = drift.drifted
            ? `> ⚠️ [STALENESS DRIFT WARNING]: Baton was created at commit ${drift.batonHead}, but current HEAD is ${drift.currentHead}.\n\n`
            : '';
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: driftBanner + md }],
              isError: false,
            },
          };
        }

        if (toolName === 'vicem_rehydrate') {
          const filePath = args.file_path || args.filePath;
          const symbolName = args.symbol_name || args.symbolName;
          const ledger = DietLedger.load(this.projectRoot);
          const rawCode = ledger.getEntry(filePath, symbolName);
          if (!rawCode) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Symbol '${symbolName}' in '${filePath}' not found in .vicem/ledger.json.`,
                  },
                ],
                isError: true,
              },
            };
          }
          // Enforce SecretRedactor on rehydrated output as defense-in-depth (SRS C-06 / UC-15)
          const { sanitized } = SecretRedactor.redact(rawCode);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: sanitized,
                },
              ],
              isError: false,
            },
          };
        }

        if (toolName === 'vicem_check_guard') {
          const res = SafetyGuardEngine.verifyAndProtect(
            this.projectRoot,
            args.diff_text || null,
            { autoRestore: false }
          );
          if (!res.passed) {
            const selfHealPrompts = res.violations.map((v) =>
              UxFormatter.renderAgentSelfHealPrompt(v)
            );
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: selfHealPrompts.join('\n') }],
                isError: true,
              },
            };
          }
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'OK: All 3 Safety Guards passed.' }],
              isError: false,
            },
          };
        }

        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message || 'Internal MCP server error' },
      };
    }
  }

  startStdio(inputStream = process.stdin, outputStream = process.stdout) {
    const rl = readline.createInterface({ input: inputStream, terminal: false });
    this._queue = Promise.resolve();
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this._queue = this._queue.then(async () => {
        try {
          const req = JSON.parse(trimmed);
          const resp = await this.handleRequest(req);
          if (resp) {
            outputStream.write(JSON.stringify(resp) + '\n');
          }
        } catch {
          outputStream.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }) + '\n'
          );
        }
      });
    });
    return rl;
  }
}

/**
 * Task 6.2: Proactive Quota Radar, TTY Sanitizer & PTY Wrapper (`vicem wrap`)
 * (SRS C-09, UX-05 / UC-19 / TC-UX-07)
 */
export class QuotaRadar {
  /**
   * High-specificity vendor rate-limit / quota / context-limit terminal banners [V-SRC].
   * Does NOT match generic "429" numbers inside user unit tests or HTTP logs.
   */
  static VENDOR_LIMIT_BANNERS = [
    {
      vendor: 'claude',
      reason: 'Claude usage limit reached',
      regex: /You've hit your limit\b|Prompt is too long\b|Claude usage limit reached/i,
    },
    {
      vendor: 'codex',
      reason: 'OpenAI Codex usage/rate limit reached',
      regex: /You've hit your usage limit\b|exceeded your current quota, please check your plan/i,
    },
    {
      vendor: 'gemini',
      reason: 'Gemini RESOURCE_EXHAUSTED quota limit',
      regex: /RESOURCE_EXHAUSTED:.*(?:quota|rate limit)|Quota exceeded for quota metric/i,
    },
    {
      vendor: 'copilot',
      reason: 'Copilot rate limit reached',
      regex: /Sorry, you have exceeded your Copilot token quota/i,
    },
  ];

  static MIN_IDLE_MS = 500;

  /**
   * Evaluates terminal output chunk + output idle time to avoid false positives on test logs
   * and user prompt echoes (Fix 10-A / TC-UX-07 / TC-ADV-04).
   */
  static detectVendorLimit(chunkText, idleMs = 500) {
    if (!chunkText || typeof chunkText !== 'string') {
      return { triggered: false, vendor: null, reason: null };
    }
    if (idleMs < QuotaRadar.MIN_IDLE_MS) {
      return { triggered: false, vendor: null, reason: 'Output stream still active (< 500ms idle)' };
    }

    // Strip ANSI codes and exclude user prompt input/echo lines (`> ...`, `? ...`, `$ ...`) (Fix 10-A)
    const cleanLines = chunkText
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:[>?$❯]|User:|Human:)\s+/.test(line));
    const clean = cleanLines.join('\n');

    for (const rule of QuotaRadar.VENDOR_LIMIT_BANNERS) {
      if (rule.regex.test(clean)) {
        return {
          triggered: true,
          vendor: rule.vendor,
          reason: rule.reason,
        };
      }
    }
    return { triggered: false, vendor: null, reason: null };
  }
}

export class TtySanitizer {
  // Exit alternate screen (?1049l), disable bracketed paste (?2004l), disable mouse tracking (?1000l, ?1006l), show cursor (?25h), reset style (0m)
  static RESET_SEQUENCE = '\x1b[?1049l\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[0m';

  static getResetSequence() {
    return TtySanitizer.RESET_SEQUENCE;
  }

  static sanitizeTerminal(outputStream = process.stdout, runStty = false) {
    try {
      outputStream.write(TtySanitizer.RESET_SEQUENCE);
      if (runStty && process.stdin.isTTY) {
        childProcess.spawnSync('stty', ['sane'], { stdio: 'inherit', timeout: 1000 });
      }
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Task 10.2 (Fix 10-A): PtyStreamInspector — Stateful Ring-Buffer & 500ms Idle Debounced Quota Watcher
 * Decouples stream chunk inspection from child_process so it can be deterministically tested and wired to async PTY streams.
 */
export class PtyStreamInspector {
  constructor({
    idleMs = QuotaRadar.MIN_IDLE_MS,
    onLimitDetected = null,
    outputStream = null,
  } = {}) {
    this.idleMs = idleMs;
    this.onLimitDetected = onLimitDetected;
    this.outputStream = outputStream;
    this.ringBuffer = '';
    this.timer = null;
    this.triggeredResult = null;
  }

  pushChunk(chunk) {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (this.outputStream) {
      this.outputStream.write(str);
    }
    this.ringBuffer = (this.ringBuffer + str).slice(-4096);

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.evaluateIdle(Math.max(this.idleMs, QuotaRadar.MIN_IDLE_MS));
    }, this.idleMs);
  }

  evaluateIdle(elapsedIdleMs = Math.max(this.idleMs, QuotaRadar.MIN_IDLE_MS)) {
    if (this.triggeredResult) return this.triggeredResult;
    const check = QuotaRadar.detectVendorLimit(this.ringBuffer, elapsedIdleMs);
    if (check.triggered) {
      this.triggeredResult = check;
      if (typeof this.onLimitDetected === 'function') {
        this.onLimitDetected(check);
      }
    }
    return check;
  }

  dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export class PtyWrapController {
  static renderCountdownPrompt(reason, targetAgent = 'codex', seconds = 3, env = process.env) {
    const noColor = UxFormatter.isNoColor(env);
    const icon = noColor ? '[WARN]' : '⏳';
    return `${icon} [Vicem Wrap] ${reason} detected! Auto-passing baton to ${UxFormatter.capitalizeAgent(targetAgent)} in ${seconds}s... (Enter: Now / Esc: Cancel)`;
  }

  static wrapCommand(agentCmd, agentArgs = [], options = {}) {
    const projectRoot = path.resolve(options.projectRoot || process.cwd());
    const fallbackTarget =
      options.fallbackTarget || SmartInferenceEngine.recommendNextTarget(agentCmd);

    if (options.dryRun) {
      return {
        wrapped: true,
        command: agentCmd,
        args: agentArgs,
        fallbackTarget,
        resetSequence: TtySanitizer.getResetSequence(),
      };
    }

    const useScript = process.platform === 'darwin' || process.platform === 'linux';
    const spawnCmd = useScript ? 'script' : agentCmd;
    const spawnArgs = useScript
      ? process.platform === 'darwin'
        ? ['-q', '/dev/null', agentCmd, ...agentArgs]
        : ['-q', '-c', [agentCmd, ...agentArgs].join(' '), '/dev/null']
      : agentArgs;

    const res = childProcess.spawnSync(spawnCmd, spawnArgs, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });

    TtySanitizer.sanitizeTerminal(process.stdout, true);
    return {
      wrapped: true,
      exitCode: res.status ?? 0,
      fallbackTarget,
    };
  }

  /**
   * Fix 10-A: Async Stream-Monitoring PTY Wrapper with Clean Child Termination BEFORE Stdin Countdown
   */
  static async wrapCommandAsync(agentCmd, agentArgs = [], options = {}) {
    const projectRoot = path.resolve(options.projectRoot || process.cwd());
    const fallbackTarget =
      options.fallbackTarget || SmartInferenceEngine.recommendNextTarget(agentCmd);
    const outStream = options.stdout || process.stdout;
    const env = options.env || process.env;

    if (options.dryRun) {
      return PtyWrapController.wrapCommand(agentCmd, agentArgs, options);
    }

    return new Promise((resolve) => {
      const child = childProcess.spawn(agentCmd, agentArgs, {
        cwd: projectRoot,
        stdio: ['inherit', 'pipe', 'pipe'],
        env,
      });

      let intercepted = null;
      const inspector = new PtyStreamInspector({
        idleMs: options.idleMs ?? 500,
        outputStream: outStream,
        onLimitDetected: (limitInfo) => {
          intercepted = limitInfo;
          // Fix 10-A: Terminate child FIRST and sanitize TTY BEFORE taking over stdin/countdown
          try {
            child.kill('SIGTERM');
          } catch {}
        },
      });

      child.stdout?.on('data', (chunk) => inspector.pushChunk(chunk));
      child.stderr?.on('data', (chunk) => inspector.pushChunk(chunk));

      child.on('close', (code) => {
        inspector.dispose();
        if (!intercepted) {
          // Final check on buffered output if process exited right after printing limit banner
          const finalCheck = inspector.evaluateIdle(QuotaRadar.MIN_IDLE_MS);
          if (finalCheck.triggered) {
            intercepted = finalCheck;
          }
        }
        TtySanitizer.sanitizeTerminal(outStream, false);
        if (intercepted) {
          outStream.write(
            '\n' +
              PtyWrapController.renderCountdownPrompt(
                intercepted.reason,
                fallbackTarget,
                3,
                env
              ) +
              '\n'
          );
        }
        resolve({
          wrapped: true,
          exitCode: code ?? 0,
          intercepted,
          fallbackTarget,
        });
      });
    });
  }
}

/**
 * Full 3-Tier CLI Router (`VicemApp`) supporting:
 * - Tier 1 Daily Zero-Flag: `vicem`, `vicem <target>`, `vicem back`, `vicem rollback`
 * - Tier 2 Explicit Workflow: `vicem self`, `vicem build`, `vicem review`, `vicem studio`, `vicem land`
 * - Tier 3 Plumbing & Automation: `vicem diet`, `vicem harvest`, `vicem mount`, `vicem unmount`, `vicem clip`, `vicem wrap`, `vicem guard`, `vicem mcp`, `vicem export-team`, `vicem fan-out`, `vicem fan-in`
 */
/**
 * Task 11.1 (Fix 11-A): HTML-Safe JSON Serialization for `<script type="application/json">` Hydration
 * Escapes `<`, `>`, `&`, `\u2028`, `\u2029` so source code containing `</script>` never causes Local XSS or parser breakage.
 */
export function safeJsonForHtmlScript(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export class StudioHydrationAdapter {
  static discoverSourceFilesFallback(root, maxFiles = 8) {
    const noiseGate = new NoiseGate(root);
    const found = [];
    const walk = (dir, relBase = '') => {
      if (found.length >= maxFiles) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= maxFiles) return;
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (noiseGate.isIgnored(rel)) continue;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else if (/\.(?:ts|tsx|js|jsx|mjs|py|go|rs)$/.test(entry.name)) {
          found.push(rel);
        }
      }
    };
    walk(root);
    return found;
  }

  static buildHydrationPayload(projectRoot, options = {}) {
    const root = path.resolve(projectRoot || process.cwd());
    const git = options.gitContext || GitCollector.collect(root);
    const task = options.taskContext || DeterministicTaskExtractor.extract([], git);
    const ranked = ContextFileRanker.rankFiles({
      projectRoot: root,
      modifiedFiles: [...(git.modifiedFiles || []), ...(git.untrackedFiles || [])],
      errorLog: options.errorLog || '',
      taskContext: task,
      maxFiles: 8,
    });
    const rankedFiles =
      ranked.length > 0 ? ranked : StudioHydrationAdapter.discoverSourceFilesFallback(root, 8);

    const sourceChunks = [];
    for (const rel of rankedFiles) {
      const abs = path.join(root, rel);
      try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        const raw = fs.readFileSync(abs, 'utf8');
        const { sanitized } = SecretRedactor.redact(raw);
        sourceChunks.push(`// File: ${rel}\n${sanitized.slice(0, 6000)}`);
      } catch {}
    }

    return {
      projectName: path.basename(root),
      goal: SecretRedactor.redact(task.goal || 'Active Project Handoff').sanitized,
      nextSteps: (task.immediateNext || []).map((s) => SecretRedactor.redact(s).sanitized),
      rawSource:
        sourceChunks.join('\n\n') ||
        SecretRedactor.redact(git.diffStat || '// No modified files detected').sanitized,
      targetAgent: options.targetAgent || 'codex',
      fileCount: Math.max(1, sourceChunks.length),
      generatedAt: new Date().toISOString(),
    };
  }

  static generateLiveStudioHtml(projectRoot, studioTemplatePath, options = {}) {
    const root = path.resolve(projectRoot || process.cwd());
    const vicemDir = AtomicFs.ensureVicemDir(root);
    const payload = options.payload || StudioHydrationAdapter.buildHydrationPayload(root, options);
    const escapedJson = safeJsonForHtmlScript(payload);
    const scriptTag = `  <script id="vicem-hydration-data" type="application/json">${escapedJson}</script>\n`;

    const templateHtml = fs.readFileSync(studioTemplatePath, 'utf8');
    const targetIdx = templateHtml.indexOf('<script>');
    const liveHtml =
      targetIdx !== -1
        ? templateHtml.slice(0, targetIdx) + scriptTag + templateHtml.slice(targetIdx)
        : templateHtml.replace('</body>', `${scriptTag}</body>`);

    const liveHtmlPath = path.join(vicemDir, 'studio.live.html');
    AtomicFs.writeFileAtomic(liveHtmlPath, liveHtml);
    return { liveHtmlPath, payload, escapedJson };
  }
}

/**
 * Task 12.1 (Fix 12-A): Worktree-Safe Idempotent Git Pre-Commit Hook Installer (`vicem init`)
 */
export class GitHookInstaller {
  static HOOK_START = '# --- VICEM-GUARD-HOOK-START ---';
  static HOOK_END = '# --- VICEM-GUARD-HOOK-END ---';

  static buildHookBlock() {
    return [
      GitHookInstaller.HOOK_START,
      '# Auto-installed by `vicem init` (Zero-Dependency 3-Pillar Safety Guard)',
      'if command -v vicem >/dev/null 2>&1; then',
      '  vicem guard || exit 1',
      'elif [ -f "./vicem.mjs" ]; then',
      '  node ./vicem.mjs guard || exit 1',
      'fi',
      GitHookInstaller.HOOK_END,
    ].join('\n');
  }

  static resolveHooksDir(projectRoot) {
    const gitDir = AtomicFs.resolveGitDir(projectRoot);
    if (!gitDir) return null;
    // In a git worktree (`.../.git/worktrees/<name>`), check if `commondir` exists
    const commonDirFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirFile)) {
      try {
        const relCommon = fs.readFileSync(commonDirFile, 'utf8').trim();
        const resolvedCommon = path.resolve(gitDir, relCommon);
        if (fs.existsSync(resolvedCommon)) {
          return path.join(resolvedCommon, 'hooks');
        }
      } catch {}
    }
    return path.join(gitDir, 'hooks');
  }

  static install(projectRoot) {
    const hooksDir = GitHookInstaller.resolveHooksDir(projectRoot);
    if (!hooksDir) {
      return { installed: false, reason: 'not_a_git_repo', hookPath: null };
    }
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-commit');
    const block = GitHookInstaller.buildHookBlock();

    let existing = '';
    if (fs.existsSync(hookPath)) {
      existing = fs.readFileSync(hookPath, 'utf8');
    }

    let updated;
    const startIdx = existing.indexOf(GitHookInstaller.HOOK_START);
    const endIdx = existing.indexOf(GitHookInstaller.HOOK_END);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Idempotent replace in-place
      updated =
        existing.slice(0, startIdx) +
        block +
        existing.slice(endIdx + GitHookInstaller.HOOK_END.length);
    } else if (!existing.trim()) {
      updated = `#!/bin/sh\n${block}\n`;
    } else {
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      updated = `${existing}${sep}${block}\n`;
    }

    AtomicFs.writeFileAtomic(hookPath, updated);
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {}
    return { installed: true, hookPath, hooksDir };
  }

  static uninstall(projectRoot) {
    const hooksDir = GitHookInstaller.resolveHooksDir(projectRoot);
    if (!hooksDir) {
      return { uninstalled: false, reason: 'not_a_git_repo', hookPath: null };
    }
    const hookPath = path.join(hooksDir, 'pre-commit');
    if (!fs.existsSync(hookPath)) {
      return { uninstalled: false, reason: 'no_hook_file', hookPath };
    }

    const existing = fs.readFileSync(hookPath, 'utf8');
    const startIdx = existing.indexOf(GitHookInstaller.HOOK_START);
    const endIdx = existing.indexOf(GitHookInstaller.HOOK_END);
    if (startIdx === -1 || endIdx === -1) {
      return { uninstalled: false, reason: 'marker_not_found', hookPath };
    }

    let before = existing.slice(0, startIdx);
    let after = existing.slice(endIdx + GitHookInstaller.HOOK_END.length);
    // Clean up separator newline added before the block during install
    if (before.endsWith('\n\n')) {
      before = before.slice(0, -1);
    }
    if (after.startsWith('\n')) {
      after = after.slice(1);
    }
    const remaining = before + after;

    if (remaining.trim() === '#!/bin/sh' || remaining.trim() === '') {
      fs.unlinkSync(hookPath);
      return { uninstalled: true, removedFile: true, hookPath };
    }

    AtomicFs.writeFileAtomic(hookPath, remaining);
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {}
    return { uninstalled: true, removedFile: false, hookPath };
  }

  static isInstalled(projectRoot) {
    const hooksDir = GitHookInstaller.resolveHooksDir(projectRoot);
    if (!hooksDir) return false;
    const hookPath = path.join(hooksDir, 'pre-commit');
    if (!fs.existsSync(hookPath)) return false;
    try {
      return fs.readFileSync(hookPath, 'utf8').includes(GitHookInstaller.HOOK_START);
    } catch {
      return false;
    }
  }

  static installOneClickBundle(projectRoot, env = process.env) {
    const vicemPath = path.resolve(fileURLToPath(import.meta.url));
    const home = env.HOME || env.USERPROFILE || os.homedir();
    const hookRes = GitHookInstaller.install(projectRoot);

    // 1. User-level CLI launcher (~/.local/bin/vicem or vicem.cmd) — no sudo required
    const localBin = path.join(home, '.local', 'bin');
    let binWrapperPath = null;
    try {
      fs.mkdirSync(localBin, { recursive: true });
      if (process.platform === 'win32') {
        binWrapperPath = path.join(localBin, 'vicem.cmd');
        AtomicFs.writeFileAtomic(binWrapperPath, `@echo off\r\nnode "${vicemPath}" %*\r\n`);
      } else {
        binWrapperPath = path.join(localBin, 'vicem');
        AtomicFs.writeFileAtomic(binWrapperPath, `#!/bin/sh\nexec node "${vicemPath}" "$@"\n`);
        fs.chmodSync(binWrapperPath, 0o755);
      }
    } catch {}

    // 2. Non-destructive MCP config auto-registration for existing agent config dirs
    const mcpEntry = { command: 'node', args: [vicemPath, 'mcp'] };
    const mcpTargets = [
      { dir: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json') },
      { dir: path.join(home, '.gemini', 'antigravity'), file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json') },
    ];
    const registeredMcp = [];
    for (const t of mcpTargets) {
      if (!fs.existsSync(t.dir)) continue;
      try {
        const cur = fs.existsSync(t.file) ? JSON.parse(fs.readFileSync(t.file, 'utf8')) : {};
        cur.mcpServers = cur.mcpServers || {};
        cur.mcpServers.vicem = mcpEntry;
        AtomicFs.writeFileAtomic(t.file, JSON.stringify(cur, null, 2) + '\n');
        registeredMcp.push(t.file);
      } catch {}
    }

    return { hookRes, binWrapperPath, registeredMcp };
  }
}

/**
 * Task 12.2 (Fix 12-B): Zero-Spawn `<50ms` Environment Diagnostics (`vicem doctor`)
 */
export class DoctorDiagnostics {
  static findExecutableInPath(binName, env = process.env) {
    const pathEnv = env.PATH || '';
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, binName + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          const stat = fs.statSync(candidate);
          if (stat.isFile()) return candidate;
        } catch {}
      }
    }
    return null;
  }

  static runDiagnostics(projectRoot = process.cwd(), env = process.env) {
    const startMs = performance.now();
    const home = env.HOME || os.homedir();
    const agents = [
      {
        id: 'claude',
        label: 'Claude Code',
        bin: 'claude',
        sessionDir: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'),
      },
      {
        id: 'codex',
        label: 'OpenAI Codex',
        bin: 'codex',
        sessionDir: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
      },
      {
        id: 'gemini',
        label: 'Gemini CLI',
        bin: 'gemini',
        sessionDir: path.join(env.GEMINI_CLI_HOME || path.join(home, '.gemini'), 'tmp'),
      },
      {
        id: 'antigravity',
        label: 'Antigravity IDE',
        bin: 'agy',
        sessionDir: path.join(home, '.gemini', 'antigravity', 'brain'),
      },
      {
        id: 'cursor',
        label: 'Cursor IDE',
        bin: 'cursor',
        sessionDir: new CursorHarvester(projectRoot, env).getWorkspaceStorageDir(),
      },
      {
        id: 'vscode',
        label: 'VS Code Copilot',
        bin: 'code',
        sessionDir: new VSCodeCopilotHarvester(projectRoot, env).getWorkspaceStorageDir(),
      },
      {
        id: 'opencode',
        label: 'OpenCode CLI',
        bin: 'opencode',
        sessionDir: new OpenCodeHarvester(projectRoot, env).getDbPath(),
      },
      {
        id: 'aider',
        label: 'Aider CLI',
        bin: 'aider',
        sessionDir: path.join(projectRoot, '.aider.chat.history.md'),
      },
    ];

    const agentChecks = agents.map((a) => {
      const binPath = DoctorDiagnostics.findExecutableInPath(a.bin, env);
      const hasStorage = fs.existsSync(a.sessionDir);
      return {
        ...a,
        binFound: Boolean(binPath),
        binPath,
        hasStorage,
      };
    });

    const sqliteSupported = Boolean(process.getBuiltinModule?.('node:sqlite'));
    const hookInstalled = GitHookInstaller.isInstalled(projectRoot);
    const elapsedMs = Number((performance.now() - startMs).toFixed(2));

    return {
      elapsedMs,
      sqliteSupported,
      hookInstalled,
      agentChecks,
    };
  }

  static formatReport(diag, env = process.env) {
    const noColor = UxFormatter.isNoColor(env);
    const ok = noColor ? '[OK]' : '✓';
    const miss = noColor ? '[--]' : '·';
    const lines = [
      `=== Vicem Doctor Diagnostics (${diag.elapsedMs}ms, Zero-Spawn) ===`,
      `${padDisplayColumn('Agent / Tool', 20)} | ${padDisplayColumn('CLI Binary', 16)} | ${padDisplayColumn('Session Store', 15)}`,
      `${'-'.repeat(20)}-+-${'-'.repeat(16)}-+-${'-'.repeat(15)}`,
    ];

    for (const a of diag.agentChecks) {
      const col1 = padDisplayColumn(a.label, 20);
      const col2 = padDisplayColumn(a.binFound ? `${ok} Found` : `${miss} Not in PATH`, 16);
      const col3 = padDisplayColumn(a.hasStorage ? `${ok} Ready` : `${miss} None`, 15);
      lines.push(`${col1} | ${col2} | ${col3}`);
    }

    lines.push(`${'-'.repeat(20)}-+-${'-'.repeat(16)}-+-${'-'.repeat(15)}`);
    lines.push(
      `SQLite (node:sqlite): ${diag.sqliteSupported ? `${ok} Supported` : `${miss} Unavailable`} | Pre-Commit Guard Hook: ${
        diag.hookInstalled ? `${ok} Active` : `${miss} Not installed (run: vicem init)`
      }`
    );
    return lines.join('\n');
  }
}

export class VicemApp {
  static HELP_TEXT = `Vicem (v5.3) — Zero-Dependency AI Agent Context Baton & Diet Suite

Usage (Tier 1 — Daily Zero-Config Commands):
  vicem                   Auto-detect active session & pass baton to recommended target
  vicem <target>          Pass baton to <target> (codex, claude, ide, cursor, web, self)
  vicem back              Return baton to previous agent & auto-unmount temporary rules
  vicem rollback          Restore working tree from pre-handoff snapshot or resume old session

Workflow & Studio Commands (Tier 2):
  vicem self              Compact current agent context (Context Rot Rescue)
  vicem build <target>    Hand off architectural plan with BUILDER role framing
  vicem review <target>   Hand off implementation diff with REVIEWER role framing
  vicem studio            Open hydrated zero-network Web Studio (.vicem/studio.live.html)
  vicem land              Extract & guard-verify code blocks from Web AI clipboard reply
  vicem init              Install idempotent Git pre-commit safety guard hook (--uninstall to remove)
  vicem doctor            Run <50ms zero-spawn environment & agent storage diagnostics

Plumbing & Automation Commands (Tier 3):
  vicem diet [path]       Run 4-Stage Context Diet Engine and print token budget summary
  vicem guard             Run 3-Pillar Safety Guards (SkeletonWrite / SecretCommit / Drift)
  vicem mount [target]    Mount .vicem/BATON.md into target rule file (AGENTS.md, etc.)
  vicem unmount           Unmount baton from rule files with 0-byte diff restoration
  vicem clip              Copy .vicem/BATON.md to clipboard (native + OSC 52 chunks)
  vicem wrap <cmd>        Run CLI agent inside proactive Quota-Radar PTY wrapper
  vicem mcp               Start Dual-Era JSON-RPC 2.0 stdio MCP server
  vicem export-team       Export sanitized .vicem/TEAM_BATON.md for Git PR/branch handoff
  vicem fan-out <targets> Generate parallel batons for comma-separated targets
  vicem fan-in            Merge parallel fan-out batons into a unified review baton

Options:
  --budget <tokens>       Token budget target (default: 4000)
  --headless              Pipe baton to target CLI in non-interactive headless mode
  --dry-run               Build baton and print receipt without launching external binary
  --uninstall             Remove Vicem pre-commit hook cleanly when used with 'vicem init'
  --profile <dir>         Custom profile directory for multi-account relay (UC-08)
  --help, -h              Show this help message`;

  static parseCliArgs(argv = process.argv.slice(2)) {
    const positional = [];
    const flags = {
      budgetTokens: 4000,
      headless: false,
      dryRun: false,
      uninstall: false,
      help: false,
      profile: null,
      role: null,
    };

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--help' || arg === '-h') {
        flags.help = true;
      } else if (arg === '--headless') {
        flags.headless = true;
      } else if (arg === '--dry-run') {
        flags.dryRun = true;
      } else if (arg === '--uninstall') {
        flags.uninstall = true;
      } else if (arg === '--budget' && argv[i + 1]) {
        flags.budgetTokens = parseInt(argv[++i], 10) || 4000;
      } else if (arg === '--profile' && argv[i + 1]) {
        flags.profile = argv[++i];
      } else if (arg === '--role' && argv[i + 1]) {
        flags.role = argv[++i];
      } else if (arg === '--mcp') {
        positional.unshift('mcp');
      } else if (!arg.startsWith('-')) {
        positional.push(arg);
      }
    }

    return { positional, flags };
  }

  static async run(argv = process.argv.slice(2), options = {}) {
    const projectRoot = path.resolve(options.projectRoot || process.cwd());
    const env = options.env || process.env;
    const outStream = options.stdout || process.stdout;
    const { positional, flags } = VicemApp.parseCliArgs(argv);

    if (flags.help) {
      outStream.write(VicemApp.HELP_TEXT + '\n');
      return { exitCode: 0, mode: 'help' };
    }

    const subcmd = (positional[0] || '').toLowerCase();

    // 1. MCP Server Mode (`vicem mcp` / `vicem mcp-server` / `vicem --mcp`)
    if (subcmd === 'mcp' || subcmd === 'mcp-server') {
      const server = new McpServerAdapter(projectRoot);
      server.startStdio(options.stdin || process.stdin, outStream);
      return { exitCode: 0, mode: 'mcp', server };
    }

    // 2. Safety Guard Check (`vicem guard`)
    if (subcmd === 'guard') {
      const res = SafetyGuardEngine.verifyAndProtect(projectRoot, null, { autoRestore: true });
      if (!res.passed) {
        for (const v of res.violations) {
          outStream.write(UxFormatter.renderGuardRecovery(v, env) + '\n');
        }
        return { exitCode: 1, mode: 'guard', result: res };
      }
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(`${okBadge} [Vicem Guard] All 3 safety guards passed (0 violations).\n`);
      return { exitCode: 0, mode: 'guard', result: res };
    }

    // 3. Unmount Rule Files (`vicem unmount`)
    if (subcmd === 'unmount') {
      const res = RuleMountAdapter.unmount(projectRoot, positional[1] || null);
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(
        `${okBadge} [Vicem] Unmounted baton from: ${res.unmountedFiles.join(', ') || 'none'}\n`
      );
      return { exitCode: 0, mode: 'unmount', result: res };
    }

    // 4. Mount Rule File (`vicem mount [target]`)
    if (subcmd === 'mount') {
      const target = positional[1] || 'antigravity';
      const batonMdPath = path.join(projectRoot, '.vicem', 'BATON.md');
      const md = fs.existsSync(batonMdPath)
        ? fs.readFileSync(batonMdPath, 'utf8')
        : BatonIaBuilder.build({ projectRoot, targetAgent: target }).markdown;
      const res = RuleMountAdapter.mount(projectRoot, target, md);
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(`${okBadge} [Vicem] Mounted baton into ${res.relPath} | Undo: vicem unmount\n`);
      return { exitCode: 0, mode: 'mount', result: res };
    }

    // 5. Return Pass (`vicem back`)
    if (subcmd === 'back') {
      // Auto-unmount any temporary rule mounts first (SRS FR-02-R1)
      RuleMountAdapter.unmount(projectRoot);
      const prev = SmartInferenceEngine.getPreviousSource(projectRoot);
      const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, env);
      const returnTarget = prev?.agent && prev.agent !== 'auto' ? prev.agent : 'claude';
      const sourceAgent = prev?.previousTarget || detected.agent || 'codex';

      const session = detected.harvester ? await detected.harvester.harvestSession() : null;
      const git = GitCollector.collect(projectRoot);
      const task = DeterministicTaskExtractor.extract(session?.rawEvents || [], git);

      const baton = BatonIaBuilder.build({
        projectRoot,
        sourceAgent,
        targetAgent: returnTarget,
        sessionId: session?.sessionId || 'return-pass',
        taskContext: task,
        gitContext: git,
        budgetTokens: flags.budgetTokens,
      });

      const receipt = UxFormatter.renderReceipt(
        {
          sourceAgent,
          targetAgent: returnTarget,
          rawTokens: baton.rawTokens,
          dietTokens: baton.dietTokens,
          redactedCount: baton.redactedCount,
          undoCommand: 'vicem rollback',
          extraNote: 'Unmounted temporary rules',
        },
        env
      );
      outStream.write(receipt + '\n');

      if (!flags.dryRun && !options.skipLaunch) {
        CliLauncherAdapter.deliver(returnTarget, baton, {
          projectRoot,
          headless: flags.headless,
          dryRun: flags.dryRun,
        });
      }
      return { exitCode: 0, mode: 'back', baton, receipt };
    }

    // 6. Rollback (`vicem rollback`) & Resume (`vicem resume`) — BUG-09 Fix
    if (subcmd === 'rollback' || subcmd === 'resume') {
      RuleMountAdapter.unmount(projectRoot);
      const latestSnapId = PreHandoffSnapshotStore.getLatestSnapshotId(projectRoot);
      const snapRes =
        subcmd === 'rollback' && latestSnapId
          ? PreHandoffSnapshotStore.restoreSnapshot(projectRoot, latestSnapId)
          : { restored: false, restoredFiles: [] };
      const poppedSession = SessionHistoryStack.popSession(projectRoot);
      const resumeAgent = positional[1] || poppedSession?.agent || 'claude';
      const resumeSessionId = positional[2] || poppedSession?.sessionId || 'last';

      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(
        `${okBadge} [Vicem ${subcmd === 'resume' ? 'Resume' : 'Rollback'}] Restored ${snapRes.restoredFiles.length} snapshot file(s)${
          poppedSession ? ` | Resuming ${resumeAgent} session (${resumeSessionId})` : ''
        }\n`
      );

      let launchRes = null;
      if ((poppedSession || subcmd === 'resume') && !flags.dryRun && !options.skipLaunch) {
        launchRes = CliLauncherAdapter.deliver(resumeAgent, null, {
          projectRoot,
          resumeSessionId,
          dryRun: flags.dryRun || options.skipLaunch,
        });
      }
      return { exitCode: 0, mode: subcmd, snapRes, poppedSession, launchRes };
    }

    // 6b. Harvest inspection (`vicem harvest [source]`) — BUG-09 Fix
    if (subcmd === 'harvest') {
      const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, env);
      const session = detected.harvester ? await detected.harvester.harvestSession() : null;
      const git = GitCollector.collect(projectRoot);
      const task = DeterministicTaskExtractor.extract(session?.rawEvents || [], git);
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(
        `${okBadge} [Vicem Harvest] Source: ${detected.agent} | Goal: ${task.goal} | Done: ${task.done.length} | Next: ${task.immediateNext.length}\n`
      );
      return { exitCode: 0, mode: 'harvest', sourceAgent: detected.agent, session, git, task };
    }

    // 7. Web Reply Land (`vicem land`)
    if (subcmd === 'land') {
      const answerText = options.clipboardText || ClipboardAdapter.pasteNative();
      const res = WebLandAdapter.land(projectRoot, answerText, { applyFiles: !flags.dryRun });
      if (!res.guardPassed) {
        for (const v of res.violations) {
          outStream.write(UxFormatter.renderGuardRecovery(v, env) + '\n');
        }
        return { exitCode: 1, mode: 'land', result: res };
      }
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(
        `${okBadge} [Vicem Land] Verified ${res.blocksCount} code block(s) from Web AI (${res.appliedFiles.length} file(s) applied).\n`
      );
      return { exitCode: 0, mode: 'land', result: res };
    }

    // 8. Clipboard Copy (`vicem clip`)
    if (subcmd === 'clip') {
      const batonMdPath = path.join(projectRoot, '.vicem', 'BATON.md');
      const md = fs.existsSync(batonMdPath)
        ? fs.readFileSync(batonMdPath, 'utf8')
        : BatonIaBuilder.build({ projectRoot }).markdown;
      const nativeRes = ClipboardAdapter.copyNative(md);
      const oscRes = ClipboardAdapter.writeOsc52(md, env, outStream);
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(
        `\n${okBadge} [Vicem Clip] Copied baton (${md.length} chars, ${oscRes.chunksCount} OSC 52 chunk(s), native: ${nativeRes.method}).\n`
      );
      return { exitCode: 0, mode: 'clip', nativeRes, oscRes };
    }

    // 9. PTY Wrapper (`vicem wrap <cmd>` — CRIT-03 Fix: uses async stream inspector)
    if (subcmd === 'wrap') {
      const targetCmd = positional[1] || 'claude';
      const targetArgs = positional.slice(2);
      const res = await PtyWrapController.wrapCommandAsync(targetCmd, targetArgs, {
        projectRoot,
        env,
        stdout: outStream,
        dryRun: flags.dryRun || options.skipLaunch,
      });
      return { exitCode: 0, mode: 'wrap', result: res };
    }

    // 10. Web Studio (`vicem studio` — Fix 11-A & CRIT-04: harvests active session for hydration)
    if (subcmd === 'studio') {
      const studioHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
      let liveHtmlPath = studioHtmlPath;
      let payload = null;
      if (fs.existsSync(studioHtmlPath)) {
        const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, env);
        const session = detected.harvester ? await detected.harvester.harvestSession() : null;
        const git = GitCollector.collect(projectRoot);
        const task = DeterministicTaskExtractor.extract(session?.rawEvents || [], git);
        const hydrated = StudioHydrationAdapter.generateLiveStudioHtml(projectRoot, studioHtmlPath, {
          targetAgent: positional[1] || 'codex',
          gitContext: git,
          taskContext: task,
        });
        liveHtmlPath = hydrated.liveHtmlPath;
        payload = hydrated.payload;
      }
      if (!flags.dryRun && !options.skipLaunch && fs.existsSync(liveHtmlPath)) {
        UrlPrefillAdapter.openExternal(liveHtmlPath);
      }
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(`${okBadge} [Vicem Studio] Opened hydrated studio at ${liveHtmlPath}\n`);
      return { exitCode: 0, mode: 'studio', studioHtmlPath, liveHtmlPath, payload };
    }

    // 10b. Git Pre-Commit Hook & 1-Click Installer (`vicem init` / `vicem setup` — Fix 12-A)
    if (subcmd === 'init' || subcmd === 'setup') {
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      if (flags.uninstall || positional[1] === '--uninstall' || positional[1] === 'uninstall') {
        const res = GitHookInstaller.uninstall(projectRoot);
        outStream.write(
          `${okBadge} [Vicem Init] Uninstalled pre-commit safety hook (${res.hookPath || 'none'}).\n`
        );
        return { exitCode: 0, mode: 'init-uninstall', result: res };
      }
      if (subcmd === 'setup') {
        const bundle = GitHookInstaller.installOneClickBundle(projectRoot, env);
        const diag = DoctorDiagnostics.runDiagnostics(projectRoot, env);
        outStream.write(DoctorDiagnostics.formatReport(diag, env) + '\n');
        outStream.write(
          `${okBadge} [Vicem 1-Click Setup] CLI wrapper: ${bundle.binWrapperPath || 'ready'} | MCP configs updated: ${bundle.registeredMcp.length} | Git Hook: ${bundle.hookRes.installed ? 'active' : 'skipped'}\n`
        );
        return { exitCode: 0, mode: 'setup', bundle, diagnostics: diag };
      }
      const res = GitHookInstaller.install(projectRoot);
      if (!res.installed) {
        outStream.write(`[ERR] [Vicem Init] Could not install git hook (${res.reason}).\n`);
        return { exitCode: 1, mode: 'init', result: res };
      }
      outStream.write(`${okBadge} [Vicem Init] Installed pre-commit guard hook at ${res.hookPath}\n`);
      return { exitCode: 0, mode: 'init', result: res };
    }

    // 10c. Zero-Spawn Environment Diagnostics (`vicem doctor` — Fix 12-B)
    if (subcmd === 'doctor') {
      const diag = DoctorDiagnostics.runDiagnostics(projectRoot, env);
      const report = DoctorDiagnostics.formatReport(diag, env);
      outStream.write(report + '\n');
      return { exitCode: 0, mode: 'doctor', diagnostics: diag, report };
    }

    // 11. Team Baton Export (`vicem export-team` — UC-11)
    if (subcmd === 'export-team') {
      const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, env);
      const session = detected.harvester ? await detected.harvester.harvestSession() : null;
      const git = GitCollector.collect(projectRoot);
      const task = DeterministicTaskExtractor.extract(session?.rawEvents || [], git);
      const baton = BatonIaBuilder.build({
        projectRoot,
        sourceAgent: detected.agent,
        targetAgent: 'team',
        taskContext: task,
        gitContext: git,
        budgetTokens: flags.budgetTokens,
      });
      const teamPath = path.join(projectRoot, '.vicem', 'TEAM_BATON.md');
      AtomicFs.writeFileAtomic(teamPath, baton.markdown + '\n');
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(`${okBadge} [Vicem Team] Exported sanitized team baton to .vicem/TEAM_BATON.md\n`);
      return { exitCode: 0, mode: 'export-team', teamPath, baton };
    }

    // 12. Parallel Fan-Out (`vicem fan-out <t1,t2>` — UC-10) & Fan-In (`vicem fan-in`)
    if (subcmd === 'fan-out') {
      const targets = (positional[1] || 'codex,claude')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, env);
      const git = GitCollector.collect(projectRoot);
      const task = DeterministicTaskExtractor.extract([], git);
      const results = [];
      for (const t of targets) {
        const b = BatonIaBuilder.build({
          projectRoot,
          sourceAgent: detected.agent,
          targetAgent: t,
          taskContext: task,
          gitContext: git,
          budgetTokens: flags.budgetTokens,
        });
        const outFile = path.join(projectRoot, '.vicem', `BATON.${t}.md`);
        AtomicFs.writeFileAtomic(outFile, b.markdown + '\n');
        results.push({ target: t, file: outFile });
      }
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(
        `${okBadge} [Vicem Fan-Out] Generated ${results.length} parallel batons (${targets.join(', ')}).\n`
      );
      return { exitCode: 0, mode: 'fan-out', results };
    }

    if (subcmd === 'fan-in') {
      const vicemDir = AtomicFs.ensureVicemDir(projectRoot);
      const files = fs
        .readdirSync(vicemDir)
        .filter((f) => f.startsWith('BATON.') && f.endsWith('.md'));
      const combined = files
        .map((f) => `<!-- SOURCE: ${f} -->\n` + fs.readFileSync(path.join(vicemDir, f), 'utf8'))
        .join('\n\n---\n\n');
      const mergedPath = path.join(vicemDir, 'BATON.md');
      if (combined) {
        AtomicFs.writeFileAtomic(mergedPath, combined);
      }
      const okBadge = UxFormatter.isNoColor(env) ? '[OK]' : '✓';
      outStream.write(`${okBadge} [Vicem Fan-In] Merged ${files.length} fan-out batons into .vicem/BATON.md.\n`);
      return { exitCode: 0, mode: 'fan-in', mergedCount: files.length };
    }

    // 13. Diet inspection (`vicem diet`)
    if (subcmd === 'diet') {
      const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, env);
      const session = detected.harvester ? await detected.harvester.harvestSession() : null;
      const git = GitCollector.collect(projectRoot);
      const task = DeterministicTaskExtractor.extract(session?.rawEvents || [], git);
      const baton = BatonIaBuilder.build({
        projectRoot,
        sourceAgent: detected.agent,
        targetAgent: 'self',
        taskContext: task,
        gitContext: git,
        budgetTokens: flags.budgetTokens,
      });
      const receipt = UxFormatter.renderReceipt(
        {
          sourceAgent: detected.agent,
          targetAgent: 'self',
          rawTokens: baton.rawTokens,
          dietTokens: baton.dietTokens,
          redactedCount: baton.redactedCount,
          undoCommand: 'vicem rollback',
        },
        env
      );
      outStream.write(receipt + '\n');
      return { exitCode: 0, mode: 'diet', baton, receipt };
    }

    // 14. Role Shortcuts (`vicem build <target>`, `vicem review <target>`) or Direct Target (`vicem [target]`)
    let role = flags.role;
    let rawTarget = positional[0] || null;
    if (subcmd === 'build' || subcmd === 'review') {
      role = subcmd === 'build' ? 'builder' : 'reviewer';
      rawTarget = positional[1] || null;
    }

    const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, env);
    const sourceAgent = detected.agent || 'git';
    let targetAgent = null;
    let fuzzyCorrectedFrom = null;

    if (!rawTarget) {
      const recommended = SmartInferenceEngine.recommendNextTarget(sourceAgent);
      targetAgent = await MicroTuiSelector.selectTarget({
        sourceAgent,
        recommended,
        isTTY: Boolean(options.isTTY ?? false),
      });
      if (!targetAgent) {
        outStream.write('Canceled.\n');
        return { exitCode: 0, mode: 'canceled' };
      }
    } else {
      const matchRes = SmartInferenceEngine.resolveTarget(rawTarget);
      if (!matchRes.matched) {
        const errPrefix = UxFormatter.isNoColor(env) ? '[ERR]' : '✗';
        outStream.write(
          `${errPrefix} [Vicem] Unknown target '${rawTarget}'. Supported targets: codex, claude, ide, cursor, windsurf, vscode, gemini, aider, web, self.\n`
        );
        return { exitCode: 1, mode: 'unknown_target', rawTarget };
      }
      targetAgent = matchRes.matched;
      if (matchRes.via === 'fuzzy') {
        fuzzyCorrectedFrom = rawTarget;
      }
    }

    // Harvest source session & build U-Shaped Baton
    const session = detected.harvester ? await detected.harvester.harvestSession() : null;
    const git = GitCollector.collect(projectRoot);
    const task = DeterministicTaskExtractor.extract(session?.rawEvents || [], git);

    if (session?.sessionId) {
      SessionHistoryStack.pushSession(projectRoot, {
        agent: sourceAgent,
        sessionId: session.sessionId,
      });
    }

    const baton = BatonIaBuilder.build({
      projectRoot,
      sourceAgent,
      targetAgent,
      sessionId: session?.sessionId || 'auto',
      taskContext: task,
      gitContext: git,
      budgetTokens: flags.budgetTokens,
      role,
      fuzzyMatchedFrom: rawTarget || targetAgent,
    });

    // Deliver according to target category:
    // - IDE targets (antigravity, cursor, windsurf, vscode, cline): Mount rule file + Copy clipboard + Open deep link
    // - Web target (web): URL prefill (<=2000 chars) or Clipboard fallback (>2000 chars)
    // - Self target (self): Fresh compact session
    // - CLI target (codex, claude, gemini, aider, opencode, goose): Interactive spawn (or headless pipe)
    const ideTargets = new Set(['antigravity', 'cursor', 'windsurf', 'vscode', 'cline']);
    let deliveryInfo = {};

    if (ideTargets.has(targetAgent)) {
      const mountRes = RuleMountAdapter.mount(projectRoot, targetAgent, baton.markdown);
      baton.json.target.mountedRuleFile = mountRes.relPath;
      AtomicFs.writeFileAtomic(baton.batonJsonPath, JSON.stringify(baton.json, null, 2) + '\n');
      if (!flags.dryRun && !options.skipLaunch) {
        ClipboardAdapter.copyNative(baton.markdown);
        UrlPrefillAdapter.openExternal(UrlPrefillAdapter.buildIdeDeepLink(targetAgent, projectRoot));
      }
      deliveryInfo = { channel: 'ide_mount', mountedFile: mountRes.relPath };
    } else if (targetAgent === 'web') {
      deliveryInfo = UrlPrefillAdapter.deliverWeb(baton.markdown, 'chatgpt', {
        dryRun: flags.dryRun || options.skipLaunch,
      });
    } else {
      const effectiveCli = targetAgent === 'self' ? (sourceAgent === 'git' ? 'claude' : sourceAgent) : targetAgent;
      const envVars = {};
      if (flags.profile) {
        if (effectiveCli === 'claude') envVars.CLAUDE_CONFIG_DIR = flags.profile;
        if (effectiveCli === 'codex') envVars.CODEX_HOME = flags.profile;
      }
      deliveryInfo = CliLauncherAdapter.deliver(effectiveCli, baton, {
        projectRoot,
        headless: flags.headless,
        dryRun: flags.dryRun || options.skipLaunch,
        envVars,
      });
    }

    const receipt = UxFormatter.renderReceipt(
      {
        sourceAgent,
        targetAgent,
        rawTokens: baton.rawTokens,
        dietTokens: baton.dietTokens,
        redactedCount: baton.redactedCount,
        undoCommand: targetAgent === 'self' ? 'vicem rollback' : 'vicem back',
        fuzzyCorrectedFrom,
      },
      env
    );
    outStream.write(receipt + '\n');

    return {
      exitCode: 0,
      mode: 'handoff',
      sourceAgent,
      targetAgent,
      baton,
      deliveryInfo,
      receipt,
    };
  }
}

// Execute CLI if invoked directly
const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const cliArgs = process.argv.slice(2);
  const effectiveArgs = cliArgs.length === 0 && !process.stdin.isTTY ? ['mcp-server'] : cliArgs;
  VicemApp.run(effectiveArgs).then((res) => {
    if (res && res.mode !== 'mcp' && typeof res.exitCode === 'number' && res.exitCode !== 0) {
      process.exitCode = res.exitCode;
    }
  });
}

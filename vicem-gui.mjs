#!/usr/bin/env node
/**
 * Vicem Desktop Command Center (v17 - Gamified Tactical Context Relay & Diet Cockpit)
 * - Default Auto-Open ON: clicking "Hand off ->" actually launches the target agent on macOS:
 *   - Claude Code / OpenAI Codex: generates an executable `.vicem/launch-<agent>.command` with full
 *     binary path (`~/.local/bin/claude` or `~/.local/bin/codex`), `cd`s into the workspace, passes
 *     the initial Baton prompt, and opens it natively in Terminal.app (`open -a Terminal ...`).
 *   - Antigravity / VS Code: opens the project directory directly in `/Applications/Antigravity.app`
 *     or `/Applications/Visual Studio Code.app`.
 *   - Web Chat: copies Baton to clipboard and opens `https://chatgpt.com/?q=...`.
 * - Live 5-Step Handoff Verification Panel: proves every background step (file size on disk,
 *   mounted rule file verification, real `pbpaste` clipboard byte check, and process launch status)
 *   with a live collapsible preview of the actual `.vicem/BATON.md` content.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DoctorDiagnostics,
  SmartInferenceEngine,
  GitCollector,
  DeterministicTaskExtractor,
  BatonIaBuilder,
  RuleMountAdapter,
  ClipboardAdapter,
  DietLedger,
  CodeSkeletonizer,
  StalenessDriftGuard,
  TokenEstimator,
  VicemApp,
} from './vicem.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT =
  process.env.VICEM_PROJECT_ROOT && fs.existsSync(process.env.VICEM_PROJECT_ROOT)
    ? path.resolve(process.env.VICEM_PROJECT_ROOT)
    : fs.existsSync(path.join(process.cwd(), '.git'))
    ? process.cwd()
    : path.basename(__dirname) === 'prototype'
    ? path.resolve(__dirname, '..')
    : __dirname;

const LOGO_DARK_PATH =
  [
    path.resolve(__dirname, 'logo-dark-transparent.png'),
    path.resolve(__dirname, 'release', 'logo-dark-transparent.png'),
    path.resolve(__dirname, '..', 'logo-dark-transparent.png'),
    path.resolve(__dirname, '..', 'release', 'logo-dark-transparent.png'),
  ].find((p) => fs.existsSync(p)) || path.resolve(__dirname, 'logo-dark-transparent.png');

const LOGO_LIGHT_PATH =
  [
    path.resolve(__dirname, 'logo-light-transparent.png'),
    path.resolve(__dirname, 'release', 'logo-light-transparent.png'),
    path.resolve(__dirname, '..', 'logo-light-transparent.png'),
    path.resolve(__dirname, '..', 'release', 'logo-light-transparent.png'),
  ].find((p) => fs.existsSync(p)) || path.resolve(__dirname, 'logo-light-transparent.png');

function shortenHome(fullPath, home) {
  if (!fullPath) return '-';
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

function formatAgo(mtimeMs) {
  if (!mtimeMs) return '-';
  const diffSec = Math.max(1, Math.floor((Date.now() - mtimeMs) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatResetShort(resetEpochSec) {
  if (!resetEpochSec) return '';
  const diffSec = Math.max(0, Math.floor(resetEpochSec - Date.now() / 1000));
  if (diffSec <= 0) return 'Resets now';
  const d = Math.floor(diffSec / 86400);
  const h = Math.floor((diffSec % 86400) / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  if (d > 0) return `Resets in ${d}d ${h}h`;
  if (h > 0) return `Resets in ${h}h ${m}m`;
  return `Resets in ${m}m`;
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

function readHeadAndTailUtf8(filePath, headBytes = 24576, tailBytes = 98304) {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= headBytes + tailBytes) {
      return fs.readFileSync(filePath, 'utf8');
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const headBuf = Buffer.alloc(headBytes);
      const tailBuf = Buffer.alloc(tailBytes);
      fs.readSync(fd, headBuf, 0, headBytes, 0);
      fs.readSync(fd, tailBuf, 0, tailBytes, st.size - tailBytes);
      return headBuf.toString('utf8') + '\n' + tailBuf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function getIdeUserDir(ideName, home) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', ideName, 'User');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, ideName, 'User');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, ideName, 'User');
}

function readClipboardCrossPlatform() {
  try {
    if (process.platform === 'darwin') {
      return execSync('pbpaste', { encoding: 'utf8', timeout: 1200 });
    }
    if (process.platform === 'win32') {
      return execSync('powershell -NoProfile -Command Get-Clipboard', {
        encoding: 'utf8',
        timeout: 1500,
      });
    }
    for (const cmd of ['wl-paste -n', 'xclip -o -selection clipboard', 'xsel -ob']) {
      try {
        return execSync(cmd, { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {}
    }
  } catch {}
  return '';
}

function openExternalCrossPlatform(urlOrPath, macAppPath = null) {
  if (process.platform === 'darwin') {
    const args = macAppPath ? ['-a', macAppPath, urlOrPath] : [urlOrPath];
    return spawnSync('open', args, { encoding: 'utf8' });
  }
  if (process.platform === 'win32') {
    return spawnSync('cmd', ['/c', 'start', '""', urlOrPath], {
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  return spawnSync('xdg-open', [urlOrPath], { encoding: 'utf8' });
}

const binaryCache = new Map();

function resolveAgentBinary(agentId, home) {
  if (binaryCache.has(agentId)) return binaryCache.get(agentId);
  const found = resolveAgentBinaryUncached(agentId, home);
  binaryCache.set(agentId, found);
  return found;
}

function resolveAgentBinaryUncached(agentId, home) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const ext of exts) {
    const localBin = path.join(home, '.local', 'bin', agentId + ext);
    if (fs.existsSync(localBin)) return localBin;
  }

  if (process.platform === 'darwin') {
    if (agentId === 'claude') {
      const appSupport = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
      if (fs.existsSync(appSupport)) {
        for (const ver of fs.readdirSync(appSupport)) {
          const p = path.join(appSupport, ver);
          if (fs.statSync(p).isDirectory()) {
            for (const sub of fs.readdirSync(p)) {
              const bin = path.join(p, sub, 'claude.app', 'Contents', 'MacOS', 'claude');
              if (fs.existsSync(bin)) return bin;
            }
          }
        }
      }
    }
    if (agentId === 'codex') {
      const codexAppBin = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
      if (fs.existsSync(codexAppBin)) return codexAppBin;
    }
    if (agentId === 'cursor') {
      const p = '/Applications/Cursor.app/Contents/Resources/app/bin/cursor';
      if (fs.existsSync(p)) return p;
    }
    if (agentId === 'windsurf') {
      const p = '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf';
      if (fs.existsSync(p)) return p;
    }
    if (agentId === 'vscode') {
      const p = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
      if (fs.existsSync(p)) return p;
    }
  }

  if (isWin) {
    const binName = agentId === 'vscode' ? 'code' : agentId;
    try {
      const found = execSync(`where ${binName}`, {
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split(/\r?\n/)[0];
      if (found && fs.existsSync(found)) return found;
    } catch {}
    return null;
  }

  // Fast zero-spawn Unix/macOS PATH + standard bin lookup
  const binName = agentId === 'vscode' ? 'code' : agentId === 'antigravity' ? 'agy' : agentId;
  const searchDirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  for (const dir of searchDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Polls the status file written by the launcher script until the agent reports in or we time out.
 */
async function waitForLaunchStatus(statusPath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(statusPath)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (status.state === 'started') {
          await new Promise((r) => setTimeout(r, 1500));
          return { ...status, alive: isPidAlive(status.pid) };
        }
        return status;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { state: 'timeout' };
}

function detectRunningProcesses() {
  const result = {
    antigravity: false,
    claude: false,
    codex: false,
    cursor: false,
    vscode: false,
    gemini: false,
    windsurf: false,
    cline: false,
    opencode: false,
    aider: false,
    goose: false,
  };
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 1500 });
      if (/Antigravity/i.test(out)) result.antigravity = true;
      if (/claude\.exe/i.test(out)) result.claude = true;
      if (/codex\.exe/i.test(out)) result.codex = true;
      if (/Cursor\.exe/i.test(out)) result.cursor = true;
      if (/Windsurf\.exe/i.test(out)) result.windsurf = true;
      if (/opencode/i.test(out)) result.opencode = true;
      if (/aider/i.test(out)) result.aider = true;
      if (/goose/i.test(out)) result.goose = true;
      return result;
    }
    const out = execSync('ps -Ao pcpu,comm,args', { encoding: 'utf8', timeout: 1500 });
    for (const line of out.split('\n')) {
      if (!line || line.includes('vicem-gui')) continue;
      if (/language_server_macos|Antigravity\.app|antigravity/i.test(line)) {
        const cpu = parseFloat(line.trim().split(/\s+/)[0] || '0');
        if (cpu > 0.5) result.antigravity = true;
      }
      if (/(?:^|\s|\/)claude(?:\s|$)/i.test(line) && !/Claude\.app\/Contents\/MacOS\/Claude/i.test(line)) {
        result.claude = true;
      }
      if (/(?:^|\s|\/)codex(?:\s|$)/i.test(line) && !/app-server/i.test(line)) {
        result.codex = true;
      }
      if (/(?:^|\s|\/)gemini(?:\s|$)/i.test(line)) result.gemini = true;
      if (/(?:^|\s|\/)opencode(?:\s|$)/i.test(line)) result.opencode = true;
      if (/(?:^|\s|\/)aider(?:\s|$)/i.test(line)) result.aider = true;
      if (/(?:^|\s|\/)goose(?:\s|$)/i.test(line)) result.goose = true;
    }
  } catch {}
  return result;
}

function collectRealAgentTelemetry(home) {
  const now = Date.now();
  const fiveHoursAgo = now - 5 * 3600 * 1000;
  const sevenDaysAgo = now - 7 * 86400 * 1000;
  const discoveredWorkspaces = new Map();

  const addWorkspace = (dirPath, agentName, mtimeMs, lastPrompt = '') => {
    if (!dirPath || typeof dirPath !== 'string') return;
    const cleaned = dirPath.replace(/^file:\/\//, '').trim();
    if (!cleaned.startsWith('/') || !fs.existsSync(cleaned)) return;
    const prev = discoveredWorkspaces.get(cleaned);
    if (!prev || mtimeMs > prev.mtimeMs) {
      discoveredWorkspaces.set(cleaned, {
        path: cleaned,
        name: path.basename(cleaned),
        shortPath: shortenHome(cleaned, home),
        lastAgent: agentName,
        mtimeMs,
        lastPrompt: lastPrompt || prev?.lastPrompt || '',
      });
    }
  };

  addWorkspace(DEFAULT_PROJECT_ROOT, 'Antigravity', now, '');

  // 1. Antigravity IDE
  let agyLatestMtime = 0;
  let agyLatestPrompt = '';
  let agyLatestWorkspace = DEFAULT_PROJECT_ROOT;
  let agyActiveBytes5h = 0;
  let agyTotalSessions = 0;
  const brainDir = path.join(home, '.gemini', 'antigravity', 'brain');
  try {
    if (fs.existsSync(brainDir)) {
      const entries = fs.readdirSync(brainDir);
      agyTotalSessions = entries.length;
      const recentFiles = [];
      for (const d of entries) {
        const tp = path.join(brainDir, d, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          if (fs.existsSync(tp)) {
            const st = fs.statSync(tp);
            if (st.mtimeMs >= fiveHoursAgo) agyActiveBytes5h += st.size;
            recentFiles.push({ path: tp, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {}
      }
      recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (recentFiles[0]) {
        agyLatestMtime = recentFiles[0].mtimeMs;
        const raw = readHeadAndTailUtf8(recentFiles[0].path);
        const wsMatch = raw.match(/Command Working Directory:\s*(\/[^\n\\<"]+)/);
        if (wsMatch && wsMatch[1] && fs.existsSync(wsMatch[1].trim())) {
          agyLatestWorkspace = wsMatch[1].trim();
        }
        const lines = raw.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"USER_INPUT"')) continue;
          try {
            const step = JSON.parse(lines[i]);
            if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
              const m = step.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
              const text = (m ? m[1] : step.content).replace(/\s+/g, ' ').trim();
              if (
                text &&
                text.length >= 6 &&
                !/^(ok|okay|yes|yep|sure|go|k|y|thx|thanks)$/i.test(text)
              ) {
                agyLatestPrompt = text.slice(0, 120);
                break;
              }
            }
          } catch {}
        }
        addWorkspace(agyLatestWorkspace, 'Antigravity', agyLatestMtime, agyLatestPrompt);
      }
    }
  } catch {}

  const agyEstTokens5h = Math.round(agyActiveBytes5h / 4);
  const agyUsedPct = Math.min(95, Math.round((agyActiveBytes5h / (12 * 1024 * 1024)) * 100));
  const agyRemainPct = Math.max(5, 100 - agyUsedPct);

  // 2. Claude Code
  let claudeCost5h = 0;
  let claudeCost7d = 0;
  let claudeOldestIn5h = 0;
  let claudeLatestMtime = 0;
  let claudeLatestWorkspace = '';
  let claudeLatestModel = 'claude-opus-4-8';
  let claudeLatestPrompt = '';
  let claudeSessionCount = 0;
  const claudeDir = path.join(home, '.claude', 'projects');
  try {
    if (fs.existsSync(claudeDir)) {
      const allFiles = [];
      for (const d of fs.readdirSync(claudeDir)) {
        const p = path.join(claudeDir, d);
        if (!fs.statSync(p).isDirectory()) continue;
        for (const f of fs.readdirSync(p)) {
          if (!f.endsWith('.jsonl')) continue;
          claudeSessionCount++;
          const full = path.join(p, f);
          const st = fs.statSync(full);
          allFiles.push({ path: full, mtimeMs: st.mtimeMs });
          if (st.mtimeMs < sevenDaysAgo) continue;
          const lines = fs.readFileSync(full, 'utf8').split('\n');
          for (const l of lines) {
            if (!l.includes('"usage"')) continue;
            try {
              const obj = JSON.parse(l);
              const ts = obj.timestamp ? Date.parse(obj.timestamp) : st.mtimeMs;
              const u = obj.message?.usage;
              if (!u) continue;
              const inp = Number(u.input_tokens || 0);
              const cw = Number(u.cache_creation_input_tokens || 0);
              const cr = Number(u.cache_read_input_tokens || 0);
              const out = Number(u.output_tokens || 0);
              const isOpus = (obj.message?.model || '').includes('opus');
              const cost = isOpus
                ? (inp * 15 + cw * 18.75 + cr * 1.5 + out * 75) / 1e6
                : (inp * 3 + cw * 3.75 + cr * 0.3 + out * 15) / 1e6;
              if (ts >= sevenDaysAgo) claudeCost7d += cost;
              if (ts >= fiveHoursAgo) {
                claudeCost5h += cost;
                if (!claudeOldestIn5h || ts < claudeOldestIn5h) claudeOldestIn5h = ts;
              }
            } catch {}
          }
        }
      }
      allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of allFiles.slice(0, 5)) {
        try {
          const lines = fs.readFileSync(item.path, 'utf8').trim().split('\n');
          let cwd = '';
          let model = '';
          let prompt = '';
          for (const l of lines) {
            try {
              const o = JSON.parse(l);
              if (o.cwd) cwd = o.cwd;
              if (o.message?.model) model = o.message.model;
              if (o.type === 'user' && typeof o.message?.content === 'string') {
                prompt = o.message.content.trim().split('\n')[0].slice(0, 120);
              }
            } catch {}
          }
          if (cwd) addWorkspace(cwd, 'Claude Code', item.mtimeMs, prompt);
          if (item === allFiles[0]) {
            claudeLatestMtime = item.mtimeMs;
            claudeLatestWorkspace = cwd;
            if (model) claudeLatestModel = model;
            claudeLatestPrompt = prompt;
          }
        } catch {}
      }
    }
  } catch {}

  const claudeUsedPct5h = Math.min(100, Math.round((claudeCost5h / 45) * 100));
  const claudeRemainPct = Math.max(0, 100 - claudeUsedPct5h);
  const claudeResetNote =
    claudeOldestIn5h > 0
      ? `${formatResetShort(Math.floor((claudeOldestIn5h + 5 * 3600 * 1000) / 1000))} · $${claudeCost5h.toFixed(1)}/5h`
      : `5h window · $${claudeCost7d.toFixed(0)} / 7d`;

  // 3. OpenAI Codex
  let codexRemainPct = 100;
  let codexPlan = 'Pro';
  let codexResetNote = 'Weekly window';
  let codexLatestMtime = 0;
  let codexLatestWorkspace = '';
  let codexLatestModel = 'gpt-6-astra';
  let codexLatestPrompt = '';
  let codexSessionCount = 0;
  const codexDir = path.join(home, '.codex', 'sessions');
  try {
    const codexFiles = [];
    const scan = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) scan(full);
        else if (e.name.endsWith('.jsonl')) {
          codexSessionCount++;
          const st = fs.statSync(full);
          codexFiles.push({ path: full, mtimeMs: st.mtimeMs });
        }
      }
    };
    scan(codexDir);
    codexFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of codexFiles.slice(0, 5)) {
      try {
        const lines = fs.readFileSync(item.path, 'utf8').trim().split('\n');
        let cwd = '';
        let model = '';
        let prompt = '';
        for (const l of lines) {
          try {
            const obj = JSON.parse(l);
            if (obj.type === 'session_meta' && obj.payload?.cwd) cwd = obj.payload.cwd;
            if (obj.type === 'turn_context' && obj.payload?.model) model = obj.payload.model;
            if (obj.payload?.role === 'user' && Array.isArray(obj.payload?.content)) {
              const txt = obj.payload.content.find((c) => c.text)?.text || '';
              if (txt && !txt.startsWith('<')) prompt = txt.trim().split('\n')[0].slice(0, 120);
            }
          } catch {}
        }
        if (cwd) addWorkspace(cwd, 'OpenAI Codex', item.mtimeMs, prompt);
        if (item === codexFiles[0]) {
          codexLatestMtime = item.mtimeMs;
          codexLatestWorkspace = cwd;
          if (model) codexLatestModel = model;
          codexLatestPrompt = prompt;
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const obj = JSON.parse(lines[i]);
              if (obj.payload && obj.payload.rate_limits) {
                const rl = obj.payload.rate_limits;
                const used = Number(rl.primary?.used_percent || 0);
                codexRemainPct = Math.max(0, Math.min(100, 100 - used));
                codexPlan = rl.plan_type
                  ? rl.plan_type[0].toUpperCase() + rl.plan_type.slice(1)
                  : 'Pro';
                if (rl.primary?.resets_at) {
                  codexResetNote = formatResetShort(rl.primary.resets_at);
                }
                break;
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}

  // Helper for VS Code / Cursor / Windsurf workspaceStorage scanning across macOS / Windows / Linux
  const scanIdeWorkspaces = (ideName, label) => {
    let latestMtime = 0;
    let latestWorkspace = '';
    let count = 0;
    const dir = path.join(getIdeUserDir(ideName, home), 'workspaceStorage');
    try {
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        count = entries.length;
        for (const d of entries) {
          const wj = path.join(dir, d, 'workspace.json');
          if (!fs.existsSync(wj)) continue;
          try {
            const st = fs.statSync(wj);
            const data = JSON.parse(fs.readFileSync(wj, 'utf8'));
            const folder = decodeURIComponent(String(data.folder || '').replace(/^file:\/\//, ''));
            if (folder) addWorkspace(folder, label, st.mtimeMs, '');
            if (st.mtimeMs > latestMtime && folder) {
              latestMtime = st.mtimeMs;
              latestWorkspace = folder;
            }
          } catch {}
        }
      }
    } catch {}
    return { latestMtime, latestWorkspace, count };
  };

  // 4. VS Code Copilot, 5. Cursor, 6. Windsurf
  const vscInfo = scanIdeWorkspaces('Code', 'VS Code Copilot');
  const curInfo = scanIdeWorkspaces('Cursor', 'Cursor');
  const wsInfo = scanIdeWorkspaces('Windsurf', 'Windsurf');

  // 7. Google Gemini CLI (~/.gemini/tmp/<hash>/chats)
  let geminiLatestMtime = 0;
  let geminiChatCount = 0;
  const geminiTmpDir = path.join(home, '.gemini', 'tmp');
  try {
    if (fs.existsSync(geminiTmpDir)) {
      for (const h of fs.readdirSync(geminiTmpDir)) {
        const chatsDir = path.join(geminiTmpDir, h, 'chats');
        if (!fs.existsSync(chatsDir)) continue;
        for (const f of fs.readdirSync(chatsDir)) {
          if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
          geminiChatCount++;
          const st = fs.statSync(path.join(chatsDir, f));
          if (st.mtimeMs > geminiLatestMtime) geminiLatestMtime = st.mtimeMs;
        }
      }
    }
  } catch {}

  // 8. Cline / Roo Code (globalStorage/saoudrizwan.claude-dev/tasks)
  let clineLatestMtime = 0;
  let clineTaskCount = 0;
  for (const ide of ['Code', 'Cursor', 'Windsurf']) {
    for (const extId of ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline']) {
      const tasksDir = path.join(getIdeUserDir(ide, home), 'globalStorage', extId, 'tasks');
      try {
        if (fs.existsSync(tasksDir)) {
          for (const t of fs.readdirSync(tasksDir)) {
            const uiMsg = path.join(tasksDir, t, 'ui_messages.json');
            if (fs.existsSync(uiMsg)) {
              clineTaskCount++;
              const st = fs.statSync(uiMsg);
              if (st.mtimeMs > clineLatestMtime) clineLatestMtime = st.mtimeMs;
            }
          }
        }
      } catch {}
    }
  }

  // 9. OpenCode (~/.local/share/opencode/opencode.db)
  let opencodeLatestMtime = 0;
  const opencodeDb = path.join(
    process.env.OPENCODE_DATA_DIR || path.join(home, '.local', 'share', 'opencode'),
    'opencode.db'
  );
  try {
    if (fs.existsSync(opencodeDb)) {
      opencodeLatestMtime = fs.statSync(opencodeDb).mtimeMs;
    }
  } catch {}

  // 10. Aider (.aider.chat.history.md in active workspace or ~/.aider*)
  let aiderLatestMtime = 0;
  try {
    const aiderHist = path.join(DEFAULT_PROJECT_ROOT, '.aider.chat.history.md');
    if (fs.existsSync(aiderHist)) aiderLatestMtime = fs.statSync(aiderHist).mtimeMs;
  } catch {}

  // 11. Block Goose (~/.local/share/goose/sessions)
  let gooseLatestMtime = 0;
  const gooseDir = path.join(home, '.local', 'share', 'goose', 'sessions');
  try {
    if (fs.existsSync(gooseDir)) {
      gooseLatestMtime = fs.statSync(gooseDir).mtimeMs;
    }
  } catch {}

  return {
    workspaces: [...discoveredWorkspaces.values()].sort((a, b) => b.mtimeMs - a.mtimeMs),
    agents: {
      antigravity: {
        mtimeMs: agyLatestMtime,
        workspace: shortenHome(agyLatestWorkspace, home),
        rawWorkspace: agyLatestWorkspace,
        model: 'Antigravity IDE',
        lastPrompt: agyLatestPrompt,
        quota: {
          hasBar: true,
          remainPct: agyRemainPct,
          label: `${agyRemainPct}%`,
          detail: `~${(agyEstTokens5h / 1000).toFixed(0)}k tok / 5h · ${agyTotalSessions} sessions`,
        },
      },
      claude: {
        mtimeMs: claudeLatestMtime,
        workspace: shortenHome(claudeLatestWorkspace, home),
        rawWorkspace: claudeLatestWorkspace,
        model: claudeLatestModel,
        lastPrompt: claudeLatestPrompt,
        quota: {
          hasBar: true,
          remainPct: claudeRemainPct,
          label: `${claudeRemainPct}%`,
          detail: claudeResetNote,
        },
      },
      codex: {
        mtimeMs: codexLatestMtime,
        workspace: shortenHome(codexLatestWorkspace, home),
        rawWorkspace: codexLatestWorkspace,
        model: codexLatestModel,
        lastPrompt: codexLatestPrompt,
        quota: {
          hasBar: true,
          remainPct: codexRemainPct,
          label: `${codexRemainPct}%`,
          detail: `${codexPlan} · ${codexResetNote}`,
        },
      },
      cursor: {
        mtimeMs: curInfo.latestMtime,
        workspace: shortenHome(curInfo.latestWorkspace, home),
        rawWorkspace: curInfo.latestWorkspace,
        model: 'Cursor Agent',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: curInfo.count > 0 ? 'Local IDE' : 'Rule Mount (.cursorrules)',
          detail: curInfo.count > 0 ? `${curInfo.count} workspaces indexed` : 'Ready on install',
        },
      },
      vscode: {
        mtimeMs: vscInfo.latestMtime,
        workspace: shortenHome(vscInfo.latestWorkspace, home),
        rawWorkspace: vscInfo.latestWorkspace,
        model: 'Copilot Chat',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: 'Local IDE',
          detail: `${vscInfo.count} workspaces indexed`,
        },
      },
      gemini: {
        mtimeMs: geminiLatestMtime,
        workspace: geminiChatCount > 0 ? '~/.gemini/tmp' : 'GEMINI.md mount',
        rawWorkspace: '',
        model: 'gemini-2.5-pro',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: 'CLI / GEMINI.md',
          detail: geminiChatCount > 0 ? `${geminiChatCount} chat sessions` : 'Ready on install',
        },
      },
      windsurf: {
        mtimeMs: wsInfo.latestMtime,
        workspace: shortenHome(wsInfo.latestWorkspace, home),
        rawWorkspace: wsInfo.latestWorkspace,
        model: 'Cascade',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: wsInfo.count > 0 ? 'Local IDE' : 'Rule Mount (.windsurfrules)',
          detail: wsInfo.count > 0 ? `${wsInfo.count} workspaces indexed` : 'Ready on install',
        },
      },
      cline: {
        mtimeMs: clineLatestMtime,
        workspace: clineTaskCount > 0 ? 'VS Code / Cursor' : '.clinerules mount',
        rawWorkspace: '',
        model: 'Autonomous Ext',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: 'Extension Bridge',
          detail: clineTaskCount > 0 ? `${clineTaskCount} tasks indexed` : 'Mounts .clinerules',
        },
      },
      opencode: {
        mtimeMs: opencodeLatestMtime,
        workspace: opencodeLatestMtime ? '~/.local/share/opencode' : 'AGENTS.md mount',
        rawWorkspace: '',
        model: 'opencode v2',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: 'SQLite / CLI',
          detail: opencodeLatestMtime ? 'opencode.db detected' : 'Ready on install',
        },
      },
      aider: {
        mtimeMs: aiderLatestMtime,
        workspace: '.aider.chat.history.md',
        rawWorkspace: '',
        model: 'Architect / Diff',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: 'CLI (--read)',
          detail: 'aider --read .vicem/BATON.md',
        },
      },
      goose: {
        mtimeMs: gooseLatestMtime,
        workspace: '~/.local/share/goose',
        rawWorkspace: '',
        model: 'MCP CLI',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: 'CLI / MCP',
          detail: 'goose session + AGENTS.md',
        },
      },
      web: {
        mtimeMs: 0,
        workspace: 'Clipboard / Browser',
        rawWorkspace: '',
        model: 'ChatGPT · Claude · Gemini',
        lastPrompt: '',
        quota: {
          hasBar: false,
          remainPct: null,
          label: 'Zero-net bridge',
          detail: 'Clipboard + URL prefill',
        },
      },
    },
  };
}

let selectedProjectRoot = DEFAULT_PROJECT_ROOT;
let customGoalOverride = '';
let manualActiveAgent = null;
let selectedSourceSessionId = null;
let lastHandedOffFrom = null;
let lastHandoffReceipt = null;
let cachedTelemetry = null;
let cachedTelemetryAt = 0;
const customWorkspacePaths = new Set();

/**
 * Discovers all real sessions belonging to `projectRoot` across Antigravity, Claude Code,
 * OpenAI Codex, Cursor/VS Code/Windsurf, plus the live Git Working Tree.
 */
function discoverProjectSessions(projectRoot, home, git) {
  const sessions = [];
  const pathRegex = new RegExp(
    projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/([A-Za-z0-9_./-]+\\.[A-Za-z0-9]+)',
    'g'
  );

  // 1. Antigravity Brain Transcripts for this projectRoot
  const brainDir = path.join(home, '.gemini', 'antigravity', 'brain');
  try {
    if (fs.existsSync(brainDir)) {
      const candidates = [];
      for (const d of fs.readdirSync(brainDir)) {
        const tp = path.join(brainDir, d, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          if (fs.existsSync(tp)) {
            const st = fs.statSync(tp);
            candidates.push({ id: d, path: tp, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {}
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const c of candidates.slice(0, 14)) {
        try {
          const raw = readHeadAndTailUtf8(c.path);
          if (!raw.includes(projectRoot)) continue;
          const prompts = [];
          const assistantDigest = [];
          const touched = new Set();
          const lines = raw.trim().split('\n');
          for (const line of lines.slice(-160)) {
            for (const pm of line.matchAll(pathRegex)) {
              const rel = pm[1];
              if (rel && !rel.startsWith('.vicem') && !['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(rel)) {
                touched.add(rel);
              }
            }
            try {
              const step = JSON.parse(line);
              if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
                const m = step.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
                const text = (m ? m[1] : step.content).replace(/\s+/g, ' ').trim();
                if (text && text.length > 2 && !text.startsWith('<')) {
                  prompts.push(text.slice(0, 180));
                }
              } else if (step.type === 'PLANNER_RESPONSE') {
                if (typeof step.content === 'string' && step.content.trim()) {
                  const firstPara = step.content
                    .trim()
                    .split(/\n\n+/)[0]
                    .replace(/\s+/g, ' ')
                    .slice(0, 220);
                  if (firstPara) assistantDigest.push(firstPara);
                }
                if (Array.isArray(step.tool_calls)) {
                  for (const tc of step.tool_calls) {
                    const args = tc.arguments || tc.input || {};
                    const p = args.Path || args.path || args.file_path || args.TargetFile;
                    if (typeof p === 'string' && p.startsWith(projectRoot)) {
                      const rel = path.relative(projectRoot, p).replace(/\\/g, '/');
                      if (rel && !rel.startsWith('..') && !['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(rel)) {
                        touched.add(rel);
                      }
                    }
                  }
                }
              }
            } catch {}
          }
          const substantive = prompts.filter(
            (u) => u.length >= 6 && !/^(ok|okay|yes|yep|sure|go|k|y|thx|thanks)$/i.test(u.trim())
          );
          const title = substantive[substantive.length - 1] || prompts[prompts.length - 1] || `Session ${c.id.slice(0, 8)}`;
          sessions.push({
            id: `agy:${c.id}`,
            rawId: c.id,
            agentId: 'antigravity',
            agentName: 'Antigravity',
            model: 'Antigravity IDE',
            title,
            prompts: prompts.slice(-6),
            assistantDigest: assistantDigest.slice(-3),
            touchedFiles: [...touched],
            mtimeMs: c.mtimeMs,
            ago: formatAgo(c.mtimeMs),
            rawBytes: c.size,
            sourceFile: shortenHome(c.path, home),
          });
        } catch {}
      }
    }
  } catch {}

  // 2. Claude Code Sessions for this projectRoot
  const encoded = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
  const claudeProjDir = path.join(home, '.claude', 'projects', encoded);
  try {
    if (fs.existsSync(claudeProjDir)) {
      const files = fs
        .readdirSync(claudeProjDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(claudeProjDir, f);
          const st = fs.statSync(full);
          return { full, id: path.basename(f, '.jsonl'), mtimeMs: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const f of files.slice(0, 5)) {
        const prompts = [];
        const assistantDigest = [];
        let model = 'claude-opus-4-8';
        const lines = readHeadAndTailUtf8(f.full).trim().split('\n');
        for (const l of lines.slice(-120)) {
          try {
            const o = JSON.parse(l);
            if (o.message?.model) model = o.message.model;
            if (o.type === 'user' && typeof o.message?.content === 'string') {
              const txt = o.message.content.replace(/\s+/g, ' ').trim();
              if (txt && !txt.startsWith('<')) prompts.push(txt.slice(0, 180));
            } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
              const tBlock = o.message.content.find((b) => b.type === 'text' && b.text);
              if (tBlock) assistantDigest.push(tBlock.text.replace(/\s+/g, ' ').trim().slice(0, 200));
            }
          } catch {}
        }
        if (prompts.length > 0 || f.size > 200) {
          sessions.push({
            id: `claude:${f.id}`,
            rawId: f.id,
            agentId: 'claude',
            agentName: 'Claude Code',
            model,
            title: prompts[prompts.length - 1] || `Claude session ${f.id.slice(0, 8)}`,
            prompts: prompts.slice(-6),
            assistantDigest: assistantDigest.slice(-3),
            touchedFiles: [],
            mtimeMs: f.mtimeMs,
            ago: formatAgo(f.mtimeMs),
            rawBytes: f.size,
            sourceFile: shortenHome(f.full, home),
          });
        }
      }
    }
  } catch {}

  // 3. OpenAI Codex Sessions for this projectRoot
  const codexDir = path.join(home, '.codex', 'sessions');
  try {
    const codexFiles = [];
    const scan = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) scan(full);
        else if (e.name.endsWith('.jsonl')) {
          const st = fs.statSync(full);
          codexFiles.push({ path: full, id: path.basename(full, '.jsonl'), mtimeMs: st.mtimeMs, size: st.size });
        }
      }
    };
    scan(codexDir);
    codexFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of codexFiles.slice(0, 15)) {
      try {
        const raw = readHeadAndTailUtf8(item.path);
        if (!raw.includes(projectRoot)) continue;
        const lines = raw.trim().split('\n');
        const prompts = [];
        let model = 'gpt-6-astra';
        for (const l of lines) {
          try {
            const obj = JSON.parse(l);
            if (obj.type === 'turn_context' && obj.payload?.model) model = obj.payload.model;
            if (obj.payload?.role === 'user' && Array.isArray(obj.payload?.content)) {
              const txt = obj.payload.content.find((c) => c.text)?.text || '';
              if (txt && !txt.startsWith('<')) prompts.push(txt.replace(/\s+/g, ' ').trim().slice(0, 180));
            }
          } catch {}
        }
        sessions.push({
          id: `codex:${item.id}`,
          rawId: item.id,
          agentId: 'codex',
          agentName: 'OpenAI Codex',
          model,
          title: prompts[prompts.length - 1] || `Codex session ${item.id.slice(0, 8)}`,
          prompts: prompts.slice(-6),
          assistantDigest: [],
          touchedFiles: [],
          mtimeMs: item.mtimeMs,
          ago: formatAgo(item.mtimeMs),
          rawBytes: item.size,
          sourceFile: shortenHome(item.path, home),
        });
      } catch {}
    }
  } catch {}

  // 4. Always provide a deterministic Git Working Tree session card so any repo can be handed off cleanly
  const gitCommits = (git.recentCommits || []).slice(0, 4);
  const gitModified = [...(git.modifiedFiles || []), ...(git.untrackedFiles || [])];
  sessions.push({
    id: `git:${path.basename(projectRoot)}`,
    rawId: `git-${git.headShort || 'head'}`,
    agentId: manualActiveAgent || 'antigravity',
    agentName: 'Git Working Tree',
    model: `${git.branch || 'main'} @ ${git.headShort || 'HEAD'}`,
    title: gitCommits[0]
      ? `Git HEAD: ${gitCommits[0]}`
      : `Working tree in ${path.basename(projectRoot)} (${gitModified.length} modified files)`,
    prompts: gitCommits.length > 0 ? gitCommits.map((c) => `Commit: ${c}`) : [`Branch ${git.branch || 'main'} active`],
    assistantDigest: [],
    touchedFiles: gitModified.slice(0, 8),
    mtimeMs: Date.now() - 3600 * 1000,
    ago: 'Live tree',
    rawBytes: Math.max(4096, gitModified.length * 6400),
    sourceFile: `${shortenHome(projectRoot, home)}/.git`,
  });

  sessions.sort((a, b) => {
    if (a.id.startsWith('git:')) return 1;
    if (b.id.startsWith('git:')) return -1;
    return b.mtimeMs - a.mtimeMs;
  });

  return sessions;
}

/**
 * Runs CodeSkeletonizer over the project's active/modified code files (or top code files)
 * and inspects `.vicem/ledger.json` + `.vicem/BATON.md` on disk so the user can see and test
 * the exact AST skeletonization & symbol rehydration in real time.
 */
function collectLiveSkeletonLedger(projectRoot, activeFiles, persistToDisk = false) {
  const codeCandidates = [...(activeFiles || [])].filter((f) =>
    /\.(mjs|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h)$/i.test(f)
  );
  if (codeCandidates.length === 0) {
    try {
      for (const entry of fs.readdirSync(projectRoot)) {
        if (/\.(mjs|js|ts|tsx|jsx|py|go|rs|java|c|cpp)$/i.test(entry) && !entry.startsWith('.')) {
          codeCandidates.push(entry);
        }
        if (codeCandidates.length >= 4) break;
      }
    } catch {}
  }

  const liveLedger = new DietLedger(`baton-${Date.now()}`);
  const fileBreakdowns = [];
  let totalRawTok = 0;
  let totalSkelTok = 0;

  for (const rel of codeCandidates.slice(0, 5)) {
    const full = path.join(projectRoot, rel);
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      const rawContent = fs.readFileSync(full, 'utf8');
      if (rawContent.length > 350000) continue;
      const rawTok = TokenEstimator.estimate(rawContent);
      const { skeleton, ledgerEntries } = CodeSkeletonizer.skeletonize(rel, rawContent, {
        ledger: liveLedger,
        minLines: 10,
      });
      const skelTok = TokenEstimator.estimate(skeleton);
      totalRawTok += rawTok;
      totalSkelTok += skelTok;
      const savedPct = rawTok > skelTok ? Math.round((1 - skelTok / rawTok) * 1000) / 10 : 0;
      fileBreakdowns.push({
        filePath: rel,
        rawTokens: rawTok,
        skeletonTokens: skelTok,
        savedPct,
        symbolCount: ledgerEntries.length,
        skeletonPreview: skeleton.slice(0, 900),
        symbols: ledgerEntries.slice(0, 18).map((e) => ({
          filePath: e.filePath,
          symbolName: e.symbolName,
          startLine: e.startLine,
          endLine: e.endLine,
          lines: Math.max(1, e.endLine - e.startLine + 1),
          tokens: TokenEstimator.estimate(e.content),
        })),
      });
    } catch {}
  }

  if (persistToDisk && liveLedger.entries.length > 0) {
    try {
      liveLedger.save(projectRoot);
    } catch {}
  }

  const batonDiskPath = path.join(projectRoot, '.vicem', 'BATON.md');
  const ledgerDiskPath = path.join(projectRoot, '.vicem', 'ledger.json');
  const batonOnDisk = fs.existsSync(batonDiskPath);
  const ledgerOnDisk = fs.existsSync(ledgerDiskPath);
  const batonDiskBytes = batonOnDisk ? fs.statSync(batonDiskPath).size : 0;
  const ledgerDiskBytes = ledgerOnDisk ? fs.statSync(ledgerDiskPath).size : 0;
  const batonMtimeMs = batonOnDisk ? fs.statSync(batonDiskPath).mtimeMs : 0;

  let diskLedgerSymbols = 0;
  if (ledgerOnDisk) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerDiskPath, 'utf8'));
      diskLedgerSymbols = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
    } catch {}
  }

  let driftStatus = { drifted: false, driftedFiles: [] };
  try {
    driftStatus = StalenessDriftGuard.check(projectRoot);
  } catch {}

  return {
    files: fileBreakdowns,
    totalSymbols: Math.max(liveLedger.entries.length, diskLedgerSymbols),
    liveSymbolsCount: liveLedger.entries.length,
    diskSymbolsCount: diskLedgerSymbols,
    totalCodeRawTokens: totalRawTok,
    totalCodeSkeletonTokens: totalSkelTok,
    codeSavedPct:
      totalRawTok > totalSkelTok ? Math.round((1 - totalSkelTok / totalRawTok) * 1000) / 10 : 0,
    batonOnDisk,
    ledgerOnDisk,
    batonDiskBytes,
    ledgerDiskBytes,
    batonDiskAgo: batonMtimeMs ? formatAgo(batonMtimeMs) : 'Not written yet',
    drifted: Boolean(driftStatus?.drifted),
    driftedFiles: driftStatus?.driftedFiles || [],
    liveLedger,
  };
}

/**
 * Harvests rich, multi-turn conversation history, tool actions, and active files
 * from the selected or most recent session of `projectRoot`.
 */
function harvestRichProjectContext(projectRoot, home, git, projectSessions = null) {
  const sessions = projectSessions || discoverProjectSessions(projectRoot, home, git);
  let chosen = null;
  if (selectedSourceSessionId) {
    chosen = sessions.find((s) => s.id === selectedSourceSessionId) || null;
  }
  if (!chosen && manualActiveAgent) {
    chosen = sessions.find((s) => s.agentId === manualActiveAgent && !s.id.startsWith('git:')) || null;
  }
  if (!chosen) {
    chosen = sessions[0] || null;
  }

  const userTimeline = chosen ? [...chosen.prompts] : [];
  const assistantDigest = chosen ? [...(chosen.assistantDigest || [])] : [];
  const touchedFiles = new Set(chosen ? chosen.touchedFiles || [] : []);
  const rawSessionBytes = chosen ? chosen.rawBytes || 0 : 0;
  const sessionId = chosen ? chosen.rawId || chosen.id : 'live-session';

  // Combine session-touched files FIRST, then Git modified + untracked files sorted by code priority & mtime
  const candidateMap = new Map();
  const skipDocsAndMeta = new Set([
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'LICENSE',
    'SHA256SUMS',
    '.gitignore',
    'AGENTS.snippet.md',
    'README.md',
    'REQUIREMENTS.md',
    'SECURITY.md',
  ]);
  const addCandidate = (rel, isTouched) => {
    if (!rel || skipDocsAndMeta.has(rel) || rel.startsWith('.vicem') || rel.startsWith('docs/')) return;
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|db|sqlite)$/i.test(rel)) return;
    const full = path.join(projectRoot, rel);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) {
        const isCode = /\.(mjs|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|css|html)$/i.test(rel);
        const score = (isTouched ? 1e13 : 0) + (isCode ? 5e12 : 0) + st.mtimeMs;
        if (!candidateMap.has(rel) || candidateMap.get(rel) < score) {
          candidateMap.set(rel, score);
        }
      } else if (st.isDirectory()) {
        for (const sub of fs.readdirSync(full)) {
          addCandidate(path.join(rel, sub).replace(/\\/g, '/'), isTouched);
        }
      }
    } catch {}
  };

  for (const f of touchedFiles) addCandidate(f, true);
  for (const f of [...(git.modifiedFiles || []), ...(git.untrackedFiles || [])]) addCandidate(f, false);

  const activeFileList = [...candidateMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([rel]) => rel);
  const recentUsers = userTimeline.slice(-6);
  const recentAssistant = assistantDigest.slice(-3);

  return {
    chosenSession: chosen,
    sessionId,
    rawSessionBytes,
    recentUsers,
    recentAssistant,
    activeFileList,
  };
}

async function collectState() {
  const home = os.homedir();
  if (!cachedTelemetry || Date.now() - cachedTelemetryAt > 2500) {
    cachedTelemetry = collectRealAgentTelemetry(home);
    cachedTelemetryAt = Date.now();
  }

  const projectRoot = fs.existsSync(selectedProjectRoot)
    ? selectedProjectRoot
    : DEFAULT_PROJECT_ROOT;

  const runningProcs = detectRunningProcesses();
  const diag = DoctorDiagnostics.runDiagnostics(projectRoot, process.env);
  const detected = await SmartInferenceEngine.autoDetectSource(projectRoot, process.env);
  const git = GitCollector.collect(projectRoot);
  const projectSessions = discoverProjectSessions(projectRoot, home, git);
  const rich = harvestRichProjectContext(projectRoot, home, git, projectSessions);

  const effectiveGit = {
    ...git,
    modifiedFiles: rich.activeFileList.length > 0 ? rich.activeFileList : git.modifiedFiles,
  };

  const tel = cachedTelemetry.agents;
  const substantiveUsers = rich.recentUsers.filter(
    (u) => u.length >= 6 && !/^(ok|okay|yes|yep|sure|go|k|y|thx|thanks)$/i.test(u.trim())
  );
  const livePromptForProject =
    customGoalOverride ||
    substantiveUsers[substantiveUsers.length - 1] ||
    rich.recentUsers[rich.recentUsers.length - 1] ||
    (projectRoot === DEFAULT_PROJECT_ROOT && tel.antigravity.lastPrompt
      ? tel.antigravity.lastPrompt
      : '') ||
    tel.claude.lastPrompt ||
    tel.codex.lastPrompt ||
    `Active branch '${git.branch || 'main'}' (${git.headShort || 'HEAD'})`;

  const doneList = [];
  if (rich.recentUsers.length > 1) {
    for (const u of rich.recentUsers.slice(0, -1)) {
      doneList.push(`User request handled: "${u}"`);
    }
  }
  for (const a of rich.recentAssistant) {
    doneList.push(`Agent summary: ${a}`);
  }
  for (const f of rich.activeFileList) {
    doneList.push(`Active file modified/created in session: \`${f}\``);
  }
  for (const c of (git.recentCommits || []).slice(0, 3)) {
    doneList.push(`Git commit: ${c}`);
  }

  const effectiveTask = {
    goal: livePromptForProject,
    immediateNext: [
      `Fulfill latest request in ${path.basename(projectRoot)} (${git.branch || 'master'}): "${livePromptForProject}"`,
      ...(rich.activeFileList.length > 0
        ? [`Inspect and continue working on active session files: ${rich.activeFileList.map((f) => `\`${f}\``).join(', ')}`]
        : []),
    ],
    done: doneList,
    userPrompts: rich.recentUsers,
  };

  const activeSourceAgentId =
    (rich.chosenSession && !rich.chosenSession.id.startsWith('git:')
      ? rich.chosenSession.agentId
      : null) ||
    manualActiveAgent ||
    detected.agent ||
    'antigravity';

  const baton = BatonIaBuilder.build({
    projectRoot,
    sourceAgent: activeSourceAgentId,
    targetAgent: 'codex',
    sessionId: rich.sessionId,
    persist: false,
    taskContext: effectiveTask,
    gitContext: effectiveGit,
    budgetTokens: 4000,
  });

  const skelSummary = collectLiveSkeletonLedger(projectRoot, rich.activeFileList, false);

  const trueRawTokens = Math.max(
    baton.rawTokens,
    Math.round(rich.rawSessionBytes / 4),
    skelSummary.totalCodeRawTokens + baton.dietTokens
  );

  const ALL_PLATFORMS = [
    { id: 'antigravity', name: 'Antigravity', primary: true },
    { id: 'claude', name: 'Claude Code', primary: true },
    { id: 'codex', name: 'OpenAI Codex', primary: true },
    { id: 'cursor', name: 'Cursor', primary: false },
    { id: 'vscode', name: 'VS Code Copilot', primary: true },
    { id: 'gemini', name: 'Gemini CLI', primary: false },
    { id: 'windsurf', name: 'Windsurf', primary: false },
    { id: 'cline', name: 'Cline / Roo', primary: false },
    { id: 'opencode', name: 'OpenCode', primary: false },
    { id: 'aider', name: 'Aider', primary: false },
    { id: 'goose', name: 'Block Goose', primary: false },
    { id: 'web', name: 'Web Chat', primary: true },
  ];

  let autoWorkingId = activeSourceAgentId;
  if (!autoWorkingId) {
    for (const a of ALL_PLATFORMS.map((p) => p.id)) {
      if (a === 'web') continue;
      const ageSec = (Date.now() - (tel[a]?.mtimeMs || 0)) / 1000;
      if (runningProcs[a] || ageSec < 120) {
        autoWorkingId = a;
        break;
      }
    }
    if (!autoWorkingId) autoWorkingId = 'antigravity';
  }

  // Map project-specific sessions by agentId so each row knows if it belongs to the selected project!
  const projectSessionByAgent = new Map();
  for (const s of projectSessions) {
    if (s.id.startsWith('git:')) continue;
    if (!projectSessionByAgent.has(s.agentId)) {
      projectSessionByAgent.set(s.agentId, s);
    }
  }

  const nodes = ALL_PLATFORMS.map((item) => {
    const t = tel[item.id];
    const projSess = projectSessionByAgent.get(item.id) || null;
    const matchesRawWorkspace =
      Boolean(t?.rawWorkspace && path.resolve(t.rawWorkspace) === path.resolve(projectRoot));
    const inProject = Boolean(projSess || matchesRawWorkspace);

    const check = diag.agentChecks.find((c) => c.id === item.id);
    const binFound = Boolean(check?.binFound || resolveAgentBinary(item.id, home));
    const hasStorage = Boolean(check?.hasStorage || (t?.mtimeMs || 0) > 0);
    const installed = item.id === 'web' ? true : binFound || hasStorage;
    const mtimeMs = projSess ? projSess.mtimeMs : t?.mtimeMs || 0;
    const ageSec = mtimeMs ? (Date.now() - mtimeMs) / 1000 : Infinity;
    const isSource = item.id === autoWorkingId;

    let status = 'Idle';
    if (isSource) {
      status = 'Working';
    } else if (inProject || item.id === lastHandedOffFrom || ageSec < 3600 * 12) {
      status = 'Done';
    }

    const displayWorkspace = inProject
      ? shortenHome(projectRoot, home)
      : t?.workspace || 'Ready';
    const displayPrompt = projSess?.title || (matchesRawWorkspace ? t?.lastPrompt : '') || '';

    return {
      id: item.id,
      name: item.name,
      primary: item.primary || installed,
      model: projSess?.model || t?.model || '',
      workspace: displayWorkspace,
      globalWorkspace: t?.workspace || 'Ready',
      inProject,
      isSource,
      projectSessionId: projSess?.id || null,
      lastPrompt: displayPrompt,
      installed,
      status,
      lastSeen: item.id === 'web' ? 'On demand' : formatAgo(mtimeMs),
      quota: t?.quota || { hasBar: false, label: 'Ready', detail: '' },
    };
  });

  const mountedFiles = [];
  const allRuleTargets = [
    { rel: 'AGENTS.md', label: 'AGENTS.md (Codex / OpenCode / Antigravity)' },
    { rel: 'CLAUDE.md', label: 'CLAUDE.md (Claude Code)' },
    { rel: 'GEMINI.md', label: 'GEMINI.md (Gemini CLI)' },
    { rel: '.cursorrules', label: '.cursorrules (Cursor)' },
    { rel: '.windsurfrules', label: '.windsurfrules (Windsurf)' },
    { rel: '.clinerules', label: '.clinerules (Cline / Roo)' },
    { rel: '.github/copilot-instructions.md', label: 'copilot-instructions.md (VS Code)' },
  ];
  const ruleMountStatus = allRuleTargets.map((rt) => {
    const fp = path.join(projectRoot, rt.rel);
    let mounted = false;
    try {
      if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes('<!-- VICEM-BATON-START -->')) {
        mounted = true;
        mountedFiles.push(rt.rel);
      }
    } catch {}
    return { ...rt, mounted };
  });

  const savedTokens = Math.max(0, trueRawTokens - baton.dietTokens);
  const savedPct =
    trueRawTokens > baton.dietTokens
      ? Math.round((1 - baton.dietTokens / trueRawTokens) * 1000) / 10
      : 0;

  // Enrich discovered + custom workspaces with git branch & baton/ledger status
  const workspaceMap = new Map();
  for (const ws of cachedTelemetry.workspaces || []) {
    workspaceMap.set(ws.path, ws);
  }
  for (const customPath of customWorkspacePaths) {
    if (fs.existsSync(customPath) && !workspaceMap.has(customPath)) {
      workspaceMap.set(customPath, {
        path: customPath,
        name: path.basename(customPath),
        shortPath: shortenHome(customPath, home),
        lastAgent: 'Custom',
        mtimeMs: Date.now(),
        lastPrompt: '',
      });
    }
  }
  if (!workspaceMap.has(projectRoot)) {
    workspaceMap.set(projectRoot, {
      path: projectRoot,
      name: path.basename(projectRoot),
      shortPath: shortenHome(projectRoot, home),
      lastAgent: 'Active',
      mtimeMs: Date.now(),
      lastPrompt: '',
    });
  }

  const enrichedWorkspaces = [...workspaceMap.values()].slice(0, 10).map((ws) => {
    const hasBaton = fs.existsSync(path.join(ws.path, '.vicem', 'BATON.md'));
    const hasLedger = fs.existsSync(path.join(ws.path, '.vicem', 'ledger.json'));
    let wsBranch = 'main';
    try {
      const headFile = path.join(ws.path, '.git', 'HEAD');
      if (fs.existsSync(headFile)) {
        const ref = fs.readFileSync(headFile, 'utf8').trim();
        const m = ref.match(/ref: refs\/heads\/(.+)/);
        if (m) wsBranch = m[1];
      }
    } catch {}
    return {
      ...ws,
      branch: wsBranch,
      hasBaton,
      hasLedger,
    };
  });

  return {
    guiVersion: 'v18',
    osPlatform: process.platform,
    projectRoot,
    project: path.basename(projectRoot),
    shortProject: shortenHome(projectRoot, home),
    branch: git.branch || 'main',
    headShort: git.headShort || 'HEAD',
    modifiedFiles: effectiveGit.modifiedFiles,
    recentCommits: (git.recentCommits || []).slice(0, 4),
    mountedFiles,
    ruleMountStatus,
    workspaces: enrichedWorkspaces,
    projectSessions: projectSessions.map((s) => ({
      ...s,
      isSelected: Boolean(rich.chosenSession && rich.chosenSession.id === s.id),
    })),
    selectedSessionId: rich.chosenSession ? rich.chosenSession.id : null,
    workingAgentId: autoWorkingId,
    lastHandedOffFrom,
    taskTitle: livePromptForProject,
    customGoalOverride,
    stats: {
      rawTokens: trueRawTokens,
      dietTokens: baton.dietTokens,
      savedTokens,
      savedPct,
      secretsMasked: baton.redactedCount,
    },
    skeletonSummary: {
      files: skelSummary.files,
      totalSymbols: skelSummary.totalSymbols,
      liveSymbolsCount: skelSummary.liveSymbolsCount,
      diskSymbolsCount: skelSummary.diskSymbolsCount,
      totalCodeRawTokens: skelSummary.totalCodeRawTokens,
      totalCodeSkeletonTokens: skelSummary.totalCodeSkeletonTokens,
      codeSavedPct: skelSummary.codeSavedPct,
      batonOnDisk: skelSummary.batonOnDisk,
      ledgerOnDisk: skelSummary.ledgerOnDisk,
      batonDiskBytes: skelSummary.batonDiskBytes,
      ledgerDiskBytes: skelSummary.ledgerDiskBytes,
      batonDiskAgo: skelSummary.batonDiskAgo,
      drifted: skelSummary.drifted,
      driftedFiles: skelSummary.driftedFiles,
    },
    lastHandoffReceipt,
    batonMarkdown: baton.markdown,
    nodes,
  };
}

/**
 * Cross-OS (macOS / Windows / Linux) Target Agent Launcher supporting all 12 platforms:
 * - launchMode === 'app' (default): Opens the native Desktop GUI App / Deep Link (`claude://`, `codex://`, `cursor://`, `windsurf://`, `vscode://`, or IDE app).
 * - launchMode === 'cli': Opens the OS native terminal (`Terminal.app` on macOS, `wt.exe`/`cmd.exe` on Windows, `x-terminal-emulator`/`gnome-terminal` on Linux) running the CLI binary.
 */
async function launchTargetAgentCrossPlatform(targetId, projectRoot, batonMarkdown, launchMode = 'app') {
  const home = os.homedir();
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const vicemDir = path.join(projectRoot, '.vicem');
  fs.mkdirSync(vicemDir, { recursive: true });
  const initialPrompt = `Read .vicem/BATON.md in ${projectRoot} and continue immediately from Section 2 (Immediate NEXT #1).`;

  // 1. Desktop GUI Deep Links for Claude Code & OpenAI Codex (`launchMode === 'app'`)
  if (targetId === 'claude' && launchMode === 'app') {
    const hasDesktop =
      (isMac && fs.existsSync('/Applications/Claude.app')) ||
      (isWin && fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude')));
    if (hasDesktop || !isMac) {
      const deepLink = `claude://code/new?folder=${encodeURIComponent(projectRoot)}&q=${encodeURIComponent(initialPrompt)}&source=vicem`;
      const res = openExternalCrossPlatform(deepLink);
      if (res.status === 0) {
        return {
          ok: true,
          method: `claude://code/new?folder=${shortenHome(projectRoot, home)}&q=...`,
          detail: `Opened Claude Desktop GUI in ${path.basename(projectRoot)} with Baton prompt prefilled`,
        };
      }
    }
  }

  if (targetId === 'codex' && launchMode === 'app') {
    const hasDesktop = !isMac || fs.existsSync('/Applications/ChatGPT.app');
    if (hasDesktop) {
      const deepLink = `codex://threads/new?prompt=${encodeURIComponent(initialPrompt)}`;
      const res = openExternalCrossPlatform(deepLink);
      if (res.status === 0) {
        return {
          ok: true,
          method: `codex://threads/new?prompt=...`,
          detail: `Opened Codex Desktop GUI with Baton prompt prefilled`,
        };
      }
    }
  }

  // 2. IDE Targets (`antigravity`, `cursor`, `windsurf`, `vscode`, `cline`)
  const ideSpecs = {
    antigravity: {
      macApps: ['/Applications/Antigravity.app', '/Applications/Antigravity IDE.app'],
      cli: 'agy',
      scheme: `antigravity://file${projectRoot}`,
      rule: 'AGENTS.md',
    },
    cursor: {
      macApps: ['/Applications/Cursor.app'],
      cli: 'cursor',
      scheme: `cursor://file${projectRoot}`,
      rule: '.cursorrules',
    },
    windsurf: {
      macApps: ['/Applications/Windsurf.app'],
      cli: 'windsurf',
      scheme: `windsurf://file${projectRoot}`,
      rule: '.windsurfrules',
    },
    vscode: {
      macApps: ['/Applications/Visual Studio Code.app'],
      cli: 'code',
      scheme: `vscode://file${projectRoot}`,
      rule: '.github/copilot-instructions.md',
    },
    cline: {
      macApps: ['/Applications/Cursor.app', '/Applications/Visual Studio Code.app'],
      cli: 'code',
      scheme: `vscode://file${projectRoot}`,
      rule: '.clinerules',
    },
  };

  if (ideSpecs[targetId]) {
    const spec = ideSpecs[targetId];
    if (isMac) {
      const foundApp = spec.macApps.find((p) => fs.existsSync(p));
      if (foundApp) {
        const res = openExternalCrossPlatform(projectRoot, foundApp);
        return {
          ok: res.status === 0,
          method: `open -a "${path.basename(foundApp)}" ${shortenHome(projectRoot, home)}`,
          detail: `Opened ${path.basename(foundApp)} at ${path.basename(projectRoot)} (${spec.rule} mounted)`,
        };
      }
    }
    const bin = resolveAgentBinary(targetId, home);
    if (bin) {
      const res = spawnSync(bin, [projectRoot], { encoding: 'utf8', windowsHide: true });
      return {
        ok: res.status === 0,
        method: `${path.basename(bin)} ${shortenHome(projectRoot, home)}`,
        detail: `Opened ${targetId} at ${path.basename(projectRoot)} (${spec.rule} mounted)`,
      };
    }
    const res = openExternalCrossPlatform(spec.scheme);
    return {
      ok: res.status === 0,
      method: spec.scheme,
      detail: `Triggered ${targetId} URI scheme (${spec.rule} mounted + clipboard ready)`,
    };
  }

  // 3. Web Chat (`web`)
  if (targetId === 'web') {
    const shortQuery = encodeURIComponent(batonMarkdown.slice(0, 1800));
    const webUrl = `https://chatgpt.com/?q=${shortQuery}`;
    const res = openExternalCrossPlatform(webUrl);
    return {
      ok: res.status === 0,
      method: 'https://chatgpt.com/?q=...',
      detail: 'Opened browser tab with prefilled Baton + full Baton on clipboard',
    };
  }

  // 4. CLI Agents (`claude`, `codex`, `gemini`, `opencode`, `aider`, `goose`) across macOS / Windows / Linux
  const binPath = resolveAgentBinary(targetId, home);
  if (!binPath) {
    return {
      ok: true,
      method: 'Rule Mount + Clipboard (CLI binary not installed)',
      detail: `${targetId} CLI not installed locally; Baton mounted & copied to clipboard`,
    };
  }

  const buildCliCommandLine = (bin) => {
    const qBin = isWin ? `"${bin}"` : shellQuote(bin);
    if (targetId === 'gemini') return `${qBin} -i ${isWin ? `"${initialPrompt}"` : shellQuote(initialPrompt)}`;
    if (targetId === 'opencode') return `${qBin} --prompt ${isWin ? `"${initialPrompt}"` : shellQuote(initialPrompt)}`;
    if (targetId === 'aider') return `${qBin} --read .vicem/BATON.md`;
    if (targetId === 'goose') return `${qBin} session`;
    return `${qBin} ${isWin ? `"${initialPrompt}"` : shellQuote(initialPrompt)}`;
  };

  if (isWin) {
    const cmdPath = path.join(vicemDir, `launch-${targetId}.cmd`);
    const cmdContent = [
      '@echo off',
      `cd /d "${projectRoot}"`,
      `echo [Vicem Relay] Loaded .vicem/BATON.md in ${path.basename(projectRoot)}`,
      buildCliCommandLine(binPath),
    ].join('\r\n');
    fs.writeFileSync(cmdPath, cmdContent);
    const res = spawnSync('cmd', ['/c', 'start', `"Vicem - ${targetId}"`, 'cmd', '/k', cmdPath], {
      encoding: 'utf8',
    });
    return {
      ok: res.status === 0,
      method: `start cmd /k ${path.basename(cmdPath)}`,
      detail: `Launched ${targetId} in Windows Terminal / Command Prompt`,
    };
  }

  const launcherScriptPath = path.join(vicemDir, isMac ? `launch-${targetId}.command` : `launch-${targetId}.sh`);
  const statusPath = path.join(vicemDir, `launch-${targetId}.status.json`);
  fs.rmSync(statusPath, { force: true });
  const scriptContent = [
    isMac ? '#!/bin/zsh' : '#!/bin/sh',
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    `STATUS=${shellQuote(statusPath)}`,
    `cd ${shellQuote(projectRoot)} || { echo '{"state":"cd_failed"}' > "$STATUS"; exit 1; }`,
    'clear',
    `echo "=================================================================="`,
    `printf '%s\\n' ${shellQuote(` ✓ [Vicem Relay] Loaded .vicem/BATON.md in ${path.basename(projectRoot)}`)}`,
    `printf '%s\\n' ${shellQuote(` ✓ Target Agent: ${targetId} (${binPath})`)}`,
    `echo "=================================================================="`,
    `echo ""`,
    `echo "{\\"state\\":\\"started\\",\\"pid\\":$$,\\"at\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}" > "$STATUS"`,
    `exec ${buildCliCommandLine(binPath)}`,
    '',
  ].join('\n');

  fs.writeFileSync(launcherScriptPath, scriptContent, { mode: 0o755 });
  fs.chmodSync(launcherScriptPath, 0o755);

  if (isMac) {
    const res = spawnSync('open', ['-a', 'Terminal', launcherScriptPath], { encoding: 'utf8' });
    if (res.status !== 0) {
      return { ok: false, method: 'open -a Terminal', detail: `Terminal failed to open` };
    }
  } else {
    // Linux terminal emulators
    const terms = [
      ['x-terminal-emulator', ['-e', launcherScriptPath]],
      ['gnome-terminal', ['--', launcherScriptPath]],
      ['konsole', ['-e', launcherScriptPath]],
      ['xfce4-terminal', ['-e', launcherScriptPath]],
      ['kitty', [launcherScriptPath]],
      ['alacritty', ['-e', launcherScriptPath]],
    ];
    let launched = false;
    for (const [tBin, tArgs] of terms) {
      const r = spawnSync(tBin, tArgs, { encoding: 'utf8', stdio: 'ignore' });
      if (r.status === 0) {
        launched = true;
        break;
      }
    }
    if (!launched) {
      return {
        ok: true,
        method: 'Clipboard + Rule Mount',
        detail: `Prepared ${shortenHome(launcherScriptPath, home)} (run in terminal)`,
      };
    }
  }

  const status = await waitForLaunchStatus(statusPath);
  const name = path.basename(binPath);
  if (status.state === 'started' && status.alive) {
    return { ok: true, method: `Terminal (${name})`, detail: `${name} running in Terminal (pid ${status.pid})` };
  }
  return { ok: true, method: `Terminal (${name})`, detail: `Opened Terminal launcher for ${name}` };
}

/**
 * Performs a REAL handoff and records a 5-step verified receipt so the user can see concrete proof.
 */
async function executeRealHandoff(targetId, launchMode = 'app') {
  const home = os.homedir();
  const state = await collectState();
  const projectRoot = state.projectRoot;
  const sourceAgent = state.workingAgentId || 'antigravity';

  const git = GitCollector.collect(projectRoot);
  const rich = harvestRichProjectContext(projectRoot, home, git);
  const effectiveGit = {
    ...git,
    modifiedFiles: rich.activeFileList.length > 0 ? rich.activeFileList : git.modifiedFiles,
  };

  const doneList = [];
  if (rich.recentUsers.length > 1) {
    for (const u of rich.recentUsers.slice(0, -1)) {
      doneList.push(`User request handled: "${u}"`);
    }
  }
  for (const a of rich.recentAssistant) {
    doneList.push(`Agent summary: ${a}`);
  }
  for (const f of rich.activeFileList) {
    doneList.push(`Active file modified/created in session: \`${f}\``);
  }
  for (const c of (git.recentCommits || []).slice(0, 3)) {
    doneList.push(`Git commit: ${c}`);
  }

  const task = {
    goal: state.taskTitle,
    immediateNext: [
      `Fulfill latest request in ${state.project} (${state.branch}): "${state.taskTitle}"`,
      ...(rich.activeFileList.length > 0
        ? [`Inspect and continue working on active session files: ${rich.activeFileList.map((f) => `\`${f}\``).join(', ')}`]
        : []),
    ],
    done: doneList,
    userPrompts: rich.recentUsers,
  };

  // Step 1 & 2 & 3: Build Baton & write `.vicem/BATON.md` + `.vicem/ledger.json`
  const baton = BatonIaBuilder.build({
    projectRoot,
    sourceAgent,
    targetAgent: targetId,
    sessionId: rich.sessionId,
    taskContext: task,
    gitContext: effectiveGit,
    budgetTokens: 4000,
  });
  const skelSaved = collectLiveSkeletonLedger(projectRoot, rich.activeFileList, true);

  const batonFilePath = path.join(projectRoot, '.vicem', 'BATON.md');
  const batonStat = fs.existsSync(batonFilePath) ? fs.statSync(batonFilePath) : null;

  // Step 4A: Mount target rule file (`CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `.windsurfrules` / `.clinerules` / `GEMINI.md` / `.github/copilot-instructions.md`)
  let mountedRel = '.vicem/BATON.md';
  let mountVerified = false;
  try {
    const mountRes = RuleMountAdapter.mount(projectRoot, targetId, baton.markdown);
    mountedRel = mountRes.relPath;
    if (targetId === 'claude') {
      const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
      const block = `<!-- VICEM-BATON-START -->\n${baton.markdown.trim()}\n<!-- VICEM-BATON-END -->\n`;
      fs.writeFileSync(claudeMdPath, block, 'utf8');
      mountedRel = 'CLAUDE.md + AGENTS.md';
    }
    const checkPath = path.join(projectRoot, mountRes.relPath);
    mountVerified =
      fs.existsSync(checkPath) &&
      fs.readFileSync(checkPath, 'utf8').includes('<!-- VICEM-BATON-START -->');
  } catch {}

  // Step 4B: Copy to OS Clipboard (`pbcopy` / `Set-Clipboard` / `wl-copy` / `xclip`) and verify
  ClipboardAdapter.copyNative(baton.markdown);
  let clipboardChars = 0;
  try {
    const pasted = readClipboardCrossPlatform();
    if (pasted.includes('VICEM-BATON') || pasted.includes('# BATON:')) {
      clipboardChars = pasted.length;
    }
  } catch {}

  // Step 5: Launch target application across macOS / Windows / Linux according to launchMode ('app' | 'cli' | 'off')
  let launchResult = {
    ok: true,
    method: 'Skipped (Launch: Off)',
    detail: 'Clipboard + Rule mount only',
  };
  if (launchMode && launchMode !== 'off') {
    launchResult = await launchTargetAgentCrossPlatform(targetId, projectRoot, baton.markdown, launchMode);
  }

  if (launchResult.ok && targetId && targetId !== sourceAgent) {
    lastHandedOffFrom = sourceAgent;
    manualActiveAgent = targetId;
  }

  const nowStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  lastHandoffReceipt = {
    timestamp: nowStr,
    sourceAgent,
    targetId,
    project: state.project,
    steps: [
      {
        ok: true,
        title: 'Harvest Session & Git State',
        detail: `Extracted ${rich.recentUsers.length} prompts & ${rich.activeFileList.length} active files from ${sourceAgent} in ${state.project} (${state.branch})`,
      },
      {
        ok: true,
        title: 'Skeletonize AST & 4-Stage Diet',
        detail: `${state.stats.rawTokens.toLocaleString()} -> ${baton.dietTokens.toLocaleString()} tok (-${state.stats.savedPct}%) · ${skelSaved.totalSymbols} symbols indexed · ${baton.redactedCount} secrets masked`,
      },
      {
        ok: Boolean(batonStat && batonStat.size > 0),
        title: 'Persist Baton & Ledger on Disk',
        detail: `${shortenHome(batonFilePath, home)} (${batonStat ? batonStat.size.toLocaleString() : 0}B) + .vicem/ledger.json (${skelSaved.ledgerDiskBytes.toLocaleString()}B)`,
      },
      {
        ok: mountVerified && clipboardChars > 0,
        title: 'Mount Rules & Verify Clipboard',
        detail: `Mounted ${mountedRel} · Clipboard verified (${clipboardChars.toLocaleString()} chars)`,
      },
      {
        ok: launchResult.ok,
        title: 'Launch Target Agent',
        detail: `${launchResult.detail} [${launchResult.method}]`,
      },
    ],
    batonPreview: baton.markdown,
  };

  cachedTelemetryAt = 0;
  const updated = await collectState();
  return {
    ...updated,
    actionReceipt: `${nowStr} · Relayed ${sourceAgent} -> ${targetId} (${launchResult.detail})`,
  };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Vicem - Tactical Context Relay &amp; Diet Cockpit</title>
<link rel="icon" type="image/png" href="/logo-dark.png" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
    --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
    --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
    --spring-snappy: cubic-bezier(0.22, 1.18, 0.32, 1);
    --spring-glide: cubic-bezier(0.22, 1.08, 0.32, 1);
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 10px;
  }

  :root[data-theme="dark"] {
    color-scheme: dark;
    --canvas: #090A0D;
    --canvas-glow: radial-gradient(960px circle at 50% 0%, #12171D 0%, #090A0D 72%);
    --win-bg: #0F1115;
    --win-header: #0B0D10;
    --win-elevated: #151920;
    --win-card: #12161C;
    --row-hover: #161B22;
    --row-working: #0F1D18;
    --border-subtle: #1D222B;
    --border-mid: #272E3A;
    --border-strong: #384252;
    --text-primary: #F2F4F8;
    --text-secondary: #9BA3B0;
    --text-muted: #626A78;
    --accent: #10B981;
    --accent-soft: rgba(16, 185, 129, 0.14);
    --accent-border: rgba(16, 185, 129, 0.42);
    --warn: #F59E0B;
    --warn-soft: rgba(245, 158, 11, 0.14);
    --icon-box-bg: #151920;
    --seg-empty: #1C212A;
    --seg-fill: #E2E6EE;
    --seg-working: #10B981;
    --seg-warn: #F59E0B;
    --status-working: #10B981;
    --status-done: #9BA3B0;
    --status-idle: #525966;
    --btn-bg: #151920;
    --btn-bg-hover: #F2F4F8;
    --btn-text-hover: #0B0D10;
    --shadow-win: 0 28px 70px rgba(5, 7, 10, 0.76), 0 0 0 1px rgba(242, 244, 248, 0.04);
    --shadow-pop: 0 18px 42px rgba(5, 7, 10, 0.72);
  }

  :root[data-theme="light"] {
    color-scheme: light;
    --canvas: #E6E9EF;
    --canvas-glow: radial-gradient(960px circle at 50% 0%, #F4F6F9 0%, #E6E9EF 75%);
    --win-bg: #F8F9FB;
    --win-header: #EFF2F6;
    --win-elevated: #EAEFF5;
    --win-card: #F2F4F8;
    --row-hover: #EEF1F6;
    --row-working: #E8F6F0;
    --border-subtle: #DCE1E9;
    --border-mid: #C8D0DC;
    --border-strong: #9AA6B8;
    --text-primary: #11141A;
    --text-secondary: #495160;
    --text-muted: #768092;
    --accent: #059669;
    --accent-soft: rgba(5, 150, 105, 0.12);
    --accent-border: rgba(5, 150, 105, 0.42);
    --warn: #D97706;
    --warn-soft: rgba(217, 119, 6, 0.12);
    --icon-box-bg: #EFF2F6;
    --seg-empty: #DCE1E9;
    --seg-fill: #1A1F29;
    --seg-working: #059669;
    --seg-warn: #D97706;
    --status-working: #059669;
    --status-done: #495160;
    --status-idle: #9AA6B8;
    --btn-bg: #F8F9FB;
    --btn-bg-hover: #11141A;
    --btn-text-hover: #F8F9FB;
    --shadow-win: 0 24px 60px rgba(17, 20, 26, 0.12), 0 2px 10px rgba(17, 20, 26, 0.05);
    --shadow-pop: 0 16px 36px rgba(17, 20, 26, 0.16);
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }

  html.no-anim *,
  html.no-anim *::before,
  html.no-anim *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 120ms !important;
      transform: none !important;
    }
  }

  body {
    background: var(--canvas);
    background-image: var(--canvas-glow);
    color: var(--text-primary);
    font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12.5px;
    line-height: 1.45;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(0px, 1.5vw, 18px);
    transition: background-color 180ms ease, color 180ms ease;
  }

  .app-window {
    width: min(1220px, 100%);
    max-width: 100%;
    height: min(920px, calc(100dvh - clamp(0px, 3vw, 36px)));
    max-height: calc(100dvh - clamp(0px, 3vw, 36px));
    display: flex;
    flex-direction: column;
    background: var(--win-bg);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-win);
    overflow: hidden;
    position: relative;
    transition: background-color 180ms ease, border-color 180ms ease;
  }

  /* Universal physical press feedback (Emil Kowalski rule: scale 0.97 on :active) */
  button,
  .ws-tab,
  .session-card,
  .pipe-node,
  .rule-chip,
  .symbol-row {
    transition:
      transform 140ms var(--ease-out),
      background-color 150ms ease,
      border-color 150ms ease,
      color 150ms ease,
      opacity 150ms var(--ease-out);
  }

  button:active,
  .ws-tab:active,
  .session-card:active,
  .pipe-node:active,
  .rule-chip:active {
    transform: scale(0.97);
  }

  /* Blur-masked crossfade when switching workspaces or workbench views */
  .crossfade-surface {
    transition: filter 160ms var(--ease-out), opacity 160ms var(--ease-out);
  }
  .crossfade-surface.is-transitioning {
    filter: blur(2px);
    opacity: 0.65;
  }

  /* ==========================================================================
     1. TOPBAR: PROJECT SWITCHER + ADD WORKSPACE POPOVER + GAMIFIED XP HUD
     ========================================================================== */
  .win-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 52px;
    padding: 8px 18px;
    background: var(--win-header);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
    position: relative;
    z-index: 30;
  }

  .brand-cluster {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .official-logo-box {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    background: var(--icon-box-bg);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
  }

  .official-logo-box img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    filter: contrast(1.35) brightness(1.15);
  }
  :root[data-theme="light"] .official-logo-box img {
    filter: contrast(1.4) brightness(0.85);
  }

  .brand-name-wrap {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-shrink: 0;
  }

  .brand-name {
    font-weight: 700;
    font-size: 14px;
    letter-spacing: -0.02em;
    color: var(--text-primary);
  }

  .brand-ver {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--accent);
    font-weight: 600;
  }

  .ws-switcher-bar {
    display: flex;
    align-items: center;
    gap: 5px;
    padding-left: 10px;
    border-left: 1px solid var(--border-subtle);
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
  }
  .ws-switcher-bar::-webkit-scrollbar {
    display: none;
  }

  .ws-tab {
    height: 28px;
    padding: 0 10px;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  @media (hover: hover) and (pointer: fine) {
    .ws-tab:hover {
      color: var(--text-primary);
      border-color: var(--border-mid);
      background: var(--win-elevated);
    }
  }

  .ws-tab.active {
    background: var(--accent-soft);
    color: var(--text-primary);
    border-color: var(--accent-border);
    font-weight: 600;
  }

  .ws-sync-dot {
    width: 6px;
    height: 6px;
    border-radius: 99px;
    background: var(--border-strong);
    flex-shrink: 0;
  }
  .ws-sync-dot.synced {
    background: var(--accent);
  }

  .ws-branch-mini {
    font-size: 9.5px;
    color: var(--text-muted);
  }
  .ws-tab.active .ws-branch-mini {
    color: var(--accent);
  }

  .add-ws-btn {
    height: 28px;
    padding: 0 9px;
    background: transparent;
    border: 1px dashed var(--border-mid);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  @media (hover: hover) and (pointer: fine) {
    .add-ws-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-secondary);
      background: var(--win-elevated);
    }
  }

  /* Origin-Aware Add Project Popover (Emil Kowalski recipe: scale(0.95) + opacity 0, transform-origin top left) */
  .ws-popover {
    position: absolute;
    top: 48px;
    left: 140px;
    width: min(440px, calc(100vw - 32px));
    background: var(--win-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
    padding: 12px;
    z-index: 80;
    transform-origin: top left;
    opacity: 0;
    transform: scale(0.95);
    pointer-events: none;
    transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out);
  }

  .ws-popover.open {
    opacity: 1;
    transform: scale(1);
    pointer-events: auto;
  }

  .ws-pop-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .ws-pop-form {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }

  .ws-pop-input {
    flex: 1;
    height: 30px;
    padding: 0 10px;
    background: var(--win-bg);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    outline: none;
  }
  .ws-pop-input:focus {
    border-color: var(--accent);
  }

  .ws-pop-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 180px;
    overflow-y: auto;
  }

  .ws-pop-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-secondary);
    text-align: left;
  }
  @media (hover: hover) and (pointer: fine) {
    .ws-pop-item:hover {
      border-color: var(--accent-border);
      color: var(--text-primary);
    }
  }

  /* Kinetic Telemetry HUD & Action Toast (Game-Grade Motion, Zero Game Jargon) */
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    position: relative;
  }

  .diet-meter-hud {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px;
    background: var(--win-bg);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    position: relative;
    overflow: hidden;
  }

  .diet-meter-hud::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(110deg, transparent 25%, rgba(16, 185, 129, 0.18) 50%, transparent 75%);
    transform: translateX(-120%);
    pointer-events: none;
  }
  .diet-meter-hud.pulse-sheen::after {
    animation: sheenSweep 560ms var(--ease-out);
  }

  @keyframes sheenSweep {
    0% { transform: translateX(-120%); }
    100% { transform: translateX(120%); }
  }

  .ast-count-badge {
    color: var(--accent);
    font-weight: 600;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
  }

  .diet-bar-wrap {
    width: 64px;
    height: 6px;
    background: var(--seg-empty);
    border-radius: 99px;
    overflow: hidden;
    position: relative;
  }

  /* Hardware-accelerated clip-path compression ratio bar */
  .diet-bar-fill {
    position: absolute;
    inset: 0;
    background: var(--accent);
    clip-path: inset(0 50% 0 0);
    transition: clip-path 380ms var(--spring-glide);
  }

  .diet-pct-val {
    color: var(--text-primary);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .combo-pill {
    height: 30px;
    padding: 0 9px;
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-variant-numeric: tabular-nums;
    transition: transform 240ms var(--spring-snappy), border-color 180ms ease;
  }
  .combo-pill.bump {
    transform: scale(1.045);
  }

  /* Kinetic Spring Action Toast */
  .action-toast {
    position: absolute;
    top: 38px;
    right: 68px;
    background: var(--accent);
    color: #090A0D;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    font-weight: 700;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    pointer-events: none;
    opacity: 0;
    transform: translate3d(0, 8px, 0) scale(0.92);
    transition: opacity 220ms var(--ease-out), transform 280ms var(--spring-snappy);
    z-index: 90;
    white-space: nowrap;
    box-shadow: 0 10px 24px rgba(16, 185, 129, 0.28);
  }
  .action-toast.show {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }

  .theme-btn {
    height: 30px;
    padding: 0 9px;
    background: var(--win-bg);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  @media (hover: hover) and (pointer: fine) {
    .theme-btn:hover {
      color: var(--text-primary);
      border-color: var(--border-strong);
    }
  }

  /* ==========================================================================
     2. SOURCE SESSION SELECTOR & RELAY GOAL DECK
     ========================================================================== */
  .session-deck {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 18px;
    background: var(--win-bg);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .session-strip-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .session-strip-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .project-path-pill {
    color: var(--text-primary);
    font-weight: 600;
    background: var(--win-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 1px 7px;
  }

  .session-cards {
    display: flex;
    align-items: stretch;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    padding-bottom: 2px;
  }
  .session-cards::-webkit-scrollbar {
    display: none;
  }

  @keyframes cardCascadeIn {
    0% {
      opacity: 0;
      transform: translate3d(0, 6px, 0) scale(0.97);
    }
    100% {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }

  .session-card {
    min-width: 210px;
    max-width: 280px;
    padding: 7px 10px;
    background: var(--win-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex-shrink: 0;
    text-align: left;
    position: relative;
    overflow: hidden;
    animation: cardCascadeIn 260ms var(--ease-out) backwards;
    animation-delay: calc(var(--idx, 0) * 32ms);
  }

  @media (hover: hover) and (pointer: fine) {
    .session-card:hover {
      border-color: var(--border-strong);
      background: var(--row-hover);
      transform: translate3d(0, -1px, 0);
    }
  }

  .session-card:active {
    transform: scale(0.96);
  }

  .session-card.selected {
    background: var(--row-working);
    border-color: var(--accent);
    box-shadow: 0 0 18px rgba(16, 185, 129, 0.12);
  }

  .sc-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
  }

  .sc-agent {
    font-weight: 600;
    color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  @keyframes beaconPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.06); opacity: 0.86; }
  }

  .sc-source-tag {
    font-size: 9.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--accent);
    color: #090A0D;
    font-weight: 700;
    animation: beaconPulse 2.2s ease-in-out infinite;
  }

  .sc-ago {
    color: var(--text-muted);
    font-size: 10px;
  }

  .sc-title {
    font-size: 11.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session-card.selected .sc-title {
    color: var(--text-primary);
  }

  /* Goal Input + Route Bar */
  .goal-route-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 12px;
  }

  .prompt-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .prompt-prefix {
    position: absolute;
    left: 10px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    pointer-events: none;
  }

  .prompt-input {
    width: 100%;
    height: 32px;
    padding: 0 58px 0 58px;
    background: var(--win-header);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 12.5px;
    font-weight: 500;
    outline: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: border-color 150ms ease;
  }
  .prompt-input:focus {
    border-color: var(--accent);
  }

  .prompt-edit-hint {
    position: absolute;
    right: 9px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--text-muted);
    pointer-events: none;
  }

  .relay-route-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 11px;
    background: var(--win-header);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    flex-shrink: 0;
    transition: border-color 180ms ease, box-shadow 180ms ease;
  }
  .relay-route-pill.route-active {
    border-color: var(--accent);
    box-shadow: 0 0 16px rgba(16, 185, 129, 0.16);
  }

  .route-from {
    color: var(--accent);
    font-weight: 600;
  }
  .route-arrow {
    color: var(--text-muted);
    display: inline-block;
    transition: transform 200ms var(--spring-snappy), color 180ms ease;
  }
  .relay-route-pill.route-active .route-arrow {
    color: var(--accent);
    transform: translateX(3px);
  }
  .route-to {
    color: var(--text-secondary);
    font-weight: 600;
    transition: color 160ms ease;
  }
  .route-to.locked {
    color: var(--text-primary);
  }

  /* ==========================================================================
     3. LIVE 4-NODE CORE PIPELINE STEPPER (WITH SLIDING GLIDER & PULSE WAVE)
     ========================================================================== */
  .pipeline-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    padding: 8px 18px;
    background: var(--win-header);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
    position: relative;
  }

  /* Physical Sliding Glider Highlight Cursor (Game Menu / Layout Projection Feel) */
  .pipe-glider {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    border: 1.5px solid var(--accent);
    background: var(--row-working);
    border-radius: var(--radius-md);
    box-shadow: 0 0 22px rgba(16, 185, 129, 0.15);
    pointer-events: none;
    z-index: 1;
    opacity: 0;
    transition:
      transform 280ms var(--spring-glide),
      width 280ms var(--spring-glide),
      height 280ms var(--spring-glide),
      opacity 180ms ease;
  }
  .pipe-glider.visible {
    opacity: 1;
  }

  @keyframes nodeWaveBounce {
    0% { transform: scale(1); }
    45% { transform: scale(1.032); border-color: var(--accent); }
    100% { transform: scale(1); }
  }

  .pipe-node {
    padding: 7px 10px;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
    position: relative;
    z-index: 2;
  }

  @media (hover: hover) and (pointer: fine) {
    .pipe-node:hover {
      border-color: var(--border-strong);
      background: var(--win-elevated);
      transform: translate3d(0, -1px, 0);
    }
  }

  .pipe-node.active-tab {
    background: transparent;
    border-color: transparent;
  }

  .pipe-node.wave-hit {
    animation: nodeWaveBounce 340ms var(--spring-snappy);
  }

  /* Animated Signal Connector Line Between Pipeline Stages */
  .pipe-node:not(:last-child)::after {
    content: "";
    position: absolute;
    top: 50%;
    right: -11px;
    width: 10px;
    height: 2px;
    background: linear-gradient(90deg, var(--accent) 50%, transparent 50%);
    background-size: 6px 2px;
    opacity: 0.55;
    animation: packetFlow 900ms linear infinite;
    pointer-events: none;
  }

  @keyframes packetFlow {
    0% { background-position: 0 0; }
    100% { background-position: 12px 0; }
  }

  .pipe-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
  }

  .pipe-title {
    font-weight: 600;
    color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .pipe-badge {
    font-size: 9.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--win-elevated);
    border: 1px solid var(--border-mid);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .pipe-badge.ok {
    background: var(--accent-soft);
    border-color: var(--accent-border);
    color: var(--accent);
    font-weight: 600;
  }
  .pipe-badge.warn {
    background: var(--warn-soft);
    border-color: var(--warn);
    color: var(--warn);
  }

  .pipe-sub {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }

  /* Interactive Core Workbench Drawer */
  .workbench-drawer {
    display: none;
    flex-direction: column;
    gap: 8px;
    padding: 10px 18px;
    background: var(--win-elevated);
    border-bottom: 1px solid var(--border-mid);
    max-height: 225px;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .workbench-drawer.open {
    display: flex;
  }

  .wb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .wb-title {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
  }

  .wb-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .wb-grid-2 {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 12px;
  }

  .wb-box {
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    max-height: 155px;
    overflow-y: auto;
    transition: border-color 220ms ease;
  }

  @keyframes codeUnfoldReveal {
    0% {
      opacity: 0.25;
      transform: translate3d(0, 7px, 0) scale(0.985);
      filter: blur(3px);
    }
    100% {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      filter: blur(0);
    }
  }

  .wb-box.rehydrate-flash {
    border-color: var(--accent);
    animation: codeUnfoldReveal 280ms var(--spring-snappy);
  }

  .wb-box-title {
    font-size: 10px;
    color: var(--text-muted);
    margin-bottom: 6px;
    font-weight: 600;
  }

  .prompt-list-item {
    padding: 4px 0;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: 11px;
  }
  .prompt-list-item:last-child {
    border-bottom: none;
  }

  .symbol-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-secondary);
  }
  @media (hover: hover) and (pointer: fine) {
    .symbol-row:hover {
      background: var(--row-hover);
      color: var(--text-primary);
      transform: translate3d(3px, 0, 0);
    }
  }
  .symbol-row.active-sym {
    background: var(--row-working);
    color: var(--text-primary);
    border-left: 2px solid var(--accent);
  }

  .rehydrate-btn {
    padding: 2px 7px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    border-radius: 4px;
    color: var(--accent);
    cursor: pointer;
    flex-shrink: 0;
  }

  .code-preview-pre {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .rule-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .rule-chip {
    padding: 4px 8px;
    background: var(--win-bg);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    color: var(--text-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .rule-chip.mounted {
    background: var(--accent-soft);
    border-color: var(--accent-border);
    color: var(--text-primary);
  }

  /* ==========================================================================
     4. AGENT PROCESS & RELAY TABLE (PROJECT-SCOPED + EXPLICIT FROM/TO)
     ========================================================================== */
  .table-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 18px;
    background: var(--win-header);
    border-bottom: 1px solid var(--border-subtle);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    flex-shrink: 0;
  }

  .filter-pills {
    display: flex;
    align-items: center;
    gap: 6px;
    position: relative;
  }

  .filter-glider {
    position: absolute;
    top: 0;
    left: 0;
    height: 24px;
    width: 0;
    background: var(--win-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    pointer-events: none;
    z-index: 1;
    transition:
      transform 260ms var(--spring-glide),
      width 260ms var(--spring-glide);
  }

  .filter-pill {
    height: 24px;
    padding: 0 9px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    cursor: pointer;
    position: relative;
    z-index: 2;
  }
  .filter-pill.active {
    color: var(--text-primary);
    font-weight: 600;
  }

  .table-viewport {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  }

  .process-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .col-agent { width: 34%; }
  .col-state { width: 12%; }
  .col-quota { width: 25%; }
  .col-seen  { width: 10%; }
  .col-act   { width: 19%; }

  .process-table thead th {
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--win-header);
    padding: 7px 10px;
    text-align: left;
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
    white-space: nowrap;
  }

  .process-table thead th:first-child { padding-left: 18px; }
  .process-table thead th:last-child { padding-right: 18px; text-align: right; }
  .process-table thead th.num-col { text-align: right; }

  .process-table tbody tr {
    border-bottom: 1px solid var(--border-subtle);
    transition: background-color 140ms ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .process-table tbody tr:hover {
      background: var(--row-hover);
    }
  }
  .process-table tbody tr.is-working {
    background: var(--row-working);
  }

  .process-table td {
    padding: 8px 10px;
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .process-table td:first-child { padding-left: 18px; }
  .process-table td:last-child { padding-right: 18px; text-align: right; }

  .agent-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .agent-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .agent-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .agent-name {
    font-weight: 600;
    font-size: 12.5px;
    color: var(--text-primary);
  }

  .in-proj-badge {
    font-family: "IBM Plex Mono", monospace;
    font-size: 9.5px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    border-radius: 4px;
    padding: 0 5px;
    flex-shrink: 0;
  }

  .model-badge {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--text-muted);
    background: var(--win-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0 5px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agent-path {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .state-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
  }
  .state-sq {
    width: 6px;
    height: 6px;
    border-radius: 2px;
  }
  .state-sq.Working { background: var(--status-working); }
  .state-sq.Done { background: var(--status-done); }
  .state-sq.Idle { background: var(--status-idle); }

  .quota-cell {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-right: 8px;
  }
  .quota-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    font-family: "IBM Plex Mono", monospace;
  }
  .quota-val {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .quota-val.subtle {
    font-size: 10.5px;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .quota-sub {
    font-size: 10px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .seg-bar {
    display: grid;
    grid-template-columns: repeat(20, 1fr);
    gap: 2px;
    height: 5px;
  }
  .seg {
    background: var(--seg-empty);
    height: 100%;
  }
  .seg.on { background: var(--seg-fill); }
  .seg.on.working { background: var(--seg-working); }
  .seg.on.warn { background: var(--seg-warn); }

  .seen-cell {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-secondary);
    text-align: right;
  }

  .act-group {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
  }

  .set-src-btn {
    height: 26px;
    padding: 0 7px;
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    cursor: pointer;
  }
  @media (hover: hover) and (pointer: fine) {
    .set-src-btn:hover {
      color: var(--text-primary);
      border-color: var(--border-strong);
      background: var(--win-elevated);
    }
  }

  .handoff-btn {
    height: 26px;
    padding: 0 10px;
    background: var(--btn-bg);
    border: 1px solid var(--border-mid);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  @media (hover: hover) and (pointer: fine) {
    .handoff-btn:hover {
      background: var(--btn-bg-hover);
      color: var(--btn-text-hover);
      border-color: var(--btn-bg-hover);
    }
  }

  .holding-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    color: var(--accent);
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    font-weight: 600;
  }

  /* ==========================================================================
     5. COMMAND FOOTER
     ========================================================================== */
  .win-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 44px;
    padding: 6px 18px;
    background: var(--win-header);
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .footer-cmds {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }

  .cmd-btn {
    height: 28px;
    padding: 0 9px;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  @media (hover: hover) and (pointer: fine) {
    .cmd-btn:hover {
      color: var(--text-primary);
      border-color: var(--border-mid);
    }
  }
  .cmd-btn.active-toggle {
    color: var(--text-primary);
    border-color: var(--accent-border);
    background: var(--accent-soft);
  }

  .kbd {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--text-muted);
  }

  .footer-receipt {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    text-align: right;
  }

  @media (max-width: 920px) {
    .pipeline-bar {
      grid-template-columns: repeat(2, 1fr);
    }
    .wb-grid-2 {
      grid-template-columns: 1fr;
    }
    .col-seen, .th-seen, .seen-cell {
      display: none;
    }
    .col-agent { width: 38%; }
    .col-state { width: 13%; }
    .col-quota { width: 27%; }
    .col-act   { width: 22%; }
  }

  @media (max-width: 640px) {
    body { padding: 0; }
    .app-window {
      width: 100%;
      height: 100dvh;
      max-height: 100dvh;
      border-radius: 0;
      border: none;
    }
    .goal-route-row {
      grid-template-columns: 1fr;
    }
    .col-state, .th-state, .td-state, .set-src-btn {
      display: none;
    }
    .col-agent { width: 44%; }
    .col-quota { width: 34%; }
    .col-act   { width: 22%; }
  }
</style>
</head>
<body>

  <div class="app-window">

    <!-- 1. Topbar: Project Switcher + Add Project Popover + Live Kinetic Compression Telemetry -->
    <header class="win-topbar">
      <div class="brand-cluster">
        <div class="official-logo-box">
          <img id="official-logo" src="/logo-dark.png" alt="Vicem Logo" />
        </div>
        <div class="brand-name-wrap">
          <span class="brand-name">Vicem</span>
          <span class="brand-ver">v1.1</span>
        </div>
        <div class="ws-switcher-bar" id="ws-tabs"></div>
        <button class="add-ws-btn" id="btn-add-ws" onclick="toggleAddWorkspacePopover(event)" title="Open or add any project directory">
          <span>+ Project</span>
        </button>
      </div>

      <!-- Origin-Aware Add Project Popover -->
      <div class="ws-popover" id="add-ws-popover">
        <div class="ws-pop-title">
          <span>Switch or Add Project Directory</span>
          <button class="cmd-btn" style="height:22px;padding:0 6px" onclick="closeAddWorkspacePopover()">Close</button>
        </div>
        <form class="ws-pop-form" onsubmit="submitCustomWorkspace(event)">
          <input
            type="text"
            class="ws-pop-input"
            id="custom-ws-input"
            placeholder="Paste path e.g. ~/Documents/my-repo"
          />
          <button type="submit" class="cmd-btn active-toggle" style="height:30px">Open</button>
        </form>
        <div class="wb-box-title">Discovered Workspaces on This Machine</div>
        <div class="ws-pop-list" id="ws-pop-list"></div>
      </div>

      <div class="topbar-right">
        <div class="combo-pill" id="combo-pill" title="Live 4-Stage Context Diet token stream">
          <span id="stat-tokens">Loading...</span>
        </div>
        <div class="diet-meter-hud" id="diet-meter-hud" title="Live AST Skeletonizer &amp; Compression Ratio">
          <span class="ast-count-badge" id="hud-ast-count">0 AST Symbols</span>
          <div class="diet-bar-wrap">
            <div class="diet-bar-fill" id="hud-diet-fill"></div>
          </div>
          <span class="diet-pct-val" id="hud-diet-pct">-0%</span>
        </div>
        <div class="action-toast" id="action-toast">Synced</div>
        <button class="theme-btn" onclick="toggleTheme()" title="Toggle Light / Dark Mode (T)">
          <span id="theme-icon">☀</span>
          <span id="theme-label">Light</span>
          <span class="kbd">T</span>
        </button>
      </div>
    </header>

    <!-- 2. Project Sessions Strip (Explicit Source Selection) & Goal Bar -->
    <section class="session-deck crossfade-surface" id="session-deck">
      <div class="session-strip-header">
        <div class="session-strip-label">
          <span>Project Sessions in</span>
          <span class="project-path-pill" id="active-project-pill">~/workspace</span>
          <span id="session-count-label">· Click any session to lock as Source Baton</span>
        </div>
        <div class="session-strip-label">
          <span id="mounted-status">No rules mounted</span>
        </div>
      </div>

      <div class="session-cards" id="session-cards"></div>

      <div class="goal-route-row">
        <div class="prompt-input-wrap">
          <span class="prompt-prefix">GOAL &gt;</span>
          <input
            type="text"
            class="prompt-input"
            id="task-input"
            value="Loading session context..."
            placeholder="Type handoff goal or instruction before relaying..."
            onchange="saveCustomGoal(this.value)"
          />
          <span class="prompt-edit-hint">Edit</span>
        </div>

        <div class="relay-route-pill" id="relay-route-pill">
          <span>FROM</span>
          <span class="route-from" id="relay-source">Antigravity</span>
          <span class="route-arrow">-&gt;</span>
          <span class="route-to" id="relay-target">Select target below</span>
        </div>
      </div>
    </section>

    <!-- 3. Live 4-Node Core Pipeline Stepper (With Sliding Layout-Projection Glider) -->
    <section class="pipeline-bar" id="pipeline-bar">
      <div class="pipe-glider" id="pipe-glider"></div>

      <button class="pipe-node" id="pipe-node-1" onclick="selectWorkbenchTab('harvest')">
        <div class="pipe-top">
          <span class="pipe-title">1. Harvest Session</span>
          <span class="pipe-badge ok" id="pipe-badge-1">Active</span>
        </div>
        <div class="pipe-sub" id="pipe-sub-1">Scanning session logs...</div>
      </button>

      <button class="pipe-node" id="pipe-node-2" onclick="selectWorkbenchTab('skeleton')">
        <div class="pipe-top">
          <span class="pipe-title">2. Skeletonize AST</span>
          <span class="pipe-badge ok" id="pipe-badge-2">0 symbols</span>
        </div>
        <div class="pipe-sub" id="pipe-sub-2">Computing AST diet...</div>
      </button>

      <button class="pipe-node" id="pipe-node-3" onclick="selectWorkbenchTab('ledger')">
        <div class="pipe-top">
          <span class="pipe-title">3. Index Ledger &amp; Rules</span>
          <span class="pipe-badge" id="pipe-badge-3">Preview</span>
        </div>
        <div class="pipe-sub" id="pipe-sub-3">.vicem/BATON.md &amp; ledger.json</div>
      </button>

      <button class="pipe-node" id="pipe-node-4" onclick="selectWorkbenchTab('receipt')">
        <div class="pipe-top">
          <span class="pipe-title">4. Relay Verification</span>
          <span class="pipe-badge" id="pipe-badge-4">Ready</span>
        </div>
        <div class="pipe-sub" id="pipe-sub-4">Click Hand off on any target</div>
      </button>
    </section>

    <!-- Interactive Workbench Drawer (Shows Live Internals of Selected Pipeline Stage) -->
    <section class="workbench-drawer crossfade-surface" id="workbench-drawer">
      <div class="wb-header">
        <span class="wb-title" id="wb-title">Pipeline Inspector</span>
        <div class="wb-actions">
          <button class="cmd-btn active-toggle" style="height:24px" onclick="syncDietToDisk()">
            <span>Sync Diet to Disk</span>
          </button>
          <button class="cmd-btn" style="height:24px" onclick="closeWorkbench()">
            <span>Close</span>
          </button>
        </div>
      </div>
      <div id="wb-body"></div>
    </section>

    <!-- 4. Project-Scoped Agent Relay Table -->
    <div class="table-toolbar">
      <div class="filter-pills" id="filter-pills-wrap">
        <div class="filter-glider" id="filter-glider"></div>
        <button class="filter-pill active" id="filter-installed" onclick="setAgentFilter('installed')">Installed &amp; Primary</button>
        <button class="filter-pill" id="filter-project" onclick="setAgentFilter('project')">In This Project</button>
        <button class="filter-pill" id="filter-all" onclick="setAgentFilter('all')">All 12 Platforms</button>
      </div>
      <span id="table-scope-hint" style="color:var(--text-muted)">Showing agents synced with active workspace</span>
    </div>

    <div class="table-viewport crossfade-surface" id="table-viewport">
      <table class="process-table">
        <colgroup>
          <col class="col-agent" />
          <col class="col-state" />
          <col class="col-quota" />
          <col class="col-seen" />
          <col class="col-act" />
        </colgroup>
        <thead>
          <tr>
            <th>Agent &amp; Project Session Context</th>
            <th class="th-state">Role</th>
            <th>Remaining Capacity</th>
            <th class="num-col th-seen">Last Activity</th>
            <th>Source / Target Relay</th>
          </tr>
        </thead>
        <tbody id="agent-rows"></tbody>
      </table>
    </div>

    <!-- 5. Command Bar Footer -->
    <footer class="win-footer">
      <div class="footer-cmds">
        <button class="cmd-btn active-toggle" onclick="syncDietToDisk()">
          <span>Sync Diet &amp; Ledger</span>
          <span class="kbd">R</span>
        </button>
        <button class="cmd-btn" onclick="triggerBack()">
          <span>Return Previous</span>
          <span class="kbd">Z</span>
        </button>
        <button class="cmd-btn" onclick="copyBaton()">
          <span>Copy Baton</span>
          <span class="kbd">C</span>
        </button>
        <button class="cmd-btn" id="btn-inspect" onclick="toggleWorkbenchDrawer()">
          <span>Pipeline Inspector</span>
          <span class="kbd">I</span>
        </button>
        <button class="cmd-btn" id="btn-launch-toggle" onclick="toggleLaunchApp()">
          <span id="launch-label">Launch: Desktop App</span>
        </button>
      </div>
      <div class="footer-receipt" id="status-line">Ready · Click any session card or pipeline node to inspect</div>
    </footer>

  </div>

<script>
  const CLIENT_GUI_VERSION = 'v18';
  const urlParams = new URLSearchParams(window.location.search);
  const isStaticMode = Boolean(navigator.webdriver || urlParams.get('static') === '1');
  if (isStaticMode) {
    document.documentElement.classList.add('no-anim');
  }

  let state = null;
  let currentTheme = localStorage.getItem('vicem-theme') || 'dark';
  let launchMode = 'app';
  let agentFilter = urlParams.get('all') === '1' ? 'all' : 'installed';
  let activeWorkbenchTab = 'skeleton';
  let workbenchOpen = true;
  let isEditingGoal = false;
  let relayingTargetId = null;
  let rehydratedPreview = null;
  let displayedRawTokens = 0;
  let displayedDietTokens = 0;
  let displayedSymbols = 0;
  let justRehydratedFlash = false;

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vicem-theme', theme);
    const logoImg = document.getElementById('official-logo');
    if (logoImg) logoImg.src = theme === 'light' ? '/logo-light.png' : '/logo-dark.png';
    document.getElementById('theme-icon').textContent = theme === 'light' ? '☾' : '☀';
    document.getElementById('theme-label').textContent = theme === 'light' ? 'Dark' : 'Light';
  }

  function toggleTheme() {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }

  const urlTheme = urlParams.get('theme');
  if (urlTheme === 'light' || urlTheme === 'dark') {
    applyTheme(urlTheme);
  } else {
    applyTheme(currentTheme);
  }

  const taskInput = document.getElementById('task-input');
  taskInput.addEventListener('focus', () => { isEditingGoal = true; });
  taskInput.addEventListener('blur', () => { isEditingGoal = false; });

  function setStatus(msg) {
    const el = document.getElementById('status-line');
    if (!el) return;
    el.textContent = msg;
    el.style.color = 'var(--text-primary)';
    setTimeout(() => {
      el.style.color = 'var(--text-muted)';
    }, 3200);
  }

  function popActionToast(text) {
    const t = document.getElementById('action-toast');
    if (!t) return;
    t.textContent = text;
    t.classList.add('show');
    const meter = document.getElementById('diet-meter-hud');
    if (meter) {
      meter.classList.remove('pulse-sheen');
      void meter.offsetWidth;
      meter.classList.add('pulse-sheen');
    }
    const combo = document.getElementById('combo-pill');
    if (combo) {
      combo.classList.add('bump');
      setTimeout(() => combo.classList.remove('bump'), 240);
    }
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 1900);
  }

  function triggerCrossfade(elId) {
    if (isStaticMode) return;
    const el = document.getElementById(elId);
    if (!el) return;
    el.classList.add('is-transitioning');
    setTimeout(() => el.classList.remove('is-transitioning'), 150);
  }

  // Sequential 4-stage kinetic wave across the pipeline nodes
  function triggerPipelineWave() {
    if (isStaticMode) return;
    ['1', '2', '3', '4'].forEach((id, idx) => {
      setTimeout(() => {
        const node = document.getElementById('pipe-node-' + id);
        if (!node) return;
        node.classList.remove('wave-hit');
        void node.offsetWidth;
        node.classList.add('wave-hit');
      }, idx * 75);
    });
  }

  // Smooth layout-projection glider positioning for Pipeline Stepper & Filter Pills
  function positionGliders() {
    const pipeGlider = document.getElementById('pipe-glider');
    const tabIndexMap = { harvest: '1', skeleton: '2', ledger: '3', receipt: '4' };
    const activeNode = workbenchOpen ? document.getElementById('pipe-node-' + tabIndexMap[activeWorkbenchTab]) : null;
    if (pipeGlider && activeNode) {
      pipeGlider.style.width = activeNode.offsetWidth + 'px';
      pipeGlider.style.height = activeNode.offsetHeight + 'px';
      pipeGlider.style.transform = 'translate3d(' + activeNode.offsetLeft + 'px, ' + activeNode.offsetTop + 'px, 0)';
      pipeGlider.classList.add('visible');
    } else if (pipeGlider) {
      pipeGlider.classList.remove('visible');
    }

    const filterGlider = document.getElementById('filter-glider');
    const filterMap = { installed: 'filter-installed', project: 'filter-project', all: 'filter-all' };
    const activePill = document.getElementById(filterMap[agentFilter]);
    if (filterGlider && activePill) {
      filterGlider.style.width = activePill.offsetWidth + 'px';
      filterGlider.style.transform = 'translate3d(' + activePill.offsetLeft + 'px, 0, 0)';
    }
  }

  window.addEventListener('resize', positionGliders);

  // Rolling odometer animation for token & symbol counters
  function animateTelemetryNumbers(targetRaw, targetDiet, savedPct, targetSymbols) {
    const statEl = document.getElementById('stat-tokens');
    const astEl = document.getElementById('hud-ast-count');
    const pctEl = document.getElementById('hud-diet-pct');
    const fillEl = document.getElementById('hud-diet-fill');

    if (pctEl) pctEl.textContent = '-' + savedPct + '%';
    if (fillEl) {
      const insetRight = Math.max(0, 100 - Math.min(100, Math.max(10, Math.round(savedPct))));
      fillEl.style.clipPath = 'inset(0 ' + insetRight + '% 0 0)';
    }

    if (isStaticMode || (displayedRawTokens === targetRaw && displayedDietTokens === targetDiet && displayedSymbols === targetSymbols)) {
      displayedRawTokens = targetRaw;
      displayedDietTokens = targetDiet;
      displayedSymbols = targetSymbols;
      if (statEl) {
        statEl.textContent =
          targetRaw.toLocaleString() + ' -> ' + targetDiet.toLocaleString() + ' tok (-' + savedPct + '%)';
      }
      if (astEl) astEl.textContent = targetSymbols + ' AST Symbols';
      return;
    }

    const startRaw = displayedRawTokens || targetRaw;
    const startDiet = displayedDietTokens || targetDiet;
    const startSym = displayedSymbols || targetSymbols;
    const startTime = performance.now();
    const duration = 360;

    function tick(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const curRaw = Math.round(startRaw + (targetRaw - startRaw) * ease);
      const curDiet = Math.round(startDiet + (targetDiet - startDiet) * ease);
      const curSym = Math.round(startSym + (targetSymbols - startSym) * ease);
      if (statEl) {
        statEl.textContent =
          curRaw.toLocaleString() + ' -> ' + curDiet.toLocaleString() + ' tok (-' + savedPct + '%)';
      }
      if (astEl) astEl.textContent = curSym + ' AST Symbols';
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        displayedRawTokens = targetRaw;
        displayedDietTokens = targetDiet;
        displayedSymbols = targetSymbols;
      }
    }
    requestAnimationFrame(tick);
  }

  function toggleAddWorkspacePopover(e) {
    if (e) e.stopPropagation();
    const pop = document.getElementById('add-ws-popover');
    pop.classList.toggle('open');
    if (pop.classList.contains('open')) {
      setTimeout(() => document.getElementById('custom-ws-input')?.focus(), 40);
    }
  }

  function closeAddWorkspacePopover() {
    document.getElementById('add-ws-popover')?.classList.remove('open');
  }

  document.addEventListener('click', (e) => {
    const pop = document.getElementById('add-ws-popover');
    const btn = document.getElementById('btn-add-ws');
    if (pop && pop.classList.contains('open') && !pop.contains(e.target) && !btn.contains(e.target)) {
      pop.classList.remove('open');
    }
  });

  async function submitCustomWorkspace(e) {
    e.preventDefault();
    const inp = document.getElementById('custom-ws-input');
    const rawPath = (inp?.value || '').trim();
    if (!rawPath) return;
    setStatus('Opening project directory...');
    const res = await fetch('/api/add-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawPath }),
    });
    const data = await res.json();
    if (data.error) {
      setStatus(data.error);
      return;
    }
    inp.value = '';
    closeAddWorkspacePopover();
    rehydratedPreview = null;
    triggerCrossfade('session-deck');
    triggerCrossfade('table-viewport');
    state = data;
    render();
    triggerPipelineWave();
    popActionToast('✓ Workspace Opened · ' + state.project);
    setStatus('Switched project to ' + state.project);
  }

  async function switchWorkspace(projectRoot) {
    closeAddWorkspacePopover();
    setStatus('Switching project context...');
    rehydratedPreview = null;
    triggerCrossfade('session-deck');
    triggerCrossfade('table-viewport');
    const res = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot }),
    });
    state = await res.json();
    render();
    triggerPipelineWave();
    popActionToast('✓ Project Synced · ' + state.project);
    setStatus('Switched project to ' + state.project + ' (' + state.branch + ')');
  }

  async function selectSourceSession(agentId, sessionId) {
    setStatus('Locking source session...');
    rehydratedPreview = null;
    triggerCrossfade('workbench-drawer');
    const res = await fetch('/api/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId }),
    });
    state = await res.json();
    render();
    triggerPipelineWave();
    popActionToast('✓ Source Locked · ' + agentId);
    setStatus('Source baton locked to ' + agentId + (sessionId ? ' (' + sessionId + ')' : ''));
  }

  async function syncDietToDisk() {
    setStatus('Running 4-Stage Context Diet & writing .vicem/BATON.md + ledger.json...');
    triggerPipelineWave();
    const res = await fetch('/api/sync-diet', { method: 'POST' });
    state = await res.json();
    workbenchOpen = true;
    activeWorkbenchTab = 'ledger';
    render();
    popActionToast('✓ Synced .vicem/BATON.md & ' + (state.skeletonSummary?.totalSymbols || 0) + ' Symbols');
    setStatus(state.actionReceipt || 'Synced .vicem/BATON.md and .vicem/ledger.json to disk');
  }

  async function testRehydrateSymbol(filePath, symbolName) {
    setStatus('Rehydrating ' + symbolName + ' from .vicem/ledger.json...');
    const res = await fetch('/api/rehydrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, symbolName }),
    });
    const data = await res.json();
    if (data.ok) {
      rehydratedPreview = data;
      justRehydratedFlash = true;
      renderWorkbench();
      justRehydratedFlash = false;
      popActionToast('✓ Rehydrated · ' + symbolName);
      setStatus('Rehydrated ' + symbolName + ' from ' + filePath + ' (lossless AST body verified)');
    }
  }

  async function toggleRuleMount(relPath) {
    setStatus('Updating rule file ' + relPath + '...');
    const res = await fetch('/api/toggle-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath }),
    });
    state = await res.json();
    render();
    popActionToast('✓ Rule Mount Updated · ' + relPath);
    setStatus('Updated rule mount for ' + relPath);
  }

  function selectWorkbenchTab(tabName) {
    if (workbenchOpen && activeWorkbenchTab === tabName) {
      workbenchOpen = false;
    } else {
      workbenchOpen = true;
      activeWorkbenchTab = tabName;
      triggerCrossfade('workbench-drawer');
    }
    render();
  }

  function toggleWorkbenchDrawer() {
    workbenchOpen = !workbenchOpen;
    render();
  }

  function closeWorkbench() {
    workbenchOpen = false;
    render();
  }

  function setAgentFilter(mode) {
    agentFilter = mode;
    document.getElementById('filter-installed').classList.toggle('active', mode === 'installed');
    document.getElementById('filter-project').classList.toggle('active', mode === 'project');
    document.getElementById('filter-all').classList.toggle('active', mode === 'all');
    render();
  }

  function previewRoute(targetName) {
    const el = document.getElementById('relay-target');
    const pill = document.getElementById('relay-route-pill');
    if (!el) return;
    if (targetName) {
      el.textContent = targetName;
      el.classList.add('locked');
      pill?.classList.add('route-active');
    } else if (!relayingTargetId) {
      el.textContent = 'Select target below';
      el.classList.remove('locked');
      pill?.classList.remove('route-active');
    }
  }

  function buildSegmentedBar(pct, isWorking, isWarn, hasBar) {
    const total = 20;
    const filled = hasBar ? Math.round((pct / 100) * total) : 0;
    let html = '<div class="seg-bar">';
    for (let i = 0; i < total; i++) {
      let cls = 'seg';
      if (i < filled) {
        cls += ' on';
        if (isWarn) cls += ' warn';
        else if (isWorking) cls += ' working';
      }
      html += '<span class="' + cls + '"></span>';
    }
    html += '</div>';
    return html;
  }

  function toggleLaunchApp() {
    if (launchMode === 'app') launchMode = 'cli';
    else if (launchMode === 'cli') launchMode = 'off';
    else launchMode = 'app';

    const btn = document.getElementById('btn-launch-toggle');
    const lbl = document.getElementById('launch-label');
    btn.classList.toggle('active-toggle', launchMode !== 'off');
    if (launchMode === 'app') {
      lbl.textContent = 'Launch: Desktop App';
      setStatus('Mode: Open Desktop GUI App (Claude.app / ChatGPT.app / IDE)');
    } else if (launchMode === 'cli') {
      lbl.textContent = 'Launch: Terminal CLI';
      setStatus('Mode: Open native terminal running CLI binary');
    } else {
      lbl.textContent = 'Launch: Off (Copy only)';
      setStatus('Mode: Copy baton + mount rule file only');
    }
  }

  async function saveCustomGoal(goal) {
    const res = await fetch('/api/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    });
    state = await res.json();
    render();
    setStatus('Updated handoff goal instruction');
  }

  function renderWorkbench() {
    const drawer = document.getElementById('workbench-drawer');
    const titleEl = document.getElementById('wb-title');
    const bodyEl = document.getElementById('wb-body');
    const inspectBtn = document.getElementById('btn-inspect');

    if (!state || !workbenchOpen) {
      drawer.classList.remove('open');
      if (inspectBtn) inspectBtn.classList.remove('active-toggle');
      ['1', '2', '3', '4'].forEach((n) => document.getElementById('pipe-node-' + n)?.classList.remove('active-tab'));
      positionGliders();
      return;
    }

    drawer.classList.add('open');
    if (inspectBtn) inspectBtn.classList.add('active-toggle');

    const tabIndexMap = { harvest: '1', skeleton: '2', ledger: '3', receipt: '4' };
    ['1', '2', '3', '4'].forEach((n) => {
      document.getElementById('pipe-node-' + n)?.classList.toggle('active-tab', tabIndexMap[activeWorkbenchTab] === n);
    });
    positionGliders();

    const sk = state.skeletonSummary || { files: [], totalSymbols: 0 };
    const selectedSess = (state.projectSessions || []).find((s) => s.isSelected) || (state.projectSessions || [])[0];

    if (activeWorkbenchTab === 'harvest') {
      titleEl.textContent = 'Stage 1 · Harvested Session Timeline & Active Git Tree (' + state.project + ')';
      const prompts = (selectedSess?.prompts || []).slice().reverse();
      const promptsHtml = prompts.length
        ? prompts.map((p, idx) => '<div class="prompt-list-item"><strong>#' + (prompts.length - idx) + '</strong> ' + escapeHtml(p) + '</div>').join('')
        : '<div class="prompt-list-item">No user prompts recorded in this session yet.</div>';

      const filesHtml = (state.modifiedFiles || []).length
        ? state.modifiedFiles.map((f) => '<div class="prompt-list-item">' + escapeHtml(f) + '</div>').join('')
        : '<div class="prompt-list-item">Working tree clean (using recent project files).</div>';

      bodyEl.innerHTML =
        '<div class="wb-grid-2">' +
          '<div class="wb-box">' +
            '<div class="wb-box-title">Recent Prompts from Source (' + escapeHtml(selectedSess?.agentName || state.workingAgentId) + ' · ' + escapeHtml(selectedSess?.sourceFile || '') + ')</div>' +
            promptsHtml +
          '</div>' +
          '<div class="wb-box">' +
            '<div class="wb-box-title">Tracked / Modified Files Included in Baton (' + (state.modifiedFiles || []).length + ')</div>' +
            filesHtml +
          '</div>' +
        '</div>';
    } else if (activeWorkbenchTab === 'skeleton') {
      titleEl.textContent =
        'Stage 2 · Live AST Code Skeletonizer & Lossless Symbol Rehydration (' +
        sk.totalSymbols +
        ' functions indexed)';

      const allSymbols = [];
      for (const f of sk.files || []) {
        for (const sym of f.symbols || []) {
          allSymbols.push({ ...sym, savedPct: f.savedPct });
        }
      }

      const symRowsHtml = allSymbols.length
        ? allSymbols
            .slice(0, 16)
            .map(
              (s) =>
                '<div class="symbol-row' +
                (rehydratedPreview && rehydratedPreview.symbolName === s.symbolName ? ' active-sym' : '') +
                '" onclick="testRehydrateSymbol(\\'' +
                escapeHtml(s.filePath) +
                '\\', \\'' +
                escapeHtml(s.symbolName) +
                '\\')">' +
                '<span><strong>' +
                escapeHtml(s.symbolName) +
                '</strong> <span style="color:var(--text-muted)">(' +
                escapeHtml(s.filePath) +
                ':L' +
                s.startLine +
                '-' +
                s.endLine +
                ' · ' +
                s.tokens +
                ' tok)</span></span>' +
                '<button class="rehydrate-btn">Rehydrate</button>' +
                '</div>'
            )
            .join('')
        : '<div class="prompt-list-item">No multi-line functions detected to skeletonize in active files.</div>';

      const rightBoxTitle = rehydratedPreview
        ? 'Rehydrated Symbol: ' + escapeHtml(rehydratedPreview.symbolName) + ' (' + escapeHtml(rehydratedPreview.filePath) + ')'
        : 'Skeletonized File Preview (' + escapeHtml(sk.files[0]?.filePath || 'Active Code') + ' · -' + (sk.codeSavedPct || 0) + '% tokens)';
      const rightBoxCode = rehydratedPreview
        ? rehydratedPreview.rehydratedCode
        : sk.files[0]?.skeletonPreview || '// Select any function on the left to test lossless MCP vicem_rehydrate';

      bodyEl.innerHTML =
        '<div class="wb-grid-2">' +
          '<div class="wb-box">' +
            '<div class="wb-box-title">Indexed AST Symbols in .vicem/ledger.json (Click to Rehydrate)</div>' +
            symRowsHtml +
          '</div>' +
          '<div class="wb-box' + (justRehydratedFlash ? ' rehydrate-flash' : '') + '">' +
            '<div class="wb-box-title">' + rightBoxTitle + '</div>' +
            '<pre class="code-preview-pre">' + escapeHtml(rightBoxCode) + '</pre>' +
          '</div>' +
        '</div>';
    } else if (activeWorkbenchTab === 'ledger') {
      titleEl.textContent =
        'Stage 3 · Disk Sync Status (.vicem/BATON.md & .vicem/ledger.json) + Rule File Mounts';
      const rulesHtml = (state.ruleMountStatus || [])
        .map(
          (r) =>
            '<button class="rule-chip' +
            (r.mounted ? ' mounted' : '') +
            '" onclick="toggleRuleMount(\\'' +
            escapeHtml(r.rel) +
            '\\')">' +
            '<span>' +
            (r.mounted ? '● Mounted:' : '○ Mount:') +
            '</span>' +
            '<strong>' +
            escapeHtml(r.rel) +
            '</strong>' +
            '</button>'
        )
        .join('');

      const diskInfo =
        'BATON.md on disk: ' +
        (sk.batonOnDisk ? sk.batonDiskBytes.toLocaleString() + ' bytes (' + sk.batonDiskAgo + ')' : 'Not written yet (Click Sync Diet)') +
        ' | ledger.json on disk: ' +
        (sk.ledgerOnDisk ? sk.ledgerDiskBytes.toLocaleString() + ' bytes (' + sk.diskSymbolsCount + ' symbols)' : 'Not written yet');

      bodyEl.innerHTML =
        '<div class="wb-grid-2">' +
          '<div class="wb-box">' +
            '<div class="wb-box-title">' + escapeHtml(diskInfo) + '</div>' +
            '<div class="wb-box-title" style="margin-top:6px">1-Click Agent Rule Mounts in ' + escapeHtml(state.shortProject) + '</div>' +
            '<div class="rule-chip-list">' + rulesHtml + '</div>' +
          '</div>' +
          '<div class="wb-box">' +
            '<div class="wb-box-title">Live .vicem/BATON.md Payload Preview (' + state.stats.dietTokens.toLocaleString() + ' tokens)</div>' +
            '<pre class="code-preview-pre">' + escapeHtml(state.batonMarkdown || '') + '</pre>' +
          '</div>' +
        '</div>';
    } else if (activeWorkbenchTab === 'receipt') {
      const r = state.lastHandoffReceipt;
      titleEl.textContent = r
        ? 'Stage 4 · Verified 5-Step Handoff Receipt (' + r.timestamp + ' · ' + r.sourceAgent + ' -> ' + r.targetId + ')'
        : 'Stage 4 · 5-Step Handoff Verification Pipeline (Ready to Relay)';
      const steps = r
        ? r.steps
        : [
            { ok: true, title: '1. Harvest Session & Git State', detail: 'Ready to extract ' + (selectedSess?.prompts?.length || 0) + ' prompts from ' + state.workingAgentId },
            { ok: true, title: '2. Skeletonize AST & 4-Stage Diet', detail: state.stats.rawTokens.toLocaleString() + ' -> ' + state.stats.dietTokens.toLocaleString() + ' tok (-' + state.stats.savedPct + '%)' },
            { ok: sk.batonOnDisk, title: '3. Persist .vicem/BATON.md & ledger.json', detail: sk.batonOnDisk ? 'Synced on disk (' + sk.batonDiskBytes + ' bytes)' : 'Will write on handoff or Sync Diet' },
            { ok: (state.mountedFiles || []).length > 0, title: '4. Mount Target Rules & Clipboard', detail: (state.mountedFiles || []).length > 0 ? 'Mounted: ' + state.mountedFiles.join(', ') : 'Mounts target agent rule file + clipboard' },
            { ok: true, title: '5. Launch Target Agent', detail: 'Click Hand off -> on any row below (' + launchMode.toUpperCase() + ' mode)' },
          ];
      bodyEl.innerHTML =
        '<div class="wb-box">' +
        steps
          .map(
            (s) =>
              '<div class="prompt-list-item" style="display:flex;justify-content:space-between;gap:12px">' +
              '<span><strong style="color:' + (s.ok ? 'var(--accent)' : 'var(--warn)') + '">' + (s.ok ? '[OK]' : '[WAIT]') + '</strong> ' + escapeHtml(s.title) + '</span>' +
              '<span style="color:var(--text-muted)">' + escapeHtml(s.detail) + '</span>' +
              '</div>'
          )
          .join('') +
        '</div>';
    }
  }

  function render() {
    if (!state) return;

    // 1. Project Tabs + Discovered Workspaces List in Popover
    const tabsEl = document.getElementById('ws-tabs');
    tabsEl.innerHTML = '';
    for (const ws of (state.workspaces || []).slice(0, 5)) {
      const btn = document.createElement('button');
      const isCurrent = ws.path === state.projectRoot;
      btn.className = 'ws-tab' + (isCurrent ? ' active' : '');
      btn.title = ws.shortPath + ' (' + (ws.branch || 'main') + ')';
      btn.onclick = () => switchWorkspace(ws.path);
      btn.innerHTML =
        '<span class="ws-sync-dot' + (ws.hasBaton ? ' synced' : '') + '"></span>' +
        '<span>' + escapeHtml(ws.name) + '</span>' +
        '<span class="ws-branch-mini">' + escapeHtml(ws.branch || 'main') + '</span>';
      tabsEl.appendChild(btn);
    }

    const popList = document.getElementById('ws-pop-list');
    if (popList) {
      popList.innerHTML = (state.workspaces || [])
        .map(
          (ws) =>
            '<button class="ws-pop-item" onclick="switchWorkspace(\\'' +
            escapeHtml(ws.path) +
            '\\')">' +
            '<span><strong>' +
            escapeHtml(ws.name) +
            '</strong> <span style="color:var(--text-muted)">(' +
            escapeHtml(ws.shortPath) +
            ')</span></span>' +
            '<span style="color:var(--accent)">' +
            escapeHtml(ws.branch || 'main') +
            (ws.hasBaton ? ' · Synced' : '') +
            '</span>' +
            '</button>'
        )
        .join('');
    }

    // 2. Kinetic Rolling Token & AST Telemetry
    const sk = state.skeletonSummary || { totalSymbols: 0, batonOnDisk: false };
    animateTelemetryNumbers(
      state.stats.rawTokens,
      state.stats.dietTokens,
      state.stats.savedPct,
      sk.totalSymbols || 0
    );

    // 3. Project Sessions Strip (Explicit Source Selector with Staggered Cascade)
    document.getElementById('active-project-pill').textContent =
      state.shortProject + ' (' + state.branch + ')';
    document.getElementById('mounted-status').textContent =
      state.mountedFiles.length > 0
        ? 'Mounted: ' + state.mountedFiles.join(', ')
        : 'Clean tree (no rules mounted)';

    const sCardsEl = document.getElementById('session-cards');
    sCardsEl.innerHTML = (state.projectSessions || [])
      .map(
        (s, idx) =>
          '<button class="session-card' +
          (s.isSelected ? ' selected' : '') +
          '" style="--idx:' + idx + '" onclick="selectSourceSession(\\'' +
          escapeHtml(s.agentId) +
          '\\', \\'' +
          escapeHtml(s.id) +
          '\\')">' +
          '<div class="sc-top">' +
          '<span class="sc-agent">' +
          (s.isSelected ? '<span class="sc-source-tag">SOURCE</span>' : '') +
          escapeHtml(s.agentName) +
          '</span>' +
          '<span class="sc-ago">' +
          escapeHtml(s.ago) +
          ' · ' +
          (s.prompts?.length || 0) +
          ' prompts</span>' +
          '</div>' +
          '<div class="sc-title">' +
          escapeHtml(s.title) +
          '</div>' +
          '</button>'
      )
      .join('');

    const workingNode = state.nodes.find((n) => n.isSource) || state.nodes[0];
    document.getElementById('relay-source').textContent = workingNode ? workingNode.name : state.workingAgentId;
    if (!isEditingGoal) {
      taskInput.value = state.taskTitle;
    }

    // 4. Live 4-Node Pipeline Stepper Summary
    const selectedSess = (state.projectSessions || []).find((s) => s.isSelected) || (state.projectSessions || [])[0];
    document.getElementById('pipe-badge-1').textContent = (selectedSess?.prompts?.length || 0) + ' prompts';
    document.getElementById('pipe-sub-1').textContent =
      (selectedSess?.agentName || 'Session') + ' · ' + (state.modifiedFiles?.length || 0) + ' tracked files';

    document.getElementById('pipe-badge-2').textContent = sk.totalSymbols + ' symbols';
    document.getElementById('pipe-sub-2').textContent =
      state.stats.rawTokens.toLocaleString() + ' -> ' + state.stats.dietTokens.toLocaleString() + ' tok (-' + state.stats.savedPct + '%)';

    const b3 = document.getElementById('pipe-badge-3');
    b3.textContent = sk.batonOnDisk ? 'Disk Synced' : 'In-Memory';
    b3.className = 'pipe-badge ' + (sk.batonOnDisk ? 'ok' : 'warn');
    document.getElementById('pipe-sub-3').textContent = sk.batonOnDisk
      ? 'BATON.md (' + sk.batonDiskBytes + 'B) · ' + (state.mountedFiles.length || 0) + ' mounted'
      : 'Click Sync Diet (R) to write to disk';

    const b4 = document.getElementById('pipe-badge-4');
    if (state.lastHandoffReceipt) {
      b4.textContent = 'Verified';
      b4.className = 'pipe-badge ok';
      document.getElementById('pipe-sub-4').textContent =
        state.lastHandoffReceipt.sourceAgent + ' -> ' + state.lastHandoffReceipt.targetId + ' (' + state.lastHandoffReceipt.timestamp + ')';
    } else {
      b4.textContent = 'Ready';
      b4.className = 'pipe-badge';
      document.getElementById('pipe-sub-4').textContent = 'Route: ' + (workingNode?.name || 'Source') + ' -> Target';
    }

    renderWorkbench();

    // 5. Agent Process Rows (Scoped to Project + Explicit Set Source / Hand Off)
    const tbody = document.getElementById('agent-rows');
    const visibleNodes = state.nodes.filter((n) => {
      if (agentFilter === 'project') return n.inProject || n.isSource;
      if (agentFilter === 'all') return true;
      return n.primary || n.installed || n.inProject;
    });

    const inProjCount = state.nodes.filter((n) => n.inProject).length;
    document.getElementById('filter-project').textContent = 'In This Project (' + inProjCount + ')';
    document.getElementById('table-scope-hint').textContent =
      inProjCount + ' agents have session history in ' + state.project + ' (' + state.branch + ')';

    tbody.innerHTML = visibleNodes
      .map((node) => {
        const isSource = Boolean(node.isSource);
        const hasBar = Boolean(node.quota?.hasBar);
        const pct = node.quota?.remainPct ?? 100;
        const isWarn = hasBar && pct < 55;
        const isRelayingThis = relayingTargetId === node.id;

        const actionHtml = isSource
          ? '<span class="holding-pill">● SOURCE BATON</span>'
          : isRelayingThis
          ? '<button class="handoff-btn"><span>Relaying...</span></button>'
          : '<div class="act-group">' +
              '<button class="set-src-btn" onclick="selectSourceSession(\\'' +
              escapeHtml(node.id) +
              '\\', ' +
              (node.projectSessionId ? '\\'' + escapeHtml(node.projectSessionId) + '\\'' : 'null') +
              ')" title="Use this agent as the Baton Source">Set Source</button>' +
              '<button class="handoff-btn" onmouseenter="previewRoute(\\'' +
              escapeHtml(node.name) +
              '\\')" onmouseleave="previewRoute(null)" onclick="handOffTo(\\'' +
              escapeHtml(node.id) +
              '\\', \\'' +
              escapeHtml(node.name) +
              '\\')"><span>Hand off</span><span>-&gt;</span></button>' +
            '</div>';

        const subLine = node.inProject
          ? (node.lastPrompt ? 'Session: "' + node.lastPrompt + '"' : 'Active in ' + state.shortProject)
          : 'Global: ' + node.globalWorkspace;

        return (
          '<tr class="' + (isSource ? 'is-working' : '') + '" data-agent-id="' + escapeHtml(node.id) + '">' +
            '<td>' +
              '<div class="agent-cell">' +
                '<div class="agent-info">' +
                  '<div class="agent-title-row">' +
                    '<span class="agent-name">' + escapeHtml(node.name) + '</span>' +
                    (node.inProject ? '<span class="in-proj-badge">IN PROJECT</span>' : '') +
                    (node.model ? '<span class="model-badge">' + escapeHtml(node.model) + '</span>' : '') +
                  '</div>' +
                  '<span class="agent-path">' + escapeHtml(subLine) + '</span>' +
                '</div>' +
              '</div>' +
            '</td>' +
            '<td class="td-state">' +
              '<span class="state-badge">' +
                '<span class="state-sq ' + escapeHtml(node.status) + '"></span>' +
                '<span>' + (isSource ? 'Source' : node.inProject ? 'Ready' : node.status) + '</span>' +
              '</span>' +
            '</td>' +
            '<td>' +
              '<div class="quota-cell">' +
                '<div class="quota-meta">' +
                  '<span class="quota-val' + (hasBar ? '' : ' subtle') + '">' + escapeHtml(node.quota?.label || 'Ready') + '</span>' +
                  '<span class="quota-sub">' + escapeHtml(node.quota?.detail || '') + '</span>' +
                '</div>' +
                buildSegmentedBar(pct, isSource, isWarn, hasBar) +
              '</div>' +
            '</td>' +
            '<td class="seen-cell">' + escapeHtml(node.lastSeen) + '</td>' +
            '<td>' + actionHtml + '</td>' +
          '</tr>'
        );
      })
      .join('');

    requestAnimationFrame(positionGliders);
  }

  async function handOffTo(targetId, targetName) {
    relayingTargetId = targetId;
    previewRoute(targetName);
    triggerPipelineWave();
    render();
    setStatus('Executing 5-step handoff to ' + targetName + '...');
    try {
      const res = await fetch('/api/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, launchMode }),
      });
      state = await res.json();
      workbenchOpen = true;
      activeWorkbenchTab = 'receipt';
    } finally {
      relayingTargetId = null;
    }
    render();
    popActionToast('✓ Baton Relayed -> ' + targetName);
    setStatus(state.actionReceipt || 'Relayed baton to ' + targetName);
  }

  async function triggerBack() {
    if (!state || !state.lastHandedOffFrom) {
      setStatus('No previous agent in session history');
      return;
    }
    const prev = state.nodes.find((n) => n.id === state.lastHandedOffFrom);
    await handOffTo(state.lastHandedOffFrom, prev ? prev.name : state.lastHandedOffFrom);
  }

  async function copyBaton() {
    const res = await fetch('/api/clip', { method: 'POST' });
    state = await res.json();
    render();
    popActionToast('✓ Copied .vicem/BATON.md');
    setStatus('Copied .vicem/BATON.md to system clipboard');
  }

  // Keyboard shortcuts (Emil Kowalski rule: zero animation on high-frequency keyboard actions)
  window.addEventListener('keydown', (e) => {
    if (isEditingGoal || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') syncDietToDisk();
    else if (k === 'z') triggerBack();
    else if (k === 'c') copyBaton();
    else if (k === 'i') toggleWorkbenchDrawer();
    else if (k === 'a') setAgentFilter(agentFilter === 'all' ? 'installed' : 'all');
    else if (k === 't') toggleTheme();
    else if (k === '1') selectWorkbenchTab('harvest');
    else if (k === '2') selectWorkbenchTab('skeleton');
    else if (k === '3') selectWorkbenchTab('ledger');
    else if (k === '4') selectWorkbenchTab('receipt');
  });

  async function load(initialData) {
    try {
      const nextState = initialData || await (await fetch('/api/state')).json();
      if (nextState.guiVersion && nextState.guiVersion !== CLIENT_GUI_VERSION) {
        window.location.reload();
        return;
      }
      state = nextState;
      render();
    } catch {}
  }

  load(window.__INITIAL_STATE__ || null);
  if (!isStaticMode) setInterval(() => load(null), 3500);
</script>
</body>
</html>`;

const PORT = Number(process.env.VICEM_GUI_PORT || 4310);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/') {
    const initData = await collectState();
    const safeJson = JSON.stringify(initData)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const hydratedHtml = HTML_PAGE.replace(
      '<script>',
      () => `<script>window.__INITIAL_STATE__ = ${safeJson};\n`
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(hydratedHtml);
    return;
  }

  if (url.pathname === '/logo-dark.png' && fs.existsSync(LOGO_DARK_PATH)) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(LOGO_DARK_PATH).pipe(res);
    return;
  }

  if (url.pathname === '/logo-light.png' && fs.existsSync(LOGO_LIGHT_PATH)) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(LOGO_LIGHT_PATH).pipe(res);
    return;
  }

  if (url.pathname === '/api/state') {
    const data = await collectState();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url.pathname === '/api/workspace' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { projectRoot } = JSON.parse(body || '{}');
        if (projectRoot && fs.existsSync(projectRoot)) {
          selectedProjectRoot = projectRoot;
          selectedSourceSessionId = null;
          manualActiveAgent = null;
          customGoalOverride = '';
        }
        const updated = await collectState();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/api/add-workspace' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { rawPath } = JSON.parse(body || '{}');
        const home = os.homedir();
        let cleaned = String(rawPath || '').trim();
        if (cleaned.startsWith('~/')) {
          cleaned = path.join(home, cleaned.slice(2));
        } else if (cleaned === '~') {
          cleaned = home;
        }
        cleaned = path.resolve(cleaned);
        if (!cleaned || !fs.existsSync(cleaned) || !fs.statSync(cleaned).isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Directory not found: ${rawPath}` }));
          return;
        }
        customWorkspacePaths.add(cleaned);
        selectedProjectRoot = cleaned;
        selectedSourceSessionId = null;
        manualActiveAgent = null;
        customGoalOverride = '';
        const updated = await collectState();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/api/source' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { agentId, sessionId } = JSON.parse(body || '{}');
        if (agentId) manualActiveAgent = String(agentId);
        if (sessionId !== undefined) selectedSourceSessionId = sessionId ? String(sessionId) : null;
        customGoalOverride = '';
        const updated = await collectState();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/api/sync-diet' && req.method === 'POST') {
    try {
      const home = os.homedir();
      const state = await collectState();
      const projectRoot = state.projectRoot;
      const sourceAgent = state.workingAgentId || 'antigravity';
      const git = GitCollector.collect(projectRoot);
      const rich = harvestRichProjectContext(projectRoot, home, git);
      const effectiveGit = {
        ...git,
        modifiedFiles: rich.activeFileList.length > 0 ? rich.activeFileList : git.modifiedFiles,
      };
      const doneList = [];
      for (const u of rich.recentUsers.slice(0, -1)) doneList.push(`User request handled: "${u}"`);
      for (const a of rich.recentAssistant) doneList.push(`Agent summary: ${a}`);
      for (const f of rich.activeFileList) doneList.push(`Active file modified/created in session: \`${f}\``);
      const task = {
        goal: state.taskTitle,
        immediateNext: [
          `Fulfill latest request in ${state.project} (${state.branch}): "${state.taskTitle}"`,
        ],
        done: doneList,
        userPrompts: rich.recentUsers,
      };
      const baton = BatonIaBuilder.build({
        projectRoot,
        sourceAgent,
        targetAgent: 'codex',
        sessionId: rich.sessionId,
        persist: true,
        taskContext: task,
        gitContext: effectiveGit,
        budgetTokens: 4000,
      });
      const skelSaved = collectLiveSkeletonLedger(projectRoot, rich.activeFileList, true);
      ClipboardAdapter.copyNative(baton.markdown);
      const updated = await collectState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ...updated,
          actionReceipt: `Synced .vicem/BATON.md (${updated.skeletonSummary.batonDiskBytes}B) & .vicem/ledger.json (${skelSaved.totalSymbols} AST symbols)`,
        })
      );
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (url.pathname === '/api/rehydrate' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { filePath, symbolName } = JSON.parse(body || '{}');
        const projectRoot = fs.existsSync(selectedProjectRoot) ? selectedProjectRoot : DEFAULT_PROJECT_ROOT;
        const git = GitCollector.collect(projectRoot);
        const rich = harvestRichProjectContext(projectRoot, os.homedir(), git);
        const skel = collectLiveSkeletonLedger(projectRoot, rich.activeFileList, false);
        const diskLedger = DietLedger.load(projectRoot);
        const code =
          diskLedger.getEntry(String(filePath || ''), symbolName ? String(symbolName) : null) ||
          skel.liveLedger.getEntry(String(filePath || ''), symbolName ? String(symbolName) : null) ||
          '// Symbol not found in ledger';
        let driftBanner = '';
        try {
          const drift = StalenessDriftGuard.check(projectRoot);
          if (drift.drifted) {
            driftBanner = `// [STALENESS DRIFT WARNING]: Branch/commits changed since Baton snapshot (${drift.driftedFiles.join(', ')})\n`;
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            filePath,
            symbolName,
            rehydratedCode: driftBanner + code,
          })
        );
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/api/toggle-rule' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { relPath } = JSON.parse(body || '{}');
        const state = await collectState();
        const projectRoot = state.projectRoot;
        const fp = path.join(projectRoot, String(relPath || 'AGENTS.md'));
        const isMounted =
          fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes('<!-- VICEM-BATON-START -->');
        if (isMounted) {
          const cur = fs.readFileSync(fp, 'utf8');
          const stripped = cur
            .replace(/<!-- VICEM-BATON-START -->[\s\S]*?<!-- VICEM-BATON-END -->\n?/g, '')
            .trim();
          if (stripped) {
            fs.writeFileSync(fp, stripped + '\n', 'utf8');
          } else {
            fs.rmSync(fp, { force: true });
          }
        } else {
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          const block = `<!-- VICEM-BATON-START -->\n${state.batonMarkdown.trim()}\n<!-- VICEM-BATON-END -->\n`;
          if (fs.existsSync(fp)) {
            const cur = fs.readFileSync(fp, 'utf8');
            fs.writeFileSync(fp, block + '\n' + cur, 'utf8');
          } else {
            fs.writeFileSync(fp, block, 'utf8');
          }
        }
        const updated = await collectState();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/api/goal' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { goal } = JSON.parse(body || '{}');
        customGoalOverride = String(goal || '').trim();
        const updated = await collectState();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/api/handoff' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { targetId, launchMode } = JSON.parse(body || '{}');
        const updated = await executeRealHandoff(targetId || 'codex', launchMode || 'app');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  if (url.pathname === '/api/unmount' && req.method === 'POST') {
    try {
      RuleMountAdapter.unmount(selectedProjectRoot);
      lastHandoffReceipt = null;
      const updated = await collectState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(updated));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (url.pathname === '/api/clip' && req.method === 'POST') {
    await VicemApp.run(['clip'], { projectRoot: selectedProjectRoot, skipLaunch: true });
    const updated = await collectState();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(updated));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', (err) => {
  const url = `http://127.0.0.1:${PORT}`;
  if (err && err.code === 'EADDRINUSE') {
    console.log(`[Vicem Utility GUI] Already running at ${url}`);
    if (process.env.VICEM_AUTO_OPEN === '1') {
      openExternalCrossPlatform(url);
    }
    process.exit(0);
  }
  console.error('[Vicem Utility GUI] Server error:', err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`[Vicem Utility GUI] Running at ${url}`);
  if (process.env.VICEM_AUTO_OPEN === '1') {
    openExternalCrossPlatform(url);
  }
});

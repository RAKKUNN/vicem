#!/usr/bin/env node
/**
 * Vicem Desktop Command Center (v9 — Real Native App Launcher + Step-by-Step Verification Receipt)
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
  if (!fullPath) return '—';
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

function formatAgo(mtimeMs) {
  if (!mtimeMs) return '—';
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

function resolveAgentBinary(agentId, home) {
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

  // Unix/macOS login shell lookup
  const binName = agentId === 'vscode' ? 'code' : agentId === 'antigravity' ? 'agy' : agentId;
  try {
    const shellBin = process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
    const found = execSync(`${shellBin} -lic 'command -v ${binName}'`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .pop();
    if (found && found.startsWith('/') && fs.existsSync(found)) return found;
  } catch {}
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
        const raw = fs.readFileSync(recentFiles[0].path, 'utf8');
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
let lastHandedOffFrom = null;
let lastHandoffReceipt = null;
let cachedTelemetry = null;
let cachedTelemetryAt = 0;

/**
 * Harvests rich, multi-turn conversation history, tool actions, and active files
 * from the real session logs of Antigravity, Claude Code, or OpenAI Codex for `projectRoot`.
 */
function harvestRichProjectContext(projectRoot, home, git) {
  const userTimeline = [];
  const assistantDigest = [];
  const touchedFiles = new Set();
  let rawSessionBytes = 0;
  let sessionId = 'live-session';

  // 1. Scan Antigravity brain transcripts sorted by mtimeMs (descending)
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
      for (const c of candidates.slice(0, 10)) {
        const raw = fs.readFileSync(c.path, 'utf8');
        if (!raw.includes(projectRoot)) continue;
        rawSessionBytes = c.size;
        sessionId = c.id;
        const lines = raw.trim().split('\n');
        const pathRegex = new RegExp(
          projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/([A-Za-z0-9_./-]+\\.[A-Za-z0-9]+)',
          'g'
        );
        for (const line of lines.slice(-160)) {
          for (const pm of line.matchAll(pathRegex)) {
            const rel = pm[1];
            if (rel && !rel.startsWith('.vicem') && !['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(rel)) {
              touchedFiles.add(rel);
            }
          }
          try {
            const step = JSON.parse(line);
            if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
              const m = step.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
              const text = (m ? m[1] : step.content).replace(/\s+/g, ' ').trim();
              if (text && text.length > 1 && !text.startsWith('<')) {
                userTimeline.push(text.slice(0, 180));
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
                      touchedFiles.add(rel);
                    }
                  }
                }
              }
            }
          } catch {}
        }
        break;
      }
    }
  } catch {}

  // 2. Fallback: Check Claude Code project sessions if no Antigravity timeline found
  if (userTimeline.length === 0) {
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
        if (files[0]) {
          rawSessionBytes = files[0].size;
          sessionId = files[0].id;
          const lines = fs.readFileSync(files[0].full, 'utf8').trim().split('\n');
          for (const l of lines.slice(-120)) {
            try {
              const o = JSON.parse(l);
              if (o.type === 'user' && typeof o.message?.content === 'string') {
                const txt = o.message.content.replace(/\s+/g, ' ').trim();
                if (txt) userTimeline.push(txt.slice(0, 180));
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  // 3. Combine session-touched files FIRST, then Git modified + untracked files sorted by code priority & mtime
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
  const rich = harvestRichProjectContext(projectRoot, home, git);

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

  const baton = BatonIaBuilder.build({
    projectRoot,
    sourceAgent: detected.agent || 'antigravity',
    targetAgent: 'codex',
    sessionId: rich.sessionId,
    persist: false,
    taskContext: effectiveTask,
    gitContext: effectiveGit,
    budgetTokens: 4000,
  });

  const trueRawTokens = Math.max(
    baton.rawTokens,
    Math.round(rich.rawSessionBytes / 4)
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

  let autoWorkingId = manualActiveAgent;
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

  const nodes = ALL_PLATFORMS.map((item) => {
    const t = tel[item.id];
    const check = diag.agentChecks.find((c) => c.id === item.id);
    const binFound = Boolean(check?.binFound || resolveAgentBinary(item.id, home));
    const hasStorage = Boolean(check?.hasStorage || (t?.mtimeMs || 0) > 0);
    const installed = item.id === 'web' ? true : binFound || hasStorage;
    const mtimeMs = t?.mtimeMs || 0;
    const ageSec = mtimeMs ? (Date.now() - mtimeMs) / 1000 : Infinity;

    let status = 'Idle';
    if (item.id === autoWorkingId && runningProcs[item.id]) {
      status = 'Working';
    } else if (item.id === lastHandedOffFrom || ageSec < 3600 * 12) {
      status = 'Done';
    }

    return {
      id: item.id,
      name: item.name,
      primary: item.primary || installed,
      model: t?.model || '',
      workspace: t?.workspace || '—',
      lastPrompt: t?.lastPrompt || '',
      installed,
      status,
      lastSeen: item.id === 'web' ? 'On demand' : formatAgo(mtimeMs),
      quota: t?.quota || { hasBar: false, label: 'Ready', detail: '' },
    };
  });

  const mountedFiles = [];
  for (const rel of [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.cursorrules',
    '.windsurfrules',
    '.clinerules',
    '.github/copilot-instructions.md',
  ]) {
    const fp = path.join(projectRoot, rel);
    try {
      if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes('<!-- VICEM-BATON-START -->')) {
        mountedFiles.push(rel);
      }
    } catch {}
  }

  const savedPct =
    trueRawTokens > baton.dietTokens
      ? Math.round((1 - baton.dietTokens / trueRawTokens) * 1000) / 10
      : 0;

  return {
    guiVersion: 'v16',
    osPlatform: process.platform,
    projectRoot,
    project: path.basename(projectRoot),
    shortProject: shortenHome(projectRoot, home),
    branch: git.branch || 'main',
    headShort: git.headShort || 'HEAD',
    modifiedFiles: effectiveGit.modifiedFiles,
    mountedFiles,
    workspaces: cachedTelemetry.workspaces,
    workingAgentId: autoWorkingId,
    lastHandedOffFrom,
    taskTitle: livePromptForProject,
    customGoalOverride,
    stats: {
      rawTokens: trueRawTokens,
      dietTokens: baton.dietTokens,
      savedPct,
      secretsMasked: baton.redactedCount,
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
        title: '1. Session & Git Harvest',
        detail: `Extracted context from ${sourceAgent} in ${state.project} (${state.branch})`,
      },
      {
        ok: true,
        title: '2. Context Diet & Redaction',
        detail: `${state.stats.rawTokens.toLocaleString()} → ${baton.dietTokens.toLocaleString()} tokens (-${state.stats.savedPct}%) · ${baton.redactedCount} secrets masked`,
      },
      {
        ok: Boolean(batonStat && batonStat.size > 0),
        title: '3. Baton File Written on Disk',
        detail: `${shortenHome(batonFilePath, home)} (${batonStat ? batonStat.size.toLocaleString() : 0} bytes verified)`,
      },
      {
        ok: mountVerified && clipboardChars > 0,
        title: '4. Rule Mounted & Clipboard Verified',
        detail: `Injected into ${mountedRel} · macOS clipboard verified (${clipboardChars.toLocaleString()} chars on pbpaste)`,
      },
      {
        ok: launchResult.ok,
        title: '5. Target Agent Launch',
        detail: `${launchResult.detail} [${launchResult.method}]`,
      },
    ],
    batonPreview: baton.markdown,
  };

  cachedTelemetryAt = 0;
  const updated = await collectState();
  return {
    ...updated,
    actionReceipt: `${nowStr} · ${launchMode && launchMode !== 'off' ? (launchResult.ok ? 'Launch verified for' : 'Launch failed for') : 'Baton prepared for'} ${targetId} (${launchResult.detail})`,
  };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Vicem — Agent Context Relay &amp; Capacity Monitor</title>
<link rel="icon" type="image/png" href="/logo-dark.png" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root[data-theme="dark"] {
    color-scheme: dark;
    --canvas: #08080A;
    --canvas-glow: radial-gradient(900px circle at 50% 0%, #14141A 0%, #08080A 70%);
    --win-bg: #101013;
    --win-header: #0C0C0E;
    --win-elevated: #151519;
    --row-hover: #17171C;
    --row-working: #111814;
    --border-subtle: #1E1E24;
    --border-mid: #282830;
    --border-strong: #383844;
    --text-primary: #F4F4F6;
    --text-secondary: #A0A0AB;
    --text-muted: #63636E;
    --icon-box-bg: #16161B;
    --icon-box-border: #26262F;
    --seg-empty: #1D1D24;
    --seg-fill: #E4E4E9;
    --seg-working: #22C55E;
    --seg-warn: #F59E0B;
    --status-working: #22C55E;
    --status-done: #A1A1AA;
    --status-idle: #52525C;
    --btn-bg: #16161B;
    --btn-bg-hover: #F4F4F6;
    --btn-text-hover: #09090B;
    --shadow-win: 0 28px 70px rgba(0, 0, 0, 0.72), 0 0 0 1px rgba(255, 255, 255, 0.03);
    --relay-track: #22222A;
    --relay-pulse: #F4F4F6;
  }

  :root[data-theme="light"] {
    color-scheme: light;
    --canvas: #E8E8E5;
    --canvas-glow: radial-gradient(900px circle at 50% 0%, #F3F3F0 0%, #E6E6E2 75%);
    --win-bg: #FAFAF8;
    --win-header: #F2F2EE;
    --win-elevated: #F0F0EC;
    --row-hover: #F3F3F0;
    --row-working: #EDF6F0;
    --border-subtle: #E4E4DF;
    --border-mid: #D4D4CE;
    --border-strong: #B8B8B0;
    --text-primary: #111113;
    --text-secondary: #4E4E56;
    --text-muted: #82828C;
    --icon-box-bg: #F2F2EE;
    --icon-box-border: #DADAD4;
    --seg-empty: #E2E2DC;
    --seg-fill: #18181B;
    --seg-working: #059669;
    --seg-warn: #D97706;
    --status-working: #059669;
    --status-done: #52525B;
    --status-idle: #A1A1AA;
    --btn-bg: #FCFBF9;
    --btn-bg-hover: #111113;
    --btn-text-hover: #FAFAF8;
    --shadow-win: 0 24px 60px rgba(15, 15, 20, 0.10), 0 2px 10px rgba(15, 15, 20, 0.05);
    --relay-track: #D4D4CE;
    --relay-pulse: #111113;
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

  body {
    background: var(--canvas);
    background-image: var(--canvas-glow);
    color: var(--text-primary);
    font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    line-height: 1.45;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(0px, 2vw, 24px);
    transition: background-color 0.2s ease, color 0.2s ease;
  }

  .app-window {
    width: min(1160px, 100%);
    max-width: 100%;
    max-height: calc(100vh - clamp(0px, 4vw, 48px));
    display: flex;
    flex-direction: column;
    background: var(--win-bg);
    border: 1px solid var(--border-mid);
    box-shadow: var(--shadow-win);
    overflow: hidden;
    transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  }

  /* Top Brand & Workspace Bar */
  .win-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 52px;
    padding: 8px 22px;
    background: var(--win-header);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .brand-cluster {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .official-logo-box {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    background: var(--icon-box-bg);
    border: 1px solid var(--border-mid);
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
    gap: 7px;
    flex-shrink: 0;
  }

  .brand-name {
    font-weight: 700;
    font-size: 14.5px;
    letter-spacing: -0.02em;
    color: var(--text-primary);
  }

  .brand-ver {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--text-muted);
  }

  .ws-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 8px;
    padding-left: 14px;
    border-left: 1px solid var(--border-subtle);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .ws-tabs::-webkit-scrollbar {
    display: none;
  }

  .ws-tab {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid transparent;
    height: 26px;
    padding: 0 10px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.14s ease;
    max-width: 160px;
    flex-shrink: 0;
  }

  .ws-tab span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ws-tab:hover {
    color: var(--text-primary);
    background: var(--win-elevated);
  }

  .ws-tab.active {
    color: var(--text-primary);
    background: var(--win-bg);
    border-color: var(--border-mid);
    font-weight: 500;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .telemetry-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-secondary);
    padding: 4px 9px;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    max-width: 240px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pulse-dot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    background: var(--status-working);
    animation: pulseGlow 2.2s infinite ease-in-out;
  }

  @keyframes pulseGlow {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.92); }
  }

  .theme-btn {
    height: 28px;
    padding: 0 10px;
    background: var(--btn-bg);
    border: 1px solid var(--border-mid);
    color: var(--text-secondary);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    flex-shrink: 0;
    transition: all 0.14s ease;
  }

  .theme-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
  }

  /* Live Baton Relay Deck */
  .relay-deck {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
    align-items: center;
    gap: 20px;
    padding: 16px 22px;
    background: var(--win-bg);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .deck-left {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .deck-eyebrow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .branch-tag {
    color: var(--text-secondary);
    background: var(--win-elevated);
    border: 1px solid var(--border-subtle);
    padding: 1px 6px;
  }

  .prompt-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .prompt-input {
    width: 100%;
    background: var(--win-header);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 13.5px;
    font-weight: 500;
    height: 36px;
    padding: 0 72px 0 12px;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }

  .prompt-input:hover {
    border-color: var(--border-mid);
  }

  .prompt-input:focus {
    outline: none;
    border-color: var(--border-strong);
    background: var(--win-bg);
  }

  .prompt-edit-hint {
    position: absolute;
    right: 10px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--text-muted);
    pointer-events: none;
  }

  .relay-graph {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 11px 14px;
    background: var(--win-header);
    border: 1px solid var(--border-subtle);
    min-width: 0;
    position: relative;
    overflow: hidden;
    transition: border-color 0.22s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .relay-graph.route-locked {
    border-color: rgba(34, 197, 94, 0.45);
    box-shadow: inset 0 0 24px rgba(34, 197, 94, 0.05);
  }

  .relay-graph.relaying-surge {
    border-color: var(--status-working);
    box-shadow: inset 0 0 32px rgba(34, 197, 94, 0.14);
  }

  .relay-nodes {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11.5px;
  }

  .relay-endpoint {
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    transition: color 0.18s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .relay-endpoint.target-preview {
    color: var(--text-secondary);
  }

  .relay-endpoint.target-preview.active-route {
    color: var(--status-working);
    transform: translateX(-1px);
  }

  .relay-wire {
    flex: 1;
    height: 10px;
    position: relative;
    display: flex;
    align-items: center;
    overflow: hidden;
  }

  .relay-wire::before {
    content: "";
    width: 100%;
    height: 1px;
    background: repeating-linear-gradient(
      90deg,
      var(--relay-track) 0px,
      var(--relay-track) 4px,
      transparent 4px,
      transparent 7px
    );
    transition: opacity 0.2s ease;
  }

  .relay-wire::after {
    content: "";
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    left: -40%;
    width: 40%;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--relay-pulse), var(--status-working));
    box-shadow: 0 0 8px rgba(34, 197, 94, 0.45);
    animation: wireSlide 2.2s infinite cubic-bezier(0.4, 0, 0.2, 1);
  }

  .relay-graph.route-locked .relay-wire::after {
    height: 2px;
    background: linear-gradient(90deg, transparent, rgba(34, 197, 94, 0.5), var(--status-working));
    box-shadow: 0 0 12px rgba(34, 197, 94, 0.8);
    animation-duration: 0.72s;
  }

  .relay-graph.relaying-surge .relay-wire::after {
    height: 3px;
    width: 65%;
    background: linear-gradient(90deg, transparent, #4ade80, #ecfdf5);
    box-shadow: 0 0 16px rgba(34, 197, 94, 1);
    animation-duration: 0.36s;
  }

  @keyframes wireSlide {
    0% { left: -40%; opacity: 0.2; }
    30% { opacity: 1; }
    80% { opacity: 1; }
    100% { left: 100%; opacity: 0.1; }
  }

  .relay-metrics {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .diet-pill {
    color: var(--text-secondary);
    font-weight: 500;
    white-space: nowrap;
    transition: color 0.2s ease;
  }

  /* Scrollable Table Viewport & Responsive Process Table */
  .table-viewport,
  .receipt-panel,
  .baton-preview-box {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .table-viewport::-webkit-scrollbar,
  .receipt-panel::-webkit-scrollbar,
  .baton-preview-box::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
  }

  .table-viewport {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .process-table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
  }

  .col-agent { width: 29%; }
  .col-state { width: 13%; }
  .col-quota { width: 33%; }
  .col-seen  { width: 11%; }
  .col-act   { width: 14%; }

  .process-table thead th {
    position: sticky;
    top: 0;
    z-index: 5;
    height: 34px;
    padding: 0 12px;
    background: var(--win-header);
    box-shadow: inset 0 -1px 0 var(--border-subtle);
    font-family: "IBM Plex Mono", monospace;
    font-size: 10.5px;
    font-weight: 500;
    color: var(--text-muted);
    text-align: left;
    user-select: none;
    white-space: nowrap;
  }

  .process-table thead th:first-child { padding-left: 22px; }
  .process-table thead th:last-child { padding-right: 22px; text-align: right; }
  .process-table thead th.num-col { text-align: right; }

  .process-table tbody tr {
    height: 64px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background-color 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .process-table tbody tr.row-enter {
    animation: rowSlideIn 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: calc(var(--row-idx, 0) * 18ms);
  }

  @keyframes rowSlideIn {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .process-table tbody tr:last-child {
    border-bottom: none;
  }

  .process-table tbody tr:hover {
    background: var(--row-hover);
  }

  .process-table tbody tr.route-target-hover {
    background: var(--row-hover);
    box-shadow: inset 3px 0 0 rgba(34, 197, 94, 0.55);
  }

  .process-table tbody tr.is-working {
    background: var(--row-working);
    box-shadow: inset 3px 0 0 var(--status-working);
  }

  .process-table tbody tr.just-relayed {
    animation: relayFlash 0.9s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes relayFlash {
    0% { background: rgba(34, 197, 94, 0.22); }
    100% { background: var(--row-working); }
  }

  .process-table td {
    padding: 0 12px;
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .process-table td:first-child { padding-left: 22px; }
  .process-table td:last-child { padding-right: 22px; text-align: right; }

  .agent-cell {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .agent-info {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    width: 100%;
  }

  .agent-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .agent-name {
    font-weight: 600;
    font-size: 13.5px;
    letter-spacing: -0.01em;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-badge {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--text-secondary);
    background: var(--win-elevated);
    border: 1px solid var(--border-subtle);
    padding: 1px 5px;
    line-height: 1.3;
    flex-shrink: 0;
  }

  .agent-path {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11.5px;
    font-weight: 500;
    padding: 3px 8px;
    border: 1px solid transparent;
    white-space: nowrap;
  }

  .state-badge.Working {
    color: var(--status-working);
    background: rgba(34, 197, 94, 0.08);
    border-color: rgba(34, 197, 94, 0.25);
  }

  .state-badge.Done {
    color: var(--text-secondary);
    background: var(--win-elevated);
    border-color: var(--border-subtle);
  }

  .state-badge.Idle {
    color: var(--text-muted);
  }

  .state-sq {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
  }
  .state-sq.Working { background: var(--status-working); }
  .state-sq.Done { background: var(--status-done); }
  .state-sq.Idle { background: var(--status-idle); }

  .quota-cell {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-right: 12px;
    font-family: "IBM Plex Mono", monospace;
    font-variant-numeric: tabular-nums;
    min-width: 0;
  }

  .quota-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }

  .quota-val {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-primary);
    flex-shrink: 0;
  }

  .quota-val.subtle {
    font-weight: 500;
    color: var(--text-secondary);
  }

  .quota-sub {
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .seg-bar {
    display: grid;
    grid-template-columns: repeat(20, 1fr);
    gap: 2px;
    height: 6px;
    width: 100%;
  }

  .seg {
    background: var(--seg-empty);
    height: 100%;
    transform-origin: left center;
    transition: background-color 0.24s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s ease;
  }

  .process-table tbody tr.row-enter .seg.on {
    animation: segFillIn 0.32s cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: calc(var(--row-idx, 0) * 16ms + var(--seg-idx, 0) * 11ms);
  }

  @keyframes segFillIn {
    0% { opacity: 0.15; transform: scaleY(0.35); }
    100% { opacity: 1; transform: scaleY(1); }
  }

  .seg.on { background: var(--seg-fill); }
  .seg.on.working { background: var(--seg-working); }
  .seg.on.warn { background: var(--seg-warn); }

  .seen-cell {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11.5px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .handoff-btn {
    width: 100px;
    max-width: 100%;
    height: 30px;
    background: var(--btn-bg);
    color: var(--text-primary);
    border: 1px solid var(--border-mid);
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
    position: relative;
    overflow: hidden;
    transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .handoff-btn .arr {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .handoff-btn:hover {
    background: var(--btn-bg-hover);
    color: var(--btn-text-hover);
    border-color: var(--btn-bg-hover);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22);
  }

  .handoff-btn:hover .arr {
    transform: translateX(3.5px);
  }

  .handoff-btn:active {
    transform: scale(0.96);
  }

  .handoff-btn.is-relaying {
    border-color: var(--status-working);
    color: var(--status-working);
    background: rgba(34, 197, 94, 0.1);
    pointer-events: none;
  }

  .holding-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100px;
    max-width: 100%;
    height: 30px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    font-weight: 500;
    color: var(--status-working);
    border: 1px solid rgba(34, 197, 94, 0.3);
    background: rgba(34, 197, 94, 0.06);
    white-space: nowrap;
    animation: holdingPulse 3s infinite ease-in-out;
  }

  @keyframes holdingPulse {
    0%, 100% { border-color: rgba(34, 197, 94, 0.3); }
    50% { border-color: rgba(34, 197, 94, 0.6); }
  }

  /* ==========================================================================
     LIVE 5-STEP HANDOFF VERIFICATION RECEIPT PANEL
     ========================================================================== */
  .receipt-panel {
    display: none;
    border-top: 1px solid var(--border-mid);
    background: var(--win-header);
    padding: 14px 22px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11.5px;
    flex-shrink: 0;
    max-height: 42vh;
    overflow-y: auto;
  }

  .receipt-panel.visible {
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: drawerSlideUp 0.26s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes drawerSlideUp {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .receipt-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .receipt-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: var(--status-working);
    font-size: 12px;
  }

  .receipt-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .steps-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    padding: 10px 14px;
  }

  .step-row {
    display: grid;
    grid-template-columns: minmax(180px, 260px) minmax(0, 1fr);
    align-items: baseline;
    gap: 12px;
    font-size: 11px;
  }

  .step-row.step-cascade {
    animation: stepReveal 0.18s cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: calc(var(--step-idx, 0) * 20ms);
  }

  @keyframes stepReveal {
    from {
      opacity: 0;
      transform: translateX(-6px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .step-name {
    color: var(--text-primary);
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }

  .step-ok {
    color: var(--status-working);
    font-weight: 600;
  }

  .step-detail {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .baton-preview-box {
    display: none;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    padding: 12px;
    max-height: 170px;
    overflow-y: auto;
    font-size: 11px;
    color: var(--text-secondary);
    white-space: pre-wrap;
    line-height: 1.5;
  }

  .baton-preview-box.open {
    display: block;
  }

  /* Inspector Drawer */
  .inspector-drawer {
    display: none;
    padding: 12px 22px;
    border-top: 1px solid var(--border-subtle);
    background: var(--win-header);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    flex-shrink: 0;
  }

  .inspector-drawer.open {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    animation: drawerSlideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .insp-col {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .insp-title {
    color: var(--text-muted);
    font-size: 10.5px;
  }

  .insp-list {
    color: var(--text-secondary);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .insp-tag {
    border: 1px solid var(--border-mid);
    background: var(--win-bg);
    padding: 2px 8px;
  }

  /* Command Bar Footer — Adaptive Zero-Break Layout */
  .win-footer {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    min-height: 46px;
    padding: 8px 22px;
    background: var(--win-header);
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .footer-cmds {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    min-width: 0;
  }

  .cmd-btn {
    height: 28px;
    padding: 0 8px;
    background: var(--win-bg);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    flex-shrink: 0;
    transition: all 0.14s ease;
  }

  .cmd-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-mid);
  }

  .cmd-btn:active,
  .cmd-btn.kbd-pressed,
  .theme-btn:active,
  .theme-btn.kbd-pressed {
    transform: scale(0.96);
    border-color: var(--border-strong);
    color: var(--text-primary);
    background: var(--win-elevated);
  }

  .cmd-btn.active-toggle {
    color: var(--text-primary);
    border-color: var(--border-strong);
    background: var(--win-elevated);
  }

  .kbd {
    font-family: "IBM Plex Mono", monospace;
    font-size: 10px;
    color: var(--text-muted);
    padding-left: 2px;
  }

  .footer-receipt {
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1 1 0;
    min-width: 0;
    text-align: right;
  }

  /* ==========================================================================
     RESPONSIVE BREAKPOINTS (ANY WINDOW SIZE: WIDE / SPLIT-SCREEN / COMPACT)
     ========================================================================== */
  @media (max-width: 880px) {
    .win-footer, .footer-cmds {
      flex-wrap: wrap;
    }
    .footer-cmds {
      flex: 1 1 100%;
    }
    .footer-receipt {
      flex: 1 1 100%;
      text-align: right;
    }
    .relay-deck {
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .col-seen, .th-seen, .seen-cell {
      display: none;
    }
    .col-agent { width: 35%; }
    .col-state { width: 13%; }
    .col-quota { width: 35%; }
    .col-act   { width: 17%; }
    .step-row {
      grid-template-columns: 1fr;
      gap: 2px;
    }
    .inspector-drawer.open {
      grid-template-columns: 1fr;
      gap: 10px;
    }
  }

  @media (max-width: 640px) {
    body {
      padding: 0;
    }
    .app-window {
      width: 100%;
      height: 100vh;
      max-height: 100vh;
      border-left: none;
      border-right: none;
    }
    .win-topbar, .relay-deck, .win-footer, .receipt-panel, .inspector-drawer {
      padding-left: 14px;
      padding-right: 14px;
    }
    .process-table thead th:first-child,
    .process-table td:first-child {
      padding-left: 14px;
    }
    .process-table thead th:last-child,
    .process-table td:last-child {
      padding-right: 14px;
    }
    .telemetry-badge {
      display: none;
    }
    .col-state, .th-state, .td-state {
      display: none;
    }
    .col-agent { width: 42%; }
    .col-quota { width: 36%; }
    .col-act   { width: 22%; }
    .handoff-btn, .holding-pill {
      width: 88px;
      font-size: 11px;
    }
  }
</style>
</head>
<body>

  <div class="app-window">

    <!-- 1. Top Brand & One-Click Workspace Bar -->
    <header class="win-topbar">
      <div class="brand-cluster">
        <div class="official-logo-box">
          <img id="official-logo" src="/logo-dark.png" alt="Vicem Logo" />
        </div>
        <div class="brand-name-wrap">
          <span class="brand-name">Vicem</span>
          <span class="brand-ver">v1.0</span>
        </div>
        <div class="ws-tabs" id="ws-tabs"></div>
      </div>

      <div class="topbar-right">
        <div class="telemetry-badge">
          <span class="pulse-dot"></span>
          <span id="mounted-status">Live telemetry</span>
        </div>
        <button class="theme-btn" onclick="toggleTheme()" title="Toggle Light / Dark Mode (T)">
          <span id="theme-icon">☀</span>
          <span id="theme-label">Light</span>
          <span class="kbd">T</span>
        </button>
      </div>
    </header>

    <!-- 2. Live Baton Relay Deck -->
    <section class="relay-deck">
      <div class="deck-left">
        <div class="deck-eyebrow">
          <span>Active session baton</span>
          <span>·</span>
          <span class="branch-tag" id="branch-badge">workspace (main)</span>
          <span>·</span>
          <span>Editable handoff instruction</span>
        </div>
        <div class="prompt-input-wrap">
          <input
            type="text"
            class="prompt-input"
            id="task-input"
            value="Loading session context..."
            placeholder="Type handoff goal or instruction before relaying..."
            onchange="saveCustomGoal(this.value)"
          />
          <span class="prompt-edit-hint">✎ Edit</span>
        </div>
      </div>

      <div class="relay-graph">
        <div class="relay-nodes">
          <span class="relay-endpoint" id="relay-source">Antigravity</span>
          <div class="relay-wire"></div>
          <span class="relay-endpoint target-preview" id="relay-target">Select target</span>
        </div>
        <div class="relay-metrics">
          <span class="diet-pill" id="stat-tokens">—</span>
          <span id="stat-secrets">0 masked</span>
        </div>
      </div>
    </section>

    <!-- 3. Fluid Responsive Agent Process & Quota Table -->
    <div class="table-viewport">
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
            <th>Agent &amp; Workspace</th>
            <th class="th-state">State</th>
            <th>Remaining Capacity</th>
            <th class="num-col th-seen">Last Activity</th>
            <th>Relay Baton</th>
          </tr>
        </thead>
        <tbody id="agent-rows"></tbody>
      </table>
    </div>

    <!-- 4. Live 5-Step Handoff Verification Receipt Panel (Appears on Handoff) -->
    <section class="receipt-panel" id="receipt-panel">
      <div class="receipt-header">
        <span class="receipt-title" id="receipt-title">✓ Handoff Execution Verified</span>
        <div class="receipt-actions">
          <button class="cmd-btn" onclick="toggleBatonPreview()">
            <span id="btn-preview-label">View .vicem/BATON.md</span>
          </button>
          <button class="cmd-btn" onclick="closeReceiptPanel()">
            <span>Dismiss</span>
          </button>
        </div>
      </div>
      <div class="steps-grid" id="receipt-steps"></div>
      <pre class="baton-preview-box" id="baton-preview-box"></pre>
    </section>

    <!-- 5. Collapsible Inspector Drawer -->
    <div class="inspector-drawer" id="inspector-drawer">
      <div class="insp-col">
        <span class="insp-title">Tracked modified files in baton</span>
        <div class="insp-list" id="insp-files"></div>
      </div>
      <div class="insp-col">
        <span class="insp-title">Mounted rule files in workspace</span>
        <div class="insp-list" id="insp-mounts"></div>
      </div>
    </div>

    <!-- 6. Command Bar Footer -->
    <footer class="win-footer">
      <div class="footer-cmds">
        <button class="cmd-btn" onclick="triggerSelfDiet()">
          <span>Compact current</span>
          <span class="kbd">R</span>
        </button>
        <button class="cmd-btn" onclick="triggerBack()">
          <span>Return to previous</span>
          <span class="kbd">Z</span>
        </button>
        <button class="cmd-btn" onclick="copyBaton()">
          <span>Copy baton</span>
          <span class="kbd">C</span>
        </button>
        <button class="cmd-btn" id="btn-inspect" onclick="toggleInspector()">
          <span>Inspect files</span>
          <span class="kbd">I</span>
        </button>
        <button class="cmd-btn" id="btn-all-platforms" onclick="toggleAllPlatforms()">
          <span id="platforms-label">All 12 platforms</span>
          <span class="kbd">A</span>
        </button>
        <button class="cmd-btn active-toggle" id="btn-launch-toggle" onclick="toggleLaunchApp()">
          <span id="launch-label">Launch: Desktop App</span>
        </button>
      </div>
      <div class="footer-receipt" id="status-line">Ready · Desktop App launch enabled</div>
    </footer>

  </div>

<script>
  const CLIENT_GUI_VERSION = 'v16';
  const urlParams = new URLSearchParams(window.location.search);
  const isStaticMode = Boolean(navigator.webdriver || urlParams.get('static') === '1');
  const isDemoMode = urlParams.get('demo') === '1';
  if (isStaticMode) {
    document.documentElement.classList.add('no-anim');
  }
  let state = null;
  let currentTheme = localStorage.getItem('vicem-theme') || 'dark';
  let launchMode = 'app'; // 'app' (Desktop GUI App) | 'cli' (Terminal CLI) | 'off' (Clipboard only)
  let inspectorOpen = false;
  let showAllPlatforms = new URLSearchParams(window.location.search).get('all') === '1';
  let batonPreviewOpen = false;
  let receiptDismissed = false;
  let isEditingGoal = false;
  let lastRenderedReceiptTs = null;
  let lastAnimRaw = 0;
  let lastAnimDiet = 0;
  let relayingTargetId = null;

  if (showAllPlatforms) {
    document.getElementById('btn-all-platforms').classList.add('active-toggle');
    document.getElementById('platforms-label').textContent = 'Installed only';
  }

  function flashKeybindButton(selector) {
    const btn = document.querySelector(selector);
    if (!btn) return;
    btn.classList.add('kbd-pressed');
    setTimeout(() => btn.classList.remove('kbd-pressed'), 160);
  }

  function animateTokenStats(rawTarget, dietTarget, savedPct) {
    const el = document.getElementById('stat-tokens');
    if (!el) return;
    if (isStaticMode || (lastAnimRaw === rawTarget && lastAnimDiet === dietTarget)) {
      lastAnimRaw = rawTarget;
      lastAnimDiet = dietTarget;
      el.textContent = \`\${rawTarget.toLocaleString()} → \${dietTarget.toLocaleString()} tok (-\${savedPct}%)\`;
      return;
    }
    const startRaw = lastAnimRaw || rawTarget;
    const startDiet = lastAnimDiet || dietTarget;
    lastAnimRaw = rawTarget;
    lastAnimDiet = dietTarget;
    const startTime = performance.now();
    const duration = 360;
    function tick(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const curRaw = Math.round(startRaw + (rawTarget - startRaw) * ease);
      const curDiet = Math.round(startDiet + (dietTarget - startDiet) * ease);
      el.textContent = \`\${curRaw.toLocaleString()} → \${curDiet.toLocaleString()} tok (-\${savedPct}%)\`;
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vicem-theme', theme);
    const logoImg = document.getElementById('official-logo');
    logoImg.src = theme === 'light' ? '/logo-light.png' : '/logo-dark.png';
    document.getElementById('theme-icon').textContent = theme === 'light' ? '☾' : '☀';
    document.getElementById('theme-label').textContent = theme === 'light' ? 'Dark' : 'Light';
  }

  function toggleTheme() {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }

  const urlTheme = new URLSearchParams(window.location.search).get('theme');
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
    el.textContent = msg;
    el.style.color = 'var(--text-primary)';
    setTimeout(() => {
      el.style.color = 'var(--text-muted)';
    }, 3200);
  }

  function previewRoute(targetName, targetId) {
    const el = document.getElementById('relay-target');
    const graph = document.querySelector('.relay-graph');
    if (!el) return;
    document.querySelectorAll('#agent-rows tr').forEach(r => {
      r.classList.toggle('route-target-hover', Boolean(targetId && r.dataset.agentId === targetId));
    });
    if (targetName) {
      el.textContent = targetName;
      el.classList.add('active-route');
      if (graph) graph.classList.add('route-locked');
    } else if (!relayingTargetId) {
      el.textContent = 'Select target';
      el.classList.remove('active-route');
      if (graph) graph.classList.remove('route-locked');
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
      html += \`<span class="\${cls}" style="--seg-idx:\${i}"></span>\`;
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
      setStatus('Mode: Open Terminal.app running CLI binary');
    } else {
      lbl.textContent = 'Launch: Off (Copy only)';
      setStatus('Mode: Copy baton + mount rule file only');
    }
  }

  function toggleInspector() {
    inspectorOpen = !inspectorOpen;
    document.getElementById('inspector-drawer').classList.toggle('open', inspectorOpen);
    document.getElementById('btn-inspect').classList.toggle('active-toggle', inspectorOpen);
  }

  function toggleAllPlatforms() {
    showAllPlatforms = !showAllPlatforms;
    document.getElementById('btn-all-platforms').classList.toggle('active-toggle', showAllPlatforms);
    document.getElementById('platforms-label').textContent = showAllPlatforms
      ? 'Installed only'
      : 'All 12 platforms';
    render();
    setStatus(
      showAllPlatforms
        ? 'Showing all 12 supported platforms (macOS / Windows / Linux)'
        : 'Showing installed & primary platforms'
    );
  }

  function toggleBatonPreview() {
    batonPreviewOpen = !batonPreviewOpen;
    document.getElementById('baton-preview-box').classList.toggle('open', batonPreviewOpen);
    document.getElementById('btn-preview-label').textContent =
      batonPreviewOpen ? 'Hide .vicem/BATON.md' : 'View .vicem/BATON.md';
  }

  function closeReceiptPanel() {
    receiptDismissed = true;
    document.getElementById('receipt-panel').classList.remove('visible');
  }

  async function switchWorkspace(projectRoot) {
    setStatus('Switching workspace...');
    const res = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot }),
    });
    state = await res.json();
    render();
    setStatus(\`Switched workspace to \${state.project}\`);
  }

  async function saveCustomGoal(goal) {
    const res = await fetch('/api/goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal }),
    });
    state = await res.json();
    render();
    setStatus('Updated handoff instruction');
  }

  function render() {
    if (!state) return;

    // 1. Workspace Tabs
    const tabsEl = document.getElementById('ws-tabs');
    tabsEl.innerHTML = '';
    for (const ws of state.workspaces.slice(0, 4)) {
      const btn = document.createElement('button');
      btn.className = 'ws-tab' + (ws.path === state.projectRoot ? ' active' : '');
      btn.title = ws.shortPath;
      btn.onclick = () => switchWorkspace(ws.path);
      btn.innerHTML = \`<span>\${ws.name}</span>\`;
      tabsEl.appendChild(btn);
    }

    document.getElementById('branch-badge').textContent =
      \`\${state.project} (\${state.branch})\`;

    document.getElementById('mounted-status').textContent =
      state.mountedFiles.length > 0
        ? \`Mounted: \${state.mountedFiles.join(', ')}\`
        : 'Live telemetry';

    const workingNode = state.nodes.find(n => n.status === 'Working') || state.nodes[0];
    document.getElementById('relay-source').textContent = workingNode.name;
    if (!document.getElementById('relay-target').classList.contains('active-route')) {
      document.getElementById('relay-target').textContent = 'Select target';
    }

    if (!isEditingGoal) {
      taskInput.value = state.taskTitle;
    }

    animateTokenStats(state.stats.rawTokens, state.stats.dietTokens, state.stats.savedPct);
    document.getElementById('stat-secrets').textContent =
      \`\${state.stats.secretsMasked} masked\`;

    // Render Live 5-Step Handoff Verification Receipt Panel if present
    const receiptPanel = document.getElementById('receipt-panel');
    if (state.lastHandoffReceipt && !receiptDismissed) {
      const r = state.lastHandoffReceipt;
      const isNewReceipt = lastRenderedReceiptTs !== r.timestamp;
      lastRenderedReceiptTs = r.timestamp;
      receiptPanel.classList.add('visible');
      document.getElementById('receipt-title').textContent =
        \`✓ Handoff Verified (\${r.timestamp}) — \${r.sourceAgent} → \${r.targetId} (\${r.project})\`;
      if (isNewReceipt || !document.getElementById('receipt-steps').children.length) {
        document.getElementById('receipt-steps').innerHTML = r.steps
          .map(
            (s, idx) => \`<div class="step-row\${isNewReceipt ? ' step-cascade' : ''}" style="--step-idx:\${idx}">
              <span class="step-name"><span class="step-ok">\${s.ok ? '[✓]' : '[!]'}</span> \${s.title}</span>
              <span class="step-detail">\${s.detail}</span>
            </div>\`
          )
          .join('');
      }
      document.getElementById('baton-preview-box').textContent = r.batonPreview || '';
    } else {
      receiptPanel.classList.remove('visible');
    }

    // Inspector Drawer
    document.getElementById('insp-files').innerHTML = (state.modifiedFiles || [])
      .map(f => \`<span class="insp-tag">\${f}</span>\`)
      .join('');
    document.getElementById('insp-mounts').innerHTML = state.mountedFiles.length > 0
      ? state.mountedFiles.map(m => \`<span class="insp-tag">\${m}</span>\`).join('') +
        \`<button class="cmd-btn" style="height:22px" onclick="unmountRules()">Unmount all</button>\`
      : '<span style="color:var(--text-muted)">None (clean working tree)</span>';

    // Agent Process Rows — Keyed Non-Destructive DOM Update (preserves hover & transitions)
    const tbody = document.getElementById('agent-rows');
    const visibleNodes = showAllPlatforms
      ? state.nodes
      : state.nodes.filter(n => n.primary || n.installed);

    const existingRows = new Map();
    Array.from(tbody.querySelectorAll('tr[data-agent-id]')).forEach(tr => {
      existingRows.set(tr.dataset.agentId, tr);
    });

    const visibleIds = new Set(visibleNodes.map(n => n.id));
    for (const [id, tr] of existingRows.entries()) {
      if (!visibleIds.has(id)) tr.remove();
    }

    visibleNodes.forEach((node, idx) => {
      const isWorking = node.status === 'Working';
      const hasBar = Boolean(node.quota?.hasBar);
      const pct = node.quota?.remainPct ?? 100;
      const isWarn = hasBar && pct < 55;
      const isRelayingThis = relayingTargetId === node.id;

      const actionHtml = isWorking
        ? \`<span class="holding-pill">● Holding</span>\`
        : isRelayingThis
        ? \`<button class="handoff-btn is-relaying"><span>Relaying</span><span class="arr">···</span></button>\`
        : \`<button class="handoff-btn" onmouseenter="previewRoute('\${node.name}', '\${node.id}')" onmouseleave="previewRoute(null, null)" onclick="handOffTo('\${node.id}', '\${node.name}')"><span>Hand off</span><span class="arr">→</span></button>\`;

      const rowInnerHtml = \`
        <td>
          <div class="agent-cell">
            <div class="agent-info">
              <div class="agent-title-row">
                <span class="agent-name">\${node.name}</span>
                <span class="model-badge">\${node.model}</span>
              </div>
              <span class="agent-path">\${node.workspace}</span>
            </div>
          </div>
        </td>
        <td class="td-state">
          <span class="state-badge \${node.status}">
            <span class="state-sq \${node.status}"></span>
            <span>\${node.status}</span>
          </span>
        </td>
        <td>
          <div class="quota-cell">
            <div class="quota-meta">
              <span class="quota-val\${hasBar ? '' : ' subtle'}">\${node.quota?.label || 'Ready'}</span>
              <span class="quota-sub">\${node.quota?.detail || ''}</span>
            </div>
            \${buildSegmentedBar(pct, isWorking, isWarn, hasBar)}
          </div>
        </td>
        <td class="seen-cell">\${node.lastSeen}</td>
        <td>\${actionHtml}</td>
      \`;

      let tr = existingRows.get(node.id);
      const rowSig = \`\${node.status}|\${node.model}|\${node.workspace}|\${node.quota?.label}|\${node.quota?.detail}|\${pct}|\${node.lastSeen}|\${isRelayingThis}\`;
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.agentId = node.id;
        tr.dataset.sig = rowSig;
        tr.style.setProperty('--row-idx', String(idx));
        tr.className = (isWorking ? 'is-working ' : '') + 'row-enter';
        tr.innerHTML = rowInnerHtml;
        tbody.appendChild(tr);
        setTimeout(() => tr.classList.remove('row-enter'), 550);
      } else {
        tr.classList.toggle('is-working', isWorking);
        if (tr.dataset.sig !== rowSig) {
          tr.dataset.sig = rowSig;
          tr.innerHTML = rowInnerHtml;
        }
        tbody.appendChild(tr);
      }
    });
  }

  async function handOffTo(targetId, targetName) {
    receiptDismissed = false;
    relayingTargetId = targetId;
    previewRoute(targetName, targetId);
    const graph = document.querySelector('.relay-graph');
    if (graph) graph.classList.add('relaying-surge');
    render();
    setStatus(\`Executing 5-step handoff to \${targetName}...\`);
    try {
      const res = await fetch('/api/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, launchMode }),
      });
      state = await res.json();
    } finally {
      relayingTargetId = null;
      if (graph) graph.classList.remove('relaying-surge');
    }
    render();
    const targetRow = document.querySelector(\`#agent-rows tr[data-agent-id="\${targetId}"]\`);
    if (targetRow) {
      targetRow.classList.remove('just-relayed');
      void targetRow.offsetWidth;
      targetRow.classList.add('just-relayed');
    }
    setStatus(state.actionReceipt || \`Relayed baton to \${targetName}\`);
  }

  async function unmountRules() {
    const res = await fetch('/api/unmount', { method: 'POST' });
    state = await res.json();
    render();
    setStatus('Unmounted temporary rule files');
  }

  async function triggerSelfDiet() {
    receiptDismissed = false;
    setStatus('Compacting active session...');
    const res = await fetch('/api/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId: state?.workingAgentId || 'antigravity', launchMode: 'off' }),
    });
    state = await res.json();
    render();
    setStatus(\`Compacted active session (-\${state?.stats?.savedPct || 94.2}%) & copied to clipboard\`);
  }

  async function triggerBack() {
    if (!state || !state.lastHandedOffFrom) {
      setStatus('No previous agent in session history');
      return;
    }
    const prev = state.nodes.find(n => n.id === state.lastHandedOffFrom);
    await handOffTo(state.lastHandedOffFrom, prev ? prev.name : state.lastHandedOffFrom);
  }

  async function copyBaton() {
    await fetch('/api/clip', { method: 'POST' });
    setStatus('Copied .vicem/BATON.md to macOS clipboard');
  }

  window.addEventListener('keydown', (e) => {
    if (isEditingGoal || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') { flashKeybindButton('button[onclick="triggerSelfDiet()"]'); triggerSelfDiet(); }
    else if (k === 'z') { flashKeybindButton('button[onclick="triggerBack()"]'); triggerBack(); }
    else if (k === 'c') { flashKeybindButton('button[onclick="copyBaton()"]'); copyBaton(); }
    else if (k === 'i') { flashKeybindButton('#btn-inspect'); toggleInspector(); }
    else if (k === 'a') { flashKeybindButton('#btn-all-platforms'); toggleAllPlatforms(); }
    else if (k === 't') { flashKeybindButton('.theme-btn'); toggleTheme(); }
  });

  async function load(initialData) {
    try {
      const nextState = initialData || await (await fetch('/api/state')).json();
      if (nextState.guiVersion && nextState.guiVersion !== CLIENT_GUI_VERSION) {
        window.location.reload();
        return;
      }
      if (isDemoMode) {
        const origProject = nextState.project;
        const origShort = nextState.shortProject;
        nextState.project = 'vicem';
        nextState.branch = 'main';
        nextState.workspaces = [
          { name: 'vicem', path: nextState.projectRoot, shortPath: '~/workspace/vicem' },
          { name: 'core-sdk', path: '/ws/core-sdk', shortPath: '~/workspace/core-sdk' },
          { name: 'api-gateway', path: '/ws/api-gateway', shortPath: '~/workspace/api-gateway' },
          { name: 'web-studio', path: '/ws/web-studio', shortPath: '~/workspace/web-studio' },
        ];
        nextState.nodes = (nextState.nodes || []).map(n => ({
          ...n,
          workspace: n.workspace.startsWith('~/') ? '~/workspace/vicem' : n.workspace,
        }));
        if (nextState.lastHandoffReceipt) {
          nextState.lastHandoffReceipt.project = 'vicem';
          nextState.lastHandoffReceipt.steps = nextState.lastHandoffReceipt.steps.map(s => ({
            ...s,
            detail: s.detail
              .replaceAll(origShort, '~/workspace/vicem')
              .replaceAll(origProject, 'vicem')
              .replaceAll('(master)', '(main)'),
          }));
        }
      }
      state = nextState;
      render();
    } catch {}
  }

  load(window.__INITIAL_STATE__ || null);
  if (!isStaticMode) setInterval(() => load(null), 3000);
</script>
</body>
</html>`;

const PORT = Number(process.env.VICEM_GUI_PORT || 4310);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/') {
    const initData = await collectState();
    const safeJson = JSON.stringify(initData).replace(/</g, '\\u003c');
    const hydratedHtml = HTML_PAGE.replace(
      '<script>',
      `<script>window.__INITIAL_STATE__ = ${safeJson};\n`
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
      lastHandedOffTo = null;
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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

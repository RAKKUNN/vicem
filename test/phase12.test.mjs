import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  GitHookInstaller,
  DoctorDiagnostics,
  padDisplayColumn,
  getDisplayWidth,
  VicemApp,
} from '../vicem.mjs';

test('Phase 12 - TC-ADV-06 (Fix 12-A): Worktree-safe idempotent Git pre-commit hook installer (`vicem init` / `vicem init --uninstall`) preserves existing hooks and restores 0-byte diff', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p12-hook-'));
  try {
    // 1. Standard .git repository with pre-existing Husky/lint-staged hook
    const repoDir = path.join(tmpDir, 'repo');
    const hooksDir = path.join(repoDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const huskyHook = `#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
`;
    const hookFile = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hookFile, huskyHook, { mode: 0o755 });

    // Run `vicem init` twice to verify idempotence
    const out1 = [];
    await VicemApp.run(['init'], {
      projectRoot: repoDir,
      stdout: { write: (s) => out1.push(s) },
    });
    await VicemApp.run(['init'], {
      projectRoot: repoDir,
      stdout: { write: (s) => out1.push(s) },
    });

    const afterInstall = fs.readFileSync(hookFile, 'utf8');
    assert.ok(afterInstall.includes('npx lint-staged'), 'Must preserve pre-existing Husky hook');
    assert.ok(
      afterInstall.includes(GitHookInstaller.HOOK_START),
      'Must include VICEM-GUARD-HOOK-START marker'
    );
    // Count occurrences of HOOK_START to ensure idempotence (must be 1, not 2)
    const countMarkers = afterInstall.split(GitHookInstaller.HOOK_START).length - 1;
    assert.equal(countMarkers, 1, 'Running `vicem init` multiple times must be 100% idempotent');

    // Check executable permission bit
    const mode = fs.statSync(hookFile).mode & 0o111;
    assert.ok(mode !== 0, 'pre-commit hook must have executable permission (0o755)');

    // Run `vicem init --uninstall` and verify 0-byte diff against original huskyHook
    await VicemApp.run(['init', '--uninstall'], {
      projectRoot: repoDir,
      stdout: { write: (s) => out1.push(s) },
    });

    const afterUninstall = fs.readFileSync(hookFile, 'utf8');
    assert.equal(
      afterUninstall,
      huskyHook,
      '`vicem init --uninstall` must restore pre-existing hook with 0-byte diff'
    );

    // 2. Git Worktree repository (`.git` is a file pointing to `gitdir: .../worktrees/wt1` with `commondir`)
    const wtDir = path.join(tmpDir, 'worktree-wt1');
    const gitWorktreeMetaDir = path.join(repoDir, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtDir, { recursive: true });
    fs.mkdirSync(gitWorktreeMetaDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: ${gitWorktreeMetaDir}\n`);
    fs.writeFileSync(path.join(gitWorktreeMetaDir, 'commondir'), '../..\n');

    const wtInstall = GitHookInstaller.install(wtDir);
    assert.ok(wtInstall.installed, 'Must install hook inside a Git Worktree');
    assert.equal(
      fs.realpathSync(wtInstall.hookPath),
      fs.realpathSync(hookFile),
      'Worktree hook must resolve to the common .git/hooks/pre-commit'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 12 - TC-ADV-07 (Fix 12-B): Zero-spawn `<50ms` `vicem doctor` diagnostics & CJK-aware column padding', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p12-doc-'));
  try {
    const fakeBinDir = path.join(tmpDir, 'bin');
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.codex', 'sessions'), { recursive: true });

    // Create dummy executable `claude` and `codex` in fakeBinDir
    for (const name of ['claude', 'codex']) {
      const p = path.join(fakeBinDir, name);
      fs.writeFileSync(p, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    }

    const out = [];
    const env = {
      ...process.env,
      PATH: fakeBinDir,
      HOME: fakeHome,
      NO_COLOR: '1',
    };

    const res = await VicemApp.run(['doctor'], {
      projectRoot: tmpDir,
      env,
      stdout: { write: (s) => out.push(s) },
    });

    assert.equal(res.exitCode, 0);
    assert.ok(
      res.diagnostics.elapsedMs < 50,
      `Doctor diagnostics must finish in < 50ms (took ${res.diagnostics.elapsedMs}ms)`
    );

    const claudeCheck = res.diagnostics.agentChecks.find((a) => a.id === 'claude');
    const codexCheck = res.diagnostics.agentChecks.find((a) => a.id === 'codex');
    assert.ok(claudeCheck.binFound && claudeCheck.hasStorage, 'Must detect claude binary and storage');
    assert.ok(codexCheck.binFound && codexCheck.hasStorage, 'Must detect codex binary and storage');

    // Verify CJK display column alignment
    const colAscii = padDisplayColumn('Claude Code', 16);
    const colFullWidth = padDisplayColumn('\ud074\ub85c\ub4dc \ucf54\ub4dc', 16); // 5 full-width chars * 2 + 1 space = 11 display cols -> +5 spaces
    assert.equal(
      getDisplayWidth(colAscii),
      16,
      'ASCII padded column must have display width 16'
    );
    assert.equal(
      getDisplayWidth(colFullWidth),
      16,
      'Full-width CJK padded column must have exact display width 16'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

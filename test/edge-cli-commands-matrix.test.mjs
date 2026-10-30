import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';
import {
  VicemApp,
  FuzzyTargetMatcher,
  SmartInferenceEngine,
  DeterministicTaskExtractor,
  BatonIaBuilder,
  UxFormatter,
  SessionHistoryStack,
  CliLauncherAdapter,
  RuleMountAdapter,
  ClipboardAdapter,
  UrlPrefillAdapter,
  QuotaRadar,
  TtySanitizer,
  PtyStreamInspector,
  PtyWrapController,
  DoctorDiagnostics,
  ClaudeHarvester,
  CodexHarvester,
  GeminiHarvester,
  AiderHarvester,
  AntigravityHarvester,
  CursorHarvester,
  VSCodeCopilotHarvester,
  ClineHarvester,
  OpenCodeHarvester,
  WebExportHarvester,
  encodeClaudeProjectDir,
  getGeminiProjectHash,
} from '../vicem.mjs';

function makeTmpDir(prefix = 'vicem-cli-matrix-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCaptureStream() {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      cb();
    },
  });
  return {
    stream,
    getOutput: () => buf,
  };
}

// ============================================================================
// SECTION 1: Exhaustive FuzzyTargetMatcher Canonical, Alias, Typo & False-Positive Matrix
// ============================================================================

const FUZZY_MATCH_MATRIX = [
  // 13 Canonical exact matches
  { input: 'codex', expected: 'codex', via: 'exact', dist: 0 },
  { input: 'claude', expected: 'claude', via: 'exact', dist: 0 },
  { input: 'gemini', expected: 'gemini', via: 'exact', dist: 0 },
  { input: 'antigravity', expected: 'antigravity', via: 'exact', dist: 0 },
  { input: 'vscode', expected: 'vscode', via: 'exact', dist: 0 },
  { input: 'cursor', expected: 'cursor', via: 'exact', dist: 0 },
  { input: 'windsurf', expected: 'windsurf', via: 'exact', dist: 0 },
  { input: 'cline', expected: 'cline', via: 'exact', dist: 0 },
  { input: 'aider', expected: 'aider', via: 'exact', dist: 0 },
  { input: 'opencode', expected: 'opencode', via: 'exact', dist: 0 },
  { input: 'goose', expected: 'goose', via: 'exact', dist: 0 },
  { input: 'web', expected: 'web', via: 'exact', dist: 0 },
  { input: 'self', expected: 'self', via: 'exact', dist: 0 },

  // Explicit aliases
  { input: 'cdx', expected: 'codex', via: 'alias', dist: 0 },
  { input: 'cx', expected: 'codex', via: 'alias', dist: 0 },
  { input: 'openai', expected: 'codex', via: 'alias', dist: 0 },
  { input: 'cld', expected: 'claude', via: 'alias', dist: 0 },
  { input: 'cc', expected: 'claude', via: 'alias', dist: 0 },
  { input: 'anthropic', expected: 'claude', via: 'alias', dist: 0 },
  { input: 'agy', expected: 'antigravity', via: 'alias', dist: 0 },
  { input: 'anti', expected: 'antigravity', via: 'alias', dist: 0 },
  { input: 'ide', expected: 'antigravity', via: 'alias', dist: 0 },
  { input: 'vsc', expected: 'vscode', via: 'alias', dist: 0 },
  { input: 'code', expected: 'vscode', via: 'alias', dist: 0 },
  { input: 'copilot', expected: 'vscode', via: 'alias', dist: 0 },
  { input: 'cur', expected: 'cursor', via: 'alias', dist: 0 },
  { input: 'ws', expected: 'windsurf', via: 'alias', dist: 0 },
  { input: 'wind', expected: 'windsurf', via: 'alias', dist: 0 },
  { input: 'gem', expected: 'gemini', via: 'alias', dist: 0 },
  { input: 'chat', expected: 'web', via: 'alias', dist: 0 },
  { input: 'chatgpt', expected: 'web', via: 'alias', dist: 0 },
  { input: 'browser', expected: 'web', via: 'alias', dist: 0 },

  // Fuzzy Levenshtein matches (edit distance 1 or 2)
  { input: 'claud', expected: 'claude', via: 'fuzzy', dist: 1 },
  { input: 'cluade', expected: 'claude', via: 'fuzzy', dist: 2 },
  { input: 'codexx', expected: 'codex', via: 'fuzzy', dist: 1 },
  { input: 'codx', expected: 'codex', via: 'fuzzy', dist: 1 },
  { input: 'gemni', expected: 'gemini', via: 'fuzzy', dist: 1 },
  { input: 'cursr', expected: 'cursor', via: 'fuzzy', dist: 1 },
  { input: 'windsrff', expected: 'windsurf', via: 'fuzzy', dist: 2 },
  { input: 'antigravty', expected: 'antigravity', via: 'fuzzy', dist: 1 },
  { input: 'aidr', expected: 'aider', via: 'fuzzy', dist: 1 },
  { input: 'opencod', expected: 'opencode', via: 'fuzzy', dist: 1 },

  // Short-string false-positive immunity (must NOT match 'web' or any target)
  { input: 'cat', expected: null, via: 'none' },
  { input: 'git', expected: null, via: 'none' },
  { input: 'foo', expected: null, via: 'none' },
  { input: 'bar', expected: null, via: 'none' },
  { input: 'npm', expected: null, via: 'none' },
  { input: 'wet', expected: null, via: 'none' },
  { input: 'we', expected: null, via: 'none' },
  { input: 'unknown-agent-xyz', expected: null, via: 'none' },
  { input: '', expected: null, via: 'none' },
  { input: '   ', expected: null, via: 'none' },
];

for (const tc of FUZZY_MATCH_MATRIX) {
  test(`CLI Matrix [FuzzyTargetMatcher]: input="${tc.input}" -> matched=${tc.expected} (${tc.via})`, () => {
    const res = FuzzyTargetMatcher.match(tc.input);
    assert.equal(res.matched, tc.expected);
    assert.equal(res.via, tc.via);
    if (typeof tc.dist === 'number') {
      assert.equal(res.distance, tc.dist);
    }
  });
}

// ============================================================================
// SECTION 2: VicemApp.parseCliArgs Flag & Positional Parsing Matrix
// ============================================================================

const CLI_ARGS_MATRIX = [
  {
    name: 'default empty args',
    argv: [],
    expectedPositional: [],
    expectedFlags: {
      budgetTokens: 4000,
      headless: false,
      dryRun: false,
      uninstall: false,
      help: false,
      profile: null,
      role: null,
    },
  },
  {
    name: 'space-separated flags (--budget 2500 --profile /tmp/prof --role reviewer)',
    argv: ['codex', '--budget', '2500', '--profile', '/tmp/prof', '--role', 'reviewer', '--headless', '--dry-run'],
    expectedPositional: ['codex'],
    expectedFlags: {
      budgetTokens: 2500,
      headless: true,
      dryRun: true,
      uninstall: false,
      help: false,
      profile: '/tmp/prof',
      role: 'reviewer',
    },
  },
  {
    name: 'equals-separated flags (--budget=6000 --profile=/custom --role=builder)',
    argv: ['--budget=6000', '--profile=/custom', '--role=builder', 'claude'],
    expectedPositional: ['claude'],
    expectedFlags: {
      budgetTokens: 6000,
      headless: false,
      dryRun: false,
      uninstall: false,
      help: false,
      profile: '/custom',
      role: 'builder',
    },
  },
  {
    name: 'invalid or negative --budget clamps to 4000 default',
    argv: ['--budget=-500', 'cursor'],
    expectedPositional: ['cursor'],
    expectedFlags: {
      budgetTokens: 4000,
      headless: false,
      dryRun: false,
      uninstall: false,
      help: false,
      profile: null,
      role: null,
    },
  },
  {
    name: '--mcp flag unshifts mcp positional command',
    argv: ['--mcp'],
    expectedPositional: ['mcp'],
    expectedFlags: {
      budgetTokens: 4000,
      headless: false,
      dryRun: false,
      uninstall: false,
      help: false,
      profile: null,
      role: null,
    },
  },
  {
    name: '-h and --uninstall flags',
    argv: ['init', '--uninstall', '-h'],
    expectedPositional: ['init'],
    expectedFlags: {
      budgetTokens: 4000,
      headless: false,
      dryRun: false,
      uninstall: true,
      help: true,
      profile: null,
      role: null,
    },
  },
];

for (const tc of CLI_ARGS_MATRIX) {
  test(`CLI Matrix [VicemApp.parseCliArgs]: ${tc.name}`, () => {
    const parsed = VicemApp.parseCliArgs(tc.argv);
    assert.deepEqual(parsed.positional, tc.expectedPositional);
    assert.deepEqual(parsed.flags, tc.expectedFlags);
  });
}

// ============================================================================
// SECTION 3: End-to-End VicemApp.run Subcommand Execution Matrix (All 22 Commands)
// ============================================================================

test('CLI Matrix [VicemApp.run]: full lifecycle across help, init, doctor, diet, harvest, handoff, mount, unmount, clip, export-team, fan-out, fan-in, build, review, back, rollback, resume, land, studio, gui, guard', async () => {
  const tmpDir = makeTmpDir('vicem-e2e-cli-');
  const fakeHome = makeTmpDir('vicem-e2e-home-');
  try {
    // Initialize fake git repo structure & sample code file
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'engine.ts'),
      [
        'export function computeScore(items: number[]): number {',
        '  let sum = 0;',
        '  for (const n of items) sum += n;',
        '  return sum;',
        '}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<!doctype html><html><head><title>Studio</title></head><body><script id="vicem-live-state"></script></body></html>'
    );

    // Seed a Claude Code session for this projectRoot
    const claudeProjDir = path.join(fakeHome, '.claude', 'projects', encodeClaudeProjectDir(tmpDir));
    fs.mkdirSync(claudeProjDir, { recursive: true });
    const sessionFile = path.join(claudeProjDir, 'sess-e2e-100.jsonl');
    const events = [
      { type: 'user', sessionId: 'sess-e2e-100', message: { content: 'Implement score normalization in src/engine.ts' } },
      {
        type: 'assistant',
        sessionId: 'sess-e2e-100',
        message: {
          content: [
            { type: 'text', text: 'I updated computeScore.\nImmediate NEXT:\n1. Add empty array guard\n2. Write unit tests' },
          ],
        },
      },
    ];
    fs.writeFileSync(sessionFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const baseEnv = { ...process.env, HOME: fakeHome, NO_COLOR: '1' };

    // 1. --help
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['--help'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.mode, 'help');
      assert.ok(cap.getOutput().includes('Usage (Tier 1'));
    }

    // 2. vicem init & vicem init --uninstall
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['init'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.mode, 'init');
      assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit')));

      const unCap = makeCaptureStream();
      const unRes = await VicemApp.run(['init', '--uninstall'], { projectRoot: tmpDir, env: baseEnv, stdout: unCap.stream });
      assert.equal(unRes.exitCode, 0);
      assert.equal(unRes.mode, 'init-uninstall');
    }

    // 3. vicem doctor
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['doctor'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.mode, 'doctor');
      assert.ok(cap.getOutput().includes('Vicem Doctor Diagnostics'));
      assert.equal(res.diagnostics.agentChecks.length, 8);
    }

    // 4. vicem harvest
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['harvest'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.mode, 'harvest');
      assert.equal(res.sourceAgent, 'claude');
      assert.match(res.task.goal, /Implement score normalization/);
    }

    // 5. vicem diet
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['diet', '--budget=3000'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.mode, 'diet');
      assert.ok(cap.getOutput().includes('[OK] [Vicem]'));
    }

    // 6. vicem codex --dry-run (CLI target handoff)
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['codex', '--dry-run'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.mode, 'handoff');
      assert.equal(res.sourceAgent, 'claude');
      assert.equal(res.targetAgent, 'codex');
      assert.ok(fs.existsSync(path.join(tmpDir, '.vicem', 'BATON.md')));
      assert.ok(fs.existsSync(path.join(tmpDir, '.vicem', 'baton.json')));
    }

    // 7. vicem cursor --dry-run (IDE target handoff mounts .cursorrules)
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['cursor', '--dry-run'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.targetAgent, 'cursor');
      assert.equal(res.deliveryInfo.channel, 'ide_mount');
      assert.equal(res.deliveryInfo.mountedFile, '.cursorrules');
      assert.ok(fs.existsSync(path.join(tmpDir, '.cursorrules')));
    }

    // 8. vicem web --dry-run (Web target handoff)
    {
      const cap = makeCaptureStream();
      const res = await VicemApp.run(['web', '--dry-run'], { projectRoot: tmpDir, env: baseEnv, stdout: cap.stream });
      assert.equal(res.exitCode, 0);
      assert.equal(res.targetAgent, 'web');
      assert.ok(res.deliveryInfo.url.startsWith('https://chatgpt.com/'));
    }

    // 9. vicem build codex --dry-run & vicem review claude --dry-run (Role framing)
    {
      const capBuild = makeCaptureStream();
      const buildRes = await VicemApp.run(['build', 'codex', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capBuild.stream,
      });
      assert.equal(buildRes.exitCode, 0);
      assert.ok(buildRes.baton.markdown.includes('| Role: BUILDER'));

      const capRev = makeCaptureStream();
      const revRes = await VicemApp.run(['review', 'claude', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capRev.stream,
      });
      assert.equal(revRes.exitCode, 0);
      assert.ok(revRes.baton.markdown.includes('| Role: REVIEWER'));
    }

    // 10. vicem mount windsurf & vicem unmount
    {
      const capMount = makeCaptureStream();
      const mRes = await VicemApp.run(['mount', 'windsurf'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capMount.stream,
      });
      assert.equal(mRes.exitCode, 0);
      assert.ok(fs.existsSync(path.join(tmpDir, '.windsurfrules')));

      const capUnmount = makeCaptureStream();
      const uRes = await VicemApp.run(['unmount'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capUnmount.stream,
      });
      assert.equal(uRes.exitCode, 0);
      assert.equal(fs.existsSync(path.join(tmpDir, '.windsurfrules')), false);
      assert.equal(fs.existsSync(path.join(tmpDir, '.cursorrules')), false);
    }

    // 11. vicem export-team, vicem fan-out, vicem fan-in
    {
      const capTeam = makeCaptureStream();
      const teamRes = await VicemApp.run(['export-team'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capTeam.stream,
      });
      assert.equal(teamRes.exitCode, 0);
      assert.ok(fs.existsSync(path.join(tmpDir, '.vicem', 'TEAM_BATON.md')));

      const capFanOut = makeCaptureStream();
      const foRes = await VicemApp.run(['fan-out', 'codex,claude,gemini'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capFanOut.stream,
      });
      assert.equal(foRes.exitCode, 0);
      assert.equal(foRes.results.length, 3);

      const capFanIn = makeCaptureStream();
      const fiRes = await VicemApp.run(['fan-in'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capFanIn.stream,
      });
      assert.equal(fiRes.exitCode, 0);
      assert.equal(fiRes.mergedCount, 3);
    }

    // 12. vicem back --dry-run, vicem rollback --dry-run, vicem resume --dry-run
    {
      const capBack = makeCaptureStream();
      const backRes = await VicemApp.run(['back', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capBack.stream,
      });
      assert.equal(backRes.exitCode, 0);
      assert.equal(backRes.mode, 'back');

      const capRb = makeCaptureStream();
      const rbRes = await VicemApp.run(['rollback', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capRb.stream,
      });
      assert.equal(rbRes.exitCode, 0);
      assert.equal(rbRes.mode, 'rollback');

      const capRes = makeCaptureStream();
      const resMode = await VicemApp.run(['resume', 'claude', 'sess-123', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capRes.stream,
      });
      assert.equal(resMode.exitCode, 0);
      assert.equal(resMode.mode, 'resume');
    }

    // 13. vicem land (valid code block & guard-blocked code block)
    {
      const capLandOk = makeCaptureStream();
      const validReply = '```ts src/new_helper.ts\nexport const helperVersion = 42;\n```';
      const landOk = await VicemApp.run(['land'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capLandOk.stream,
        clipboardText: validReply,
      });
      assert.equal(landOk.exitCode, 0);
      assert.ok(fs.existsSync(path.join(tmpDir, 'src', 'new_helper.ts')));

      const capLandFail = makeCaptureStream();
      const badReply = '```ts src/bad.ts\nexport function broken() { /* ... */ }\n```';
      const landFail = await VicemApp.run(['land'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capLandFail.stream,
        clipboardText: badReply,
      });
      assert.equal(landFail.exitCode, 1);
      assert.equal(fs.existsSync(path.join(tmpDir, 'src', 'bad.ts')), false);
    }

    // 14. vicem studio --dry-run, vicem gui --dry-run, vicem wrap --dry-run, vicem guard
    {
      const capStudio = makeCaptureStream();
      const stRes = await VicemApp.run(['studio', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capStudio.stream,
      });
      assert.equal(stRes.exitCode, 0);
      assert.equal(stRes.mode, 'studio');

      const capGui = makeCaptureStream();
      const guiRes = await VicemApp.run(['gui', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capGui.stream,
      });
      assert.equal(guiRes.exitCode, 0);
      assert.equal(guiRes.mode, 'gui');

      const capWrap = makeCaptureStream();
      const wrapRes = await VicemApp.run(['wrap', 'claude', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capWrap.stream,
      });
      assert.equal(wrapRes.exitCode, 0);
      assert.equal(wrapRes.mode, 'wrap');

      const capGuard = makeCaptureStream();
      const guardRes = await VicemApp.run(['guard'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capGuard.stream,
      });
      assert.equal(guardRes.exitCode, 0);
      assert.equal(guardRes.mode, 'guard');
    }

    // 15. Unknown target returns exitCode 1
    {
      const capUnk = makeCaptureStream();
      const unkRes = await VicemApp.run(['totally-nonexistent-agent', '--dry-run'], {
        projectRoot: tmpDir,
        env: baseEnv,
        stdout: capUnk.stream,
      });
      assert.equal(unkRes.exitCode, 1);
      assert.equal(unkRes.mode, 'unknown_target');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 4: CliLauncherAdapter Launch Spec Matrix (Interactive, Headless, Resume, Profile)
// ============================================================================

const LAUNCH_SPEC_MATRIX = [
  {
    name: 'claude interactive default',
    agent: 'claude',
    baton: { markdown: '# Baton' },
    options: {},
    expectedCmd: 'claude',
    expectedArgs: [BatonIaBuilder.BOOT_PROMPT],
    expectedMode: 'interactive',
    expectedStdio: 'inherit',
  },
  {
    name: 'claude headless pipe mode',
    agent: 'claude',
    baton: { markdown: '# Full Markdown Baton' },
    options: { headless: true },
    expectedCmd: 'claude',
    expectedArgs: ['-p', BatonIaBuilder.BOOT_PROMPT],
    expectedMode: 'headless',
    expectedInput: '# Full Markdown Baton',
  },
  {
    name: 'claude resume specific session ID',
    agent: 'claude',
    baton: null,
    options: { resumeSessionId: 'sess-abc-999' },
    expectedCmd: 'claude',
    expectedArgs: ['--resume', 'sess-abc-999'],
    expectedMode: 'resume',
  },
  {
    name: 'claude resume "last" uses -c flag',
    agent: 'claude',
    baton: null,
    options: { resumeSessionId: 'last' },
    expectedCmd: 'claude',
    expectedArgs: ['-c'],
    expectedMode: 'resume',
  },
  {
    name: 'codex interactive default',
    agent: 'codex',
    baton: { markdown: '# Baton' },
    options: {},
    expectedCmd: 'codex',
    expectedArgs: [BatonIaBuilder.BOOT_PROMPT],
    expectedMode: 'interactive',
  },
  {
    name: 'codex headless exec - pipe mode',
    agent: 'codex',
    baton: { markdown: '# Codex Headless Baton' },
    options: { headless: true },
    expectedCmd: 'codex',
    expectedArgs: ['exec', '-'],
    expectedMode: 'headless',
    expectedInput: '# Codex Headless Baton',
  },
  {
    name: 'codex resume --last',
    agent: 'codex',
    baton: null,
    options: { resumeSessionId: 'sess-codex-1' },
    expectedCmd: 'codex',
    expectedArgs: ['resume', '--last'],
    expectedMode: 'resume',
  },
  {
    name: 'gemini interactive and resume',
    agent: 'gemini',
    baton: null,
    options: { resumeSessionId: 'gem-session-42' },
    expectedCmd: 'gemini',
    expectedArgs: ['--resume', 'gem-session-42'],
    expectedMode: 'resume',
  },
  {
    name: 'aider interactive --message',
    agent: 'aider',
    baton: { markdown: '# Baton' },
    options: {},
    expectedCmd: 'aider',
    expectedArgs: ['--message', BatonIaBuilder.BOOT_PROMPT],
    expectedMode: 'interactive',
  },
  {
    name: 'opencode interactive',
    agent: 'opencode',
    baton: { markdown: '# Baton' },
    options: {},
    expectedCmd: 'opencode',
    expectedArgs: [BatonIaBuilder.BOOT_PROMPT],
    expectedMode: 'interactive',
  },
  {
    name: 'goose run --text interactive',
    agent: 'goose',
    baton: { markdown: '# Baton' },
    options: {},
    expectedCmd: 'goose',
    expectedArgs: ['run', '--text', BatonIaBuilder.BOOT_PROMPT],
    expectedMode: 'interactive',
  },
];

for (const tc of LAUNCH_SPEC_MATRIX) {
  test(`CLI Matrix [CliLauncherAdapter.buildLaunchSpec]: ${tc.name}`, () => {
    const spec = CliLauncherAdapter.buildLaunchSpec(tc.agent, tc.baton, tc.options);
    assert.equal(spec.command, tc.expectedCmd);
    assert.deepEqual(spec.args, tc.expectedArgs);
    assert.equal(spec.mode, tc.expectedMode);
    if (tc.expectedStdio) assert.equal(spec.stdio, tc.expectedStdio);
    if (tc.expectedInput) assert.equal(spec.input, tc.expectedInput);
  });
}

// ============================================================================
// SECTION 5: QuotaRadar, PtyStreamInspector, Clipboard OSC 52 & UrlPrefill Matrix
// ============================================================================

test('CLI Matrix [QuotaRadar & PtyStreamInspector]: detects vendor limit banners only when idle >= 500ms and ignores user prompt echoes', () => {
  // 1. All 4 vendor limit banners trigger when idleMs >= 500
  const vendorSamples = [
    { text: "Error: You've hit your limit for Claude 3.5 Sonnet.", expectedVendor: 'claude' },
    { text: "You've hit your usage limit. Upgrade to Pro.", expectedVendor: 'codex' },
    { text: 'RESOURCE_EXHAUSTED: Quota exceeded for quota metric', expectedVendor: 'gemini' },
    { text: 'Sorry, you have exceeded your Copilot token quota.', expectedVendor: 'copilot' },
  ];

  for (const s of vendorSamples) {
    const res = QuotaRadar.detectVendorLimit(s.text, 550);
    assert.equal(res.triggered, true, `Expected trigger for ${s.expectedVendor}`);
    assert.equal(res.vendor, s.expectedVendor);

    // Must NOT trigger when stream is still actively printing (< 500ms idle)
    const activeRes = QuotaRadar.detectVendorLimit(s.text, 100);
    assert.equal(activeRes.triggered, false);
  }

  // 2. User prompt echoes (`> ...`, `$ ...`, `User: ...`) and generic unit test 429 logs do NOT trigger false positives
  const falsePositives = [
    "> What should I do when Claude says You've hit your limit?",
    "$ echo \"You've hit your usage limit\"",
    'User: Fix the RESOURCE_EXHAUSTED: quota error handler',
    'PASS test/http.test.ts: expected status 429 Too Many Requests',
  ];
  for (const fp of falsePositives) {
    assert.equal(QuotaRadar.detectVendorLimit(fp, 1000).triggered, false);
  }

  // 3. PtyStreamInspector ring-buffer and manual evaluateIdle
  let detectedEvent = null;
  const cap = makeCaptureStream();
  const inspector = new PtyStreamInspector({
    idleMs: 5000,
    outputStream: cap.stream,
    onLimitDetected: (info) => {
      detectedEvent = info;
    },
  });
  inspector.pushChunk('Normal compilation output...\n');
  assert.equal(inspector.evaluateIdle(600).triggered, false);
  inspector.pushChunk("Claude usage limit reached. Please wait.\n");
  const evalRes = inspector.evaluateIdle(600);
  assert.equal(evalRes.triggered, true);
  assert.equal(detectedEvent?.vendor, 'claude');
  inspector.dispose();
});

test('CLI Matrix [ClipboardAdapter OSC 52 & UrlPrefillAdapter]: 512KiB chunk ceiling, tmux DCS wrapping, and 2,000-char web fallback', () => {
  // 1. Standard OSC 52 vs tmux DCS passthrough
  const oscNormal = ClipboardAdapter.encodeOsc52Chunks('Hello Baton', {});
  assert.equal(oscNormal.length, 1);
  assert.ok(oscNormal[0].startsWith('\x1b]52;c;'));
  assert.ok(oscNormal[0].endsWith('\x07'));

  const oscTmux = ClipboardAdapter.encodeOsc52Chunks('Hello Baton', { TMUX: '/tmp/tmux-1000/default,123,0' });
  assert.equal(oscTmux.length, 1);
  assert.ok(oscTmux[0].startsWith('\x1bPtmux;\x1b\x1b]52;c;'));
  assert.ok(oscTmux[0].endsWith('\x07\x1b\\'));

  // 2. Multi-chunk splitting for payload > 384 KiB raw bytes
  const largeText = 'X'.repeat(450 * 1024);
  const multiChunks = ClipboardAdapter.encodeOsc52Chunks(largeText, {});
  assert.equal(multiChunks.length, 2);

  // 3. UrlPrefillAdapter <= 2000 chars vs > 2000 chars fallback across chatgpt, claude, aistudio
  const shortMd = '# Compact Baton\nFix bug in auth.ts';
  for (const prov of ['chatgpt', 'claude', 'aistudio']) {
    const res = UrlPrefillAdapter.deliverWeb(shortMd, prov, { dryRun: true });
    assert.equal(res.mode, 'url_prefill');
    assert.equal(res.copiedToClipboard, false);
    assert.ok(res.url.includes(encodeURIComponent('Compact Baton')));
  }

  const longMd = '# Large Baton\n' + 'A'.repeat(2100);
  const fallbackRes = UrlPrefillAdapter.deliverWeb(longMd, 'claude', { dryRun: true });
  assert.equal(fallbackRes.mode, 'clipboard_fallback');
  assert.equal(fallbackRes.copiedToClipboard, true);
  assert.equal(fallbackRes.url, 'https://claude.ai/new');

  // 4. IDE Deep-Link URI generation
  assert.match(UrlPrefillAdapter.buildIdeDeepLink('antigravity', '/repo'), /^antigravity-ide:\/\/file\/repo\/\.vicem\/BATON\.md$/);
  assert.match(UrlPrefillAdapter.buildIdeDeepLink('cursor', '/repo'), /^cursor:\/\/file\/repo\/\.vicem\/BATON\.md$/);
  assert.match(UrlPrefillAdapter.buildIdeDeepLink('windsurf', '/repo'), /^windsurf:\/\/file\/repo\/\.vicem\/BATON\.md$/);
  assert.match(UrlPrefillAdapter.buildIdeDeepLink('vscode', '/repo'), /^vscode:\/\/file\/repo\/\.vicem\/BATON\.md$/);
});

// ============================================================================
// SECTION 6: RuleMountAdapter Target Rule File Matrix (All 9 Targets + External Edit Preservation)
// ============================================================================

const RULE_MOUNT_TARGET_MATRIX = [
  { target: 'antigravity', expectedRelPath: 'AGENTS.md' },
  { target: 'claude', expectedRelPath: 'CLAUDE.md' },
  { target: 'codex', expectedRelPath: 'AGENTS.md' },
  { target: 'opencode', expectedRelPath: 'AGENTS.md' },
  { target: 'cursor', expectedRelPath: '.cursorrules' },
  { target: 'windsurf', expectedRelPath: '.windsurfrules' },
  { target: 'vscode', expectedRelPath: '.github/copilot-instructions.md' },
  { target: 'cline', expectedRelPath: '.clinerules' },
  { target: 'gemini', expectedRelPath: 'GEMINI.md' },
];

for (const tc of RULE_MOUNT_TARGET_MATRIX) {
  test(`CLI Matrix [RuleMountAdapter :: ${tc.target}] (${tc.expectedRelPath}): mount, idempotent re-mount, byte-exact unmount, and user edit preservation`, () => {
    const tmpDir = makeTmpDir(`vicem-rule-${tc.target}-`);
    try {
      // 1. Fresh mount when rule file did not exist previously -> unmount deletes file cleanly
      const m1 = RuleMountAdapter.mount(tmpDir, tc.target, '# Baton Payload 1');
      assert.equal(m1.relPath, tc.expectedRelPath);
      assert.ok(fs.existsSync(m1.absPath));
      assert.ok(fs.readFileSync(m1.absPath, 'utf8').includes('# Baton Payload 1'));

      // Re-mounting updates payload without duplicating markers
      RuleMountAdapter.mount(tmpDir, tc.target, '# Baton Payload 2');
      const remountedText = fs.readFileSync(m1.absPath, 'utf8');
      assert.equal(remountedText.split(RuleMountAdapter.START_MARKER).length - 1, 1);
      assert.ok(remountedText.includes('# Baton Payload 2'));

      const u1 = RuleMountAdapter.unmount(tmpDir, tc.target);
      assert.equal(u1.unmounted, true);
      assert.equal(fs.existsSync(m1.absPath), false);

      // 2. Mount when rule file already existed with custom user rules -> byte-exact restoration on unmount
      const originalRuleText = '# Team Coding Standards\n- Always use strict TypeScript\n';
      fs.mkdirSync(path.dirname(m1.absPath), { recursive: true });
      fs.writeFileSync(m1.absPath, originalRuleText, 'utf8');

      RuleMountAdapter.mount(tmpDir, tc.target, '# Baton Payload 3');
      assert.ok(fs.readFileSync(m1.absPath, 'utf8').includes(originalRuleText));
      assert.ok(fs.readFileSync(m1.absPath, 'utf8').includes('# Baton Payload 3'));

      RuleMountAdapter.unmount(tmpDir, tc.target);
      assert.equal(fs.readFileSync(m1.absPath, 'utf8'), originalRuleText);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

// ============================================================================
// SECTION 7: DeterministicTaskExtractor & UxFormatter Accessibility Matrix
// ============================================================================

test('CLI Matrix [DeterministicTaskExtractor]: extracts goal, done items, immediateNext, and tool_use actions from mixed harvester events', () => {
  const events = [
    { role: 'user', text: 'Build a zero-dependency rate limiter middleware in src/rateLimiter.ts' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I created the sliding window counter.' },
        { type: 'tool_use', name: 'write_file', input: { file_path: 'src/rateLimiter.ts' } },
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Implement sliding window counter', status: 'completed' },
              { content: 'Implement Redis token bucket fallback', status: 'in_progress' },
              { content: 'Verify concurrency under load', status: 'pending' },
            ],
          },
        },
        {
          type: 'tool_use',
          name: 'bash',
          input: { command: 'npm test' },
          exit_code: 1,
        },
      ],
    },
    { role: 'user', text: 'Now add Redis fallback and fix the failing unit test' },
  ];
  const git = {
    branch: 'feat/rate-limiter',
    headCommit: 'a1b2c3d',
    modifiedFiles: ['src/rateLimiter.ts'],
    untrackedFiles: ['test/rateLimiter.test.ts'],
    recentCommits: ['feat: initial rate limiter skeleton'],
  };

  const extracted = DeterministicTaskExtractor.extract(events, git);
  assert.ok(extracted.goal.includes('Build a zero-dependency rate limiter middleware'));
  assert.ok(extracted.done.some((d) => d.includes('rateLimiter.ts') || d.includes('sliding window')));
  assert.ok(extracted.immediateNext.some((n) => n.includes('Redis')));
  assert.ok(extracted.immediateNext.some((n) => n.includes('npm test')));
});

test('CLI Matrix [UxFormatter]: NO_COLOR=1, TERM=dumb, and standard ANSI color receipts + guard recovery + self-heal prompt', () => {
  const receiptData = {
    sourceAgent: 'claude',
    targetAgent: 'codex',
    rawTokens: 20000,
    dietTokens: 2500,
    redactedCount: 3,
    undoCommand: 'vicem back',
    fuzzyCorrectedFrom: 'codexx',
  };

  const plainReceipt = UxFormatter.renderReceipt(receiptData, { NO_COLOR: '1' });
  assert.ok(plainReceipt.startsWith('[OK] [Vicem]'));
  assert.ok(!plainReceipt.includes('\x1b['));
  assert.ok(plainReceipt.includes("Auto-corrected 'codexx' → 'codex'"));
  assert.ok(plainReceipt.includes('Redacted: 3 secrets'));

  const dumbReceipt = UxFormatter.renderReceipt(receiptData, { TERM: 'dumb' });
  assert.ok(dumbReceipt.startsWith('[OK] [Vicem]'));
  assert.ok(!dumbReceipt.includes('\x1b['));

  const colorReceipt = UxFormatter.renderReceipt(receiptData, { TERM: 'xterm-256color' });
  assert.ok(colorReceipt.includes('✓'));

  const violation = {
    type: 'SKELETON_PLACEHOLDER',
    rule: 'C_BLOCK_ELLIPSIS',
    filePath: 'src/engine.ts',
    line: 42,
    snippet: 'export function run() { /* ... */ }',
  };
  const guardMsg = UxFormatter.renderGuardRecovery(violation, { NO_COLOR: '1' });
  assert.ok(guardMsg.includes('[ERR] [Vicem Guard] Blocked'));
  assert.ok(guardMsg.includes('src/engine.ts:42'));

  const selfHeal = UxFormatter.renderAgentSelfHealPrompt(violation, 'run');
  assert.ok(selfHeal.includes('vicem_rehydrate("src/engine.ts", "run")'));
});

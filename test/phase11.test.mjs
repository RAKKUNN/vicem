import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  safeJsonForHtmlScript,
  StudioHydrationAdapter,
  TokenEstimator,
  SecretRedactor,
  CodeSkeletonizer,
  VicemApp,
} from '../vicem.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const indexHtmlPath = path.join(repoRoot, 'index.html');

test('Phase 11 - TC-ADV-05 (Fix 11-A & Fix 11-B): XSS-Safe Hydrated Web Studio (.vicem/studio.live.html) & Browser-CLI Isomorphic Core Parity', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-p11-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // Source file containing hostile `</script><script>evil()</script>` payload + multi-line function + secret
    const hostileCode = `export interface WidgetProps {
  title: string;
}

export function renderDangerTemplate(props: WidgetProps): string {
  const badTag = "</script><script>window.__pwned = true;</script>";
  const secretKey = "sk-proj-9999999999zyxwvutsrqponmlk";
  const line1 = props.title.trim();
  const line2 = line1.toLowerCase();
  const line3 = line2.replace(/a/g, 'b');
  const line4 = line3.slice(0, 10);
  const line5 = line4 + badTag;
  const line6 = line5.repeat(2);
  const line7 = line6.trim();
  const line8 = line7.concat('!');
  return line8 + secretKey;
}
`;
    fs.writeFileSync(path.join(srcDir, 'widget.ts'), hostileCode);

    const originalIndexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    // Run `vicem studio --dry-run` on tmpDir
    const outChunks = [];
    const res = await VicemApp.run(['studio', 'claude', '--dry-run'], {
      projectRoot: tmpDir,
      stdout: { write: (s) => outChunks.push(s) },
      skipLaunch: true,
    });

    assert.equal(res.exitCode, 0);
    assert.ok(fs.existsSync(res.liveHtmlPath), '.vicem/studio.live.html must be generated');

    // 1. Original index.html must remain 100% untouched (0-byte diff)
    assert.equal(
      fs.readFileSync(indexHtmlPath, 'utf8'),
      originalIndexHtml,
      'Original index.html must never be mutated by vicem studio'
    );

    const liveHtml = fs.readFileSync(res.liveHtmlPath, 'utf8');

    // 2. Hostile `</script>` inside project code must be escaped as `\u003c/script\u003e`
    assert.ok(
      !liveHtml.includes('</script><script>window.__pwned'),
      'Raw </script> tag from source code must never appear unescaped in studio.live.html'
    );
    assert.ok(
      liveHtml.includes('\\u003c/script\\u003e\\u003cscript\\u003ewindow.__pwned'),
      'Hostile script tag must be escaped via safeJsonForHtmlScript'
    );

    // 3. CSP default-src 'none' must be preserved in studio.live.html
    assert.ok(
      liveHtml.includes("default-src 'none'"),
      'CSP default-src none must remain intact in studio.live.html'
    );

    // 4. Secret in hydrated payload must already be redacted
    assert.ok(
      !liveHtml.includes('sk-proj-9999999999zyxwvutsrqponmlk'),
      'Secrets must be redacted before writing studio.live.html'
    );

    // 5. Execute liveHtml script in a mocked DOM VM to verify hydration + isomorphic parity
    const scriptMatch = liveHtml.match(/<script>([\s\S]*?)<\/script>/);
    const hydrationMatch = liveHtml.match(
      /<script id="vicem-hydration-data" type="application\/json">([\s\S]*?)<\/script>/
    );
    assert.ok(scriptMatch && hydrationMatch, 'Must contain both hydration JSON and main script');

    const elements = {
      'vicem-hydration-data': { textContent: hydrationMatch[1] },
      goalInput: { value: '', addEventListener() {} },
      nextInput: { value: '', addEventListener() {} },
      rawSourceInput: { value: '', addEventListener() {} },
      dietSlider: { value: '2', addEventListener() {} },
      dietLevelName: { textContent: '' },
      tokenStatsText: { textContent: '' },
      budgetStatusText: { textContent: '', style: {} },
      gaugeFill: { style: {} },
      inspectorOutput: { textContent: '' },
      secretShieldSummary: { textContent: '' },
      secretTabCount: { textContent: '' },
      targetSelect: { value: 'codex', addEventListener() {} },
      actionReceipt: { textContent: '' },
      copyBatonBtn: { addEventListener() {} },
      downloadBatonBtn: { addEventListener() {} },
      dropZone: { addEventListener() {}, classList: { add() {}, remove() {} } },
      filePicker: { addEventListener() {}, click() {} },
      fileCountBadge: { textContent: '' },
    };

    const sandbox = {
      document: {
        getElementById: (id) => elements[id] || { value: '', textContent: '', style: {}, addEventListener() {} },
        querySelectorAll: () => [],
        createElement: () => ({ click() {} }),
      },
      window: { addEventListener() {} },
      navigator: {},
      Blob: class {},
      URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
      Math,
      String,
      Array,
      Object,
      RegExp,
      parseInt,
      JSON,
    };

    vm.runInNewContext(scriptMatch[1], sandbox);

    // Verify that boot hydration populated targetSelect, rawSourceInput, and collapsed the 15-line function in preview
    assert.equal(elements.targetSelect.value, 'claude', 'Hydration must set targetSelect to claude');
    assert.ok(
      elements.rawSourceInput.value.includes('renderDangerTemplate'),
      'Hydration must populate rawSourceInput with project source code'
    );
    assert.ok(
      elements.inspectorOutput.textContent.includes('{ /* ... */ }'),
      'Browser isomorphic skeletonizer must collapse >=12 line function in Baton preview'
    );
    assert.ok(
      elements.inspectorOutput.textContent.includes('export interface WidgetProps'),
      'Browser isomorphic skeletonizer must preserve TypeScript interface 100%'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Phase 7 - TC-SEC-02: index.html enforces strict CSP default-src none and zero external network calls', () => {
  const htmlPath = path.resolve('index.html');
  assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // 1. Strict CSP meta tag verification
  assert.ok(
    html.includes("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"),
    'index.html must contain strict zero-network CSP meta tag'
  );

  // 2. Zero external network API calls (no fetch, XMLHttpRequest, WebSocket, or external CDN URLs)
  assert.ok(!/\bfetch\s*\(/.test(html), 'Must not call fetch()');
  assert.ok(!/\bXMLHttpRequest\b/.test(html), 'Must not use XMLHttpRequest');
  assert.ok(!/\bWebSocket\b/.test(html), 'Must not use WebSocket');
  assert.ok(!/https?:\/\//i.test(html), 'Must not reference any external http:// or https:// URLs');
});

test('Phase 7 - TC-UX-06: index.html implements 3-Zone layout, ARIA accessibility attributes, and Cmd+Enter shortcut', () => {
  const htmlPath = path.resolve('index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // 1. 3-Zone architecture (Zone A, Zone B, Zone C)
  assert.ok(html.includes('Zone A'), 'Must include Zone A (Source Input)');
  assert.ok(html.includes('Zone B'), 'Must include Zone B (Live Diet Slider & Inspector)');
  assert.ok(html.includes('Zone C'), 'Must include Zone C (1-Click Action Bar)');

  // 2. ARIA & Keyboard navigation support
  assert.ok(html.includes('role="region"'), 'Must define ARIA regions');
  assert.ok(html.includes('aria-live="polite"'), 'Must define aria-live polite announcements');
  assert.ok(html.includes('role="tablist"'), 'Must define ARIA tablist for 3-Tab Inspector');

  // 3. Live Diet Slider & 3-Tab Inspector IDs
  assert.ok(html.includes('id="dietSlider"'), 'Must include interactive Diet Slider');
  assert.ok(html.includes('data-tab="preview"'), 'Must include Baton Preview tab');
  assert.ok(html.includes('data-tab="skeleton"'), 'Must include Skeleton Diff tab');
  assert.ok(html.includes('data-tab="secrets"'), 'Must include Masked Secrets tab');

  // 4. Cmd+Enter / Ctrl+Enter keyboard shortcut
  assert.ok(
    html.includes("(e.metaKey || e.ctrlKey) && e.key === 'Enter'"),
    'Must bind Cmd+Enter / Ctrl+Enter to 1-click Copy Baton'
  );
});

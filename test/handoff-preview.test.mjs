import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BatonIaBuilder } from '../vicem.mjs';

test('state previews preserve the delivered baton, ledger and snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-preview-'));
  try {
    const options = {
      projectRoot: root,
      taskContext: { goal: 'Deliver the task', immediateNext: ['Implement it'] },
      gitContext: { modifiedFiles: [], untrackedFiles: [], branch: 'main' },
    };
    BatonIaBuilder.build({ ...options, persist: false });
    assert.equal(fs.existsSync(path.join(root, '.vicem')), false);
    BatonIaBuilder.build(options);
    const before = new Map(fs.readdirSync(path.join(root, '.vicem'), { recursive: true })
      .filter(f => fs.statSync(path.join(root, '.vicem', f)).isFile())
      .map(f => [f, fs.readFileSync(path.join(root, '.vicem', f))]));
    const preview = BatonIaBuilder.build({ ...options, targetAgent: 'claude', persist: false });
    assert.ok(preview.markdown.includes('Deliver the task'));
    for (const [file, bytes] of before) {
      assert.deepEqual(fs.readFileSync(path.join(root, '.vicem', file)), bytes, file);
    }
    assert.equal(fs.readdirSync(path.join(root, '.vicem'), { recursive: true })
      .filter(f => fs.statSync(path.join(root, '.vicem', f)).isFile()).length, before.size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

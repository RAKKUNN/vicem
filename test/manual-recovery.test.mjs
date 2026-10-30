import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('GUI keeps a readable handoff and truthful support status after launch failure', {timeout:30000}, async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(), 'vicem recovery 한글 '));
 process.env.VICEM_PROJECT_ROOT=root;
 fs.writeFileSync(path.join(root,'app.js'),'export const value = 42;\n');
 const {server,executeRealHandoff}=await import('../vicem-gui.mjs');
 try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/support');
  assert.equal(response.status,200);
  const support=await response.json();
  assert.equal(support.platform,process.platform);
  assert.match(support.desktop,/best effort/);
  const result=await executeRealHandoff('codex','app',{launcher:async()=>{throw new Error('Simulated unavailable desktop');}});
  assert.equal(result.handoffStatus,'partial');
  assert.equal(result.launchSucceeded,false);
  assert.equal(result.receptionConfirmed,false);
  assert.match(fs.readFileSync(result.manualContinuation.batonPath,'utf8'),/BATON/);
  assert.match(result.manualContinuation.prompt,/Section 2/);
  assert.equal(result.manualContinuation.projectRoot,root);
  const html=await (await fetch(base)).text();
  assert.match(html,/Copy command/);
  assert.match(html,/Copy start prompt/);
 } finally {
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
 }
});

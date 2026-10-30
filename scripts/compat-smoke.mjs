import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const source=path.resolve(process.argv[2] || '.');
const {HandoffService,CliLauncherAdapter}=await import(pathToFileURL(path.join(source,'vicem.mjs')));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vicem compatibility 한글 '));
const passed=[];
try {
 fs.writeFileSync(path.join(root,'app.js'),'export const value = 42;\n');
 const plan=HandoffService.prepare({projectRoot:root,targetAgent:'codex',persist:false});
 assert.ok(plan.markdown.includes('BATON'));assert.equal(fs.existsSync(path.join(root,'.vicem')),false);passed.push('read-only preview; Unicode/spaces path');
 const baton=HandoffService.prepare({projectRoot:root,targetAgent:'codex'});
 assert.ok(fs.existsSync(path.join(root,'.vicem','BATON.md')));passed.push('baton persistence');
 const rules=path.join(root,'CLAUDE.md');fs.writeFileSync(rules,'Existing project instructions\n');
 HandoffService.mount(root,'claude',baton);HandoffService.record(root,baton,'prepared');
 assert.equal(HandoffService.history(root)[0].receptionConfirmed,false);
 HandoffService.undo(root,baton.id);assert.equal(fs.readFileSync(rules,'utf8'),'Existing project instructions\n');assert.equal(HandoffService.history(root)[0].status,'undone');passed.push('mount/history/undo preserve original instructions');
 HandoffService.mount(root,'claude',{...baton,id:'baton-compat-conflict'});fs.appendFileSync(rules,'Later user edit\n');assert.throws(()=>HandoffService.undo(root,'baton-compat-conflict'),/changed since/);passed.push('conflict prevents overwrite');
 const script=path.join(root,'fail.cjs');fs.writeFileSync(script,'process.exit(7)');
 const failure=CliLauncherAdapter.deliver(process.execPath,{}, {projectRoot:root,bootPrompt:script});assert.equal(failure.launched,false);assert.equal(failure.status,7);passed.push('failed child reported as failure');
 const help=spawnSync(process.execPath,[path.join(source,'vicem.mjs'),'--help'],{encoding:'utf8',timeout:10000});assert.equal(help.status,0);assert.match(help.stdout,/preview/);passed.push('CLI startup/help');
 const invalid=spawnSync(process.execPath,[path.join(source,'vicem.mjs'),'--nonexistent-option'],{encoding:'utf8',timeout:10000});assert.equal(invalid.status,2);passed.push('invalid input exit code');
 console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,passed},null,2));
} finally {fs.rmSync(root,{recursive:true,force:true});}

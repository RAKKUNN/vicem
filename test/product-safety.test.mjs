import childProcess from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuleMountAdapter, VicemApp, HandoffService, CliLauncherAdapter } from '../vicem.mjs';
test('Claude mount preserves existing instructions and edits across remount', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-safe-'));
 try {
  const file = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(file, '# User rules\n');
  RuleMountAdapter.mount(root, 'claude', 'first');
  fs.appendFileSync(file, 'New user instruction\n');
  RuleMountAdapter.mount(root, 'claude', 'second');
  assert.match(fs.readFileSync(file, 'utf8'), /New user instruction/);
  RuleMountAdapter.unmount(root, 'claude');
  assert.match(fs.readFileSync(file, 'utf8'), /# User rules/);
  assert.match(fs.readFileSync(file, 'utf8'), /New user instruction/);
 } finally { fs.rmSync(root, {recursive:true,force:true}); }
});
test('Unknown CLI options fail before doing work', async () => {
 const result = await VicemApp.run(['--typo'], { stdout: {write() {}} });
 assert.equal(result.exitCode, 2);
});

test('Preview does not write project artifacts; history records outcomes without claiming reception', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-preview-'));
 try {
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  const baton = HandoffService.prepare({projectRoot: root, targetAgent: 'codex', persist: false});
  assert.equal(fs.existsSync(path.join(root, '.vicem')), false);
  assert.match(baton.markdown, /BATON/);
  assert.throws(() => HandoffService.prepare({projectRoot: root, targetAgent: 'codex', budgetTokens: -1}), /Budget/);
  assert.equal(fs.existsSync(path.join(root, '.vicem')), false);
  HandoffService.record(root, baton, 'prepared', 'No launch');
  assert.equal(HandoffService.history(root)[0].receptionConfirmed, false);
  assert.equal(HandoffService.history(root)[0].id, baton.id);
 } finally { fs.rmSync(root, {recursive:true,force:true}); }
});

test('Handoff undo restores only its instructions and refuses later edits', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vicem-undo-'));
 try {
  const file = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(file, 'User rules\n');
  const baton = { id:'baton-test-1', markdown: 'Continue testing' };
  HandoffService.mount(root, 'claude', baton);
  assert.equal(HandoffService.undo(root, baton.id).status, 'undone');
  assert.equal(fs.readFileSync(file, 'utf8'), 'User rules\n');
  HandoffService.mount(root, 'claude', {...baton,id:'baton-test-2'});
  fs.appendFileSync(file, 'New instruction\n');
  const edited = fs.readFileSync(file, 'utf8');
  assert.throws(() => HandoffService.undo(root, 'baton-test-2'), /changed since/);
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  assert.throws(() => HandoffService.undo(root, '../escape'), /valid handoff/);
 } finally { fs.rmSync(root, {recursive:true,force:true}); }
});

test('CLI delivery reports nonzero exits and timeouts as failures', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vicem-process-'));
 try {
  const script=path.join(root,'child.cjs'); fs.writeFileSync(script,'process.exit(7);');
  const failure=CliLauncherAdapter.deliver(process.execPath,{}, {projectRoot:root,bootPrompt:script});
  assert.equal(failure.launched,false); assert.equal(failure.status,7); assert.match(failure.error,/code 7/);
  fs.writeFileSync(script,'setInterval(() => {}, 1000);');
  const timeout=CliLauncherAdapter.deliver(process.execPath,{}, {projectRoot:root,bootPrompt:script,timeoutMs:100});
  assert.equal(timeout.launched,false); assert.ok(timeout.error);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('wrap dry-run never launches an absent agent and missing agent returns an error', async () => {
 const options={stdout:{write(){}},projectRoot:os.tmpdir()};
 const dry=await VicemApp.run(['wrap','vicem-nonexistent-agent','--dry-run'],options);
 assert.equal(dry.exitCode,0);assert.equal(dry.result.command,'vicem-nonexistent-agent');
 const live=await VicemApp.run(['wrap','vicem-nonexistent-agent'],options);
 assert.equal(live.exitCode,127);assert.match(live.result.error,/ENOENT/);
});

test('manual continuation quotes Windows and POSIX paths and does not claim reception', () => {
 const windows=HandoffService.manualGuide("C:\\Work\\O'Brien $demo",'codex','win32');
 assert.equal(windows.shell,'PowerShell');
 assert.ok(windows.command.startsWith("& { Set-Location -LiteralPath 'C:\\Work\\O''Brien $demo'"));
 assert.ok(windows.command.includes("\ncodex 'Read .vicem/BATON.md"));
 assert.equal(windows.receptionConfirmed,false);
 const posix=HandoffService.manualGuide("/tmp/O'Brien $demo",'claude','linux');
 assert.ok(posix.command.includes("'\"'\"'"));
 assert.ok(posix.command.includes(' && claude '));
 assert.equal(HandoffService.supportInfo('win32').label,'Windows Preview');
 assert.match(HandoffService.supportInfo('win32').desktop,/best effort/);
 const web=HandoffService.manualGuide('/tmp/project','web','linux');
 assert.equal(web.command,"cd '/tmp/project'");
 assert.match(web.instructions,/manually/);
 assert.match(web.instructions,/attach or paste/);
 assert.match(web.prompt,/I attach or paste/);
});


test('Windows manual command runs in the intended folder and stops on a missing folder', {skip: process.platform !== 'win32'}, () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(), "vicem manual O'Brien 한글 "));
 const capture=path.join(root,'capture.txt');
 try {
  const invoke = guide => childProcess.spawnSync('pwsh', ['-NoProfile','-NonInteractive','-Command',
   `function codex { [System.IO.File]::WriteAllText($env:VICEM_MANUAL_CAPTURE, ($PWD.Path + "\n" + $args[0])) }\n${guide.command}`],
   {encoding:'utf8',timeout:15000,env:{...process.env,VICEM_MANUAL_CAPTURE:capture}});
  const guide=HandoffService.manualGuide(root,'codex','win32');
  const result=invoke(guide);
  assert.equal(result.status,0,result.stderr);
  const [actualDirectory, ...promptLines] = fs.readFileSync(capture,'utf8').split('\n');
  // PowerShell expands Windows 8.3 aliases (RUNNER~1) to their long path.
  assert.equal(fs.realpathSync.native(actualDirectory),fs.realpathSync.native(root));
  assert.equal(promptLines.join('\n'),guide.prompt);
  fs.rmSync(capture);
  const missing=invoke(HandoffService.manualGuide(path.join(root,'missing'),'codex','win32'));
  assert.notEqual(missing.status,0);
  assert.equal(fs.existsSync(capture),false,'must not launch an agent in the wrong folder');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

// Codex as the engine of a background agent: the real worker (agentrun.mjs) and Codex adapter (codex.mjs), driven by a
// fake Codex CLI (test/fakecodex.mjs) that reaches our tools only through the MCP server it is told to start.
// Progress, done, a refused model, a stop, and the missing / signed-out CLI checks. Run: npm test
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-codexrun-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.FAKE_CODEX_LOG = path.join(tmp, 'codex.log');
delete process.env.ROAMIES_FAKE_AGENT;
const fake = fileURLToPath(new URL('./fakecodex.mjs', import.meta.url));
const { agentsRoot, createAgents } = await import('../agents.mjs');
const { checkOpen, checkRead, checkWrite } = await import('../safety.mjs');
const { probeCodex } = await import('../codex.mjs');

let model = 'gpt-5.5';
const events = [];
let onEnd = null;
const mgr = createAgents({
  fork, root: agentsRoot(), userName: 'Ken', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
  config: { model: async () => ({ provider: 'codex', model, route: 'codex', codex: { bin: process.execPath, args: [fake] } }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {} },
  ui: ({ e }) => { events.push(e); if (e.type === 'done' || e.type === 'fail' || e.type === 'gone') onEnd?.(e); },
});
const ended = () => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no result in 20 s: ${JSON.stringify(events.map((e) => e.type))}`)), 20_000);
  onEnd = (e) => { clearTimeout(t); onEnd = null; resolve(e); };
});
const codexLog = () => fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Done: it plans, writes through our write_file (safety.mjs), and finishes through our finish tool.
let done = ended();
const a = await mgr.start({ type: 'maker', title: 'A note', brief: 'Write a short note.' });
let end = await done;
assert.equal(end.type, 'done', end.agent.reason);
assert.ok(events.some((e) => e.type === 'update' && e.agent.step === 'Writing the note'), 'its plan line reached the row');
assert.equal(fs.readFileSync(path.join(a.dir, 'files', 'note.md'), 'utf8'), '# Hi\n');
assert.equal(end.agent.result.outcome, 'Wrote a short note.');
assert.deepEqual(end.agent.result.files.map((f) => f.rel), ['files/note.md']);
const state = JSON.parse(fs.readFileSync(path.join(a.dir, '.agent.json'), 'utf8'));
assert.deepEqual(state.tokens, { in: 1200, out: 80 });
const log = codexLog();
const { argv } = log[0];
// How it was run: headless JSON, our model, in its folder, Codex's own shell off and its sandbox read-only.
assert.deepEqual(argv.slice(0, 2), ['exec', '--json']);
assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.5');
assert.equal(argv[argv.indexOf('-C') + 1], a.dir);
assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
assert.ok(argv.includes('--skip-git-repo-check'));
assert.ok(argv.includes('features.shell_tool=false'));
assert.ok(argv.includes('web_search="disabled"'));
assert.deepEqual([...log[1].tools].sort(), ['finish', 'list_files', 'plan', 'read_file', 'run_command', 'search_files', 'web_fetch', 'web_search', 'write_file'], 'only its own tools, plus plan and finish');
assert.match(log[1].input, /Brief from Ken:\nWrite a short note\./);
assert.ok(log[1].input.includes(`Your folder is ${a.dir}.`), 'our agent prompt goes in');
assert.equal(log[2].write.isError, undefined, 'write_file worked');

// A model the account can't use: a clear failure that says what to do.
fs.rmSync(process.env.FAKE_CODEX_LOG);
model = 'gpt-nope';
done = ended();
await mgr.start({ type: 'maker', title: 'Another note', brief: 'Write another note.' });
end = await done;
assert.equal(end.type, 'fail');
assert.match(end.agent.reason, /Codex can't use the model gpt-nope on this account/);
assert.match(end.agent.reason, /Subagents page/);

// Stop: a long run ends as stopped, and the Codex process goes with it.
fs.rmSync(process.env.FAKE_CODEX_LOG);
model = 'gpt-slow';
done = ended();
const c = await mgr.start({ type: 'maker', title: 'Slow job', brief: 'Take your time.' });
await new Promise((resolve) => { const t = setInterval(() => { if (events.some((e) => e.type === 'update' && e.agent.step === 'Working for a long time')) { clearInterval(t); resolve(); } }, 50); });
const { pid } = codexLog()[0];
mgr.stop(c.id);
end = await done;
assert.equal(end.type, 'gone');
assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, '.agent.json'), 'utf8')).state, 'stopped');
if (process.platform !== 'win32') {
  // TerminateProcess on Windows gives the worker no chance to take Codex down with it.
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(pid, 0), 'the Codex process ended with the agent');
}

// The engine's availability on the Subagents page: missing, signed out, ready.
assert.deepEqual(await probeCodex({ bin: path.join(tmp, 'no-codex-here') }), { ok: false, reason: 'Codex CLI not found. Install it: npm i -g @openai/codex' });
process.env.FAKE_CODEX_SIGNED_OUT = '1';
assert.deepEqual(await probeCodex({ bin: process.execPath, args: [fake] }), { ok: false, reason: 'Codex is signed out. Run codex login in a terminal.' });
delete process.env.FAKE_CODEX_SIGNED_OUT;
assert.deepEqual(await probeCodex({ bin: process.execPath, args: [fake] }), { ok: true, version: '0.155.1' });

mgr.stopAll();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('codex run tests: passed');

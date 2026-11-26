// Classic chat end to end, driven by text: a scripted "model" (a list of tool calls run in order, as the chat loop
// runs them) against the real tools. A temp folder is the second brain, a fake hands helper stands in for the
// screen and mouse, a fake `open` for the browser, a stubbed fetch for the web, and background agents run in the
// real worker (agentrun.mjs) with the scripted test/fakeagent.mjs model. Nothing touches the real screen, network
// or home folder. Run: npm test (or node test/e2e-classic.test.mjs)
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-classic-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.JARVIS_DATA_DIR = path.join(tmp, 'data');
process.env.JARVIS_FAKE_AGENT = fileURLToPath(new URL('./fakeagent.mjs', import.meta.url));
process.env.FAKE_LOG = path.join(tmp, 'fake-agent.log');
process.env.JARVIS_BG = '1';
const HANDS_OK = ['darwin', 'win32'].includes(process.platform);

// The fake hands helper (a .mjs runs on this Node): logs every call, and answers like the real one for one window.
const handsLog = path.join(tmp, 'hands.jsonl'), handsFake = path.join(tmp, 'hands.mjs');
fs.writeFileSync(handsFake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(handsLog)}, JSON.stringify(a) + '\\n');
const win = { id: 7, app: 'Chrome', title: 'Cards', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') o = { ok: true, done: JSON.parse(a[1]).steps.map((s) => s.do), window: win, controls: [{ id: 1, role: 'button', label: 'Video +' }], texts: ['Info cards'] };
if (a[0] === 'ui') o = { ok: true, window: win, controls: [{ id: 1, role: 'button', label: 'Video +', bounds: [10, 10, 80, 24] }, { id: 2, role: 'link', label: 'Upload', bounds: [10, 50, 80, 24] }], texts: ['Info cards'] };
if (a[0] === 'windows') o = { ok: true, windows: [{ id: 7, app: 'Chrome', title: 'Cards', frontApp: true }, { id: 9, app: 'Notes', title: '' }] };
if (a[0] === 'find-text') o = { ok: true, matches: [{ text: a[2], match: 'exact', role: 'button', bounds: [100, 100, 80, 24], window: win }] };
if (a[0] === 'locate') o = { ok: true, window: win };
if (a[0] === 'front') o = { ok: true, app: win.app, title: win.title };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`);
process.env.JARVIS_HANDS = handsFake;
const handsCalls = () => (fs.existsSync(handsLog) ? fs.readFileSync(handsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A fake `open` (macOS) / `xdg-open` (Linux) first on PATH: links "open" into a log, never a real browser.
const binDir = path.join(tmp, 'bin'), openLog = path.join(tmp, 'open.log');
fs.mkdirSync(binDir);
for (const name of ['open', 'xdg-open']) {
  fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(openLog)}\n`, { mode: 0o755 });
}
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
const OPEN_OK = process.platform !== 'win32';
const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8').trim().split('\n').filter(Boolean) : []);

const { createTools } = await import('../tools.mjs');
const { guardTools, LOOP_MESSAGE } = await import('../loopguard.mjs');

// The second brain: a folder with notes and a read-only _raw/ evidence folder.
const brain = path.join(tmp, 'Brain');
fs.mkdirSync(path.join(brain, '_raw'), { recursive: true });
fs.mkdirSync(path.join(brain, '_context'), { recursive: true });
fs.writeFileSync(path.join(brain, '_context', 'index.md'), '# Index\nJarvis ships v0.2.6 with the loop guard.\n');
fs.writeFileSync(path.join(brain, '_raw', 'call.md'), 'Raw transcript: Eric said the operator hands off from Live.\n');

const ui = [];
const noop = async () => {};
const asked = [];
const shown = [], committed = [];
const made = createTools({
  allowActions: () => true, ask: async (o) => { asked.push(o); return true; }, openUrl: noop, onCommitments: (c) => committed.push(c), showList: () => shown.push(1), fmtWhen: String, commitmentsText: () => '', userName: 'Eric',
  ui: (m) => { ui.push(m); if (m.e?.type === 'draw') setImmediate(() => made.ink.started(m.e.id, m.e.seg)); },
  workdir: tmp, fileDir: () => brain, readOnly: () => [path.join(brain, '_raw')],
});
const logged = [];
const tools = guardTools(made.tools, { log: (...a) => logged.push(a) });
const tool = (n) => tools.find((t) => t.name === n);
let callN = 0;
// The scripted model: run each call in order, like the chat loop, collecting results or the error the model would see.
async function play(calls) {
  const out = [];
  for (const [name, args] of calls) {
    const t = tool(name);
    assert.ok(t, `the chat has a ${name} tool`);
    try { out.push({ name, ok: true, result: await t.execute(args, { toolCallId: `c${++callN}`, signal: new AbortController().signal }) }); }
    catch (e) { out.push({ name, ok: false, result: e.message }); }
  }
  return out;
}
// Each critical path is a named step, tagged with its CP id from the test plan, so a failure says which path broke.
const passed = [];
async function cp(name, fn) { await fn(); passed.push(name); console.log(`  ok  ${name}`); }
const text = (r) => (typeof r === 'string' ? r : Array.isArray(r?.content) ? r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : typeof r?.content === 'string' ? r.content : JSON.stringify(r));

// 1. The second brain: list it, read a note by a path relative to the brain, search it, write a new note, and _raw/ stays read-only.
await cp('CP-2 knowledge base: list, read, search and write notes; _raw read-only; secrets off limits', async () => {
  const r = await play([
    ['list_files', { dir: '.' }],
    ['read_file', { path: '_context/index.md' }],
    ['search_files', { pattern: 'loop guard', dir: '_context' }],
    ['write_file', { path: '_context/today.md', content: 'Ran the regression tests.' }],
    ['read_file', { path: '_raw/call.md' }],
    ['write_file', { path: '_raw/call.md', content: 'edited' }],
    ['write_file', { path: '_raw/new.md', content: 'new evidence' }],
  ]);
  assert.ok(r[0].ok && /_context\//.test(r[0].result) && /_raw\//.test(r[0].result), `lists the brain: ${r[0].result}`);
  assert.equal(r[1].result, '# Index\nJarvis ships v0.2.6 with the loop guard.\n', 'reads a note relative to the brain');
  assert.ok(r[2].ok && /index\.md:2:Jarvis ships v0\.2\.6 with the loop guard\./.test(r[2].result), `search finds the line: ${r[2].result}`);
  assert.ok(r[3].ok, r[3].result);
  assert.equal(fs.readFileSync(path.join(brain, '_context', 'today.md'), 'utf8'), 'Ran the regression tests.', 'a new note lands in the brain');
  assert.match(r[4].result, /^Raw transcript/, '_raw/ can be read');
  assert.equal(r[5].ok, false, 'overwriting _raw/ evidence is refused');
  assert.match(r[5].result, /Blocked for safety/);
  assert.equal(r[6].ok, false, 'a new file in _raw/ is refused too');
  assert.equal(fs.readFileSync(path.join(brain, '_raw', 'call.md'), 'utf8'), 'Raw transcript: Eric said the operator hands off from Live.\n', '_raw/ unchanged');
  assert.ok(!fs.existsSync(path.join(brain, '_raw', 'new.md')));
  // Secrets stay off limits even inside the brain.
  fs.writeFileSync(path.join(brain, '.env'), 'KEY=nope');
  const [sec] = await play([['read_file', { path: '.env' }]]);
  assert.equal(sec.ok, false, 'a .env in the brain is not read');
  assert.match(sec.result, /Blocked for safety/);
});

// 1b. A plain tool round trip: the real execute runs and its result is what the model gets back.
await cp('CP-3 tool round trip: show_list and remember_commitment run and answer the model', async () => {
  const r = await play([['show_list', {}], ['remember_commitment', { text: 'Record the Jarvis regression video', due: '2030-01-02T09:00' }]]);
  assert.deepEqual(r.map((x) => x.ok), [true, true], JSON.stringify(r));
  assert.equal(r[0].result, 'The list is on screen.');
  assert.equal(shown.length, 1, 'show_list put the list on screen');
  assert.match(r[1].result, /^Saved as \S+, due .+\. I'll remind them when it is due\.$/);
  assert.equal(committed.at(-1)?.text, 'Record the Jarvis regression video', 'the saved commitment reached the app');
});

// 2. The screen: list windows, read the window, click and scroll in it, look at it.
if (HANDS_OK) await cp('CP-5/CP-6 screen: list_windows, read_window, act_in_app click/scroll/click_text, take_screenshot reach the helper', async () => {
  made.nextTurn?.();
  fs.writeFileSync(handsLog, '');
  const r = await play([
    ['list_windows', {}],
    ['read_window', { target: 'front' }],
    ['act_in_app', { target: 'front', steps: [{ do: 'click', id: 1 }] }],
    ['act_in_app', { target: 'Chrome', steps: [{ do: 'scroll', direction: 'down', amount: 3 }] }],
    ['act_in_app', { target: 'front', steps: [{ do: 'click_text', text: 'Upload' }] }],
    ['take_screenshot', { target: 'front' }],
  ]);
  for (const x of r) assert.ok(x.ok, `${x.name}: ${text(x.result)}`);
  assert.match(r[0].result, /window:7 {2}Chrome — Cards {2}\(frontmost app\)/);
  assert.match(r[1].result, /Video \+/, 'read_window lists the controls');
  assert.match(r[2].result, /^In Chrome: click\./);
  assert.match(r[3].result, /^In Chrome: scroll\./);
  assert.match(r[4].result, /^In Chrome: click_text\./);
  const acts = handsCalls().filter((c) => c[0] === 'act').map((c) => JSON.parse(c[1]));
  assert.equal(acts.length, 3, 'three plans reached the helper');
  assert.deepEqual(acts[0].steps.map((s) => [s.do, s.id]), [['click', 1]], 'the click went by the read_window id');
  assert.deepEqual(acts[1].steps[0], { do: 'scroll', direction: 'down', amount: 3 });
  assert.deepEqual(acts[2].steps[0], { do: 'click_text', text: 'Upload' });
  assert.ok(handsCalls().some((c) => c[0] === 'capture'), 'the screenshot went through the helper');
  assert.ok(Array.isArray(r[5].result?.content) && r[5].result.content.some((c) => c.type === 'image'), 'take_screenshot gives the model a picture');
});
if (HANDS_OK) await cp('CP-7 loop guard: 4th identical no-change scroll refused; a take_screenshot resets the count', async () => {
  // The loop guard: the same scroll on a window that never changes is refused on the fourth try.
  made.nextTurn?.();
  const scroll = ['act_in_app', { target: 'front', steps: [{ do: 'scroll', direction: 'down' }] }];
  const g = await play([scroll, scroll, scroll, scroll]);
  assert.deepEqual(g.map((x) => x.ok && !String(x.result).startsWith(LOOP_MESSAGE.slice(0, 20))), [true, true, true, false], `fourth identical scroll refused: ${JSON.stringify(g.map((x) => x.result))}`);
  assert.match(text(g[3].result), /nothing changed after 3 tries/);
  assert.equal(text(g[3].result), LOOP_MESSAGE);
  assert.match(LOOP_MESSAGE, /take_screenshot/, 'the refusal tells the model to look and try a different step');
  // Looking resets it: after a take_screenshot the same scroll runs again (and is counted from one).
  const again = await play([['take_screenshot', { target: 'front' }], scroll, scroll, scroll, scroll]);
  assert.deepEqual(again.map((x) => x.ok), [true, true, true, true, false], `count restarts after a look: ${JSON.stringify(again.map((x) => text(x.result).slice(0, 60)))}`);
  // A different step also breaks the run.
  const other = await play([['act_in_app', { target: 'front', steps: [{ do: 'click', id: 1 }] }], scroll]);
  assert.deepEqual(other.map((x) => x.ok), [true, true], 'a different step lets the scroll run again');
});
if (!HANDS_OK) console.log('e2e-classic: screen steps skipped (macOS and Windows only)');

// 3. Opening a tab: a link opens in the browser, a bare address is a link, and typing an address into the browser bar
// goes straight to it. Unsafe targets never reach the browser.
if (OPEN_OK) await cp('CP-6 open URL/tab: links and bare addresses open, unsafe targets blocked, typed address goes straight', async () => {
  const r = await play([
    ['open', { target: 'https://youtube.com/studio' }],
    ['open', { target: 'example.com/docs' }],
    ['open', { target: 'file:///etc/passwd' }],
    ['open', { target: 'javascript:alert(1)' }],
  ]);
  assert.equal(r[0].result, 'Opened https://youtube.com/studio.');
  assert.equal(r[1].result, 'Opened https://example.com/docs.', 'a bare address opens as a link');
  assert.equal(r[2].ok, false); assert.match(r[2].result, /Blocked for safety/);
  assert.equal(r[3].ok, false); assert.match(r[3].result, /Blocked for safety/);
  if (HANDS_OK) {
    const [t] = await play([['act_in_app', { target: 'browser', steps: [{ do: 'key', key: 'cmd+l' }, { do: 'type', text: 'skool.com' }, { do: 'key', key: 'return' }] }]]);
    assert.ok(t.ok, t.result);
    assert.match(t.result, /went straight to the address/);
  }
  const o = opened();
  assert.ok(o.some((l) => l.endsWith('https://youtube.com/studio')), `opened: ${o}`);
  assert.ok(o.some((l) => l.endsWith('https://example.com/docs')));
  assert.ok(!o.some((l) => /passwd|javascript/.test(l)), 'blocked targets never reached the browser');
  if (HANDS_OK) assert.ok(o.some((l) => /https:\/\/skool\.com/.test(l)), `typed address opened as a link: ${o}`);
}); else console.log('e2e-classic: open skipped on Windows (no fake Start-Process)');

// 4. Drawing: a flow diagram and a mind-map-style list card go to the overlay as draw segments with their marks.
await cp('CP-9 draw: a flow diagram reaches the overlay; a broken one is refused', async () => {
  made.nextTurn?.();
  ui.length = 0;
  const r = await play([['draw', { beats: [{ say: 'Live hands the long task to an operator.', marks: [{ kind: 'flow', title: 'Handoff', nodes: [{ id: 'a', text: 'Live call', shape: 'round' }, { id: 'b', text: 'Long task?', shape: 'diamond' }, { id: 'c', text: 'Operator agent' }], links: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'yes' }] }] }] }]]);
  assert.ok(r[0].ok, text(r[0].result));
  const draws = ui.filter((m) => m.e?.type === 'draw');
  assert.ok(draws.length >= 1, 'the overlay got a drawing');
  const marks = draws.flatMap((d) => d.e.marks ?? d.e.beats?.flatMap((b) => b.marks) ?? []);
  const flow = marks.find((m) => m.kind === 'flow');
  assert.ok(flow, `a flow mark was sent: ${JSON.stringify(draws.map((d) => d.e)).slice(0, 400)}`);
  assert.deepEqual(flow.nodes.map((n) => n.text), ['Live call', 'Long task?', 'Operator agent']);
  // A broken diagram comes back as the model's error, nothing drawn.
  ui.length = 0;
  const [bad] = await play([['draw', { beats: [{ say: 'Oops.', marks: [{ kind: 'flow', nodes: [{ id: 'a', text: 'A' }], links: [{ from: 'a', to: 'zz' }] }] }] }]]);
  assert.equal(bad.ok, false, 'a link to a missing node is refused');
  assert.equal(ui.filter((m) => m.e?.type === 'draw').length, 0);
});

// 5. The web: web_fetch never reaches this computer or the local network; a public page comes back as text; web_search
// with no side search uses the keyless engines (fetch stubbed with one result page).
await cp('CP-4 web: web_fetch blocks local addresses and reads a public page; web_search returns results', async () => {
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (/93\.184\.215\.14/.test(u)) return new Response('<html><head><title>Jarvis</title></head><body><h1>Jarvis notes</h1><p>The operator agent takes long tasks.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('<html><body><div class="result"><h2><a class="result__a" href="https://example.com/jarvis-assistant">Jarvis desktop assistant release notes</a></h2><a class="result__snippet">Jarvis desktop assistant v0.2.6 adds a loop guard.</a></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const r = await play([
      ['web_fetch', { url: 'http://127.0.0.1:8080/admin' }],
      ['web_fetch', { url: 'http://localhost/' }],
      ['web_fetch', { url: 'http://192.168.1.1/' }],
      ['web_fetch', { url: 'https://93.184.215.14/notes', prefer_llms_txt: false }],
      ['web_search', { query: 'jarvis desktop assistant release notes' }],
    ]);
    for (const x of r.slice(0, 3)) assert.match(text(x.result), /Blocked|blocked|not allowed|private|local/i, `local address refused: ${text(x.result)}`);
    assert.ok(!fetched.some((u) => /127\.0\.0\.1|localhost|192\.168/.test(u)), `nothing local was fetched: ${fetched}`);
    assert.match(text(r[3].result), /The operator agent takes long tasks\./, `a public page is read: ${text(r[3].result).slice(0, 300)}`);
    assert.match(text(r[4].result), /Jarvis desktop assistant release notes/, `search results: ${text(r[4].result).slice(0, 300)}`);
    assert.match(text(r[4].result), /https:\/\/example\.com\/jarvis-assistant/);
  } finally { globalThis.fetch = realFetch; }
});

// 6. Subagents: send_agent starts a researcher in the real worker and its report becomes news for the chat; an
// operator gets the screen tools and the loop guard; a bad launch says so instead of going quiet.
await cp('CP-8 subagents: researcher report reaches the chat; operator runs screen tools loop-guarded; one operator at a time', async () => {
  const { agentsRoot, createAgents } = await import('../agents.mjs');
  const { checkOpen, checkRead, checkWrite } = await import('../safety.mjs');
  const events = [];
  let onEnd = null;
  const mgr = createAgents({
    fork, root: agentsRoot(), userName: 'Eric', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
    config: { model: async () => ({ provider: 'anthropic', model: 'fake', route: 'api' }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {} },
    ui: (m) => {
      if (m.kind === 'hands') return;
      events.push(m.e);
      if (m.e.type === 'ask') setTimeout(() => mgr.answer(m.e.agent.id, true), 20);
      if (['done', 'fail', 'gone'].includes(m.e.type)) onEnd?.(m.e);
    },
  });
  const ended = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no result in 20 s: ${JSON.stringify(events.map((e) => e.type))}`)), 20_000);
    onEnd = (e) => { clearTimeout(t); onEnd = null; resolve(e); };
  });
  const send = mgr.tools.find((t) => t.name === 'send_agent');
  try {
    const end1 = ended();
    const started = await send.execute({ type: 'researcher', title: 'Latest LLM releases', brief: 'Find out the latest LLM releases.' });
    assert.match(started, /^Started a\w* "Latest LLM releases" \(researcher, returns answer\) in .+\. .*the launch is your reply\.$/s, started);
    const e1 = await end1;
    assert.equal(e1.type, 'done', e1.agent?.reason);
    const news = mgr.news().find((n) => n.id === e1.agent.id);
    assert.equal(news.report, 'GPT-6 and Claude 6 both came out this week.\nSources: https://example.com/news', 'the report comes back to the chat');
    assert.match(await mgr.tools.find((t) => t.name === 'agent_report').execute({ id: e1.agent.id }), /Report: GPT-6 and Claude 6/);

    process.env.FAKE_LOG = path.join(tmp, 'fake-operator.log');
    const end2 = ended();
    const op = await send.execute({ type: 'operator', title: 'YouTube info cards', brief: 'Add the five cards from the doc to the video.' });
    assert.match(op, /\(operator, returns answer\)/);
    const e2 = await end2;
    assert.equal(e2.type, 'done', e2.agent?.reason);
    const opLog = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([...opLog[0].tools].sort(), ['act_in_app', 'finish', 'list_windows', 'open', 'plan', 'read_window', 'take_screenshot']);
    assert.deepEqual(opLog.filter((l) => l.name === 'act_in_app').map((l) => l.isError), [false, false, false, true], 'the operator is loop-guarded');

    await assert.rejects(send.execute({ type: 'researcher', title: 'Bad', brief: 'x', continue: 'nope42' }), /The launch failed, so there is no agent/);

    // Two operators would fight over the mouse: the second is refused while the first runs.
    process.env.FAKE_LOG = path.join(tmp, 'fake-operator2.log');
    const end3 = ended();
    await send.execute({ type: 'operator', title: 'First operator', brief: 'Add the cards.' });
    await assert.rejects(send.execute({ type: 'operator', title: 'Second operator', brief: 'Also add the cards.' }), /An operator is already working on the screen/);
    assert.equal((await end3).type, 'done', 'the first operator still finishes');
  } finally { mgr.stopAll(); }
});

// 7. Safety holds with actions switched off: nothing writes or acts, the model is told how to turn them on; looking still works.
await cp('CP-5/CP-6 allowActions off: act_in_app and write refused with the Allow message; take_screenshot and read_window still work', async () => {
  const off = createTools({ allowActions: () => false, ask: async () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Eric', workdir: tmp, fileDir: () => brain });
  const w = off.tools.find((t) => t.name === 'write_file');
  await assert.rejects(w.execute({ path: '_context/off.md', content: 'x' }, { toolCallId: 'o1' }), /switched off/);
  assert.ok(!fs.existsSync(path.join(brain, '_context', 'off.md')));
  if (HANDS_OK) {
    const ot = (n) => off.tools.find((t) => t.name === n);
    fs.writeFileSync(handsLog, '');
    await assert.rejects(ot('act_in_app').execute({ target: 'front', steps: [{ do: 'click', id: 1 }] }, { toolCallId: 'o2' }), /turn on "Allow File Edits & Commands"/);
    assert.ok(!handsCalls().some((c) => c[0] === 'act'), 'nothing reached the hands helper');
    assert.match(await ot('read_window').execute({ target: 'front' }, { toolCallId: 'o3' }), /Video \+/, 'read_window works with actions off');
    const shot = await ot('take_screenshot').execute({ target: 'front' }, { toolCallId: 'o4' });
    assert.ok(Array.isArray(shot?.content) && shot.content.some((c) => c.type === 'image'), 'take_screenshot works with actions off');
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`e2e-classic tests: passed (${passed.length} critical paths)`);

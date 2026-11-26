// A Live call learns, the way a Classic conversation does when it ends: what was said in the call (his words, her
// words, the tools and what they returned) is kept as text, and the hang-up hands it to the same memory pass, whose
// facts are saved. A call where he said nothing hands over nothing. And with a second brain set, the prompt says to
// look there before ever saying "I don't know" about him. The real call, brain and store; a fake Live transport and a
// fake side model. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-livememory-'));
process.env.HOME = process.env.USERPROFILE = TMP;
process.env.JARVIS_DATA_DIR = path.join(TMP, 'data');
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const { z } = await import('zod');
const { createLiveBrain, LIVE_GUIDANCE } = await import('../livebrain.mjs');
const { createLiveCall } = await import('../livecall.mjs');
const { memoryFacts } = await import('../brain.mjs');
const S = await import('../store.mjs');
const { secondBrainBlock } = await import('../secondbrain.mjs');

const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};
const fakeConnect = (calls) => async (params) => {
  const s = { params, sendRealtimeInput() {}, sendClientContent() {}, sendToolResponse() {}, close() {}, server: (m) => params.callbacks.onmessage(m) };
  calls.push(s);
  return s;
};
const setup = (tools = []) => {
  const calls = [], ended = [];
  const call = createLiveCall({
    makeBrain: async (emit) => createLiveBrain({ emit, connect: fakeConnect(calls), key: 'k', tools, system: () => 'You are Jarvis.' }),
    ui() {}, send() {}, ask: async () => null, toClassic() {},
    onEnd: (messages, why) => ended.push({ messages, why }),
  });
  return { calls, call, ended };
};

{ // A call where he says who he is: the hang-up hands the call's words to the memory pass, and its facts are saved.
  const tools = [{ name: 'read_file', description: 'Read.', parameters: z.object({ path: z.string() }), execute: async () => 'Channel: youtube.com/@EricTech' }];
  const { calls, call, ended } = setup(tools);
  await call.toggle();
  await until(() => calls.length === 1);
  const s = calls[0];
  s.server({ serverContent: { inputTranscription: { text: "I'm Eric, I run" } } });
  s.server({ serverContent: { inputTranscription: { text: ' a YouTube channel about AI.' } } });
  s.server({ toolCall: { functionCalls: [{ id: 'r1', name: 'read_file', args: { path: '_context/index.md' } }] } });
  await new Promise((r) => setTimeout(r, 20)); // the tool answers
  s.server({ serverContent: { outputTranscription: { text: 'Nice to meet you, Eric.' } } });
  s.server({ serverContent: { turnComplete: true } });
  s.server({ serverContent: { inputTranscription: { text: 'Fill in my name' } } }); // still talking when he hangs up
  call.hangUp('esc');
  assert.equal(ended.length, 1, 'the hang-up hands the call over once');
  assert.equal(ended[0].why, 'esc');
  const m = ended[0].messages;
  assert.deepEqual(m.filter((x) => x.role === 'user').map((x) => x.content), ["I'm Eric, I run a YouTube channel about AI.", 'Fill in my name'], 'his words, a half-said turn included');
  assert.ok(m.some((x) => x.role === 'assistant' && x.content.some((p) => p.type === 'tool_call' && p.name === 'read_file')), 'the tool she used');
  assert.ok(m.some((x) => x.role === 'tool' && /youtube\.com\/@EricTech/.test(x.content[0].content)), 'and what it returned');
  assert.ok(m.some((x) => x.role === 'assistant' && x.content.some((p) => p.text === 'Nice to meet you, Eric.')), 'her words');
  assert.ok(m.findIndex((x) => x.role === 'user') < m.findIndex((x) => x.role === 'assistant'), 'his turn comes before the tool it led to');

  // The same memory pass Classic runs: the call's transcript goes to the side model, and the facts it picks are saved.
  let sent = null;
  const out = await memoryFacts({ messages: m, name: 'Eric', facts: S.listFacts(), ask: async (o) => { sent = o; return { text: '{"facts":[{"text":"Eric runs a YouTube channel about AI at youtube.com/@EricTech."}]}', model: 'fake' }; } });
  assert.match(sent.system, /pick out what to remember about Eric/);
  assert.match(sent.text, /Eric: I'm Eric, I run a YouTube channel about AI\./);
  assert.match(sent.text, /\[tool result\] Channel: youtube\.com\/@EricTech/);
  for (const f of out.facts) await S.addFact(f.text);
  assert.deepEqual(S.listFacts().map((f) => f.text), ['Eric runs a YouTube channel about AI at youtube.com/@EricTech.']);
}

{ // A call where he said nothing (opened and hung up, or only she spoke): nothing to learn, no memory pass.
  const { calls, call, ended } = setup();
  await call.toggle();
  await until(() => calls.length === 1);
  calls[0].server({ serverContent: { outputTranscription: { text: 'Hello?' } } });
  call.hangUp('tap');
  assert.deepEqual(ended, []);
  assert.equal(await memoryFacts({ messages: [], name: 'Eric', ask: async () => { throw new Error('not called'); } }), null);
}

{ // A second call starts fresh: the last call's words aren't handed over again.
  const { calls, call, ended } = setup();
  await call.toggle(); await until(() => calls.length === 1);
  calls[0].server({ serverContent: { inputTranscription: { text: 'First call.' } } });
  call.hangUp('tap');
  await call.toggle(); await until(() => calls.length === 2);
  calls[1].server({ serverContent: { inputTranscription: { text: 'Second call.' } } });
  call.hangUp('tap');
  assert.deepEqual(ended.map((e) => e.messages.map((x) => x.content)), [['First call.'], ['Second call.']]);
}

{ // With a second brain set, the prompt sends questions about him to it before any "I don't know".
  const brain = path.join(TMP, 'Brain');
  fs.mkdirSync(path.join(brain, '_context'), { recursive: true });
  fs.writeFileSync(path.join(brain, '_context', 'index.md'), '# Index');
  const block = secondBrainBlock(brain);
  assert.match(block, /about themselves[^\n]*not already in what you know about them[^\n]*look in the second brain first[^\n]*_context\/index\.md[^\n]*before ever saying you don't know/);
  fs.mkdirSync(path.join(TMP, 'Plain'));
  assert.match(secondBrainBlock(path.join(TMP, 'Plain')), /look in the second brain first[^\n]*search_files/, 'no index: search it');
  assert.match(LIVE_GUIDANCE, /never say you don't know something about them before looking/i, 'the call says it too');
}
console.log('livememory ok');

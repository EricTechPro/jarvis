// A Live call as Jarvis runs it (livecall.mjs): the talk chord's tap opens and hangs up the call, the mic goes in,
// her voice goes to the overlay's player, captions become bubbles, and a failure shows one card offering Classic.
// The brain is the real livebrain.mjs; a fake Live transport plays Gemini's side. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLiveBrain } from '../livebrain.mjs';
import { createLiveCall, liveErrorText } from '../livecall.mjs';

const fakeTransport = () => {
  const calls = [];
  const connect = async (params) => {
    const sent = [];
    const s = {
      params, sent, closed: false,
      sendRealtimeInput: (m) => sent.push({ realtime: m }),
      sendClientContent: (m) => sent.push({ content: m }),
      sendToolResponse: (m) => sent.push({ tool: m }),
      close() { s.closed = true; },
      server: (msg) => params.callbacks.onmessage(msg),
      drop: (e) => params.callbacks.onclose(e),
    };
    calls.push(s);
    return s;
  };
  return { connect, calls };
};
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
};

const setup = ({ tools = [], key = 'k', answer = null } = {}) => {
  const t = fakeTransport();
  const uis = [], sends = [], asks = [], switched = [];
  const call = createLiveCall({
    makeBrain: async (emit) => createLiveBrain({ emit, connect: t.connect, key, tools, system: () => 'You are Jarvis.' }),
    ui: (m) => uis.push(m),
    send: (m) => sends.push(m),
    ask: async (opts) => { asks.push(opts); return answer; },
    toClassic: () => switched.push('classic'),
    anim: (name) => ({ tool: 'read', label: name }),
    hangUpHint: 'tap ⌃⌥ to hang up',
  });
  return { t, call, uis, sends, asks, switched, agentEvents: () => uis.filter((m) => m.kind === 'agent').map((m) => m.e) };
};

{ // A tap opens the call and starts the mic; mic frames go in; another tap hangs up and stops the mic.
  const { t, call, uis, sends } = setup();
  assert.equal(call.open, false);
  await call.toggle();
  await until(() => t.calls.length === 1);
  assert.equal(call.open, true);
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture'), [{ type: 'live_capture', on: true }]);
  assert.ok(uis.some((m) => m.kind === 'live' && m.state === 'listening' && /Live/.test(m.hint) && /hang up/.test(m.hint)));
  call.pcm('AQACAA==');
  assert.deepEqual(t.calls[0].sent.at(-1), { realtime: { audio: { data: 'AQACAA==', mimeType: 'audio/pcm;rate=16000' } } });
  await call.toggle();
  assert.equal(call.open, false);
  assert.equal(t.calls[0].closed, true);
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture').at(-1), { type: 'live_capture', on: false });
  assert.ok(uis.some((m) => m.kind === 'speech' && m.stop));
  assert.equal(uis.filter((m) => m.kind === 'live').at(-1).state, 'closed');
  call.pcm('AQACAA=='); // hung up: nothing goes anywhere
  assert.equal(t.calls[0].sent.length, 1);
}

{ // Her voice goes to the player, cutting in stops it at once, and the captions become bubbles.
  const { t, call, uis, agentEvents } = setup();
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  s.server({ serverContent: { inputTranscription: { text: 'What time' } } });
  s.server({ serverContent: { inputTranscription: { text: ' is it?' } } });
  assert.deepEqual(uis.filter((m) => m.kind === 'live' && m.heard).map((m) => m.heard), ['What time', 'What time is it?']);
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] }, outputTranscription: { text: "It's" } } });
  s.server({ serverContent: { outputTranscription: { text: ' noon.' } } });
  const speech = uis.filter((m) => m.kind === 'speech');
  assert.deepEqual(speech[0], { kind: 'speech', id: speech[0].id, rate: 24000, pcm: 'AAAA' });
  assert.ok(uis.findIndex((m) => m.turn) < uis.findIndex((m) => m.kind === 'agent'), 'the listening bubble makes way first');
  s.server({ serverContent: { turnComplete: true } });
  const ev = agentEvents();
  assert.deepEqual(ev.map((e) => e.type), ['start', 'text', 'text', 'done']);
  assert.deepEqual(ev.filter((e) => e.type === 'text').map((e) => e.text), ["It's", ' noon.']);
  assert.equal(ev.at(-1).speech, speech[0].id);
  assert.ok(uis.some((m) => m.kind === 'speech' && m.end && m.id === speech[0].id));
  // Cutting in: playback stops now, and her half-said reply ends.
  s.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BBBB' } }] }, outputTranscription: { text: 'Also' } } });
  const before = uis.length;
  s.server({ serverContent: { interrupted: true } });
  const after = uis.slice(before);
  assert.deepEqual(after[0], { kind: 'speech', stop: true });
  assert.ok(after.some((m) => m.kind === 'agent' && m.e.type === 'done'));
  assert.equal(call.open, true, 'cutting in keeps the call open');
}

{ // A tool Gemini calls shows its tag, as in Classic.
  const tools = [{ name: 'list_commitments', description: 'List.', parameters: (await import('zod')).z.object({}), execute: async () => 'none' }];
  const { t, call, agentEvents } = setup({ tools });
  await call.toggle();
  await until(() => t.calls.length === 1);
  t.calls[0].server({ toolCall: { functionCalls: [{ id: 'c1', name: 'list_commitments', args: {} }] } });
  await until(() => agentEvents().some((e) => e.type === 'tool_end'));
  const ev = agentEvents();
  assert.deepEqual(ev.find((e) => e.type === 'tool'), { type: 'tool', id: 'c1', anim: { tool: 'read', label: 'list_commitments' } });
  assert.deepEqual(ev.find((e) => e.type === 'tool_end'), { type: 'tool_end', id: 'c1', isError: false });
}

{ // A bad key hangs up and shows one card: its words point to the key, and its first button switches to Classic.
  const { t, call, uis, sends, asks, switched } = setup({ answer: 'yes' });
  await call.toggle();
  await until(() => t.calls.length === 1);
  t.calls[0].drop({ code: 1008, reason: 'API key not valid' });
  await until(() => switched.length === 1);
  assert.equal(call.open, false);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].placeholder, liveErrorText('key'));
  assert.match(asks[0].placeholder, /Gemini key/);
  assert.deepEqual(asks[0].choices, ['Switch to Classic', 'Not now']);
  assert.deepEqual(sends.filter((m) => m.type === 'live_capture').at(-1), { type: 'live_capture', on: false });
  assert.equal(uis.filter((m) => m.kind === 'live').at(-1).state, 'closed');
}

{ // "Not now" leaves the mode alone; no key at all gives the key card too.
  const { call, asks, switched } = setup({ key: null, answer: null });
  await call.toggle();
  await until(() => asks.length === 1);
  assert.equal(asks[0].placeholder, liveErrorText('key'));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(switched, []);
  assert.equal(call.open, false);
}

{ // Hanging up from outside (a mode switch, sleep, quit): the call closes; with no call it does nothing.
  const { t, call, sends } = setup();
  assert.equal(call.hangUp('sleep'), false);
  assert.deepEqual(sends, []);
  await call.toggle();
  await until(() => t.calls.length === 1);
  assert.equal(call.hangUp('sleep'), true);
  assert.equal(t.calls[0].closed, true);
  assert.equal(call.open, false);
}

{ // Hung up while the call was still being set up: it never opens.
  const t = fakeTransport();
  let release;
  const sends = [];
  const call = createLiveCall({
    makeBrain: (emit) => new Promise((r) => { release = () => r(createLiveBrain({ emit, connect: t.connect, key: 'k', tools: [], system: '' })); }),
    ui: () => {}, send: (m) => sends.push(m), ask: async () => null, toClassic: () => {},
  });
  const opening = call.toggle();
  call.hangUp('switch');
  release();
  await opening;
  assert.equal(call.open, false);
  assert.equal(t.calls.length, 0);
}

{ // Agent news goes into an open call; with no call it is left for Classic.
  const { t, call } = setup();
  assert.equal(call.news('(news)'), false);
  await call.toggle();
  await until(() => t.calls.length === 1);
  assert.equal(call.news('(news)'), true);
  assert.deepEqual(t.calls[0].sent.at(-1), { realtime: { text: '(news)' } });
  assert.equal(call.busy(), false);
}

{ // sidekick.mjs wires it up: a mode switch, sleep and quit hang up; the helper hears the mode with its settings.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const menuBranch = src.slice(src.indexOf('/^voicemode_(classic|live)$/'), src.indexOf('/^voicemode_(classic|live)$/') + 300);
  assert.match(menuBranch, /liveCall\.hangUp\('switch'\)[^]*saveConfig\(\)/, 'hangs up before saving the new mode');
  assert.match(menuBranch, /voiceConfig\(\)/);
  assert.match(src, /m\.type === 'system_sleep'\) liveCall\.hangUp\('sleep'\)/);
  assert.match(src, /\.on\('close', \(\) => \{[^]{0,200}liveCall\.hangUp\('quit'\)/);
  assert.match(src, /type: 'voice_config',[^\n]*live: voiceModeOf\(config\) === 'live'/);
  assert.match(src, /m\.type === 'live_toggle'\) \{ if \(voiceModeOf\(config\) === 'live'\)/, 'a tap only calls in Live mode');
}

console.log('livecall tests passed');

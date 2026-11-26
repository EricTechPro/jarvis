// A Live call as Jarvis runs it (livecall.mjs): the talk chord's tap opens and hangs up the call, the mic goes in,
// her voice goes to the overlay's player, captions become bubbles, and a failure shows one card offering Classic.
// The brain is the real livebrain.mjs; a fake Live transport plays Gemini's side. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLiveBrain } from '../livebrain.mjs';
import { createLiveCall, liveErrorText } from '../livecall.mjs';
import { holdAfterLaunch } from '../agents.mjs';

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

const setup = ({ tools = [], key = 'k', answer = null, newTurn } = {}) => {
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
    newTurn,
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

{ // Each of their turns in the call is a new request, as in Classic: after send_agent the rest of that turn is held,
  // and a tool in their next turn runs.
  const { z } = await import('zod');
  let requestNo = 0;
  const ran = [];
  const tools = holdAfterLaunch([
    { name: 'send_agent', description: 'Agent.', parameters: z.object({}), execute: async () => { ran.push('send_agent'); return 'launched'; } },
    { name: 'list_commitments', description: 'List.', parameters: z.object({}), execute: async () => { ran.push('list'); return 'none'; } },
  ], () => requestNo);
  const { t, call } = setup({ tools, newTurn: () => { requestNo++; } });
  await call.toggle();
  await until(() => t.calls.length === 1);
  const s = t.calls[0];
  const answered = (id) => s.sent.find((m) => m.tool?.functionResponses[0].id === id)?.tool.functionResponses[0].response.output;
  s.server({ serverContent: { inputTranscription: { text: 'Send an agent.' } } });
  assert.equal(requestNo, 1);
  s.server({ toolCall: { functionCalls: [{ id: 'a1', name: 'send_agent', args: {} }] } });
  await until(() => answered('a1'));
  s.server({ toolCall: { functionCalls: [{ id: 'a2', name: 'list_commitments', args: {} }] } });
  await until(() => answered('a2'));
  assert.match(answered('a2'), /^Not done: an agent just launched/);
  s.server({ serverContent: { turnComplete: true } });
  s.server({ serverContent: { inputTranscription: { text: 'What is on my list?' } } });
  assert.equal(requestNo, 2);
  s.server({ toolCall: { functionCalls: [{ id: 'a3', name: 'list_commitments', args: {} }] } });
  await until(() => answered('a3'));
  assert.equal(answered('a3'), 'none');
  assert.deepEqual(ran, ['send_agent', 'list']);
  call.hangUp('tap');
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

{ // The mic card names the cause: a refused permission points to the Privacy settings, any other mic trouble stays general.
  assert.match(liveErrorText('mic_permission'), /Privacy settings/);
  assert.match(liveErrorText('mic_permission'), /Classic/);
  assert.doesNotMatch(liveErrorText('mic'), /Privacy/);
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

{ // Esc hangs up an open call like a tap does, logged as Esc; while it is still being made, Esc drops it unlogged.
  const t = fakeTransport();
  const logs = [];
  let release;
  const call = createLiveCall({
    makeBrain: (emit) => new Promise((r) => { release = () => r(createLiveBrain({ emit, connect: t.connect, key: 'k', tools: [], system: '' })); }),
    ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {}, log: (event, data) => logs.push([event, data]),
  });
  const opening = call.toggle();
  assert.equal(call.hangUp('esc'), true);
  release();
  await opening;
  assert.equal(call.open, false);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(logs.filter(([e]) => e === 'live_end'), [], 'a call that never opened has no end');
  const second = call.toggle();
  release();
  await second;
  await until(() => t.calls.length === 1);
  assert.equal(call.hangUp('esc'), true);
  assert.equal(t.calls[0].closed, true);
  assert.equal(logs.find(([e]) => e === 'live_end')[1].why, 'esc');
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

{ // A crop (look) goes into the open call, or opens one and goes in once it is listening, never lost while it connects.
  const img = Buffer.from([7, 8]);
  const frames = (s) => s.sent.filter((m) => m.realtime?.video);
  { // open call: straight in
    const { t, call } = setup();
    await call.toggle();
    await until(() => t.calls.length === 1);
    await call.look(img, 'image/png');
    assert.deepEqual(frames(t.calls[0]), [{ realtime: { video: { data: img.toString('base64'), mimeType: 'image/png' } } }]);
  }
  { // no call: opens one, then sends once
    const { t, call } = setup();
    await call.look(img, 'image/png');
    assert.equal(call.open, true);
    assert.equal(frames(t.calls[0]).length, 1);
  }
  { // still connecting: held, then sent when listening
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = fakeTransport();
    const call = createLiveCall({
      makeBrain: async (emit) => createLiveBrain({ emit, connect: async (p) => { await gate; return t.connect(p); }, key: 'k', tools: [], system: () => 'x' }),
      ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {},
    });
    const opening = call.toggle();
    await until(() => call.open);
    const crop = call.look(img, 'image/png');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.calls.length, 0);
    release();
    await Promise.all([opening, crop]);
    assert.equal(frames(t.calls[0]).length, 1);
  }
  { // hung up while it waited: nothing is sent to a later call
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = fakeTransport();
    const call = createLiveCall({
      makeBrain: async (emit) => createLiveBrain({ emit, connect: async (p) => { await gate; return t.connect(p); }, key: 'k', tools: [], system: () => 'x' }),
      ui: () => {}, send: () => {}, ask: async () => null, toClassic: () => {},
    });
    const opening = call.toggle();
    await until(() => call.open);
    call.look(img, 'image/png');
    call.hangUp('tap');
    release();
    await opening;
    await call.toggle();
    await until(() => t.calls.length >= 1);
    assert.equal(t.calls.flatMap(frames).length, 0);
    call.hangUp('tap');
  }
}

{ // sidekick.mjs: in Live the crop goes through liveCall.look and skips the Classic listen/ask; Escape returns before it.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function areaSnap()'), src.indexOf('let snapping = false'));
  assert.match(fn, /if \(res\.cancelled\) return;[^]*voiceModeOf\(config\) === 'live'[^]*liveCall\.look\(/);
}

{ // sidekick.mjs wires it up: a mode switch, sleep and quit hang up; the helper hears the mode with its settings.
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const menuBranch = src.slice(src.indexOf('function switchVoiceMode(mode)'), src.indexOf('function switchVoiceMode(mode)') + 400);
  assert.match(menuBranch, /liveCall\.hangUp\('switch'\)[^]*saveConfig\(\)/, 'hangs up before saving the new mode');
  assert.match(menuBranch, /voiceConfig\(\)/);
  assert.match(src, /m\.type === 'system_sleep'\) liveCall\.hangUp\('sleep'\)/);
  assert.match(src, /\.on\('close', \(\) => \{[^]{0,200}liveCall\.hangUp\('quit'\)/);
  assert.match(src, /type: 'voice_config',[^\n]*live: voiceModeOf\(config\) === 'live'/);
  assert.match(src, /m\.type === 'live_toggle'\) \{ if \(voiceModeOf\(config\) === 'live'\)/, 'a tap only calls in Live mode');
  assert.match(src, /m\.type === 'live_hangup'\) liveCall\.hangUp\(m\.via === 'esc' \? 'esc' : 'tap'\)/, "the overlay's Esc hangs up through the same path");
  // Live mode starts the helper even with Classic talking off (macOS: the only helper with a Live mic).
  assert.match(src, /const liveTalk = \(\) => MAC && voiceModeOf\(config\) === 'live';/);
  assert.match(src, /type: 'voice_config', enabled: VOICE_OK && \(liveTalk\(\) \|\| \(config\.voice && voiceReady\(\)\)\),/);
  // One source for the helper's live mode: voice_config. A restarted helper is sent the whole config again.
  assert.match(src, /m\.type === 'voice_ready'\) \{[^\n]*voiceConfig\(\);/);
  assert.doesNotMatch(src, /type: 'live_mode'/);
  const rust = fs.readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(rust, /Some\("live_mode"\)/, 'Rust has no separate live_mode message');
  // The Live prompt: Classic's live state without its Voice line (hold to talk, a pause sends), and making it leaves
  // the facts the last Classic request used alone (touchFacts marks those after the reply).
  assert.match(src, /const liveSystem = \(\) => \{ const l = livePrompt\('', \{ live: true \}\);/);
  const lp = src.slice(src.indexOf('const livePrompt = '), src.indexOf('return { turn, memory };', src.indexOf('const livePrompt = ')));
  assert.match(lp, /const livePrompt = \(context = '', \{ live = false \} = \{\}\) => \{/);
  assert.match(lp, /if \(!live\) lastFactIds = facts\.map/);
  assert.match(lp, /\$\{live \? LIVE_VOICE_LINE\(\) : VOICE_OK \? `- Voice: /, 'Live has its own Voice line');
  assert.match(src, /toClassic: \(\) => switchVoiceMode\('classic'\),/, "the error card's Switch to Classic is the same switch");
  // One path starts a request in both modes: Classic per message, Live per turn of theirs in the call.
  assert.match(src, /const startRequest = \(\) => \(requestNo = nextTurn\(\)\);/);
  assert.match(src, /const turn = startRequest\(\);/, 'Classic starts its request through it');
  assert.match(src.slice(src.indexOf('const liveCall = createLiveCall(')), /^[^]{0,900}newTurn: startRequest,/, 'Live starts each turn through it');
}

console.log('livecall tests passed');

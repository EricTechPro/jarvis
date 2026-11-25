// The overlay in a Live call (showcase/jarvis/host.js): the call's listening bubble shows what they say, and an
// Allow that's open stays open while they talk (in Classic, starting to talk closes it as a no). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const noop = () => {};
const calls = [];
const el = () => new Proxy({ style: {}, setAttribute: noop, addEventListener: noop, focus: noop, blur: noop }, { get: (t, k) => (k in t ? t[k] : noop) });
const bubbles = [];
const bubble = (kind, opts) => { const h = { kind, opts, text: '', closed: false, busy: false, set(t) { h.text = t; return h; }, processing() { h.busy = true; return h; }, close() { h.closed = true; }, end() { h.closed = true; }, append() {}, focus() {}, get open() { return !h.closed; } }; bubbles.push(h); return h; };
const agent = { visible: true, pos: { x: 0, y: 0, r: 10 }, hide: noop, setAuto: noop, show: () => false, act: noop, working: noop, hush: noop, typing: () => false,
  listen: (o) => bubble('listen', o), prompt: (o) => bubble('prompt', o), say: (_, o) => bubble('say', o), think: () => bubble('think') };
const window = {
  __TAURI__: { core: { invoke: (cmd, args) => { calls.push([cmd, args]); return Promise.resolve(true); } } },
  Jarvis: { ptr: () => false, tiles: [{ creature: { agent } }] },
};
const ctx = {
  window, Jarvis: window.Jarvis, navigator: { platform: 'MacIntel' }, performance, Math, JSON, Promise, Set, Map, Array, Object, String, Number, RegExp, Date,
  document: { createElement: el, addEventListener: noop, body: el(), hidden: false },
  addEventListener: noop, setTimeout: noop, clearTimeout: noop, clearInterval: noop, setInterval: () => 0,
  matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: noop, innerWidth: 1512, innerHeight: 982,
};
vm.runInNewContext(fs.readFileSync(new URL('../../../jarvis/host.js', import.meta.url), 'utf8'), ctx);
const host = window.__jarvisHost;
const answers = () => calls.filter(([c, a]) => c === 'sidecar_send' && a.msg.type === 'answer');

host({ kind: 'live', state: 'connecting', hint: 'Live · Connecting…' });
assert.equal(bubbles.at(-1).opts.placeholder, 'Live · Connecting…');
host({ kind: 'live', state: 'listening', hint: 'Live · Listening… tap ⌃+⌥ to hang up' });
const listening = bubbles.at(-1);
assert.equal(listening.opts.placeholder, 'Live · Listening… tap ⌃+⌥ to hang up', 'the bubble says it is Live');
host({ kind: 'live', heard: 'What time is it?' });
assert.equal(listening.text, 'What time is it?');
host({ kind: 'live', state: 'thinking' });
assert.equal(listening.busy, true);
host({ kind: 'live', turn: true });
assert.equal(listening.closed, true, 'her reply takes the bubble');

// An Allow opens; they keep talking in the call: it stays open, nothing is answered for them.
host({ kind: 'ask', id: 'a1', placeholder: 'Run this command?', choices: ['Allow', "Don't allow"] });
const allow = bubbles.at(-1);
host({ kind: 'live', heard: 'yes go ahead' });
host({ kind: 'live', state: 'listening' });
assert.equal(allow.closed, false);
assert.deepEqual(answers(), []);
// Classic's listening state still closes it as a no (unchanged).
host({ kind: 'voice', type: 'state', state: 'listening' });
assert.equal(allow.closed, true);
assert.equal(answers()[0][1].msg.text, null);

host({ kind: 'live', state: 'closed' });
assert.ok(bubbles.filter((b) => b.kind === 'listen').every((b) => b.closed), 'hanging up closes the bubble');
console.log('host live tests: passed');

// A Live call as Jarvis runs it: the glue between the Live brain (livebrain.mjs) and the rest of the app. A tap of the
// talk chord opens or hangs up the call (toggle), the helper's mic frames go in (pcm), her voice goes to the overlay's
// player as speech chunks, cutting in stops it at once, captions become bubbles (yours in the listening bubble, hers
// as a reply in the agent stream, the same one Classic uses), and the tool tags show as in Classic. A failure hangs up
// and shows one card offering Classic. Overlay messages (through ui):
//   {kind:'live', state, hint}  connecting | listening | thinking | closed; hint: the listening bubble's words
//   {kind:'live', heard}        what they're saying, so far
//   {kind:'live', turn:true}    she's answering: the listening bubble makes way for her reply
// The helper hears {type:'live_capture', on} (through send) to start and stop the call's mic.
import { toolLog } from './safety.mjs';

const ERRORS = {
  key: 'Live mode needs a Gemini key. Add one on the Speaking page in Settings, or switch to Classic.',
  quota: 'Gemini Live is out of quota for now. Switch to Classic to keep talking?',
  network: "I couldn't reach Gemini Live. Check the internet, or switch to Classic.",
  dropped: 'The Live call dropped. Switch to Classic to keep talking?',
  mic: "I can't use the microphone for the Live call. Switch to Classic?",
  mic_permission: "macOS isn't letting me use the microphone for the Live call. Turn on Jarvis in the Privacy settings I just opened, or switch to Classic.",
};
export const liveErrorText = (reason) => ERRORS[reason] ?? ERRORS.dropped;
export const SWITCH_TO_CLASSIC = 'Switch to Classic';
// ponytail: how long held draw marks wait for her voice before drawing anyway (a walkthrough step waiting for a click
// gets no voice until after it). A guess: needs a calibration pass on a real call, with a real mic and speakers.
export const DRAW_HOLD_MS = 5000;
// ponytail: cutting in on her locally (story 10). Mic loudness (RMS, fraction of full scale) held this long while her
// reply plays stops it before Gemini's `interrupted` arrives. A guess: needs a real-mic calibration pass by Eric (echo
// cancellation leaves some of her own voice in; too low and she cuts herself off, too high and she talks over him).
export const CUT_IN = { rms: 0.04, holdMs: 150 };

// RMS of a base64 16 kHz s16le mono frame, as a fraction of full scale, and its length in ms.
const frameLevel = (data) => {
  const b = Buffer.from(data, 'base64'), n = b.length >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 2) / 32768; sum += v * v; }
  return { rms: n ? Math.sqrt(sum / n) : 0, ms: n / 16 };
};

/**
 * makeBrain(emit): a Live brain for one call (async: the key is looked up first). ask: the app's yes/no card.
 * toClassic: switches the voice mode to Classic. anim(name): a tool's tag, as Classic shows it. hangUpHint: how to hang
 * up, for the listening bubble (a value or a function). newTurn: each of their turns in the call starts a new request,
 * the way Classic starts one per message (per-turn Allows, freshness and the hold after send_agent).
 */
export function createLiveCall({ makeBrain, ui, send, ask, toClassic, anim = () => null, hangUpHint = '', newTurn = () => {}, log = () => {}, inkStarted = () => {}, holdMs = DRAW_HOLD_MS, cutIn = CUT_IN }) {
  let brain = null, call = 0, capturing = false, opening = false;
  let ready = false, pending = []; // ready: the call is up; pending: crops waiting for it
  let turn = null; // her reply on screen: { shown, speech }
  let request; // the request their turn started (newTurn's), for the log
  let speechId = null; // the reply audio playing now
  let cutId = null, loudMs = 0; // cutId: the reply he cut in on (its late audio is dropped); loudMs: how long he's been loud
  // draw in the call: its lines are said by her after the tool answers, so its overlay segments are held here (by
  // tool call id) and released when her voice after that answer starts. answered: the answer went out.
  const held = new Map(); // id → { segs: [ui message], answered, timer }
  const release = (id, voiced) => {
    const h = held.get(id);
    if (!h) return;
    held.delete(id); clearTimeout(h.timer);
    for (const m of h.segs) ui(voiced ? m : { ...m, e: { ...m.e, beats: m.e.beats.map((b) => ({ ...b, voiced: false })) } });
  };
  const flushDraws = () => { for (const id of [...held.keys()]) release(id, false); };
  const holdTimer = (id) => { const h = held.get(id); clearTimeout(h.timer); h.timer = setTimeout(() => release(id, false), holdMs); };

  const capture = (on) => { if (capturing !== on) { capturing = on; send({ type: 'live_capture', on }); } };
  const startTurn = () => {
    if (turn) return;
    turn = { shown: '', speech: speechId };
    ui({ kind: 'live', turn: true });
    ui({ kind: 'agent', e: { type: 'start' } });
  };
  const endTurn = () => {
    if (!turn) return;
    ui({ kind: 'agent', e: { type: 'done', speech: turn.speech ?? undefined } });
    turn = null;
  };
  const closed = () => {
    flushDraws();
    ready = false; pending = [];
    capture(false);
    ui({ kind: 'speech', stop: true });
    endTurn();
    speechId = null;
    ui({ kind: 'live', state: 'closed' });
  };

  function onEvent(me, e) {
    if (me !== call) return; // a call already hung up
    switch (e.type) {
      case 'turn':
        stats.turns++;
        request = newTurn();
        return;
      case 'state':
        if (e.state === 'closed') return; // closed() runs once, from hangUp or the error
        if (e.state !== 'connecting') { ready = true; for (const [d, m] of pending.splice(0)) brain?.pushImage(d, m); }
        if (e.state === 'listening') { capture(true); flushDraws(); if (turn && !speechId) endTurn(); }
        if (e.state !== 'speaking') ui({ kind: 'live', state: e.state, hint: e.state === 'listening' ? `Live · Listening… ${typeof hangUpHint === 'function' ? hangUpHint() : hangUpHint}`.trim() : undefined });
        return;
      case 'audio':
        stats.voice++;
        if (e.id === cutId) return;
        for (const [id, h] of [...held]) if (h.answered) release(id, true);
        speechId = e.id;
        if (turn) turn.speech ??= e.id;
        ui({ kind: 'speech', id: e.id, rate: e.rate, pcm: e.pcm });
        return;
      case 'audioEnd':
        flushDraws();
        ui({ kind: 'speech', id: e.id, end: true });
        if (speechId === e.id) speechId = null;
        return;
      case 'interrupted':
        flushDraws();
        ui({ kind: 'speech', stop: true });
        speechId = null;
        endTurn();
        return;
      case 'caption':
        if (e.who === 'user') stats.heard = Math.max(stats.heard, e.text.length);
        if (e.who === 'user') { if (!e.done) ui({ kind: 'live', heard: e.text }); return; }
        startTurn();
        if (e.text.length > turn.shown.length && e.text.startsWith(turn.shown)) {
          ui({ kind: 'agent', e: { type: 'text', text: e.text.slice(turn.shown.length) } });
          turn.shown = e.text;
        }
        if (e.done) endTurn();
        return;
      case 'tool':
        log('tool', toolLog({ turn: request, id: e.id, name: e.name, args: e.args }));
        startTurn();
        ui({ kind: 'agent', e: { type: 'tool', id: e.id, anim: anim(e.name) } });
        return;
      case 'toolEnd':
        // Cancelled or failed: what it held never draws (a cancelled drawing is taken off the overlay).
        if (held.has(e.id)) { if (e.ok) { held.get(e.id).answered = true; holdTimer(e.id); } else { clearTimeout(held.get(e.id).timer); held.delete(e.id); } }
        ui({ kind: 'agent', e: { type: 'tool_end', id: e.id, isError: !e.ok } });
        return;
      case 'error':
        fail(e.reason, e.message);
    }
  }

  // A call still being made: dropped before it opens (whatever it makes is stopped), and its crops with it.
  const dropOpening = () => { opening = false; call++; pending = []; ui({ kind: 'live', state: 'closed' }); };

  // What each call heard, for the log (no words, only counts and levels): mic seconds and level, Gemini's turns,
  // how many characters it transcribed from him, and how many chunks of her voice came back.
  const newStats = () => ({ ms: 0, sq: 0, peak: 0, turns: 0, heard: 0, voice: 0 });
  let stats = newStats();
  const callStats = () => ({ micSecs: +(stats.ms / 1000).toFixed(1), micRms: +(stats.ms ? Math.sqrt(stats.sq / stats.ms) : 0).toFixed(4),
    micPeak: +stats.peak.toFixed(4), turns: stats.turns, heardChars: stats.heard, voiceChunks: stats.voice });

  function hangUp(why = 'tap') {
    if (opening) { dropOpening(); return true; }
    if (!brain) return false;
    const b = brain;
    brain = null; call++;
    b.stop();
    closed();
    log('live_end', { why, ...callStats() });
    return true;
  }

  async function fail(reason, message) {
    if (brain) { hangUp(reason); log('live_error', { reason, message: String(message ?? '').slice(0, 200) }); }
    const yes = await ask({ placeholder: liveErrorText(reason), choices: [SWITCH_TO_CLASSIC, 'Not now'] });
    if (yes) toClassic();
  }

  return {
    get open() { return !!brain || opening; },
    /** Opens the call, or hangs up the open one. */
    async toggle() {
      if (brain) return hangUp('tap');
      if (opening) return hangUp('tap');
      const me = ++call;
      opening = true;
      ui({ kind: 'live', state: 'connecting', hint: 'Live · Connecting…' });
      let b;
      try { b = await makeBrain((e) => onEvent(me, e)); } catch (err) {
        if (me !== call) return;
        dropOpening();
        return fail('network', err?.message);
      }
      if (me !== call) return b.stop(); // hung up (a mode switch, sleep) while it was being made
      opening = false;
      brain = b;
      stats = newStats();
      log('live_start', {});
      await b.start();
    },
    hangUp,
    /** A problem outside the call itself (the helper's mic): hang up and show the card. */
    fail,
    pcm(data) {
      if (!brain) return;
      brain.pushAudio(data);
      const { rms, ms } = frameLevel(data);
      stats.ms += ms; stats.sq += rms * rms * ms; stats.peak = Math.max(stats.peak, rms);
      if (!speechId) { loudMs = 0; return; }
      loudMs = rms >= cutIn.rms ? loudMs + ms : 0;
      if (loudMs < cutIn.holdMs) return;
      // He's talking over her: stop her now; Gemini's `interrupted` follows and ends the turn.
      loudMs = 0; cutId = speechId; speechId = null;
      ui({ kind: 'speech', stop: true });
    },
    pushImage(data, mimeType) { brain?.pushImage(data, mimeType); },
    /** A crop for the call: straight in when it is up, held until it is listening while it connects, and it opens a call when there is none. */
    async look(data, mimeType) {
      pending.push([data, mimeType]);
      if (!brain && !opening) await this.toggle();
      if (brain && ready) for (const [d, m] of pending.splice(0)) brain.pushImage(d, m);
    },
    /** draw's speak() while the call is open: the line is said by her after the tool answers ('later'). */
    say: () => (brain ? 'later' : false),
    /**
     * draw's overlay messages while the call is open: a segment is held until her voice for it (true: held). The tool
     * is told it started, so it answers and she can say the lines.
     */
    holdDraw(m) {
      if (!brain || m?.kind !== 'agent' || m.e?.type !== 'draw') return false;
      const { id, seg } = m.e;
      if (!held.has(id)) held.set(id, { segs: [], answered: false, timer: null });
      held.get(id).segs.push(m);
      holdTimer(id);
      setImmediate(() => inkStarted(id, seg)); // after draw starts waiting for it
      return true;
    },
    /** Busy: a call is open and something is going on in it (she's talking or thinking, or a tool runs). */
    busy: () => !!brain && !brain.quiet(),
    /** A background agent's news for the open call; false when there's no call to take it. */
    news(text) { if (!brain) return false; brain.news(text); return true; },
  };
}

/**
 * A circle drawn with the talk chord in a call (the voice helper's live_look): the circled shot goes in as a look, the
 * same as ⌃⌥A's crop, so it opens a call when there is none. prepare/read/remove: the file steps (sidekick passes
 * fitImage and node:fs); the file is the helper's temp shot and is removed either way. quiet: run before a call opens,
 * to stop a Classic reply still streaming or speaking. False: no area to look at.
 */
export async function lookAtArea(call, area, { prepare = async () => {}, read, remove = () => {}, quiet = () => {} }) {
  const file = area?.file;
  if (typeof file !== 'string' || !file) return false;
  try {
    if (!call.open) quiet(); // opening a call: stop a Classic reply first, the same as a tap of the talk chord
    await prepare(file);
    await call.look(await read(file), 'image/png');
    return true;
  } finally { remove(file); }
}

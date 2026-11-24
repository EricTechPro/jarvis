// A Live call as Jarvis runs it: the glue between the Live brain (livebrain.mjs) and the rest of the app. A tap of the
// talk chord opens or hangs up the call (toggle), the helper's mic frames go in (pcm), her voice goes to the overlay's
// player as speech chunks, cutting in stops it at once, captions become bubbles (yours in the listening bubble, hers
// as a reply in the agent stream, the same one Classic uses), and the tool tags show as in Classic. A failure hangs up
// and shows one card offering Classic. Overlay messages (through ui):
//   {kind:'live', state, hint}  connecting | listening | thinking | closed; hint: the listening bubble's words
//   {kind:'live', heard}        what they're saying, so far
//   {kind:'live', turn:true}    she's answering: the listening bubble makes way for her reply
// The helper hears {type:'live_capture', on} (through send) to start and stop the call's mic.
const ERRORS = {
  key: 'Live mode needs a Gemini key. Add one on the Speaking page in Settings, or switch to Classic.',
  quota: 'Gemini Live is out of quota for now. Switch to Classic to keep talking?',
  network: "I couldn't reach Gemini Live. Check the internet, or switch to Classic.",
  dropped: 'The Live call dropped. Switch to Classic to keep talking?',
  mic: "I can't use the microphone for the Live call. Switch to Classic?",
};
export const liveErrorText = (reason) => ERRORS[reason] ?? ERRORS.dropped;
export const SWITCH_TO_CLASSIC = 'Switch to Classic';

/**
 * makeBrain(emit): a Live brain for one call (async: the key is looked up first). ask: the app's yes/no card.
 * toClassic: switches the voice mode to Classic. anim(name): a tool's tag, as Classic shows it. hangUpHint: how to hang
 * up, for the listening bubble (a value or a function). newTurn: each of their turns in the call starts a new request,
 * the way Classic starts one per message (per-turn Allows, freshness and the hold after send_agent).
 */
export function createLiveCall({ makeBrain, ui, send, ask, toClassic, anim = () => null, hangUpHint = '', newTurn = () => {}, log = () => {} }) {
  let brain = null, call = 0, capturing = false, opening = false;
  let ready = false, pending = []; // ready: the call is up; pending: crops waiting for it
  let turn = null; // her reply on screen: { shown, speech }
  let speechId = null; // the reply audio playing now

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
        newTurn();
        return;
      case 'state':
        if (e.state === 'closed') return; // closed() runs once, from hangUp or the error
        if (e.state !== 'connecting') { ready = true; for (const [d, m] of pending.splice(0)) brain?.pushImage(d, m); }
        if (e.state === 'listening') { capture(true); if (turn && !speechId) endTurn(); }
        if (e.state !== 'speaking') ui({ kind: 'live', state: e.state, hint: e.state === 'listening' ? `Live · Listening… ${typeof hangUpHint === 'function' ? hangUpHint() : hangUpHint}`.trim() : undefined });
        return;
      case 'audio':
        speechId = e.id;
        if (turn) turn.speech ??= e.id;
        ui({ kind: 'speech', id: e.id, rate: e.rate, pcm: e.pcm });
        return;
      case 'audioEnd':
        ui({ kind: 'speech', id: e.id, end: true });
        if (speechId === e.id) speechId = null;
        return;
      case 'interrupted':
        ui({ kind: 'speech', stop: true });
        speechId = null;
        endTurn();
        return;
      case 'caption':
        if (e.who === 'user') { if (!e.done) ui({ kind: 'live', heard: e.text }); return; }
        startTurn();
        if (e.text.length > turn.shown.length && e.text.startsWith(turn.shown)) {
          ui({ kind: 'agent', e: { type: 'text', text: e.text.slice(turn.shown.length) } });
          turn.shown = e.text;
        }
        if (e.done) endTurn();
        return;
      case 'tool':
        startTurn();
        ui({ kind: 'agent', e: { type: 'tool', id: e.id, anim: anim(e.name) } });
        return;
      case 'toolEnd':
        ui({ kind: 'agent', e: { type: 'tool_end', id: e.id, isError: !e.ok } });
        return;
      case 'error':
        fail(e.reason, e.message);
    }
  }

  // A call still being made: dropped before it opens (whatever it makes is stopped), and its crops with it.
  const dropOpening = () => { opening = false; call++; pending = []; ui({ kind: 'live', state: 'closed' }); };

  function hangUp(why = 'tap') {
    if (opening) { dropOpening(); return true; }
    if (!brain) return false;
    const b = brain;
    brain = null; call++;
    b.stop();
    closed();
    log('live_end', { why });
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
      log('live_start', {});
      await b.start();
    },
    hangUp,
    /** A problem outside the call itself (the helper's mic): hang up and show the card. */
    fail,
    pcm(data) { brain?.pushAudio(data); },
    pushImage(data, mimeType) { brain?.pushImage(data, mimeType); },
    /** A crop for the call: straight in when it is up, held until it is listening while it connects, and it opens a call when there is none. */
    async look(data, mimeType) {
      pending.push([data, mimeType]);
      if (!brain && !opening) await this.toggle();
      if (brain && ready) for (const [d, m] of pending.splice(0)) brain.pushImage(d, m);
    },
    /** Busy: a call is open and something is going on in it (she's talking or thinking, or a tool runs). */
    busy: () => !!brain && !brain.quiet(),
    /** A background agent's news for the open call; false when there's no call to take it. */
    news(text) { if (!brain) return false; brain.news(text); return true; },
  };
}

// Every tool call's outcome, and a stop for loops: Classic, Live and the operator agent run the same tools, so their
// execute is wrapped here once. Each call logs a 'tool_outcome' line (ok or not, whether its result differs from that
// tool's last one, how many identical calls in a row saw nothing change, a short reason): counts only, never what the
// screen showed or what was typed. The change signal is the tool's own result (act_in_app's text ends with the window's
// title and controls as they are after the steps; a screenshot's picture), so nothing extra is captured for it.
import { createHash } from 'node:crypto';

// ponytail: identical calls that saw nothing change before the next one is refused. 3 because Eric's Live call
// scrolled a page behind a modal 17 times; a real retry rarely needs more than two. Raise it if real retries get cut off.
export const LOOP_LIMIT = 3;
export const LOOP_MESSAGE = `nothing changed after ${LOOP_LIMIT} tries: stop, take_screenshot, look at what's actually on screen and try a different step (e.g. open the control first), or ask the user.`;

// ponytail: with goals on, the same goal failing twice, or 3 failed act_in_app calls, ends act_in_app for the request.
// Eric's Live call tried one goal (tick Public, then Save) 12 ways in one turn; raise these if real work gets cut off.
export const GOAL_LIMIT = 2;
export const FAIL_LIMIT = 3;
export const STUCK_MESSAGE = "these app steps keep failing: stop, take_screenshot once to see what's actually on screen, then either hand it to the operator (send_agent with type operator and a complete brief) or tell the user what's blocking it. No more act_in_app this request.";
// A goal: act_in_app's first click, by its text or id, so rewordings of one attempt count as one. Clicks by screenshot
// pixels (click_at) are one goal, AT, wherever they land.
const AT = 'act_in_app|@pixels';
const goalOf = (name, args) => {
  const s = name === 'act_in_app' && Array.isArray(args?.steps) ? args.steps.find((x) => x?.do === 'click' || x?.do === 'click_text' || x?.do === 'click_at') : null;
  return !s ? null : s.do === 'click_at' ? AT : `${name}|${String(s.text ?? s.id ?? '').trim().toLowerCase()}`;
};

// Select all, or a delete key: a plan that clears what's there.
const wipes = (args) => (Array.isArray(args?.steps) ? args.steps : []).some((x) => x?.do === 'key'
  && /^((cmd|command|meta)\+a|delete|backspace|forward_?delete)$/i.test(String(x.key ?? '').replace(/\s/g, '')));
const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
/** What makes two calls "the same action": the tool and its arguments, except that scrolls are the same scroll on the
 *  same target whatever the amount. */
export function actionKey(name, args = {}) {
  const steps = args?.steps;
  if (name === 'act_in_app' && Array.isArray(steps) && steps.length && steps.every((s) => s?.do === 'scroll')) {
    return `act_in_app|scroll|${String(args.target ?? 'front').toLowerCase()}|${steps.map((s) => [s.direction ?? 'down', s.text ?? '', s.id ?? '', s.to_end ? 'end' : ''].join(':')).join(',')}`;
  }
  return `${name}|${JSON.stringify(sorted(args ?? {}))}`;
}
// A result's change signal: its text, plus each picture's bytes (a screenshot's text is a fixed caption, so the
// picture is what shows the screen moved).
const signalOf = (raw) => {
  const c = typeof raw === 'string' ? raw : raw?.content ?? '';
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? `image:${b.data ?? ''}` : '')).join('\n') : '';
};
// Looking is never refused: it is the step the guard itself asks for, and it changes nothing.
const LOOKS = new Set(['take_screenshot']);
// act_in_app without "Now showing:" (the helper sent no controls) says nothing about the screen, so it can't show a loop.
const saysNothing = (name, raw) => name === 'act_in_app' && typeof raw === 'string' && !/\nNow showing: /.test(raw);
const digest = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
// Why a call failed, as a short code from the helper's and the tools' error wording: never the message itself, which
// holds screen text and what was asked for. First match wins.
const REASONS = [
  [/^Blocked for safety/, 'blocked'], [/switched off/, 'actions_off'], [/said no/, 'declined'],
  [/^Stopped before (clicking|choosing)/, 'needs_yes'],
  [/Accessibility|Screen Recording permission/, 'permission'],
  [/timed out/i, 'timeout'],
  [/No matching window/i, 'no_window'],
  [/no visible text|no text "/, 'no_visible_text'],
  [/no control with id|id is out of date|No control \d+/, 'stale_id'],
  [/is in front instead of|came to the front|Couldn't bring/, 'wrong_app'],
  [/no text field called|no dropdown called/, 'no_field'],
];
const reasonOf = (msg) => REASONS.find(([re]) => re.test(msg))?.[1] ?? 'error';

/** Wraps each tool's execute in place (tools added later aren't wrapped) and returns the same array. request: the
 *  current request's number (a Classic message or a Live turn); the repeat count starts over with each new one.
 *  goals: also stop failing act_in_app by goal and count (GOAL_LIMIT, FAIL_LIMIT); off for the operator agent, whose
 *  whole job is one request. */
export function guardTools(tools, { log = () => {}, request = () => 0, goals = false } = {}) {
  let last = null; // the latest call that ran in this request: { key, sig, same, req }
  let fails = { req: null, n: 0, by: new Map() }; // failed act_in_app calls this request, in all and by goal
  const lastSig = new Map(); // tool name → its latest result's digest
  for (const t of tools) {
    const run = t.execute;
    if (typeof run !== 'function' || run.guarded) continue;
    t.execute = async function execute(args, ctx) {
      const key = actionKey(t.name, args), id = ctx?.toolCallId, t0 = Date.now(), req = request();
      if (last && last.req !== req) last = null;
      if (last?.key === key && last.same >= LOOP_LIMIT && !LOOKS.has(t.name)) {
        log('tool_outcome', { id, name: t.name, ok: false, reason: 'loop_guard', same: last.same });
        throw new Error(LOOP_MESSAGE);
      }
      const goal = goals ? goalOf(t.name, args) : null;
      if (fails.req !== req) fails = { req, n: 0, by: new Map(), pixels: 0 };
      const mine = fails; // counted into the request this call started in, even if it ends in a later one
      // FAIL_LIMIT spent on words or ids still leaves clicking by pixels GOAL_LIMIT tries in all (worked or not: a
      // click_at rarely fails): a canvas page (Google Docs) has no words for click_text to find, and a click_at from a
      // fresh screenshot is a different way in. Never one that selects all or deletes: stuck is no time to wipe a page.
      const stuck = fails.n >= FAIL_LIMIT;
      if (goals && t.name === 'act_in_app' && ((stuck && (goal !== AT || fails.pixels >= GOAL_LIMIT || wipes(args))) || (goal && (fails.by.get(goal) ?? 0) >= GOAL_LIMIT))) {
        log('tool_outcome', { id, name: t.name, ok: false, reason: 'loop_guard', fails: fails.n });
        throw new Error(STUCK_MESSAGE);
      }
      if (goals && stuck && goal === AT) fails.pixels++;
      let raw, err = null;
      try { raw = await run.call(this, args, ctx); } catch (e) { err = e; }
      if (ctx?.signal?.aborted) log('tool_outcome', { id, name: t.name, ok: false, reason: 'aborted', ms: Date.now() - t0 });
      else {
        const blind = !err && saysNothing(t.name, raw);
        const sig = err ? `error:${digest(err?.message ?? err)}` : digest(signalOf(raw));
        const prev = blind ? null : lastSig.get(t.name);
        const same = !blind && last?.key === key && last.sig === sig ? last.same + 1 : 1;
        last = { key, sig, same, req };
        if (!err && !blind) lastSig.set(t.name, sig);
        log('tool_outcome', { id, name: t.name, ok: !err, changed: err || prev == null ? null : sig !== prev, same, ms: Date.now() - t0, ...(err ? { reason: reasonOf(String(err?.message ?? err)) } : {}) });
      }
      // A goal that worked starts over (every page of a wizard ends in "Next": one goal, many pages).
      if (goals && t.name === 'act_in_app' && !ctx?.signal?.aborted) { if (err) { mine.n++; if (goal) mine.by.set(goal, (mine.by.get(goal) ?? 0) + 1); } else if (goal) mine.by.delete(goal); }
      if (err) throw err;
      return raw;
    };
    t.execute.guarded = true;
  }
  return tools;
}

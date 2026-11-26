// Every tool call's outcome, and a stop for loops: Classic, Live and the operator agent run the same tools, so their
// execute is wrapped here once. Each call logs a 'tool_outcome' line (ok or not, whether its result differs from that
// tool's last one, how many identical calls in a row saw nothing change, a short reason): counts only, never what the
// screen showed or what was typed. The change signal is the tool's own result text (act_in_app's ends with the window's
// title and controls as they are after the steps), so nothing extra is captured for it.
import { createHash } from 'node:crypto';

// ponytail: identical calls that saw nothing change before the next one is refused. 3 because Eric's Live call
// scrolled a page behind a modal 17 times; a real retry rarely needs more than two. Raise it if real retries get cut off.
export const LOOP_LIMIT = 3;
export const LOOP_MESSAGE = `nothing changed after ${LOOP_LIMIT} tries: stop, take_screenshot, look at what's actually on screen and try a different step (e.g. open the control first), or ask the user.`;

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
const textOf = (raw) => {
  const c = typeof raw === 'string' ? raw : raw?.content ?? '';
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
};
const digest = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const reasonOf = (msg) => (/^Blocked for safety/.test(msg) ? 'blocked' : /switched off/.test(msg) ? 'actions_off' : /said no/.test(msg) ? 'declined' : 'error');

/** Wraps each tool's execute in place (tools added later aren't wrapped) and returns the same array. */
export function guardTools(tools, { log = () => {} } = {}) {
  let last = null; // the latest call that ran: { key, sig, same }
  const lastSig = new Map(); // tool name → its latest result's digest
  for (const t of tools) {
    const run = t.execute;
    if (typeof run !== 'function' || run.guarded) continue;
    t.execute = async function execute(args, ctx) {
      const key = actionKey(t.name, args), id = ctx?.toolCallId, t0 = Date.now();
      if (last?.key === key && last.same >= LOOP_LIMIT) {
        log('tool_outcome', { id, name: t.name, ok: false, reason: 'loop_guard', same: last.same });
        throw new Error(LOOP_MESSAGE);
      }
      let raw, err = null;
      try { raw = await run.call(this, args, ctx); } catch (e) { err = e; }
      if (ctx?.signal?.aborted) log('tool_outcome', { id, name: t.name, ok: false, reason: 'aborted', ms: Date.now() - t0 });
      else {
        const sig = err ? `error:${digest(err?.message ?? err)}` : digest(textOf(raw));
        const prev = lastSig.get(t.name);
        const same = last?.key === key && last.sig === sig ? last.same + 1 : 1;
        last = { key, sig, same };
        if (!err) lastSig.set(t.name, sig);
        log('tool_outcome', { id, name: t.name, ok: !err, changed: err || prev == null ? null : sig !== prev, same, ms: Date.now() - t0, ...(err ? { reason: reasonOf(String(err?.message ?? err)) } : {}) });
      }
      if (err) throw err;
      return raw;
    };
    t.execute.guarded = true;
  }
  return tools;
}

// The loop guard and every tool call's outcome line (loopguard.mjs), shared by Classic, Live and the operator agent.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOOP_LIMIT, guardTools } from '../loopguard.mjs';

// A fake act_in_app whose window text is whatever `screen` holds, so a test says when the screen moved.
const setup = () => {
  const lines = [];
  const state = { screen: 'Now showing: Cards\n1 button "Video +"', runs: 0, fail: null };
  const tools = guardTools([
    { name: 'act_in_app', execute: async () => { state.runs++; if (state.fail) throw new Error(state.fail); return `In Chrome: scrolled.\n${state.screen}`; } },
    { name: 'take_screenshot', execute: async () => ({ content: [{ type: 'text', text: 'Screenshot of the front window.' }, { type: 'image', data: 'AAAA', mediaType: 'image/jpeg' }] }) },
  ], { log: (kind, data) => lines.push({ kind, ...data }) });
  const call = (name, args, id = 'c') => tools.find((t) => t.name === name).execute(args, { toolCallId: id });
  return { lines, state, call };
};
const scroll = (amount = 3) => ({ target: 'front', steps: [{ do: 'scroll', direction: 'down', amount }] });

assert.equal(LOOP_LIMIT, 3);

// The same scroll on the same target, three times with nothing changing: the fourth never runs, and says what to do.
{
  const { state, call, lines } = setup();
  for (let i = 0; i < 3; i++) await call('act_in_app', scroll(i + 1)); // amount differs: still the same scroll
  assert.equal(state.runs, 3);
  await assert.rejects(call('act_in_app', scroll()), /nothing changed after 3 tries: stop, take_screenshot, look at what's actually on screen and try a different step \(e\.g\. open the control first\), or ask the user/);
  assert.equal(state.runs, 3, 'the blocked call did not run');
  const last = lines.at(-1);
  assert.equal(last.kind, 'tool_outcome');
  assert.equal(last.ok, false); assert.equal(last.reason, 'loop_guard');
}

// Anything changing on screen resets the count.
{
  const { state, call } = setup();
  await call('act_in_app', scroll()); await call('act_in_app', scroll());
  state.screen = 'Now showing: Cards\n1 button "Video +"\n2 link "My video"';
  await call('act_in_app', scroll()); await call('act_in_app', scroll()); await call('act_in_app', scroll());
  assert.equal(state.runs, 5, 'the screen moved, so the scrolls after it count from one');
}

// A different action in between (a screenshot, the step the guard asks for) resets it too.
{
  const { state, call } = setup();
  for (let i = 0; i < 3; i++) await call('act_in_app', scroll());
  await call('take_screenshot', { target: 'front' });
  await call('act_in_app', scroll());
  assert.equal(state.runs, 4);
}

// A step that fails the same way three times is a loop too.
{
  const { state, call } = setup();
  state.fail = 'No "My video" on screen.';
  const click = { target: 'front', steps: [{ do: 'click_text', text: 'My video' }] };
  for (let i = 0; i < 3; i++) await assert.rejects(call('act_in_app', click), /No "My video"/);
  await assert.rejects(call('act_in_app', click), /nothing changed after 3 tries/);
  assert.equal(state.runs, 3);
}

// Each call's outcome is logged: ok or error, whether the window changed, how many repeats, a short reason. Never what
// the screen or the user said: no window text, no step text, no error message.
{
  const { state, call, lines } = setup();
  await call('act_in_app', scroll(), 'a1');
  await call('act_in_app', scroll(), 'a2');
  state.screen = 'Now showing: Studio\n1 button "Save"';
  await call('act_in_app', scroll(), 'a3');
  state.fail = 'Could not find "secret words"';
  await call('act_in_app', { target: 'front', steps: [{ do: 'fill', field: 'Title', text: 'my private text' }] }, 'a4').catch(() => {});
  const out = lines.filter((l) => l.kind === 'tool_outcome');
  assert.deepEqual(out.map((l) => [l.id, l.name, l.ok, l.changed]), [['a1', 'act_in_app', true, null], ['a2', 'act_in_app', true, false], ['a3', 'act_in_app', true, true], ['a4', 'act_in_app', false, null]]);
  assert.equal(out[1].same, 2, 'the second identical call with no change');
  assert.equal(out[3].reason, 'error');
  const text = JSON.stringify(lines);
  for (const w of ['Studio', 'Save', 'secret words', 'my private text', 'Cards']) assert.ok(!text.includes(w), `${w} is not logged`);
}

// An aborted call (they cut in) neither counts nor blocks.
{
  const { state, call } = setup();
  const tools = guardTools([{ name: 'act_in_app', execute: async () => { state.runs++; return 'same'; } }]);
  const ac = new AbortController(); ac.abort();
  for (let i = 0; i < 5; i++) await tools[0].execute(scroll(), { signal: ac.signal });
  assert.equal(state.runs, 5);
  void call;
}

// Wired once on the chat's shared tools, so Classic and Live both log outcomes and both stop loops.
{
  const side = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
  assert.match(side, /\nguardTools\(tools, \{ log: /);
  assert.match(side, /tools, system: liveSystem/, 'the Live brain gets the same tools array');
}

console.log('loop guard tests: passed');

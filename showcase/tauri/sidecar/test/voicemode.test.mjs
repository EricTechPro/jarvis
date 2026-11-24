// Voice mode: Classic (default) or Live, stored in config; the Settings switch and the panel show it. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE_MODE, DEFAULT_LIVE_MODEL, voiceModeOf, setVoiceMode, liveVoiceOf } from '../voicemode.mjs';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// A fresh config, an old config with no field, or a hand-edited bad value is Classic.
assert.equal(DEFAULT_VOICE_MODE, 'classic');
assert.equal(voiceModeOf({}), 'classic');
assert.equal(voiceModeOf({ voiceMode: 'banana' }), 'classic');
assert.equal(voiceModeOf({ voiceMode: 'live' }), 'live');
assert.equal(DEFAULT_LIVE_MODEL, 'gemini-3.8-live');

// Picking a mode sets it; a bad pick changes nothing and says so.
const c = {};
assert.equal(setVoiceMode(c, 'live'), true);
assert.equal(c.voiceMode, 'live');
assert.equal(setVoiceMode(c, 'classic'), true);
assert.equal(c.voiceMode, 'classic');
assert.equal(setVoiceMode(c, 'nope'), false);
assert.equal(c.voiceMode, 'classic');

// The Live voice: the configured one, else the one closest to the current look's voice.
assert.equal(liveVoiceOf({ liveVoice: 'Kore' }, 'Charon'), 'Kore');
assert.equal(liveVoiceOf({ liveVoice: null }, 'Charon'), 'Charon');
assert.equal(liveVoiceOf({}, 'Puck'), 'Puck');

// Wiring (sidekick.mjs runs at import, so it is read as text): defaults, menu pick that saves, panel state, panel row.
const side = src('../sidekick.mjs'), panel = src('../../../panel/panel.js');
assert.match(side, /voiceMode: DEFAULT_VOICE_MODE/);
assert.match(side, /liveVoice: null/);
assert.match(side, /liveModel: DEFAULT_LIVE_MODEL/);
const branch = side.match(/\/\^voicemode_\(classic\|live\)\$\/\.test\(id\)\)[^\n]*/)?.[0] ?? '';
assert.match(branch, /setVoiceMode\(config, id\.slice\(10\)\)/);
assert.match(branch, /saveConfig\(\)/);
assert.match(branch, /menu\(\)/);
assert.match(side, /voiceMode: voiceModeOf\(config\)/, 'panelState reports the active mode');
assert.match(panel, /picks\('Voice mode', \[\['classic', 'Classic'\], \['live', 'Live'\]\], state\.voiceMode/);
assert.match(panel, /act\(`voicemode_\$\{x\}`\)/);
console.log('voice mode tests: passed');

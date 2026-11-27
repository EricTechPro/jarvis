// Field and text matching in the macOS hands helper (src-tauri/hands/main.swift, fold): a page's "…" (one character,
// U+2026) and the three dots a model writes from a screenshot are the same label. Regression (v0.2.10, Classic,
// 2026-11-27): act_in_app fill "Add a reply..." on YouTube Studio's reply box failed with no_field, costing a model call.
// The Windows helper's fold has the same check in its self-test (cargo test). Run: npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const src = fs.readFileSync(new URL('../../src-tauri/hands/main.swift', import.meta.url), 'utf8');
const start = src.indexOf('func fold(_ s: String) -> String {');
assert.ok(start >= 0, 'main.swift has fold');
const end = src.indexOf('\n}\n', start) + 3;
const fold = src.slice(start, end);
const swiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
if (swiftc.status !== 0) {
  // No Swift toolchain (Linux/Windows CI): check the source instead.
  assert.match(fold, /\\u\{2026\}/, 'fold maps … to three dots');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-fold-'));
  const file = path.join(dir, 'main.swift');
  fs.writeFileSync(file, `import Foundation\n${fold}\nlet a = fold("Add a reply\\u{2026}"), b = fold("Add a reply...")\nprint(a == b && a.contains(b) ? "same" : "differ: \\(a) | \\(b)")\n`);
  const bin = path.join(dir, 'fold');
  const c = spawnSync('swiftc', ['-O', file, '-o', bin], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const r = spawnSync(bin, [], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.stdout.trim(), 'same', 'a label with … matches the same words typed with three dots');
}
console.log('foldellipsis ok');

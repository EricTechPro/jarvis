# AGENTS.md

Jarvis (based on Roamies): a Tauri 2 desktop app (Rust shell in `showcase/tauri/src-tauri`), a Node sidecar that runs the
agent (`showcase/tauri/sidecar`), shared browser JS in `showcase/jarvis`, macOS Swift helpers built by
`src-tauri/build.rs`, and two Windows helpers built by `build.sh` for Windows targets: voice
(`src-tauri/voice-win`, Rust + Parakeet; `--transcribe <wav>` and `--test-audio <wav>` test speech without a
Windows PC, see the top of its `main.rs`) and hands (`src-tauri/hands-win`, the twin of `hands/main.swift`: same
commands and JSON, over Win32, UI Automation and Windows OCR). Only hands-win's `logic.rs` builds off Windows, so
`cargo test` there runs its checks anywhere; `jarvis-hands --smoke` drives Notepad on a real Windows desktop (CI).
From a Mac, `cargo xwin check --target x86_64-pc-windows-msvc` type-checks the Windows code with the real SDK.

Linux (beta) uses the same voice helper (`voice-win` builds for Linux too: ALSA mic, talk keys over X11, and a
`toggle` command for `jarvis --talk` on Wayland) and no hands helper. Its shell code is `src-tauri/src/linux.rs`:
every window is an X11 window (`GDK_BACKEND=x11` on Wayland, through XWayland), the overlay lets clicks through by
region (the page reports its click areas, `host.js` → `set_hit_rects`) instead of following the cursor, and
screenshots, copying, Open at Login and AppImage-only updates live there. Debug aids: `JARVIS_TRACE=1` prints the
overlay's click areas, and in debug builds `JARVIS_TEST_AUDIO=<wav>` stands in for the microphone.

## Commands

```sh
cd showcase/tauri/sidecar && npm ci     # install sidecar deps
npm test                                # sidecar tests (reply stream, storage, pointing, safety, voice model download)
npm run build                           # bundle the sidecar into dist/
cd .. && ./build.sh dev                 # web files + sidecar + debug `cargo build`
./build.sh                              # release bundle for this OS (signs on macOS if a Developer ID is in the keychain)
```

There is no linter configured yet.

Releases: bump the version in `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, then push a matching `v*` tag (or run
`.github/workflows/release.yml` by hand). It builds a macOS DMG (Apple silicon and Intel), an unsigned Windows installer
and the Linux beta (AppImage, .deb, .rpm, built on Ubuntu 24.04 because ONNX Runtime needs glibc 2.38) into a draft
GitHub release. Mac builds are signed and notarized only when the Apple secrets are set, and ad-hoc signed otherwise.
The Linux leg may fail without stopping the release. Asset names carry no version (`Jarvis-macos-arm64.dmg`,
`Jarvis-windows-x64-setup.exe`, ...) because the one-line installers `get.sh` (macOS, Linux) and `get.ps1` (Windows,
stock PowerShell 5.1) download `releases/latest/download/<name>`. Keep the names in those scripts and in release.yml
in step. `latest.json` is written only when the updater signing key is set.

## Commits

Subject: `<emoji> [type] scope: subject`, then short bullets in the body, for example `✨ [feat] install: one-line
curl installers`. Types: ✨ feat · 🐛 fix · 🔧 chore · ♻️ refactor · 🧪 test · ⚡ perf · 📝 docs · 👷 ci · 💄 ui ·
🔒 security · ⏪ revert · 🚧 wip.

- `.githooks/commit-msg` rejects other subjects (git's own Merge, Revert and fixup! subjects pass). Enable it once
  per clone: `git config core.hooksPath .githooks`.
- Squash merges use the pull request title, so the title follows the same format; `.github/workflows/pr-title.yml`
  checks it with the same hook.

## Rules

- Every tool that touches files, commands, URLs or other apps goes through `showcase/tauri/sidecar/safety.mjs`
  (tested in `test/safety.test.mjs`); the hands helpers also refuse to type or click in the apps in `HANDS_OFF`
  (by bundle id in `hands/main.swift`, by program name in `hands-win/src/logic.rs`).
  Add a test case with every rule change.
- In-app updates read `latest.json` from the newest published release, signed with the key in the
  `TAURI_SIGNING_PRIVATE_KEY` secret. Keep `plugins.updater.pubkey` in `tauri.conf.json` matching it.
  When GitHub's release links fail, the updater falls back to the copy on the `updates` branch, which
  `.github/workflows/update-feed.yml` writes whenever a release is published; downloads go through the API.

- CI lives in `.github/workflows/ci.yml` and must stay green.
- Never commit with `--no-verify`.
- Never commit experiments (prototypes, test pages, design tools). They stay local and are listed in `.git/info/exclude`; check `git status` before every commit.
- Never commit secrets (Apple ID passwords, certificates, `~/.gg/auth.json`); signing credentials go in GitHub Actions secrets.

# AGENTS.md

Guidance for AI agents and contributors working in this repo.

## Naming — read this first

This project uses two live names plus one dead codename. Keep them straight.

| Name            | What it is                          | Where it belongs                                                                 |
| --------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| **termset**     | The **product name** + WM class     | All user-facing text: window title, `.desktop` `Name=`, README, docs, UI copy; also the X11/Wayland WM class / app id |
| **terms**       | The CLI binary / command            | `cargo run --bin terms`, the `[[bin]]` in `Cargo.toml`, usage examples (`$ terms …`) |
| **termset-cli** | The library crate                   | `[package] name` in `Cargo.toml`; referenced in code as `termset_cli`            |

Rules:

- **Use "termset" for the product** anywhere a human reads it. New user-facing
  strings say "termset".
- **`terms` is the command** and stays `terms`. Don't rename it.
- **The WM class is `"termset"`** and must stay in sync across three places so the
  launcher icon binds to the live window:
  - `src/lib.rs` — `with_name("termset", "termset")` (and `with_title("termset")`),
  - `assets/termset.desktop.in` — `StartupWMClass=termset`,
  - `scripts/install-icon.sh` — icon/desktop filenames.
  Don't change one without the others.
- **"termem" / "manyterm" / "mtm" are dead codenames.** They survive only as a
  stale-entry cleanup in `scripts/install-icon.sh` (which repins an old
  `termem.desktop` favorite) and in a few stale doc comments. Don't reintroduce
  them; do fix them when you touch the surrounding code.
- Layout files (`terminals.yml`, `termset.yml`, `workspace01.yaml`) hold real
  filesystem paths in their `dir:` fields — leave them.

## Layout

- `src/lib.rs` — core application logic: the workspace rose-tree model, the pure
  `core` functions over it, and the effectful `shell` (`State` / `App`, PTY I/O,
  winit event loop). Functional-core / imperative-shell; see the module header.
- `src/config.rs` — the on-disk YAML layout schema, parsing it into the in-memory
  `Tree`, tilde expansion, and resolving which layout file to open. The layout
  file is **read-only** to the app — never written back.
- `src/ui.rs` — rendering and chrome: palette, embedded backdrop, framebuffer
  drawing primitives, Win2k-style widgets (sidebar, inspector, context menu),
  and chrome geometry / hit-testing.
- `src/main.rs` — thin binary shim that calls into the library.
- `src/testkit.rs` — headless screenshot harness; builds the real `State` with no
  window and paints into an off-screen framebuffer. `screenshot()` captures the
  logical (1×) frame; `screenshot_physical()` runs `State::compose_physical` —
  the byte-identical frame the GUI presents, including the Retina/HiDPI upscale
  and device-resolution text overdraw — so the macOS presentation path is
  testable on a Linux box (see `retina_physical_frames` in `tests/screenshots.rs`).
- `examples/demo.rs`, `tests/screenshots.rs` — drive the app headlessly.
- `.github/workflows/macos.yml` — real-Mac CI: runs the tests on a GitHub macOS
  runner, launches the actual app there, and uploads all screenshots (harness
  PNGs + a live screen capture) as a `macos-screenshots` artifact.
- `scripts/install-icon.sh` — installs the icon + `.desktop` launcher (idempotent).
- `scripts/demo-screenshot.sh` — regenerates `demo/screenshot.png` for the README.
- `termset.svg` — the app icon.
- `assets/` — `default-termset.yml` (compiled-in default layout), `termset.desktop.in`
  (launcher template with `@PLACEHOLDERS@`), bundled `fonts/`, backdrop image.

## Layout-file resolution

- `terms <file>` → that file (leading `~` expanded; relative paths resolve to CWD).
- `terms` (no argument) → `./termset.yml` in the current directory.
- If the chosen file is missing, the compiled-in `assets/default-termset.yml`
  template is used.

## Common commands

```sh
cargo build                  # build lib + the terms binary
cargo run --bin terms <file> # run termset on a layout file
cargo test                   # run tests (includes the screenshot harness)
cargo run --example demo     # headless demo / screenshot
bash scripts/install-icon.sh # (re)install icon + launcher on GNOME
```

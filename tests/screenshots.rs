//! Integration "looks like" test. Run it and open the printed PNGs:
//!
//!     cargo test --test screenshots -- --nocapture
//!
//! Each `screenshot(..)` prints `Screenshot taken: <path>`.

use termset_cli::testkit::Harness;

/// A workspace spec in the on-disk YAML layout format.
const WORKSPACE: &str = "\
groups:
  - name: Apps
    sessions:
      - name: qwen
        dir: ~/.apps
        command: ./run-llama.sh
  - name: Diabetes
    sessions:
      - name: Meal planner
        dir: ~/diabetes/mealplanner
        command: bun run main.ts
      - name: Sugar tracker
        dir: ~/diabetes/sugar
        command: ./run.sh
  - name: Study
    sessions:
      - name: Papers
        dir: ~/papers
        command: bash
";

const SAMPLE: &str = concat!(
    "\x1b[1;32mliam@rand\x1b[0m:\x1b[1;34m~/diabetes/sugar\x1b[0m$ ls --color\r\n",
    "\x1b[1;34mdata\x1b[0m  run.sh  \x1b[1;32manalyze\x1b[0m  README.md\r\n",
    "\x1b[1;32mliam@rand\x1b[0m:\x1b[1;34m~/diabetes/sugar\x1b[0m$ cargo test\r\n",
    "\x1b[32m   Compiling\x1b[0m sugar v0.1.0\r\n",
    "\x1b[32m    Finished\x1b[0m test profile in 1.21s\r\n",
    "\x1b[31merror\x1b[0m: something went \x1b[1;31mwrong\x1b[0m on line 42\r\n",
    // Showcase the face/attribute rendering: bold, italic, underline, dim,
    // strikeout, a powerline separator, and emoji (Noto Emoji fallback).
    "\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[1;3mbold-italic\x1b[0m ",
    "\x1b[4munderline\x1b[0m \x1b[9mstrikeout\x1b[0m \x1b[2mdim\x1b[0m\r\n",
    "\x1b[7;34m\x1b[0m\x1b[44;30m master \x1b[0m\x1b[34;42m\x1b[0m\x1b[42;30m \u{2713} \x1b[0m\x1b[32m\x1b[0m\r\n",
    "emoji: \u{1F680} \u{1F525} \u{2705} \u{1F4A1} \u{2764} done\r\n",
    "\x1b[1;32mliam@rand\x1b[0m:\x1b[1;34m~/diabetes/sugar\x1b[0m$ \u{2588}\r\n",
);

#[test]
fn ui_walkthrough() {
    let mut h = Harness::new(WORKSPACE);
    eprintln!("screenshot dir: {}", h.dir().display());

    // 1. A freshly-opened leaf with no live session.
    h.select("Study/Papers");
    h.screenshot("empty-leaf");

    // 2. Real (deterministic) terminal output, with ANSI colour.
    h.select("Diabetes/Sugar tracker")
        .feed("Sugar tracker", SAMPLE);
    h.screenshot("terminal-output");

    // 3. Inspector ("info") pane open on that leaf.
    h.inspector(true);
    h.screenshot("inspector-open");

    // 4. A group selected (fans out / shows first session under it).
    h.inspector(false).select("Diabetes");
    h.screenshot("group-selected");

    // 5. Hovering a window-control traffic light reveals all three glyphs.
    h.hover_win(Some(2));
    h.screenshot("win-hover");

    // 6. Sidebar toggled off (⌘B / Ctrl+Shift+B): terminal takes the full width.
    h.hover_win(None)
        .select("Diabetes/Sugar tracker")
        .sidebar(false);
    h.screenshot("sidebar-hidden");
}

/// The two context menus. Open the printed PNGs and check the item lists and
/// the group dividers against the intended shape:
///
/// * tab (sidebar): Start / Stop / Close, no dividers.
/// * terminal content: Copy / Paste / Paste + Enter | Search Google | Submit.
#[test]
fn context_menus() {
    let mut h = Harness::new(WORKSPACE);
    eprintln!("screenshot dir: {}", h.dir().display());
    h.select("Diabetes/Sugar tracker")
        .feed("Sugar tracker", SAMPLE);

    // Right-click a tab in the sidebar.
    h.mouse_at(90.0, 150.0).ctx_sidebar();
    h.screenshot("ctx-tab");

    // Right-click terminal content, pointer over a word so the search entry
    // (and therefore its dividers) is present.
    h.mouse_at(430.0, 120.0).ctx_terminal();
    h.screenshot("ctx-terminal");
}

/// The frame a Mac actually *presents*: the physical compose, i.e. the
/// nearest-neighbour shape upscale plus the crisp device-resolution text
/// overdraw that only runs when `scale > 1`. On a 1× Linux dev box this path
/// otherwise never executes — this is the on-Linux stand-in for launching the
/// app on a Retina display. Open the printed PNGs to review.
#[test]
fn retina_physical_frames() {
    // 2.0 = a real Retina display; the window is 2200×1440 physical px.
    let mut h = Harness::with_window(WORKSPACE, 2200, 1440, 2.0);
    eprintln!("screenshot dir: {}", h.dir().display());
    h.select("Diabetes/Sugar tracker")
        .feed("Sugar tracker", SAMPLE);
    h.screenshot_physical("retina2x-terminal");
    h.inspector(true);
    h.screenshot_physical("retina2x-inspector");
    h.inspector(false).sidebar(false);
    h.screenshot_physical("retina2x-no-sidebar");

    // Fractional DPI (e.g. a scaled external display): the hardest case for
    // the upscale's edge math.
    let mut f = Harness::with_window(WORKSPACE, 1650, 1080, 1.5);
    f.select("Diabetes/Sugar tracker")
        .feed("Sugar tracker", SAMPLE);
    f.screenshot_physical("retina1-5x-terminal");

    // 1×: physical == logical; the compose must degrade to a straight copy.
    let mut o = Harness::with_window(WORKSPACE, 1100, 720, 1.0);
    o.select("Diabetes/Sugar tracker")
        .feed("Sugar tracker", SAMPLE);
    o.screenshot_physical("plain1x-terminal");
}

/// The macOS fix: the UI is laid out in logical pixels, so a 2× Retina
/// display must produce a pixel-identical frame to a 1× display of the same
/// logical size — only the final upscale differs.
#[test]
fn retina_parity() {
    let mut a = Harness::with_window(WORKSPACE, 1100, 720, 1.0);
    a.select("Study/Papers").feed("Papers", SAMPLE);
    let lo = a.screenshot("scale1x");

    let mut b = Harness::with_window(WORKSPACE, 2200, 1440, 2.0);
    b.select("Study/Papers").feed("Papers", SAMPLE);
    let hi = b.screenshot("scale2x");

    let (da, db) = (std::fs::read(&lo).unwrap(), std::fs::read(&hi).unwrap());
    assert_eq!(
        da, db,
        "logical frame must be identical at 1x and 2x (macOS parity)"
    );
}

/// The licensing modals (feature-gated): the unregistered nag and the
/// key-entry dialog, empty and in its error state. Open the printed PNGs to
/// review the Win2k dialog chrome.
#[cfg(feature = "licensing")]
#[test]
fn licensing_modals() {
    let mut h = Harness::new(WORKSPACE);
    eprintln!("screenshot dir: {}", h.dir().display());

    h.select("Diabetes/Sugar tracker")
        .feed("Sugar tracker", SAMPLE);
    h.nag();
    h.screenshot("license-nag");

    // Hover feedback: the pointer over "Buy License" lifts that button.
    h.mouse_at(422.0, 405.0);
    h.screenshot("license-nag-hover");

    // Press feedback: "Continue" held down (sunken) with the pointer over it.
    h.mouse_at(678.0, 405.0).press_modal_btn(2);
    h.screenshot("license-nag-press");

    h.enter_key(
        "TS-DEMO-KEY-eyJuYW1lIjoiQWRhIiwicHJvZHVjdCI6InRlcm1zZXQifQ",
        false,
    );
    h.screenshot("license-enter-key");

    h.enter_key("this-is-not-a-valid-key", true);
    h.screenshot("license-enter-key-error");
}

//! tmux control-mode backend: sessions that outlive the app and can be
//! attached from anywhere (`ssh` from a phone, another machine, …).
//!
//! Instead of forking a PTY per tab, each leaf gets a **tmux session** on a
//! dedicated server socket (default `termset`, so the user's own tmux is
//! untouched), and the tab talks to it through one `tmux -C` *control mode*
//! client per session. Control mode is a line protocol over the client's
//! stdin/stdout — no PTY, no status bar, no alternate-screen takeover:
//!
//!   * pane output arrives as `%output %<pane> <octal-escaped bytes>`
//!     notifications, which we unescape and feed straight into the tab's own
//!     `alacritty_terminal::Term` (native rendering, native scrollback,
//!     native selection — tmux never draws anything);
//!   * commands we write (`send-keys`, `refresh-client`, …) are each answered
//!     by a `%begin … %end`/`%error` reply block, in order;
//!   * `%exit` (or EOF) means the client is done — session killed, server
//!     gone, or we detached.
//!
//! Because the session lives on the server, quitting termset merely detaches:
//! reopening the same layout re-attaches (`new-session -A`) and backfills the
//! scrollback via `capture-pane`. An external `tmux -L termset attach -t
//! <name>` sees the exact same shell — that is the point.
//!
//! Layer split mirrors the crate: the protocol (`Parser`, `unescape`,
//! `sanitize_name`) is pure and unit-tested; only `spawn`/`Client` touch
//! processes. Nothing here knows about winit — events surface through a plain
//! callback so the module is testable headlessly.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use alacritty_terminal::event::EventListener;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::Term;
use alacritty_terminal::vte::ansi;

// ===========================================================================
// pure protocol layer
// ===========================================================================

/// Undo control mode's output escaping: `\ooo` (exactly three octal digits)
/// becomes one byte; everything else passes through. tmux escapes `\`, DEL and
/// all bytes < 0x20 this way and sends UTF-8 high bytes raw, so a literal
/// backslash always arrives as `\134` and the grammar is unambiguous.
pub(crate) fn unescape(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let oct = |b: u8| (b'0'..=b'7').contains(&b);
        if data[i] == b'\\' && i + 3 < data.len() && data[i + 1..i + 4].iter().all(|&b| oct(b)) {
            let v = (data[i + 1] - b'0') as u32 * 64
                + (data[i + 2] - b'0') as u32 * 8
                + (data[i + 3] - b'0') as u32;
            out.push(v as u8);
            i += 4;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    out
}

/// A tmux session name a leaf can legally wear. `:` and `.` are target-syntax
/// metacharacters (forbidden in names), and whitespace/control chars only
/// cause quoting grief for someone typing `tmux attach -t <name>` on a phone —
/// all become `-`. Never empty (tmux rejects that too).
pub(crate) fn sanitize_name(raw: &str) -> String {
    let s: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c == ':' || c == '.' || c.is_whitespace() || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    if s.is_empty() { "session".into() } else { s }
}

/// One semantic line of the control-mode stream, as classified by [`Parser`].
#[derive(Debug, PartialEq)]
pub(crate) enum Line {
    /// Pane output (already unescaped). The pane id is dropped: each client is
    /// attached to a one-window, one-pane session, so there is only one source.
    Output(Vec<u8>),
    /// A complete `%begin … %end`/`%error` command reply, with its raw content
    /// lines. Replies arrive strictly in the order commands were written.
    Reply { lines: Vec<Vec<u8>>, error: bool },
    /// The client is finished (detached, session killed, or server exited).
    Exit,
}

/// Line-at-a-time state machine over the control-mode stream. The only state
/// is "inside a reply block or not": tmux never nests blocks and never
/// interleaves notifications *into* a block, so one `Option` suffices.
#[derive(Default)]
pub(crate) struct Parser {
    block: Option<Vec<Vec<u8>>>,
}

impl Parser {
    /// Classify one raw line (trailing `\n`/`\r` tolerated). Returns `None`
    /// for lines that don't complete an event: block interiors, `%begin`, and
    /// notifications we deliberately ignore (`%layout-change`,
    /// `%sessions-changed`, …).
    pub(crate) fn feed_line(&mut self, raw: &[u8]) -> Option<Line> {
        let mut line = raw;
        while let [rest @ .., b'\n' | b'\r'] = line {
            line = rest;
        }
        if let Some(block) = &mut self.block {
            if line.starts_with(b"%end") {
                return Some(Line::Reply {
                    lines: self.block.take().unwrap(),
                    error: false,
                });
            }
            if line.starts_with(b"%error") {
                return Some(Line::Reply {
                    lines: self.block.take().unwrap(),
                    error: true,
                });
            }
            block.push(line.to_vec());
            return None;
        }
        if line.starts_with(b"%begin") {
            self.block = Some(Vec::new());
            return None;
        }
        if let Some(rest) = line.strip_prefix(b"%output ") {
            // "%output %<pane> <data>" — data starts after the first space
            // past the pane id (and may itself be empty).
            let data = match rest.iter().position(|&b| b == b' ') {
                Some(sp) => &rest[sp + 1..],
                None => &[][..],
            };
            return Some(Line::Output(unescape(data)));
        }
        if let Some(rest) = line.strip_prefix(b"%extended-output ") {
            // "%extended-output %<pane> <age> ... : <data>" (only sent when
            // pause mode is on — we don't enable it, but parse it anyway so a
            // future flag can't silently eat output).
            if let Some(pos) = rest.windows(3).position(|w| w == b" : ") {
                return Some(Line::Output(unescape(&rest[pos + 3..])));
            }
            return None;
        }
        if line == b"%exit" || line.starts_with(b"%exit ") {
            return Some(Line::Exit);
        }
        None
    }
}

/// Stitch a `capture-pane` reply back into a byte stream for the local `Term`:
/// drop the blank tail (capture pads to the full pane height), join with CRLF,
/// and leave the final line unterminated so the cursor lands right after the
/// prompt — the same place it is in the live pane.
fn join_capture(lines: &[Vec<u8>]) -> Vec<u8> {
    let end = lines
        .iter()
        .rposition(|l| !l.is_empty())
        .map_or(0, |i| i + 1);
    let mut out = Vec::new();
    for (i, line) in lines[..end].iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(line);
    }
    out
}

/// `TSINFO <pane_pid>` — our handshake marker line (see [`spawn`]). Content
/// match instead of block counting so an unexpected extra reply can't shift
/// the frame.
fn parse_tsinfo(line: &[u8]) -> Option<u32> {
    let rest = line.strip_prefix(b"TSINFO ")?;
    std::str::from_utf8(rest).ok()?.trim().parse().ok()
}

// ===========================================================================
// effectful layer — the control client process
// ===========================================================================

/// Everything needed to place a session on the server.
pub(crate) struct Spawn {
    /// Server socket name (`tmux -L <socket>`); isolates us from the user's own tmux.
    pub socket: String,
    /// Session name on that socket (see [`sanitize_name`]).
    pub session: String,
    /// Working directory for a *newly created* session (adoption keeps the
    /// existing one, which is what you want — the shell may have `cd`'d away).
    pub workdir: Option<PathBuf>,
    pub cols: u16,
    pub lines: u16,
}

/// What the reader thread reports upward. The embedder maps these onto its own
/// event loop (the GUI turns them into `UserEvent`s; tests into a channel).
#[derive(Debug, PartialEq)]
pub(crate) enum Event {
    /// New output landed in the `Term` — repaint when convenient.
    Wakeup,
    /// The client is gone (session killed, detached, server died, spawn hung
    /// up). Always the last event.
    Exit,
    /// The pane's shell pid, learned during the handshake. Feeds the same
    /// `/proc` observation the PTY backend uses (the server is local, so the
    /// pane's shell is a local process like any other).
    ShellPid(u32),
}

/// Handle for writing to a live control client. All methods are fire-and-
/// forget: replies come back on the reader thread, and by the time a write
/// can fail the reader has already reported `Exit`, so errors are ignored.
pub(crate) struct Client {
    stdin: Arc<Mutex<ChildStdin>>,
}

impl Client {
    fn cmd(&self, line: &str) {
        if let Ok(mut w) = self.stdin.lock() {
            let _ = w.write_all(line.as_bytes());
            let _ = w.write_all(b"\n");
            let _ = w.flush();
        }
    }

    /// Type raw bytes into the pane. `send-keys -H` takes hex byte arguments,
    /// so there is no quoting problem for any input (control chars, UTF-8,
    /// bracketed paste, …). Chunked to keep command lines bounded on big pastes.
    pub(crate) fn send_bytes(&self, bytes: &[u8]) {
        for chunk in bytes.chunks(256) {
            let mut line = String::with_capacity(13 + chunk.len() * 3);
            line.push_str("send-keys -H");
            for b in chunk {
                line.push_str(&format!(" {b:02x}"));
            }
            self.cmd(&line);
        }
    }

    /// Report our grid size to the server. With `window-size latest` (set in
    /// the generated conf) the session follows the most recently active
    /// client, so the desktop keeps its size while a phone is attached small.
    pub(crate) fn resize(&self, cols: u16, lines: u16) {
        self.cmd(&format!("refresh-client -C {cols}x{lines}"));
    }

    /// Leave the session running headless on the server (app quit, tab close
    /// on a spec leaf). This is the persistence feature, not a leak.
    pub(crate) fn detach(&self) {
        self.cmd("detach-client");
    }

    /// Destroy the session outright (scratch tabs — closing one means
    /// discarding it; leaving it would strand invisible sessions on the server).
    pub(crate) fn kill_session(&self) {
        self.cmd("kill-session");
    }
}

impl Drop for Client {
    /// Dropping a live client means the tab is going away — detach rather than
    /// linger. Harmless when the client already exited (write to a dead pipe
    /// is just an ignored error) or was already told to kill its session.
    fn drop(&mut self) {
        self.detach();
    }
}

/// Is a usable tmux on PATH? Checked once per launch; failure downgrades the
/// layout's `tmux: true` to the plain PTY backend with a warning.
pub(crate) fn available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The server-side config, applied only when the *server* first starts (later
/// clients' `-f` is ignored — by then these are already set). Kept minimal and
/// regenerated every launch: this file is owned by termset, the user's own
/// `~/.tmux.conf` never loads on this socket.
const SERVER_CONF: &str = "\
# Generated by termset — rewritten on every launch, do not edit.
# Panes present as a 256-color truecolor terminal (matches the PTY backend).
set -g default-terminal \"xterm-256color\"
set -as terminal-overrides \",xterm-256color:Tc\"
set-environment -g COLORTERM truecolor
set-environment -g COLORFGBG \"15;0\"
# termset draws its own chrome; a status line would eat a grid row and skew
# the geometry between the control client and the pane.
set -g status off
# Size the window to the most recently active client, so a small phone
# attaching doesn't shrink the desktop view (it letterboxes the phone instead).
set -g window-size latest
set -s escape-time 10
set -g history-limit 10000
# The server is started empty, once, before any client connects (see spawn():
# two control clients racing to *create* a server on a fresh socket crash it —
# observed on tmux 3.4). An empty server must therefore stay alive.
set -s exit-empty off
";

/// Write the generated server conf to a stable path (once per process).
fn conf_path() -> std::io::Result<PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = crate::home_dir().join(".cache").join("termset");
        std::fs::create_dir_all(&dir).ok()?;
        let p = dir.join("tmux.conf");
        std::fs::write(&p, SERVER_CONF).ok()?;
        Some(p)
    })
    .clone()
    .ok_or_else(|| std::io::Error::other("cannot write termset tmux.conf"))
}

/// Start (or adopt — `new-session -A`) the named session and stream it into
/// `term`. Returns immediately with the write handle; a reader thread owns the
/// handshake and the output stream, reporting through `emit`:
///
///   1. `refresh-client -C` — declare our grid size *before* anything is
///      captured, so adopted content reflows to the width we will render;
///   2. `display-message` a `TSINFO <pane_pid>` line — surfaces as
///      [`Event::ShellPid`] for `/proc` observation;
///   3. adoption only: `capture-pane -peqJ` to backfill history. `%output`
///      seen *before* that reply is discarded — the server emitted it before
///      taking the capture, so those bytes are already inside it; feeding both
///      would duplicate them. A fresh session skips the capture entirely (we
///      are attached from its first byte), so nothing can be dropped.
///
/// After the handshake it is a plain pump: unescape `%output`, advance the VT
/// parser into `term`, `Wakeup`. `%exit`/EOF reaps the child and emits `Exit`.
pub(crate) fn spawn<L>(
    cfg: &Spawn,
    term: Arc<FairMutex<Term<L>>>,
    emit: impl Fn(Event) + Send + 'static,
) -> std::io::Result<Client>
where
    L: EventListener + Send + 'static,
{
    let conf = conf_path()?;
    // Make sure the server exists *before* any control client connects: two
    // clients racing to create the server on a fresh socket kill it at birth
    // ("%exit server exited unexpectedly", tmux 3.4) — and the app spawns one
    // client per leaf back-to-back. `start-server` is synchronous, idempotent,
    // and loads our conf (whose `exit-empty off` keeps the empty server alive).
    let _ = Command::new("tmux")
        .arg("-L")
        .arg(&cfg.socket)
        .arg("-f")
        .arg(&conf)
        .arg("start-server")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    // Adoption probe: decides the backfill strategy above. `=` pins an exact
    // name match (no prefix magic). Races with session creation are benign —
    // worst case a just-created empty session gets an empty backfill.
    let adopt = Command::new("tmux")
        .args(["-L", &cfg.socket, "has-session", "-t"])
        .arg(format!("={}", cfg.session))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let mut c = Command::new("tmux");
    c.arg("-L").arg(&cfg.socket).arg("-f").arg(&conf).arg("-C");
    c.arg("new-session")
        .arg("-A")
        .arg("-s")
        .arg(&cfg.session)
        .arg("-x")
        .arg(cfg.cols.max(2).to_string())
        .arg("-y")
        .arg(cfg.lines.max(2).to_string());
    if let Some(dir) = cfg.workdir.as_ref().filter(|p| p.is_dir()) {
        c.arg("-c").arg(dir);
    }
    // The client never renders (control mode), but tmux still wants a TERM.
    c.env("TERM", "xterm-256color");
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = c.spawn()?;

    let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
    let stdout = child.stdout.take().expect("piped stdout");
    let client = Client {
        stdin: stdin.clone(),
    };

    client.resize(cfg.cols, cfg.lines);
    client.cmd("display-message -p -F 'TSINFO #{pane_pid}'");
    if adopt {
        client.cmd("capture-pane -peqJ -S -10000");
    }

    std::thread::Builder::new()
        .name(format!("tmux-{}", cfg.session))
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut parser = Parser::default();
            let mut vte = ansi::Processor::<ansi::StdSyncHandler>::new();
            let mut feed = |bytes: &[u8]| {
                let mut t = term.lock();
                vte.advance(&mut *t, bytes);
                drop(t);
                emit(Event::Wakeup);
            };
            // Handshake tracking: the TSINFO reply marks the frame; when
            // adopting, the *next* reply after it is the capture.
            let mut seen_info = false;
            let mut pending_capture = adopt;
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                match parser.feed_line(&line) {
                    Some(Line::Output(bytes)) => {
                        // Pre-capture output is already inside the capture.
                        if !pending_capture {
                            feed(&bytes);
                        }
                    }
                    Some(Line::Reply { lines, error }) => {
                        if let Some(pid) = lines.iter().find_map(|l| parse_tsinfo(l)) {
                            seen_info = true;
                            emit(Event::ShellPid(pid));
                        } else if seen_info && pending_capture {
                            pending_capture = false;
                            if !error {
                                feed(&join_capture(&lines));
                            }
                        }
                    }
                    Some(Line::Exit) => break,
                    None => {}
                }
            }
            emit(Event::Exit);
            let _ = child.wait();
        })
        .expect("spawn tmux reader thread");

    Ok(client)
}

// ===========================================================================
// tests — protocol layer pure; client layer against a real tmux when present
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::Event as TermEvent;
    use alacritty_terminal::term::Config;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn unescapes_octal_and_passes_the_rest() {
        assert_eq!(unescape(br"a\134b\015\012"), b"a\\b\r\n");
        assert_eq!(unescape(br"\033[1m"), b"\x1b[1m");
        // UTF-8 high bytes arrive raw and must survive.
        assert_eq!(unescape("é日".as_bytes()), "é日".as_bytes());
        // Truncated / non-octal escapes are not escapes.
        assert_eq!(unescape(br"tail\03"), br"tail\03");
        assert_eq!(unescape(br"\09x"), br"\09x");
    }

    #[test]
    fn sanitizes_session_names() {
        assert_eq!(sanitize_name("web"), "web");
        assert_eq!(sanitize_name("api: v2.1"), "api--v2-1");
        assert_eq!(sanitize_name("  "), "session");
    }

    #[test]
    fn parses_a_control_mode_transcript() {
        // Condensed from a real `tmux -C` session (see the probes in the
        // module history): attach ack, notifications, output, a reply, exit.
        let mut p = Parser::default();
        assert_eq!(p.feed_line(b"%begin 1783494396 265 0\n"), None);
        assert_eq!(
            p.feed_line(b"%end 1783494396 265 0\n"),
            Some(Line::Reply {
                lines: vec![],
                error: false
            })
        );
        assert_eq!(p.feed_line(b"%window-add @0\n"), None);
        assert_eq!(p.feed_line(b"%session-changed $0 web\n"), None);
        assert_eq!(
            p.feed_line(b"%output %0 hi\\015\\012\n"),
            Some(Line::Output(b"hi\r\n".to_vec()))
        );
        assert_eq!(p.feed_line(b"%begin 1783494396 271 1\n"), None);
        assert_eq!(p.feed_line(b"TSINFO 4242\n"), None);
        assert_eq!(
            p.feed_line(b"%end 1783494396 271 1\n"),
            Some(Line::Reply {
                lines: vec![b"TSINFO 4242".to_vec()],
                error: false
            })
        );
        assert_eq!(parse_tsinfo(b"TSINFO 4242"), Some(4242));
        // %-lines inside a block are content, not notifications.
        assert_eq!(p.feed_line(b"%begin 1 300 1\n"), None);
        assert_eq!(p.feed_line(b"%output not a notification\n"), None);
        assert_eq!(
            p.feed_line(b"%error 1 300 1\n"),
            Some(Line::Reply {
                lines: vec![b"%output not a notification".to_vec()],
                error: true
            })
        );
        assert_eq!(p.feed_line(b"%exit\n"), Some(Line::Exit));
    }

    #[test]
    fn capture_join_trims_the_blank_tail() {
        let lines = vec![
            b"one".to_vec(),
            b"".to_vec(),
            b"three".to_vec(),
            b"".to_vec(),
            b"".to_vec(),
        ];
        assert_eq!(join_capture(&lines), b"one\r\n\r\nthree");
    }

    // ---- live-tmux integration (skipped when tmux isn't installed) --------

    #[derive(Clone)]
    struct NullListener;
    impl EventListener for NullListener {
        fn send_event(&self, _: TermEvent) {}
    }

    fn test_term() -> Arc<FairMutex<Term<NullListener>>> {
        let size = crate::TermSize {
            cols: 80,
            lines: 24,
        };
        Arc::new(FairMutex::new(Term::new(
            Config::default(),
            &size,
            NullListener,
        )))
    }

    fn grid_text(term: &Arc<FairMutex<Term<NullListener>>>) -> String {
        let t = term.lock();
        let mut out = String::new();
        for cell in t.grid().display_iter() {
            if cell.point.column.0 == 0 {
                out.push('\n');
            }
            out.push(cell.c);
        }
        out
    }

    /// Poll until the grid shows `needle` (output is asynchronous).
    fn wait_for(term: &Arc<FairMutex<Term<NullListener>>>, needle: &str) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if grid_text(term).contains(needle) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn kill_server(sock: &str) {
        let _ = Command::new("tmux")
            .args(["-L", sock, "kill-server"])
            .status();
    }

    #[test]
    fn live_roundtrip_and_adoption() {
        if !available() {
            eprintln!("tmux not installed; skipping live test");
            return;
        }
        let sock = format!("termset-test-{}", std::process::id());

        // Fresh session: spawn, learn the pid, type a command, see its output.
        let term = test_term();
        let (tx, rx) = mpsc::channel();
        let client = spawn(
            &Spawn {
                socket: sock.clone(),
                session: "it-fresh".into(),
                workdir: None,
                cols: 80,
                lines: 24,
            },
            term.clone(),
            move |e| {
                let _ = tx.send(e);
            },
        )
        .expect("spawn control client");
        let pid = loop {
            match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(Event::ShellPid(p)) => break p,
                Ok(_) => continue,
                Err(e) => {
                    kill_server(&sock);
                    panic!("no ShellPid: {e}");
                }
            }
        };
        assert!(pid > 0, "pane pid must be a real process");
        client.send_bytes(b"echo TMUX_R0UNDTRIP\r");
        assert!(
            wait_for(&term, "TMUX_R0UNDTRIP"),
            "typed output must reach the local grid"
        );

        // Adoption: content printed while detached must backfill on attach.
        let run = |args: &[&str]| {
            assert!(
                Command::new("tmux")
                    .args(["-L", &sock])
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        };
        run(&[
            "new-session",
            "-d",
            "-s",
            "it-adopt",
            "-x",
            "80",
            "-y",
            "24",
        ]);
        run(&["send-keys", "-t", "it-adopt", "echo ADOPTED_L1NE", "Enter"]);
        std::thread::sleep(Duration::from_millis(500));
        let term2 = test_term();
        let _client2 = spawn(
            &Spawn {
                socket: sock.clone(),
                session: "it-adopt".into(),
                workdir: None,
                cols: 80,
                lines: 24,
            },
            term2.clone(),
            |_| {},
        )
        .expect("spawn adopting client");
        let ok = wait_for(&term2, "ADOPTED_L1NE");
        kill_server(&sock);
        assert!(ok, "pre-attach output must be backfilled from capture-pane");
    }

    #[test]
    fn live_exit_reported_when_session_dies() {
        if !available() {
            return;
        }
        let sock = format!("termset-testx-{}", std::process::id());
        let term = test_term();
        let (tx, rx) = mpsc::channel();
        let _client = spawn(
            &Spawn {
                socket: sock.clone(),
                session: "it-exit".into(),
                workdir: None,
                cols: 80,
                lines: 24,
            },
            term,
            move |e| {
                let _ = tx.send(e);
            },
        )
        .expect("spawn control client");
        // Wait for the handshake, then kill the whole server out from under it.
        loop {
            match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(Event::ShellPid(_)) => break,
                Ok(_) => continue,
                Err(e) => {
                    kill_server(&sock);
                    panic!("no ShellPid: {e}");
                }
            }
        }
        kill_server(&sock);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Event::Exit) => return,
                Ok(_) => continue,
                Err(_) => panic!("Exit must be emitted when the server dies"),
            }
        }
    }
}

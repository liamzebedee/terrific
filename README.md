<h1><img src="termset.svg" width="40" align="top" alt=""> termset</h1>

**Save your terminal layouts.**

- Save your terminal layout to a YAML file that you can commit into git and open the same on your other devices
- Group and label terminal tabs
- Optional tmux backend: sessions survive app restarts and can be attached from anywhere — e.g. an SSH terminal app on your phone

Termset is a terminal app, written in Rust. It uses [Alacritty](https://github.com/alacritty/alacritty), a fast cross-platform OpenGL terminal emulator under the hood.

## Usage

```
$ terms terminals.yml     # open a layout file (a default layout opens if missing)
$ terms                 # use ./termset.yml in the current directory
```

![termset running a full-stack workspace](demo/screenshot.png)

`termset.yml`:

```yaml
groups:
  - name: Frontend
    sessions:
      - name: web
        dir: ~/app/web
        command: npm run dev
      - name: storybook
        dir: ~/app/web
        command: npm run storybook
      - name: claude
        dir: ~/app/web
        command: claude
  - name: Backend
    sessions:
      - name: api
        dir: ~/app/api
        command: cargo watch -x run
      - name: worker
        dir: ~/app/api
        command: cargo run --bin worker
  - name: Infra
    sessions:
      - name: postgres
        dir: ~/app
        command: docker compose up db
      - name: redis
        dir: ~/app
        command: redis-server
```

## tmux backend

Add `tmux: true` at the top of your layout file and every tab is backed by a
tmux session on a dedicated server socket (default `termset` — your own tmux
setup is untouched). termset stays a fully native terminal — no status bar, no
copy-mode; tmux runs invisibly underneath via its control-mode protocol.

```yaml
tmux: true            # requires tmux ≥ 3.2 on PATH
# tmux_socket: myproj # optional: override the socket name
groups:
  - name: Frontend
    sessions:
      - name: web
        dir: ~/app/web
        command: npm run dev
```

What you get:

- **Sessions survive the app.** Quit (or crash) and relaunch: every shell is
  still running and every tab re-attaches, scrollback included. Closing a tab
  (Ctrl+Shift+W) detaches its spec session; closing a scratch tab kills it.
- **Attach from anywhere.** Each tab is a plain tmux session named after it
  (`web`, `api`, …; duplicate names get `-2`, `-3` suffixes). From a phone SSH
  app (e.g. over Tailscale):

  ```
  $ tmux -L termset ls            # list your termset tabs
  $ tmux -L termset attach -t web # jump into one — same shell the desktop shows
  ```

  Both ends see the same session live; the window sizes to whichever client
  typed last (`window-size latest`), so a small phone doesn't shrink your
  desktop view for long.

Without `tmux: true` (the default), sessions are plain local PTYs exactly as
before. If the flag is set but tmux is missing, termset warns on stderr and
falls back to PTYs.

## Shortcuts.

Special key is assumed as macOS (Cmd), Linux (Ctrl+Shift)

 - **New tab**. Ctrl+Shift+T
 - **Close tab**. Ctrl+Shift+W
 - **Navigate up/down tab**. Ctrl+Shift+Up/Down
 - **Collapse/expand section**. Ctrl+Shift+Left/Right
 - **Start / Stop session**. Ctrl+Shift+R / Ctrl+Shift+X
 - **Copy / Paste**. Ctrl+Shift+C / Ctrl+Shift+V (or right-click)
 - **Toggle sidebar**. Ctrl+Shift+B
 - **Edit layout**. Ctrl+Shift+, (opens the YAML in nano)
 - **Quit**. Ctrl+Shift+Q


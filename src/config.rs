//! Workspace layout configuration: the on-disk YAML schema, parsing it into the
//! in-memory [`crate::Tree`], tilde expansion, and resolution of which layout
//! file / default template to open, and serializing sidebar edits.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    home_dir,
    model::{Kind, Tree},
};

/// Expand `~` / `~/...` to `$HOME`. Pure given `home`.
pub(crate) fn expand_tilde(s: &str, home: &Path) -> PathBuf {
    if s == "~" {
        home.to_path_buf()
    } else if let Some(rest) = s.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(s)
    }
}

/// The on-disk layout/config schema (YAML): top-level sessions plus named
/// groups containing sessions. This is the typed shape `serde` deserializes;
/// the UI deliberately exposes at most one level of nesting.
#[derive(Debug, Default, Deserialize)]
struct LayoutCfg {
    /// Ordered modern representation. When present it supersedes the two
    /// legacy arrays below and can preserve groups interleaved with sessions.
    #[serde(default)]
    items: Vec<ItemCfg>,
    /// Top-level sections shown in the sidebar, in order.
    #[serde(default)]
    groups: Vec<GroupCfg>,
    /// Sessions not currently in a group.
    #[serde(default)]
    sessions: Vec<SessionCfg>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum ItemCfg {
    Group(OrderedGroupCfg),
    Session(SessionCfg),
}

/// `sessions` is intentionally required here: it distinguishes a group item
/// from a session item in the untagged ordered representation.
#[derive(Debug, Deserialize, Serialize)]
struct OrderedGroupCfg {
    name: String,
    sessions: Vec<SessionCfg>,
}

/// One sidebar group.
#[derive(Debug, Deserialize, Serialize)]
struct GroupCfg {
    name: String,
    /// Sessions in this section.
    #[serde(default)]
    sessions: Vec<SessionCfg>,
}

/// One session (a leaf): a working directory and an optional default command.
#[derive(Debug, Deserialize, Serialize)]
struct SessionCfg {
    name: String,
    /// Working directory (`~` allowed). Empty/absent → `$HOME`.
    #[serde(default)]
    dir: String,
    /// Default command run by Start. Empty → a bare shell.
    #[serde(default)]
    command: String,
}

/// Top-level backend settings in the layout file, orthogonal to the tree
/// (parsed separately so the two schemas stay independent). `tmux: true` backs
/// every session with a tmux session on a dedicated server socket — sessions
/// survive app restarts and can be attached from elsewhere
/// (`tmux -L termset attach -t <name>`, e.g. over SSH from a phone).
#[derive(Debug, Default, Deserialize)]
pub(crate) struct Settings {
    /// Back sessions with tmux (requires tmux ≥ 3.2 on PATH; silently falls
    /// back to plain local PTYs, with a stderr warning, when missing).
    #[serde(default)]
    pub tmux: bool,
    /// Server socket name (`tmux -L <socket>`). Default `termset`.
    #[serde(default)]
    pub tmux_socket: Option<String>,
}

/// Parse the backend [`Settings`] out of the layout YAML. Same degrade-to-
/// default policy as [`parse_workspace`]: malformed YAML means defaults.
pub(crate) fn parse_settings(text: &str) -> Settings {
    serde_yaml::from_str(text).unwrap_or_default()
}

/// Parse the YAML layout file into a tree. Malformed YAML degrades to an empty
/// layout rather than panicking. Empty groups are discarded so the domain
/// model never contains an unselectable header with no sessions.
pub(crate) fn parse_workspace(text: &str, home: &Path) -> Tree {
    let cfg: LayoutCfg = serde_yaml::from_str(text).unwrap_or_default();

    let mut tree = Tree::empty();
    let root = tree.root;

    let items = if cfg.items.is_empty() {
        cfg.groups
            .into_iter()
            .map(|g| {
                ItemCfg::Group(OrderedGroupCfg {
                    name: g.name,
                    sessions: g.sessions,
                })
            })
            .chain(cfg.sessions.into_iter().map(ItemCfg::Session))
            .collect()
    } else {
        cfg.items
    };
    for item in items {
        let ItemCfg::Group(g) = item else {
            let ItemCfg::Session(s) = item else {
                unreachable!()
            };
            let workdir = if s.dir.trim().is_empty() {
                home.to_path_buf()
            } else {
                expand_tilde(s.dir.trim(), home)
            };
            tree.push(
                Some(root),
                s.name,
                Kind::Leaf {
                    workdir,
                    command: s.command,
                },
                false,
            );
            continue;
        };
        if g.sessions.is_empty() {
            continue;
        }
        let gid = tree.push(Some(root), g.name, Kind::Group, false);
        for s in g.sessions {
            let workdir = if s.dir.trim().is_empty() {
                home.to_path_buf()
            } else {
                expand_tilde(s.dir.trim(), home)
            };
            tree.push(
                Some(gid),
                s.name,
                Kind::Leaf {
                    workdir,
                    command: s.command,
                },
                false,
            );
        }
    }
    tree
}

/// Rewrite the editable tree portion of a layout while retaining unrelated
/// top-level settings (notably `tmux` and `tmux_socket`). Runtime-only tabs are
/// omitted. A temporary sibling plus rename avoids leaving a half-written file.
pub(crate) fn save_workspace(path: &Path, tree: &Tree) -> std::io::Result<()> {
    let old = std::fs::read_to_string(path).unwrap_or_default();
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&old)
        .unwrap_or_else(|_| serde_yaml::Value::Mapping(Default::default()));
    if !doc.is_mapping() {
        doc = serde_yaml::Value::Mapping(Default::default());
    }
    let map = doc.as_mapping_mut().expect("mapping above");
    let mut items = Vec::new();
    let session = |id: usize| {
        let n = &tree.nodes[id];
        let (workdir, command) = tree.leaf_spec(id).expect("leaf");
        SessionCfg {
            name: n.name.clone(),
            dir: workdir.display().to_string(),
            command: command.to_string(),
        }
    };
    for &id in &tree.nodes[tree.root].children {
        let n = &tree.nodes[id];
        if n.dynamic || n.volatile {
            continue;
        }
        match n.kind {
            Kind::Group if !n.children.is_empty() => items.push(ItemCfg::Group(OrderedGroupCfg {
                name: n.name.clone(),
                sessions: n
                    .children
                    .iter()
                    .copied()
                    .filter(|&c| {
                        tree.is_leaf(c) && !tree.nodes[c].dynamic && !tree.nodes[c].volatile
                    })
                    .map(&session)
                    .collect(),
            })),
            Kind::Leaf { .. } => items.push(ItemCfg::Session(session(id))),
            Kind::Group | Kind::Root => {}
        }
    }
    map.remove(serde_yaml::Value::String("groups".into()));
    map.remove(serde_yaml::Value::String("sessions".into()));
    map.insert(
        "items".into(),
        serde_yaml::to_value(items).unwrap_or_default(),
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("termset.tmp");
    std::fs::write(&tmp, serde_yaml::to_string(&doc).unwrap_or_default())?;
    std::fs::rename(tmp, path)
}

/// Which layout file to use, per the `terms` CLI:
///
/// * `terms <file>` → that file (a leading `~` is expanded; relative paths resolve
///   against the current directory).
/// * `terms` (no argument) → the per-directory layout file `./termset.yml` in the
///   current directory — so each project gets its own layout.
///
/// Either way, a missing file just opens the default layout (a `Project` group
/// with one session in the current directory; see [`default_workspace_text`]).
/// Sidebar structural edits create/rewrite this file immediately.
pub(crate) fn resolve_workspace_path() -> PathBuf {
    match std::env::args().nth(1) {
        Some(a) if !a.trim().is_empty() => expand_tilde(a.trim(), &home_dir()),
        _ => std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("termset.yml"),
    }
}

/// The on-disk template a brand-new (missing/empty) workspace opens with,
/// compiled into the binary at build time. Edit `assets/default-termset.yml`
/// to change the starting layout; `{{name}}`/`{{dir}}` are substituted by
/// [`default_workspace_text`]. Keeping it as an editable file (rather than a
/// `LayoutCfg` literal) means the default can be tweaked without touching code.
const DEFAULT_LAYOUT_TEMPLATE: &str = include_str!("../assets/default-termset.yml");

/// The tree a brand-new (missing/empty) workspace opens with: the bundled
/// [`DEFAULT_LAYOUT_TEMPLATE`] with `{{name}}`/`{{dir}}` filled in for the
/// current working directory. It remains in memory until the first sidebar edit.
pub(crate) fn default_workspace_text() -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let name = cwd
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("session");
    // YAML-escape the substituted scalars so directories/names containing
    // spaces, colons, etc. still produce valid YAML (serde quotes when needed).
    let yaml_scalar = |s: &str| {
        serde_yaml::to_string(&s)
            .unwrap_or_default()
            .trim_end()
            .to_string()
    };
    DEFAULT_LAYOUT_TEMPLATE
        .replace("{{name}}", &yaml_scalar(name))
        .replace("{{dir}}", &yaml_scalar(&cwd.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_round_trips_groups_loose_sessions_and_settings() {
        let base = std::env::temp_dir().join(format!("termset-config-test-{}", std::process::id()));
        let path = base.join("layout.yml");
        let input = "tmux: true\ntmux_socket: private\ngroups:\n  - name: Work\n    sessions:\n      - name: shell\n        dir: /tmp\n        command: ''\nsessions:\n  - name: loose\n    dir: /\n    command: pwd\n";
        let tree = parse_workspace(input, Path::new("/home/test"));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(&path, input).unwrap();
        save_workspace(&path, &tree).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("tmux: true"));
        assert!(saved.contains("tmux_socket: private"));
        let again = parse_workspace(&saved, Path::new("/home/test"));
        assert_eq!(again.nodes[again.root].children.len(), 2);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn ordered_items_survive_save_and_reload() {
        let input = "items:\n  - name: first\n    dir: /first\n  - name: Middle\n    sessions:\n      - name: nested\n        dir: /nested\n  - name: last\n    dir: /last\n";
        let tree = parse_workspace(input, Path::new("/home/test"));
        let base = std::env::temp_dir().join(format!("termset-order-test-{}", std::process::id()));
        let path = base.join("layout.yml");
        std::fs::create_dir_all(&base).unwrap();
        save_workspace(&path, &tree).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        let again = parse_workspace(&saved, Path::new("/home/test"));
        let names: Vec<_> = again.nodes[again.root]
            .children
            .iter()
            .map(|&id| again.nodes[id].name.as_str())
            .collect();
        assert_eq!(names, ["first", "Middle", "last"]);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn empty_groups_do_not_enter_the_tree() {
        let tree = parse_workspace(
            "items:\n  - name: Empty\n    sessions: []\n  - name: shell\n    dir: /tmp\n",
            Path::new("/home/test"),
        );
        assert_eq!(tree.nodes[tree.root].children.len(), 1);
        assert_eq!(tree.nodes[tree.nodes[tree.root].children[0]].name, "shell");
    }
}

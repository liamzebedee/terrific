//! Sidebar reducer.
//!
//! The window layer translates gestures and keys into [`Action`] values. This
//! module owns selection, grouping, ungrouping, rename, removal, and reorder
//! rules. It returns declarative effects to the shell and never draws, writes
//! files, spawns terminals, or depends on winit.

use std::collections::HashSet;

use crate::model::{Kind, NodeId, Placement, Row, Tree};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Command {
    Group,
    Ungroup,
    Rename,
    Close,
}

#[derive(Clone, Copy)]
pub(crate) enum RenameInput {
    Insert(char),
    Backspace,
    Delete,
    Left,
    Right,
    Home,
    End,
    Commit,
    Cancel,
}

pub(crate) enum Action {
    Press { target: NodeId, extend: bool },
    SelectOnly(NodeId),
    ContextSelect(NodeId),
    SelectRelative(i32),
    Group,
    Ungroup,
    Reorder(Placement),
    BeginRename(NodeId),
    Rename { input: RenameInput, caret: usize },
    Remove(NodeId),
}

/// Effects emitted by one atomic reducer transition.
#[derive(Default)]
pub(crate) struct Outcome {
    pub(crate) redraw: bool,
    pub(crate) persist: bool,
    pub(crate) caret: Option<usize>,
    /// A plain press on an already-selected row keeps the multi-selection so a
    /// drag can move it. Collapse it on mouse-up if no drag actually occurred.
    pub(crate) collapse_on_click: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DropPreview {
    pub(crate) placement: Placement,
}

#[derive(Clone)]
struct Rename {
    node: NodeId,
    original: String,
    select_all: bool,
}

/// All persistent interaction state for the sidebar. Fields are private so
/// event handlers cannot accidentally create an impossible selection.
pub(crate) struct State {
    primary: NodeId,
    selection: HashSet<NodeId>,
    anchor: NodeId,
    rename: Option<Rename>,
}

impl State {
    pub(crate) fn new(primary: NodeId) -> Self {
        Self {
            primary,
            selection: HashSet::from([primary]),
            anchor: primary,
            rename: None,
        }
    }

    pub(crate) fn primary(&self) -> NodeId {
        self.primary
    }

    pub(crate) fn selection(&self) -> &HashSet<NodeId> {
        &self.selection
    }

    pub(crate) fn rename_node(&self) -> Option<NodeId> {
        self.rename.as_ref().map(|rename| rename.node)
    }

    pub(crate) fn is_renaming(&self) -> bool {
        self.rename.is_some()
    }

    pub(crate) fn rows(&self, tree: &Tree) -> Vec<Row> {
        tree.rows(self.primary)
    }

    pub(crate) fn dispatch(&mut self, tree: &mut Tree, action: Action) -> Outcome {
        match action {
            Action::Press { target, extend } => self.press(tree, target, extend),
            Action::SelectOnly(node) => {
                self.select_only(node);
                Outcome {
                    redraw: true,
                    ..Outcome::default()
                }
            }
            Action::ContextSelect(node) => {
                if !self.selection.contains(&node) {
                    self.select_only(node);
                } else {
                    self.primary = node;
                    self.rename = None;
                }
                Outcome {
                    redraw: true,
                    ..Outcome::default()
                }
            }
            Action::SelectRelative(delta) => {
                let redraw = self.select_relative(tree, delta);
                Outcome {
                    redraw,
                    ..Outcome::default()
                }
            }
            Action::Group => self.group(tree),
            Action::Ungroup => self.ungroup(tree),
            Action::Reorder(placement) => self.reorder(tree, placement),
            Action::BeginRename(node) => self.begin_rename(tree, node),
            Action::Rename { input, caret } => self.rename(tree, input, caret),
            Action::Remove(node) => self.remove(tree, node),
        }
    }

    pub(crate) fn can(&self, tree: &Tree, command: Command, context: NodeId) -> bool {
        let selected = self.effective_selection(context);
        match command {
            Command::Group => {
                !selected.is_empty()
                    && selected.iter().all(|&id| {
                        tree.is_leaf(id) && !tree.nodes[id].dynamic && !tree.nodes[id].volatile
                    })
            }
            Command::Ungroup => {
                !selected.is_empty()
                    && selected.iter().all(|&id| {
                        matches!(tree.nodes[id].kind, Kind::Group)
                            && tree.nodes[id].parent == Some(tree.root)
                            && !tree.nodes[id].children.is_empty()
                    })
            }
            Command::Rename => {
                selected == [context] && matches!(tree.nodes[context].kind, Kind::Group)
            }
            Command::Close => selected == [context] && tree.is_leaf(context),
        }
    }

    /// Validate a pointer-derived candidate through the same model rule used
    /// by the eventual reorder. Rendering this result gives truthful live UI
    /// feedback: every visible marker is a drop that will actually succeed.
    pub(crate) fn drop_preview(&self, tree: &Tree, placement: Placement) -> Option<DropPreview> {
        let ids: Vec<_> = self.selection.iter().copied().collect();
        tree.can_reorder(&ids, placement)
            .then_some(DropPreview { placement })
    }

    fn effective_selection(&self, context: NodeId) -> Vec<NodeId> {
        if self.selection.contains(&context) {
            self.selection.iter().copied().collect()
        } else {
            vec![context]
        }
    }

    fn press(&mut self, tree: &Tree, target: NodeId, extend: bool) -> Outcome {
        let preserve_multi =
            !extend && self.selection.len() > 1 && self.selection.contains(&target);
        if extend {
            let rows = self.rows(tree);
            self.selection = range(tree, &rows, self.anchor, target);
            if !rows.iter().any(|row| row.id == self.anchor)
                || (tree.is_group(self.anchor) != tree.is_group(target))
            {
                self.anchor = target;
            }
        } else if !preserve_multi {
            self.select_only(target);
        }
        self.primary = target;
        self.rename = None;
        Outcome {
            redraw: true,
            collapse_on_click: preserve_multi,
            ..Outcome::default()
        }
    }

    fn select_only(&mut self, node: NodeId) {
        self.primary = node;
        self.anchor = node;
        self.selection.clear();
        self.selection.insert(node);
        self.rename = None;
    }

    fn select_relative(&mut self, tree: &Tree, delta: i32) -> bool {
        let steps = delta.unsigned_abs();
        if steps == 0 {
            return false;
        }
        let forward = delta > 0;
        let mut next = self.primary;
        for _ in 0..steps {
            let Some(node) = tree.visible_neighbor(next, self.primary, forward) else {
                return false;
            };
            next = node;
        }
        if next == self.primary {
            return false;
        }
        self.select_only(next);
        true
    }

    fn group(&mut self, tree: &mut Tree) -> Outcome {
        if !self.can(tree, Command::Group, self.primary) {
            return Outcome::default();
        }
        let ids: Vec<_> = self.selection.iter().copied().collect();
        let mut name = "Group".to_string();
        let mut suffix = 2;
        while tree.nodes[tree.root]
            .children
            .iter()
            .any(|&id| tree.nodes[id].name == name)
        {
            name = format!("Group {suffix}");
            suffix += 1;
        }
        let Some(group) = tree.group_leaves(&ids, name) else {
            return Outcome::default();
        };
        self.select_only(group);
        let original = tree.nodes[group].name.clone();
        let caret = original.chars().count();
        self.rename = Some(Rename {
            node: group,
            original,
            select_all: true,
        });
        Outcome {
            redraw: true,
            persist: true,
            caret: Some(caret),
            ..Outcome::default()
        }
    }

    fn ungroup(&mut self, tree: &mut Tree) -> Outcome {
        if !self.can(tree, Command::Ungroup, self.primary) {
            return Outcome::default();
        }
        let groups: Vec<_> = self.selection.iter().copied().collect();
        let Some(lifted) = tree.ungroup(&groups) else {
            return Outcome::default();
        };
        let Some(&primary) = lifted.first() else {
            return Outcome::default();
        };
        self.primary = primary;
        self.anchor = primary;
        self.selection = lifted.into_iter().collect();
        self.rename = None;
        Outcome {
            redraw: true,
            persist: true,
            ..Outcome::default()
        }
    }

    fn reorder(&mut self, tree: &mut Tree, placement: Placement) -> Outcome {
        let ids: Vec<_> = self.selection.iter().copied().collect();
        let changed = tree.reorder(&ids, placement);
        Outcome {
            redraw: changed,
            persist: changed,
            ..Outcome::default()
        }
    }

    fn begin_rename(&mut self, tree: &Tree, node: NodeId) -> Outcome {
        if !self.can(tree, Command::Rename, node) {
            return Outcome::default();
        }
        let original = tree.nodes[node].name.clone();
        let caret = original.chars().count();
        self.rename = Some(Rename {
            node,
            original,
            select_all: true,
        });
        Outcome {
            redraw: true,
            caret: Some(caret),
            ..Outcome::default()
        }
    }

    fn rename(&mut self, tree: &mut Tree, input: RenameInput, caret: usize) -> Outcome {
        let Some(mut rename) = self.rename.take() else {
            return Outcome::default();
        };
        let id = rename.node;
        if matches!(input, RenameInput::Cancel) {
            let persist = tree.nodes[id].name != rename.original;
            tree.set_name(id, rename.original);
            return Outcome {
                redraw: true,
                persist,
                ..Outcome::default()
            };
        }
        if matches!(input, RenameInput::Commit) {
            return Outcome {
                redraw: true,
                ..Outcome::default()
            };
        }

        let mut chars: Vec<_> = tree.nodes[id].name.chars().collect();
        let mut next_caret = caret.min(chars.len());
        let mut changed = false;
        if rename.select_all {
            match input {
                RenameInput::Insert(ch) => {
                    chars.clear();
                    chars.push(ch);
                    next_caret = 1;
                    changed = true;
                }
                RenameInput::Backspace | RenameInput::Delete => {
                    changed = !chars.is_empty();
                    chars.clear();
                    next_caret = 0;
                }
                RenameInput::Left | RenameInput::Home => next_caret = 0,
                RenameInput::Right | RenameInput::End => next_caret = chars.len(),
                RenameInput::Commit | RenameInput::Cancel => unreachable!(),
            }
            rename.select_all = false;
        } else {
            match input {
                RenameInput::Insert(ch) => {
                    chars.insert(next_caret, ch);
                    next_caret += 1;
                    changed = true;
                }
                RenameInput::Backspace if next_caret > 0 => {
                    chars.remove(next_caret - 1);
                    next_caret -= 1;
                    changed = true;
                }
                RenameInput::Delete if next_caret < chars.len() => {
                    chars.remove(next_caret);
                    changed = true;
                }
                RenameInput::Left => next_caret = next_caret.saturating_sub(1),
                RenameInput::Right if next_caret < chars.len() => next_caret += 1,
                RenameInput::Home => next_caret = 0,
                RenameInput::End => next_caret = chars.len(),
                _ => {}
            }
        }
        if changed {
            tree.set_name(id, chars.into_iter().collect());
        }
        self.rename = Some(rename);
        Outcome {
            redraw: true,
            persist: changed,
            caret: Some(next_caret),
            ..Outcome::default()
        }
    }

    fn remove(&mut self, tree: &mut Tree, node: NodeId) -> Outcome {
        let preferred = tree.unlink(node);
        if preferred.is_none() {
            return Outcome::default();
        }
        tree.prune_empty_groups();
        self.selection.retain(|&id| attached(tree, id));
        if self
            .rename
            .as_ref()
            .is_some_and(|rename| !attached(tree, rename.node))
        {
            self.rename = None;
        }
        if !attached(tree, self.primary) {
            let target = preferred
                .filter(|&id| attached(tree, id) && id != tree.root)
                .and_then(|id| tree.first_leaf(id).or(Some(id)))
                .or_else(|| tree.first_leaf(tree.root))
                .unwrap_or(tree.root);
            self.select_only(target);
        }
        Outcome {
            redraw: true,
            ..Outcome::default()
        }
    }
}

fn attached(tree: &Tree, id: NodeId) -> bool {
    if id >= tree.nodes.len() {
        return false;
    }
    let mut current = id;
    for _ in 0..=tree.nodes.len() {
        if current == tree.root {
            return true;
        }
        let Some(parent) = tree.nodes[current].parent else {
            return false;
        };
        current = parent;
    }
    false
}

fn range(tree: &Tree, rows: &[Row], anchor: NodeId, target: NodeId) -> HashSet<NodeId> {
    let (Some(start), Some(end)) = (
        rows.iter().position(|row| row.id == anchor),
        rows.iter().position(|row| row.id == target),
    ) else {
        return HashSet::from([target]);
    };
    let groups = tree.is_group(anchor) && tree.is_group(target);
    let leaves = tree.is_leaf(anchor) && tree.is_leaf(target);
    if !groups && !leaves {
        return HashSet::from([target]);
    }
    rows[start.min(end)..=start.max(end)]
        .iter()
        .filter(|row| (groups && row.is_group) || (leaves && tree.is_leaf(row.id)))
        .map(|row| row.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn tree() -> Tree {
        let mut tree = Tree::empty();
        for name in ["one", "two", "three"] {
            tree.push(
                Some(tree.root),
                name.into(),
                Kind::Leaf {
                    workdir: PathBuf::from("/tmp"),
                    command: String::new(),
                },
                false,
            );
        }
        tree
    }

    #[test]
    fn shift_replaces_instead_of_accumulating() {
        let mut tree = tree();
        let [one, two, stale] = tree.nodes[tree.root].children[..] else {
            panic!()
        };
        let mut sidebar = State::new(stale);
        sidebar.dispatch(&mut tree, Action::SelectOnly(one));
        sidebar.dispatch(
            &mut tree,
            Action::Press {
                target: two,
                extend: true,
            },
        );
        assert_eq!(sidebar.selection(), &HashSet::from([one, two]));
    }

    #[test]
    fn group_is_one_atomic_transition() {
        let mut tree = tree();
        let [one, two, three] = tree.nodes[tree.root].children[..] else {
            panic!()
        };
        let mut sidebar = State::new(one);
        sidebar.dispatch(
            &mut tree,
            Action::Press {
                target: two,
                extend: true,
            },
        );
        let outcome = sidebar.dispatch(&mut tree, Action::Group);
        let group = sidebar.primary();
        assert!(outcome.persist);
        assert_eq!(tree.nodes[group].children, [one, two]);
        assert_eq!(tree.nodes[tree.root].children, [group, three]);
        assert_eq!(sidebar.selection(), &HashSet::from([group]));
    }

    #[test]
    fn a_single_tab_can_be_grouped() {
        let mut tree = tree();
        let [one, two, three] = tree.nodes[tree.root].children[..] else {
            panic!()
        };
        let mut sidebar = State::new(two);
        let outcome = sidebar.dispatch(&mut tree, Action::Group);
        let group = sidebar.primary();
        assert!(outcome.persist);
        assert_eq!(tree.nodes[group].children, [two]);
        assert_eq!(tree.nodes[tree.root].children, [one, group, three]);
        assert_eq!(sidebar.selection(), &HashSet::from([group]));
        assert_eq!(sidebar.rename_node(), Some(group));
    }

    #[test]
    fn invalid_commands_do_not_mutate() {
        let mut tree = tree();
        let root = tree.root;
        let before = tree.nodes[tree.root].children.clone();
        let mut sidebar = State::new(root);
        let outcome = sidebar.dispatch(&mut tree, Action::Group);
        assert!(!outcome.persist);
        assert!(!sidebar.can(&tree, Command::Close, tree.root));
        assert_eq!(tree.nodes[tree.root].children, before);
    }

    #[test]
    fn bulk_close_is_disabled() {
        let mut tree = tree();
        let [one, two, _] = tree.nodes[tree.root].children[..] else {
            panic!()
        };
        let mut sidebar = State::new(one);
        sidebar.dispatch(
            &mut tree,
            Action::Press {
                target: two,
                extend: true,
            },
        );
        assert!(!sidebar.can(&tree, Command::Close, two));
    }

    #[test]
    fn first_delete_clears_a_selected_rename() {
        let mut tree = tree();
        let [one, two, _] = tree.nodes[tree.root].children[..] else {
            panic!()
        };
        let mut sidebar = State::new(one);
        sidebar.dispatch(
            &mut tree,
            Action::Press {
                target: two,
                extend: true,
            },
        );
        sidebar.dispatch(&mut tree, Action::Group);
        let group = sidebar.primary();
        let outcome = sidebar.dispatch(
            &mut tree,
            Action::Rename {
                input: RenameInput::Backspace,
                caret: 5,
            },
        );
        assert!(outcome.persist);
        assert!(tree.nodes[group].name.is_empty());
        assert_eq!(outcome.caret, Some(0));
    }

    #[test]
    fn removing_last_child_prunes_group_and_repairs_selection() {
        let mut tree = tree();
        let one = tree.nodes[tree.root].children[0];
        let two = tree.nodes[tree.root].children[1];
        let group = tree.group_leaves(&[one, two], "g".into()).unwrap();
        let mut sidebar = State::new(group);
        let children = tree.nodes[group].children.clone();
        sidebar.dispatch(&mut tree, Action::Remove(children[0]));
        sidebar.dispatch(&mut tree, Action::Remove(children[1]));
        assert!(tree.nodes[group].parent.is_none());
        assert_ne!(sidebar.primary(), group);
    }

    #[test]
    fn group_adjacency_and_group_nesting_are_distinct() {
        let mut adjacent_tree = tree();
        let one = adjacent_tree.nodes[adjacent_tree.root].children[0];
        let two = adjacent_tree.nodes[adjacent_tree.root].children[1];
        let loose = adjacent_tree.nodes[adjacent_tree.root].children[2];
        let group = adjacent_tree.group_leaves(&[one, two], "g".into()).unwrap();
        let mut adjacent = State::new(loose);
        assert!(
            adjacent
                .drop_preview(&adjacent_tree, Placement::Before(group))
                .is_some()
        );
        adjacent.dispatch(
            &mut adjacent_tree,
            Action::Reorder(Placement::Before(group)),
        );
        assert_eq!(
            adjacent_tree.nodes[adjacent_tree.root].children,
            [loose, group]
        );
        assert_eq!(adjacent_tree.nodes[group].children, [one, two]);

        let mut nested_tree = tree();
        let one = nested_tree.nodes[nested_tree.root].children[0];
        let two = nested_tree.nodes[nested_tree.root].children[1];
        let loose = nested_tree.nodes[nested_tree.root].children[2];
        let group = nested_tree.group_leaves(&[one, two], "g".into()).unwrap();
        let mut nested = State::new(loose);
        nested.dispatch(&mut nested_tree, Action::Reorder(Placement::Into(group)));
        assert_eq!(nested_tree.nodes[nested_tree.root].children, [group]);
        assert_eq!(nested_tree.nodes[group].children, [one, two, loose]);
    }
}

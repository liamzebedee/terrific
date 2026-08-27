//! Workspace domain model.
//!
//! This module contains no winit, framebuffer, context-menu, or filesystem
//! code. It owns the tree shape and the invariants for grouping, ungrouping,
//! ordering, and removing nodes. UI code projects it into rows; controllers
//! invoke these methods and decide which effects (save/redraw) to perform.

use std::path::{Path, PathBuf};

/// Stable arena identifier for a workspace node.
pub(crate) type NodeId = usize;

#[derive(Clone)]
pub(crate) enum Kind {
    Root,
    Group,
    Leaf { workdir: PathBuf, command: String },
}

pub(crate) struct Node {
    pub(crate) parent: Option<NodeId>,
    pub(crate) children: Vec<NodeId>,
    pub(crate) name: String,
    pub(crate) kind: Kind,
    pub(crate) expanded: bool,
    pub(crate) dynamic: bool,
    pub(crate) volatile: bool,
}

pub(crate) struct Tree {
    pub(crate) nodes: Vec<Node>,
    pub(crate) root: NodeId,
}

/// Read model consumed by the sidebar renderer and hit testing.
pub(crate) struct Row {
    pub(crate) id: NodeId,
    pub(crate) name: String,
    pub(crate) is_group: bool,
}

/// An explicit structural destination. Adjacency is deliberately distinct
/// from `Into`, so dropping near a group cannot unexpectedly nest rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Placement {
    Before(NodeId),
    After(NodeId),
    Into(NodeId),
    End,
}

impl Tree {
    pub(crate) fn empty() -> Self {
        let mut tree = Self {
            nodes: Vec::new(),
            root: 0,
        };
        tree.root = tree.push(None, "workspaces".into(), Kind::Root, false);
        tree
    }

    pub(crate) fn push(
        &mut self,
        parent: Option<NodeId>,
        name: String,
        kind: Kind,
        dynamic: bool,
    ) -> NodeId {
        let id = self.nodes.len();
        self.nodes.push(Node {
            parent,
            children: Vec::new(),
            name,
            kind,
            expanded: true,
            dynamic,
            volatile: false,
        });
        if let Some(parent) = parent {
            self.nodes[parent].children.push(id);
        }
        id
    }

    pub(crate) fn is_group(&self, id: NodeId) -> bool {
        matches!(self.nodes[id].kind, Kind::Group | Kind::Root)
    }

    pub(crate) fn is_leaf(&self, id: NodeId) -> bool {
        matches!(self.nodes[id].kind, Kind::Leaf { .. })
    }

    pub(crate) fn leaf_spec(&self, id: NodeId) -> Option<(&Path, &str)> {
        match &self.nodes[id].kind {
            Kind::Leaf { workdir, command } => Some((workdir.as_path(), command.as_str())),
            _ => None,
        }
    }

    pub(crate) fn command_mut(&mut self, id: NodeId) -> Option<&mut String> {
        match &mut self.nodes[id].kind {
            Kind::Leaf { command, .. } => Some(command),
            _ => None,
        }
    }

    pub(crate) fn set_workdir(&mut self, id: NodeId, dir: PathBuf) {
        if let Kind::Leaf { workdir, .. } = &mut self.nodes[id].kind {
            *workdir = dir;
        }
    }

    pub(crate) fn set_name(&mut self, id: NodeId, name: String) {
        self.nodes[id].name = name;
    }

    pub(crate) fn rows(&self, reveal: NodeId) -> Vec<Row> {
        fn visit(tree: &Tree, id: NodeId, reveal: NodeId, rows: &mut Vec<Row>) {
            for &child in &tree.nodes[id].children {
                let node = &tree.nodes[child];
                if node.volatile && child != reveal {
                    continue;
                }
                let is_group = matches!(node.kind, Kind::Group);
                rows.push(Row {
                    id: child,
                    name: node.name.clone(),
                    is_group,
                });
                if is_group && node.expanded {
                    visit(tree, child, reveal, rows);
                }
            }
        }
        let mut rows = Vec::new();
        visit(self, self.root, reveal, &mut rows);
        rows
    }

    /// Visible row adjacent to `current`, wrapping at the ends, without
    /// allocating the render rows or cloning their labels.
    pub(crate) fn visible_neighbor(
        &self,
        current: NodeId,
        reveal: NodeId,
        forward: bool,
    ) -> Option<NodeId> {
        struct Walk {
            first: Option<NodeId>,
            last: Option<NodeId>,
            previous: Option<NodeId>,
            found_current: bool,
            next: Option<NodeId>,
            saw_current: bool,
        }

        fn visit(tree: &Tree, id: NodeId, reveal: NodeId, current: NodeId, walk: &mut Walk) {
            for &child in &tree.nodes[id].children {
                let node = &tree.nodes[child];
                if node.volatile && child != reveal {
                    continue;
                }
                walk.first.get_or_insert(child);
                if walk.found_current && walk.next.is_none() {
                    walk.next = Some(child);
                }
                if child == current {
                    walk.saw_current = true;
                    walk.found_current = true;
                } else if !walk.found_current {
                    walk.previous = Some(child);
                }
                walk.last = Some(child);
                if matches!(node.kind, Kind::Group) && node.expanded {
                    visit(tree, child, reveal, current, walk);
                }
            }
        }

        let mut walk = Walk {
            first: None,
            last: None,
            previous: None,
            found_current: false,
            next: None,
            saw_current: false,
        };
        visit(self, self.root, reveal, current, &mut walk);
        if !walk.saw_current {
            return walk.first;
        }
        if forward {
            walk.next.or(walk.first)
        } else {
            walk.previous.or(walk.last)
        }
    }

    pub(crate) fn leaves(&self, id: NodeId) -> Vec<NodeId> {
        fn visit(tree: &Tree, id: NodeId, leaves: &mut Vec<NodeId>) {
            if tree.is_leaf(id) {
                leaves.push(id);
            } else {
                for &child in &tree.nodes[id].children {
                    visit(tree, child, leaves);
                }
            }
        }
        let mut leaves = Vec::new();
        visit(self, id, &mut leaves);
        leaves
    }

    pub(crate) fn group_for_new(&self, selected: NodeId) -> NodeId {
        if self.is_group(selected) {
            selected
        } else {
            self.nodes[selected].parent.unwrap_or(self.root)
        }
    }

    pub(crate) fn first_leaf(&self, id: NodeId) -> Option<NodeId> {
        self.leaves(id).into_iter().next()
    }

    /// First leaf in DFS order matching `predicate`, without materializing the
    /// subtree. Used on every repaint when a group is selected.
    pub(crate) fn first_leaf_matching(
        &self,
        id: NodeId,
        predicate: &dyn Fn(NodeId) -> bool,
    ) -> Option<NodeId> {
        if self.is_leaf(id) {
            return predicate(id).then_some(id);
        }
        for &child in &self.nodes[id].children {
            if let Some(found) = self.first_leaf_matching(child, predicate) {
                return Some(found);
            }
        }
        None
    }

    pub(crate) fn prev_sibling(&self, id: NodeId) -> Option<NodeId> {
        let parent = self.nodes[id].parent?;
        let children = &self.nodes[parent].children;
        let index = children.iter().position(|&child| child == id)?;
        index.checked_sub(1).map(|index| children[index])
    }

    pub(crate) fn unlink(&mut self, id: NodeId) -> Option<NodeId> {
        let parent = self.nodes[id].parent?;
        let target = self.prev_sibling(id).unwrap_or(parent);
        self.nodes[parent].children.retain(|&child| child != id);
        self.nodes[id].parent = None;
        Some(target)
    }

    /// Group exactly the supplied editable leaves; never accepts an empty or
    /// partial input. Returned group occupies the first selection's block.
    pub(crate) fn group_leaves(&mut self, ids: &[NodeId], name: String) -> Option<NodeId> {
        let root = self.root;
        let mut leaves: Vec<_> = ids
            .iter()
            .copied()
            .filter(|&id| self.is_leaf(id) && !self.nodes[id].dynamic && !self.nodes[id].volatile)
            .collect();
        let visual_order: Vec<_> = self.nodes[root]
            .children
            .iter()
            .flat_map(|&id| std::iter::once(id).chain(self.nodes[id].children.iter().copied()))
            .collect();
        leaves.sort_by_key(|id| {
            visual_order
                .iter()
                .position(|child| child == id)
                .unwrap_or(usize::MAX)
        });
        leaves.dedup();
        if leaves.len() != ids.len() || leaves.is_empty() {
            return None;
        }

        let first = leaves[0];
        let anchor = self.nodes[first]
            .parent
            .filter(|&parent| parent != root)
            .unwrap_or(first);
        let original_index = self.nodes[root]
            .children
            .iter()
            .position(|&id| id == anchor)?;
        for &id in &leaves {
            let parent = self.nodes[id].parent?;
            self.nodes[parent].children.retain(|&child| child != id);
        }
        self.prune_empty_groups();
        let index = self.nodes[root]
            .children
            .iter()
            .position(|&id| id == anchor)
            .map(|index| index + usize::from(matches!(self.nodes[anchor].kind, Kind::Group)))
            .unwrap_or(original_index.min(self.nodes[root].children.len()));

        let group = self.push(Some(root), name, Kind::Group, false);
        self.nodes[root].children.retain(|&id| id != group);
        self.nodes[root].children.insert(index, group);
        self.nodes[group].children = leaves.clone();
        for leaf in leaves {
            self.nodes[leaf].parent = Some(group);
        }
        Some(group)
    }

    pub(crate) fn ungroup(&mut self, ids: &[NodeId]) -> Option<Vec<NodeId>> {
        let root = self.root;
        let mut groups = ids.to_vec();
        groups.sort_by_key(|id| {
            self.nodes[root]
                .children
                .iter()
                .position(|child| child == id)
                .unwrap_or(usize::MAX)
        });
        groups.dedup();
        if groups.is_empty()
            || groups.len() != ids.len()
            || groups.iter().any(|&id| {
                !matches!(self.nodes[id].kind, Kind::Group)
                    || self.nodes[id].parent != Some(root)
                    || self.nodes[id].children.is_empty()
            })
        {
            return None;
        }

        let mut lifted = Vec::new();
        for group in groups {
            let index = self.nodes[root]
                .children
                .iter()
                .position(|&id| id == group)?;
            self.nodes[root].children.remove(index);
            self.nodes[group].parent = None;
            let children = std::mem::take(&mut self.nodes[group].children);
            for (offset, child) in children.into_iter().enumerate() {
                self.nodes[child].parent = Some(root);
                self.nodes[root].children.insert(index + offset, child);
                lifted.push(child);
            }
        }
        Some(lifted)
    }

    pub(crate) fn reorder(&mut self, ids: &[NodeId], placement: Placement) -> bool {
        let Some((moving, parent)) = self.reorder_plan(ids, placement) else {
            return false;
        };
        for &id in &moving {
            let old_parent = self.nodes[id]
                .parent
                .expect("reorder_plan only accepts attached nodes");
            self.nodes[old_parent].children.retain(|&child| child != id);
        }
        let mut index = if let Some((target, after)) = match placement {
            Placement::Before(target) => Some((target, false)),
            Placement::After(target) => Some((target, true)),
            Placement::Into(_) | Placement::End => None,
        } {
            let index = self.nodes[parent]
                .children
                .iter()
                .position(|&id| id == target)
                .expect("reorder_plan validates the target");
            index + usize::from(after)
        } else {
            self.nodes[parent].children.len()
        };
        for id in moving {
            self.nodes[id].parent = Some(parent);
            self.nodes[parent].children.insert(index, id);
            index += 1;
        }
        if matches!(self.nodes[parent].kind, Kind::Group) {
            self.nodes[parent].expanded = true;
        }
        self.prune_empty_groups();
        true
    }

    /// Validate a reorder without mutating the tree. Preview and commit share
    /// this planner, so every rendered destination is executable.
    pub(crate) fn can_reorder(&self, ids: &[NodeId], placement: Placement) -> bool {
        self.reorder_plan(ids, placement).is_some()
    }

    fn reorder_plan(&self, ids: &[NodeId], placement: Placement) -> Option<(Vec<NodeId>, NodeId)> {
        let mut moving = ids.to_vec();
        let target = match placement {
            Placement::Before(id) | Placement::After(id) | Placement::Into(id) => Some(id),
            Placement::End => None,
        };
        if moving.is_empty()
            || target.is_some_and(|id| id >= self.nodes.len() || moving.contains(&id))
        {
            return None;
        }
        let mut order = Vec::new();
        for &id in &self.nodes[self.root].children {
            order.push(id);
            order.extend(self.nodes[id].children.iter().copied());
        }
        moving.sort_by_key(|id| {
            order
                .iter()
                .position(|child| child == id)
                .unwrap_or(usize::MAX)
        });
        moving.dedup();
        if moving.len() != ids.len()
            || moving.iter().any(|&id| {
                id >= self.nodes.len()
                    || self.nodes[id].parent.is_none()
                    || self.nodes[id].dynamic
                    || self.nodes[id].volatile
            })
        {
            return None;
        }
        let groups = moving
            .iter()
            .all(|&id| matches!(self.nodes[id].kind, Kind::Group));
        let leaves = moving.iter().all(|&id| self.is_leaf(id));
        if !groups && !leaves {
            return None;
        }

        let root = self.root;
        let parent = match placement {
            Placement::Into(id) if matches!(self.nodes[id].kind, Kind::Group) && leaves => id,
            Placement::Into(_) => return None,
            Placement::Before(id) | Placement::After(id) => self.nodes[id].parent.unwrap_or(root),
            Placement::End => root,
        };
        if (groups && parent != root)
            || (matches!(placement, Placement::Before(_) | Placement::After(_))
                && target.is_some_and(|id| !self.nodes[parent].children.contains(&id)))
        {
            return None;
        }
        Some((moving, parent))
    }

    pub(crate) fn prune_empty_groups(&mut self) {
        let root = self.root;
        let empty: Vec<_> = self.nodes[root]
            .children
            .iter()
            .copied()
            .filter(|&id| {
                matches!(self.nodes[id].kind, Kind::Group) && self.nodes[id].children.is_empty()
            })
            .collect();
        self.nodes[root].children.retain(|id| !empty.contains(id));
        for id in empty {
            self.nodes[id].parent = None;
        }
    }

    pub(crate) fn path(&self, id: NodeId) -> String {
        let mut parts = Vec::new();
        let mut current = Some(id);
        while let Some(id) = current {
            if id == self.root {
                break;
            }
            parts.push(self.nodes[id].name.clone());
            current = self.nodes[id].parent;
        }
        parts.reverse();
        parts.join("  /  ")
    }
}

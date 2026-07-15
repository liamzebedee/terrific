# RFCs

Design notes for mealplanner / protodatabase. Numbered, PEP/RFC-style. Each captures a
decision and its reasoning so the "why" survives.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-relationships.md) | Relationships — soft refs + join tables, no SQL foreign keys | Draft |
| [0002](0002-indexes.md) | Indexes — declarative, reconciled, not ledgered | Draft |
| [0003](0003-data-definition-language.md) | Data definition language — schema, typed client, RPC layer | Descriptive |
| [0004](0004-migrations-and-refactoring.md) | Migrations and refactoring — additive/append-only evolution | Descriptive + directional |
| [0005](0005-data-modeling.md) | Data modeling — when to normalize (table vs blob) + UUIDv7 identity | Draft |

**Status** — *Draft*: proposed, not fully built. *Descriptive*: documents the current
implementation. *Directional*: notes the intended target beyond what exists today.

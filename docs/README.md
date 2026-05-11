---
title: "GN Tracing Docs"
description: "Entry point for the GN Tracing docs tree."
type: index
status: active
tags: ["docs"]
related:
  - "./overview.md"
  - "./_index.md"
  - "./_sync.md"
---

# GN Tracing Docs

This directory is the repository knowledge base. It describes the current product behavior, architecture, module boundaries, shared contracts, planning notes, and sync state for GN Tracing.

## Structure

- `overview.md`: scope, goal, and current guardrails.
- `_index.md`: navigation and dependency map.
- `_sync.md`: current docs/code synchronization snapshot.
- `modules/`: implemented module behavior, APIs, relationships, and business rules.
- `shared/`: shared models, conventions, and project context.
- `specs/planning/`: planning notes and implementation plans that are not module source-of-truth docs.
- `compliance/`: coverage summaries and known documentation gaps.

Docs should describe the current state of the codebase. Historical notes, commit timelines, and migration journals should stay out of module/shared docs unless a changelog is explicitly requested.

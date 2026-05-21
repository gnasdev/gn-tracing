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

This directory is the repository knowledge base. It describes the current product behavior, architecture, module boundaries, shared contracts, compliance notes, and sync state for GN Tracing.

## Structure

- `overview.md`: scope, goal, and current guardrails.
- `_index.md`: navigation and dependency map.
- `_sync.md`: current docs/code synchronization snapshot.
- `modules/`: implemented module behavior, APIs, relationships, and business rules.
- `features/`: user-facing shipped behavior that spans more than one module.
- `shared/`: shared models, conventions, and project context.
- `compliance/`: coverage summaries and known documentation gaps.

Docs should describe the current state of the codebase. Historical notes, commit timelines, and migration journals should stay out of module/shared docs unless a changelog is explicitly requested.

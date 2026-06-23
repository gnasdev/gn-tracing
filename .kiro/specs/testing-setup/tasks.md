# Implementation Plan: Testing Setup

## Overview

This plan stands up a Vitest-based testing setup across the three TypeScript contexts (root extension/`node`, `player-standalone`/`jsdom`, `worker`/Cloudflare Workers pool). It builds incrementally: a shared base config first, then the per-context configs, the in-memory Chrome API mock and harness, the fast-check property suite that encodes the design's nine Correctness Properties, baseline unit coverage, and finally the tooling integration (package scripts, Taskfile aggregate targets, the Husky pre-commit hook, and a new GitHub Actions CI workflow). Each step builds on the previous and ends by wiring everything together so nothing is orphaned.

All new dev dependencies are added with pinned (exact) versions per context, consistent with the repo's existing pinning convention.

## Tasks

- [x] 1. Set up shared and root extension test configuration
  - [x] 1.1 Create the shared base Vitest config
    - Create `vitest.shared.ts` exporting `sharedTestConfig` with `globals: true`, the V8 coverage provider, reporters `["text", "html", "lcov"]`, and Coverage_Threshold values `lines: 60, functions: 60, branches: 55, statements: 60`
    - Define exactly one canonical include glob `["**/*.{test,spec}.ts"]` and shared excludes for `node_modules`, `dist`, and `.wrangler`
    - _Requirements: 2.1, 2.2, 2.5, 6.1, 6.2, 6.5_
  - [x] 1.2 Create the root extension Vitest config
    - Create `vitest.config.ts` that spreads `sharedTestConfig`, sets `environment: "node"`, and lists `setupFiles: ["./test/setup.ts", "./test/property-config.ts"]`, declaring no Shared_Config-owned keys
    - Add `@types/node`-free, root-only resolution so `src/**` imports behave as in production
    - _Requirements: 1.1, 1.2, 1.5, 2.3, 2.4, 1.6_
  - [x] 1.3 Write a config-inheritance test
    - Create `test/config.test.ts` asserting the resolved root/player/worker configs inherit Shared_Config coverage/reporters/threshold/include/exclude values and only override environment or pool
    - _Requirements: 2.3, 2.4_

- [x] 2. Implement the shared Chrome API mock and test harness
  - [x] 2.1 Implement the Chrome mock and in-memory storage areas
    - Create `test/mocks/chrome.ts` with `createChromeMock`, `installChromeMock`, and `resetChromeMock`
    - Provide stubs for `storage.session`, `storage.local`, `runtime`, `tabs`, `alarms`, `debugger`, and `action`; back storage areas with an in-memory map supporting `get`/`set`/`remove`/`clear`
    - Record arguments, call counts, and preserve cross-spy invocation order; throw a descriptive error naming the missing namespace path when an absent `chrome.*` namespace is accessed
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.11_
  - [x] 2.2 Implement the global setup file
    - Create `test/setup.ts` registering `beforeEach` to install a fresh Chrome mock on `globalThis.chrome` and `afterEach` to reset it so storage is empty and call counts are zero between tests
    - _Requirements: 4.9, 4.10_
  - [x] 2.3 Implement test data factories
    - Create `test/factories.ts` with `makeTab`, `makePrivacySettings`, and `makeHeaderMap` returning valid defaults with override hooks
    - _Requirements: 3.2_
  - [x] 2.4 Write unit tests for the Chrome mock lifecycle
    - Create `test/mocks/chrome.test.ts` covering fresh-instance state, `installChromeMock` global assignment, spy recording/order, per-test reset, and the missing-namespace error
    - _Requirements: 4.2, 4.3, 4.4, 4.9, 4.10, 4.11_
  - [x] 2.5 Write property test for mock storage round-trip
    - Create `test/mocks/chrome.storage.test.ts`
    - **Property 8: Mock storage round-trip** — after `set({[k]: v})`, `get(k)` resolves to `{[k]: v}`; removed/cleared keys are absent
    - **Validates: Requirements 4.5, 4.8**

- [x] 3. Configure the fast-check property suite and root property tests
  - [x] 3.1 Configure the fast-check property suite
    - Create `test/property-config.ts` calling `fc.configureGlobal` with `numRuns: 100`, deterministic seed reporting on failure, and seed-based reproducibility
    - _Requirements: 5.1, 5.10, 5.11, 5.12_
  - [x] 3.2 Write property test: redaction never leaks secrets
    - Create `src/shared/privacy-redaction.test.ts`
    - **Property 1: Redaction never leaks secrets** — for an enabled header rule, no output header value exact-matches the original sensitive value
    - **Validates: Requirements 5.2**
  - [x] 3.3 Write property test: redaction idempotence
    - Add to `src/shared/privacy-redaction.test.ts`
    - **Property 2: Redaction is idempotent** — `redact(redact(x))` is deeply equal to `redact(x)`
    - **Validates: Requirements 5.3**
  - [x] 3.4 Write property test: redaction preserves structure
    - Add to `src/shared/privacy-redaction.test.ts`
    - **Property 3: Redaction preserves structure** — `redactJsonValue` preserves the full key set and nesting, changing only leaf values
    - **Validates: Requirements 5.4**
  - [x] 3.5 Write property test: profile monotonicity
    - Add to `src/shared/privacy-redaction.test.ts`
    - **Property 4: Profile monotonicity** — rules enabled under `strict` are a superset of those enabled under `standard`
    - **Validates: Requirements 5.5**
  - [x] 3.6 Write property test: selector normalization stability
    - Add to `src/shared/privacy-redaction.test.ts`
    - **Property 7: Selector normalization stability** — `normalizeMaskDomSelectors` applied to its own output is deeply equal to a single application
    - **Validates: Requirements 5.8**
  - [x] 3.7 Write property test: target validation totality
    - Create `src/shared/recording-target.test.ts`
    - **Property 5: Target validation totality** — `getRecordingTabTarget` returns a result where exactly one of `url`/`error` is non-null
    - **Validates: Requirements 5.6**
  - [x] 3.8 Write property test: target validation soundness
    - Add to `src/shared/recording-target.test.ts`
    - **Property 6: Target validation soundness** — accepted URLs use `http:`/`https:`/`file:` and a non–Chrome Web Store host
    - **Validates: Requirements 5.7**

- [x] 4. Establish baseline mock-backed unit coverage for root modules
  - [x] 4.1 Write mock-backed unit tests for the settings store
    - Create `src/background/settings-store.test.ts` exercising load/persist paths against the Chrome mock's `storage.session`/`storage.local`
    - _Requirements: 4.1, 6.3_
  - [x] 4.2 Write mock-backed unit tests for the storage manager
    - Create `src/background/storage-manager.test.ts` exercising console/network entry handling with the Chrome mock to lift coverage above the floor
    - _Requirements: 4.1, 6.3_

- [x] 5. Checkpoint - root context tests pass with coverage
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Set up the standalone player test context
  - [x] 6.1 Create the player Vitest config
    - Create `player-standalone/vitest.config.ts` deriving from the shared base, setting `environment: "jsdom"`, and reusing the existing Vite resolve/plugins
    - _Requirements: 1.1, 1.3, 1.5, 2.3, 2.4_
  - [x] 6.2 Write property test: ZIP/CRC parsing safety
    - Create the co-located player ZIP parser test (exposing the central-directory parser as an importable module if needed)
    - **Property 9: ZIP/CRC parsing safety** — the parser returns a typed error for empty/truncated/malformed buffers and never throws for any byte buffer input
    - **Validates: Requirements 5.9**
  - [x] 6.3 Write unit tests for player ZIP fixtures
    - Add example-based tests for stored and DEFLATE entries and optional-artifact presence/absence
    - _Requirements: 6.3_

- [x] 7. Set up the worker test context
  - [x] 7.1 Create the worker Vitest config
    - Create `worker/vitest.config.ts` using `defineWorkersConfig`, spreading the shared base, and pointing `poolOptions.workers.wrangler.configPath` at the worker's wrangler config
    - _Requirements: 1.1, 1.4, 1.5, 2.3, 2.4_
  - [x] 7.2 Write integration tests for the OAuth worker handler
    - Create `worker/src/index.test.ts` covering non-POST rejection (405), missing-secret handling, and upstream error mapping using placeholder env bindings (never real secrets)
    - _Requirements: 1.4, 6.3_

- [x] 8. Checkpoint - all three contexts pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Wire test scripts and Taskfile targets
  - [x] 9.1 Add root package.json test scripts and pinned deps
    - Add `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:coverage": "vitest run --coverage"`; add pinned `vitest`, `@vitest/coverage-v8`, `fast-check` to root `devDependencies`
    - _Requirements: 7.1, 7.2_
  - [x] 9.2 Add player and worker test scripts and pinned deps
    - Add `test`/`test:coverage` scripts and pinned `vitest`, `@vitest/coverage-v8`, `jsdom` (player) and `vitest`, `@cloudflare/vitest-pool-workers` (worker, aligned with `wrangler` ^3)
    - _Requirements: 7.1, 7.2_
  - [x] 9.3 Add Taskfile test and test:all targets
    - Add `task test` (root only, propagating its exit code) and `task test:all` that runs root, player, and worker, attempting every context, returning zero iff all pass, and printing each failed context
    - _Requirements: 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

- [x] 10. Integrate the pre-commit hook
  - [x] 10.1 Append related-tests run to the Husky pre-commit hook
    - Append a single-run `vitest related --run` over staged files to `.husky/pre-commit`, allowing commits when no related test exists, blocking on failure while preserving staged changes, and emitting an error if the runner cannot execute
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 11. Create the CI workflow
  - [x] 11.1 Add the GitHub Actions test workflow
    - Create `.github/workflows/test.yml` triggered on push and pull_request that installs deps for all three contexts, fails fast and skips downstream steps if any install fails, then runs typecheck and test-with-coverage for each context, marking the job failed on any typecheck/test/coverage failure
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 12. Final checkpoint - full pipeline green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test-authoring sub-tasks and can be skipped for a faster MVP, though the property suite (Requirement 5) and coverage floor (Requirement 6) depend on them.
- Each task references specific requirement sub-clauses for traceability.
- The nine Correctness Properties from the design map to sub-tasks 2.5 (P8), 3.2 (P1), 3.3 (P2), 3.4 (P3), 3.5 (P4), 3.6 (P7), 3.7 (P5), 3.8 (P6), and 6.2 (P9).
- fast-check global settings in 3.1 cover the remaining Requirement 5 clauses (5.1, 5.10, 5.11, 5.12) shared by every property test.
- Coverage thresholds (Requirement 6.6) ratchet upward only; never lower an established floor.
- All new dev dependencies are pinned to exact versions per context.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "6.1", "7.1"] },
    { "id": 2, "tasks": ["1.3", "2.4", "2.5", "3.2", "3.7", "4.1", "4.2", "6.2", "7.2"] },
    { "id": 3, "tasks": ["3.3", "3.8", "6.3"] },
    { "id": 4, "tasks": ["3.4"] },
    { "id": 5, "tasks": ["3.5"] },
    { "id": 6, "tasks": ["3.6"] },
    { "id": 7, "tasks": ["9.1", "9.2", "9.3", "10.1", "11.1"] }
  ]
}
```

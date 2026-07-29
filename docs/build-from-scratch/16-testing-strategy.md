---
title: "16 - Testing Strategy"
description: "Unit, integration, and e2e layers: when to use which, how to run them."
type: build
status: active
tags: ["build", "testing", "vitest", "playwright"]
related:
  - "./11-testing-three-contexts.md"
  - "./15-quality-gates.md"
  - "../specs/planning/comprehensive-unit-and-e2e-tests.md"
---

# 16 - Testing Strategy

## Meta

- Goal: keep regression safety risk-first without demanding 100% LOC on UI god files.
- Verification: `task test:all` green; optional `npm run test:e2e:player` when browsers are installed.

## Pyramid

| Layer | Tool | What belongs here |
| --- | --- | --- |
| Unit (pure) | Vitest node | Filters, body eligibility, redaction, URL parse, settings normalize |
| Integration | Vitest + chrome mock | CDP event streams → StorageManager; message-router; storage providers with mocked fetch/XHR |
| E2E | Playwright | Player shell + `gnCore.network` in a real browser; not full tab recording on CI |

## Commands

```bash
# All unit contexts (root extension, standalone player, worker)
task test:all

# Root only
npm test

# CDP + router + providers (examples)
npx vitest run src/background/cdp-manager.network.test.ts
npx vitest run src/background/message-router.test.ts

# Player e2e (needs Chromium once: npx playwright install chromium)
npm run test:e2e:player
# or
task test:e2e
```

If Playwright/browsers cannot install in an environment, the **gating bar** for filter/body behavior is:

- `src/shared/network-filter-type.test.ts`
- `src/shared/network-response-body.test.ts`
- `src/shared/player-e2e-acceptance.test.ts` (shared fixtures with e2e/)

Do not invent a “fake e2e passed” result.

## Fixtures

- `test/fixtures/cdp/` — CDP sequence notes
- `test/fixtures/network/` — sample network.json-shaped entries
- `e2e/fixtures/` — browser matrix cases for Playwright + pure acceptance tests

## CI

`.github/workflows/test.yml`:

- Always: `task test:all` on PR/push to main/master/dev
- Optional: player e2e on push to protected branches or PR label `e2e`

## Anti-patterns

- Reimplementing production logic inside a test to compute expected values
- Mocking the unit under test
- E2E for every UI pixel; prefer pure extract + thin e2e for critical contracts

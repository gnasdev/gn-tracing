/**
 * Global fast-check configuration for the property-based test suite.
 *
 * This file is registered as a Vitest `setupFile` so that every property test
 * across the context shares one consistent configuration. It guarantees:
 *
 *  - Each property runs against at least 100 distinct generated inputs per run
 *    (`numRuns: 100`), satisfying the minimum-cases requirement (5.10).
 *  - Failing runs report the shrunk counterexample together with the seed and
 *    path needed to reproduce the failure (5.11). fast-check reports the seed,
 *    path, and shrunk counterexample by default; `verbose` is enabled so the
 *    full failure context is always surfaced.
 *  - Re-running a property with a previously reported seed regenerates the
 *    identical input sequence (5.12). fast-check's generators are deterministic
 *    for a given seed; we only fix `numRuns` here and never inject a random or
 *    time-derived seed, so reproduction via `{ seed, path }` stays reliable.
 *
 * fast-check is added as a dev dependency in a later task (task 9), so the
 * module import below may surface a type/resolution warning until then. That is
 * expected and resolves once the dependency is installed.
 *
 * _Requirements: 5.1, 5.10, 5.11, 5.12_
 */

import fc from "fast-check";

fc.configureGlobal({
  // Property 5.10: run each property against a minimum of 100 generated cases.
  numRuns: 100,
  // Property 5.11: surface the shrunk counterexample and reproduction details
  // (seed + path) on failure. fast-check includes these by default; verbose
  // reporting ensures the full failure context is always printed.
  verbose: fc.VerbosityLevel.Verbose,
  // Property 5.12: do NOT set a fixed or random global seed here. Leaving the
  // seed unset lets each run choose a fresh seed that is reported on failure,
  // and re-running with that reported seed deterministically regenerates the
  // identical input sequence.
});

/**
 * Global Vitest setup for the root extension test context.
 *
 * Registered via `setupFiles` in the root `vitest.config.ts`, this module wires
 * the shared Chrome API mock into every test's lifecycle so each test observes
 * an isolated `globalThis.chrome`:
 *
 * - `beforeEach` installs a fresh {@link installChromeMock} instance, guaranteeing
 *   empty in-memory storage areas and spies with zero recorded calls.
 * - `afterEach` calls {@link resetChromeMock} to clear storage and call records,
 *   so no test leaks state into the next one.
 */
import { afterEach, beforeEach } from "vitest";
import { installChromeMock, resetChromeMock } from "./mocks/chrome";

// Install a fresh Chrome mock before each test so storage is empty and every
// spy starts with zero recorded calls (Requirement 4.9).
beforeEach(() => {
  installChromeMock();
});

// Reset the installed Chrome mock after each test so in-memory storage contains
// no keys and every spy's recorded call count returns to zero (Requirement 4.10).
afterEach(() => {
  resetChromeMock();
});

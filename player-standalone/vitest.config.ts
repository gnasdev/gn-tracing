/**
 * Vitest configuration for the standalone replay player context.
 *
 * This config derives from the shared base (`../vitest.shared`) so coverage
 * settings, reporters, the globals flag, and the include/exclude globs stay
 * aligned with every other context. It declares only `environment: "jsdom"`
 * to distinguish the DOM-dependent player runtime, and merges the existing
 * Vite config so resolve/plugins behave like production.
 */

import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../vitest.shared";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig({ command: "serve", mode: "test" }),
  defineConfig({
    test: {
      ...sharedTestConfig,
      environment: "jsdom",
    },
  }),
);

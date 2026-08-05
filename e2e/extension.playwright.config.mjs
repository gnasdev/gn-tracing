import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Chromium extension evidence e2e.
 *
 * Loads the built `dist/chrome` unpacked extension in a real browser and proves
 * the console + network evidence pipeline end to end. Separate from
 * `playwright.config.mjs` (which drives the hosted player), because this suite
 * launches a persistent context with the extension loaded and serves its own
 * loopback page — it needs no shared webServer.
 *
 * Prerequisites:
 *   npm run build                 # produces dist/chrome
 *   npx playwright install chromium
 *
 * Run:
 *   npm run test:e2e:extension
 *
 * IMPORTANT: this MUST use Playwright's Chromium (Chrome for Testing), which
 * honors the `--load-extension` switch. Branded Google Chrome 137+ ignores that
 * switch for security (measured on Chrome 150: the unpacked extension never
 * loads), so pointing `executablePath` at a system Chrome will not work.
 *
 * Deliberately NOT wired into `npm test`: the default unit suite must stay
 * runnable offline with no browser download.
 */
export default defineConfig({
  testDir: e2eDir,
  testMatch: /record-evidence\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
});

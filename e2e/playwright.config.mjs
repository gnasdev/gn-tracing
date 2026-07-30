import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Player e2e against hosted player public assets (player-standalone/public).
 * Run: npm run test:e2e:player
 * Requires: npm i -D @playwright/test && npx playwright install chromium
 */
export default defineConfig({
  testDir: path.join(root, "e2e/specs"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
  },
  webServer: {
    command: `npx --yes serve "${path.join(root, "player-standalone/public")}" -l 5199 --no-port-switching`,
    port: 5199,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

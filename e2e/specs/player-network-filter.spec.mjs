import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cases = JSON.parse(
  readFileSync(path.join(root, "e2e/fixtures/network-filter-cases.json"), "utf8"),
);

test.describe("player gnCore network filter (browser)", () => {
  test("player shell loads and exposes gnCore.network", async ({ page }) => {
    await page.goto("http://127.0.0.1:5199/player.html");
    await expect(page.locator("#network-filters")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#network-filters [data-filter="js"]')).toHaveAttribute(
      "data-filter",
      "js",
    );
    const hasApi = await page.evaluate(() => {
      return typeof globalThis.gnCore?.network?.getNetworkFilterType === "function";
    });
    expect(hasApi).toBe(true);
  });

  test("DevTools-like filter matrix matches fixture expectations", async ({ page }) => {
    await page.goto("http://127.0.0.1:5199/player.html");
    await page.waitForFunction(
      () => typeof globalThis.gnCore?.network?.getNetworkFilterType === "function",
    );

    const results = await page.evaluate((rows) => {
      const get = globalThis.gnCore.network.getNetworkFilterType;
      return rows.map((row) => ({
        name: row.name,
        expected: row.expected,
        actual: get(row.input),
      }));
    }, cases);

    for (const row of results) {
      expect(row.actual, row.name).toBe(row.expected);
    }
  });
});

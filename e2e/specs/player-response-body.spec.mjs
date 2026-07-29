import { expect, test } from "@playwright/test";

test.describe("player network response body display (browser)", () => {
  test("shows body text when present and non-empty missing state otherwise", async ({ page }) => {
    await page.goto("http://127.0.0.1:5199/player.html");
    await page.waitForFunction(
      () => typeof globalThis.gnCore?.network?.resolveNetworkResponseBodyDisplay === "function",
    );

    const outcomes = await page.evaluate(() => {
      const resolve = globalThis.gnCore.network.resolveNetworkResponseBodyDisplay;
      return {
        withBody: resolve({ text: '{"ok":true}' }),
        missing: resolve({ text: "" }),
        binary: resolve({ text: "AAAA", encoding: "base64", decodedText: "" }),
      };
    });

    expect(outcomes.withBody).toEqual({ kind: "text", text: '{"ok":true}' });
    expect(outcomes.missing.kind).toBe("missing");
    expect(outcomes.missing.text).toBe("");
    expect(outcomes.binary.kind).toBe("binary");
  });

  test("i18n catalog includes empty-body copy used by player detail", async ({ page }) => {
    await page.goto("http://127.0.0.1:5199/player.html");
    const hasKey = await page.evaluate(async () => {
      const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
      for (const src of scripts) {
        if (!src.includes("player.js")) continue;
        const text = await fetch(src).then((r) => r.text());
        return text.includes("detail.noResponseBody");
      }
      return false;
    });
    expect(hasKey).toBe(true);
  });
});

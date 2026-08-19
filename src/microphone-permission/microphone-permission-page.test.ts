import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("microphone permission extension page", () => {
  it("ships a user-visible page that requests microphone access from its own click", () => {
    const htmlPath = resolve(root, "microphone-permission/microphone-permission.html");
    const sourcePath = resolve(root, "src/microphone-permission/microphone-permission.ts");

    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(sourcePath)).toBe(true);

    const html = read("microphone-permission/microphone-permission.html");
    const source = read("src/microphone-permission/microphone-permission.ts");
    expect(html).toContain('id="allow-microphone-btn"');
    expect(source).toContain("allowMicrophoneButton.addEventListener");
    expect(source).toContain("navigator.mediaDevices.getUserMedia");
    expect(source).toContain("chrome.storage.session.set");
  });

  it("registers the new page's assets and script in extension packaging", () => {
    const build = read("esbuild.config.mjs");
    const knip = JSON.parse(read("knip.json")) as { entry: string[] };

    expect(build).toContain("microphone-permission/microphone-permission.html");
    expect(build).toContain("microphone-permission/microphone-permission.css");
    expect(build).toContain("src/microphone-permission/microphone-permission.ts");
    expect(knip.entry).toContain("src/microphone-permission/microphone-permission.ts");
  });
});

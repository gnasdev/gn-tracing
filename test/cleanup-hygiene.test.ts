/**
 * Regression guards for residual full-repo hygiene cleanup.
 *
 * These tests drive real shipped config + source on disk (not re-implemented
 * knip). They prove:
 * 1. Dynamically injected content entry scripts remain present and are listed
 *    in knip + esbuild (must not be deleted as "dead files").
 * 2. Confirmed-dead helpers from the code-quality review stay gone.
 * 3. The storage package barrel only re-exports the minimal public surface.
 * 4. Root ignore rules cover nested build/deps, secrets, wrangler, and agent noise.
 * 5. Legacy standalone auth pages (drive-auth / storage-auth) stay removed —
 *    cloud connect lives on the dedicated manage-clouds extension page.
 * 6. Manage clouds is a packaged page (not an in-popup dialog) and is wired in
 *    esbuild + knip.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as storageBarrel from "../src/background/storage";

const ROOT = resolve(import.meta.dirname, "..");

function readRoot(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function listTsUnder(relativeDir: string): string[] {
  const abs = join(ROOT, relativeDir);
  return readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(relativeDir, entry.name).replace(/\\/g, "/"));
}

/** Collect .ts sources under src/ (recursive, shallow-safe via walk). */
function walkTs(relativeDir: string): string[] {
  const abs = join(ROOT, relativeDir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(relativeDir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      out.push(...walkTs(rel));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

const REQUIRED_ENTRY_SCRIPTS = [
  "src/content/recording-events.ts",
  "src/content/drawing-overlay.ts",
] as const;

const REMOVED_AUTH_PAGE_PATHS = [
  "src/drive-auth/drive-auth.ts",
  "src/storage-auth/storage-auth.ts",
  "drive-auth/drive-auth.html",
  "storage-auth/storage-auth.html",
] as const;

const DEAD_HELPER_SYMBOLS = [
  "loadMirroredGoogleDriveState",
  "loadMirroredDriveConnected",
  "updateGoogleDriveUI",
  "getDropboxAuthenticatedDownloadHeaders",
  "getUploadHistoryUiLabels",
] as const;

describe("cleanup hygiene: inject entry scripts stay wired", () => {
  it("keeps content entry files on disk", () => {
    for (const rel of REQUIRED_ENTRY_SCRIPTS) {
      expect(existsSync(join(ROOT, rel)), `missing entry script ${rel}`).toBe(true);
    }
  });

  it("lists every inject entry in knip.json entry array", () => {
    const knip = JSON.parse(readRoot("knip.json")) as { entry: string[] };
    expect(Array.isArray(knip.entry)).toBe(true);
    for (const rel of REQUIRED_ENTRY_SCRIPTS) {
      expect(knip.entry, `knip entry missing ${rel}`).toContain(rel);
    }
  });

  it("lists every inject entry in esbuild.config.mjs entryPoints", () => {
    const esbuildSource = readRoot("esbuild.config.mjs");
    for (const rel of REQUIRED_ENTRY_SCRIPTS) {
      expect(esbuildSource, `esbuild missing ${rel}`).toContain(rel);
    }
  });

  it("does not ship standalone drive-auth / storage-auth pages", () => {
    for (const rel of REMOVED_AUTH_PAGE_PATHS) {
      expect(existsSync(join(ROOT, rel)), `legacy auth page still present: ${rel}`).toBe(false);
    }
    const esbuildSource = readRoot("esbuild.config.mjs");
    expect(esbuildSource).not.toMatch(/drive-auth|storage-auth/);
    const knip = JSON.parse(readRoot("knip.json")) as { entry: string[] };
    expect(knip.entry.some((e) => e.includes("drive-auth") || e.includes("storage-auth"))).toBe(
      false,
    );
  });

  it("ships Manage clouds as a dedicated extension page (not a popup dialog)", () => {
    const required = [
      "manage-clouds/manage-clouds.html",
      "manage-clouds/manage-clouds.css",
      "src/manage-clouds/manage-clouds.ts",
      "src/manage-clouds/page-model.ts",
    ] as const;
    for (const rel of required) {
      expect(existsSync(join(ROOT, rel)), `missing manage-clouds surface: ${rel}`).toBe(true);
    }

    const esbuildSource = readRoot("esbuild.config.mjs");
    expect(esbuildSource).toContain("src/manage-clouds/manage-clouds.ts");
    expect(esbuildSource).toContain("manage-clouds/manage-clouds.html");

    const knip = JSON.parse(readRoot("knip.json")) as { entry: string[] };
    expect(knip.entry).toContain("src/manage-clouds/manage-clouds.ts");

    const popupHtml = readRoot("popup/popup.html");
    expect(popupHtml).not.toContain("manage-clouds-dialog");
    expect(popupHtml).not.toContain("popup-provider-list");

    const popupTs = readRoot("src/popup/popup.ts");
    expect(popupTs).toContain("resolveManageCloudsPageUrl");
    expect(popupTs).toContain("openManageCloudsPage");
    expect(popupTs).not.toMatch(/setManageCloudsDialogOpen|manage-clouds-dialog/);

    const pageHtml = readRoot("manage-clouds/manage-clouds.html");
    expect(pageHtml).toContain('id="provider-list"');
    expect(pageHtml).toContain("manage-clouds.js");

    const pageTs = readRoot("src/manage-clouds/manage-clouds.ts");
    expect(pageTs).toContain("STORAGE_CONNECT");
    expect(pageTs).toContain("STORAGE_DISCONNECT");
    expect(pageTs).toContain("STORAGE_STATUS");
  });

  it("does not package the replay player into the extension build", () => {
    const esbuildSource = readRoot("esbuild.config.mjs");
    // STATIC_ASSET_ENTRIES must not copy player assets into dist/player.
    expect(esbuildSource).not.toMatch(/dest:\s*["']dist\/player\//);
    expect(esbuildSource).not.toMatch(/src:\s*["']player\/player\.(html|js|css)["']/);
    // Hosted player lives under player/ (Vite app); legacy player-standalone/ is gone.
    expect(existsSync(join(ROOT, "player-standalone"))).toBe(false);
    expect(existsSync(join(ROOT, "player/public/player.js"))).toBe(true);
    expect(existsSync(join(ROOT, "player/package.json"))).toBe(true);
  });
});

describe("cleanup hygiene: confirmed dead helpers stay gone", () => {
  it("does not redefine review-dead helpers in shipped extension TypeScript", () => {
    // Production TS only — docs and this test may mention symbol names.
    const productionSources = walkTs("src").filter(
      (rel) => !rel.endsWith(".test.ts") && !rel.includes("/test/"),
    );
    const hits: string[] = [];
    for (const rel of productionSources) {
      const source = readRoot(rel);
      for (const symbol of DEAD_HELPER_SYMBOLS) {
        // Match function/const definitions or exports — not comments alone is ideal,
        // but any identifier reference in production code is a regression.
        const asIdent = new RegExp(`\\b${symbol}\\b`);
        if (asIdent.test(source)) {
          hits.push(`${rel}:${symbol}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("cleanup hygiene: storage barrel public surface", () => {
  it("exports only the live multi-cloud registry accessors used outside the package", () => {
    // Drive the real barrel module — knip already verified nothing else is needed.
    expect(typeof storageBarrel.getGoogleDriveProvider).toBe("function");
    expect(typeof storageBarrel.getDropboxProvider).toBe("function");
    expect(typeof storageBarrel.requireRegisteredStorageProvider).toBe("function");
    expect(typeof storageBarrel.resolveRegisteredUploadProviderId).toBe("function");

    const exportedNames = Object.keys(storageBarrel).sort();
    expect(exportedNames).toEqual(
      [
        "getDropboxProvider",
        "getGoogleDriveProvider",
        "requireRegisteredStorageProvider",
        "resolveRegisteredUploadProviderId",
      ].sort(),
    );

    // Classes and registry mutators must not leak through the public barrel.
    expect(exportedNames).not.toContain("DropboxProvider");
    expect(exportedNames).not.toContain("GoogleDriveProvider");
    expect(exportedNames).not.toContain("registerStorageProvider");
    expect(exportedNames).not.toContain("getStorageProvider");
  });

  it("resolveRegisteredUploadProviderId still returns live providers from the barrel", () => {
    expect(storageBarrel.resolveRegisteredUploadProviderId("dropbox")).toBe("dropbox");
    expect(storageBarrel.resolveRegisteredUploadProviderId("google-drive")).toBe("google-drive");
    expect(storageBarrel.getGoogleDriveProvider().id).toBe("google-drive");
    expect(storageBarrel.getDropboxProvider().id).toBe("dropbox");
  });
});

describe("cleanup hygiene: root ignore rules", () => {
  it("covers nested dist/node_modules, secrets, wrangler, and agent/editor noise", () => {
    const gitignore = readRoot(".gitignore");
    const requiredPatterns = [
      "dist/",
      "**/dist/",
      "node_modules/",
      "**/node_modules/",
      ".env",
      ".env.*",
      "!.env.example",
      ".dev.vars",
      ".wrangler/",
      "**/.wrangler/",
      ".claude/",
      ".agents/",
      ".cursor/",
      ".grok/",
      ".vscode/",
      "coverage/",
      "*.zip",
    ];
    for (const pattern of requiredPatterns) {
      expect(gitignore.includes(pattern), `gitignore missing ${pattern}`).toBe(true);
    }
  });
});

describe("cleanup hygiene: content directory still has injectables", () => {
  it("lists expected content script modules", () => {
    const files = listTsUnder("src/content");
    expect(files).toEqual(
      expect.arrayContaining([
        "src/content/drawing-overlay.ts",
        "src/content/recording-events.ts",
        "src/content/instant-replay.ts",
        "src/content/instant-replay-evidence.ts",
      ]),
    );
    expect(files).not.toEqual(expect.arrayContaining(["src/content/in-page-capture.ts"]));
    expect(files).not.toEqual(expect.arrayContaining(["src/content/in-page-relay.ts"]));
  });
});

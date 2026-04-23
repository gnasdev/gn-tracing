import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOOGLE_CLIENT_ID = "95916347176-ulk25djm5l4g6ebq7vftjik8iv9a11vf.apps.googleusercontent.com";

const watch = process.argv.includes("--watch");
const commonOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: true,
  minify: false,
};

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyTextFile(src, dest, transform) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const content = fs.readFileSync(src, "utf-8");
  fs.writeFileSync(dest, transform ? transform(content) : content, "utf-8");
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function generateManifest(outputPath) {
  const templatePath = path.resolve(__dirname, "manifest.template.json");
  const manifestPath = path.resolve(__dirname, outputPath);

  if (!fs.existsSync(templatePath)) {
    console.error("manifest.template.json not found");
    return;
  }

  const template = fs
    .readFileSync(templatePath, "utf-8")
    .replace(/{{GOOGLE_CLIENT_ID}}/g, GOOGLE_CLIENT_ID);

  fs.writeFileSync(manifestPath, template, "utf-8");
  console.log("✓ manifest.json generated");
}

async function build() {
  if (!watch) {
    fs.rmSync(path.resolve(__dirname, "dist"), { recursive: true, force: true });
  }

  const swCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/background/service-worker.ts"],
    outfile: "dist/background/service-worker.js",
    format: "esm",
  });

  const uiCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: [
      { in: "src/popup/popup.ts", out: "popup/popup" },
      { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen" },
      { in: "src/drive-auth/drive-auth.ts", out: "drive-auth/drive-auth" },
    ],
    outdir: "dist",
    format: "iife",
  });

  if (watch) {
    await Promise.all([swCtx.watch(), uiCtx.watch()]);
    generateManifest("dist/manifest.json");
    copyStaticAssets();
    console.log("Watching extension sources...");
    return;
  }

  await Promise.all([swCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([swCtx.dispose(), uiCtx.dispose()]);
  generateManifest("dist/manifest.json");
  copyStaticAssets();

  console.log("Extension built.");
}

function copyStaticAssets() {
  copyTextFile("popup/popup.html", "dist/popup/popup.html");
  copyFile("popup/popup.css", "dist/popup/popup.css");
  copyTextFile("offscreen/offscreen.html", "dist/offscreen/offscreen.html");
  copyTextFile("drive-auth/drive-auth.html", "dist/drive-auth/drive-auth.html");
  copyDir("icons", "dist/icons");
  copyFile("player/player.html", "dist/player/player.html");
  copyFile("player/player.css", "dist/player/player.css");
  copyFile("player/player.js", "dist/player/player.js");
  copyDir("player/icons", "dist/player/icons");
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});

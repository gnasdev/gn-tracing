import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file if exists
const envPath = path.resolve(__dirname, ".env");
let envVars = {};
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  envContent.split("\n").forEach((line) => {
    const [key, ...valueParts] = line.split("=");
    if (key && valueParts.length > 0) {
      envVars[key.trim()] = valueParts.join("=").trim();
    }
  });
}

const watch = process.argv.includes("--watch");

const commonOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: true,
  minify: false,
  define: {
    "process.env.GOOGLE_CLIENT_ID": JSON.stringify(envVars.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || ""),
    "process.env.PLAYER_HOST_URL": JSON.stringify(envVars.PLAYER_HOST_URL || process.env.PLAYER_HOST_URL || ""),
  },
};

// Copy helper function
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
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

// Generate manifest.json from template with env substitution
function generateManifest() {
  const templatePath = path.resolve(__dirname, "manifest.template.json");
  const manifestPath = path.resolve(__dirname, "manifest.json");

  if (!fs.existsSync(templatePath)) {
    console.error("manifest.template.json not found");
    return;
  }

  const clientId = envVars.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";

  if (!clientId) {
    console.warn("⚠️ GOOGLE_CLIENT_ID not set in .env - manifest.json may have empty client_id");
  }

  let template = fs.readFileSync(templatePath, "utf-8");
  template = template.replace(/{{GOOGLE_CLIENT_ID}}/g, clientId);

  fs.writeFileSync(manifestPath, template, "utf-8");
  console.log("✓ manifest.json generated");
}

async function build() {
  // Generate manifest.json first
  generateManifest();
  // Service worker — ESM (Chrome MV3 module worker)
  const swCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/background/service-worker.ts"],
    outfile: "dist/background/service-worker.js",
    format: "esm",
  });

  // Popup, offscreen, and drive-auth — IIFE (loaded via non-module script tags)
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
    console.log("Watching extension sources...");
  } else {
    await Promise.all([swCtx.rebuild(), uiCtx.rebuild()]);
    await Promise.all([swCtx.dispose(), uiCtx.dispose()]);

    // Copy player files
    copyFile("player/player.html", "dist/player/player.html");
    copyFile("player/player.css", "dist/player/player.css");
    copyFile("player/player.js", "dist/player/player.js");
    copyDir("player/icons", "dist/player/icons");

    // Copy JSZip
    copyFile("node_modules/jszip/dist/jszip.min.js", "dist/lib/jszip.min.js");

    console.log("Extension built.");
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});

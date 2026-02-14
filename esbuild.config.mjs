import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const commonOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: true,
  minify: false,
};

async function build() {
  // Service worker — ESM (Chrome MV3 module worker)
  const swCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: ["src/background/service-worker.ts"],
    outfile: "dist/background/service-worker.js",
    format: "esm",
  });

  // Popup and offscreen — IIFE (loaded via non-module script tags)
  const uiCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: [
      { in: "src/popup/popup.ts", out: "popup/popup" },
      { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen" },
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
    console.log("Extension built.");
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});

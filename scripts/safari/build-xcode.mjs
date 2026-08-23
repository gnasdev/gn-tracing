/**
 * Build the Safari (macOS/iOS) Xcode wrapper from the checked-in project.
 *
 * There are two separate single-platform Xcode projects, not one combined
 * project — `xcode/GN Tracing (macOS)/` and `xcode/GN Tracing (iOS)/`. They
 * must stay separate: macOS Safari (dist/safari/) and iOS Safari
 * (dist/safari-ios/) bake in a different `__BROWSER_TARGET__` (esbuild
 * define), which changes runtime behavior (SafariRecordingRuntime vs
 * SafariIosRecordingRuntime, video capability, network ownership). An
 * Apple-default combined "Platform: All" project shares one extension
 * resource group across both platforms, which would silently point the iOS
 * target at the macOS (full-capability) bundle. Verified by generating a
 * combined project first, inspecting its PBXFileReference paths, and finding
 * exactly this bug before switching to `--macos-only`/`--ios-only`.
 *
 * Both projects are hand-maintained, not regenerated per build (see plan
 * rationale: an always-regenerated project can't be reviewed/diffed in PRs).
 * Each references its dist/safari* folder by relative path (confirmed via
 * `xcrun safari-web-extension-converter`), so the moving part on every build
 * is dist/safari*, not the Xcode project itself.
 *
 * Before invoking xcodebuild this script verifies every top-level entry in
 * the relevant dist/ folder still has a matching PBXFileReference in the
 * project — this is the drift check: a new content-script/permission that
 * changes dist/'s top-level shape without a matching Xcode project update
 * fails loudly here instead of silently shipping a stale bundle.
 *
 * Usage:
 *   node scripts/safari/build-xcode.mjs --scheme macos
 *   node scripts/safari/build-xcode.mjs --scheme ios --destination "generic/platform=iOS Simulator"
 *   node scripts/safari/build-xcode.mjs --scheme macos --allow-signing
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function fail(message) {
  console.error(`Safari Xcode build failed: ${message}`);
  process.exit(1);
}

function getCliArgValue(flagName) {
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === flagName) {
      return process.argv[i + 1];
    }
    if (arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1);
    }
  }
  return undefined;
}

const TARGETS = {
  macos: { projectDir: "GN Tracing (macOS)", distDir: "safari" },
  ios: { projectDir: "GN Tracing (iOS)", distDir: "safari-ios" },
};

const targetName = String(getCliArgValue("--scheme") || "macos")
  .trim()
  .toLowerCase();
const targetConfig = TARGETS[targetName];
if (!targetConfig) {
  fail(`unsupported --scheme ${targetName} (use macos or ios)`);
}

const xcodeProjectDir = path.join(root, "xcode", targetConfig.projectDir);
const xcodeProjectPath = path.join(xcodeProjectDir, "GN Tracing.xcodeproj");
const pbxprojPath = path.join(xcodeProjectPath, "project.pbxproj");
const distDir = path.join(root, "dist", targetConfig.distDir);

const destination = getCliArgValue("--destination");
const allowSigning = process.argv.includes("--allow-signing");
const configuration = getCliArgValue("--configuration") || "Debug";

function checkDriftAgainstDist() {
  if (!fs.existsSync(distDir)) {
    fail(
      `dist/${targetConfig.distDir} is missing. Run 'task dist:${targetName === "ios" ? "safari-ios" : "safari"}' first.`,
    );
  }
  if (!fs.existsSync(pbxprojPath)) {
    fail(
      `${path.relative(root, pbxprojPath)} is missing. Seed it with ` +
        "'xcrun safari-web-extension-converter' (see DEVELOPER.md).",
    );
  }

  const pbxprojText = fs.readFileSync(pbxprojPath, "utf8");
  const distEntries = fs.readdirSync(distDir);
  const missing = distEntries.filter((entry) => {
    // PBXFileReference paths always end with the dist-relative entry name;
    // matching just that suffix is robust to how many "../" segments precede
    // it (which depends on where in the project tree the reference lives).
    const suffix = `dist/${targetConfig.distDir}/${entry}`;
    return !pbxprojText.includes(suffix);
  });

  if (missing.length > 0) {
    fail(
      `dist/${targetConfig.distDir}/ has entries the Xcode project does not reference: ` +
        `${missing.join(", ")}. Add a PBXFileReference for each (open the project in Xcode ` +
        "and drag the folder in, or re-run safari-web-extension-converter and merge the new " +
        "references by hand).",
    );
  }
  console.log(
    `✓ Xcode project (${targetConfig.projectDir}) references all ${distEntries.length} ` +
      `dist/${targetConfig.distDir}/ entries.`,
  );
}

function build() {
  const args = [
    "-project",
    xcodeProjectPath,
    "-scheme",
    "GN Tracing",
    "-configuration",
    configuration,
  ];
  if (destination) {
    args.push("-destination", destination);
  }
  if (!allowSigning) {
    // Local/CI builds never have a signing identity available; this is a
    // structural build check, not a distributable artifact. See
    // scripts/safari/sign-and-notarize.mjs for the signed path.
    args.push("CODE_SIGNING_ALLOWED=NO");
  }
  args.push("build");

  console.log(`Building "${targetConfig.projectDir}"...`);
  execFileSync("xcodebuild", args, { stdio: "inherit", cwd: xcodeProjectDir });
  console.log(`✓ Xcode build succeeded (${targetConfig.projectDir}, ${configuration}).`);
}

checkDriftAgainstDist();
build();

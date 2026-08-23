/**
 * Sign, notarize, and staple the macOS Safari app for direct (non-App-Store)
 * distribution — Developer ID export, not Mac App Store. App Store Connect
 * upload is a separate, not-yet-written path (deliberately out of scope here).
 *
 * Pipeline: xcodebuild archive -> xcodebuild -exportArchive (developer-id
 * method) -> ditto to zip -> xcrun notarytool submit --wait -> xcrun stapler
 * staple. Each step was smoke-tested against this repo's actual Xcode project:
 * `archive` succeeds fully unsigned (CODE_SIGNING_ALLOWED=NO); `-exportArchive`
 * for the "developer-id" method fails immediately with "No Team Found in
 * Archive" once a real Apple Developer Team is required — that is the exact
 * point real credentials become necessary, confirmed by testing rather than
 * assumed.
 *
 * Requires (this machine has none of these — see plan risk #3):
 *   APPLE_TEAM_ID                    Apple Developer Team ID
 *   APPLE_SIGNING_IDENTITY           "Developer ID Application: <name> (<team>)"
 *                                     (optional with signingStyle=automatic)
 *   APPLE_NOTARIZE_KEY_ID             App Store Connect API key id
 *   APPLE_NOTARIZE_KEY_ISSUER_ID      App Store Connect API key issuer id
 *   APPLE_NOTARIZE_KEY_PATH           Path to the .p8 private key file
 *
 * Usage:
 *   node scripts/safari/sign-and-notarize.mjs
 *   node scripts/safari/sign-and-notarize.mjs --skip-notarize   (archive + export only)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const xcodeProjectDir = path.join(root, "xcode", "GN Tracing (macOS)");
const xcodeProjectPath = path.join(xcodeProjectDir, "GN Tracing.xcodeproj");
const scheme = "GN Tracing";

function fail(message) {
  console.error(`sign-and-notarize failed: ${message}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(
      `${name} is required (see this file's header comment for the full credential list). ` +
        "This machine has no Apple Developer credentials configured, so this step cannot run here.",
    );
  }
  return value;
}

const skipNotarize = process.argv.includes("--skip-notarize");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gn-tracing-notarize-"));
const archivePath = path.join(workDir, "GN Tracing.xcarchive");
const exportDir = path.join(workDir, "export");
const exportOptionsPath = path.join(workDir, "export-options.plist");
const zipPath = path.join(workDir, "GN Tracing.zip");

function archive() {
  console.log("Archiving (Release, requires a valid signing identity for a real distributable)...");
  execFileSync(
    "xcodebuild",
    [
      "-project",
      xcodeProjectPath,
      "-scheme",
      scheme,
      "-configuration",
      "Release",
      "archive",
      "-archivePath",
      archivePath,
    ],
    { stdio: "inherit", cwd: xcodeProjectDir },
  );
  console.log(`✓ Archived to ${archivePath}`);
}

function exportDeveloperId() {
  const teamId = requireEnv("APPLE_TEAM_ID");
  const identity = process.env.APPLE_SIGNING_IDENTITY;

  const plistLines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>method</key>",
    "  <string>developer-id</string>",
    "  <key>teamID</key>",
    `  <string>${teamId}</string>`,
    "  <key>signingStyle</key>",
    `  <string>${identity ? "manual" : "automatic"}</string>`,
    ...(identity ? ["  <key>signingCertificate</key>", `  <string>${identity}</string>`] : []),
    "</dict>",
    "</plist>",
  ];
  fs.writeFileSync(exportOptionsPath, `${plistLines.join("\n")}\n`, "utf8");

  console.log("Exporting Developer ID-signed .app...");
  execFileSync(
    "xcodebuild",
    [
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportPath",
      exportDir,
      "-exportOptionsPlist",
      exportOptionsPath,
    ],
    { stdio: "inherit" },
  );
  console.log(`✓ Exported to ${exportDir}`);
}

function zipForNotarization() {
  const appPath = path.join(exportDir, "GN Tracing.app");
  if (!fs.existsSync(appPath)) {
    fail(`expected exported app at ${appPath}, but it does not exist.`);
  }
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { stdio: "inherit" });
  console.log(`✓ Zipped for notarization: ${zipPath}`);
}

function notarize() {
  const keyId = requireEnv("APPLE_NOTARIZE_KEY_ID");
  const issuerId = requireEnv("APPLE_NOTARIZE_KEY_ISSUER_ID");
  const keyPath = requireEnv("APPLE_NOTARIZE_KEY_PATH");
  if (!fs.existsSync(keyPath)) {
    fail(`APPLE_NOTARIZE_KEY_PATH does not exist: ${keyPath}`);
  }

  console.log("Submitting to Apple notary service (this calls Apple's servers)...");
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      zipPath,
      "--key",
      keyPath,
      "--key-id",
      keyId,
      "--issuer",
      issuerId,
      "--wait",
    ],
    { stdio: "inherit" },
  );
  console.log("✓ Notarization accepted.");

  const appPath = path.join(exportDir, "GN Tracing.app");
  console.log("Stapling notarization ticket...");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log(`✓ Stapled. Distributable app: ${appPath}`);
}

function checkRequiredEnvUpfront() {
  // Fail fast, before the slow archive step, rather than discovering a
  // missing credential only after minutes of building.
  requireEnv("APPLE_TEAM_ID");
  if (!skipNotarize) {
    requireEnv("APPLE_NOTARIZE_KEY_ID");
    requireEnv("APPLE_NOTARIZE_KEY_ISSUER_ID");
    requireEnv("APPLE_NOTARIZE_KEY_PATH");
  }
}

checkRequiredEnvUpfront();
archive();
exportDeveloperId();
zipForNotarization();
if (skipNotarize) {
  console.log(`--skip-notarize passed; stopping after export+zip. Artifact: ${zipPath}`);
} else {
  notarize();
}
console.log(`Work directory (not cleaned up automatically): ${workDir}`);

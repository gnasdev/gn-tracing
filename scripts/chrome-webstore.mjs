import fs from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const API_ROOT = "https://chromewebstore.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUIRED_ENV = [
  "CHROME_WEBSTORE_PUBLISHER_ID",
  "CHROME_WEBSTORE_EXTENSION_ID",
  "CHROME_WEBSTORE_CLIENT_ID",
  "CHROME_WEBSTORE_CLIENT_SECRET",
  "CHROME_WEBSTORE_REFRESH_TOKEN",
];

const args = process.argv.slice(2);
const command = args[0];
const options = parseOptions(args.slice(1));

function parseOptions(rawArgs) {
  const parsed = { dryRun: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--zip") {
      parsed.zip = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--zip=")) {
      parsed.zip = arg.slice("--zip=".length);
      continue;
    }
  }
  return parsed;
}

function usage() {
  console.log(`Usage:
  node scripts/chrome-webstore.mjs status
  node scripts/chrome-webstore.mjs upload --zip gn-tracing-store.zip
  node scripts/chrome-webstore.mjs publish
  node scripts/chrome-webstore.mjs release --zip gn-tracing-store.zip

Required environment:
  ${REQUIRED_ENV.join("\n  ")}
`);
}

function getEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function getItemName() {
  return `publishers/${getEnv("CHROME_WEBSTORE_PUBLISHER_ID")}/items/${getEnv("CHROME_WEBSTORE_EXTENSION_ID")}`;
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: getEnv("CHROME_WEBSTORE_CLIENT_ID"),
    client_secret: getEnv("CHROME_WEBSTORE_CLIENT_SECRET"),
    refresh_token: getEnv("CHROME_WEBSTORE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Unable to fetch access token (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload.access_token;
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Chrome Web Store API failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function authHeaders() {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

async function uploadPackage() {
  const zipPath = path.resolve(rootDir, options.zip || "gn-tracing-store.zip");
  const zip = await fs.readFile(zipPath);
  const name = getItemName();
  const url = `${API_ROOT}/upload/v2/${name}:upload`;

  if (options.dryRun) {
    console.log(`[dry-run] Would upload ${path.relative(rootDir, zipPath)} to ${url}`);
    return;
  }

  const payload = await requestJson(url, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": "application/zip",
    },
    body: zip,
  });

  console.log(`Uploaded ${payload.itemId || getEnv("CHROME_WEBSTORE_EXTENSION_ID")} (${payload.crxVersion || "version pending"}).`);
  console.log(JSON.stringify(payload, null, 2));
}

async function publishItem() {
  const name = getItemName();
  const url = `${API_ROOT}/v2/${name}:publish`;

  if (options.dryRun) {
    console.log(`[dry-run] Would publish ${url}`);
    return;
  }

  const payload = await requestJson(url, {
    method: "POST",
    headers: await authHeaders(),
  });

  console.log("Submitted Chrome Web Store item for review.");
  console.log(JSON.stringify(payload, null, 2));
}

async function fetchStatus() {
  const name = getItemName();
  const url = `${API_ROOT}/v2/${name}:fetchStatus`;

  if (options.dryRun) {
    console.log(`[dry-run] Would fetch status from ${url}`);
    return;
  }

  const payload = await requestJson(url, {
    method: "GET",
    headers: await authHeaders(),
  });

  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  for (const envName of REQUIRED_ENV) {
    getEnv(envName);
  }

  if (command === "upload") {
    await uploadPackage();
    return;
  }
  if (command === "publish") {
    await publishItem();
    return;
  }
  if (command === "status") {
    await fetchStatus();
    return;
  }
  if (command === "release") {
    await uploadPackage();
    await publishItem();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

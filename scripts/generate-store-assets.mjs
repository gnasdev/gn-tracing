import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const outDir = path.join(rootDir, "store-assets");
const capturesDir = path.join(outDir, "captures");
const screenshotsDir = path.join(outDir, "screenshots");
const tempDir = path.join(outDir, ".tmp");
const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const colors = {
  bg0: "#07111f",
  bg1: "#11203a",
  bg2: "#102f34",
  panel: "#0e1a2d",
  line: "#2c4167",
  white: "#f8fbff",
  muted: "#c7d2e8",
  dim: "#95a8c5",
  blue: "#4361ee",
  teal: "#2ec4b6",
  green: "#36d399",
  amber: "#f6c453",
};

const storeShots = [
  {
    file: "01-popup-recording-controls.png",
    capture: "popup-recording.png",
    title: ["Record tab", "with context"],
    copy: ["Actual popup recording state:", "timer, queue, stats, and Drive."],
    badge: "Extension popup",
    screenshot: { x: 560, y: 72, w: 374, h: 650 },
  },
  {
    file: "02-popup-privacy-and-drive-settings.png",
    capture: "popup-privacy.png",
    title: ["Privacy controls", "before upload"],
    copy: ["Payload capture is opt-in.", "Sensitive headers are redacted."],
    badge: "Capture settings",
    screenshot: { x: 560, y: 72, w: 374, h: 650 },
  },
  {
    file: "03-player-introduction-page.png",
    capture: "player-intro.png",
    title: ["Player", "intro page"],
    copy: ["Actual hosted player root page.", "Shown before a replay link opens."],
    badge: "Player landing",
    screenshot: { x: 72, y: 280, w: 1136, h: 420 },
  },
  {
    file: "04-player-replay-inspector.png",
    capture: "player-replay.png",
    title: ["Replay", "inspector"],
    copy: ["Actual player UI with video,", "console, network, and filters."],
    badge: "Replay player",
    screenshot: { x: 72, y: 280, w: 1136, h: 420 },
  },
  {
    file: "05-upload-history-page.png",
    capture: "history-page.png",
    title: ["Upload", "history"],
    copy: ["Actual history page for replay", "links and previous uploads."],
    badge: "Upload history",
    screenshot: { x: 72, y: 280, w: 1136, h: 420 },
  },
];

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fileUrl(filePath) {
  return `file://${filePath}`;
}

function text(x, y, value, size, fill = colors.white, weight = 700, extra = "") {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${esc(value)}</text>`;
}

function lines(
  x,
  y,
  values,
  size,
  fill = colors.white,
  gap = Math.round(size * 1.25),
  weight = 750,
) {
  return values.map((line, index) => text(x, y + index * gap, line, size, fill, weight)).join("");
}

function rect(x, y, w, h, fill, radius = 12, stroke = "none", sw = 1, extra = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
}

function svgRoot(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.bg0}"/>
        <stop offset="50%" stop-color="${colors.bg1}"/>
        <stop offset="100%" stop-color="${colors.bg2}"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${colors.blue}"/>
        <stop offset="100%" stop-color="${colors.teal}"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000814" flood-opacity="0.34"/>
      </filter>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${body}
  </svg>`;
}

function baseHtml(title, css, body, script = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${css}</style>
</head>
${body}
${script ? `<script>${script}</script>` : ""}
</html>`;
}

function readBody(html) {
  const match = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  if (!match) {
    throw new Error("Unable to extract body from HTML file");
  }
  return `<body${match[1]}>${match[2].replace(/<script[\s\S]*?<\/script>/gi, "")}</body>`;
}

async function makePopupCapture(name, fixtureScript) {
  const popupHtml = await fs.readFile(path.join(rootDir, "popup", "popup.html"), "utf8");
  const popupCss = await fs.readFile(path.join(rootDir, "popup", "popup.css"), "utf8");
  const body = readBody(popupHtml);
  const css = `${popupCss}
    body { width: 380px; min-height: 720px; background: #0b1425; }
    #app { min-height: 720px; }
  `;
  const htmlPath = path.join(tempDir, `${name}.html`);
  await fs.writeFile(htmlPath, baseHtml(name, css, body, fixtureScript), "utf8");
  await captureChrome(htmlPath, path.join(capturesDir, `${name}.png`), 380, 720);
}

async function makePlayerCapture(name, mode) {
  const playerHtml = await fs.readFile(path.join(rootDir, "player", "player.html"), "utf8");
  const playerCss = await fs.readFile(path.join(rootDir, "player", "player.css"), "utf8");
  const iconCss = await fs
    .readFile(path.join(rootDir, "player", "icons", "phosphor-icons.css"), "utf8")
    .catch(() => "");
  const body = readBody(playerHtml);
  const script = mode === "intro" ? playerIntroScript() : playerReplayScript();
  const htmlPath = path.join(tempDir, `${name}.html`);
  await fs.writeFile(htmlPath, baseHtml(name, `${iconCss}\n${playerCss}`, body, script), "utf8");
  await captureChrome(htmlPath, path.join(capturesDir, `${name}.png`), 1280, 800);
}

async function makeHistoryCapture() {
  const historyHtml = await fs.readFile(path.join(rootDir, "history", "history.html"), "utf8");
  const popupCss = await fs.readFile(path.join(rootDir, "popup", "popup.css"), "utf8");
  const historyCss = await fs.readFile(path.join(rootDir, "history", "history.css"), "utf8");
  const body = readBody(historyHtml);
  const htmlPath = path.join(tempDir, "history-page.html");
  await fs.writeFile(
    htmlPath,
    baseHtml("history-page", `${popupCss}\n${historyCss}`, body, historyScript()),
    "utf8",
  );
  await captureChrome(htmlPath, path.join(capturesDir, "history-page.png"), 1100, 760);
}

async function captureChrome(htmlPath, outPath, width, height) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "gn-tracing-store-assets-"));
  try {
    await execFileAsync(
      chromeBin,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--no-first-run",
        "--allow-file-access-from-files",
        `--user-data-dir=${profileDir}`,
        `--window-size=${width},${height}`,
        `--screenshot=${outPath}`,
        fileUrl(htmlPath),
      ],
      { timeout: 20000 },
    );
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true });
  }
}

function popupRecordingScript() {
  return `
    document.getElementById('status-bar').classList.remove('hidden');
    document.getElementById('timer').textContent = '02:18';
    document.getElementById('toggle-btn').textContent = 'Stop Recording';
    document.getElementById('toggle-btn').className = 'btn btn-stop';
    document.getElementById('pause-resume-btn').classList.remove('hidden');
    document.getElementById('stats').classList.remove('hidden');
    document.getElementById('console-count').textContent = '18';
    document.getElementById('network-count').textContent = '124';
    document.getElementById('google-drive-status').textContent = 'Connected';
    document.getElementById('google-drive-connect-btn').classList.add('hidden');
    document.getElementById('google-drive-disconnect-btn').classList.remove('hidden');
    document.getElementById('google-drive-folder-input').disabled = false;
    document.getElementById('google-drive-folder-input').value = '/QA/Replays';
    document.getElementById('google-drive-folder-hint').textContent = 'Uploads will be saved under QA/Replays.';
    document.getElementById('capture-websocket-frames-input').checked = true;
    document.getElementById('session-list').innerHTML = '<div class="session-item"><div class="session-item-header"><div class="session-item-title">Checkout regression capture</div><div class="session-item-badge phase-uploading">Recording</div></div><div class="session-item-meta">example-app.local/checkout · video, console, network, WebSocket</div></div>';
    document.getElementById('popup-upload-history-list').innerHTML = '<div class="history-item"><div class="history-item-title">Checkout bug replay</div><div class="history-item-meta">Uploaded today · 02:41 · 124 requests</div><div class="history-item-actions"><button>Open</button><button>Copy link</button></div></div>';
  `;
}

function popupPrivacyScript() {
  return `
    document.getElementById('google-drive-status').textContent = 'Connected';
    document.getElementById('google-drive-connect-btn').classList.add('hidden');
    document.getElementById('google-drive-disconnect-btn').classList.remove('hidden');
    document.getElementById('google-drive-folder-input').disabled = false;
    document.getElementById('google-drive-folder-input').value = 'https://drive.google.com/drive/folders/QA-Replays';
    document.getElementById('google-drive-folder-hint').textContent = 'Using folder: QA Replays.';
    document.getElementById('capture-request-bodies-input').checked = false;
    document.getElementById('capture-response-bodies-input').checked = false;
    document.getElementById('capture-websocket-frames-input').checked = false;
    document.getElementById('session-list').innerHTML = '<div class="session-empty">Connect Drive, choose privacy settings, then start recording.</div>';
    document.getElementById('popup-upload-history-list').innerHTML = '<div class="history-item"><div class="history-item-title">Payment validation replay</div><div class="history-item-meta">Readable by link after upload · headers redacted</div><div class="history-item-actions"><button>Open</button><button>Copy link</button></div></div>';
  `;
}

function playerIntroScript() {
  return `
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('intro-state').classList.remove('hidden');
  `;
}

function playerReplayScript() {
  return `
    document.getElementById('loading-state').classList.add('hidden');
    const player = document.getElementById('player-state');
    player.classList.remove('hidden');
    player.dataset.layoutMode = 'horizontal';
    player.style.setProperty('--player-split-percent', '58');
    document.getElementById('player-title').textContent = 'Checkout bug - 2026-05-12 10:18';
    document.getElementById('recording-duration').textContent = '02:41';
    document.getElementById('current-time').textContent = '01:04';
    document.getElementById('total-duration').textContent = '02:41';
    document.getElementById('played-bar').style.width = '40%';
    document.getElementById('buffered-bar').style.width = '78%';
    document.getElementById('progress-handle').style.left = '40%';
    document.getElementById('video-player').outerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#101827;font:700 28px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;"><div style="width:74%;height:62%;border-radius:14px;background:linear-gradient(#eef3fb,#f8fafc);box-shadow:inset 0 0 0 1px #d9e3f2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;"><div style="width:52%;height:34px;border-radius:10px;background:#dfe7f3;"></div><div style="width:68%;height:14px;border-radius:8px;background:#c5d0df;"></div><div style="width:46%;height:46px;border-radius:10px;background:#4361ee;color:white;display:flex;align-items:center;justify-content:center;">Checkout</div></div></div>';
    document.getElementById('console-entries').innerHTML = [
      ['00:17', 'info', 'cart loaded in 321ms', 'src/cart.ts:48'],
      ['00:31', 'warn', 'retrying /api/tax after timeout', 'src/api/tax.ts:73'],
      ['01:04', 'error', 'payment validation failed: missing billing country', 'src/checkout.ts:141'],
      ['01:12', 'log', 'checkout state synchronized', 'src/store.ts:27']
    ].map(([time, level, message, source]) => '<div class="console-entry '+(level === 'error' ? 'error-entry active-entry' : '')+'"><span class="console-time">'+time+'</span><span class="console-level '+level+'">'+level.toUpperCase()+'</span><span class="console-message">'+message+'<span class="console-source-location">'+source+'</span></span></div>').join('');
    document.getElementById('network-rows').innerHTML = [
      ['GET','/assets/app.js','200','script','42 KB','success'],
      ['POST','/api/checkout','422','fetch','2.8 KB','error'],
      ['GET','/api/products','200','fetch','18 KB','success'],
      ['WS','wss://events.example','open','websocket','24 msg','success'],
      ['GET','/styles/main.css','200','stylesheet','9 KB','success']
    ].map(([method, url, status, type, size, cls], index) => '<div class="network-row '+(index === 1 ? 'active' : '')+'"><button class="toggle-expand">›</button><span class="col-method">'+method+'</span><span class="col-url">'+url+'</span><span class="col-status '+cls+'">'+status+'</span><span class="col-type">'+type+'</span><span class="col-size">'+size+'</span></div>').join('');
    document.getElementById('network-summary').textContent = '124 requests · 3 errors · 1 socket';
  `;
}

function historyScript() {
  return `
    document.getElementById('history-count').textContent = '12';
    document.getElementById('history-summary').textContent = 'Browse recent Drive uploads, reopen replay links, or copy a link for teammates.';
    document.getElementById('upload-history-list').innerHTML = [
      ['Checkout bug replay', 'Today · 02:41 · 124 requests · https://tracing.gnas.dev/1M7b...xQ'],
      ['WebSocket reconnect issue', 'Yesterday · 01:38 · 6 socket frames'],
      ['Pricing page slow API', 'May 10 · 03:12 · 218 requests']
    ].map(([title, meta]) => '<div class="history-item"><div class="history-item-title">'+title+'</div><div class="history-item-meta">'+meta+'</div><div class="history-item-actions"><button>Open replay</button><button>Copy link</button><button data-action="delete-history">Delete</button></div></div>').join('');
  `;
}

async function buildCaptures() {
  await makePopupCapture("popup-recording", popupRecordingScript());
  await makePopupCapture("popup-privacy", popupPrivacyScript());
  await makePlayerCapture("player-intro", "intro");
  await makePlayerCapture("player-replay", "replay");
  await makeHistoryCapture();
}

async function renderStoreScreenshot(config) {
  const width = 1280;
  const height = 800;
  const capPath = path.join(capturesDir, config.capture);
  const shot = config.screenshot;
  const captureBuffer = await sharp(capPath)
    .resize({ width: shot.w, height: shot.h, fit: "cover", position: "top" })
    .png()
    .toBuffer();

  const isTallCapture = shot.h > 560;
  const bg = svgRoot(
    width,
    height,
    `
    ${rect(70, 72, Math.min(320, config.badge.length * 10 + 46), 34, "rgba(46,196,182,0.18)", 17)}
    ${text(92, 94, config.badge, 15, "#9ff5ec", 800)}
    ${
      isTallCapture
        ? `${lines(70, 160, config.title, 52, colors.white, 62, 850)}
         ${lines(72, 318, config.copy, 23, colors.muted, 33, 650)}`
        : `${text(70, 172, config.title.join(" "), 56, colors.white, 850)}
         ${lines(72, 218, config.copy, 22, colors.muted, 31, 650)}`
    }
    ${rect(shot.x - 18, shot.y - 18, shot.w + 36, shot.h + 36, colors.panel, 24, colors.line, 1, 'filter="url(#shadow)"')}
    ${rect(shot.x - 10, shot.y - 10, shot.w + 20, shot.h + 20, "#091427", 18, "#385176", 1)}
  `,
  );

  await sharp(Buffer.from(bg))
    .composite([{ input: captureBuffer, left: shot.x, top: shot.y }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(screenshotsDir, config.file));
}

async function renderPromoAssets() {
  const popup = await sharp(path.join(capturesDir, "popup-recording.png"))
    .resize({ width: 150 })
    .png()
    .toBuffer();
  const player = await sharp(path.join(capturesDir, "player-replay.png"))
    .resize({ width: 470, height: 294, fit: "cover", position: "top" })
    .png()
    .toBuffer();

  const small = svgRoot(
    440,
    280,
    `
    ${rect(28, 28, 384, 224, "rgba(10,20,37,0.82)", 24, colors.line, 1)}
    ${rect(52, 52, 150, 34, "url(#accent)", 17)}
    ${text(72, 74, "GN Tracing", 15, colors.bg0, 850)}
    ${lines(52, 126, ["Bug reports", "with evidence", "teams need"], 29, colors.white, 33, 850)}
    ${text(54, 232, "Video + console + network replay", 15, colors.muted, 700)}
  `,
  );
  await sharp(Buffer.from(small))
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, "small-promo-440x280.png"));

  const marquee = svgRoot(
    1400,
    560,
    `
    ${rect(74, 80, 346, 34, "rgba(46,196,182,0.18)", 17)}
    ${text(92, 102, "Chrome/Edge debugging recorder", 15, "#9ff5ec", 800)}
    ${lines(74, 166, ["Share the full bug story,", "not just the screen."], 58, colors.white, 68, 850)}
    ${lines(76, 318, ["Capture one tab with video, console logs, network traffic,", "WebSocket activity, and a Drive-backed replay link."], 24, colors.muted, 34, 650)}
    ${rect(74, 452, 286, 34, "rgba(67,97,238,0.22)", 17)}
    ${text(92, 474, "Uses real UI screenshots", 15, "#dbe4ff", 800)}
    ${rect(786, 82, 560, 386, colors.panel, 24, colors.line, 1, 'filter="url(#shadow)"')}
    ${rect(808, 104, 516, 342, "#091427", 16, "#385176", 1)}
  `,
  );
  await sharp(Buffer.from(marquee))
    .composite([
      { input: player, left: 832, top: 128 },
      { input: popup, left: 746, top: 122 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(path.join(outDir, "marquee-promo-1400x560.png"));
}

async function writeReadme() {
  const readme = `# Chrome Web Store Assets

Generated by \`npm run store:assets\`.

The screenshots in this folder are composed from real captures of the extension popup, upload history page, and player pages. The temporary HTML fixtures load the repository's actual page markup and CSS, then populate representative state before Chrome headless captures each page.

## Upload Files

- \`icon-128.png\` - Store icon.
- \`small-promo-440x280.png\` - Small promo tile.
- \`marquee-promo-1400x560.png\` - Optional marquee promo tile.
- \`screenshots/01-popup-recording-controls.png\`
- \`screenshots/02-popup-privacy-and-drive-settings.png\`
- \`screenshots/03-player-introduction-page.png\`
- \`screenshots/04-player-replay-inspector.png\`
- \`screenshots/05-upload-history-page.png\`

Raw page captures are kept in \`captures/\` for review.
`;
  await fs.writeFile(path.join(outDir, "README.md"), readme, "utf8");
}

async function verifyImage(file, width, height) {
  const meta = await sharp(file).metadata();
  if (meta.width !== width || meta.height !== height) {
    throw new Error(
      `${path.relative(rootDir, file)} rendered as ${meta.width}x${meta.height}, expected ${width}x${height}`,
    );
  }
  return { file: path.relative(outDir, file), width: meta.width, height: meta.height };
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.rm(path.join(outDir, "sources"), { recursive: true, force: true });
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.rm(capturesDir, { recursive: true, force: true });
  await fs.rm(screenshotsDir, { recursive: true, force: true });
  await fs.mkdir(capturesDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  await fs.copyFile(path.join(rootDir, "icons", "icon128.png"), path.join(outDir, "icon-128.png"));
  await buildCaptures();

  for (const shot of storeShots) {
    await renderStoreScreenshot(shot);
  }
  await renderPromoAssets();
  await writeReadme();
  await fs.rm(tempDir, { recursive: true, force: true });

  const rendered = [
    await verifyImage(path.join(outDir, "icon-128.png"), 128, 128),
    await verifyImage(path.join(outDir, "small-promo-440x280.png"), 440, 280),
    await verifyImage(path.join(outDir, "marquee-promo-1400x560.png"), 1400, 560),
  ];
  for (const shot of storeShots) {
    rendered.push(await verifyImage(path.join(screenshotsDir, shot.file), 1280, 800));
  }
  console.table(rendered);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

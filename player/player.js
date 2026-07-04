/**
 * GN Tracing Player
 * Loads recording data from Google Drive and displays video synchronized with logs.
 *
 * This file is shared by the extension player and the hosted standalone player.
 * Keep environment-specific behavior behind adapter/config checks so both
 * runtimes stay aligned when player assets are synced.
 */

(() => {
  // ===== MODE DETECTION =====
  // Detect if running in Chrome Extension or Standalone mode
  const IS_EXTENSION =
    typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function";

  const IS_STANDALONE = !IS_EXTENSION;

  // Get config from window (set by standalone adapter if running standalone)
  const CONFIG = window.GN_TRACING_CONFIG || {};
  const PLAYER_LAYOUT_STORAGE_KEY = "gn-tracing-player-layout";
  const PLAYER_BRAND_TITLE = "GN Tracing";
  const DEFAULT_PLAYER_TITLE = "GN Tracing Player";
  const GITHUB_REPO_URL = "https://github.com/gnasdev/gn-tracing";
  const DEFAULT_LAYOUT_MODE = "horizontal";
  const DEFAULT_SPLIT_PERCENT = {
    horizontal: 50,
    vertical: 55,
  };
  const MIN_SPLIT_PERCENT = 25;
  const MAX_SPLIT_PERCENT = 75;
  const MAX_RESPONSE_DISPLAY_CHARS = 10240;
  const MAX_RESPONSE_PREVIEW_CHARS = 40000;
  const DRIVE_CACHE_NAME = "gn-tracing-drive-files-v1";
  const DRIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const DRIVE_CACHE_MAX_BYTES = 5 * 1024 * 1024;
  const DRIVE_API_FILES_URL = "https://www.googleapis.com/drive/v3/files";
  const VIDEO_DOWNLOAD_CONCURRENCY = 4;
  const ZIP_ENCRYPTION_PAYLOAD_PATH = "encrypted-payload.bin";
  const ZIP_ENCRYPTION_ALGORITHM = "AES-GCM";
  const ZIP_ENCRYPTION_KDF = "PBKDF2-SHA-256";
  const ZIP_FLAG_ENCRYPTED = 0x0001;
  const PROGRESS_END_SNAP_MS = 1000;
  const ZIP_CRYPTO_HEADER_BYTES = 12;
  const DYNAMIC_ROUTE_EXTENSIONS = new Set([".html", ".htm", ".php", ".asp", ".aspx", ".jsp"]);

  console.log("[GN Tracing Player] Mode:", IS_EXTENSION ? "extension" : "standalone");

  // State
  let videoBlob = null;
  let videoUrl = null;
  let consoleLogs = [];
  let networkLogs = [];
  let webSocketLogs = [];
  let storageArtifact = null;
  let domArtifact = null;
  // Track which snapshot each time-synced panel is currently showing, so the
  // panels only re-render when the active (by-playback-time) snapshot changes.
  let storageActiveKey = "";
  let elementsActiveIndex = -1;
  let metadata = {};
  let report = null;
  let privacySummary = null;
  let sourceMapDiagnostics = [];
  let userEvents = [];
  let effectEvents = [];
  let effectsCursorIdx = 0;
  let effectsRafId = null;
  let liveEffectNodes = [];
  let drawingStrokes = [];
  let drawingClears = [];
  let drawingRafId = null;
  const MAX_LIVE_EFFECT_NODES = 20;
  const EFFECT_TRAILING_WINDOW_MS = 300;
  let screenshotUrl = null;
  let startTime = 0;
  let currentTimeMs = 0;
  let duration = 0;

  const activeConsoleFilters = new Set();
  const activeNetworkFilters = new Set();
  let consoleSearchQuery = "";
  let networkSearchQuery = "";
  let expandedConsoleIndex = null;
  let expandedNetworkIndex = null;
  let expandedWsIndex = null;
  const networkDetailTabs = new Map();
  const networkInitiatorVendorFilters = new Map();
  const networkJsonPreviewToggles = new Map();
  // Row element caches keyed by String(item.index), one per log list, so
  // syncLogRows can look up/reuse existing rows in O(1) instead of scanning the
  // container with querySelector on every playback tick.
  const consoleRowMap = new Map();
  const networkRowMap = new Map();
  const wsRowMap = new Map();
  let closestConsoleIndex = -1;
  let closestNetworkIndex = -1;
  // Which logs tab is currently visible, plus dirty flags for the hidden ones so
  // playback ticks skip rendering panels the user can't see and catch up once
  // the tab is switched back to instead of paying the cost every tick.
  let activeLogsTab = "console";
  let consolePanelDirty = false;
  let networkPanelDirty = false;
  let layoutState = loadLayoutState();
  let isVideoFullscreen = false;
  let loadingProgressMessage = "Loading recording...";
  const loadingProgressEntries = new Map();
  let expectedVideoBytes = 0;
  let passwordPromptResolve = null;
  let passwordPromptBusy = false;

  function releaseVideoResources() {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      videoUrl = null;
    }
    videoBlob = null;
    if (elements && elements.video) {
      elements.video.removeAttribute("src");
      elements.video.load();
    }
  }

  function releaseScreenshotResources() {
    if (screenshotUrl) {
      URL.revokeObjectURL(screenshotUrl);
      screenshotUrl = null;
    }
  }

  // Auto-scroll refs
  const STICKY_SCROLL_THRESHOLD_PX = 8;

  // Recording files from Drive
  let recordingFiles = {
    packageId: null,
    indexId: null,
    folderId: null,
    manifest: null,
    videoParts: [],
    metadata: null,
    report: null,
    events: null,
    privacy: null,
    diagnostics: null,
    screenshot: null,
    console: null,
    network: null,
    websocket: null,
    drawing: null,
  };

  // DOM Elements
  const elements = {};

  function initElements() {
    elements.loadingState = document.getElementById("loading-state");
    elements.loadingMessage = document.getElementById("loading-message");
    elements.loadingProgressFill = document.getElementById("loading-progress-fill");
    elements.loadingProgressText = document.getElementById("loading-progress-text");
    elements.loadingProgressList = document.getElementById("loading-progress-list");
    elements.passwordState = document.getElementById("password-state");
    elements.passwordForm = document.getElementById("recording-password-form");
    elements.passwordInput = document.getElementById("recording-password-input");
    elements.passwordSubmit = document.getElementById("recording-password-submit");
    elements.passwordError = document.getElementById("recording-password-error");
    elements.introState = document.getElementById("intro-state");
    elements.errorState = document.getElementById("error-state");
    elements.playerState = document.getElementById("player-state");
    elements.mainLayout = document.querySelector(".main-layout");
    elements.playerTitle = document.getElementById("player-title");
    elements.reportPanel = document.getElementById("report-panel");
    elements.reportTitle = document.getElementById("report-title");
    elements.reportPageLink = document.getElementById("report-page-link");
    elements.reportMeta = document.getElementById("report-meta");
    elements.privacySummary = document.getElementById("privacy-summary");
    elements.reportScreenshot = document.getElementById("report-screenshot");
    elements.eventTimeline = document.getElementById("event-timeline");
    elements.eventList = document.getElementById("event-list");

    // Video elements
    elements.videoSection = document.getElementById("video-section");
    elements.videoContainer = document.getElementById("video-container");
    elements.video = document.getElementById("video-player");
    elements.videoEffectsLayer = document.getElementById("video-effects-layer");
    elements.drawingCanvas = document.getElementById("drawing-overlay");
    elements.playPauseBtn = document.getElementById("play-pause-btn");
    elements.playIcon = document.getElementById("play-icon");
    elements.pauseIcon = document.getElementById("pause-icon");
    elements.currentTime = document.getElementById("current-time");
    elements.totalDuration = document.getElementById("total-duration");
    elements.progressWrapper = document.getElementById("progress-wrapper");
    elements.bufferedBar = document.getElementById("buffered-bar");
    elements.playedBar = document.getElementById("played-bar");
    elements.markersContainer = document.getElementById("markers-container");
    elements.progressHandle = document.getElementById("progress-handle");
    elements.tooltip = document.getElementById("tooltip");
    elements.speedBtn = document.getElementById("speed-btn");
    elements.speedMenu = document.getElementById("speed-menu");
    elements.muteBtn = document.getElementById("mute-btn");
    elements.volumeOn = document.getElementById("volume-on");
    elements.volumeOff = document.getElementById("volume-off");
    elements.volumeSlider = document.getElementById("volume-slider");
    elements.layoutHorizontalBtn = document.getElementById("layout-horizontal-btn");
    elements.layoutVerticalBtn = document.getElementById("layout-vertical-btn");
    elements.videoFullscreenBtn = document.getElementById("video-fullscreen-btn");
    elements.fullscreenEnterIcon = document.getElementById("fullscreen-enter-icon");
    elements.fullscreenExitIcon = document.getElementById("fullscreen-exit-icon");
    elements.layoutSplitter = document.getElementById("layout-splitter");
    elements.logsPanel = document.getElementById("logs-panel");

    // Header info
    elements.recordingDuration = document.getElementById("recording-duration");
    elements.errorMessage = document.getElementById("error-message");

    // Tabs
    elements.reportTab = document.getElementById("report-tab");
    elements.consoleTab = document.getElementById("console-tab");
    elements.networkTab = document.getElementById("network-tab");
    elements.reportViewer = document.getElementById("report-viewer");
    elements.consoleViewer = document.getElementById("console-viewer");
    elements.networkViewer = document.getElementById("network-viewer");
    elements.storageTab = document.getElementById("storage-tab");
    elements.storageViewer = document.getElementById("storage-viewer");
    elements.storageContent = document.getElementById("storage-content");
    elements.elementsTab = document.getElementById("elements-tab");
    elements.elementsViewer = document.getElementById("elements-viewer");
    elements.elementsSnapshotSelect = document.getElementById("elements-snapshot-select");
    elements.elementsTree = document.getElementById("elements-tree");

    // Console
    elements.consoleFilters = document.getElementById("console-filters");
    elements.consoleSearch = document.getElementById("console-search");
    elements.consoleEntries = document.getElementById("console-entries");

    // Network
    elements.networkFilters = document.getElementById("network-filters");
    elements.networkSearch = document.getElementById("network-search");
    elements.networkSummary = document.getElementById("network-summary");
    elements.networkEntries = document.getElementById("network-entries");
    elements.networkRows = document.getElementById("network-rows");
    elements.websocketSection = document.getElementById("websocket-section");
    elements.websocketRows = document.getElementById("websocket-rows");
  }

  function clampSplitPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_SPLIT_PERCENT[DEFAULT_LAYOUT_MODE];
    }
    return Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, numeric));
  }

  function loadLayoutState() {
    const fallback = {
      mode: DEFAULT_LAYOUT_MODE,
      splitPercent: DEFAULT_SPLIT_PERCENT[DEFAULT_LAYOUT_MODE],
    };

    try {
      const raw = window.localStorage.getItem(PLAYER_LAYOUT_STORAGE_KEY);
      if (!raw) {
        return fallback;
      }

      const parsed = JSON.parse(raw);
      const mode = parsed?.mode === "vertical" ? "vertical" : DEFAULT_LAYOUT_MODE;
      const defaultPercent = DEFAULT_SPLIT_PERCENT[mode];
      return {
        mode,
        splitPercent: clampSplitPercent(parsed?.splitPercent ?? defaultPercent),
      };
    } catch (error) {
      console.warn("[GN Tracing Player] Failed to load layout state:", error);
      return fallback;
    }
  }

  function saveLayoutState() {
    try {
      window.localStorage.setItem(PLAYER_LAYOUT_STORAGE_KEY, JSON.stringify(layoutState));
    } catch (error) {
      console.warn("[GN Tracing Player] Failed to persist layout state:", error);
    }
  }

  function updateFullscreenButton() {
    elements.videoFullscreenBtn.classList.toggle("active", isVideoFullscreen);
    elements.fullscreenEnterIcon.classList.toggle("hidden", isVideoFullscreen);
    elements.fullscreenExitIcon.classList.toggle("hidden", !isVideoFullscreen);
    elements.videoFullscreenBtn.title = isVideoFullscreen
      ? "Exit expanded video"
      : "Expand video in tab";
    elements.videoFullscreenBtn.setAttribute("aria-pressed", String(isVideoFullscreen));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }

  function renderLoadingProgress() {
    const progressEntries = Array.from(loadingProgressEntries.values());
    const uploadedBytes = progressEntries.reduce(
      (sum, entry) => sum + (entry.total > 0 ? Math.min(entry.loaded, entry.total) : 0),
      0,
    );
    const videoLoadedBytes = progressEntries
      .filter((entry) => entry.group === "video")
      .reduce((sum, entry) => sum + (entry.total > 0 ? Math.min(entry.loaded, entry.total) : 0), 0);
    const videoKnownTotalBytes = progressEntries
      .filter((entry) => entry.group === "video")
      .reduce((sum, entry) => sum + entry.total, 0);
    const otherTotalBytes = progressEntries
      .filter((entry) => entry.group !== "video")
      .reduce((sum, entry) => sum + entry.total, 0);
    const totalBytes =
      Math.max(videoKnownTotalBytes, expectedVideoBytes, videoLoadedBytes) + otherTotalBytes;
    const percent =
      totalBytes > 0 ? Math.max(0, Math.min(100, (uploadedBytes / totalBytes) * 100)) : 0;

    if (elements.loadingMessage) {
      elements.loadingMessage.textContent = loadingProgressMessage;
    }
    if (elements.loadingProgressFill) {
      elements.loadingProgressFill.style.width = `${percent}%`;
    }
    if (elements.loadingProgressText) {
      elements.loadingProgressText.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)} (${percent.toFixed(1)}%)`;
    }
    if (elements.loadingProgressList) {
      elements.loadingProgressList.innerHTML = "";
    }
  }

  function resetLoadingProgress(message = "Loading recording...") {
    loadingProgressEntries.clear();
    expectedVideoBytes = 0;
    loadingProgressMessage = message;
    renderLoadingProgress();
  }

  function setLoadingMessage(message) {
    loadingProgressMessage = message;
    renderLoadingProgress();
  }

  function setExpectedVideoBytes(totalBytes) {
    expectedVideoBytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
    renderLoadingProgress();
  }

  function updateLoadingEntry(
    key,
    { loaded = 0, total = 0, group = "other", label, status, message } = {},
  ) {
    const previous = loadingProgressEntries.get(key) || {
      loaded: 0,
      total: 0,
      group,
      label: label || key,
      status: "Queued",
    };
    loadingProgressEntries.set(key, {
      loaded: Math.max(0, loaded),
      total: Math.max(0, total || previous.total || 0),
      group,
      label: label || previous.label || key,
      status: status || previous.status || "Queued",
    });
    if (message) {
      loadingProgressMessage = message;
    }
    renderLoadingProgress();
  }

  function registerLoadingEntry(key, label, group, status = "Queued") {
    updateLoadingEntry(key, { label, group, status, loaded: 0, total: 0 });
  }

  function markLoadingEntryLoaded(key, label, group) {
    const current = loadingProgressEntries.get(key);
    const loaded = current?.loaded || 0;
    const total = current?.total || loaded || 0;
    updateLoadingEntry(key, {
      loaded,
      total,
      group,
      label,
      status: "Loaded",
    });
  }

  function markPendingLoadingEntriesFailed() {
    for (const [key, entry] of loadingProgressEntries.entries()) {
      if (entry.status === "Loaded" || entry.status === "Failed") {
        continue;
      }
      loadingProgressEntries.set(key, {
        ...entry,
        status: "Failed",
      });
    }
    renderLoadingProgress();
  }

  function setPasswordPromptBusy(isBusy) {
    passwordPromptBusy = isBusy;
    if (elements.passwordInput) {
      elements.passwordInput.disabled = isBusy;
    }
    if (elements.passwordSubmit) {
      elements.passwordSubmit.disabled = isBusy;
      elements.passwordSubmit.textContent = isBusy ? "Unlocking..." : "Unlock";
    }
  }

  function setPasswordPromptError(message) {
    if (!elements.passwordError) {
      return;
    }
    elements.passwordError.textContent = message || "";
    elements.passwordError.classList.toggle("hidden", !message);
  }

  function requestRecordingPassword(errorMessage = "") {
    setPasswordPromptBusy(false);
    setPasswordPromptError(errorMessage);
    showPasswordPrompt();
    return new Promise((resolve) => {
      passwordPromptResolve = resolve;
      window.setTimeout(() => elements.passwordInput?.focus(), 0);
    });
  }

  function createLoadingProgressReporter(key, group, label) {
    return ({ loaded, total }) => {
      updateLoadingEntry(key, { loaded, total, group, label, status: "Loading" });
    };
  }

  function applyLayoutState() {
    const mode = layoutState.mode === "vertical" ? "vertical" : "horizontal";
    const splitPercent = clampSplitPercent(layoutState.splitPercent);
    layoutState = { mode, splitPercent };

    elements.playerState.dataset.layoutMode = mode;
    elements.playerState.style.setProperty("--player-split-percent", String(splitPercent));
    elements.layoutSplitter.setAttribute(
      "aria-orientation",
      mode === "vertical" ? "horizontal" : "vertical",
    );
    elements.layoutHorizontalBtn.classList.toggle("active", mode === "horizontal");
    elements.layoutVerticalBtn.classList.toggle("active", mode === "vertical");
    elements.layoutHorizontalBtn.setAttribute("aria-pressed", String(mode === "horizontal"));
    elements.layoutVerticalBtn.setAttribute("aria-pressed", String(mode === "vertical"));
    elements.playerState.classList.toggle("is-video-fullscreen", isVideoFullscreen);
    updateFullscreenButton();
    window.requestAnimationFrame(updateVideoFit);
  }

  function setLayoutMode(mode) {
    const nextMode = mode === "vertical" ? "vertical" : "horizontal";
    layoutState.mode = nextMode;
    layoutState.splitPercent = clampSplitPercent(
      layoutState.splitPercent || DEFAULT_SPLIT_PERCENT[nextMode],
    );
    applyLayoutState();
    saveLayoutState();
  }

  function setSplitPercent(percent, persist = true) {
    layoutState.splitPercent = clampSplitPercent(percent);
    applyLayoutState();
    if (persist) {
      saveLayoutState();
    }
  }

  function toggleVideoFullscreen() {
    isVideoFullscreen = !isVideoFullscreen;
    applyLayoutState();
  }

  // Utility functions
  function formatTime(ms) {
    const totalSec = Math.floor(Math.max(0, ms) / 1000);
    const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const sec = String(totalSec % 60).padStart(2, "0");
    return `${min}:${sec}`;
  }

  function getFiniteDurationMs(value) {
    const durationMs = Number(value);
    return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  }

  function getVideoDurationMs() {
    return getFiniteDurationMs((elements.video?.duration || 0) * 1000);
  }

  function syncDurationState(extraDurationMs = 0) {
    // MediaRecorder WebM metadata can report 0/Infinity while playback still advances.
    duration = Math.max(
      getFiniteDurationMs(duration),
      getFiniteDurationMs(metadata?.duration),
      getFiniteDurationMs(extraDurationMs),
    );
    elements.totalDuration.textContent = formatTime(duration);
    elements.recordingDuration.textContent = formatTime(duration);
    return duration;
  }

  function formatTimeMs(ms) {
    const safeMs = Math.max(0, ms);
    const totalSec = Math.floor(safeMs / 1000);
    const millis = String(Math.floor(safeMs % 1000)).padStart(3, "0");
    const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const sec = String(totalSec % 60).padStart(2, "0");
    return `${min}:${sec}.${millis}`;
  }

  function getFilterLevel(entry) {
    if (entry.source === "exception") return "exception";
    if (entry.source === "browser") return "browser";
    return getConsoleLevel(entry);
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function truncateUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname + u.search;
      return p.length > 60 ? p.slice(0, 60) + "..." : p;
    } catch {
      return url && url.length > 60 ? url.slice(0, 60) + "..." : url;
    }
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getRecordingTitleLabel(meta) {
    if (!meta || typeof meta !== "object") {
      return "";
    }

    const parts = [];
    const rawUrl = typeof meta.url === "string" ? meta.url : "";
    const recordedAt = meta.startTime || meta.timestamp;

    if (rawUrl) {
      try {
        const url = new URL(rawUrl);
        parts.push(url.hostname.replace(/^www\./, ""));

        const segments = url.pathname.split("/").filter(Boolean);
        const lastSegment = segments[segments.length - 1];
        if (lastSegment) {
          parts.push(lastSegment.length > 24 ? `${lastSegment.slice(0, 24)}...` : lastSegment);
        }
      } catch {
        parts.push(rawUrl.length > 40 ? `${rawUrl.slice(0, 40)}...` : rawUrl);
      }
    }

    if (recordedAt) {
      const date = new Date(recordedAt);
      if (!Number.isNaN(date.getTime())) {
        parts.push(
          date.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        );
      }
    }

    return parts.filter(Boolean).join(" • ");
  }

  function updatePlayerTitle(meta) {
    const reportTitle = report && typeof report.title === "string" ? report.title.trim() : "";
    const label = reportTitle || getRecordingTitleLabel(meta);

    if (elements.playerTitle) {
      elements.playerTitle.textContent = PLAYER_BRAND_TITLE;
      elements.playerTitle.title = PLAYER_BRAND_TITLE;
    }

    document.title = label ? `${label} | ${DEFAULT_PLAYER_TITLE}` : DEFAULT_PLAYER_TITLE;
  }

  function getDisplayUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      return `${parsed.hostname.replace(/^www\./, "")}${truncateUrl(url)}`;
    } catch {
      return String(url);
    }
  }

  function getEventLabel(event) {
    if (!event || !event.type) return "Event";
    if (event.type === "navigation") {
      return `Navigation ${getDisplayUrl(event.url || "")}`.trim();
    }
    if (event.type === "click") {
      return `Click ${event.text || event.selector || event.role || ""}`.trim();
    }
    if (event.type === "contextmenu") {
      return `Right click ${event.text || event.selector || event.role || ""}`.trim();
    }
    if (event.type === "scroll") {
      return `Scroll ${event.direction === "up" ? "up" : "down"} ${event.selector || ""}`.trim();
    }
    if (event.type === "focus") {
      return `Focus ${event.selector || event.inputType || ""}`.trim();
    }
    if (event.type === "submit") {
      return `Submit ${event.selector || ""}`.trim();
    }
    return event.type;
  }

  function getReportMetaChips() {
    const chips = [];
    if (duration) {
      chips.push(`Duration ${formatTime(duration)}`);
    }
    if (report?.createdAt) {
      chips.push(`Created ${formatDate(report.createdAt)}`);
    }
    if (report?.severity) {
      chips.push(`Severity ${report.severity}`);
    }
    if (report?.reference) {
      chips.push(`Reference ${report.reference}`);
    }

    const env = report?.environment || {};
    if (env.browserName || env.browserVersion) {
      chips.push([env.browserName, env.browserVersion].filter(Boolean).join(" "));
    }
    if (env.viewport?.width && env.viewport?.height) {
      chips.push(`Viewport ${env.viewport.width}x${env.viewport.height}`);
    }
    if (env.language) {
      chips.push(`Language ${env.language}`);
    }
    if (env.timezone) {
      chips.push(`Timezone ${env.timezone}`);
    }
    return chips;
  }

  function getPrivacySummaryRows() {
    if (!privacySummary || typeof privacySummary !== "object") {
      return [];
    }
    const rows = [];
    const profile = privacySummary.profile ? String(privacySummary.profile) : "unknown";
    rows.push(`Policy v${privacySummary.policyVersion || 1} · ${profile}`);
    const flags = privacySummary.artifactFlags || {};
    const evidence = Object.entries(flags)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([name]) => name)
      .slice(0, 8);
    if (evidence.length) {
      rows.push(`Evidence: ${evidence.join(", ")}`);
    }
    const counts = Array.isArray(privacySummary.counts) ? privacySummary.counts : [];
    const redactionTotal = counts.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    if (redactionTotal > 0) {
      rows.push(`${redactionTotal} redaction${redactionTotal === 1 ? "" : "s"} applied`);
    }
    const limitations = Array.isArray(privacySummary.limitations)
      ? privacySummary.limitations.filter(Boolean).slice(0, 2)
      : [];
    rows.push(...limitations.map((item) => `Limit: ${item}`));
    return rows;
  }

  function showLogsTab(tabName) {
    const isReport = tabName === "report";
    const isConsole = tabName === "console";
    const isNetwork = tabName === "network";
    const isStorage = tabName === "storage";
    const isElements = tabName === "elements";

    elements.reportTab?.classList.toggle("active", isReport);
    elements.consoleTab.classList.toggle("active", isConsole);
    elements.networkTab.classList.toggle("active", isNetwork);
    elements.storageTab?.classList.toggle("active", isStorage);
    elements.elementsTab?.classList.toggle("active", isElements);
    elements.reportViewer?.classList.toggle("hidden", !isReport);
    elements.consoleViewer.classList.toggle("hidden", !isConsole);
    elements.networkViewer.classList.toggle("hidden", !isNetwork);
    elements.storageViewer?.classList.toggle("hidden", !isStorage);
    elements.elementsViewer?.classList.toggle("hidden", !isElements);

    activeLogsTab = tabName;
    if (isConsole && consolePanelDirty) {
      consolePanelDirty = false;
      renderConsoleEntries();
    } else if (isNetwork && networkPanelDirty) {
      networkPanelDirty = false;
      renderNetworkEntries();
    }
  }

  // Build a one-row-per-key diff between two storage groups. Every key present
  // in start∪stop yields exactly one row (Property P4 / R5.2).
  function diffStorageGroups(startItems, stopItems) {
    const startMap = new Map((startItems || []).map((it) => [it.key, it.value]));
    const stopMap = new Map((stopItems || []).map((it) => [it.key, it.value]));
    const rows = [];
    for (const [key, value] of stopMap) {
      if (!startMap.has(key)) {
        rows.push({ key, status: "added", value });
      } else if (startMap.get(key) !== value) {
        rows.push({ key, status: "changed", from: startMap.get(key), to: value });
      } else {
        rows.push({ key, status: "unchanged", value });
      }
    }
    for (const [key, value] of startMap) {
      if (!stopMap.has(key)) {
        rows.push({ key, status: "removed", value });
      }
    }
    return rows;
  }

  // Normalize a snapshot's group into a list of { key, value }. Cookies use the
  // cookie `name` as the diff key.
  function toStorageItems(snapshot, group) {
    if (!snapshot) return [];
    const raw = Array.isArray(snapshot[group]) ? snapshot[group] : [];
    if (group === "cookies") {
      return raw.map((c) => ({ key: c?.name ?? "", value: c?.value ?? "" }));
    }
    return raw.map((kv) => ({ key: kv?.key ?? "", value: kv?.value ?? "" }));
  }

  function getStorageDiffValueHtml(row) {
    if (row.status === "changed") {
      return [
        `<span class="storage-value storage-value-from">${escapeHtml(row.from)}</span>`,
        '<span class="storage-value-arrow" aria-hidden="true">→</span>',
        `<span class="storage-value storage-value-to">${escapeHtml(row.to)}</span>`,
      ].join("");
    }
    const value = row.value ?? "";
    const legacy = `<span class="storage-value">${escapeHtml(value)}</span>`;
    const parsed = tryParseJsonObject(value);
    if (parsed === undefined) {
      return legacy;
    }
    return buildLunaJsonMount(parsed, legacy, "storage-value-mount");
  }

  function getStorageGroupHtml(label, startItems, stopItems) {
    const rows = diffStorageGroups(startItems, stopItems);
    rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));

    const body = rows.length
      ? rows
          .map(
            (row) => `
        <div class="storage-row storage-row-${row.status}">
          <span class="storage-status-badge storage-status-${row.status}">${escapeHtml(row.status)}</span>
          <span class="storage-key">${escapeHtml(row.key)}</span>
          <span class="storage-value-cell">${getStorageDiffValueHtml(row)}</span>
        </div>`,
          )
          .join("")
      : '<div class="storage-empty">No entries captured.</div>';

    return `
      <section class="storage-group" aria-label="${escapeHtml(label)}">
        <h3 class="storage-group-title">${escapeHtml(label)} <span class="storage-group-count">(${rows.length})</span></h3>
        <div class="storage-group-rows">${body}</div>
      </section>`;
  }

  // Render the Storage tab with 3 groups (localStorage, sessionStorage, cookies)
  // diffed between the start and stop snapshots. Hides the tab when there is no
  // storage artifact (R5.1, R5.4).
  // Returns the relative playback time (ms from recording start) of a snapshot,
  // or null when its capture time cannot be related to the recording start.
  function getSnapshotRelativeMs(snapshot) {
    const capturedAt = Number(snapshot?.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0 || !Number.isFinite(startTime)) {
      return null;
    }
    return capturedAt - startTime;
  }

  // Picks the snapshot active at the current playback time: the latest snapshot
  // captured at or before `currentTimeMs`. Falls back to the earliest snapshot
  // when playback is before the first capture. Returns its index.
  function getActiveSnapshotIndexByTime(snapshots) {
    let activeIndex = 0;
    let bestRel = Number.NEGATIVE_INFINITY;
    let earliestRel = Number.POSITIVE_INFINITY;
    let earliestIndex = 0;
    for (let i = 0; i < snapshots.length; i += 1) {
      const rel = getSnapshotRelativeMs(snapshots[i]);
      if (rel === null) continue;
      if (rel < earliestRel) {
        earliestRel = rel;
        earliestIndex = i;
      }
      if (rel <= currentTimeMs && rel >= bestRel) {
        bestRel = rel;
        activeIndex = i;
      }
    }
    return bestRel === Number.NEGATIVE_INFINITY ? earliestIndex : activeIndex;
  }

  function renderStorageTab() {
    const snapshots = Array.isArray(storageArtifact?.snapshots) ? storageArtifact.snapshots : [];
    const hasStorage = snapshots.length > 0;

    elements.storageTab?.classList.toggle("hidden", !hasStorage);

    if (!hasStorage) {
      // If the storage tab was active but is now hidden, fall back to console.
      if (elements.storageTab?.classList.contains("active")) {
        showLogsTab("console");
      }
      if (elements.storageContent) {
        elements.storageContent.innerHTML = "";
      }
      storageActiveKey = "";
      return;
    }

    storageActiveKey = "";
    updateStorageForTime();
  }

  // Renders the storage diff for the current playback time: localStorage /
  // sessionStorage / cookies diffed between the start snapshot and the snapshot
  // active at `currentTimeMs`. Before the stop snapshot's time the diff shows
  // the start state (all "unchanged"); once playback passes stop, the full
  // start↔stop diff is shown. Only re-renders when the active snapshot changes.
  function updateStorageForTime() {
    if (!elements.storageContent) return;
    const snapshots = Array.isArray(storageArtifact?.snapshots) ? storageArtifact.snapshots : [];
    if (snapshots.length === 0) return;

    const startSnapshot = snapshots.find((s) => s?.phase === "start") || snapshots[0];
    const activeIndex = getActiveSnapshotIndexByTime(snapshots);
    const currentSnapshot = snapshots[activeIndex] || startSnapshot;

    const key = String(activeIndex);
    if (key === storageActiveKey) return;
    storageActiveKey = key;

    const groups = [
      { label: "localStorage", group: "localStorage" },
      { label: "sessionStorage", group: "sessionStorage" },
      { label: "Cookies", group: "cookies" },
    ];

    elements.storageContent.innerHTML = groups
      .map(({ label, group }) =>
        getStorageGroupHtml(
          label,
          toStorageItems(startSnapshot, group),
          toStorageItems(currentSnapshot, group),
        ),
      )
      .join("");

    mountLunaPlaceholders(elements.storageContent);
  }

  // --- Elements / DOM snapshot panel (Item 3, R8.1–R8.3) ---

  // Human-readable label for a DOM snapshot dropdown option (R8.2).
  function getDomSnapshotLabel(snapshot, index) {
    const rawLabel = snapshot && typeof snapshot.label === "string" ? snapshot.label : "";
    const label = rawLabel || `snapshot ${index + 1}`;
    const capturedAt = Number(snapshot?.capturedAt);
    if (Number.isFinite(capturedAt) && capturedAt > 0) {
      const time = new Date(capturedAt).toLocaleTimeString();
      return `${label} — ${time}`;
    }
    return label;
  }

  // Render a single DOM node (and its descendants) as a <details>/<summary>
  // tree. Masked nodes never expose original text; they carry REDACTED_VALUE
  // from capture and are flagged with a visible badge.
  function renderDomNodeFallback(node) {
    if (!node || typeof node !== "object") return "";

    const nodeType = Number(node.nodeType);
    const isMasked = node.masked === true;
    const maskedBadge = isMasked
      ? '<span class="dom-masked-badge" title="Content masked for privacy">masked</span>'
      : "";

    // Text node (nodeType 3) / CDATA (4) / comment (8): render value only.
    if (nodeType === 3 || nodeType === 4 || nodeType === 8) {
      const text = typeof node.nodeValue === "string" ? node.nodeValue : "";
      const trimmed = text.trim();
      if (!trimmed && !isMasked) return "";
      const cls = nodeType === 8 ? "dom-comment" : "dom-text";
      return `<div class="dom-leaf ${cls}">${maskedBadge}<span class="dom-text-value">${escapeHtml(trimmed)}</span></div>`;
    }

    const tagName = typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "node";

    // Build attribute string (attribute values already redacted at capture).
    let attrsHtml = "";
    if (node.attributes && typeof node.attributes === "object") {
      const parts = [];
      for (const [name, value] of Object.entries(node.attributes)) {
        parts.push(
          ` <span class="dom-attr-name">${escapeHtml(name)}</span>=<span class="dom-attr-value">"${escapeHtml(String(value))}"</span>`,
        );
      }
      attrsHtml = parts.join("");
    }

    const children = Array.isArray(node.children) ? node.children : [];
    const childHtml = children.map((child) => renderDomNodeFallback(child)).join("");

    const openTag = `<span class="dom-tag">&lt;${escapeHtml(tagName)}${attrsHtml}&gt;</span>`;

    // Leaf element (no rendered children): single summary line.
    if (!childHtml) {
      return `<div class="dom-leaf dom-element">${maskedBadge}${openTag}<span class="dom-tag">&lt;/${escapeHtml(tagName)}&gt;</span></div>`;
    }

    return `
      <details class="dom-node" open>
        <summary class="dom-summary">${maskedBadge}${openTag}</summary>
        <div class="dom-children">${childHtml}</div>
        <div class="dom-leaf dom-close-tag"><span class="dom-tag">&lt;/${escapeHtml(tagName)}&gt;</span></div>
      </details>`;
  }

  // Render a DOM snapshot's tree into a container. Prefers window.LunaDomViewer
  // when present; otherwise falls back to a <details>/<summary> tree. MUST NOT
  // throw when LunaDomViewer is undefined (R8.3).
  function renderDomTree(rootNode, container) {
    if (!container) return;
    container.innerHTML = "";

    if (!rootNode || typeof rootNode !== "object") {
      container.innerHTML = '<div class="dom-empty">No DOM nodes captured.</div>';
      return;
    }

    const DomViewer = window.LunaDomViewer;
    if (typeof DomViewer === "function") {
      try {
        const viewer = new DomViewer(container, { node: rootNode });
        if (viewer && typeof viewer.expand === "function") {
          viewer.expand();
        }
        return;
      } catch (error) {
        // Fall through to the safe fallback renderer.
        console.warn("[GN Tracing Player] LunaDomViewer failed, using fallback:", error);
        container.innerHTML = "";
      }
    }

    container.innerHTML = renderDomNodeFallback(rootNode);
  }

  // Render the Elements tab: hide when there is no DOM artifact/snapshot
  // (R8.1 negative); otherwise populate the snapshot dropdown (R8.2) and render
  // the selected snapshot's tree (R8.3).
  function renderElementsTab() {
    const snapshots = Array.isArray(domArtifact?.snapshots) ? domArtifact.snapshots : [];
    const hasSnapshots = snapshots.length > 0;

    elements.elementsTab?.classList.toggle("hidden", !hasSnapshots);

    if (!hasSnapshots) {
      // If the elements tab was active but is now hidden, fall back to console.
      if (elements.elementsTab?.classList.contains("active")) {
        showLogsTab("console");
      }
      if (elements.elementsSnapshotSelect) {
        elements.elementsSnapshotSelect.innerHTML = "";
      }
      if (elements.elementsTree) {
        elements.elementsTree.innerHTML = "";
      }
      elementsActiveIndex = -1;
      return;
    }

    const select = elements.elementsSnapshotSelect;
    if (select) {
      select.innerHTML = snapshots
        .map(
          (snapshot, index) =>
            `<option value="${index}">${escapeHtml(getDomSnapshotLabel(snapshot, index))}</option>`,
        )
        .join("");
      // Manually picking a snapshot seeks playback to its capture time, so the
      // dropdown and the timeline stay in sync (the timeupdate handler then
      // keeps the selection following playback). When the snapshot has no
      // relatable time, just render it directly.
      select.onchange = () => {
        const index = Number.parseInt(select.value, 10);
        const safeIndex = Number.isFinite(index) ? index : 0;
        const rel = getSnapshotRelativeMs(snapshots[safeIndex]);
        if (rel !== null && elements.video) {
          elements.video.currentTime = Math.max(0, rel / 1000);
          currentTimeMs = elements.video.currentTime * 1000;
        }
        elementsActiveIndex = -1; // force re-render of the chosen snapshot
        updateElementsForTime(safeIndex);
      };
    }

    elementsActiveIndex = -1;
    updateElementsForTime();
  }

  // Selects and renders the DOM snapshot active at the current playback time
  // (or an explicit index when provided). Only re-renders when the active
  // snapshot changes, so it is cheap to call on every timeupdate.
  function updateElementsForTime(explicitIndex) {
    const tree = elements.elementsTree;
    if (!tree) return;
    const snapshots = Array.isArray(domArtifact?.snapshots) ? domArtifact.snapshots : [];
    if (snapshots.length === 0) return;

    const index =
      typeof explicitIndex === "number" && Number.isFinite(explicitIndex)
        ? explicitIndex
        : getActiveSnapshotIndexByTime(snapshots);
    if (index === elementsActiveIndex) return;
    elementsActiveIndex = index;

    if (elements.elementsSnapshotSelect) {
      elements.elementsSnapshotSelect.value = String(index);
    }
    renderDomTree(snapshots[index]?.root, tree);
  }

  function renderPrivacySummary() {
    if (!elements.privacySummary) {
      return;
    }

    const privacyRows = getPrivacySummaryRows();
    const hasPrivacyRows = privacyRows.length > 0;
    elements.privacySummary.classList.toggle("hidden", !hasPrivacyRows);
    elements.privacySummary.innerHTML = hasPrivacyRows
      ? [
          '<div class="privacy-summary-title">Privacy summary</div>',
          ...privacyRows.map((row) => `<div class="privacy-summary-row">${escapeHtml(row)}</div>`),
        ].join("")
      : "";
  }

  function renderReportPanel() {
    if (!elements.reportPanel) return;

    const pageUrl = report?.page?.url || metadata.url || "";
    const title = report?.title || getRecordingTitleLabel(metadata);
    const hasReportContent = Boolean(
      report || privacySummary || userEvents.length || screenshotUrl,
    );
    const isFirstReportRender = elements.reportTab?.classList.contains("hidden");

    elements.reportTab?.classList.toggle("hidden", !hasReportContent);
    elements.reportPanel.classList.toggle("hidden", !hasReportContent);
    renderPrivacySummary();
    if (!hasReportContent) {
      if (elements.reportTab?.classList.contains("active")) {
        showLogsTab("console");
      }
      return;
    }
    if (isFirstReportRender) {
      showLogsTab("report");
    }

    elements.reportTitle.textContent = title || "Recorded session";
    if (pageUrl) {
      elements.reportPageLink.href = pageUrl;
      elements.reportPageLink.textContent = getDisplayUrl(pageUrl);
      elements.reportPageLink.classList.remove("hidden");
    } else {
      elements.reportPageLink.classList.add("hidden");
    }

    const chips = getReportMetaChips();
    elements.reportMeta.innerHTML = chips
      .map((chip) => `<span class="report-meta-chip">${escapeHtml(chip)}</span>`)
      .join("");

    if (screenshotUrl) {
      elements.reportScreenshot.src = screenshotUrl;
      elements.reportScreenshot.classList.remove("hidden");
    } else {
      elements.reportScreenshot.removeAttribute("src");
      elements.reportScreenshot.classList.add("hidden");
    }

    elements.eventTimeline.classList.toggle("hidden", userEvents.length === 0);
    elements.eventList.innerHTML = userEvents
      .slice(0, 12)
      .map((event) => {
        const timeMs = Math.max(0, Number(event.relativeMs) || 0);
        return `
        <button class="event-item" type="button" data-time-ms="${timeMs}">
          <span class="event-time">${escapeHtml(formatTime(timeMs))}</span>
          <span class="event-label">${escapeHtml(getEventLabel(event))}</span>
        </button>
      `;
      })
      .join("");
  }

  function getNetworkUrlExtension(url) {
    try {
      const pathname = new URL(url || "", "http://x").pathname.toLowerCase();
      const lastSegment = pathname.split("/").pop() || "";
      const dot = lastSegment.lastIndexOf(".");
      if (dot > 0 && dot < lastSegment.length - 1) {
        return lastSegment.slice(dot);
      }
    } catch {}

    return "";
  }

  function isFileLikeNetworkUrl(url) {
    const ext = getNetworkUrlExtension(url);
    if (!ext) return false;

    return !DYNAMIC_ROUTE_EXTENSIONS.has(ext);
  }

  function detectNetworkFilterFromUrlAndMime(url, mimeType) {
    const normalizedMimeType = String(mimeType || "").toLowerCase();

    if (normalizedMimeType.includes("javascript") || normalizedMimeType.includes("ecmascript"))
      return "js";
    if (normalizedMimeType.includes("css")) return "css";
    if (normalizedMimeType.includes("html")) return "doc";
    if (normalizedMimeType.startsWith("image/")) return "img";
    if (normalizedMimeType.startsWith("font/")) return "font";
    if (normalizedMimeType.startsWith("audio/") || normalizedMimeType.startsWith("video/"))
      return "media";

    try {
      const ext = getNetworkUrlExtension(url);
      if (ext) {
        const extMap = {
          ".js": "js",
          ".mjs": "js",
          ".cjs": "js",
          ".map": "js",
          ".css": "css",
          ".png": "img",
          ".jpg": "img",
          ".jpeg": "img",
          ".gif": "img",
          ".svg": "img",
          ".webp": "img",
          ".ico": "img",
          ".avif": "img",
          ".bmp": "img",
          ".woff": "font",
          ".woff2": "font",
          ".ttf": "font",
          ".eot": "font",
          ".otf": "font",
          ".mp4": "media",
          ".webm": "media",
          ".mp3": "media",
          ".ogg": "media",
          ".wav": "media",
          ".html": "doc",
          ".htm": "doc",
          ".php": "doc",
          ".asp": "doc",
          ".aspx": "doc",
          ".jsp": "doc",
          ".json": "other",
          ".xml": "other",
          ".txt": "other",
          ".csv": "other",
          ".pdf": "other",
          ".zip": "other",
        };
        if (extMap[ext]) return extMap[ext];
      }
    } catch {}

    if (normalizedMimeType.includes("json")) return "fetch";

    return null;
  }

  function getNetworkFilterType(entry) {
    const resourceType = String(entry.resourceType || "").trim();
    const normalizedResourceType = resourceType.toLowerCase();
    const url = (entry.request && entry.request.url) || entry.url || "";
    const mimeType = (entry.response && entry.response.mimeType) || entry.mimeType || "";

    if (normalizedResourceType === "xhr" || normalizedResourceType === "fetch") {
      const detectedType = detectNetworkFilterFromUrlAndMime(url, mimeType);
      if (detectedType && detectedType !== "doc") return detectedType;
      if (isFileLikeNetworkUrl(url)) return "other";
      return "fetch";
    }

    const typeMap = {
      script: "js",
      stylesheet: "css",
      image: "img",
      document: "doc",
      font: "font",
      media: "media",
      texttrack: "media",
      websocket: "ws",
      xhr: "fetch",
      fetch: "fetch",
      preflight: "fetch",
      prefetch: "fetch",
      eventsource: "fetch",
      manifest: "doc",
      signedexchange: "doc",
      ping: "other",
      cspviolationreport: "other",
      fedcm: "other",
      other: "other",
    };

    if (typeMap[normalizedResourceType]) {
      return typeMap[normalizedResourceType];
    }

    const detectedType = detectNetworkFilterFromUrlAndMime(url, mimeType);
    if (detectedType) return detectedType;

    return "other";
  }

  function getConsoleLevel(entry) {
    if (entry.source === "exception") return "error";
    if (entry.source === "browser") return entry.level || "info";
    return entry.level || "log";
  }

  function getConsoleLevelLabel(entry) {
    if (entry.source === "exception") return "EXCEPTION";
    if (entry.source === "browser") return "BROWSER";
    return (entry.level || "log").toUpperCase();
  }

  function getStatusColorClass(status) {
    if (!status) return "other";
    if (status >= 200 && status < 300) return "success";
    if (status >= 300 && status < 400) return "redirect";
    return "error";
  }

  function normalizeSearchQuery(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function stringifyForSearch(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(stringifyForSearch).join(" ");
    if (typeof value === "object") {
      if (typeof value.value === "string") return value.value;
      if (typeof value.description === "string") return value.description;
      if (typeof value.text === "string") return value.text;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function isUsableLocationFrame(frame) {
    return Boolean(frame && !frame.asyncBoundary && (frame.originalSource || frame.url));
  }

  function getFirstStackFrame(frames) {
    return (frames || []).find(isUsableLocationFrame) || null;
  }

  function getFirstCdpStackFrame(stack) {
    if (!stack) return null;
    const frame = getFirstStackFrame(stack.callFrames);
    return frame || getFirstCdpStackFrame(stack.parent);
  }

  function hasSourceMappedLocation(location) {
    return Boolean(location?.originalSource && typeof location.originalLine === "number");
  }

  function getLocationLine(location) {
    return hasSourceMappedLocation(location) ? location.originalLine : location.lineNumber;
  }

  function getLocationColumn(location) {
    return hasSourceMappedLocation(location) ? location.originalColumn : location.columnNumber;
  }

  function formatSourceLocation(location) {
    if (!location) return "";
    const source = hasSourceMappedLocation(location) ? location.originalSource : location.url || "";
    if (!source) return "";

    // Captured artifacts store CDP coordinates as zero-based values.
    const line = getLocationLine(location);
    const column = getLocationColumn(location);
    if (typeof line !== "number") return source;
    if (typeof column !== "number") return `${source}:${line + 1}`;
    return `${source}:${line + 1}:${column + 1}`;
  }

  function preferSourceMappedLocation(primary, fallback) {
    if (hasSourceMappedLocation(primary)) return primary;
    if (hasSourceMappedLocation(fallback)) return fallback;
    return primary || fallback || null;
  }

  function getConsoleSourceLocation(entry) {
    const entryLocation = isUsableLocationFrame(entry) ? entry : null;
    const stackLocation = getFirstStackFrame(entry.stackTrace);
    return formatSourceLocation(preferSourceMappedLocation(entryLocation, stackLocation));
  }

  function getConsoleSourceSnippet(entry) {
    if (entry?.sourceSnippet?.lines?.length) return entry.sourceSnippet;
    const frame = (entry?.stackTrace || []).find(
      (item) => !item.asyncBoundary && item.sourceSnippet?.lines?.length,
    );
    return frame?.sourceSnippet || null;
  }

  function formatSnippetSourceLocation(snippet) {
    if (!snippet?.source) return "";
    const line = typeof snippet.line === "number" ? snippet.line + 1 : null;
    const column = typeof snippet.column === "number" ? snippet.column + 1 : null;
    if (!line) return snippet.source;
    return column ? `${snippet.source}:${line}:${column}` : `${snippet.source}:${line}`;
  }

  function renderSourceSnippet(snippet) {
    if (!snippet?.lines?.length) return "";
    const activeLine = typeof snippet.line === "number" ? snippet.line : -1;
    const startLine = typeof snippet.startLine === "number" ? snippet.startLine : 0;
    const location = formatSnippetSourceLocation(snippet);
    const rows = snippet.lines
      .map((line, index) => {
        const lineNumber = startLine + index;
        const isActive = lineNumber === activeLine;
        return `
        <div class="source-preview-row ${isActive ? "active" : ""}">
          <span class="source-preview-line">${lineNumber + 1}</span>
          <code>${escapeHtml(line)}</code>
        </div>
      `;
      })
      .join("");

    return `
      <div class="source-preview">
        ${location ? `<div class="source-preview-location">${escapeHtml(location)}</div>` : ""}
        <div class="source-preview-code">${rows}</div>
        ${snippet.truncated ? '<div class="source-preview-note">Line truncated in recording artifact.</div>' : ""}
      </div>
    `;
  }

  function getNetworkInitiatorLocation(initiator) {
    if (!initiator) return "";
    const initiatorLocation = isUsableLocationFrame(initiator) ? initiator : null;
    const stackLocation = getFirstCdpStackFrame(initiator.stack);
    return formatSourceLocation(preferSourceMappedLocation(initiatorLocation, stackLocation));
  }

  function getNetworkInitiatorSummary(initiator) {
    const location = getNetworkInitiatorLocation(initiator);
    if (!location) return "";
    const type = initiator?.type || "other";
    return `${type} @ ${location}`;
  }

  function collectInitiatorStackFrames(stack, frames = []) {
    if (!stack) return frames;
    frames.push(...(stack.callFrames || []));
    return collectInitiatorStackFrames(stack.parent, frames);
  }

  function renderInitiatorStackFrames(stack) {
    let html = (stack.callFrames || [])
      .map((frame) => {
        const fnName = frame.originalName || frame.functionName || "(anonymous)";
        const location = formatSourceLocation(frame);
        const isVendor = isNetworkVendorFrame(frame);
        return `<div class="stack-frame ${isVendor ? "vendor-frame" : ""}">at <span class="fn-name">${escapeHtml(fnName)}</span>${location ? ` <span class="location">(${escapeHtml(location)})</span>` : ""}</div>`;
      })
      .join("");
    if (stack.parent) {
      html += `<div class="async-boundary">--- ${escapeHtml(stack.parent.description || "async")} ---</div>`;
      html += renderInitiatorStackFrames(stack.parent);
    }
    return html;
  }

  // Shared initiator section for network and WebSocket details. The vendor
  // toggle is opt-in because its click handler is wired to network rows only.
  function renderInitiatorSection(initiator, options = {}) {
    if (!initiator) return "";
    let html = `
      <div class="detail-section">
        <h4>Initiator</h4>
        <pre>${escapeHtml(initiator.type || "other")}</pre>
    `;
    const loc = getNetworkInitiatorLocation(initiator);
    if (loc) {
      html += `<pre class="initiator-location">${escapeHtml(loc)}</pre>`;
    }
    const sourceMapStatus = getNetworkSourceMapDiagnostic(initiator);
    if (sourceMapStatus) {
      html += `<pre class="initiator-location">${escapeHtml(sourceMapStatus)}</pre>`;
    }
    if (initiator.stack && initiator.stack.callFrames) {
      const hideVendorFrames = Boolean(options.hideVendorFrames);
      if (options.showVendorToggle) {
        const vendorFrameCount = collectInitiatorStackFrames(initiator.stack).filter(
          isNetworkVendorFrame,
        ).length;
        if (vendorFrameCount > 0) {
          html += `
            <button
              class="initiator-filter-toggle ${hideVendorFrames ? "active" : ""}"
              type="button"
              aria-pressed="${hideVendorFrames}"
            >
              Hide gray frames (${vendorFrameCount})
            </button>
          `;
        }
      }
      html += `<div class="initiator-stack ${hideVendorFrames ? "hide-vendor-frames" : ""}">`;
      html += renderInitiatorStackFrames(initiator.stack);
      html += "</div>";
    }
    html += "</div>";
    return html;
  }

  function getSourceMapUrlKeys(url) {
    const keys = new Set();
    if (!url) return [];
    keys.add(url);

    try {
      const parsed = new URL(url);
      parsed.hash = "";
      keys.add(parsed.href);
      if (parsed.search) {
        parsed.search = "";
        keys.add(parsed.href);
      }
    } catch {
      const hashIndex = url.indexOf("#");
      if (hashIndex >= 0) {
        keys.add(url.slice(0, hashIndex));
      }
    }

    return Array.from(keys);
  }

  function getSourceMapDiagnosticForLocation(location) {
    if (!location || hasSourceMappedLocation(location)) return null;
    const url = location.url || "";
    if (!url) return null;
    const keys = new Set(getSourceMapUrlKeys(url));
    return (
      sourceMapDiagnostics.find((diagnostic) =>
        getSourceMapUrlKeys(diagnostic.generatedUrl).some((key) => keys.has(key)),
      ) || null
    );
  }

  function formatSourceMapReason(reason, httpStatusCode) {
    const messages = {
      "pending-frame-id": "Source map unavailable: waiting for frame id",
      "missing-frame-id": "Source map unavailable: missing frame id",
      "unsupported-target": "Source map unavailable: unsupported target",
      "unsupported-url": "Source map unavailable: unsupported URL",
      "too-large": "Source map unavailable: file too large",
      "network-failed": "Source map unavailable: network load failed",
      "http-error": `Source map unavailable: HTTP ${httpStatusCode || "error"}`,
      "stream-read-failed": "Source map unavailable: stream read failed",
      "html-fallback": "Source map response was HTML, not JSON",
      "non-json-response": "Source map response was not JSON",
      "json-parse-failed": "Source map JSON could not be parsed",
      "unsupported-map": "Source map format is not supported",
      "no-map-for-generated-url": "Source map unavailable for this generated URL",
      "no-generated-line": "Source map loaded but this generated line was not mapped",
      "no-segment-for-column": "Source map loaded but no segment matched this generated column",
      "no-original-segment": "Source map loaded but matching segment had no original location",
    };
    return messages[reason] || `Source map unavailable: ${reason || "unknown"}`;
  }

  function getSourceMapDiagnosticMessage(location) {
    if (location?.sourceMapStatus) {
      return formatSourceMapReason(
        location.sourceMapStatus.reason,
        location.sourceMapStatus.httpStatusCode,
      );
    }
    const diagnostic = getSourceMapDiagnosticForLocation(location);
    if (!diagnostic) return "";
    if (diagnostic.status === "success") {
      return "Source map loaded, but this frame did not match a mapped segment.";
    }
    return formatSourceMapReason(diagnostic.reason || diagnostic.status, diagnostic.httpStatusCode);
  }

  function getConsoleSourceMapDiagnostic(entry) {
    const entryLocation = isUsableLocationFrame(entry) ? entry : null;
    const stackLocation = getFirstStackFrame(entry.stackTrace);
    return (
      getSourceMapDiagnosticMessage(entryLocation) ||
      getSourceMapDiagnosticMessage(stackLocation) ||
      ""
    );
  }

  function getNetworkSourceMapDiagnostic(initiator) {
    if (!initiator) return "";
    const initiatorLocation = isUsableLocationFrame(initiator) ? initiator : null;
    const stackLocation = getFirstCdpStackFrame(initiator.stack);
    return (
      getSourceMapDiagnosticMessage(initiatorLocation) ||
      getSourceMapDiagnosticMessage(stackLocation) ||
      ""
    );
  }

  function getConsoleSearchText(entry) {
    const sourceLocation = getConsoleSourceLocation(entry);
    const parts = [
      entry.source,
      entry.level,
      entry.message,
      entry.url,
      entry.originalSource,
      stringifyForSearch(entry.sourceSnippet),
      sourceLocation,
      renderArgs(entry),
      ...(entry.args || []).map(stringifyForSearch),
      ...(entry.stackTrace || []).flatMap((frame) => [
        frame.asyncBoundary,
        frame.functionName,
        frame.originalName,
        frame.url,
        frame.originalSource,
        stringifyForSearch(frame.sourceSnippet),
      ]),
    ];

    return normalizeSearchQuery(parts.filter(Boolean).join(" "));
  }

  function getNetworkSearchText(entry) {
    const request = entry.request || {};
    const response = entry.response || {};
    const content = getNetworkResponseContent(entry);
    const initiator = entry.initiator || {};
    const initiatorLocation = getNetworkInitiatorLocation(initiator);

    const parts = [
      entry.method,
      request.method,
      entry.url,
      request.url,
      entry.resourceType,
      entry.status,
      response.status,
      entry.statusText,
      response.statusText,
      entry.mimeType,
      content.mimeType,
      entry.error,
      entry.remoteIPAddress,
      entry.postData,
      request.postData,
      content.text,
      stringifyForSearch(entry.requestHeaders),
      stringifyForSearch(request.headers),
      stringifyForSearch(entry.responseHeaders),
      stringifyForSearch(response.headers),
      stringifyForSearch(entry.redirectChain),
      initiator.type,
      initiator.url,
      initiator.originalSource,
      initiatorLocation,
      stringifyForSearch(initiator.stack),
    ];

    return normalizeSearchQuery(parts.filter(Boolean).join(" "));
  }

  function getWsSearchText(ws) {
    const frames = Array.isArray(ws.frames) ? ws.frames : [];
    const frameText = frames
      .map((frame) => stringifyForSearch(frame.payloadData || frame.text || frame.opcode))
      .join(" ");
    return normalizeSearchQuery([ws.url, ws.closed ? "closed" : "open", frameText].join(" "));
  }

  // Attaches a lazy, self-caching `searchText` getter so building it (which can
  // walk response bodies, stack frames, and stringify headers) only happens for
  // entries a user actually searches, and never more than once per entry.
  function defineLazySearchText(target, compute) {
    Object.defineProperty(target, "searchText", {
      configurable: true,
      get() {
        const value = compute();
        Object.defineProperty(target, "searchText", {
          value,
          configurable: true,
          enumerable: true,
        });
        return value;
      },
    });
    return target;
  }

  // Index of the first entry whose relativeMs exceeds timeMs, in an array
  // sorted ascending by entry.relativeMs. Equivalent to (but O(log n) vs O(n)
  // for) `items.filter((pe) => pe.entry.relativeMs <= timeMs).length`.
  function findTimeBoundaryIndex(items, timeMs) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (items[mid].entry.relativeMs <= timeMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  // Prepared-entry caches, keyed by the array identity they were built from.
  // consoleLogs/networkLogs/webSocketLogs are only ever replaced (not mutated)
  // when a new recording loads, so an identity check is a correct and free
  // invalidation signal — no explicit cache-busting calls needed.
  let preparedConsoleCache = null;
  let preparedNetworkCache = null;
  let preparedWsCache = null;

  function getPreparedConsoleEntries() {
    if (preparedConsoleCache && preparedConsoleCache.source === consoleLogs) {
      return preparedConsoleCache.items;
    }
    const items = consoleLogs.map((entry, index) => {
      const pe = {
        entry,
        index,
        level: getConsoleLevel(entry),
        filterLevel: getFilterLevel(entry),
      };
      return defineLazySearchText(pe, () => getConsoleSearchText(entry));
    });
    preparedConsoleCache = { source: consoleLogs, items };
    return items;
  }

  function getPreparedNetworkEntries() {
    if (preparedNetworkCache && preparedNetworkCache.source === networkLogs) {
      return preparedNetworkCache.items;
    }
    const items = networkLogs.map((entry, index) => {
      const pe = {
        entry,
        index,
        filterType: getNetworkFilterType(entry),
      };
      return defineLazySearchText(pe, () => getNetworkSearchText(entry));
    });
    preparedNetworkCache = { source: networkLogs, items };
    return items;
  }

  function getPreparedWebSocketEntries() {
    if (preparedWsCache && preparedWsCache.source === webSocketLogs) {
      return preparedWsCache.items;
    }
    const items = webSocketLogs.map((ws, index) => {
      const item = { ws, index };
      return defineLazySearchText(item, () => getWsSearchText(ws));
    });
    preparedWsCache = { source: webSocketLogs, items };
    return items;
  }

  function getVisibleConsoleEntries() {
    const consoleQuery = normalizeSearchQuery(consoleSearchQuery);
    const prepared = getPreparedConsoleEntries();
    let visible = prepared.slice(0, findTimeBoundaryIndex(prepared, currentTimeMs));

    if (activeConsoleFilters.size > 0) {
      visible = visible.filter((pe) => activeConsoleFilters.has(pe.filterLevel));
    }
    if (consoleQuery) {
      visible = visible.filter((pe) => pe.searchText.includes(consoleQuery));
    }
    return visible;
  }

  function getVisibleNetworkEntries() {
    const networkQuery = normalizeSearchQuery(networkSearchQuery);
    const prepared = getPreparedNetworkEntries();
    let visible = prepared.slice(0, findTimeBoundaryIndex(prepared, currentTimeMs));

    if (activeNetworkFilters.size > 0) {
      visible = visible.filter((pe) => activeNetworkFilters.has(pe.filterType));
    }
    if (networkQuery) {
      visible = visible.filter((pe) => pe.searchText.includes(networkQuery));
    }
    return visible;
  }

  function getVisibleWebSocketEntries() {
    const networkQuery = normalizeSearchQuery(networkSearchQuery);
    let visible = getPreparedWebSocketEntries();

    if (activeNetworkFilters.size > 0 && !activeNetworkFilters.has("ws")) {
      visible = [];
    }
    if (networkQuery) {
      visible = visible.filter((item) => item.searchText.includes(networkQuery));
    }
    return visible;
  }

  function getRemoteObjectMessage(obj) {
    const description = String(obj?.description || obj?.value || obj?.className || "Error");
    const firstStackLine = description.search(/\n\s+at\s+/);
    const message = firstStackLine >= 0 ? description.slice(0, firstStackLine) : description;
    return message || "Error";
  }

  function renderRemoteObjectStackTrace(frames) {
    if (!Array.isArray(frames) || frames.length === 0) {
      return "";
    }
    const rows = frames
      .map((frame) => {
        if (frame.asyncBoundary) {
          return `<div class="async-boundary">--- ${escapeHtml(frame.asyncBoundary)} ---</div>`;
        }
        const fnName = frame.originalName || frame.functionName || "(anonymous)";
        const location = formatSourceLocation(frame);
        const sourceMapStatus = getSourceMapDiagnosticMessage(frame);
        return `
          <div class="stack-frame">
            at <span class="fn-name">${escapeHtml(fnName)}</span>${location ? ` <span class="location">(${escapeHtml(location)})</span>` : ""}
            ${sourceMapStatus ? `<div class="source-map-note">${escapeHtml(sourceMapStatus)}</div>` : ""}
          </div>
        `;
      })
      .join("");
    return `<div class="stack-trace remote-object-stack">${rows}</div>`;
  }

  // Render remote object to HTML
  function renderRemoteObject(obj, options = {}) {
    if (!obj) return '<span class="gh-secondary">undefined</span>';

    switch (obj.type) {
      case "undefined":
        return '<span class="gh-secondary">undefined</span>';
      case "boolean":
        return `<span class="gh-blue-num">${obj.value}</span>`;
      case "number":
        return `<span class="gh-blue-num">${obj.description || obj.value}</span>`;
      case "bigint":
        return `<span class="gh-blue-num">${obj.description || obj.value}n</span>`;
      case "string":
        return `<span class="gh-blue-str">"${escapeHtml(obj.value != null ? String(obj.value) : obj.description || "")}"</span>`;
      case "symbol":
        return `<span class="gh-purple">${escapeHtml(obj.description || "Symbol()")}</span>`;
      case "function":
        return `<span class="gh-purple italic">f ${escapeHtml(obj.description || "anonymous")}</span>`;
      case "object":
        return renderObjectPreview(obj, options);
      default:
        return escapeHtml(obj.description || String(obj.value));
    }
  }

  function renderObjectPreview(obj, options = {}) {
    if (obj.subtype === "null") return '<span class="gh-secondary">null</span>';
    if (obj.subtype === "error") {
      if (!Array.isArray(obj.stackTrace) || obj.stackTrace.length === 0) {
        return `<span class="gh-error">${escapeHtml(obj.description || "Error")}</span>`;
      }
      const stackTrace = options.includeStack ? renderRemoteObjectStackTrace(obj.stackTrace) : "";
      return `<span class="gh-error">${escapeHtml(getRemoteObjectMessage(obj))}</span>${stackTrace}`;
    }
    if (obj.subtype === "regexp")
      return `<span class="gh-orange">${escapeHtml(obj.description || "")}</span>`;
    if (obj.subtype === "date")
      return `<span class="gh-blue-str">${escapeHtml(obj.description || "")}</span>`;
    if (obj.preview) return renderPreview(obj.preview);
    return `<span class="gh-secondary">${escapeHtml(obj.description || obj.className || "Object")}</span>`;
  }

  function renderPreview(preview) {
    if (!preview.properties || preview.properties.length === 0) {
      if (preview.subtype === "array") return "[]";
      return "{}";
    }

    const isArray = preview.subtype === "array";
    const open = isArray ? "[" : "{";
    const close = isArray ? "]" : "}";

    const props = preview.properties
      .map((p) => {
        const val = renderPreviewValue(p);
        if (isArray) return val;
        return `<span class="gh-purple">${escapeHtml(p.name)}</span>: ${val}`;
      })
      .join(", ");

    const overflow = preview.overflow ? ", ..." : "";
    return `${open}${props}${overflow}${close}`;
  }

  function renderPreviewValue(prop) {
    if (prop.valuePreview) return renderPreview(prop.valuePreview);

    switch (prop.type) {
      case "string":
        return `<span class="gh-blue-str">"${escapeHtml(prop.value || "")}"</span>`;
      case "number":
      case "bigint":
        return `<span class="gh-blue-num">${prop.value}</span>`;
      case "boolean":
        return `<span class="gh-blue-num">${prop.value}</span>`;
      case "undefined":
        return '<span class="gh-secondary">undefined</span>';
      case "function":
        return '<span class="gh-purple italic">f</span>';
      case "object":
        if (prop.subtype === "null") return '<span class="gh-secondary">null</span>';
        return `<span class="gh-secondary">${escapeHtml(prop.value || "Object")}</span>`;
      default:
        return escapeHtml(prop.value || "");
    }
  }

  // ---------------------------------------------------------------------------
  // luna-* render adapters (Item 1 / R6.2–R6.5)
  //
  // The player is non-bundled vanilla JS, so the prebuilt luna UMD bundles are
  // loaded via <script> and expose `window.LunaObjectViewer` /
  // `window.LunaJsonEditor` (see player/vendor/luna/VERSIONS.md). These adapters
  // mount a luna viewer into a live DOM container when the global is present and
  // fall back to the existing legacy string renderers otherwise. They MUST NOT
  // throw when the global is undefined (R6.3 / Property P1).
  //
  // Integration uses progressive enhancement: render functions emit a
  // `.luna-mount` placeholder whose default content is the legacy HTML, and
  // `mountLunaPlaceholders()` upgrades those placeholders to luna after the HTML
  // is inserted into the DOM. If luna is missing (or anything throws) the legacy
  // content stays visible.
  //
  // NOTE on the real luna API (verified against the vendored bundles' own
  // prototypes via Object.getOwnPropertyNames, which differ from the design
  // pseudocode):
  //   - luna-object-viewer@0.3.2: `new LunaObjectViewer(el); viewer.set(value)`.
  //   - luna-json-editor@0.1.0: `new LunaJsonEditor(el, options)` then
  //     `editor.setValue(value)` — there is NO `set()` method (only
  //     `setValue`/`getValue`), and NO `readOnly` option; read-only is enforced
  //     via `nameEditable/valueEditable/enableInsert/enableDelete = false`. We
  //     still expose `options.readOnly === true` on the instance for the
  //     read-only contract (R6.4 / Property P2).
  function lunaObjectViewerAvailable() {
    return typeof window !== "undefined" && typeof window.LunaObjectViewer === "function";
  }

  function lunaJsonEditorAvailable() {
    return typeof window !== "undefined" && typeof window.LunaJsonEditor === "function";
  }

  // Legacy fallback for object values (console args are RemoteObject shapes).
  function renderObjectValueLegacy(container, value) {
    if (!container) return null;
    container.innerHTML = renderRemoteObject(value, { includeStack: true });
    return null;
  }

  // Render an object value (RemoteObject) using luna-object-viewer when present,
  // else fall back to the legacy renderer. Never throws (R6.3 / Property P1).
  function renderObjectValue(container, value) {
    if (!container) return null;
    const ObjectViewer = typeof window !== "undefined" ? window.LunaObjectViewer : undefined;
    if (typeof ObjectViewer !== "function") {
      return renderObjectValueLegacy(container, value);
    }
    const originalClassName = container.className;
    try {
      container.textContent = "";
      const viewer = new ObjectViewer(container);
      viewer.set(remoteObjectToPlain(value));
      return viewer;
    } catch {
      // The constructor above already stamps `container.className` with its
      // own classes before `.set()` runs, so a caught error must restore the
      // pre-mount classes — otherwise the legacy fallback below inherits
      // vendor CSS (e.g. `user-select: none`) meant for the aborted widget.
      container.className = originalClassName;
      return renderObjectValueLegacy(container, value);
    }
  }

  // Legacy fallback for JSON values: highlighted, read-only <pre> block.
  function renderJsonLegacy(container, jsonValue) {
    if (!container) return null;
    let text;
    try {
      text = JSON.stringify(jsonValue, null, 2);
    } catch {
      text = String(jsonValue);
    }
    container.innerHTML = `<pre class="json-preview-body response-code-block">${highlightJson(text)}</pre>`;
    return null;
  }

  // Render a JSON value read-only using luna-json-editor when present, else fall
  // back to the legacy renderer. Read-only per R6.4 / Property P2. Never throws.
  function renderJsonReadonly(container, jsonValue) {
    if (!container) return null;
    const JsonEditor = typeof window !== "undefined" ? window.LunaJsonEditor : undefined;
    if (typeof JsonEditor !== "function") {
      return renderJsonLegacy(container, jsonValue);
    }
    const originalClassName = container.className;
    try {
      container.textContent = "";
      // luna-json-editor API: `new LunaJsonEditor(container, options)` then
      // `.setValue(data)` — NOT `.set()`. Verified against the vendored
      // bundle's prototype (`Object.getOwnPropertyNames`): it exposes
      // `setValue`/`getValue`, not `set`; calling `.set()` throws and silently
      // falls back to the legacy renderer every time. Read-only is enforced by
      // disabling every edit affordance (the component has no `readOnly`
      // option).
      const editor = new JsonEditor(container, {
        enableInsert: false,
        enableDelete: false,
        nameEditable: false,
        valueEditable: false,
      });
      editor.setValue(jsonValue);
      // Mirror the read-only intent on the instance options for the contract
      // assertion in tests (R6.4 / Property P2).
      editor.options = editor.options || {};
      editor.options.readOnly = true;
      if (typeof editor.expand === "function") {
        editor.expand();
      }
      return editor;
    } catch {
      // See renderObjectValue: the constructor already stamps `container`
      // with luna's own classes before `.setValue()` runs, so a caught error
      // must restore the pre-mount classes — otherwise the legacy fallback
      // below inherits vendor CSS (e.g. `user-select: none`) meant for the
      // aborted widget.
      container.className = originalClassName;
      return renderJsonLegacy(container, jsonValue);
    }
  }

  // Convert a CDP-style RemoteObject (the console arg shape consumed by the
  // legacy renderers) into a plain JS value so luna-object-viewer can display
  // it. Bounded in depth to avoid pathological previews. Used only on the luna
  // path; the legacy fallback keeps using the RemoteObject directly (R6.5).
  function remoteObjectToPlain(obj, depth) {
    const d = depth || 0;
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object" || Array.isArray(obj)) return obj;
    if (typeof obj.type !== "string") return obj;

    switch (obj.type) {
      case "undefined":
        return undefined;
      case "boolean":
        return typeof obj.value === "boolean" ? obj.value : obj.description;
      case "number":
        return obj.value !== undefined ? obj.value : Number(obj.description);
      case "bigint":
        return obj.description ? `${obj.description}n` : String(obj.value);
      case "string":
        return obj.value != null ? String(obj.value) : obj.description || "";
      case "symbol":
        return obj.description || "Symbol()";
      case "function":
        return obj.description || "\u0192 anonymous";
      case "object": {
        if (obj.subtype === "null") return null;
        if (d > 5) return obj.description || obj.className || "Object";
        return remoteObjectPreviewToPlain(obj, d);
      }
      default:
        return obj.description != null ? obj.description : (obj.value ?? null);
    }
  }

  function remoteObjectPreviewToPlain(obj, d) {
    const preview = obj.preview;
    if (!preview || !Array.isArray(preview.properties)) {
      return obj.description || obj.className || "Object";
    }
    const isArray = preview.subtype === "array" || obj.subtype === "array";
    const result = isArray ? [] : {};
    for (const prop of preview.properties) {
      const value = previewPropToPlain(prop, d + 1);
      if (isArray) {
        result.push(value);
      } else {
        result[prop.name] = value;
      }
    }
    if (preview.overflow) {
      if (isArray) {
        result.push("\u2026");
      } else {
        result["\u2026"] = "more properties";
      }
    }
    return result;
  }

  function previewPropToPlain(prop, d) {
    if (prop.valuePreview && d <= 5) {
      const nestedPreview = prop.valuePreview;
      const isArray = nestedPreview.subtype === "array";
      const nested = isArray ? [] : {};
      if (Array.isArray(nestedPreview.properties)) {
        for (const nestedProp of nestedPreview.properties) {
          const nestedValue = previewPropToPlain(nestedProp, d + 1);
          if (isArray) {
            nested.push(nestedValue);
          } else {
            nested[nestedProp.name] = nestedValue;
          }
        }
      }
      if (nestedPreview.overflow) {
        if (isArray) {
          nested.push("\u2026");
        } else {
          nested["\u2026"] = "more";
        }
      }
      return nested;
    }

    switch (prop.type) {
      case "string":
        return prop.value != null ? String(prop.value) : "";
      case "number":
      case "bigint":
        return prop.value !== undefined ? Number(prop.value) : prop.value;
      case "boolean":
        return prop.value === true || prop.value === "true";
      case "undefined":
        return undefined;
      case "function":
        return "\u0192";
      case "object":
        return prop.subtype === "null" ? null : prop.value || "Object";
      default:
        return prop.value != null ? prop.value : null;
    }
  }

  // Parse text as a JSON object/array (not a bare primitive). Returns undefined
  // when the text is not a JSON container, so callers keep their legacy output.
  function tryParseJsonObject(text) {
    if (typeof text !== "string") return undefined;
    const trimmed = text.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
    try {
      const value = JSON.parse(trimmed);
      return value && typeof value === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  // Build a `.luna-mount` placeholder for an object (console arg RemoteObject).
  // Default content is the legacy HTML; mountLunaPlaceholders upgrades it later.
  function buildLunaObjectMount(remoteObject) {
    const legacy = renderRemoteObject(remoteObject, { includeStack: true });
    let payload;
    try {
      payload = encodeURIComponent(JSON.stringify(remoteObject));
    } catch {
      return legacy;
    }
    return `<div class="luna-mount" data-luna-kind="object" data-luna-payload="${payload}">${legacy}</div>`;
  }

  // Build a `.luna-mount` placeholder for a JSON value. Default content is the
  // provided legacy HTML; mountLunaPlaceholders upgrades it later.
  function buildLunaJsonMount(jsonValue, legacyHtml, extraClass) {
    let payload;
    try {
      payload = encodeURIComponent(JSON.stringify(jsonValue));
    } catch {
      return legacyHtml;
    }
    const className = extraClass ? `luna-mount ${extraClass}` : "luna-mount";
    return `<div class="${className}" data-luna-kind="json" data-luna-payload="${payload}">${legacyHtml}</div>`;
  }

  // Upgrade `.luna-mount` placeholders within `root` (default: document) to luna
  // viewers. Already-upgraded placeholders are skipped. Keeps legacy content
  // when luna is unavailable or the payload cannot be parsed (R6.3 / Property P1).
  function mountLunaPlaceholders(root) {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    let nodes;
    try {
      nodes = scope.querySelectorAll(".luna-mount:not([data-luna-mounted])");
    } catch {
      return;
    }
    nodes.forEach((el) => {
      el.setAttribute("data-luna-mounted", "1");
      const kind = el.getAttribute("data-luna-kind");
      const raw = el.getAttribute("data-luna-payload") || "";
      if (!raw) return;
      if (kind === "object" && !lunaObjectViewerAvailable()) return;
      if (kind === "json" && !lunaJsonEditorAvailable()) return;
      let value;
      try {
        value = JSON.parse(decodeURIComponent(raw));
      } catch {
        return;
      }
      if (kind === "object") {
        renderObjectValue(el, value);
      } else if (kind === "json") {
        renderJsonReadonly(el, value);
      }
    });
  }

  function renderArgs(entry) {
    // Handle new format with entry.source
    if (entry.source !== undefined) {
      if (entry.source === "exception" || entry.source === "browser") {
        const msg = entry.message || "";
        const firstStackLine = msg.search(/\n\s+at /);
        const displayMsg = firstStackLine >= 0 ? msg.substring(0, firstStackLine) : msg;
        return escapeHtml(displayMsg);
      }
      if (!Array.isArray(entry.args)) return String(entry.args || "");
      return entry.args.map((arg) => renderRemoteObject(arg)).join(" ");
    }

    // Old format
    if (!Array.isArray(entry.args)) return escapeHtml(String(entry.args));
    return entry.args
      .map((arg) => {
        if (arg === null) return "null";
        if (arg === undefined || arg === "undefined") return "undefined";
        if (typeof arg === "object") {
          if (arg.type === "Error") {
            return escapeHtml(`${arg.message || ""}\n${arg.stack || ""}`);
          }
          try {
            return escapeHtml(JSON.stringify(arg));
          } catch {
            return String(arg);
          }
        }
        return escapeHtml(String(arg));
      })
      .join(" ");
  }

  function formatHeaders(headers) {
    if (!headers) return "(none)";
    if (Array.isArray(headers)) {
      return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
    }
    if (typeof headers === "object") {
      return Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
    }
    return String(headers);
  }

  function getNetworkResponseContent(entry) {
    const response = entry.response || {};
    const content = response.content || {};
    const responseBody = entry.responseBody || null;

    return {
      mimeType: content.mimeType || response.mimeType || entry.mimeType || "",
      size: content.size ?? entry.encodedDataLength ?? 0,
      text: content.text ?? responseBody?.body ?? "",
      encoding: content.encoding || (responseBody?.base64Encoded ? "base64" : undefined),
    };
  }

  function decodeBase64Text(value) {
    if (!value) return null;

    try {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  function getUrlPathname(url) {
    try {
      return new URL(url, "https://example.invalid").pathname || "";
    } catch {
      return "";
    }
  }

  function detectResponseBodyKind(entry, content) {
    const mimeType = String(content.mimeType || "").toLowerCase();
    const pathname = getUrlPathname((entry.request || {}).url || entry.url || "").toLowerCase();

    if (mimeType.includes("json") || pathname.endsWith(".json")) return "json";
    if (
      mimeType.includes("javascript") ||
      mimeType.includes("ecmascript") ||
      pathname.endsWith(".js") ||
      pathname.endsWith(".mjs") ||
      pathname.endsWith(".cjs")
    )
      return "js";
    if (mimeType.includes("html") || pathname.endsWith(".html") || pathname.endsWith(".htm"))
      return "html";
    if (mimeType.includes("css") || pathname.endsWith(".css")) return "css";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    return "text";
  }

  function getResponseBodyText(entry, content) {
    if (!content.text) return "";
    if (content.encoding === "base64") {
      const detectedKind = detectResponseBodyKind(entry, content);
      if (
        detectedKind === "json" ||
        detectedKind === "js" ||
        detectedKind === "html" ||
        detectedKind === "css" ||
        String(content.mimeType || "").startsWith("text/")
      ) {
        return decodeBase64Text(content.text) || "";
      }
      return "";
    }
    return String(content.text);
  }

  function buildPreviewDataUrl(mimeType, payload) {
    if (!mimeType || !payload) return null;
    return `data:${mimeType};base64,${payload}`;
  }

  function formatJsonPreview(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  function validateJsonBody(text) {
    if (typeof text !== "string") {
      return null;
    }

    const source = text.trim();
    if (!source) {
      return null;
    }

    try {
      const value = JSON.parse(source);
      return {
        formatted: JSON.stringify(value, null, 2),
      };
    } catch {
      return null;
    }
  }

  function getNetworkJsonPreviewKey(entry, bodyKind) {
    return `${getNetworkDetailTabKey(entry)}:${bodyKind}`;
  }

  function isNetworkJsonPreviewVisible(entry, bodyKind) {
    return networkJsonPreviewToggles.get(getNetworkJsonPreviewKey(entry, bodyKind)) === true;
  }

  function getNetworkJsonPreviewSignature(entry) {
    return ["request", "response"]
      .map((bodyKind) => `${bodyKind}:${isNetworkJsonPreviewVisible(entry, bodyKind) ? "1" : "0"}`)
      .join("|");
  }

  function buildJsonPreviewToggle(entry, bodyKind, validation) {
    if (!validation) {
      return "";
    }

    const isVisible = isNetworkJsonPreviewVisible(entry, bodyKind);
    const label = isVisible ? "Hide preview" : "Show preview";

    return `
      <button
        type="button"
        class="json-preview-toggle"
        data-action="toggle-json-preview"
        data-body-kind="${bodyKind}"
        aria-expanded="${isVisible}"
      >
        ${label}
      </button>
    `;
  }

  function buildJsonPreviewPanel(entry, bodyKind, validation) {
    if (!validation || !isNetworkJsonPreviewVisible(entry, bodyKind)) {
      return "";
    }

    const legacy = `
      <pre class="json-preview-body response-code-block">${highlightJson(validation.formatted)}</pre>
    `;
    let parsed;
    try {
      parsed = JSON.parse(validation.formatted);
    } catch {
      return legacy;
    }
    return buildLunaJsonMount(parsed, legacy, "json-preview-mount");
  }

  function isJsonPreviewReplacingRaw(entry, bodyKind, validation) {
    return Boolean(validation && isNetworkJsonPreviewVisible(entry, bodyKind));
  }

  function highlightJson(text) {
    const source = formatJsonPreview(text);
    return tokenizeWithPattern(
      source,
      /("(?:\\.|[^"\\])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token, match) => {
        if (/^"/.test(token)) return match[2] ? "token-key" : "token-string";
        if (token === "true" || token === "false") return "token-boolean";
        if (token === "null") return "token-null";
        return "token-number";
      },
    );
  }

  function tokenizeWithPattern(text, pattern, classifyToken) {
    let result = "";
    let lastIndex = 0;
    let match = pattern.exec(text);

    while (match !== null) {
      const [token] = match;
      result += escapeHtml(text.slice(lastIndex, match.index));
      const cls = classifyToken(token, match);
      result += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
      lastIndex = match.index + token.length;
      match = pattern.exec(text);
    }

    result += escapeHtml(text.slice(lastIndex));
    pattern.lastIndex = 0;
    return result;
  }

  function highlightJavascript(text) {
    const pattern =
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:await|async|break|case|catch|class|const|continue|default|delete|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|null|return|super|switch|this|throw|true|false|try|typeof|var|while|yield)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    return tokenizeWithPattern(text, pattern, (token) => {
      if (token.startsWith("//") || token.startsWith("/*")) return "token-comment";
      if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`"))
        return "token-string";
      if (/^-?\d/.test(token)) return "token-number";
      return "token-keyword";
    });
  }

  function highlightCss(text) {
    const pattern =
      /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[a-z-]+|\.[\w-]+|#[\w-]+|-?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg)?|#[0-9a-fA-F]{3,8})/g;
    return tokenizeWithPattern(text, pattern, (token) => {
      if (token.startsWith("/*")) return "token-comment";
      if (token.startsWith('"') || token.startsWith("'")) return "token-string";
      if (token.startsWith("@")) return "token-keyword";
      if (token.startsWith(".") || token.startsWith("#"))
        return token.length > 1 && /^[#.][\w-]+$/.test(token) ? "token-selector" : "token-number";
      return "token-number";
    });
  }

  function highlightHtmlTag(tag) {
    const trimmedTag = tag.replace(/^</, "").replace(/>$/, "");
    const isClosing = trimmedTag.startsWith("/");
    const tagNameMatch = trimmedTag.match(/^\/?([^\s/>]+)/);
    const tagName = tagNameMatch ? tagNameMatch[1] : "";
    let result = "&lt;";

    if (isClosing) {
      result += "/";
    }

    if (tagName) {
      result += `<span class="token-tag">${escapeHtml(tagName)}</span>`;
    }

    const attrSource = trimmedTag.slice(tagNameMatch ? tagNameMatch[0].length : 0);
    const attrPattern = /(\s+)([\w:-]+)(?:\s*=\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s"'=<>`]+))?/g;
    let lastIndex = 0;
    let match = attrPattern.exec(attrSource);

    while (match !== null) {
      result += escapeHtml(attrSource.slice(lastIndex, match.index));
      result += escapeHtml(match[1]);
      result += `<span class="token-attr">${escapeHtml(match[2])}</span>`;
      if (match[3]) {
        result += '<span class="token-operator">=</span>';
        result += `<span class="token-string">${escapeHtml(match[3])}</span>`;
      }
      lastIndex = match.index + match[0].length;
      match = attrPattern.exec(attrSource);
    }

    result += escapeHtml(attrSource.slice(lastIndex));
    if (tag.endsWith("/>")) {
      result += "/";
    }
    result += "&gt;";
    return result;
  }

  function highlightHtml(text) {
    const pattern =
      /<!--[\s\S]*?-->|<\/?[\w:-]+(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g;
    let result = "";
    let lastIndex = 0;
    let match = pattern.exec(text);

    while (match !== null) {
      result += escapeHtml(text.slice(lastIndex, match.index));
      const token = match[0];
      if (token.startsWith("<!--")) {
        result += `<span class="token-comment">${escapeHtml(token)}</span>`;
      } else {
        result += highlightHtmlTag(token);
      }
      lastIndex = match.index + token.length;
      match = pattern.exec(text);
    }

    result += escapeHtml(text.slice(lastIndex));
    pattern.lastIndex = 0;
    return result;
  }

  function buildResponsePreview(entry, content) {
    const kind = detectResponseBodyKind(entry, content);
    const responseText = getResponseBodyText(entry, content);
    const mimeType = String(content.mimeType || "").toLowerCase();

    if (kind === "html" && responseText) {
      const previewHtml = responseText.slice(0, MAX_RESPONSE_PREVIEW_CHARS);
      return `
        <div class="response-preview-card response-preview-html">
          <iframe class="response-preview-frame" sandbox="" srcdoc="${escapeHtml(previewHtml)}"></iframe>
        </div>
      `;
    }

    if (
      (kind === "image" || kind === "audio" || kind === "video") &&
      content.encoding === "base64" &&
      content.text
    ) {
      const dataUrl = buildPreviewDataUrl(mimeType || "application/octet-stream", content.text);
      if (!dataUrl) return "";
      if (kind === "image") {
        return `
          <div class="response-preview-card response-preview-media">
            <img class="response-preview-image" src="${escapeHtml(dataUrl)}" alt="Response preview">
          </div>
        `;
      }
      if (kind === "audio") {
        return `
          <div class="response-preview-card response-preview-media">
            <audio class="response-preview-audio" controls preload="metadata" src="${escapeHtml(dataUrl)}"></audio>
          </div>
        `;
      }
      return `
        <div class="response-preview-card response-preview-media">
          <video class="response-preview-video" controls preload="metadata" src="${escapeHtml(dataUrl)}"></video>
        </div>
      `;
    }

    return "";
  }

  function buildResponseBodySection(entry, content) {
    const responseText = getResponseBodyText(entry, content);
    const isBinary = content.encoding === "base64" && !responseText;
    const jsonValidation = validateJsonBody(responseText);

    if (!content.text) {
      return "";
    }

    if (isBinary) {
      return `
        <div class="detail-section">
          <h4>Response Body</h4>
          <pre class="response-body binary">(binary data)</pre>
        </div>
      `;
    }

    const displayText = responseText;
    const truncatedText = displayText.slice(0, MAX_RESPONSE_DISPLAY_CHARS);
    const highlighted = escapeHtml(truncatedText);
    const showJsonPreview = isJsonPreviewReplacingRaw(entry, "response", jsonValidation);
    const truncatedSuffix =
      displayText.length > MAX_RESPONSE_DISPLAY_CHARS
        ? '\n<span class="token-comment">...(truncated)</span>'
        : "";

    return `
      <div class="detail-section">
        <div class="detail-section-heading">
          <h4>Response Body</h4>
          ${buildJsonPreviewToggle(entry, "response", jsonValidation)}
        </div>
        ${
          showJsonPreview
            ? ""
            : `<pre class="response-body response-code-block">${highlighted}${truncatedSuffix}</pre>`
        }
        ${buildJsonPreviewPanel(entry, "response", jsonValidation)}
      </div>
    `;
  }

  function getNetworkDetailTabKey(entry) {
    return entry.requestId || entry.url || String(entry.timestamp || "");
  }

  function getActiveNetworkDetailTab(entry, hasPreview, hasBody) {
    const key = getNetworkDetailTabKey(entry);
    const savedTab = networkDetailTabs.get(key);

    if (savedTab === "preview" && hasPreview) return "preview";
    if (savedTab === "body" && hasBody) return "body";
    if (hasPreview) return "preview";
    if (hasBody) return "body";
    return null;
  }

  function shouldHideNetworkVendorFrames(entry) {
    const key = getNetworkDetailTabKey(entry);
    return networkInitiatorVendorFilters.get(key) !== false;
  }

  function isNetworkVendorFrame(frame) {
    // A frame is highlighted (not gray) only when it resolves to an original
    // source file via source maps AND that source is not inside node_modules.
    // Unresolved frames (no source map) and resolved-but-vendor frames are gray.
    if (!frame || !frame.originalSource) return true;
    return frame.originalSource.includes("node_modules");
  }

  function buildResponseTabs(entry, previewHtml, responseBodyHtml) {
    const hasPreview = Boolean(previewHtml);
    const hasBody = Boolean(responseBodyHtml);
    const activeTab = getActiveNetworkDetailTab(entry, hasPreview, hasBody);

    if (hasPreview && !hasBody) {
      return previewHtml;
    }
    if (!hasPreview && hasBody) {
      return responseBodyHtml;
    }
    if (!activeTab) {
      return "";
    }

    return `
      <div class="detail-section">
        <div class="network-detail-tabs" role="tablist" aria-label="Response detail tabs">
          ${
            hasPreview
              ? `
            <button
              class="network-detail-tab ${activeTab === "preview" ? "active" : ""}"
              type="button"
              role="tab"
              aria-selected="${activeTab === "preview"}"
              data-tab="preview"
            >
              Response Preview
            </button>
          `
              : ""
          }
          ${
            hasBody
              ? `
            <button
              class="network-detail-tab ${activeTab === "body" ? "active" : ""}"
              type="button"
              role="tab"
              aria-selected="${activeTab === "body"}"
              data-tab="body"
            >
              Response Body
            </button>
          `
              : ""
          }
        </div>
        ${
          hasPreview
            ? `
          <div
            class="network-detail-panel ${activeTab === "preview" ? "active" : "hidden"}"
            role="tabpanel"
            data-panel="preview"
          >
            ${previewHtml}
          </div>
        `
            : ""
        }
        ${
          hasBody
            ? `
          <div
            class="network-detail-panel ${activeTab === "body" ? "active" : "hidden"}"
            role="tabpanel"
            data-panel="body"
          >
            ${responseBodyHtml}
          </div>
        `
            : ""
        }
      </div>
    `;
  }

  // Google Drive API functions
  // Check if external adapter is available (set by standalone mode)
  const DRIVE_ADAPTER = window.GN_DRIVE_ADAPTER || null;
  function getDriveApiMediaUrl(fileId) {
    const url = new URL(`${DRIVE_API_FILES_URL}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    return url.toString();
  }

  function getDownloadUrl(fileId) {
    if (IS_STANDALONE && DRIVE_ADAPTER) {
      return `/api/drive?id=${encodeURIComponent(fileId)}`;
    }

    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
  }

  async function getExtensionDriveToken() {
    if (
      !IS_EXTENSION ||
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return null;
    }

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "GET_GOOGLE_DRIVE_TOKEN" }, (response) => {
          if (
            chrome.runtime.lastError ||
            !response?.ok ||
            typeof response.token !== "string" ||
            !response.token
          ) {
            resolve(null);
            return;
          }
          resolve(response.token);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function fetchDriveFileWithOAuth(fileId) {
    const token = await getExtensionDriveToken();
    if (!token) {
      return null;
    }

    let response;
    try {
      response = await fetch(getDriveApiMediaUrl(fileId), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      return null;
    }

    if (response.ok) {
      return response;
    }

    // Auth and permission failures can still succeed through the public link
    // proxy when a replay package is link-readable, so let the caller fall back.
    if (response.status === 401 || response.status === 403) {
      return null;
    }

    throw new Error(
      `Failed to download Drive file ${fileId} via Google Drive API: HTTP ${response.status}`,
    );
  }

  async function mapWithConcurrency(items, concurrency, worker) {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }

    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => runWorker()),
    );
    return results;
  }

  async function fetchDriveFileWithCache(fileId, options = {}) {
    const oauthResponse = await fetchDriveFileWithOAuth(fileId);
    if (oauthResponse) {
      return oauthResponse;
    }

    const url = getDownloadUrl(fileId);
    if (options.cache === false || typeof caches === "undefined") {
      return fetch(url);
    }

    const cache = await caches.open(DRIVE_CACHE_NAME);
    const cached = await cache.match(url);
    const cachedAt = Number(cached?.headers.get("x-gn-cached-at")) || 0;
    const cachedType = String(cached?.headers.get("content-type") || "").toLowerCase();
    const cachedLooksLikeHtml = cachedType.includes("text/html");
    if (cachedLooksLikeHtml) {
      // Confirmation/error HTML pages are not valid recording artifacts; remove
      // stale bad entries so a fixed proxy can be retried immediately.
      await cache.delete(url);
    }
    const isFresh =
      cached && !cachedLooksLikeHtml && cachedAt > 0 && Date.now() - cachedAt < DRIVE_CACHE_TTL_MS;

    if (isFresh) {
      return cached.clone();
    }

    try {
      const networkResponse = await fetch(url);
      if (networkResponse.ok) {
        const contentLength = Number(networkResponse.headers.get("content-length")) || 0;
        const maxCacheBytes = Number.isFinite(options.maxCacheBytes)
          ? options.maxCacheBytes
          : DRIVE_CACHE_MAX_BYTES;

        if (contentLength > 0 && contentLength <= maxCacheBytes) {
          const blob = await networkResponse.clone().blob();
          const headers = new Headers(networkResponse.headers);
          headers.set("x-gn-cached-at", String(Date.now()));
          await cache.put(
            url,
            new Response(blob, {
              status: networkResponse.status,
              statusText: networkResponse.statusText,
              headers,
            }),
          );
        }
      }
      return networkResponse;
    } catch (error) {
      if (cached) {
        return cached.clone();
      }
      throw error;
    }
  }

  async function downloadFile(fileId, options = {}) {
    const response = await fetchDriveFileWithCache(fileId, {
      cache: options.cache,
      maxCacheBytes: options.maxCacheBytes,
    });

    if (!response.ok) {
      throw new Error(`Failed to download file ${fileId}`);
    }

    if (!options.onProgress || !response.body) {
      const blob = await response.blob();
      options.onProgress?.({ loaded: blob.size, total: blob.size });
      return new Response(blob, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    }

    const reader = response.body.getReader();
    const chunks = [];
    const total = Number(response.headers.get("content-length")) || 0;
    let loaded = 0;

    options.onProgress({ loaded, total });

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      chunks.push(value);
      loaded += value.byteLength;
      options.onProgress({ loaded, total });
    }

    const blob = new Blob(chunks, {
      type: response.headers.get("content-type") || "application/octet-stream",
    });
    options.onProgress?.({ loaded: blob.size, total: blob.size });

    return new Response(blob, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }

  async function downloadFileAsJson(fileId, options = {}) {
    const response = await downloadFile(fileId, options);
    return response.json();
  }

  async function downloadFileAsBlob(fileId, options = {}) {
    const response = await downloadFile(fileId, options);
    return response.blob();
  }

  async function hasZipSignature(blob) {
    if (!blob || blob.size < 4) {
      return false;
    }
    const bytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  async function isLikelyHtmlBlob(blob) {
    const type = String(blob?.type || "").toLowerCase();
    if (type.includes("text/html")) {
      return true;
    }
    const preview = await blob
      .slice(0, 128)
      .text()
      .catch(() => "");
    return preview.trimStart().startsWith("<");
  }

  async function parseJsonBlob(blob, label) {
    try {
      return JSON.parse(await blob.text());
    } catch (error) {
      throw new Error(`Invalid JSON in ${label || "recording artifact"}`);
    }
  }

  function base64ToBytes(value) {
    const binary = atob(value || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function deriveRecordingPasswordKey(password, encryption) {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Browser crypto is not available for password-protected recordings.");
    }
    if (
      encryption?.algorithm !== ZIP_ENCRYPTION_ALGORITHM ||
      encryption?.kdf !== ZIP_ENCRYPTION_KDF
    ) {
      throw new Error("Unsupported recording package encryption.");
    }

    const iterations = Number(encryption.iterations);
    if (!Number.isFinite(iterations) || iterations <= 0) {
      throw new Error("Invalid recording package encryption metadata.");
    }

    const keyMaterial = await globalThis.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );

    return globalThis.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: base64ToBytes(encryption.salt),
        iterations,
      },
      keyMaterial,
      { name: ZIP_ENCRYPTION_ALGORITHM, length: 256 },
      false,
      ["decrypt"],
    );
  }

  async function decryptRecordingPackage(encryptedPayload, encryption, password) {
    const key = await deriveRecordingPasswordKey(password, encryption);
    const iv = base64ToBytes(encryption.iv);
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: ZIP_ENCRYPTION_ALGORITHM, iv },
      key,
      await encryptedPayload.arrayBuffer(),
    );
    return new Blob([decrypted], { type: "application/zip" });
  }

  function makeCrc32Table() {
    const table = new Uint32Array(256);
    for (let i = 0; i < table.length; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    return table;
  }

  const CRC32_TABLE = makeCrc32Table();

  function updateCrc32Value(crc, byte) {
    return (CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
  }

  function calculateCrc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = updateCrc32Value(crc, byte);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function createZipCryptoKeys(password) {
    const keys = [0x12345678, 0x23456789, 0x34567890];
    for (const byte of new TextEncoder().encode(password)) {
      updateZipCryptoKeys(keys, byte);
    }
    return keys;
  }

  function updateZipCryptoKeys(keys, byte) {
    keys[0] = updateCrc32Value(keys[0], byte);
    keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    keys[2] = updateCrc32Value(keys[2], keys[1] >>> 24);
  }

  function getZipCryptoByte(keys) {
    const temp = (keys[2] | 2) >>> 0;
    return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
  }

  function decryptZipCryptoByte(keys, encryptedByte) {
    const plainByte = encryptedByte ^ getZipCryptoByte(keys);
    updateZipCryptoKeys(keys, plainByte);
    return plainByte;
  }

  function createZipPasswordError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function decryptZipCryptoPayload(encryptedBytes, password, crc32, name) {
    if (!password) {
      throw createZipPasswordError(
        "Recording package requires a password.",
        "ZIP_PASSWORD_REQUIRED",
      );
    }
    if (encryptedBytes.length < ZIP_CRYPTO_HEADER_BYTES) {
      throw new Error(`Recording package entry ${name} is missing its encryption header`);
    }

    const keys = createZipCryptoKeys(password);
    const header = new Uint8Array(ZIP_CRYPTO_HEADER_BYTES);
    for (let index = 0; index < ZIP_CRYPTO_HEADER_BYTES; index += 1) {
      header[index] = decryptZipCryptoByte(keys, encryptedBytes[index]);
    }

    if (header[ZIP_CRYPTO_HEADER_BYTES - 1] !== ((crc32 >>> 24) & 0xff)) {
      throw createZipPasswordError(
        "Wrong password or corrupted recording package.",
        "ZIP_PASSWORD_INVALID",
      );
    }

    const decrypted = new Uint8Array(encryptedBytes.length - ZIP_CRYPTO_HEADER_BYTES);
    for (let index = 0; index < decrypted.length; index += 1) {
      decrypted[index] = decryptZipCryptoByte(
        keys,
        encryptedBytes[ZIP_CRYPTO_HEADER_BYTES + index],
      );
    }

    return decrypted;
  }

  function isZipPasswordError(error) {
    return error?.code === "ZIP_PASSWORD_REQUIRED" || error?.code === "ZIP_PASSWORD_INVALID";
  }

  async function inflateRawBytes(bytes, name) {
    if (typeof DecompressionStream !== "function") {
      throw new Error(
        `Recording package entry ${name} uses DEFLATE compression, but this browser cannot decompress it.`,
      );
    }

    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      throw new Error(`Recording package entry ${name} could not be decompressed`);
    }
  }

  async function readZipEntryBytes(entryBytes, compressionMethod, uncompressedSize, name) {
    if (compressionMethod === 0) {
      if (entryBytes.length !== uncompressedSize) {
        throw new Error(`Invalid recording package size for ${name}`);
      }
      return entryBytes;
    }

    if (compressionMethod === 8) {
      const inflated = await inflateRawBytes(entryBytes, name);
      if (inflated.length !== uncompressedSize) {
        throw new Error(`Invalid decompressed recording package size for ${name}`);
      }
      return inflated;
    }

    throw new Error(`Unsupported recording package compression for ${name}`);
  }

  async function unzipStoredPackage(blob, options = {}) {
    // Recording packages may store already-compressed video entries directly,
    // while JSON/text artifacts use ZIP DEFLATE to reduce Drive payload size.
    // Password-protected packages keep using traditional ZIP encryption so
    // downloaded archives also prompt in common unzip tools.
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    const eocdSignature = 0x06054b50;
    const centralSignature = 0x02014b50;
    const localSignature = 0x04034b50;
    let eocdOffset = -1;

    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
      if (view.getUint32(offset, true) === eocdSignature) {
        eocdOffset = offset;
        break;
      }
    }

    if (eocdOffset < 0) {
      throw new Error("Invalid recording package. Zip directory was not found.");
    }

    const entryCount = view.getUint16(eocdOffset + 10, true);
    let centralOffset = view.getUint32(eocdOffset + 16, true);
    const entries = new Map();

    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(centralOffset, true) !== centralSignature) {
        throw new Error("Invalid recording package. Central directory is corrupt.");
      }

      const flags = view.getUint16(centralOffset + 8, true);
      const compressionMethod = view.getUint16(centralOffset + 10, true);
      const crc32 = view.getUint32(centralOffset + 16, true);
      const compressedSize = view.getUint32(centralOffset + 20, true);
      const uncompressedSize = view.getUint32(centralOffset + 24, true);
      const fileNameLength = view.getUint16(centralOffset + 28, true);
      const extraLength = view.getUint16(centralOffset + 30, true);
      const commentLength = view.getUint16(centralOffset + 32, true);
      const localHeaderOffset = view.getUint32(centralOffset + 42, true);
      const nameStart = centralOffset + 46;
      const name = decoder.decode(bytes.subarray(nameStart, nameStart + fileNameLength));

      const isEncrypted = (flags & ZIP_FLAG_ENCRYPTED) !== 0;
      if (!isEncrypted && compressionMethod === 0 && compressedSize !== uncompressedSize) {
        throw new Error(`Invalid recording package size for ${name}`);
      }
      if (view.getUint32(localHeaderOffset, true) !== localSignature) {
        throw new Error(`Invalid recording package entry ${name}`);
      }

      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) {
        throw new Error(`Recording package entry ${name} is truncated`);
      }

      if (name && !name.endsWith("/")) {
        const entryBytes = bytes.slice(dataStart, dataEnd);
        const packedBytes = isEncrypted
          ? decryptZipCryptoPayload(entryBytes, options.password || "", crc32, name)
          : entryBytes;
        const plainBytes = await readZipEntryBytes(
          packedBytes,
          compressionMethod,
          uncompressedSize,
          name,
        );
        if (calculateCrc32(plainBytes) !== crc32) {
          if (isEncrypted) {
            throw createZipPasswordError(
              "Wrong password or corrupted recording package.",
              "ZIP_PASSWORD_INVALID",
            );
          }
          throw new Error(`Recording package entry ${name} failed integrity validation`);
        }
        entries.set(name, new Blob([plainBytes]));
      }

      centralOffset += 46 + fileNameLength + extraLength + commentLength;
    }

    return entries;
  }

  function getPackageEntry(entries, name, required = true) {
    const entry = entries.get(name);
    if (!entry && required) {
      throw new Error(`Recording package is missing ${name}`);
    }
    return entry || null;
  }

  async function loadJsonDescriptor(file, label, options = {}) {
    if (file?.json) {
      return file.json;
    }
    if (file?.blob) {
      return parseJsonBlob(file.blob, label);
    }
    return downloadFileAsJson(file.id, options);
  }

  async function loadBlobDescriptor(file, options = {}) {
    if (file?.blob) {
      options.onProgress?.({ loaded: file.blob.size, total: file.blob.size });
      return file.blob;
    }
    return downloadFileAsBlob(file.id, options);
  }

  function buildDirectRecordingFiles(urlParams) {
    const parseFileId = (value) => {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      return trimmed ? { id: trimmed } : null;
    };

    const videoParts = (urlParams.get("videos") || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((id) => ({ id }));

    const resolved = {
      indexId: null,
      folderId: null,
      manifest: null,
      metadata: parseFileId(urlParams.get("metadata")),
      report: null,
      events: null,
      privacy: null,
      diagnostics: null,
      screenshot: null,
      console: parseFileId(urlParams.get("console")),
      network: parseFileId(urlParams.get("network")),
      websocket: parseFileId(urlParams.get("websocket")),
      videoParts,
    };

    if (!resolved.metadata || resolved.videoParts.length === 0) {
      throw new Error(
        "Invalid or missing recording parameters. Please provide videos and metadata file IDs.",
      );
    }

    return resolved;
  }

  function resolveReplayRecordingId() {
    const searchId = new URLSearchParams(window.location.search).get("id");
    if (searchId) {
      return searchId.trim();
    }

    const segments = window.location.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const lastSegment = segments[segments.length - 1] || "";

    if (!lastSegment || lastSegment.includes(".")) {
      return null;
    }

    try {
      return decodeURIComponent(lastSegment);
    } catch {
      return lastSegment;
    }
  }

  function isEncryptedPackageIndex(indexJson) {
    return Boolean(indexJson?.encryption || indexJson?.package?.encrypted);
  }

  async function buildRecordingFilesFromPackageEntries(entries, indexJson, indexId) {
    const manifestJson = await parseJsonBlob(
      getPackageEntry(entries, indexJson.manifestPath || "manifest.json"),
      "manifest.json",
    );
    const metadataPath =
      indexJson.metadataPath || manifestJson?.artifacts?.metadata || "metadata.json";
    const videoPartPaths =
      Array.isArray(indexJson?.video?.partPaths) && indexJson.video.partPaths.length
        ? indexJson.video.partPaths
        : Array.isArray(manifestJson?.video?.parts)
          ? manifestJson.video.parts.map((part) => part.name).filter(Boolean)
          : [];
    const consoleEntry = manifestJson?.artifacts?.console
      ? getPackageEntry(entries, manifestJson.artifacts.console, false)
      : null;
    const networkEntry = manifestJson?.artifacts?.network
      ? getPackageEntry(entries, manifestJson.artifacts.network, false)
      : null;
    const websocketEntry = manifestJson?.artifacts?.websocket
      ? getPackageEntry(entries, manifestJson.artifacts.websocket, false)
      : null;
    const reportPath = indexJson?.artifacts?.reportPath || manifestJson?.artifacts?.report;
    const eventsPath = indexJson?.artifacts?.eventsPath || manifestJson?.artifacts?.events;
    const drawingPath = indexJson?.artifacts?.drawingPath || manifestJson?.artifacts?.drawing;
    const privacyPath = indexJson?.artifacts?.privacyPath || manifestJson?.artifacts?.privacy;
    const diagnosticsPath =
      indexJson?.artifacts?.diagnosticsPath || manifestJson?.artifacts?.diagnostics;
    const screenshotPath =
      indexJson?.artifacts?.screenshotPath || manifestJson?.artifacts?.screenshot;
    const storagePath = indexJson?.artifacts?.storagePath || manifestJson?.artifacts?.storage;
    const domPath = indexJson?.artifacts?.domPath || manifestJson?.artifacts?.dom;
    const reportEntry = reportPath ? getPackageEntry(entries, reportPath, false) : null;
    const eventsEntry = eventsPath ? getPackageEntry(entries, eventsPath, false) : null;
    const drawingEntry = drawingPath ? getPackageEntry(entries, drawingPath, false) : null;
    const privacyEntry = privacyPath ? getPackageEntry(entries, privacyPath, false) : null;
    const diagnosticsEntry = diagnosticsPath
      ? getPackageEntry(entries, diagnosticsPath, false)
      : null;
    const screenshotEntry = screenshotPath ? getPackageEntry(entries, screenshotPath, false) : null;
    const storageEntry = storagePath ? getPackageEntry(entries, storagePath, false) : null;
    const domEntry = domPath ? getPackageEntry(entries, domPath, false) : null;

    const resolved = {
      packageId: indexId,
      indexId: null,
      folderId: typeof indexJson?.folderId === "string" ? indexJson.folderId : null,
      manifest: { json: manifestJson, video: manifestJson.video },
      metadata: { blob: getPackageEntry(entries, metadataPath) },
      report: reportEntry ? { blob: reportEntry } : null,
      events: eventsEntry ? { blob: eventsEntry } : null,
      drawing: drawingEntry ? { blob: drawingEntry } : null,
      privacy: privacyEntry ? { blob: privacyEntry } : null,
      diagnostics: diagnosticsEntry ? { blob: diagnosticsEntry } : null,
      screenshot: screenshotEntry ? { name: screenshotPath, blob: screenshotEntry } : null,
      console: consoleEntry ? { blob: consoleEntry } : null,
      network: networkEntry ? { blob: networkEntry } : null,
      websocket: websocketEntry ? { blob: websocketEntry } : null,
      storage: storageEntry ? { blob: storageEntry } : null,
      dom: domEntry ? { blob: domEntry } : null,
      videoParts: videoPartPaths.map((path) => ({
        name: path,
        blob: getPackageEntry(entries, path),
      })),
    };

    if (!resolved.metadata || resolved.videoParts.length === 0) {
      throw new Error("Invalid recording package. Missing metadata or video parts.");
    }

    return resolved;
  }

  async function unlockEncryptedRecordingPackage(entries, indexJson, indexId) {
    const encryption = indexJson?.encryption || {};
    if (
      encryption.algorithm !== ZIP_ENCRYPTION_ALGORITHM ||
      encryption.kdf !== ZIP_ENCRYPTION_KDF
    ) {
      throw new Error("Unsupported recording package encryption.");
    }
    const payloadPath =
      typeof encryption.payloadPath === "string"
        ? encryption.payloadPath
        : ZIP_ENCRYPTION_PAYLOAD_PATH;
    const encryptedPayload = getPackageEntry(entries, payloadPath);
    let promptError = "";

    while (true) {
      const password = await requestRecordingPassword(promptError);
      try {
        setPasswordPromptBusy(true);
        const innerZipBlob = await decryptRecordingPackage(encryptedPayload, encryption, password);
        setPasswordPromptBusy(false);
        if (elements.passwordInput) {
          elements.passwordInput.value = "";
        }
        showLoading();
        resetLoadingProgress("Loading unlocked recording...");
        const innerEntries = await unzipStoredPackage(innerZipBlob);
        const innerIndexJson = await parseJsonBlob(
          getPackageEntry(innerEntries, "recording-index.json"),
          "recording-index.json",
        );
        return buildRecordingFilesFromPackageEntries(innerEntries, innerIndexJson, indexId);
      } catch (error) {
        console.warn("[GN Tracing Player] Failed to unlock recording package:", error);
        promptError = "Wrong password or corrupted recording package. Please try again.";
        setPasswordPromptBusy(false);
      }
    }
  }

  async function unlockPasswordProtectedZipPackage(packageBlob, indexId) {
    let promptError = "";

    while (true) {
      const password = await requestRecordingPassword(promptError);
      try {
        setPasswordPromptBusy(true);
        const entries = await unzipStoredPackage(packageBlob, { password });
        setPasswordPromptBusy(false);
        if (elements.passwordInput) {
          elements.passwordInput.value = "";
        }
        showLoading();
        resetLoadingProgress("Loading unlocked recording...");
        const indexJson = await parseJsonBlob(
          getPackageEntry(entries, "recording-index.json"),
          "recording-index.json",
        );
        return buildRecordingFilesFromPackageEntries(entries, indexJson, indexId);
      } catch (error) {
        console.warn("[GN Tracing Player] Failed to unlock ZIP recording package:", error);
        promptError = isZipPasswordError(error)
          ? "Wrong password or corrupted recording package. Please try again."
          : error?.message || "Failed to unlock recording package.";
        setPasswordPromptBusy(false);
      }
    }
  }

  async function loadRecordingFilesFromIndex(indexId) {
    registerLoadingEntry("package", "recording.zip", "other");
    const packageBlob = await downloadFileAsBlob(indexId, {
      cache: false,
      onProgress: createLoadingProgressReporter("package", "other", "recording.zip"),
    });
    markLoadingEntryLoaded("package", "recording.zip", "other");

    if (await hasZipSignature(packageBlob)) {
      let entries;
      try {
        entries = await unzipStoredPackage(packageBlob);
      } catch (error) {
        if (isZipPasswordError(error)) {
          return unlockPasswordProtectedZipPackage(packageBlob, indexId);
        }
        throw error;
      }
      const indexJson = await parseJsonBlob(
        getPackageEntry(entries, "recording-index.json"),
        "recording-index.json",
      );
      if (isEncryptedPackageIndex(indexJson)) {
        return unlockEncryptedRecordingPackage(entries, indexJson, indexId);
      }

      return buildRecordingFilesFromPackageEntries(entries, indexJson, indexId);
    }

    if (await isLikelyHtmlBlob(packageBlob)) {
      throw new Error(
        "Drive returned an HTML download page instead of a recording package. Please retry after the player proxy refreshes the Drive download confirmation.",
      );
    }

    const indexJson = await parseJsonBlob(packageBlob, "recording-index.json");

    const videoPartFileIds = Array.isArray(indexJson?.video?.partFileIds)
      ? indexJson.video.partFileIds.filter(Boolean)
      : [];
    const resolved = {
      packageId: null,
      indexId,
      folderId: typeof indexJson?.folderId === "string" ? indexJson.folderId : null,
      manifest: indexJson?.manifestFileId ? { id: indexJson.manifestFileId } : null,
      metadata: indexJson?.metadataFileId ? { id: indexJson.metadataFileId } : null,
      report: indexJson?.artifacts?.reportFileId ? { id: indexJson.artifacts.reportFileId } : null,
      events: indexJson?.artifacts?.eventsFileId ? { id: indexJson.artifacts.eventsFileId } : null,
      drawing: indexJson?.artifacts?.drawingFileId
        ? { id: indexJson.artifacts.drawingFileId }
        : null,
      privacy: indexJson?.artifacts?.privacyFileId
        ? { id: indexJson.artifacts.privacyFileId }
        : null,
      diagnostics: indexJson?.artifacts?.diagnosticsFileId
        ? { id: indexJson.artifacts.diagnosticsFileId }
        : null,
      screenshot: indexJson?.artifacts?.screenshotFileId
        ? { id: indexJson.artifacts.screenshotFileId }
        : null,
      console: indexJson?.artifacts?.consoleFileId
        ? { id: indexJson.artifacts.consoleFileId }
        : null,
      network: indexJson?.artifacts?.networkFileId
        ? { id: indexJson.artifacts.networkFileId }
        : null,
      websocket: indexJson?.artifacts?.websocketFileId
        ? { id: indexJson.artifacts.websocketFileId }
        : null,
      videoParts: videoPartFileIds.map((id) => ({ id })),
    };

    if (!resolved.metadata || resolved.videoParts.length === 0) {
      throw new Error("Invalid recording index. Missing metadata or video parts.");
    }

    return resolved;
  }

  async function downloadCombinedBlob(files, mimeType) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("No video parts found");
    }

    files.forEach((file, index) => {
      registerLoadingEntry(
        `video:${index}`,
        file.name || `video.part-${String(index).padStart(3, "0")}.webm`,
        "video",
      );
    });
    const blobs = await mapWithConcurrency(files, VIDEO_DOWNLOAD_CONCURRENCY, (file, index) =>
      loadBlobDescriptor(file, {
        cache: false,
        onProgress: createLoadingProgressReporter(
          `video:${index}`,
          "video",
          file.name || `video.part-${String(index).padStart(3, "0")}.webm`,
        ),
      }).then((blob) => {
        updateLoadingEntry(`video:${index}`, {
          loaded: blob.size,
          total: blob.size,
          group: "video",
          label: file.name || `video.part-${String(index).padStart(3, "0")}.webm`,
          status: "Loaded",
        });
        return blob;
      }),
    );

    const combinedType = mimeType || blobs[0]?.type || "video/webm";
    return new Blob(blobs, { type: combinedType });
  }

  async function loadRecordingFromFiles() {
    try {
      await loadRecordingData();
    } catch (err) {
      markPendingLoadingEntriesFailed();
      console.error("Failed to load recording:", err);
      elements.errorMessage.textContent = err.message || "Failed to load recording";
      showError();
    }
  }

  async function loadRecordingData() {
    try {
      resetLoadingProgress("Loading recording...");
      report = null;
      privacySummary = null;
      sourceMapDiagnostics = [];
      userEvents = [];
      drawingStrokes = [];
      drawingClears = [];
      releaseScreenshotResources();
      if (recordingFiles.packageId) {
        registerLoadingEntry("package", "recording.zip", "other", "Loaded");
      } else if (recordingFiles.indexId) {
        registerLoadingEntry("index", "recording-index.json", "other", "Loaded");
      }
      registerLoadingEntry("metadata", "metadata.json", "other");
      if (recordingFiles.report) {
        registerLoadingEntry("report", "report.json", "other");
      }
      if (recordingFiles.events) {
        registerLoadingEntry("events", "events.json", "other");
      }
      if (recordingFiles.drawing) {
        registerLoadingEntry("drawing", "drawing.json", "other");
      }
      if (recordingFiles.privacy) {
        registerLoadingEntry("privacy", "privacy.json", "other");
      }
      if (recordingFiles.diagnostics) {
        registerLoadingEntry("diagnostics", "diagnostics.json", "other");
      }
      if (recordingFiles.screenshot) {
        registerLoadingEntry(
          "screenshot",
          recordingFiles.screenshot.name || "screenshot.jpg",
          "other",
        );
      }
      if (recordingFiles.console) {
        registerLoadingEntry("console", "console.json", "other");
      }
      if (recordingFiles.network) {
        registerLoadingEntry("network", "network.json", "other");
      }
      if (recordingFiles.websocket) {
        registerLoadingEntry("websocket", "websocket.json", "other");
      }
      if (recordingFiles.storage) {
        registerLoadingEntry("storage", "storage.json", "other");
      }
      if (recordingFiles.dom) {
        registerLoadingEntry("dom", "dom.json", "other");
      }

      // Load metadata first (needed for processing other data)
      const metadataJson = await loadJsonDescriptor(recordingFiles.metadata, "metadata.json", {
        onProgress: createLoadingProgressReporter("metadata", "other", "metadata.json"),
      });
      markLoadingEntryLoaded("metadata", "metadata.json", "other");
      metadata = metadataJson.metadata || metadataJson;
      startTime = metadata.startTime || new Date(metadata.timestamp || "").getTime();
      duration = getFiniteDurationMs(metadata.duration);
      setExpectedVideoBytes(metadata.video?.totalBytes || 0);
      const videoMimeType =
        recordingFiles.manifest?.video?.mimeType || metadata.video?.mimeType || "video/webm";

      // Load video, report metadata, timeline events, console, network, and websocket in parallel.
      await Promise.all([
        // Load video
        recordingFiles.videoParts.length
          ? downloadCombinedBlob(recordingFiles.videoParts, videoMimeType).then((blob) => {
              releaseVideoResources();
              videoBlob = blob;
              videoUrl = URL.createObjectURL(blob);
              elements.video.src = videoUrl;
            })
          : Promise.resolve(),

        recordingFiles.report
          ? loadJsonDescriptor(recordingFiles.report, "report.json", {
              onProgress: createLoadingProgressReporter("report", "other", "report.json"),
            })
              .then((reportJson) => {
                markLoadingEntryLoaded("report", "report.json", "other");
                report = reportJson && typeof reportJson === "object" ? reportJson : null;
              })
              .catch((error) => {
                updateLoadingEntry("report", { status: "Failed" });
                console.warn("[GN Tracing Player] Failed to load optional report artifact:", error);
              })
          : Promise.resolve(),

        recordingFiles.events
          ? loadJsonDescriptor(recordingFiles.events, "events.json", {
              onProgress: createLoadingProgressReporter("events", "other", "events.json"),
            })
              .then((eventsJson) => {
                markLoadingEntryLoaded("events", "events.json", "other");
                const rawEvents = Array.isArray(eventsJson)
                  ? eventsJson
                  : Array.isArray(eventsJson?.events)
                    ? eventsJson.events
                    : [];
                userEvents = rawEvents
                  .map((event) => ({
                    ...event,
                    relativeMs: (event.timestamp || 0) - startTime,
                  }))
                  .filter((event) => Number.isFinite(event.relativeMs))
                  .sort((a, b) => a.relativeMs - b.relativeMs);
                effectEvents = userEvents.filter(
                  (event) =>
                    (event.type === "click" ||
                      event.type === "contextmenu" ||
                      event.type === "scroll") &&
                    Number.isFinite(event.x) &&
                    Number.isFinite(event.y),
                );
              })
              .catch((error) => {
                updateLoadingEntry("events", { status: "Failed" });
                console.warn("[GN Tracing Player] Failed to load optional event artifact:", error);
              })
          : Promise.resolve(),

        recordingFiles.drawing
          ? loadJsonDescriptor(recordingFiles.drawing, "drawing.json", {
              onProgress: createLoadingProgressReporter("drawing", "other", "drawing.json"),
            })
              .then((drawingJson) => {
                markLoadingEntryLoaded("drawing", "drawing.json", "other");
                const rawStrokes = Array.isArray(drawingJson)
                  ? drawingJson
                  : Array.isArray(drawingJson?.strokes)
                    ? drawingJson.strokes
                    : [];
                const rawClears =
                  !Array.isArray(drawingJson) && Array.isArray(drawingJson?.clears)
                    ? drawingJson.clears
                    : [];
                drawingStrokes = rawStrokes
                  .map((stroke) => ({
                    ...stroke,
                    relativeMs: (stroke.timestamp || 0) - startTime,
                  }))
                  .filter(
                    (stroke) =>
                      Number.isFinite(stroke.relativeMs) &&
                      Array.isArray(stroke.points) &&
                      stroke.points.length > 0,
                  )
                  .sort((a, b) => a.relativeMs - b.relativeMs);
                drawingClears = rawClears
                  .map((ts) => (typeof ts === "number" ? ts - startTime : NaN))
                  .filter((ms) => Number.isFinite(ms))
                  .sort((a, b) => a - b);
              })
              .catch((error) => {
                updateLoadingEntry("drawing", { status: "Failed" });
                console.warn(
                  "[GN Tracing Player] Failed to load optional drawing artifact:",
                  error,
                );
              })
          : Promise.resolve(),

        recordingFiles.privacy
          ? loadJsonDescriptor(recordingFiles.privacy, "privacy.json", {
              onProgress: createLoadingProgressReporter("privacy", "other", "privacy.json"),
            })
              .then((privacyJson) => {
                markLoadingEntryLoaded("privacy", "privacy.json", "other");
                privacySummary =
                  privacyJson && typeof privacyJson === "object" ? privacyJson : null;
              })
              .catch((error) => {
                updateLoadingEntry("privacy", { status: "Failed" });
                console.warn(
                  "[GN Tracing Player] Failed to load optional privacy artifact:",
                  error,
                );
              })
          : Promise.resolve(),

        recordingFiles.diagnostics
          ? loadJsonDescriptor(recordingFiles.diagnostics, "diagnostics.json", {
              onProgress: createLoadingProgressReporter("diagnostics", "other", "diagnostics.json"),
            })
              .then((diagnosticsJson) => {
                markLoadingEntryLoaded("diagnostics", "diagnostics.json", "other");
                sourceMapDiagnostics = Array.isArray(diagnosticsJson?.sourceMaps)
                  ? diagnosticsJson.sourceMaps
                  : [];
              })
              .catch((error) => {
                updateLoadingEntry("diagnostics", { status: "Failed" });
                console.warn(
                  "[GN Tracing Player] Failed to load optional diagnostics artifact:",
                  error,
                );
              })
          : Promise.resolve(),

        recordingFiles.screenshot
          ? loadBlobDescriptor(recordingFiles.screenshot, {
              onProgress: createLoadingProgressReporter(
                "screenshot",
                "other",
                recordingFiles.screenshot.name || "screenshot.jpg",
              ),
            })
              .then((blob) => {
                markLoadingEntryLoaded(
                  "screenshot",
                  recordingFiles.screenshot.name || "screenshot.jpg",
                  "other",
                );
                releaseScreenshotResources();
                screenshotUrl = URL.createObjectURL(blob);
              })
              .catch((error) => {
                updateLoadingEntry("screenshot", { status: "Failed" });
                console.warn(
                  "[GN Tracing Player] Failed to load optional screenshot artifact:",
                  error,
                );
              })
          : Promise.resolve(),

        // Load console logs
        recordingFiles.console
          ? loadJsonDescriptor(recordingFiles.console, "console.json", {
              onProgress: createLoadingProgressReporter("console", "other", "console.json"),
            }).then((consoleJson) => {
              markLoadingEntryLoaded("console", "console.json", "other");
              const rawEntries = Array.isArray(consoleJson)
                ? consoleJson
                : consoleJson.logs || consoleJson.data || [];
              consoleLogs = rawEntries
                .map((entry) => ({
                  ...entry,
                  relativeMs: (entry.timestamp || 0) - startTime,
                }))
                .sort((a, b) => a.relativeMs - b.relativeMs);
            })
          : Promise.resolve(),

        // Load network logs
        recordingFiles.network
          ? loadJsonDescriptor(recordingFiles.network, "network.json", {
              onProgress: createLoadingProgressReporter("network", "other", "network.json"),
            }).then((networkJson) => {
              markLoadingEntryLoaded("network", "network.json", "other");
              const rawEntries = Array.isArray(networkJson)
                ? networkJson
                : networkJson.log?.entries || networkJson.entries || networkJson.data || [];

              networkLogs = rawEntries
                .map((entry) => {
                  if (entry.method && entry.url && entry.requestId) {
                    return {
                      ...entry,
                      relativeMs:
                        (entry.wallTime ? entry.wallTime * 1000 : entry.timestamp * 1000) -
                        startTime,
                    };
                  }
                  const request = entry.request || {};
                  const response = entry.response || {};
                  const content = response.content || {};
                  const timings = entry.timings || {};

                  const reqHeadersArray = request.headers || [];
                  const resHeadersArray = response.headers || [];
                  const reqHeaders = Array.isArray(reqHeadersArray)
                    ? Object.fromEntries(reqHeadersArray.map((h) => [h.name, h.value]))
                    : reqHeadersArray;
                  const resHeaders = Array.isArray(resHeadersArray)
                    ? Object.fromEntries(resHeadersArray.map((h) => [h.name, h.value]))
                    : resHeadersArray;

                  const timing = {
                    dnsStart: 0,
                    dnsEnd: timings.dns || 0,
                    connectStart: 0,
                    connectEnd: timings.connect || 0,
                    sslStart: 0,
                    sslEnd: timings.ssl || 0,
                    sendStart: 0,
                    sendEnd: timings.send || 0,
                    receiveHeadersEnd: timings.wait || 0,
                  };

                  return {
                    requestId: entry._requestId || "",
                    method: request.method || "GET",
                    url: request.url || "",
                    requestHeaders: reqHeaders || null,
                    postData: request.postData?.text || null,
                    timestamp: entry.wallTime ? entry.wallTime * 1000 : entry.timestamp || 0,
                    wallTime: entry.wallTime || null,
                    initiator: entry.initiator || null,
                    resourceType: entry.resourceType || "",
                    status: response.status || 0,
                    statusText: response.statusText || null,
                    responseHeaders: resHeaders || null,
                    mimeType: content.mimeType || null,
                    timing,
                    protocol: null,
                    remoteIPAddress: entry.serverIPAddress || null,
                    encodedDataLength: content.size || 0,
                    error: entry.error || null,
                    responseBody: content.text
                      ? { body: content.text, base64Encoded: !!content.encoding }
                      : null,
                    redirectChain: entry.redirectChain || null,
                    relativeMs:
                      (entry.wallTime ? entry.wallTime * 1000 : entry.timestamp || 0) - startTime,
                  };
                })
                .sort((a, b) => a.relativeMs - b.relativeMs);
            })
          : Promise.resolve(),

        // Load WebSocket logs
        recordingFiles.websocket
          ? loadJsonDescriptor(recordingFiles.websocket, "websocket.json", {
              onProgress: createLoadingProgressReporter("websocket", "other", "websocket.json"),
            }).then((wsJson) => {
              markLoadingEntryLoaded("websocket", "websocket.json", "other");
              webSocketLogs = Array.isArray(wsJson) ? wsJson : wsJson.data || wsJson.logs || [];
            })
          : Promise.resolve(),

        // Load storage snapshots
        recordingFiles.storage
          ? loadJsonDescriptor(recordingFiles.storage, "storage.json", {
              onProgress: createLoadingProgressReporter("storage", "other", "storage.json"),
            }).then((storageJson) => {
              markLoadingEntryLoaded("storage", "storage.json", "other");
              storageArtifact = storageJson;
            })
          : Promise.resolve(),

        // Load DOM snapshots
        recordingFiles.dom
          ? loadJsonDescriptor(recordingFiles.dom, "dom.json", {
              onProgress: createLoadingProgressReporter("dom", "other", "dom.json"),
            }).then((domJson) => {
              markLoadingEntryLoaded("dom", "dom.json", "other");
              domArtifact = domJson;
            })
          : Promise.resolve(),
      ]);

      // Update UI
      updatePlayerTitle(metadata);
      renderReportPanel();
      syncDurationState(getVideoDurationMs());
      setLoadingMessage("Loading recording...");

      showPlayer();
    } catch (err) {
      markPendingLoadingEntriesFailed();
      console.error("Failed to load recording:", err);
      elements.errorMessage.textContent = err.message || "Failed to load recording";
      showError();
    }
  }

  // State management
  function showLoading() {
    resetLoadingProgress("Loading recording...");
    elements.loadingState.classList.remove("hidden");
    elements.passwordState.classList.add("hidden");
    elements.introState.classList.add("hidden");
    elements.errorState.classList.add("hidden");
    elements.playerState.classList.add("hidden");
  }

  function showPasswordPrompt() {
    elements.loadingState.classList.add("hidden");
    elements.passwordState.classList.remove("hidden");
    elements.introState.classList.add("hidden");
    elements.errorState.classList.add("hidden");
    elements.playerState.classList.add("hidden");
  }

  function showIntro() {
    resetLoadingProgress();
    updatePlayerTitle();
    elements.loadingState.classList.add("hidden");
    elements.passwordState.classList.add("hidden");
    elements.introState.classList.remove("hidden");
    elements.errorState.classList.add("hidden");
    elements.playerState.classList.add("hidden");
  }

  function showError() {
    elements.loadingState.classList.add("hidden");
    elements.passwordState.classList.add("hidden");
    elements.introState.classList.add("hidden");
    elements.errorState.classList.remove("hidden");
    elements.playerState.classList.add("hidden");
  }

  function showPlayer() {
    elements.loadingState.classList.add("hidden");
    elements.passwordState.classList.add("hidden");
    elements.introState.classList.add("hidden");
    elements.errorState.classList.add("hidden");
    elements.playerState.classList.remove("hidden");

    renderReportPanel();
    renderConsoleEntries();
    renderNetworkEntries();
    renderStorageTab();
    renderElementsTab();
    renderMarkers();
  }

  function isScrolledNearBottom(container) {
    if (!container) return false;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom <= STICKY_SCROLL_THRESHOLD_PX;
  }

  function scrollToBottom(container) {
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function getConsoleEntryHtml(pe, closestIdx) {
    const { entry, index, level } = pe;
    const isActive = index === closestIdx;
    const isExpanded = expandedConsoleIndex === index;
    const timeStr = formatTimeMs(entry.relativeMs);
    const levelLabel = getConsoleLevelLabel(entry);

    let rowClass = "console-entry";
    if (entry.source === "exception") rowClass += " error-entry";
    if (entry.source === "browser") rowClass += " browser-entry";
    if (isActive) rowClass += " active-entry";
    if (isExpanded) rowClass += " expanded";

    const sourceLocation = getConsoleSourceLocation(entry);
    const sourceLocationHtml = sourceLocation
      ? `<span class="console-source-location">${escapeHtml(sourceLocation)}</span>`
      : "";

    return `
      <div class="${rowClass}" data-index="${index}">
        <button class="toggle-expand" aria-label="Toggle details"><i class="ph ${isExpanded ? "ph-caret-down" : "ph-caret-right"}"></i></button>
        <span class="console-time">${timeStr}</span>
        <span class="console-level console-level-${level}">${levelLabel}</span>
        <span class="console-message">
          <span>${renderArgs(entry)}</span>
          ${sourceLocationHtml}
        </span>
        ${isExpanded ? renderConsoleDetail(entry) : ""}
      </div>
    `;
  }

  function syncConsoleEntryState(row, pe, closestIdx) {
    const index = pe.index;
    const isExpanded = expandedConsoleIndex === index;
    row.classList.toggle("active-entry", index === closestIdx);
    row.classList.toggle("expanded", isExpanded);

    const icon = row.querySelector(".toggle-expand i");
    if (icon) {
      icon.classList.toggle("ph-caret-down", isExpanded);
      icon.classList.toggle("ph-caret-right", !isExpanded);
    }

    const detail = row.querySelector(":scope > .console-detail");
    if (isExpanded && !detail) {
      row.insertAdjacentHTML("beforeend", renderConsoleDetail(pe.entry));
    } else if (!isExpanded && detail) {
      detail.remove();
    }
  }

  function getNetworkEntryHtml(pe, closestIdx) {
    const { entry, index } = pe;
    const request = entry.request || {};
    const response = entry.response || {};
    const content = getNetworkResponseContent(entry);
    const isActive = index === closestIdx;
    const isExpanded = expandedNetworkIndex === index;
    const statusCode = response.status || entry.status || 0;
    const statusClass = getStatusColorClass(statusCode);
    const requestUrl = request.url || entry.url || "";
    const initiatorSummary = getNetworkInitiatorSummary(entry.initiator);
    const urlTitle = [requestUrl, initiatorSummary].filter(Boolean).join("\n");

    let rowClass = "network-row";
    if (isActive) rowClass += " active-row";
    if (isExpanded) rowClass += " expanded";

    return `
      <div class="${rowClass}" data-index="${index}">
        <button class="toggle-expand" aria-label="Toggle details"><i class="ph ${isExpanded ? "ph-caret-down" : "ph-caret-right"}"></i></button>
        <span class="col-method">${request.method || entry.method || "GET"}</span>
        <span class="col-url" title="${escapeHtml(urlTitle)}">
          <span class="network-url-main">${escapeHtml(truncateUrl(requestUrl))}</span>
          ${initiatorSummary ? `<span class="network-initiator-location">${escapeHtml(initiatorSummary)}</span>` : ""}
        </span>
        <span class="col-status ${statusClass}">${statusCode || (entry.error ? "ERR" : "-")}</span>
        <span class="col-type">${entry.resourceType || content.mimeType || "-"}</span>
        <span class="col-size">${formatSize(content.size || entry.encodedDataLength)}</span>
        ${isExpanded ? renderNetworkDetail(entry) : ""}
      </div>
    `;
  }

  function syncNetworkEntryState(row, pe, closestIdx) {
    const index = pe.index;
    const isExpanded = expandedNetworkIndex === index;
    const activeDetailTab = networkDetailTabs.get(getNetworkDetailTabKey(pe.entry)) || "";
    const hideVendorFrames = shouldHideNetworkVendorFrames(pe.entry) ? "1" : "0";
    const jsonPreviewSignature = getNetworkJsonPreviewSignature(pe.entry);
    row.classList.toggle("active-row", index === closestIdx);
    row.classList.toggle("expanded", isExpanded);

    const icon = row.querySelector(".toggle-expand i");
    if (icon) {
      icon.classList.toggle("ph-caret-down", isExpanded);
      icon.classList.toggle("ph-caret-right", !isExpanded);
    }

    const detail = row.querySelector(":scope > .network-detail");
    if (isExpanded && !detail) {
      row.insertAdjacentHTML("beforeend", renderNetworkDetail(pe.entry));
      row.dataset.detailTab = activeDetailTab;
      row.dataset.hideVendorFrames = hideVendorFrames;
      row.dataset.jsonPreviewSignature = jsonPreviewSignature;
    } else if (
      isExpanded &&
      detail &&
      (row.dataset.detailTab !== activeDetailTab ||
        row.dataset.hideVendorFrames !== hideVendorFrames ||
        row.dataset.jsonPreviewSignature !== jsonPreviewSignature)
    ) {
      detail.outerHTML = renderNetworkDetail(pe.entry);
      row.dataset.detailTab = activeDetailTab;
      row.dataset.hideVendorFrames = hideVendorFrames;
      row.dataset.jsonPreviewSignature = jsonPreviewSignature;
    } else if (!isExpanded && detail) {
      detail.remove();
      delete row.dataset.detailTab;
      delete row.dataset.hideVendorFrames;
      delete row.dataset.jsonPreviewSignature;
    }
  }

  function getWebSocketEntryHtml(item) {
    const { ws, index } = item;
    const isExpanded = expandedWsIndex === index;

    return `
      <div class="ws-row ${isExpanded ? "expanded" : ""}" data-index="${index}">
        <button class="toggle-expand" aria-label="Toggle details"><i class="ph ${isExpanded ? "ph-caret-down" : "ph-caret-right"}"></i></button>
        <span class="ws-url" title="${escapeHtml(ws.url || "")}">${escapeHtml(ws.url || "")}</span>
        <span class="ws-frames">${(ws.frames || []).length} frames</span>
        <span class="ws-status ${ws.closed ? "closed" : "open"}">${ws.closed ? "Closed" : "Open"}</span>
        ${isExpanded ? renderWsDetail(ws) : ""}
      </div>
    `;
  }

  function syncWebSocketEntryState(row, item) {
    const isExpanded = expandedWsIndex === item.index;
    row.classList.toggle("expanded", isExpanded);

    const icon = row.querySelector(".toggle-expand i");
    if (icon) {
      icon.classList.toggle("ph-caret-down", isExpanded);
      icon.classList.toggle("ph-caret-right", !isExpanded);
    }

    const detail = row.querySelector(":scope > .ws-detail");
    if (isExpanded && !detail) {
      row.insertAdjacentHTML("beforeend", renderWsDetail(item.ws));
    } else if (!isExpanded && detail) {
      detail.remove();
    }
  }

  // Keep existing rows alive while playback advances; only new/hidden rows are
  // inserted or removed. `rowMap` is a String(item.index) -> row Map persisted
  // across calls (one per log list) so lookups and removals are O(1)/O(visible)
  // instead of re-scanning the whole container with querySelector every tick.
  function syncLogRows(container, rowMap, items, getRowHtml, syncRowState) {
    const visibleKeys = new Set(items.map((item) => String(item.index)));
    for (const [key, row] of rowMap) {
      if (!visibleKeys.has(key)) {
        row.remove();
        rowMap.delete(key);
      }
    }

    let previousRow = null;
    items.forEach((item) => {
      const key = String(item.index);
      let row = rowMap.get(key);

      if (!row) {
        const template = document.createElement("template");
        template.innerHTML = getRowHtml(item).trim();
        row = template.content.firstElementChild;
        rowMap.set(key, row);
      }

      if (previousRow) {
        if (row.previousElementSibling !== previousRow) {
          previousRow.after(row);
        }
      } else if (container.firstElementChild !== row) {
        container.prepend(row);
      }

      syncRowState(row, item);
      previousRow = row;
    });
  }

  // Render console entries
  function renderConsoleEntries() {
    const visible = getVisibleConsoleEntries();

    // Find closest entry and visible entries
    let closestIdx = -1;
    let closestDist = Infinity;

    visible.forEach((pe) => {
      const dist = Math.abs(pe.entry.relativeMs - currentTimeMs);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = pe.index;
      }
    });

    // Only highlight if within 1.5s
    if (closestDist >= 1500) closestIdx = -1;
    closestConsoleIndex = closestIdx;

    const shouldStickToBottom = isScrolledNearBottom(elements.consoleEntries);

    syncLogRows(
      elements.consoleEntries,
      consoleRowMap,
      visible,
      (pe) => getConsoleEntryHtml(pe, closestIdx),
      (row, pe) => syncConsoleEntryState(row, pe, closestIdx),
    );

    mountLunaPlaceholders(elements.consoleEntries);

    if (shouldStickToBottom) {
      scrollToBottom(elements.consoleEntries);
    }
  }

  function renderConsoleDetail(entry) {
    const levelLabel = getConsoleLevelLabel(entry);
    const sourceLabel = entry.source ? ` (${entry.source})` : "";
    const timeStr = formatTimeMs(entry.relativeMs);

    let detailHtml = '<div class="console-detail">';

    // Time
    detailHtml += `
      <div class="detail-section">
        <h4>Time</h4>
        <pre>${timeStr}</pre>
      </div>
    `;

    // Level
    detailHtml += `
      <div class="detail-section">
        <h4>Level</h4>
        <pre>${levelLabel}${sourceLabel}</pre>
      </div>
    `;

    // Arguments or Message
    if (entry.source !== "exception" && entry.source !== "browser" && Array.isArray(entry.args)) {
      detailHtml += `
        <div class="detail-section">
          <h4>Arguments</h4>
          ${entry.args
            .map(
              (arg, i) => `
            <div class="arg-row">
              <span class="arg-index">[${i}]</span>
              <div class="arg-value">${buildLunaObjectMount(arg)}</div>
            </div>
          `,
            )
            .join("")}
        </div>
      `;
    } else if (entry.message) {
      detailHtml += `
        <div class="detail-section">
          <h4>Message</h4>
          <pre class="message-pre">${escapeHtml(entry.message)}</pre>
        </div>
      `;
    }

    // Source location
    const sourceLocation = getConsoleSourceLocation(entry);
    if (sourceLocation) {
      detailHtml += `
        <div class="detail-section">
          <h4>Source</h4>
          <pre>${escapeHtml(sourceLocation)}</pre>
        </div>
      `;
    }
    const sourceMapStatus = getConsoleSourceMapDiagnostic(entry);
    if (sourceMapStatus) {
      detailHtml += `
        <div class="detail-section">
          <h4>Source Map</h4>
          <pre>${escapeHtml(sourceMapStatus)}</pre>
        </div>
      `;
    }

    const sourceSnippet = getConsoleSourceSnippet(entry);
    if (sourceSnippet) {
      detailHtml += `
        <div class="detail-section">
          <h4>Source Preview</h4>
          ${renderSourceSnippet(sourceSnippet)}
        </div>
      `;
    }

    // Stack trace
    if (entry.stackTrace && entry.stackTrace.length > 0) {
      detailHtml += `
        <div class="detail-section">
          <h4>Stack Trace</h4>
          <div class="stack-trace">
      `;
      entry.stackTrace.forEach((frame, i) => {
        if (frame.asyncBoundary) {
          detailHtml += `<div class="async-boundary">--- ${escapeHtml(frame.asyncBoundary)} ---</div>`;
        } else {
          const fnName = frame.originalName || frame.functionName || "(anonymous)";
          const location = formatSourceLocation(frame);
          const src = frame.originalSource || frame.url || "";
          const isVendor = src && src.includes("node_modules");
          detailHtml += `<div class="stack-frame ${isVendor ? "vendor-frame" : ""}">at <span class="fn-name">${escapeHtml(fnName)}</span>${location ? ` <span class="location">(${escapeHtml(location)})</span>` : ""}</div>`;
        }
      });
      detailHtml += `</div></div>`;
    }

    detailHtml += "</div>";
    return detailHtml;
  }

  // Render network entries
  function renderNetworkEntries() {
    const filtered = getVisibleNetworkEntries();

    // Find closest entry and visible entries
    let closestIdx = -1;
    let closestDist = Infinity;

    filtered.forEach((pe) => {
      const dist = Math.abs(pe.entry.relativeMs - currentTimeMs);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = pe.index;
      }
    });

    // Only highlight if within 1.5s
    if (closestDist >= 1500) closestIdx = -1;
    closestNetworkIndex = closestIdx;

    const visibleCount = filtered.length;
    const visibleWs = getVisibleWebSocketEntries();

    // Summary text
    let summaryText = `${visibleCount}/${networkLogs.length} requests`;
    if (activeNetworkFilters.size > 0) summaryText += ` (${[...activeNetworkFilters].join(", ")})`;
    if (networkSearchQuery) summaryText += ` | search`;
    if (webSocketLogs.length > 0)
      summaryText += ` | ${visibleWs.length}/${webSocketLogs.length} WS`;
    elements.networkSummary.textContent = summaryText;

    const shouldStickToBottom = isScrolledNearBottom(elements.networkEntries);

    syncLogRows(
      elements.networkRows,
      networkRowMap,
      filtered,
      (pe) => getNetworkEntryHtml(pe, closestIdx),
      (row, pe) => syncNetworkEntryState(row, pe, closestIdx),
    );

    mountLunaPlaceholders(elements.networkRows);

    if (shouldStickToBottom) {
      scrollToBottom(elements.networkEntries);
    }

    // WebSocket entries
    if (visibleWs.length > 0) {
      elements.websocketSection.classList.remove("hidden");
      syncLogRows(
        elements.websocketRows,
        wsRowMap,
        visibleWs,
        getWebSocketEntryHtml,
        syncWebSocketEntryState,
      );
      mountLunaPlaceholders(elements.websocketRows);
    } else {
      elements.websocketRows.innerHTML = "";
      wsRowMap.clear();
      elements.websocketSection.classList.add("hidden");
    }
  }

  function renderNetworkDetail(entry) {
    const request = entry.request || {};
    const response = entry.response || {};
    const content = getNetworkResponseContent(entry);
    const timings = entry.timing || {};
    const previewHtml = buildResponsePreview(entry, content);
    const responseBodyHtml = buildResponseBodySection(entry, content);

    let detailHtml = '<div class="network-detail">';

    // Time
    detailHtml += `
      <div class="detail-section">
        <h4>Time</h4>
        <pre>${formatTimeMs(entry.relativeMs)}</pre>
      </div>
    `;

    // Redirect chain
    if (entry.redirectChain && entry.redirectChain.length > 0) {
      detailHtml += `
        <div class="detail-section">
          <h4>Redirect Chain</h4>
          <div class="redirect-chain">
      `;
      entry.redirectChain.forEach((r, i) => {
        detailHtml += `
          <div class="redirect-entry">
            <span class="redirect-status">${r.status}</span>
            <span class="redirect-url">${escapeHtml(r.url)}</span>
          </div>
        `;
      });
      detailHtml += `
          <div class="redirect-entry final">
            <span class="redirect-status">${response.status || entry.status || 0}</span>
            <span class="redirect-url">${escapeHtml(request.url || entry.url || "")}</span>
          </div>
        </div></div>
      `;
    }

    // URL
    detailHtml += `
      <div class="detail-section">
        <h4>URL</h4>
        <pre>${escapeHtml(request.url || entry.url || "")}</pre>
      </div>
    `;

    // Request Headers
    detailHtml += `
      <div class="detail-section">
        <h4>Request Headers</h4>
        <pre>${formatHeaders(request.headers || entry.requestHeaders)}</pre>
      </div>
    `;

    // Request Body
    const postData =
      typeof request.postData === "object"
        ? request.postData?.text
        : request.postData || entry.postData;
    if (postData) {
      const requestJsonValidation = validateJsonBody(postData);
      const showRequestJsonPreview = isJsonPreviewReplacingRaw(
        entry,
        "request",
        requestJsonValidation,
      );
      detailHtml += `
        <div class="detail-section">
          <div class="detail-section-heading">
            <h4>Request Body</h4>
            ${buildJsonPreviewToggle(entry, "request", requestJsonValidation)}
          </div>
          ${showRequestJsonPreview ? "" : `<pre>${escapeHtml(postData)}</pre>`}
          ${buildJsonPreviewPanel(entry, "request", requestJsonValidation)}
        </div>
      `;
    }

    // Response Headers
    detailHtml += `
      <div class="detail-section">
        <h4>Response Headers</h4>
        <pre>${formatHeaders(response.headers || entry.responseHeaders)}</pre>
      </div>
    `;

    detailHtml += buildResponseTabs(entry, previewHtml, responseBodyHtml);

    // Timing
    if (timings && Object.keys(timings).length > 0) {
      detailHtml += `
        <div class="detail-section">
          <h4>Timing</h4>
          <div class="timing-info">
      `;
      Object.entries(timings).forEach(([key, val]) => {
        if (val != null && val >= 0) {
          detailHtml += `<span class="timing-item">${key}: <strong>${typeof val === "number" ? val.toFixed(1) + "ms" : val}</strong></span>`;
        }
      });
      detailHtml += `</div></div>`;
    }

    // Initiator
    detailHtml += renderInitiatorSection(entry.initiator, {
      showVendorToggle: true,
      hideVendorFrames: shouldHideNetworkVendorFrames(entry),
    });

    // Error
    if (entry.error) {
      detailHtml += `
        <div class="detail-section">
          <h4>Error</h4>
          <pre class="error-text">${escapeHtml(entry.error)}</pre>
        </div>
      `;
    }

    // Copy buttons
    detailHtml += `
      <div class="copy-actions">
        <button class="copy-btn" data-action="copy-curl">Copy cURL</button>
        <button class="copy-btn" data-action="copy-item">Copy Item</button>
        ${
          content.text
            ? `
          <button class="copy-btn" data-action="copy-response">Copy Response</button>
          <button class="copy-btn" data-action="copy-all">Copy cURL + Response</button>
        `
            : ""
        }
      </div>
    `;

    detailHtml += "</div>";
    return detailHtml;
  }

  // Build a WebSocket frame payload cell. JSON payloads are upgraded to a
  // read-only luna-json-editor (R6.2); everything else keeps the legacy text
  // span. The legacy (truncated, escaped) text remains as the mount's fallback.
  function buildWsPayloadCell(rawData) {
    const data = rawData || "";
    const truncated = data.length > 200 ? `${data.slice(0, 200)}...` : data;
    const legacy = `<span class="ws-payload">${escapeHtml(truncated)}</span>`;
    const parsed = tryParseJsonObject(data);
    if (parsed === undefined) {
      return legacy;
    }
    return buildLunaJsonMount(parsed, legacy, "ws-payload-mount");
  }

  function renderWsDetail(ws) {
    const frames = ws.frames || [];
    const maxFrames = 100;

    return `
      <div class="ws-detail">
        <div>
          <h4>URL</h4>
          <pre>${escapeHtml(ws.url || "")}</pre>
        </div>
        ${renderInitiatorSection(ws.initiator)}
        <div>
          <h4>Frames (${frames.length})</h4>
          <div class="ws-frames-table">
            ${frames
              .slice(0, maxFrames)
              .map((f) => {
                const dir = f.direction === "sent" ? "&uarr;" : "&darr;";
                const dirClass = f.direction === "sent" ? "sent" : "received";
                return `
                <div class="ws-frame-row">
                  <span class="ws-direction ${dirClass}">${dir}</span>
                  ${buildWsPayloadCell(f.payloadData)}
                </div>
              `;
              })
              .join("")}
            ${
              frames.length > maxFrames
                ? `
              <div class="ws-frame-row">
                <span></span>
                <span class="ws-payload">... ${frames.length - maxFrames} more frames</span>
              </div>
            `
                : ""
            }
          </div>
        </div>
      </div>
    `;
  }

  // Render timeline markers
  function renderMarkers() {
    const markers = [];

    // Error markers from console
    consoleLogs.forEach((entry) => {
      if (entry.source === "exception" || getConsoleLevel(entry) === "error") {
        markers.push({
          timeMs: entry.relativeMs,
          color: "#f85149",
          label: `Error: ${(entry.message || "").slice(0, 80)}`,
        });
      }
    });

    // Network markers
    networkLogs.forEach((entry) => {
      const url = entry.url || "";
      const method = entry.method || "GET";
      markers.push({
        timeMs: entry.relativeMs,
        color: "#58a6ff",
        label: `${method} ${url}`.slice(0, 80),
      });
    });

    userEvents.forEach((event) => {
      markers.push({
        timeMs: event.relativeMs,
        color: "#3fb950",
        label: getEventLabel(event).slice(0, 80),
      });
    });

    // Render markers
    elements.markersContainer.innerHTML = markers
      .map((marker) => {
        const pct = duration > 0 ? (marker.timeMs / duration) * 100 : 0;
        if (pct < 0 || pct > 100) return "";
        return `<div class="marker" style="left: ${pct}%; background-color: ${marker.color};" title="${escapeHtml(marker.label)}"></div>`;
      })
      .join("");
  }

  function getSplitPercentFromPointer(clientX, clientY) {
    const rect = elements.mainLayout.getBoundingClientRect();
    if (layoutState.mode === "vertical") {
      const relativeY = clientY - rect.top;
      return (relativeY / rect.height) * 100;
    }

    const relativeX = clientX - rect.left;
    return (relativeX / rect.width) * 100;
  }

  function setupLayoutListeners() {
    let activePointerId = null;

    const stopResizing = () => {
      if (activePointerId !== null) {
        try {
          elements.layoutSplitter.releasePointerCapture(activePointerId);
        } catch {}
      }
      activePointerId = null;
      elements.playerState.classList.remove("is-resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    elements.layoutVerticalBtn.addEventListener("click", () => {
      setLayoutMode("vertical");
    });
    elements.layoutHorizontalBtn.addEventListener("click", () => {
      setLayoutMode("horizontal");
    });
    elements.videoFullscreenBtn.addEventListener("click", () => {
      toggleVideoFullscreen();
    });

    elements.layoutSplitter.addEventListener("pointerdown", (event) => {
      activePointerId = event.pointerId;
      elements.layoutSplitter.setPointerCapture(event.pointerId);
      elements.playerState.classList.add("is-resizing");
      document.body.style.userSelect = "none";
      document.body.style.cursor = layoutState.mode === "vertical" ? "row-resize" : "col-resize";
      setSplitPercent(getSplitPercentFromPointer(event.clientX, event.clientY), false);
      event.preventDefault();
    });

    elements.layoutSplitter.addEventListener("pointermove", (event) => {
      if (event.pointerId !== activePointerId) {
        return;
      }
      setSplitPercent(getSplitPercentFromPointer(event.clientX, event.clientY), false);
    });

    elements.layoutSplitter.addEventListener("pointerup", (event) => {
      if (event.pointerId !== activePointerId) {
        return;
      }
      setSplitPercent(layoutState.splitPercent, true);
      stopResizing();
    });

    elements.layoutSplitter.addEventListener("pointercancel", stopResizing);

    elements.layoutSplitter.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 5 : 2;
      if (layoutState.mode === "horizontal" && event.key === "ArrowLeft") {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent - step);
      } else if (layoutState.mode === "horizontal" && event.key === "ArrowRight") {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent + step);
      } else if (layoutState.mode === "vertical" && event.key === "ArrowUp") {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent - step);
      } else if (layoutState.mode === "vertical" && event.key === "ArrowDown") {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent + step);
      }
    });

    window.addEventListener("blur", stopResizing);
  }

  function updateVideoFit() {
    if (!elements.video || !elements.videoContainer) {
      return;
    }

    const videoWidth = elements.video.videoWidth || 0;
    const videoHeight = elements.video.videoHeight || 0;
    const containerRect = elements.videoContainer.getBoundingClientRect();
    const videoRatio = videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : 0;
    const containerRatio =
      containerRect.width > 0 && containerRect.height > 0
        ? containerRect.width / containerRect.height
        : 0;

    elements.video.classList.remove("video-fit-width", "video-fit-height");
    if (!videoRatio || !containerRatio) {
      elements.video.classList.add("video-fit-width");
      return;
    }

    // Fit the media element itself to the wrapper's limiting axis; otherwise object-fit
    // letterboxes inside a stretched full-size video box.
    elements.video.classList.add(
      containerRatio > videoRatio ? "video-fit-height" : "video-fit-width",
    );

    resizeDrawingCanvas();
    if (elements.video && !Number.isNaN(elements.video.currentTime)) {
      renderDrawingUpTo(elements.video.currentTime * 1000);
    }
  }

  // CSS-pixel size of the recorded viewport, used as the coordinate space for
  // captured event.x/event.y (which are clientX/clientY at record time). The
  // tab video captures exactly this viewport, so a click at (x, y) maps to the
  // fraction (x / viewport.width, y / viewport.height) of the displayed frame.
  function getEffectViewportSize() {
    const viewport = report?.environment?.viewport;
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      return { width: viewport.width, height: viewport.height };
    }
    // Best-effort fallback for legacy recordings without a captured viewport.
    // Intrinsic video pixels only equal CSS pixels at devicePixelRatio 1 and
    // without downscaling, so this can be off on HiDPI captures.
    const videoWidth = elements.video?.videoWidth || 0;
    const videoHeight = elements.video?.videoHeight || 0;
    if (videoWidth > 0 && videoHeight > 0) {
      return { width: videoWidth, height: videoHeight };
    }
    return null;
  }

  // Live rectangle of the actually-displayed video pixels, relative to the
  // effects layer (which covers the whole video-container). Recomputed on every
  // effect so it can never drift from the current layout, and it accounts for
  // object-fit letterboxing so coordinates land on real pixels even if the fit
  // class has not been applied yet.
  function getVideoContentRect() {
    const video = elements.video;
    const container = elements.videoContainer;
    if (!video || !container) {
      return null;
    }
    const elementRect = video.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (elementRect.width <= 0 || elementRect.height <= 0) {
      return null;
    }

    let contentWidth = elementRect.width;
    let contentHeight = elementRect.height;
    const intrinsicWidth = video.videoWidth || 0;
    const intrinsicHeight = video.videoHeight || 0;
    if (intrinsicWidth > 0 && intrinsicHeight > 0) {
      const intrinsicRatio = intrinsicWidth / intrinsicHeight;
      const elementRatio = elementRect.width / elementRect.height;
      if (elementRatio > intrinsicRatio) {
        contentHeight = elementRect.height;
        contentWidth = contentHeight * intrinsicRatio;
      } else {
        contentWidth = elementRect.width;
        contentHeight = contentWidth / intrinsicRatio;
      }
    }

    return {
      left: elementRect.left - containerRect.left + (elementRect.width - contentWidth) / 2,
      top: elementRect.top - containerRect.top + (elementRect.height - contentHeight) / 2,
      width: contentWidth,
      height: contentHeight,
    };
  }

  // Chrome tab capture can letterbox the page inside a larger fixed-size frame
  // (e.g. a 1036x884 viewport recorded into a 1920x1080 video with black bars),
  // so a click's viewport fraction is NOT its fraction of the whole frame. Map
  // the click into the contain-fitted, centered page sub-rectangle first, then
  // express it as a fraction of the full frame. Degrades to a plain fraction
  // when the aspect ratios already match (offsets become zero).
  function getRecordedFrameFraction(event, viewport) {
    const frameWidth = elements.video?.videoWidth || 0;
    const frameHeight = elements.video?.videoHeight || 0;
    const xFrac = Math.max(0, Math.min(1, event.x / viewport.width));
    const yFrac = Math.max(0, Math.min(1, event.y / viewport.height));
    if (frameWidth <= 0 || frameHeight <= 0) {
      return { x: xFrac, y: yFrac };
    }

    const viewportRatio = viewport.width / viewport.height;
    const frameRatio = frameWidth / frameHeight;
    let innerWidth = frameWidth;
    let innerHeight = frameHeight;
    if (frameRatio > viewportRatio) {
      innerWidth = frameHeight * viewportRatio;
    } else {
      innerHeight = frameWidth / viewportRatio;
    }

    return {
      x: ((frameWidth - innerWidth) / 2 + xFrac * innerWidth) / frameWidth,
      y: ((frameHeight - innerHeight) / 2 + yFrac * innerHeight) / frameHeight,
    };
  }

  function spawnEffect(event) {
    if (!elements.videoEffectsLayer) {
      return;
    }
    const viewport = getEffectViewportSize();
    const content = getVideoContentRect();
    if (!viewport || !content) {
      return;
    }

    const frac = getRecordedFrameFraction(event, viewport);
    const leftPx = content.left + frac.x * content.width;
    const topPx = content.top + frac.y * content.height;

    const node = document.createElement("div");
    if (event.type === "click") {
      node.className = "video-effect video-effect-click";
    } else if (event.type === "contextmenu") {
      node.className = "video-effect video-effect-rclick";
    } else {
      node.className = `video-effect video-effect-scroll video-effect-scroll-${event.direction === "up" ? "up" : "down"}`;
    }
    node.style.left = `${leftPx}px`;
    node.style.top = `${topPx}px`;

    node.addEventListener(
      "animationend",
      () => {
        node.remove();
        liveEffectNodes = liveEffectNodes.filter((live) => live !== node);
      },
      { once: true },
    );

    if (liveEffectNodes.length >= MAX_LIVE_EFFECT_NODES) {
      const oldest = liveEffectNodes.shift();
      oldest?.remove();
    }
    liveEffectNodes.push(node);
    elements.videoEffectsLayer.appendChild(node);
  }

  function resetEffectsCursor() {
    const timeMs = elements.video.currentTime * 1000;
    let idx = effectEvents.findIndex((event) => event.relativeMs > timeMs);
    if (idx === -1) {
      idx = effectEvents.length;
    }
    effectsCursorIdx = idx;

    const windowStart = timeMs - EFFECT_TRAILING_WINDOW_MS;
    for (let i = idx - 1; i >= 0 && effectEvents[i].relativeMs >= windowStart; i--) {
      spawnEffect(effectEvents[i]);
    }
  }

  function tickEffectsScheduler() {
    if (elements.video.paused || elements.video.ended) {
      effectsRafId = null;
      return;
    }

    const timeMs = elements.video.currentTime * 1000;
    const windowStart = timeMs - EFFECT_TRAILING_WINDOW_MS;
    while (
      effectsCursorIdx < effectEvents.length &&
      effectEvents[effectsCursorIdx].relativeMs <= timeMs
    ) {
      const event = effectEvents[effectsCursorIdx];
      if (event.relativeMs >= windowStart) {
        spawnEffect(event);
      }
      effectsCursorIdx += 1;
    }

    effectsRafId = requestAnimationFrame(tickEffectsScheduler);
  }

  function startEffectsScheduler() {
    if (effectsRafId !== null) {
      return;
    }
    effectsRafId = requestAnimationFrame(tickEffectsScheduler);
  }

  function stopEffectsScheduler() {
    if (effectsRafId !== null) {
      cancelAnimationFrame(effectsRafId);
      effectsRafId = null;
    }
  }

  function resizeDrawingCanvas() {
    const canvas = elements.drawingCanvas;
    const container = elements.videoContainer;
    if (!canvas || !container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    // Resizing the backing buffer wipes its pixels, so the next render must
    // repaint even if the drawing-state signature hasn't changed.
    drawingCanvasNeedsRepaint = true;
  }

  function getDrawingContext() {
    const canvas = elements.drawingCanvas;
    if (!canvas) {
      return null;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return ctx;
  }

  // `content` is the live video content rect, computed once per render call
  // (not once per point — see renderDrawingUpTo) since it costs two
  // getBoundingClientRect() layout reads.
  function mapDrawingPoint(point, viewport, content) {
    const frac = getRecordedFrameFraction({ x: point.x, y: point.y }, viewport);
    return {
      x: content.left + frac.x * content.width,
      y: content.top + frac.y * content.height,
    };
  }

  function getActiveDrawingClearMs(timeMs) {
    let clearMs = null;
    for (const ms of drawingClears) {
      if (ms <= timeMs) {
        clearMs = ms;
      } else {
        break;
      }
    }
    return clearMs;
  }

  // Largest index i such that points[i].t <= elapsedMs, or -1 if none qualify.
  // Points within a stroke are recorded in increasing `t` order, so a binary
  // search stays O(log n) even for a finished stroke re-checked every frame.
  function findLastDrawingPointIndex(points, elapsedMs) {
    let lo = 0;
    let hi = points.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= elapsedMs) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  // Signature of the last frame actually painted to the canvas: which strokes
  // were visible and how far each was drawn, plus the active clear boundary and
  // the strokes array identity (a new recording replaces the array). Comparing
  // against this lets renderDrawingUpTo skip clearRect+redraw entirely on
  // frames where nothing on screen would change — the common case once a
  // stroke finishes drawing and no clear/resize/seek has happened since.
  let lastDrawingSignature = { source: null, clearMs: undefined, indices: new Map() };
  // Forces the next renderDrawingUpTo call to redraw regardless of the
  // signature — set whenever the canvas pixels were wiped out-of-band (layout
  // resize, fullscreen, splitter drag, seek-start clear) so the blank canvas
  // gets repainted even when the logical drawing state hasn't changed.
  let drawingCanvasNeedsRepaint = true;

  function renderDrawingUpTo(timeMs) {
    const canvas = elements.drawingCanvas;
    const ctx = getDrawingContext();
    const viewport = getEffectViewportSize();
    if (!canvas || !ctx || !viewport) {
      return;
    }
    const content = getVideoContentRect();
    if (!content) {
      // Video isn't laid out yet (e.g. zero-size during a transient resize).
      // Blank the canvas like before, and force a full repaint once content
      // becomes available again since the signature no longer matches reality.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawingCanvasNeedsRepaint = true;
      return;
    }

    const activeClearMs = getActiveDrawingClearMs(timeMs);
    let stateChanged =
      drawingCanvasNeedsRepaint ||
      lastDrawingSignature.source !== drawingStrokes ||
      lastDrawingSignature.clearMs !== activeClearMs;

    const visible = [];
    for (const stroke of drawingStrokes) {
      if (stroke.relativeMs > timeMs) {
        continue;
      }
      if (activeClearMs !== null && stroke.relativeMs < activeClearMs) {
        continue;
      }
      const elapsed = timeMs - stroke.relativeMs;
      const lastIndex = findLastDrawingPointIndex(stroke.points, elapsed);
      if (lastIndex < 1) {
        continue;
      }
      visible.push({ stroke, lastIndex });
      if (lastDrawingSignature.indices.get(stroke) !== lastIndex) {
        stateChanged = true;
      }
    }
    if (visible.length !== lastDrawingSignature.indices.size) {
      stateChanged = true;
    }

    if (!stateChanged) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const nextIndices = new Map();

    for (const { stroke, lastIndex } of visible) {
      const points = stroke.points;
      const color = stroke.color || "#ff6b6b";
      const width = stroke.width || 3;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();

      const first = mapDrawingPoint(points[0], viewport, content);
      ctx.moveTo(first.x, first.y);

      for (let i = 1; i <= lastIndex; i += 1) {
        const mapped = mapDrawingPoint(points[i], viewport, content);
        ctx.lineTo(mapped.x, mapped.y);
      }
      ctx.stroke();
      nextIndices.set(stroke, lastIndex);
    }

    lastDrawingSignature = { source: drawingStrokes, clearMs: activeClearMs, indices: nextIndices };
    drawingCanvasNeedsRepaint = false;
  }

  function tickDrawingScheduler() {
    if (elements.video.paused || elements.video.ended) {
      drawingRafId = null;
      return;
    }
    renderDrawingUpTo(elements.video.currentTime * 1000);
    drawingRafId = requestAnimationFrame(tickDrawingScheduler);
  }

  function startDrawingScheduler() {
    if (drawingRafId !== null || drawingStrokes.length === 0) {
      return;
    }
    drawingRafId = requestAnimationFrame(tickDrawingScheduler);
  }

  function stopDrawingScheduler() {
    if (drawingRafId !== null) {
      cancelAnimationFrame(drawingRafId);
      drawingRafId = null;
    }
  }

  // Video event handlers
  function setupVideoListeners() {
    let isDragging = false;
    let lastEmitTime = 0;

    // Play/Pause toggle
    elements.video.addEventListener("click", togglePlayPause);
    elements.playPauseBtn.addEventListener("click", togglePlayPause);
    window.addEventListener("resize", updateVideoFit);
    if (typeof ResizeObserver !== "undefined" && elements.videoContainer) {
      new ResizeObserver(updateVideoFit).observe(elements.videoContainer);
    }

    // Time update
    elements.video.addEventListener("timeupdate", () => {
      const now = performance.now();
      if (now - lastEmitTime < 250) return;
      lastEmitTime = now;

      currentTimeMs = elements.video.currentTime * 1000;
      updateProgress();
      if (activeLogsTab === "console") {
        renderConsoleEntries();
      } else {
        consolePanelDirty = true;
      }
      if (activeLogsTab === "network") {
        renderNetworkEntries();
      } else {
        networkPanelDirty = true;
      }
      updateStorageForTime();
      updateElementsForTime();
    });

    // Loaded metadata
    elements.video.addEventListener("loadedmetadata", () => {
      updateVideoFit();
      syncDurationState(getVideoDurationMs());
      renderMarkers();
      updateProgress();
    });

    // Play/Pause state changes
    elements.video.addEventListener("play", () => {
      elements.playIcon.classList.add("hidden");
      elements.pauseIcon.classList.remove("hidden");
      startEffectsScheduler();
      startDrawingScheduler();
    });

    elements.video.addEventListener("pause", () => {
      elements.playIcon.classList.remove("hidden");
      elements.pauseIcon.classList.add("hidden");
      stopEffectsScheduler();
      stopDrawingScheduler();
    });

    elements.video.addEventListener("ended", () => {
      elements.playIcon.classList.remove("hidden");
      elements.pauseIcon.classList.add("hidden");
      stopEffectsScheduler();
      stopDrawingScheduler();
      currentTimeMs = syncDurationState(getVideoDurationMs());
      updateProgress();
    });

    elements.video.addEventListener("seeking", () => {
      stopEffectsScheduler();
      stopDrawingScheduler();
      if (elements.drawingCanvas) {
        const ctx = elements.drawingCanvas.getContext("2d");
        ctx?.clearRect(0, 0, elements.drawingCanvas.width, elements.drawingCanvas.height);
        drawingCanvasNeedsRepaint = true;
      }
    });
    elements.video.addEventListener("seeked", () => {
      resetEffectsCursor();
      renderDrawingUpTo(elements.video.currentTime * 1000);
      if (!elements.video.paused && !elements.video.ended) {
        startEffectsScheduler();
        startDrawingScheduler();
      }
    });

    // Progress bar interaction
    elements.progressWrapper.addEventListener("mousedown", (e) => {
      isDragging = true;
      seekToRatio(getMouseRatio(e.clientX));
    });

    elements.progressWrapper.addEventListener("touchstart", (e) => {
      isDragging = true;
      if (e.touches[0]) {
        seekToRatio(getMouseRatio(e.touches[0].clientX));
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (isDragging) {
        seekToRatio(getMouseRatio(e.clientX));
      }

      // Tooltip on hover
      const rect = elements.progressWrapper.getBoundingClientRect();
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        const ratio = (e.clientX - rect.left) / rect.width;
        const time = ratio * duration;
        elements.tooltip.textContent = formatTime(time);
        elements.tooltip.style.left = `${e.clientX - rect.left}px`;
        elements.tooltip.classList.remove("hidden");
      } else {
        elements.tooltip.classList.add("hidden");
      }
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });

    document.addEventListener("touchmove", (e) => {
      if (isDragging && e.touches[0]) {
        seekToRatio(getMouseRatio(e.touches[0].clientX));
      }
    });

    document.addEventListener("touchend", () => {
      isDragging = false;
    });

    // Speed control
    elements.speedBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      elements.speedMenu.classList.toggle("hidden");
    });

    elements.speedMenu.querySelectorAll(".speed-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const speed = parseFloat(btn.dataset.speed);
        elements.video.playbackRate = speed;
        elements.speedBtn.textContent = `${speed}x`;
        elements.speedMenu.classList.add("hidden");
      });
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".speed-control")) {
        elements.speedMenu.classList.add("hidden");
      }
    });

    // Volume control
    elements.muteBtn.addEventListener("click", () => {
      elements.video.muted = !elements.video.muted;
      updateVolumeDisplay();
    });

    elements.volumeSlider.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      elements.video.volume = val;
      elements.video.muted = false;
      updateVolumeDisplay();
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlayPause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          elements.video.currentTime = Math.max(
            0,
            elements.video.currentTime - (e.shiftKey ? 10 : 5),
          );
          break;
        case "ArrowRight":
          e.preventDefault();
          elements.video.currentTime = elements.video.currentTime + (e.shiftKey ? 10 : 5);
          break;
        case "Digit1":
          elements.video.playbackRate = 0.5;
          elements.speedBtn.textContent = "0.5x";
          break;
        case "Digit2":
          elements.video.playbackRate = 1;
          elements.speedBtn.textContent = "1x";
          break;
        case "Digit3":
          elements.video.playbackRate = 1.5;
          elements.speedBtn.textContent = "1.5x";
          break;
        case "Digit4":
          elements.video.playbackRate = 2;
          elements.speedBtn.textContent = "2x";
          break;
        case "KeyF":
          e.preventDefault();
          toggleVideoFullscreen();
          break;
        case "Escape":
          if (isVideoFullscreen) {
            e.preventDefault();
            toggleVideoFullscreen();
          }
          break;
      }
    });
  }

  function togglePlayPause() {
    if (elements.video.paused || elements.video.ended) {
      elements.video.play();
    } else {
      elements.video.pause();
    }
  }

  function getMouseRatio(clientX) {
    const rect = elements.progressWrapper.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function seekToRatio(ratio) {
    elements.video.currentTime = (ratio * duration) / 1000;
    currentTimeMs = elements.video.currentTime * 1000;
    updateProgress();
    renderConsoleEntries();
    renderNetworkEntries();
    updateStorageForTime();
    updateElementsForTime();
  }

  function clampProgressPercent(value) {
    // Media clocks can briefly report past the known duration; keep progress bars inside the track.
    return Math.max(0, Math.min(100, value));
  }

  function getVisualProgressTimeMs(timeMs, durationMs) {
    if (durationMs <= 0) {
      return timeMs;
    }

    const clampedTimeMs = Math.max(0, Math.min(timeMs, durationMs));
    const remainingMs = durationMs - clampedTimeMs;
    // Time labels are second-granular, so snap the last sub-second sliver to the end.
    return remainingMs < PROGRESS_END_SNAP_MS ? durationMs : clampedTimeMs;
  }

  function updateProgress() {
    const playbackDuration = syncDurationState(getVideoDurationMs());
    const visualTimeMs = getVisualProgressTimeMs(currentTimeMs, playbackDuration);
    const ratio =
      playbackDuration > 0 ? clampProgressPercent((visualTimeMs / playbackDuration) * 100) : 0;
    elements.playedBar.style.width = `${ratio}%`;
    elements.progressHandle.style.left = `${ratio}%`;
    elements.currentTime.textContent = formatTime(visualTimeMs);

    // Buffered
    if (elements.video.buffered.length > 0) {
      const bufferedEnd = elements.video.buffered.end(elements.video.buffered.length - 1);
      const dur = elements.video.duration;
      const bufferedRatio = dur > 0 ? clampProgressPercent((bufferedEnd / dur) * 100) : 0;
      elements.bufferedBar.style.width = `${bufferedRatio}%`;
    }
  }

  function updateVolumeDisplay() {
    if (elements.video.muted || elements.video.volume === 0) {
      elements.volumeOn.classList.add("hidden");
      elements.volumeOff.classList.remove("hidden");
    } else {
      elements.volumeOn.classList.remove("hidden");
      elements.volumeOff.classList.add("hidden");
      elements.volumeSlider.value = elements.video.volume;
    }
  }

  // Filter handlers
  function syncFilterButtonsUI(container, activeFilters) {
    container.querySelectorAll(".filter-btn").forEach((b) => {
      const value = b.dataset.filter;
      const isActive = value === "all" ? activeFilters.size === 0 : activeFilters.has(value);
      b.classList.toggle("active", isActive);
    });
  }

  function setupFilterToggleGroup(container, activeFilters, onChange) {
    container.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.filter;
        if (value === "all") {
          activeFilters.clear();
        } else if (activeFilters.has(value)) {
          activeFilters.delete(value);
        } else {
          activeFilters.add(value);
        }
        syncFilterButtonsUI(container, activeFilters);
        onChange();
      });
    });
  }

  const SEARCH_INPUT_DEBOUNCE_MS = 200;

  function debounce(fn, delayMs) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delayMs);
    };
  }

  function setupFilterListeners() {
    setupFilterToggleGroup(elements.consoleFilters, activeConsoleFilters, renderConsoleEntries);
    setupFilterToggleGroup(elements.networkFilters, activeNetworkFilters, renderNetworkEntries);

    const debouncedRenderConsoleEntries = debounce(renderConsoleEntries, SEARCH_INPUT_DEBOUNCE_MS);
    const debouncedRenderNetworkEntries = debounce(renderNetworkEntries, SEARCH_INPUT_DEBOUNCE_MS);

    elements.consoleSearch.addEventListener("input", () => {
      consoleSearchQuery = elements.consoleSearch.value || "";
      debouncedRenderConsoleEntries();
    });

    elements.networkSearch.addEventListener("input", () => {
      networkSearchQuery = elements.networkSearch.value || "";
      debouncedRenderNetworkEntries();
    });
  }

  // Toggling a row's expanded state only needs that one row patched — not a
  // full re-render of every visible row — since neither the visible set nor
  // any other row's active/expanded state changes as a result.
  function setupLogRowListeners() {
    elements.consoleEntries.addEventListener("click", (e) => {
      const toggle = e.target.closest(".toggle-expand");
      if (!toggle) return;

      const row = toggle.closest(".console-entry");
      if (!row) return;

      e.stopPropagation();
      const index = parseInt(row.dataset.index);
      expandedConsoleIndex = expandedConsoleIndex === index ? null : index;
      const pe = getPreparedConsoleEntries()[index];
      if (pe) {
        syncConsoleEntryState(row, pe, closestConsoleIndex);
        mountLunaPlaceholders(row);
      }
    });

    elements.networkRows.addEventListener("click", (e) => {
      const toggle = e.target.closest(".toggle-expand");
      if (!toggle) return;

      const row = toggle.closest(".network-row");
      if (!row) return;

      e.stopPropagation();
      const index = parseInt(row.dataset.index);
      expandedNetworkIndex = expandedNetworkIndex === index ? null : index;
      const pe = getPreparedNetworkEntries()[index];
      if (pe) {
        syncNetworkEntryState(row, pe, closestNetworkIndex);
        mountLunaPlaceholders(row);
      }
    });

    elements.websocketRows.addEventListener("click", (e) => {
      const toggle = e.target.closest(".toggle-expand");
      if (!toggle) return;

      const row = toggle.closest(".ws-row");
      if (!row) return;

      e.stopPropagation();
      const index = parseInt(row.dataset.index);
      expandedWsIndex = expandedWsIndex === index ? null : index;
      const item = getPreparedWebSocketEntries()[index];
      if (item) {
        syncWebSocketEntryState(row, item);
        mountLunaPlaceholders(row);
      }
    });
  }

  // Tab handlers
  function setupTabListeners() {
    elements.reportTab?.addEventListener("click", () => {
      if (!elements.reportTab.classList.contains("hidden")) {
        showLogsTab("report");
      }
    });

    elements.consoleTab.addEventListener("click", () => {
      showLogsTab("console");
    });

    elements.networkTab.addEventListener("click", () => {
      showLogsTab("network");
    });

    elements.storageTab?.addEventListener("click", () => {
      if (!elements.storageTab.classList.contains("hidden")) {
        showLogsTab("storage");
      }
    });

    elements.elementsTab?.addEventListener("click", () => {
      if (!elements.elementsTab.classList.contains("hidden")) {
        showLogsTab("elements");
      }
    });
  }

  // Copy cURL functionality
  function generateCurl(entry) {
    const request = entry.request || {};
    const url = request.url || entry.url || "";
    const method = request.method || entry.method || "GET";
    const parts = [`curl '${url.replace(/'/g, "'\\''")}'`];

    if (method !== "GET") parts.push(`-X ${method}`);

    const headers = request.headers || entry.requestHeaders;
    if (headers) {
      const headerList = Array.isArray(headers)
        ? headers
        : Object.entries(headers).map(([name, value]) => ({ name, value }));
      for (const h of headerList) {
        parts.push(`-H '${h.name}: ${String(h.value).replace(/'/g, "'\\''")}'`);
      }
    }

    const postData =
      typeof request.postData === "object"
        ? request.postData?.text
        : request.postData || entry.postData;
    if (postData) {
      parts.push(`--data-raw '${postData.replace(/'/g, "'\\''")}'`);
    }

    return parts.join(" \\\n  ");
  }

  function getCopyableNetworkItem(entry) {
    if (!shouldHideNetworkVendorFrames(entry) || !entry.initiator?.stack?.callFrames) {
      return entry;
    }

    return {
      ...entry,
      initiator: {
        ...entry.initiator,
        stack: {
          ...entry.initiator.stack,
          callFrames: entry.initiator.stack.callFrames.filter(
            (frame) => !isNetworkVendorFrame(frame),
          ),
        },
      },
    };
  }

  function stringifyNetworkItem(entry) {
    const seen = new WeakSet();
    return JSON.stringify(
      getCopyableNetworkItem(entry),
      (_key, value) => {
        if (typeof value === "bigint") {
          return value.toString();
        }
        if (value && typeof value === "object") {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }
        return value;
      },
      2,
    );
  }

  function setupCopyListeners() {
    document.addEventListener("click", (e) => {
      if (e.target.classList.contains("copy-btn")) {
        const action = e.target.dataset.action;
        const row = e.target.closest(".network-row");
        if (row) {
          const index = parseInt(row.dataset.index);
          const entry = networkLogs[index];

          if (entry) {
            let text = "";
            const content = getNetworkResponseContent(entry);
            if (action === "copy-curl") {
              text = generateCurl(entry);
            } else if (action === "copy-item") {
              text = stringifyNetworkItem(entry);
            } else if (action === "copy-response") {
              text = getResponseBodyText(entry, content) || content.text || "";
            } else if (action === "copy-all") {
              const curl = generateCurl(entry);
              text =
                curl +
                "\n\n--- Response ---\n\n" +
                (getResponseBodyText(entry, content) || content.text || "");
            }

            navigator.clipboard.writeText(text).then(() => {
              const originalText = e.target.textContent;
              e.target.textContent = "Copied!";
              setTimeout(() => {
                e.target.textContent = originalText;
              }, 1500);
            });
          }
        }
      }
    });
  }

  function setupNetworkDetailTabListeners() {
    document.addEventListener("click", (e) => {
      const jsonPreviewToggle = e.target.closest('[data-action="toggle-json-preview"]');
      if (jsonPreviewToggle) {
        const row = jsonPreviewToggle.closest(".network-row");
        const bodyKind = jsonPreviewToggle.dataset.bodyKind;
        if (!row || !bodyKind) return;

        const index = Number.parseInt(row.dataset.index, 10);
        const entry = networkLogs[index];
        if (!entry) return;

        const key = getNetworkJsonPreviewKey(entry, bodyKind);
        networkJsonPreviewToggles.set(key, !isNetworkJsonPreviewVisible(entry, bodyKind));
        renderNetworkEntries();
        return;
      }

      const initiatorToggle = e.target.closest(".initiator-filter-toggle");
      if (initiatorToggle) {
        const row = initiatorToggle.closest(".network-row");
        if (!row) return;

        const index = parseInt(row.dataset.index);
        const entry = networkLogs[index];
        if (!entry) return;

        const key = getNetworkDetailTabKey(entry);
        networkInitiatorVendorFilters.set(key, !shouldHideNetworkVendorFrames(entry));
        renderNetworkEntries();
        return;
      }

      const tab = e.target.closest(".network-detail-tab");
      if (!tab) return;

      const row = tab.closest(".network-row");
      if (!row) return;

      const index = parseInt(row.dataset.index);
      const entry = networkLogs[index];
      const targetTab = tab.dataset.tab;
      if (!entry || !targetTab) return;

      networkDetailTabs.set(getNetworkDetailTabKey(entry), targetTab);
      renderNetworkEntries();
    });
  }

  function setupPasswordListeners() {
    elements.passwordForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (passwordPromptBusy || !passwordPromptResolve) {
        return;
      }

      const password = elements.passwordInput?.value || "";
      if (!password) {
        setPasswordPromptError("Enter the recording password.");
        return;
      }

      const resolve = passwordPromptResolve;
      passwordPromptResolve = null;
      setPasswordPromptError("");
      resolve(password);
    });
  }

  function setupReportListeners() {
    elements.eventList?.addEventListener("click", (event) => {
      const item = event.target.closest(".event-item");
      if (!item) return;

      const timeMs = Number(item.dataset.timeMs);
      if (!Number.isFinite(timeMs) || !elements.video) return;

      elements.video.currentTime = Math.max(0, timeMs / 1000);
      currentTimeMs = elements.video.currentTime * 1000;
      updateProgress();
      renderConsoleEntries();
      renderNetworkEntries();
      updateStorageForTime();
      updateElementsForTime();
    });
  }

  // Initialize
  async function init() {
    initElements();
    applyLayoutState();
    updateVolumeDisplay();
    document.title = DEFAULT_PLAYER_TITLE;
    window.addEventListener("unload", releaseVideoResources);
    window.addEventListener("unload", releaseScreenshotResources);
    setupLayoutListeners();
    setupVideoListeners();
    setupFilterListeners();
    setupLogRowListeners();
    setupTabListeners();
    setupCopyListeners();
    setupNetworkDetailTabListeners();
    setupPasswordListeners();
    setupReportListeners();

    // Theme toggle
    const themeToggleBtn = document.getElementById("theme-toggle-btn");
    const themeToggleIcon = document.getElementById("theme-toggle-icon");
    if (themeToggleBtn && themeToggleIcon) {
      const savedTheme = localStorage.getItem("gn_tracing_theme");
      const systemLight =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
      const currentTheme =
        savedTheme === "light" || savedTheme === "dark"
          ? savedTheme
          : systemLight
            ? "light"
            : "dark";
      document.documentElement.setAttribute("data-theme", currentTheme);
      themeToggleIcon.className = currentTheme === "light" ? "ph ph-sun" : "ph ph-moon";
      themeToggleBtn.addEventListener("click", () => {
        // Read the live theme from the DOM each click so the toggle keeps
        // working past the first press (a captured const would freeze it).
        const activeTheme =
          document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
        const newTheme = activeTheme === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", newTheme);
        localStorage.setItem("gn_tracing_theme", newTheme);
        themeToggleIcon.className = newTheme === "light" ? "ph ph-sun" : "ph ph-moon";
      });
    }

    const urlParams = new URLSearchParams(window.location.search);
    const videos = urlParams.get("videos");
    const metadataFileId = urlParams.get("metadata");
    const replayRecordingId = resolveReplayRecordingId();
    const hasParams = Array.from(urlParams.keys()).length > 0;

    if (replayRecordingId) {
      resetLoadingProgress("Loading recording package...");
      recordingFiles = await loadRecordingFilesFromIndex(replayRecordingId);
      await loadRecordingFromFiles();
    } else if (videos && metadataFileId) {
      recordingFiles = buildDirectRecordingFiles(urlParams);
      await loadRecordingFromFiles();
    } else if (!hasParams) {
      console.info(
        "[GN Tracing Player] Showing intro state without replay params:",
        GITHUB_REPO_URL,
      );
      showIntro();
    } else {
      elements.errorMessage.textContent =
        "Invalid or missing recording parameters. Please provide videos and metadata file IDs.";
      showError();
    }
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

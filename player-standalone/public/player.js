/**
 * GN Tracing Player
 * Loads recording data from Google Drive and displays video synchronized with logs
 */

(function() {
  'use strict';

  // ===== MODE DETECTION =====
  // Detect if running in Chrome Extension or Standalone mode
  const IS_EXTENSION = typeof chrome !== 'undefined' &&
                       chrome.runtime &&
                       typeof chrome.runtime.getURL === 'function';

  const IS_STANDALONE = !IS_EXTENSION;

  // Get config from window (set by standalone adapter if running standalone)
  const CONFIG = window.GN_TRACING_CONFIG || {};
  const PLAYER_LAYOUT_STORAGE_KEY = 'gn-tracing-player-layout';
  const DEFAULT_PLAYER_TITLE = 'GN Tracing Player';
  const GITHUB_REPO_URL = 'https://github.com/gnasdev/gn-tracing';
  const DEFAULT_LAYOUT_MODE = 'horizontal';
  const DEFAULT_SPLIT_PERCENT = {
    horizontal: 50,
    vertical: 55
  };
  const MIN_SPLIT_PERCENT = 25;
  const MAX_SPLIT_PERCENT = 75;
  const MAX_RESPONSE_DISPLAY_CHARS = 10240;
  const MAX_RESPONSE_PREVIEW_CHARS = 40000;

  console.log('[GN Tracing Player] Mode:', IS_EXTENSION ? 'extension' : 'standalone');

  // State
  let videoBlob = null;
  let videoUrl = null;
  let consoleLogs = [];
  let networkLogs = [];
  let webSocketLogs = [];
  let metadata = {};
  let startTime = 0;
  let currentTimeMs = 0;
  let duration = 0;

  let activeConsoleFilter = 'all';
  let activeNetworkFilter = 'all';
  let consoleSearchQuery = '';
  let networkSearchQuery = '';
  let expandedConsoleIndex = null;
  let expandedNetworkIndex = null;
  let expandedWsIndex = null;
  const networkDetailTabs = new Map();
  let closestConsoleIndex = -1;
  let closestNetworkIndex = -1;
  let layoutState = loadLayoutState();
  let isVideoFullscreen = false;
  let loadingProgressMessage = 'Loading recording...';
  const loadingProgressEntries = new Map();
  let expectedVideoBytes = 0;

  function releaseVideoResources() {
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
      videoUrl = null;
    }
    videoBlob = null;
    if (elements && elements.video) {
      elements.video.removeAttribute('src');
      elements.video.load();
    }
  }

  // Auto-scroll refs
  let lastScrolledConsoleIndex = -1;
  let lastScrolledNetworkIndex = -1;
  const consoleContainerRef = null;
  const networkContainerRef = null;

  // Recording files from Drive
  let recordingFiles = {
    folderId: null,
    manifest: null,
    videoParts: [],
    metadata: null,
    console: null,
    network: null,
    websocket: null
  };

  // DOM Elements
  const elements = {};

  function initElements() {
    elements.loadingState = document.getElementById('loading-state');
    elements.loadingMessage = document.getElementById('loading-message');
    elements.loadingProgressFill = document.getElementById('loading-progress-fill');
    elements.loadingProgressText = document.getElementById('loading-progress-text');
    elements.loadingProgressList = document.getElementById('loading-progress-list');
    elements.introState = document.getElementById('intro-state');
    elements.errorState = document.getElementById('error-state');
    elements.playerState = document.getElementById('player-state');
    elements.mainLayout = document.querySelector('.main-layout');
    elements.playerTitle = document.getElementById('player-title');

    // Video elements
    elements.videoSection = document.getElementById('video-section');
    elements.video = document.getElementById('video-player');
    elements.playPauseBtn = document.getElementById('play-pause-btn');
    elements.playIcon = document.getElementById('play-icon');
    elements.pauseIcon = document.getElementById('pause-icon');
    elements.currentTime = document.getElementById('current-time');
    elements.totalDuration = document.getElementById('total-duration');
    elements.progressWrapper = document.getElementById('progress-wrapper');
    elements.bufferedBar = document.getElementById('buffered-bar');
    elements.playedBar = document.getElementById('played-bar');
    elements.markersContainer = document.getElementById('markers-container');
    elements.progressHandle = document.getElementById('progress-handle');
    elements.tooltip = document.getElementById('tooltip');
    elements.speedBtn = document.getElementById('speed-btn');
    elements.speedMenu = document.getElementById('speed-menu');
    elements.muteBtn = document.getElementById('mute-btn');
    elements.volumeOn = document.getElementById('volume-on');
    elements.volumeOff = document.getElementById('volume-off');
    elements.volumeSlider = document.getElementById('volume-slider');
    elements.layoutHorizontalBtn = document.getElementById('layout-horizontal-btn');
    elements.layoutVerticalBtn = document.getElementById('layout-vertical-btn');
    elements.videoFullscreenBtn = document.getElementById('video-fullscreen-btn');
    elements.fullscreenEnterIcon = document.getElementById('fullscreen-enter-icon');
    elements.fullscreenExitIcon = document.getElementById('fullscreen-exit-icon');
    elements.layoutSplitter = document.getElementById('layout-splitter');
    elements.logsPanel = document.getElementById('logs-panel');

    // Header info
    elements.recordingDuration = document.getElementById('recording-duration');
    elements.errorMessage = document.getElementById('error-message');

    // Tabs
    elements.consoleTab = document.getElementById('console-tab');
    elements.networkTab = document.getElementById('network-tab');
    elements.consoleViewer = document.getElementById('console-viewer');
    elements.networkViewer = document.getElementById('network-viewer');

    // Console
    elements.consoleFilters = document.getElementById('console-filters');
    elements.consoleSearch = document.getElementById('console-search');
    elements.consoleEntries = document.getElementById('console-entries');

    // Network
    elements.networkFilters = document.getElementById('network-filters');
    elements.networkSearch = document.getElementById('network-search');
    elements.networkSummary = document.getElementById('network-summary');
    elements.networkRows = document.getElementById('network-rows');
    elements.websocketSection = document.getElementById('websocket-section');
    elements.websocketRows = document.getElementById('websocket-rows');
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
      splitPercent: DEFAULT_SPLIT_PERCENT[DEFAULT_LAYOUT_MODE]
    };

    try {
      const raw = window.localStorage.getItem(PLAYER_LAYOUT_STORAGE_KEY);
      if (!raw) {
        return fallback;
      }

      const parsed = JSON.parse(raw);
      const mode = parsed?.mode === 'vertical' ? 'vertical' : DEFAULT_LAYOUT_MODE;
      const defaultPercent = DEFAULT_SPLIT_PERCENT[mode];
      return {
        mode,
        splitPercent: clampSplitPercent(parsed?.splitPercent ?? defaultPercent)
      };
    } catch (error) {
      console.warn('[GN Tracing Player] Failed to load layout state:', error);
      return fallback;
    }
  }

  function saveLayoutState() {
    try {
      window.localStorage.setItem(PLAYER_LAYOUT_STORAGE_KEY, JSON.stringify(layoutState));
    } catch (error) {
      console.warn('[GN Tracing Player] Failed to persist layout state:', error);
    }
  }

  function updateFullscreenButton() {
    elements.videoFullscreenBtn.classList.toggle('active', isVideoFullscreen);
    elements.fullscreenEnterIcon.classList.toggle('hidden', isVideoFullscreen);
    elements.fullscreenExitIcon.classList.toggle('hidden', !isVideoFullscreen);
    elements.videoFullscreenBtn.title = isVideoFullscreen ? 'Exit expanded video' : 'Expand video in tab';
    elements.videoFullscreenBtn.setAttribute('aria-pressed', String(isVideoFullscreen));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
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
    const uploadedBytes = progressEntries
      .reduce((sum, entry) => sum + (entry.total > 0 ? Math.min(entry.loaded, entry.total) : 0), 0);
    const videoLoadedBytes = progressEntries
      .filter(entry => entry.group === 'video')
      .reduce((sum, entry) => sum + (entry.total > 0 ? Math.min(entry.loaded, entry.total) : 0), 0);
    const videoKnownTotalBytes = progressEntries
      .filter(entry => entry.group === 'video')
      .reduce((sum, entry) => sum + entry.total, 0);
    const otherTotalBytes = progressEntries
      .filter(entry => entry.group !== 'video')
      .reduce((sum, entry) => sum + entry.total, 0);
    const totalBytes = Math.max(videoKnownTotalBytes, expectedVideoBytes, videoLoadedBytes) + otherTotalBytes;
    const percent = totalBytes > 0 ? Math.max(0, Math.min(100, (uploadedBytes / totalBytes) * 100)) : 0;

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
      elements.loadingProgressList.innerHTML = progressEntries.map((entry) => {
        const entryPercent = entry.total > 0
          ? `${Math.max(0, Math.min(100, (Math.min(entry.loaded, entry.total) / entry.total) * 100)).toFixed(1)}%`
          : '—';
        return `
          <div class="loading-progress-item">
            <div class="loading-progress-item-header">
              <span class="loading-progress-item-label">${entry.label}</span>
              <span class="loading-progress-item-status">${entry.status}</span>
            </div>
            <div class="loading-progress-item-meta">
              <span>${entryPercent}</span>
              <span>${formatBytes(entry.loaded)} / ${formatBytes(entry.total)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  function resetLoadingProgress(message = 'Loading recording...') {
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

  function updateLoadingEntry(key, { loaded = 0, total = 0, group = 'other', label, status, message } = {}) {
    const previous = loadingProgressEntries.get(key) || {
      loaded: 0,
      total: 0,
      group,
      label: label || key,
      status: 'Queued'
    };
    loadingProgressEntries.set(key, {
      loaded: Math.max(0, loaded),
      total: Math.max(0, total || previous.total || 0),
      group,
      label: label || previous.label || key,
      status: status || previous.status || 'Queued',
    });
    if (message) {
      loadingProgressMessage = message;
    }
    renderLoadingProgress();
  }

  function registerLoadingEntry(key, label, group, status = 'Queued') {
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
      status: 'Loaded'
    });
  }

  function createLoadingProgressReporter(key, group, label) {
    return ({ loaded, total }) => {
      updateLoadingEntry(key, { loaded, total, group, label, status: 'Loading' });
    };
  }

  function applyLayoutState() {
    const mode = layoutState.mode === 'vertical' ? 'vertical' : 'horizontal';
    const splitPercent = clampSplitPercent(layoutState.splitPercent);
    layoutState = { mode, splitPercent };

    elements.playerState.dataset.layoutMode = mode;
    elements.playerState.style.setProperty('--player-split-percent', String(splitPercent));
    elements.layoutSplitter.setAttribute('aria-orientation', mode === 'vertical' ? 'horizontal' : 'vertical');
    elements.layoutHorizontalBtn.classList.toggle('active', mode === 'horizontal');
    elements.layoutVerticalBtn.classList.toggle('active', mode === 'vertical');
    elements.layoutHorizontalBtn.setAttribute('aria-pressed', String(mode === 'horizontal'));
    elements.layoutVerticalBtn.setAttribute('aria-pressed', String(mode === 'vertical'));
    elements.playerState.classList.toggle('is-video-fullscreen', isVideoFullscreen);
    updateFullscreenButton();
  }

  function setLayoutMode(mode) {
    const nextMode = mode === 'vertical' ? 'vertical' : 'horizontal';
    layoutState.mode = nextMode;
    layoutState.splitPercent = clampSplitPercent(layoutState.splitPercent || DEFAULT_SPLIT_PERCENT[nextMode]);
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
    const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const sec = String(totalSec % 60).padStart(2, '0');
    return `${min}:${sec}`;
  }

  function formatTimeMs(ms) {
    const safeMs = Math.max(0, ms);
    const totalSec = Math.floor(safeMs / 1000);
    const millis = String(Math.floor(safeMs % 1000)).padStart(3, '0');
    const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const sec = String(totalSec % 60).padStart(2, '0');
    return `${min}:${sec}.${millis}`;
  }

  function getFilterLevel(entry) {
    if (entry.source === 'exception') return 'exception';
    if (entry.source === 'browser') return 'browser';
    return getConsoleLevel(entry);
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncateUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname + u.search;
      return p.length > 60 ? p.slice(0, 60) + '...' : p;
    } catch {
      return url && url.length > 60 ? url.slice(0, 60) + '...' : url;
    }
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function getRecordingTitleLabel(meta) {
    if (!meta || typeof meta !== 'object') {
      return '';
    }

    const parts = [];
    const rawUrl = typeof meta.url === 'string' ? meta.url : '';
    const recordedAt = meta.startTime || meta.timestamp;

    if (rawUrl) {
      try {
        const url = new URL(rawUrl);
        parts.push(url.hostname.replace(/^www\./, ''));

        const segments = url.pathname.split('/').filter(Boolean);
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
        parts.push(date.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }));
      }
    }

    return parts.filter(Boolean).join(' • ');
  }

  function updatePlayerTitle(meta) {
    const label = getRecordingTitleLabel(meta);
    const visibleTitle = label ? `GN Tracing - ${label}` : 'GN Tracing';

    if (elements.playerTitle) {
      elements.playerTitle.textContent = visibleTitle;
      elements.playerTitle.title = label || DEFAULT_PLAYER_TITLE;
    }

    document.title = label ? `${label} | ${DEFAULT_PLAYER_TITLE}` : DEFAULT_PLAYER_TITLE;
  }

  function detectNetworkFilterFromUrlAndMime(url, mimeType) {
    const normalizedMimeType = String(mimeType || '').toLowerCase();

    if (normalizedMimeType.includes('json')) return 'fetch';
    if (normalizedMimeType.includes('javascript') || normalizedMimeType.includes('ecmascript')) return 'js';
    if (normalizedMimeType.includes('css')) return 'css';
    if (normalizedMimeType.includes('html')) return 'doc';
    if (normalizedMimeType.startsWith('image/')) return 'img';
    if (normalizedMimeType.startsWith('font/')) return 'font';
    if (normalizedMimeType.startsWith('audio/') || normalizedMimeType.startsWith('video/')) return 'media';

    try {
      const pathname = new URL(url || '', 'http://x').pathname.toLowerCase();
      const dot = pathname.lastIndexOf('.');
      if (dot !== -1) {
        const ext = pathname.slice(dot);
        const extMap = {
          '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.map': 'js',
          '.css': 'css',
          '.png': 'img', '.jpg': 'img', '.jpeg': 'img', '.gif': 'img', '.svg': 'img', '.webp': 'img', '.ico': 'img', '.avif': 'img', '.bmp': 'img',
          '.woff': 'font', '.woff2': 'font', '.ttf': 'font', '.eot': 'font', '.otf': 'font',
          '.mp4': 'media', '.webm': 'media', '.mp3': 'media', '.ogg': 'media', '.wav': 'media',
          '.html': 'doc', '.htm': 'doc', '.php': 'doc', '.asp': 'doc', '.aspx': 'doc', '.jsp': 'doc',
        };
        if (extMap[ext]) return extMap[ext];
      }
    } catch {}

    return null;
  }

  function getNetworkFilterType(entry) {
    const resourceType = String(entry.resourceType || '').trim();
    const normalizedResourceType = resourceType.toLowerCase();
    const url = (entry.request && entry.request.url) || entry.url || '';
    const mimeType = (entry.response && entry.response.mimeType) || entry.mimeType || '';

    if (normalizedResourceType === 'xhr' || normalizedResourceType === 'fetch') {
      const detectedType = detectNetworkFilterFromUrlAndMime(url, mimeType);
      if (detectedType && detectedType !== 'doc') return detectedType;
      return 'fetch';
    }

    const typeMap = {
      script: 'js',
      stylesheet: 'css',
      image: 'img',
      document: 'doc',
      font: 'font',
      media: 'media',
      texttrack: 'media',
      websocket: 'ws',
      xhr: 'fetch',
      fetch: 'fetch',
      preflight: 'fetch',
      prefetch: 'fetch',
      eventsource: 'fetch',
      manifest: 'doc',
      signedexchange: 'doc',
      ping: 'other',
      cspviolationreport: 'other',
      fedcm: 'other',
      other: 'other',
    };

    if (typeMap[normalizedResourceType]) {
      return typeMap[normalizedResourceType];
    }

    const detectedType = detectNetworkFilterFromUrlAndMime(url, mimeType);
    if (detectedType) return detectedType;

    return 'other';
  }

  function getConsoleLevel(entry) {
    if (entry.source === 'exception') return 'error';
    if (entry.source === 'browser') return entry.level || 'info';
    return entry.level || 'log';
  }

  function getConsoleLevelLabel(entry) {
    if (entry.source === 'exception') return 'EXCEPTION';
    if (entry.source === 'browser') return 'BROWSER';
    return (entry.level || 'log').toUpperCase();
  }

  function getStatusColorClass(status) {
    if (!status) return 'other';
    if (status >= 200 && status < 300) return 'success';
    if (status >= 300 && status < 400) return 'redirect';
    return 'error';
  }

  function normalizeSearchQuery(value) {
    return String(value || '').trim().toLowerCase();
  }

  function stringifyForSearch(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(stringifyForSearch).join(' ');
    if (typeof value === 'object') {
      if (typeof value.value === 'string') return value.value;
      if (typeof value.description === 'string') return value.description;
      if (typeof value.text === 'string') return value.text;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function getConsoleSearchText(entry) {
    const parts = [
      entry.source,
      entry.level,
      entry.message,
      entry.url,
      entry.originalSource,
      renderArgs(entry),
      ...(entry.args || []).map(stringifyForSearch),
      ...((entry.stackTrace || []).flatMap(frame => [
        frame.asyncBoundary,
        frame.functionName,
        frame.originalName,
        frame.url,
        frame.originalSource,
      ])),
    ];

    return normalizeSearchQuery(parts.filter(Boolean).join(' '));
  }

  function getNetworkSearchText(entry) {
    const request = entry.request || {};
    const response = entry.response || {};
    const content = getNetworkResponseContent(entry);
    const initiator = entry.initiator || {};

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
      stringifyForSearch(initiator.stack),
    ];

    return normalizeSearchQuery(parts.filter(Boolean).join(' '));
  }

  function getWsSearchText(ws) {
    const frames = Array.isArray(ws.frames) ? ws.frames : [];
    const frameText = frames.map(frame => stringifyForSearch(frame.payloadData || frame.text || frame.opcode)).join(' ');
    return normalizeSearchQuery([ws.url, ws.closed ? 'closed' : 'open', frameText].join(' '));
  }

  function getVisibleConsoleEntries() {
    const consoleQuery = normalizeSearchQuery(consoleSearchQuery);

    return consoleLogs
      .map((entry, i) => ({
        entry,
        index: i,
        level: getConsoleLevel(entry),
        filterLevel: getFilterLevel(entry),
        searchText: getConsoleSearchText(entry),
      }))
      .filter((pe) => pe.entry.relativeMs <= currentTimeMs)
      .filter((pe) => activeConsoleFilter === 'all' || pe.filterLevel === activeConsoleFilter)
      .filter((pe) => !consoleQuery || pe.searchText.includes(consoleQuery));
  }

  function getVisibleNetworkEntries() {
    const networkQuery = normalizeSearchQuery(networkSearchQuery);

    return networkLogs
      .map((entry, i) => ({
        entry,
        index: i,
        filterType: getNetworkFilterType(entry),
        searchText: getNetworkSearchText(entry),
      }))
      .filter((pe) => pe.entry.relativeMs <= currentTimeMs)
      .filter((pe) => activeNetworkFilter === 'all' || pe.filterType === activeNetworkFilter)
      .filter((pe) => !networkQuery || pe.searchText.includes(networkQuery));
  }

  function getVisibleWebSocketEntries() {
    const networkQuery = normalizeSearchQuery(networkSearchQuery);

    return webSocketLogs
      .map((ws, index) => ({
        ws,
        index,
        searchText: getWsSearchText(ws),
      }))
      .filter(() => activeNetworkFilter === 'all' || activeNetworkFilter === 'ws')
      .filter((item) => !networkQuery || item.searchText.includes(networkQuery));
  }

  // Render remote object to HTML
  function renderRemoteObject(obj) {
    if (!obj) return '<span class="gh-secondary">undefined</span>';

    switch (obj.type) {
      case 'undefined':
        return '<span class="gh-secondary">undefined</span>';
      case 'boolean':
        return `<span class="gh-blue-num">${obj.value}</span>`;
      case 'number':
        return `<span class="gh-blue-num">${obj.description || obj.value}</span>`;
      case 'bigint':
        return `<span class="gh-blue-num">${obj.description || obj.value}n</span>`;
      case 'string':
        return `<span class="gh-blue-str">"${escapeHtml(obj.value != null ? String(obj.value) : obj.description || '')}"</span>`;
      case 'symbol':
        return `<span class="gh-purple">${escapeHtml(obj.description || 'Symbol()')}</span>`;
      case 'function':
        return `<span class="gh-purple italic">f ${escapeHtml(obj.description || 'anonymous')}</span>`;
      case 'object':
        return renderObjectPreview(obj);
      default:
        return escapeHtml(obj.description || String(obj.value));
    }
  }

  function renderObjectPreview(obj) {
    if (obj.subtype === 'null') return '<span class="gh-secondary">null</span>';
    if (obj.subtype === 'error') return `<span class="gh-error">${escapeHtml(obj.description || 'Error')}</span>`;
    if (obj.subtype === 'regexp') return `<span class="gh-orange">${escapeHtml(obj.description || '')}</span>`;
    if (obj.subtype === 'date') return `<span class="gh-blue-str">${escapeHtml(obj.description || '')}</span>`;
    if (obj.preview) return renderPreview(obj.preview);
    return `<span class="gh-secondary">${escapeHtml(obj.description || obj.className || 'Object')}</span>`;
  }

  function renderPreview(preview) {
    if (!preview.properties || preview.properties.length === 0) {
      if (preview.subtype === 'array') return '[]';
      return '{}';
    }

    const isArray = preview.subtype === 'array';
    const open = isArray ? '[' : '{';
    const close = isArray ? ']' : '}';

    const props = preview.properties.map(p => {
      const val = renderPreviewValue(p);
      if (isArray) return val;
      return `<span class="gh-purple">${escapeHtml(p.name)}</span>: ${val}`;
    }).join(', ');

    const overflow = preview.overflow ? ', ...' : '';
    return `${open}${props}${overflow}${close}`;
  }

  function renderPreviewValue(prop) {
    if (prop.valuePreview) return renderPreview(prop.valuePreview);

    switch (prop.type) {
      case 'string':
        return `<span class="gh-blue-str">"${escapeHtml(prop.value || '')}"</span>`;
      case 'number':
      case 'bigint':
        return `<span class="gh-blue-num">${prop.value}</span>`;
      case 'boolean':
        return `<span class="gh-blue-num">${prop.value}</span>`;
      case 'undefined':
        return '<span class="gh-secondary">undefined</span>';
      case 'function':
        return '<span class="gh-purple italic">f</span>';
      case 'object':
        if (prop.subtype === 'null') return '<span class="gh-secondary">null</span>';
        return `<span class="gh-secondary">${escapeHtml(prop.value || 'Object')}</span>`;
      default:
        return escapeHtml(prop.value || '');
    }
  }

  function renderArgs(entry) {
    // Handle new format with entry.source
    if (entry.source !== undefined) {
      if (entry.source === 'exception' || entry.source === 'browser') {
        const msg = entry.message || '';
        const firstStackLine = msg.search(/\n\s+at /);
        const displayMsg = firstStackLine >= 0 ? msg.substring(0, firstStackLine) : msg;
        return escapeHtml(displayMsg);
      }
      if (!Array.isArray(entry.args)) return String(entry.args || '');
      return entry.args.map(arg => renderRemoteObject(arg)).join(' ');
    }

    // Old format
    if (!Array.isArray(entry.args)) return escapeHtml(String(entry.args));
    return entry.args.map(arg => {
      if (arg === null) return 'null';
      if (arg === undefined || arg === 'undefined') return 'undefined';
      if (typeof arg === 'object') {
        if (arg.type === 'Error') {
          return escapeHtml(`${arg.message || ''}\n${arg.stack || ''}`);
        }
        try {
          return escapeHtml(JSON.stringify(arg));
        } catch {
          return String(arg);
        }
      }
      return escapeHtml(String(arg));
    }).join(' ');
  }

  function formatHeaders(headers) {
    if (!headers) return '(none)';
    if (Array.isArray(headers)) {
      return headers.map(h => `${h.name}: ${h.value}`).join('\n');
    }
    if (typeof headers === 'object') {
      return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    }
    return String(headers);
  }

  function getNetworkResponseContent(entry) {
    const response = entry.response || {};
    const content = response.content || {};
    const responseBody = entry.responseBody || null;

    return {
      mimeType: content.mimeType || response.mimeType || entry.mimeType || '',
      size: content.size ?? entry.encodedDataLength ?? 0,
      text: content.text ?? responseBody?.body ?? '',
      encoding: content.encoding || (responseBody?.base64Encoded ? 'base64' : undefined),
    };
  }

  function decodeBase64Text(value) {
    if (!value) return null;

    try {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  function getUrlPathname(url) {
    try {
      return new URL(url, 'https://example.invalid').pathname || '';
    } catch {
      return '';
    }
  }

  function detectResponseBodyKind(entry, content) {
    const mimeType = String(content.mimeType || '').toLowerCase();
    const pathname = getUrlPathname((entry.request || {}).url || entry.url || '').toLowerCase();

    if (mimeType.includes('json') || pathname.endsWith('.json')) return 'json';
    if (mimeType.includes('javascript') || mimeType.includes('ecmascript') || pathname.endsWith('.js') || pathname.endsWith('.mjs') || pathname.endsWith('.cjs')) return 'js';
    if (mimeType.includes('html') || pathname.endsWith('.html') || pathname.endsWith('.htm')) return 'html';
    if (mimeType.includes('css') || pathname.endsWith('.css')) return 'css';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'text';
  }

  function getResponseBodyText(entry, content) {
    if (!content.text) return '';
    if (content.encoding === 'base64') {
      const detectedKind = detectResponseBodyKind(entry, content);
      if (detectedKind === 'json' || detectedKind === 'js' || detectedKind === 'html' || detectedKind === 'css' || String(content.mimeType || '').startsWith('text/')) {
        return decodeBase64Text(content.text) || '';
      }
      return '';
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

  function highlightJson(text) {
    const source = formatJsonPreview(text);
    return tokenizeWithPattern(
      source,
      /("(?:\\.|[^"\\])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      (token, match) => {
        if (/^"/.test(token)) return match[2] ? 'token-key' : 'token-string';
        if (token === 'true' || token === 'false') return 'token-boolean';
        if (token === 'null') return 'token-null';
        return 'token-number';
      }
    );
  }

  function tokenizeWithPattern(text, pattern, classifyToken) {
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const [token] = match;
      result += escapeHtml(text.slice(lastIndex, match.index));
      const cls = classifyToken(token, match);
      result += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
      lastIndex = match.index + token.length;
    }

    result += escapeHtml(text.slice(lastIndex));
    pattern.lastIndex = 0;
    return result;
  }

  function highlightJavascript(text) {
    const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:await|async|break|case|catch|class|const|continue|default|delete|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|null|return|super|switch|this|throw|true|false|try|typeof|var|while|yield)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g;
    return tokenizeWithPattern(text, pattern, (token) => {
      if (token.startsWith('//') || token.startsWith('/*')) return 'token-comment';
      if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return 'token-string';
      if (/^-?\d/.test(token)) return 'token-number';
      return 'token-keyword';
    });
  }

  function highlightCss(text) {
    const pattern = /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[a-z-]+|\.[\w-]+|#[\w-]+|-?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg)?|#[0-9a-fA-F]{3,8})/g;
    return tokenizeWithPattern(text, pattern, (token) => {
      if (token.startsWith('/*')) return 'token-comment';
      if (token.startsWith('"') || token.startsWith("'")) return 'token-string';
      if (token.startsWith('@')) return 'token-keyword';
      if (token.startsWith('.') || token.startsWith('#')) return token.length > 1 && /^[#.][\w-]+$/.test(token) ? 'token-selector' : 'token-number';
      return 'token-number';
    });
  }

  function highlightHtmlTag(tag) {
    const trimmedTag = tag.replace(/^</, '').replace(/>$/, '');
    const isClosing = trimmedTag.startsWith('/');
    const tagNameMatch = trimmedTag.match(/^\/?([^\s/>]+)/);
    const tagName = tagNameMatch ? tagNameMatch[1] : '';
    let result = '&lt;';

    if (isClosing) {
      result += '/';
    }

    if (tagName) {
      result += `<span class="token-tag">${escapeHtml(tagName)}</span>`;
    }

    const attrSource = trimmedTag.slice(tagNameMatch ? tagNameMatch[0].length : 0);
    const attrPattern = /(\s+)([\w:-]+)(?:\s*=\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s"'=<>`]+))?/g;
    let lastIndex = 0;
    let match;

    while ((match = attrPattern.exec(attrSource)) !== null) {
      result += escapeHtml(attrSource.slice(lastIndex, match.index));
      result += escapeHtml(match[1]);
      result += `<span class="token-attr">${escapeHtml(match[2])}</span>`;
      if (match[3]) {
        result += '<span class="token-operator">=</span>';
        result += `<span class="token-string">${escapeHtml(match[3])}</span>`;
      }
      lastIndex = match.index + match[0].length;
    }

    result += escapeHtml(attrSource.slice(lastIndex));
    if (tag.endsWith('/>')) {
      result += '/';
    }
    result += '&gt;';
    return result;
  }

  function highlightHtml(text) {
    const pattern = /<!--[\s\S]*?-->|<\/?[\w:-]+(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      result += escapeHtml(text.slice(lastIndex, match.index));
      const token = match[0];
      if (token.startsWith('<!--')) {
        result += `<span class="token-comment">${escapeHtml(token)}</span>`;
      } else {
        result += highlightHtmlTag(token);
      }
      lastIndex = match.index + token.length;
    }

    result += escapeHtml(text.slice(lastIndex));
    pattern.lastIndex = 0;
    return result;
  }

  function highlightResponseText(kind, text) {
    if (!text) return '';
    if (kind === 'json') return highlightJson(text);
    if (kind === 'js') return highlightJavascript(text);
    if (kind === 'html') return highlightHtml(text);
    if (kind === 'css') return highlightCss(text);
    return escapeHtml(text);
  }

  function buildJsonPreview(text) {
    const formatted = formatJsonPreview(text);
    let summaryHtml = '';

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const entries = Array.isArray(parsed)
          ? parsed.slice(0, 6).map((value, index) => [`[${index}]`, value])
          : Object.entries(parsed).slice(0, 6);

        summaryHtml = `
          <div class="json-preview-summary">
            ${entries.map(([key, value]) => `
              <div class="json-preview-item">
                <span class="json-preview-key">${escapeHtml(String(key))}</span>
                <span class="json-preview-value">${escapeHtml(stringifyForSearch(value).slice(0, 120) || '(empty)')}</span>
              </div>
            `).join('')}
          </div>
        `;
      }
    } catch {}

    return `
      <div class="response-preview-card response-preview-json">
        ${summaryHtml}
        <pre class="response-code-block">${highlightJson(formatted.slice(0, MAX_RESPONSE_PREVIEW_CHARS))}${formatted.length > MAX_RESPONSE_PREVIEW_CHARS ? '\n<span class="token-comment">...(truncated)</span>' : ''}</pre>
      </div>
    `;
  }

  function buildResponsePreview(entry, content) {
    const kind = detectResponseBodyKind(entry, content);
    const responseText = getResponseBodyText(entry, content);
    const mimeType = String(content.mimeType || '').toLowerCase();

    if (kind === 'html' && responseText) {
      const previewHtml = responseText.slice(0, MAX_RESPONSE_PREVIEW_CHARS);
      return `
        <div class="response-preview-card response-preview-html">
          <iframe class="response-preview-frame" sandbox="" srcdoc="${escapeHtml(previewHtml)}"></iframe>
        </div>
      `;
    }

    if ((kind === 'image' || kind === 'audio' || kind === 'video') && content.encoding === 'base64' && content.text) {
      const dataUrl = buildPreviewDataUrl(mimeType || 'application/octet-stream', content.text);
      if (!dataUrl) return '';
      if (kind === 'image') {
        return `
          <div class="response-preview-card response-preview-media">
            <img class="response-preview-image" src="${escapeHtml(dataUrl)}" alt="Response preview">
          </div>
        `;
      }
      if (kind === 'audio') {
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

    if (kind === 'json' && responseText) {
      return buildJsonPreview(responseText);
    }

    return '';
  }

  function buildResponseBodySection(entry, content) {
    const kind = detectResponseBodyKind(entry, content);
    const responseText = getResponseBodyText(entry, content);
    const isBinary = content.encoding === 'base64' && !responseText;

    if (!content.text) {
      return '';
    }

    if (isBinary) {
      return `
        <div class="detail-section">
          <h4>Response Body</h4>
          <pre class="response-body binary">(binary data)</pre>
        </div>
      `;
    }

    const displayText = kind === 'json' ? formatJsonPreview(responseText) : responseText;
    const truncatedText = displayText.slice(0, MAX_RESPONSE_DISPLAY_CHARS);
    const highlighted = highlightResponseText(kind, truncatedText);
    const truncatedSuffix = displayText.length > MAX_RESPONSE_DISPLAY_CHARS
      ? '\n<span class="token-comment">...(truncated)</span>'
      : '';

    return `
      <div class="detail-section">
        <h4>Response Body</h4>
        <pre class="response-body response-code-block">${highlighted}${truncatedSuffix}</pre>
      </div>
    `;
  }

  function getNetworkDetailTabKey(entry) {
    return entry.requestId || entry.url || String(entry.timestamp || '');
  }

  function getActiveNetworkDetailTab(entry, hasPreview, hasBody) {
    const key = getNetworkDetailTabKey(entry);
    const savedTab = networkDetailTabs.get(key);

    if (savedTab === 'preview' && hasPreview) return 'preview';
    if (savedTab === 'body' && hasBody) return 'body';
    if (hasPreview) return 'preview';
    if (hasBody) return 'body';
    return null;
  }

  function buildResponseTabs(entry, previewHtml, responseBodyHtml) {
    const hasPreview = Boolean(previewHtml);
    const hasBody = Boolean(responseBodyHtml);
    const activeTab = getActiveNetworkDetailTab(entry, hasPreview, hasBody);

    if (!activeTab) {
      return '';
    }

    return `
      <div class="detail-section">
        <div class="network-detail-tabs" role="tablist" aria-label="Response detail tabs">
          ${hasPreview ? `
            <button
              class="network-detail-tab ${activeTab === 'preview' ? 'active' : ''}"
              type="button"
              role="tab"
              aria-selected="${activeTab === 'preview'}"
              data-tab="preview"
            >
              Response Preview
            </button>
          ` : ''}
          ${hasBody ? `
            <button
              class="network-detail-tab ${activeTab === 'body' ? 'active' : ''}"
              type="button"
              role="tab"
              aria-selected="${activeTab === 'body'}"
              data-tab="body"
            >
              Response Body
            </button>
          ` : ''}
        </div>
        ${hasPreview ? `
          <div
            class="network-detail-panel ${activeTab === 'preview' ? 'active' : 'hidden'}"
            role="tabpanel"
            data-panel="preview"
          >
            ${previewHtml}
          </div>
        ` : ''}
        ${hasBody ? `
          <div
            class="network-detail-panel ${activeTab === 'body' ? 'active' : 'hidden'}"
            role="tabpanel"
            data-panel="body"
          >
            ${responseBodyHtml}
          </div>
        ` : ''}
      </div>
    `;
  }

  // Google Drive API functions
  // Check if external adapter is available (set by standalone mode)
  const DRIVE_ADAPTER = window.GN_DRIVE_ADAPTER || null;
  function getDownloadUrl(fileId) {
    if (IS_STANDALONE && DRIVE_ADAPTER) {
      return `/api/drive?id=${encodeURIComponent(fileId)}`;
    }

    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
  }

  async function downloadFile(fileId, options = {}) {
    const response = await fetch(getDownloadUrl(fileId));

    if (!response.ok) {
      throw new Error(`Failed to download file ${fileId}`);
    }

    if (!options.onProgress || !response.body) {
      const blob = await response.blob();
      options.onProgress?.({ loaded: blob.size, total: blob.size });
      return new Response(blob, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers)
      });
    }

    const reader = response.body.getReader();
    const chunks = [];
    const total = Number(response.headers.get('content-length')) || 0;
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
      type: response.headers.get('content-type') || 'application/octet-stream'
    });
    options.onProgress?.({ loaded: blob.size, total: blob.size });

    return new Response(blob, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers)
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

  function buildDirectRecordingFiles(urlParams) {
    const parseFileId = value => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed ? { id: trimmed } : null;
    };

    const videoParts = (urlParams.get('videos') || '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(id => ({ id }));

    const resolved = {
      folderId: null,
      manifest: null,
      metadata: parseFileId(urlParams.get('metadata')),
      console: parseFileId(urlParams.get('console')),
      network: parseFileId(urlParams.get('network')),
      websocket: parseFileId(urlParams.get('websocket')),
      videoParts
    };

    if (!resolved.metadata || resolved.videoParts.length === 0) {
      throw new Error('Invalid or missing recording parameters. Please provide videos and metadata file IDs.');
    }

    return resolved;
  }

  async function downloadCombinedBlob(files, mimeType) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('No video parts found');
    }

    files.forEach((file, index) => {
      registerLoadingEntry(`video:${index}`, `video.part-${String(index).padStart(3, '0')}.webm`, 'video');
    });
    const blobs = await Promise.all(files.map((file, index) =>
      downloadFileAsBlob(
        file.id,
        {
          onProgress: createLoadingProgressReporter(
            `video:${index}`,
            'video',
            `video.part-${String(index).padStart(3, '0')}.webm`
          )
        }
      ).then((blob) => {
        updateLoadingEntry(`video:${index}`, {
          loaded: blob.size,
          total: blob.size,
          group: 'video',
          label: `video.part-${String(index).padStart(3, '0')}.webm`,
          status: 'Loaded'
        });
        return blob;
      })
    ));

    const combinedType = mimeType || blobs[0]?.type || 'video/webm';
    return new Blob(blobs, { type: combinedType });
  }

  async function loadRecordingFromFiles() {
    try {
      await loadRecordingData();
    } catch (err) {
      console.error('Failed to load recording:', err);
      elements.errorMessage.textContent = err.message || 'Failed to load recording';
      showError();
    }
  }

  async function loadRecordingData() {
    try {
      resetLoadingProgress('Loading recording...');
      registerLoadingEntry('metadata', 'metadata.json', 'other');
      if (recordingFiles.console) {
        registerLoadingEntry('console', 'console.json', 'other');
      }
      if (recordingFiles.network) {
        registerLoadingEntry('network', 'network.json', 'other');
      }
      if (recordingFiles.websocket) {
        registerLoadingEntry('websocket', 'websocket.json', 'other');
      }

      // Load metadata first (needed for processing other data)
      const metadataJson = await downloadFileAsJson(
        recordingFiles.metadata.id,
        {
          onProgress: createLoadingProgressReporter('metadata', 'other', 'metadata.json')
        }
      );
      markLoadingEntryLoaded('metadata', 'metadata.json', 'other');
      metadata = metadataJson.metadata || metadataJson;
      startTime = metadata.startTime || new Date(metadata.timestamp || '').getTime();
      duration = metadata.duration || 0;
      updatePlayerTitle(metadata);
      setExpectedVideoBytes(metadata.video?.totalBytes || 0);
      const videoMimeType = recordingFiles.manifest?.video?.mimeType || metadata.video?.mimeType || 'video/webm';

      // Load video, console, network, websocket in parallel
      await Promise.all([
        // Load video
        recordingFiles.videoParts.length ? downloadCombinedBlob(recordingFiles.videoParts, videoMimeType).then(blob => {
          releaseVideoResources();
          videoBlob = blob;
          videoUrl = URL.createObjectURL(blob);
          elements.video.src = videoUrl;
        }) : Promise.resolve(),

        // Load console logs
        recordingFiles.console ? downloadFileAsJson(
        recordingFiles.console.id,
        {
          onProgress: createLoadingProgressReporter('console', 'other', 'console.json')
        }
      ).then(consoleJson => {
          markLoadingEntryLoaded('console', 'console.json', 'other');
          const rawEntries = Array.isArray(consoleJson)
            ? consoleJson
            : (consoleJson.logs || consoleJson.data || []);
          consoleLogs = rawEntries.map(entry => ({
            ...entry,
            relativeMs: (entry.timestamp || 0) - startTime
          })).sort((a, b) => a.relativeMs - b.relativeMs);
        }) : Promise.resolve(),

        // Load network logs
        recordingFiles.network ? downloadFileAsJson(
        recordingFiles.network.id,
        {
          onProgress: createLoadingProgressReporter('network', 'other', 'network.json')
        }
      ).then(networkJson => {
          markLoadingEntryLoaded('network', 'network.json', 'other');
          const rawEntries = Array.isArray(networkJson)
            ? networkJson
            : (networkJson.log?.entries || networkJson.entries || networkJson.data || []);

          networkLogs = rawEntries.map(entry => {
            if (entry.method && entry.url && entry.requestId) {
              return {
                ...entry,
                relativeMs: (entry.wallTime ? entry.wallTime * 1000 : entry.timestamp * 1000) - startTime
              };
            }
            const request = entry.request || {};
            const response = entry.response || {};
            const content = response.content || {};
            const timings = entry.timings || {};

            const reqHeadersArray = request.headers || [];
            const resHeadersArray = response.headers || [];
            const reqHeaders = Array.isArray(reqHeadersArray)
              ? Object.fromEntries(reqHeadersArray.map(h => [h.name, h.value]))
              : reqHeadersArray;
            const resHeaders = Array.isArray(resHeadersArray)
              ? Object.fromEntries(resHeadersArray.map(h => [h.name, h.value]))
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
              requestId: entry._requestId || '',
              method: request.method || 'GET',
              url: request.url || '',
              requestHeaders: reqHeaders || null,
              postData: request.postData?.text || null,
              timestamp: entry.wallTime ? entry.wallTime * 1000 : (entry.timestamp || 0),
              wallTime: entry.wallTime || null,
              initiator: entry.initiator || null,
              resourceType: entry.resourceType || '',
              status: response.status || 0,
              statusText: response.statusText || null,
              responseHeaders: resHeaders || null,
              mimeType: content.mimeType || null,
              timing,
              protocol: null,
              remoteIPAddress: entry.serverIPAddress || null,
              encodedDataLength: content.size || 0,
              error: entry.error || null,
              responseBody: content.text ? { body: content.text, base64Encoded: !!content.encoding } : null,
              redirectChain: entry.redirectChain || null,
              relativeMs: (entry.wallTime ? entry.wallTime * 1000 : (entry.timestamp || 0)) - startTime,
            };
          }).sort((a, b) => a.relativeMs - b.relativeMs);
        }) : Promise.resolve(),

        // Load WebSocket logs
        recordingFiles.websocket ? downloadFileAsJson(
        recordingFiles.websocket.id,
        {
          onProgress: createLoadingProgressReporter('websocket', 'other', 'websocket.json')
        }
      ).then(wsJson => {
          markLoadingEntryLoaded('websocket', 'websocket.json', 'other');
          webSocketLogs = Array.isArray(wsJson) ? wsJson : (wsJson.data || wsJson.logs || []);
        }) : Promise.resolve(),
      ]);

      // Update UI
      elements.recordingDuration.textContent = formatTime(duration);
      setLoadingMessage('Loading recording...');

      showPlayer();
    } catch (err) {
      console.error('Failed to load recording:', err);
      elements.errorMessage.textContent = err.message || 'Failed to load recording';
      showError();
    }
  }

  // State management
  function showLoading() {
    resetLoadingProgress('Loading recording...');
    elements.loadingState.classList.remove('hidden');
    elements.introState.classList.add('hidden');
    elements.errorState.classList.add('hidden');
    elements.playerState.classList.add('hidden');
  }

  function showIntro() {
    resetLoadingProgress();
    updatePlayerTitle();
    elements.loadingState.classList.add('hidden');
    elements.introState.classList.remove('hidden');
    elements.errorState.classList.add('hidden');
    elements.playerState.classList.add('hidden');
  }

  function showError() {
    elements.loadingState.classList.add('hidden');
    elements.introState.classList.add('hidden');
    elements.errorState.classList.remove('hidden');
    elements.playerState.classList.add('hidden');
  }

  function showPlayer() {
    elements.loadingState.classList.add('hidden');
    elements.introState.classList.add('hidden');
    elements.errorState.classList.add('hidden');
    elements.playerState.classList.remove('hidden');

    renderConsoleEntries();
    renderNetworkEntries();
    renderMarkers();
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

    const filtered = visible;

    const lastVisibleIndex = filtered.length > 0 ? filtered[filtered.length - 1].index : -1;

    // Level color map
    const levelColorClass = {
      log: 'console-level-log',
      warn: 'console-level-warn',
      error: 'console-level-error',
      info: 'console-level-info',
      debug: 'console-level-debug',
      exception: 'console-level-error',
      browser: 'console-level-info',
    };

    elements.consoleEntries.innerHTML = filtered.map((pe, vi) => {
      const { entry, index, level } = pe;
      const isActive = index === closestIdx;
      const isExpanded = expandedConsoleIndex === index;
      const isLast = vi === filtered.length - 1;
      const timeStr = formatTimeMs(entry.relativeMs);
      const levelLabel = getConsoleLevelLabel(entry);

      let rowClass = 'console-entry';
      if (entry.source === 'exception') rowClass += ' error-entry';
      if (entry.source === 'browser') rowClass += ' browser-entry';
      if (isActive) rowClass += ' active-entry';
      if (isExpanded) rowClass += ' expanded';

      // Source location for exception/browser
      const sourceLocation = (entry.source === 'exception' || entry.source === 'browser') && (entry.originalSource || entry.url)
        ? `<span class="console-source-location">${entry.originalSource
            ? `${entry.originalSource}:${(entry.originalLine ?? 0) + 1}:${(entry.originalColumn ?? 0) + 1}`
            : `${entry.url}:${(entry.lineNumber ?? 0) + 1}:${(entry.columnNumber ?? 0) + 1}`}</span>`
        : '';

      return `
        <div class="${rowClass}" data-index="${index}" ref="${isLast ? 'last' : ''}">
          <button class="toggle-expand" aria-label="Toggle details"><i class="ph ${isExpanded ? 'ph-caret-down' : 'ph-caret-right'}"></i></button>
          <span class="console-time">${timeStr}</span>
          <span class="console-level console-level-${level}">${levelLabel}</span>
          <span class="console-message">
            <span>${renderArgs(entry)}</span>
            ${sourceLocation}
          </span>
          ${isExpanded ? renderConsoleDetail(entry) : ''}
        </div>
      `;
    }).join('');

    // Auto-scroll to last visible entry
    if (lastVisibleIndex !== lastScrolledConsoleIndex) {
      lastScrolledConsoleIndex = lastVisibleIndex;
      const lastEl = elements.consoleEntries.querySelector('[ref="last"]');
      if (lastEl) {
        lastEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      }
    }

    // Add click listeners for toggle buttons
    elements.consoleEntries.querySelectorAll('.toggle-expand').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(el.closest('.console-entry').dataset.index);
        expandedConsoleIndex = expandedConsoleIndex === index ? null : index;
        renderConsoleEntries();
      });
    });

  }

  function renderConsoleDetail(entry) {
    const levelLabel = getConsoleLevelLabel(entry);
    const sourceLabel = entry.source ? ` (${entry.source})` : '';
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
    if (entry.source !== 'exception' && entry.source !== 'browser' && Array.isArray(entry.args)) {
      detailHtml += `
        <div class="detail-section">
          <h4>Arguments</h4>
          ${entry.args.map((arg, i) => `
            <div class="arg-row">
              <span class="arg-index">[${i}]</span>
              <span>${renderRemoteObject(arg)}</span>
            </div>
          `).join('')}
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
    if (entry.originalSource || entry.url) {
      detailHtml += `
        <div class="detail-section">
          <h4>Source</h4>
          <pre>${entry.originalSource
            ? `${entry.originalSource}:${(entry.originalLine ?? 0) + 1}:${(entry.originalColumn ?? 0) + 1}`
            : `${entry.url}:${(entry.lineNumber ?? 0) + 1}:${(entry.columnNumber ?? 0) + 1}`}</pre>
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
          detailHtml += `<div class="async-boundary">--- ${frame.asyncBoundary} ---</div>`;
        } else {
          const fnName = frame.originalName || frame.functionName || '(anonymous)';
          const location = frame.originalSource
            ? `${frame.originalSource}:${(frame.originalLine ?? 0) + 1}:${(frame.originalColumn ?? 0) + 1}`
            : frame.url
              ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}`
              : '';
          const src = frame.originalSource || frame.url || '';
          const isVendor = src && src.includes('node_modules');
          detailHtml += `<div class="stack-frame ${isVendor ? 'vendor-frame' : ''}">at <span class="fn-name">${escapeHtml(fnName)}</span>${location ? ` <span class="location">(${location})</span>` : ''}</div>`;
        }
      });
      detailHtml += `</div></div>`;
    }

    detailHtml += '</div>';
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

    const lastVisibleIndex = filtered.length > 0 ? filtered[filtered.length - 1].index : -1;
    const visibleCount = filtered.length;
    const visibleWs = getVisibleWebSocketEntries();

    // Summary text
    let summaryText = `${visibleCount}/${networkLogs.length} requests`;
    if (activeNetworkFilter !== 'all') summaryText += ` (${activeNetworkFilter})`;
    if (networkSearchQuery) summaryText += ` | search`;
    if (webSocketLogs.length > 0) summaryText += ` | ${visibleWs.length}/${webSocketLogs.length} WS`;
    elements.networkSummary.textContent = summaryText;

    elements.networkRows.innerHTML = filtered.map((pe, vi) => {
      const { entry, index } = pe;
      const request = entry.request || {};
      const response = entry.response || {};
      const content = getNetworkResponseContent(entry);
      const isActive = index === closestIdx;
      const isExpanded = expandedNetworkIndex === index;
      const isLast = vi === filtered.length - 1;
      const statusCode = response.status || entry.status || 0;
      const statusClass = getStatusColorClass(statusCode);

      let rowClass = 'network-row';
      if (isActive) rowClass += ' active-row';
      if (isExpanded) rowClass += ' expanded';

      return `
        <div class="${rowClass}" data-index="${index}" ref="${isLast ? 'last' : ''}">
          <button class="toggle-expand" aria-label="Toggle details"><i class="ph ${isExpanded ? 'ph-caret-down' : 'ph-caret-right'}"></i></button>
          <span class="col-method">${request.method || entry.method || 'GET'}</span>
          <span class="col-url" title="${escapeHtml(request.url || entry.url || '')}">${truncateUrl(request.url || entry.url || '')}</span>
          <span class="col-status ${statusClass}">${statusCode || (entry.error ? 'ERR' : '-')}</span>
          <span class="col-type">${entry.resourceType || content.mimeType || '-'}</span>
          <span class="col-size">${formatSize(content.size || entry.encodedDataLength)}</span>
          ${isExpanded ? renderNetworkDetail(entry) : ''}
        </div>
      `;
    }).join('');

    // Auto-scroll to last visible entry
    if (lastVisibleIndex !== lastScrolledNetworkIndex) {
      lastScrolledNetworkIndex = lastVisibleIndex;
      const lastEl = elements.networkRows.querySelector('[ref="last"]');
      if (lastEl) {
        lastEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      }
    }

    // Add click listeners for toggle buttons
    elements.networkRows.querySelectorAll('.toggle-expand').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(el.closest('.network-row').dataset.index);
        expandedNetworkIndex = expandedNetworkIndex === index ? null : index;
        renderNetworkEntries();
      });
    });

    // WebSocket entries
    if (visibleWs.length > 0) {
      elements.websocketSection.classList.remove('hidden');
      elements.websocketRows.innerHTML = visibleWs.map(({ ws, index }) => {
        const isExpanded = expandedWsIndex === index;
        return `
          <div class="ws-row ${isExpanded ? 'expanded' : ''}" data-index="${index}">
            <button class="toggle-expand" aria-label="Toggle details"><i class="ph ${isExpanded ? 'ph-caret-down' : 'ph-caret-right'}"></i></button>
            <span class="ws-url" title="${escapeHtml(ws.url || '')}">${escapeHtml(ws.url || '')}</span>
            <span class="ws-frames">${(ws.frames || []).length} frames</span>
            <span class="ws-status ${ws.closed ? 'closed' : 'open'}">${ws.closed ? 'Closed' : 'Open'}</span>
            ${isExpanded ? renderWsDetail(ws) : ''}
          </div>
        `;
      }).join('');

      elements.websocketRows.querySelectorAll('.toggle-expand').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const index = parseInt(el.closest('.ws-row').dataset.index);
          expandedWsIndex = expandedWsIndex === index ? null : index;
          renderNetworkEntries();
        });
      });
    } else {
      elements.websocketSection.classList.add('hidden');
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
            <span class="redirect-url">${escapeHtml(request.url || entry.url || '')}</span>
          </div>
        </div></div>
      `;
    }

    // URL
    detailHtml += `
      <div class="detail-section">
        <h4>URL</h4>
        <pre>${escapeHtml(request.url || entry.url || '')}</pre>
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
    const postData = typeof request.postData === 'object' ? request.postData?.text : request.postData || entry.postData;
    if (postData) {
      detailHtml += `
        <div class="detail-section">
          <h4>Request Body</h4>
          <pre>${escapeHtml(postData)}</pre>
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
          detailHtml += `<span class="timing-item">${key}: <strong>${typeof val === 'number' ? val.toFixed(1) + 'ms' : val}</strong></span>`;
        }
      });
      detailHtml += `</div></div>`;
    }

    // Initiator
    if (entry.initiator) {
      detailHtml += `
        <div class="detail-section">
          <h4>Initiator</h4>
          <pre>${entry.initiator.type || 'other'}</pre>
      `;
      if (entry.initiator.originalSource || entry.initiator.url) {
        const loc = entry.initiator.originalSource
          ? `${entry.initiator.originalSource}:${(entry.initiator.originalLine ?? 0) + 1}:${(entry.initiator.originalColumn ?? 0) + 1}`
          : `${entry.initiator.url}:${(entry.initiator.lineNumber ?? 0) + 1}:${(entry.initiator.columnNumber ?? 0) + 1}`;
        detailHtml += `<pre class="initiator-location">${escapeHtml(loc)}</pre>`;
      }
      if (entry.initiator.stack && entry.initiator.stack.callFrames) {
        detailHtml += '<div class="initiator-stack">';
        entry.initiator.stack.callFrames.forEach((frame, i) => {
          const fnName = frame.originalName || frame.functionName || '(anonymous)';
          const location = frame.originalSource
            ? `${frame.originalSource}:${(frame.originalLine ?? 0) + 1}:${(frame.originalColumn ?? 0) + 1}`
            : frame.url
              ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}`
              : '';
          const src = frame.originalSource || frame.url || '';
          const isVendor = src && src.includes('node_modules');
          detailHtml += `<div class="stack-frame ${isVendor ? 'vendor-frame' : ''}">at <span class="fn-name">${escapeHtml(fnName)}</span>${location ? ` <span class="location">(${location})</span>` : ''}</div>`;
        });
        if (entry.initiator.stack.parent) {
          detailHtml += `<div class="async-boundary">--- ${entry.initiator.stack.parent.description || 'async'} ---</div>`;
        }
        detailHtml += '</div>';
      }
      detailHtml += '</div>';
    }

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
        ${content.text ? `
          <button class="copy-btn" data-action="copy-response">Copy Response</button>
          <button class="copy-btn" data-action="copy-all">Copy cURL + Response</button>
        ` : ''}
      </div>
    `;

    detailHtml += '</div>';
    return detailHtml;
  }

  function renderWsDetail(ws) {
    const frames = ws.frames || [];
    const maxFrames = 100;

    return `
      <div class="ws-detail">
        <div>
          <h4>URL</h4>
          <pre>${escapeHtml(ws.url || '')}</pre>
        </div>
        <div>
          <h4>Frames (${frames.length})</h4>
          <div class="ws-frames-table">
            ${frames.slice(0, maxFrames).map(f => {
              const dir = f.direction === 'sent' ? '&uarr;' : '&darr;';
              const dirClass = f.direction === 'sent' ? 'sent' : 'received';
              const data = f.payloadData || '';
              const truncated = data.length > 200 ? data.slice(0, 200) + '...' : data;
              return `
                <div class="ws-frame-row">
                  <span class="ws-direction ${dirClass}">${dir}</span>
                  <span class="ws-payload">${escapeHtml(truncated)}</span>
                </div>
              `;
            }).join('')}
            ${frames.length > maxFrames ? `
              <div class="ws-frame-row">
                <span></span>
                <span class="ws-payload">... ${frames.length - maxFrames} more frames</span>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // Render timeline markers
  function renderMarkers() {
    const markers = [];

    // Error markers from console
    consoleLogs.forEach(entry => {
      if (entry.source === 'exception' || getConsoleLevel(entry) === 'error') {
        markers.push({
          timeMs: entry.relativeMs,
          color: '#f85149',
          label: `Error: ${(entry.message || '').slice(0, 80)}`
        });
      }
    });

    // Network markers
    networkLogs.forEach(entry => {
      const url = entry.url || '';
      const method = entry.method || 'GET';
      markers.push({
        timeMs: entry.relativeMs,
        color: '#58a6ff',
        label: `${method} ${url}`.slice(0, 80)
      });
    });

    // Render markers
    elements.markersContainer.innerHTML = markers.map(marker => {
      const pct = duration > 0 ? (marker.timeMs / duration) * 100 : 0;
      if (pct < 0 || pct > 100) return '';
      return `<div class="marker" style="left: ${pct}%; background-color: ${marker.color};" title="${escapeHtml(marker.label)}"></div>`;
    }).join('');
  }

  function getSplitPercentFromPointer(clientX, clientY) {
    const rect = elements.mainLayout.getBoundingClientRect();
    if (layoutState.mode === 'vertical') {
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
      elements.playerState.classList.remove('is-resizing');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    elements.layoutHorizontalBtn.addEventListener('click', () => setLayoutMode('horizontal'));
    elements.layoutVerticalBtn.addEventListener('click', () => setLayoutMode('vertical'));
    elements.videoFullscreenBtn.addEventListener('click', toggleVideoFullscreen);

    elements.layoutSplitter.addEventListener('pointerdown', (event) => {
      activePointerId = event.pointerId;
      elements.layoutSplitter.setPointerCapture(event.pointerId);
      elements.playerState.classList.add('is-resizing');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = layoutState.mode === 'vertical' ? 'row-resize' : 'col-resize';
      setSplitPercent(getSplitPercentFromPointer(event.clientX, event.clientY), false);
      event.preventDefault();
    });

    elements.layoutSplitter.addEventListener('pointermove', (event) => {
      if (event.pointerId !== activePointerId) {
        return;
      }
      setSplitPercent(getSplitPercentFromPointer(event.clientX, event.clientY), false);
    });

    elements.layoutSplitter.addEventListener('pointerup', (event) => {
      if (event.pointerId !== activePointerId) {
        return;
      }
      setSplitPercent(layoutState.splitPercent, true);
      stopResizing();
    });

    elements.layoutSplitter.addEventListener('pointercancel', stopResizing);

    elements.layoutSplitter.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 5 : 2;
      if (layoutState.mode === 'horizontal' && event.key === 'ArrowLeft') {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent - step);
      } else if (layoutState.mode === 'horizontal' && event.key === 'ArrowRight') {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent + step);
      } else if (layoutState.mode === 'vertical' && event.key === 'ArrowUp') {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent - step);
      } else if (layoutState.mode === 'vertical' && event.key === 'ArrowDown') {
        event.preventDefault();
        setSplitPercent(layoutState.splitPercent + step);
      }
    });

    window.addEventListener('blur', stopResizing);
  }

  // Video event handlers
  function setupVideoListeners() {
    let isDragging = false;
    let lastEmitTime = 0;

    // Play/Pause toggle
    elements.video.addEventListener('click', togglePlayPause);
    elements.playPauseBtn.addEventListener('click', togglePlayPause);

    // Time update
    elements.video.addEventListener('timeupdate', () => {
      const now = performance.now();
      if (now - lastEmitTime < 250) return;
      lastEmitTime = now;

      currentTimeMs = elements.video.currentTime * 1000;
      updateProgress();
      renderConsoleEntries();
      renderNetworkEntries();
    });

    // Loaded metadata
    elements.video.addEventListener('loadedmetadata', () => {
      elements.totalDuration.textContent = formatTime(elements.video.duration * 1000);
      duration = elements.video.duration * 1000;
      renderMarkers();
    });

    // Play/Pause state changes
    elements.video.addEventListener('play', () => {
      elements.playIcon.classList.add('hidden');
      elements.pauseIcon.classList.remove('hidden');
    });

    elements.video.addEventListener('pause', () => {
      elements.playIcon.classList.remove('hidden');
      elements.pauseIcon.classList.add('hidden');
    });

    elements.video.addEventListener('ended', () => {
      elements.playIcon.classList.remove('hidden');
      elements.pauseIcon.classList.add('hidden');
    });

    // Progress bar interaction
    elements.progressWrapper.addEventListener('mousedown', (e) => {
      isDragging = true;
      seekToRatio(getMouseRatio(e.clientX));
    });

    elements.progressWrapper.addEventListener('touchstart', (e) => {
      isDragging = true;
      if (e.touches[0]) {
        seekToRatio(getMouseRatio(e.touches[0].clientX));
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        seekToRatio(getMouseRatio(e.clientX));
      }

      // Tooltip on hover
      const rect = elements.progressWrapper.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const ratio = (e.clientX - rect.left) / rect.width;
        const time = ratio * duration;
        elements.tooltip.textContent = formatTime(time);
        elements.tooltip.style.left = `${e.clientX - rect.left}px`;
        elements.tooltip.classList.remove('hidden');
      } else {
        elements.tooltip.classList.add('hidden');
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    document.addEventListener('touchmove', (e) => {
      if (isDragging && e.touches[0]) {
        seekToRatio(getMouseRatio(e.touches[0].clientX));
      }
    });

    document.addEventListener('touchend', () => {
      isDragging = false;
    });

    // Speed control
    elements.speedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.speedMenu.classList.toggle('hidden');
    });

    elements.speedMenu.querySelectorAll('.speed-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        elements.video.playbackRate = speed;
        elements.speedBtn.textContent = `${speed}x`;
        elements.speedMenu.classList.add('hidden');
      });
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.speed-control')) {
        elements.speedMenu.classList.add('hidden');
      }
    });

    // Volume control
    elements.muteBtn.addEventListener('click', () => {
      elements.video.muted = !elements.video.muted;
      updateVolumeDisplay();
    });

    elements.volumeSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      elements.video.volume = val;
      elements.video.muted = false;
      updateVolumeDisplay();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlayPause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          elements.video.currentTime = Math.max(0, elements.video.currentTime - (e.shiftKey ? 10 : 5));
          break;
        case 'ArrowRight':
          e.preventDefault();
          elements.video.currentTime = elements.video.currentTime + (e.shiftKey ? 10 : 5);
          break;
        case 'Digit1':
          elements.video.playbackRate = 0.5;
          elements.speedBtn.textContent = '0.5x';
          break;
        case 'Digit2':
          elements.video.playbackRate = 1;
          elements.speedBtn.textContent = '1x';
          break;
        case 'Digit3':
          elements.video.playbackRate = 1.5;
          elements.speedBtn.textContent = '1.5x';
          break;
        case 'Digit4':
          elements.video.playbackRate = 2;
          elements.speedBtn.textContent = '2x';
          break;
        case 'KeyF':
          e.preventDefault();
          toggleVideoFullscreen();
          break;
        case 'Escape':
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
    elements.video.currentTime = ratio * duration / 1000;
    currentTimeMs = elements.video.currentTime * 1000;
    updateProgress();
    renderConsoleEntries();
    renderNetworkEntries();
  }

  function updateProgress() {
    const ratio = duration > 0 ? (currentTimeMs / duration) * 100 : 0;
    elements.playedBar.style.width = `${ratio}%`;
    elements.progressHandle.style.left = `${ratio}%`;
    elements.currentTime.textContent = formatTime(currentTimeMs);

    // Buffered
    if (elements.video.buffered.length > 0) {
      const bufferedEnd = elements.video.buffered.end(elements.video.buffered.length - 1);
      const dur = elements.video.duration;
      const bufferedRatio = dur > 0 ? (bufferedEnd / dur) * 100 : 0;
      elements.bufferedBar.style.width = `${bufferedRatio}%`;
    }
  }

  function updateVolumeDisplay() {
    if (elements.video.muted || elements.video.volume === 0) {
      elements.volumeOn.classList.add('hidden');
      elements.volumeOff.classList.remove('hidden');
    } else {
      elements.volumeOn.classList.remove('hidden');
      elements.volumeOff.classList.add('hidden');
      elements.volumeSlider.value = elements.video.volume;
    }
  }

  // Filter handlers
  function setupFilterListeners() {
    // Console filters
    elements.consoleFilters.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        elements.consoleFilters.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeConsoleFilter = btn.dataset.filter;
        renderConsoleEntries();
      });
    });

    // Network filters
    elements.networkFilters.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        elements.networkFilters.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeNetworkFilter = btn.dataset.filter;
        renderNetworkEntries();
      });
    });

    elements.consoleSearch.addEventListener('input', () => {
      consoleSearchQuery = elements.consoleSearch.value || '';
      renderConsoleEntries();
    });

    elements.networkSearch.addEventListener('input', () => {
      networkSearchQuery = elements.networkSearch.value || '';
      renderNetworkEntries();
    });
  }

  // Tab handlers
  function setupTabListeners() {
    elements.consoleTab.addEventListener('click', () => {
      elements.consoleTab.classList.add('active');
      elements.networkTab.classList.remove('active');
      elements.consoleViewer.classList.remove('hidden');
      elements.networkViewer.classList.add('hidden');
    });

    elements.networkTab.addEventListener('click', () => {
      elements.networkTab.classList.add('active');
      elements.consoleTab.classList.remove('active');
      elements.networkViewer.classList.remove('hidden');
      elements.consoleViewer.classList.add('hidden');
    });
  }

  // Copy cURL functionality
  function generateCurl(entry) {
    const request = entry.request || {};
    const url = request.url || entry.url || '';
    const method = request.method || entry.method || 'GET';
    const parts = [`curl '${url.replace(/'/g, "'\\''")}'`];

    if (method !== 'GET') parts.push(`-X ${method}`);

    const headers = request.headers || entry.requestHeaders;
    if (headers) {
      const headerList = Array.isArray(headers)
        ? headers
        : Object.entries(headers).map(([name, value]) => ({ name, value }));
      for (const h of headerList) {
        parts.push(`-H '${h.name}: ${String(h.value).replace(/'/g, "'\\''")}'`);
      }
    }

    const postData = typeof request.postData === 'object'
      ? request.postData?.text
      : request.postData || entry.postData;
    if (postData) {
      parts.push(`--data-raw '${postData.replace(/'/g, "'\\''")}'`);
    }

    return parts.join(' \\\n  ');
  }

  function setupCopyListeners() {
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('copy-btn')) {
        const action = e.target.dataset.action;
        const row = e.target.closest('.network-row');
        if (row) {
          const index = parseInt(row.dataset.index);
          const entry = networkLogs[index];

          if (entry) {
            let text = '';
            const content = getNetworkResponseContent(entry);
            if (action === 'copy-curl') {
              text = generateCurl(entry);
            } else if (action === 'copy-response') {
              text = getResponseBodyText(entry, content) || content.text || '';
            } else if (action === 'copy-all') {
              const curl = generateCurl(entry);
              text = curl + '\n\n--- Response ---\n\n' + (getResponseBodyText(entry, content) || content.text || '');
            }

            navigator.clipboard.writeText(text).then(() => {
              const originalText = e.target.textContent;
              e.target.textContent = 'Copied!';
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
    document.addEventListener('click', (e) => {
      const tab = e.target.closest('.network-detail-tab');
      if (!tab) return;

      const row = tab.closest('.network-row');
      if (!row) return;

      const index = parseInt(row.dataset.index);
      const entry = networkLogs[index];
      const targetTab = tab.dataset.tab;
      if (!entry || !targetTab) return;

      networkDetailTabs.set(getNetworkDetailTabKey(entry), targetTab);
      renderNetworkEntries();
    });
  }

  // Initialize
  async function init() {
    initElements();
    applyLayoutState();
    updateVolumeDisplay();
    document.title = DEFAULT_PLAYER_TITLE;
    window.addEventListener('unload', releaseVideoResources);
    setupLayoutListeners();
    setupVideoListeners();
    setupFilterListeners();
    setupTabListeners();
    setupCopyListeners();
    setupNetworkDetailTabListeners();

    const urlParams = new URLSearchParams(window.location.search);
    const videos = urlParams.get('videos');
    const metadataFileId = urlParams.get('metadata');
    const hasParams = Array.from(urlParams.keys()).length > 0;

    if (videos && metadataFileId) {
      recordingFiles = buildDirectRecordingFiles(urlParams);
      await loadRecordingFromFiles();
    } else if (!hasParams) {
      console.info('[GN Tracing Player] Showing intro state without replay params:', GITHUB_REPO_URL);
      showIntro();
    } else {
      elements.errorMessage.textContent = 'Invalid or missing recording parameters. Please provide videos and metadata file IDs.';
      showError();
    }
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

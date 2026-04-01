/**
 * GN Web Tracing Player
 * Loads recording data from Google Drive and displays video synchronized with logs
 */

(function() {
  'use strict';

  // Google Drive configuration
  const DRIVE_API = 'https://www.googleapis.com/drive/v3';
  const DRIVE_FILES_API = 'https://www.googleapis.com/upload/drive/v3';

  // State
  let authToken = null;
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
  let expandedConsoleIndex = null;
  let expandedNetworkIndex = null;
  let expandedWsIndex = null;
  let closestConsoleIndex = -1;
  let closestNetworkIndex = -1;

  // Auto-scroll refs
  let lastScrolledConsoleIndex = -1;
  let lastScrolledNetworkIndex = -1;
  const consoleContainerRef = null;
  const networkContainerRef = null;

  // Recording files from Drive
  let recordingFiles = {
    video: null,
    metadata: null,
    console: null,
    network: null,
    websocket: null
  };

  // DOM Elements
  const elements = {};

  function initElements() {
    elements.loadingState = document.getElementById('loading-state');
    elements.errorState = document.getElementById('error-state');
    elements.playerState = document.getElementById('player-state');

    // Video elements
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

    // Header info
    elements.recordingUrl = document.getElementById('recording-url');
    elements.recordingDuration = document.getElementById('recording-duration');
    elements.errorMessage = document.getElementById('error-message');

    // Tabs
    elements.consoleTab = document.getElementById('console-tab');
    elements.networkTab = document.getElementById('network-tab');
    elements.consoleViewer = document.getElementById('console-viewer');
    elements.networkViewer = document.getElementById('network-viewer');

    // Console
    elements.consoleFilters = document.getElementById('console-filters');
    elements.consoleEntries = document.getElementById('console-entries');

    // Network
    elements.networkFilters = document.getElementById('network-filters');
    elements.networkSummary = document.getElementById('network-summary');
    elements.networkRows = document.getElementById('network-rows');
    elements.websocketSection = document.getElementById('websocket-section');
    elements.websocketRows = document.getElementById('websocket-rows');
  }

  // Utility functions
  function formatTime(ms) {
    const totalSec = Math.floor(Math.max(0, ms) / 1000);
    const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const sec = String(totalSec % 60).padStart(2, '0');
    return `${min}:${sec}`;
  }

  function formatTimeMs(ms) {
    const totalSec = Math.floor(Math.max(0, ms) / 1000);
    const millis = String(Math.floor(ms % 1000)).padStart(3, '0');
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

  function getNetworkFilterType(entry) {
    const resourceType = entry.resourceType || '';
    if (resourceType === 'XHR' || resourceType === 'Fetch') {
      const url = (entry.request && entry.request.url) || entry.url || '';
      try {
        const pathname = new URL(url, 'http://x').pathname;
        const dot = pathname.lastIndexOf('.');
        if (dot !== -1) {
          const ext = pathname.slice(dot).toLowerCase();
          const extMap = {
            '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.map': 'js',
            '.css': 'css',
            '.png': 'img', '.jpg': 'img', '.jpeg': 'img', '.gif': 'img', '.svg': 'img', '.webp': 'img', '.ico': 'img', '.avif': 'img',
            '.woff': 'font', '.woff2': 'font', '.ttf': 'font', '.eot': 'font', '.otf': 'font',
            '.mp4': 'media', '.webm': 'media', '.mp3': 'media', '.ogg': 'media', '.wav': 'media',
            '.html': 'doc', '.htm': 'doc',
          };
          if (extMap[ext]) return extMap[ext];
        }
      } catch {}
      return 'fetch';
    }
    const typeMap = {
      'Script': 'js',
      'Stylesheet': 'css',
      'Image': 'img',
      'Document': 'doc',
      'Font': 'font',
      'Media': 'media',
      'WebSocket': 'ws',
    };
    for (const [filterKey, types] of Object.entries(typeMap)) {
      if (types.includes(resourceType)) return filterKey;
    }
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

  // Google Drive API functions
  async function getAuthToken() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'GOOGLE_DRIVE_STATUS' }, (response) => {
        if (response && response.ok && response.isConnected) {
          chrome.runtime.sendMessage({ action: 'GET_GOOGLE_DRIVE_TOKEN' }, (tokenResponse) => {
            resolve(tokenResponse && tokenResponse.ok ? tokenResponse.token : null);
          });
        } else {
          resolve(null);
        }
      });
    });
  }

  async function downloadFile(fileId) {
    const url = `${DRIVE_API}/files/${fileId}?alt=media`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download file ${fileId}`);
    }

    return response;
  }

  async function downloadFileAsJson(fileId) {
    const response = await downloadFile(fileId);
    return response.json();
  }

  async function downloadFileAsBlob(fileId) {
    const response = await downloadFile(fileId);
    return response.blob();
  }

  async function loadRecordingFromFiles() {
    try {
      // Get auth token from extension
      authToken = await getAuthToken();
      if (!authToken) {
        // Try to load without auth - files may be publicly shared
        console.warn('No auth token available, attempting to load publicly shared files');
      }

      await loadRecordingData();
    } catch (err) {
      console.error('Failed to load recording:', err);
      elements.errorMessage.textContent = err.message || 'Failed to load recording';
      showError();
    }
  }

  async function loadRecordingData() {
    try {
      // Load metadata
      const metadataJson = await downloadFileAsJson(recordingFiles.metadata.id);
      metadata = metadataJson.metadata || metadataJson;
      startTime = metadata.startTime || new Date(metadata.timestamp || '').getTime();
      duration = metadata.duration || 0;

      // Load video
      if (recordingFiles.video) {
        videoBlob = await downloadFileAsBlob(recordingFiles.video.id);
        videoUrl = URL.createObjectURL(videoBlob);
        elements.video.src = videoUrl;
      }

      // Load console logs
      if (recordingFiles.console) {
        const consoleJson = await downloadFileAsJson(recordingFiles.console.id);
        const rawEntries = Array.isArray(consoleJson)
          ? consoleJson
          : (consoleJson.logs || consoleJson.data || []);

        consoleLogs = rawEntries.map(entry => ({
          ...entry,
          relativeMs: (entry.timestamp || 0) - startTime
        })).sort((a, b) => a.relativeMs - b.relativeMs);
      }

      // Load network logs
      if (recordingFiles.network) {
        const networkJson = await downloadFileAsJson(recordingFiles.network.id);
        const rawEntries = Array.isArray(networkJson)
          ? networkJson
          : (networkJson.log?.entries || networkJson.entries || networkJson.data || []);

        // Map from HAR format to player format
        networkLogs = rawEntries.map(entry => {
          // If already in flat format (has method at top level), use as-is
          if (entry.method && entry.url && entry.requestId) {
            return {
              ...entry,
              relativeMs: (entry.wallTime ? entry.wallTime * 1000 : entry.timestamp * 1000) - startTime
            };
          }
          // HAR format - need to flatten
          const request = entry.request || {};
          const response = entry.response || {};
          const content = response.content || {};
          const timings = entry.timings || {};

          // Convert headers array to object
          const reqHeadersArray = request.headers || [];
          const resHeadersArray = response.headers || [];
          const reqHeaders = Array.isArray(reqHeadersArray)
            ? Object.fromEntries(reqHeadersArray.map(h => [h.name, h.value]))
            : reqHeadersArray;
          const resHeaders = Array.isArray(resHeadersArray)
            ? Object.fromEntries(resHeadersArray.map(h => [h.name, h.value]))
            : resHeadersArray;

          // Calculate timing from HAR timings
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
      }

      // Load WebSocket logs
      if (recordingFiles.websocket) {
        const wsJson = await downloadFileAsJson(recordingFiles.websocket.id);
        webSocketLogs = Array.isArray(wsJson) ? wsJson : (wsJson.data || wsJson.logs || []);
      }

      // Update UI
      elements.recordingUrl.textContent = metadata.url || 'Recording';
      elements.recordingDuration.textContent = formatTime(duration);

      showPlayer();
    } catch (err) {
      console.error('Failed to load recording:', err);
      elements.errorMessage.textContent = err.message || 'Failed to load recording';
      showError();
    }
  }

  // State management
  function showLoading() {
    elements.loadingState.classList.remove('hidden');
    elements.errorState.classList.add('hidden');
    elements.playerState.classList.add('hidden');
  }

  function showError() {
    elements.loadingState.classList.add('hidden');
    elements.errorState.classList.remove('hidden');
    elements.playerState.classList.add('hidden');
  }

  function showPlayer() {
    elements.loadingState.classList.add('hidden');
    elements.errorState.classList.add('hidden');
    elements.playerState.classList.remove('hidden');

    renderConsoleEntries();
    renderNetworkEntries();
    renderMarkers();
  }

  // Render console entries
  function renderConsoleEntries() {
    const processedEntries = consoleLogs.map((entry, i) => ({
      entry,
      index: i,
      level: getConsoleLevel(entry),
      filterLevel: getFilterLevel(entry),
    }));

    // Find closest entry and visible entries
    let closestIdx = -1;
    let closestDist = Infinity;

    const visible = processedEntries.filter((pe) => {
      const inTime = pe.entry.relativeMs <= currentTimeMs;
      if (!inTime) return false;
      const dist = Math.abs(pe.entry.relativeMs - currentTimeMs);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = pe.index;
      }
      return true;
    });

    // Only highlight if within 1.5s
    if (closestDist >= 1500) closestIdx = -1;
    closestConsoleIndex = closestIdx;

    const filtered = activeConsoleFilter === 'all'
      ? visible
      : visible.filter((pe) => pe.filterLevel === activeConsoleFilter);

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

    // Add click listeners
    elements.consoleEntries.querySelectorAll('.console-entry').forEach(el => {
      el.addEventListener('click', () => {
        const index = parseInt(el.dataset.index);
        expandedConsoleIndex = expandedConsoleIndex === index ? null : index;
        renderConsoleEntries();
      });
    });

    // Prevent clicks on detail section from toggling expand
    elements.consoleEntries.querySelectorAll('.console-detail').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
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
    const processedEntries = networkLogs.map((entry, i) => ({
      entry,
      index: i,
      filterType: getNetworkFilterType(entry),
    }));

    // Find closest entry and visible entries
    let closestIdx = -1;
    let closestDist = Infinity;

    const visible = processedEntries.filter((pe) => {
      const inTime = pe.entry.relativeMs <= currentTimeMs;
      if (!inTime) return false;
      const dist = Math.abs(pe.entry.relativeMs - currentTimeMs);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = pe.index;
      }
      return true;
    });

    // Only highlight if within 1.5s
    if (closestDist >= 1500) closestIdx = -1;
    closestNetworkIndex = closestIdx;

    const filtered = activeNetworkFilter === 'all'
      ? visible
      : visible.filter((pe) => pe.filterType === activeNetworkFilter);

    const lastVisibleIndex = filtered.length > 0 ? filtered[filtered.length - 1].index : -1;
    const visibleCount = filtered.length;

    // Summary text
    let summaryText = `${visibleCount}/${networkLogs.length} requests`;
    if (activeNetworkFilter !== 'all') summaryText += ` (${activeNetworkFilter})`;
    if (webSocketLogs.length > 0) summaryText += ` | ${webSocketLogs.length} WS`;
    elements.networkSummary.textContent = summaryText;

    elements.networkRows.innerHTML = filtered.map((pe, vi) => {
      const { entry, index } = pe;
      const request = entry.request || {};
      const response = entry.response || {};
      const content = response.content || {};
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

    // Add click listeners
    elements.networkRows.querySelectorAll('.network-row').forEach(el => {
      el.addEventListener('click', () => {
        const index = parseInt(el.dataset.index);
        expandedNetworkIndex = expandedNetworkIndex === index ? null : index;
        renderNetworkEntries();
      });
    });

    // Prevent clicks on detail section from toggling expand
    elements.networkRows.querySelectorAll('.network-detail').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });

    // WebSocket entries
    if (webSocketLogs.length > 0) {
      elements.websocketSection.classList.remove('hidden');
      elements.websocketRows.innerHTML = webSocketLogs.map((ws, i) => {
        const isExpanded = expandedWsIndex === i;
        return `
          <div class="ws-row ${isExpanded ? 'expanded' : ''}" data-index="${i}">
            <span class="ws-url" title="${escapeHtml(ws.url || '')}">${escapeHtml(ws.url || '')}</span>
            <span class="ws-frames">${(ws.frames || []).length} frames</span>
            <span class="ws-status ${ws.closed ? 'closed' : 'open'}">${ws.closed ? 'Closed' : 'Open'}</span>
            ${isExpanded ? renderWsDetail(ws) : ''}
          </div>
        `;
      }).join('');

      elements.websocketRows.querySelectorAll('.ws-row').forEach(el => {
        el.addEventListener('click', () => {
          const index = parseInt(el.dataset.index);
          expandedWsIndex = expandedWsIndex === index ? null : index;
          renderNetworkEntries();
        });
      });

      // Prevent clicks on detail section from toggling expand
      elements.websocketRows.querySelectorAll('.ws-detail').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
        });
      });
    } else {
      elements.websocketSection.classList.add('hidden');
    }
  }

  function renderNetworkDetail(entry) {
    const request = entry.request || {};
    const response = entry.response || {};
    const content = response.content || {};
    const timings = entry.timing || {};

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

    // Response Body
    if (content.text) {
      const isBase64 = content.encoding === 'base64';
      let bodyText = content.text || '';
      if (content.mimeType && content.mimeType.includes('json')) {
        try {
          bodyText = JSON.stringify(JSON.parse(bodyText), null, 2);
        } catch {}
      }
      detailHtml += `
        <div class="detail-section">
          <h4>Response Body</h4>
          <pre class="response-body${isBase64 ? ' binary' : ''}">
            ${isBase64 ? '(binary data)' : escapeHtml(bodyText.slice(0, 10240))}${bodyText.length > 10240 ? '\n...(truncated)' : ''}
          </pre>
        </div>
      `;
    }

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
      if (e.clientX >= rect.left && e.clientX <= rect.right) {
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
          const filtered = networkLogs.filter(entry => {
            if (activeNetworkFilter === 'all') return true;
            return getNetworkFilterType(entry) === activeNetworkFilter;
          });
          const visibleFiltered = filtered.filter(entry => entry.relativeMs <= currentTimeMs);
          const entry = visibleFiltered[index];

          if (entry) {
            let text = '';
            if (action === 'copy-curl') {
              text = generateCurl(entry);
            } else if (action === 'copy-response') {
              const content = (entry.response || {}).content || {};
              text = content.text || '';
            } else if (action === 'copy-all') {
              const curl = generateCurl(entry);
              const content = (entry.response || {}).content || {};
              text = curl + '\n\n--- Response ---\n\n' + (content.text || '');
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

  // Initialize
  async function init() {
    initElements();
    setupVideoListeners();
    setupFilterListeners();
    setupTabListeners();
    setupCopyListeners();

    // Check for file IDs in URL params
    const urlParams = new URLSearchParams(window.location.search);
    const videoId = urlParams.get('video');
    const metadataId = urlParams.get('metadata');
    const consoleId = urlParams.get('console');
    const networkId = urlParams.get('network');
    const websocketId = urlParams.get('websocket');

    if (videoId && metadataId) {
      // Load specific recording from file IDs
      recordingFiles = {
        video: { id: videoId },
        metadata: { id: metadataId },
        console: consoleId ? { id: consoleId } : null,
        network: networkId ? { id: networkId } : null,
        websocket: websocketId ? { id: websocketId } : null
      };
      await loadRecordingFromFiles();
    } else {
      // No valid params - show error
      elements.errorMessage.textContent = 'Invalid or missing recording parameters. Please provide video and metadata file IDs.';
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

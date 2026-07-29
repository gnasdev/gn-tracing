/**
 * Manages the full-page settings surface for Drive, package, and capture controls.
 */

import { attachFeedbackPopover, type FeedbackUiController } from "../shared/feedback-ui";
import { attachPageNav } from "../shared/page-nav";
import { getPrivacyProfileSettings, normalizeMaskDomSelectors } from "../shared/privacy-redaction";
import { attachThemeToggle, type ThemeToggleController } from "../shared/theme";
import { attachLanguageSwitch, type UiLanguage } from "../shared/ui-language";
import type { MessageResponse, UploadHistoryEntry, UploadSettings } from "../types/messages";

const DEFAULT_SETTINGS: UploadSettings = {
  activeStorageProvider: "google-drive",
  folderInput: "/gn-tracing",
  folderId: null,
  zipPasswordConfigured: false,
  ...getPrivacyProfileSettings("custom"),
  captureConsole: true,
  captureConsoleArgs: true,
  consolePreviewDepth: "full",
  captureConsoleStacks: "all",
  captureConsoleSourceSnippets: "all",
  maxConsoleEntryBytes: null,
  captureNetwork: true,
  captureRequestHeaders: "full",
  captureResponseHeaders: "full",
  captureRequestBodies: true,
  captureResponseBodies: true,
  captureResponseBodyMode: "eligible",
  maxResponseBodyBytes: null,
  captureRedirectHeaders: "full",
  captureInitiator: "full-stack",
  suppressRecorderInternalRequests: true,
  captureWebSockets: true,
  captureWebSocketFrames: true,
  maxWebSocketFrameBytes: null,
  captureWebSocketInitiator: true,
  captureStorage: true,
  redactStorageValues: true,
  captureDomSnapshots: true,
  redactDomTextContent: true,
  // Instant Replay enable/window are owned by the popup (host-permission UX).
  // Settings must round-trip the stored values so a capture-section save does
  // not silently turn always-on IR off.
  instantReplayEnabled: false,
  instantReplayWindowSeconds: 120,
  instantReplayAllowedDomains: [] as string[],
  captureMode: "cdp",
};

type SettingsLanguage = UiLanguage;

const TRANSLATIONS: Record<SettingsLanguage, Record<string, string>> = {
  en: {
    "topbar.pageTitle": "Settings",
    "nav.settings": "Settings",
    "nav.history": "Upload History",
    "nav.connect": "Manage clouds",
    "theme.system": "System",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "theme.aria": "Theme: {label}",
    "theme.titleSystem": "Theme: {label} (follows OS). Click to cycle System → Light → Dark.",
    "theme.titleFixed": "Theme: {label}. Click to cycle System → Light → Dark.",
    "feedback.button": "Feedback",
    "feedback.sectionAria": "Send feedback",
    "feedback.label": "Feedback",
    "feedback.placeholder": "Describe a bug, idea, or question…",
    "feedback.hint":
      "Creates a public GitHub issue. Includes extension version, browser, OS, and locale only. Do not include secrets or passwords.",
    "feedback.submit": "Submit",
    "feedback.cancel": "Cancel",
    "feedback.sending": "Sending…",
    "feedback.success": "Feedback submitted.",
    "feedback.failed": "Could not submit feedback.",
    "page.title": "Settings",
    "page.lead":
      "Choose what each recording captures before you start a session. Save each section when you finish editing it.",
    "actions.save": "Save Settings",
    "actions.saveSection": "Save section",
    "actions.savingSection": "Saving…",
    "sections.privacyRedaction": "Privacy & Redaction",
    "sections.privacyData": "Data redaction",
    "sections.visualMasking": "Visual masking",
    "sections.capture": "Capture",
    "sections.console": "Console",
    "sections.network": "Network",
    "sections.websocket": "WebSocket",
    "sections.inspector": "Inspector capture",
    "sections.captureMode": "Capture mode",
    "fields.redactSensitiveHeaders.label": "Redact sensitive headers",
    "fields.redactSensitiveQueryParams.label": "Redact sensitive query params",
    "fields.redactRequestBodyFields.label": "Redact request body fields",
    "fields.redactResponseBodyFields.label": "Redact response body fields",
    "fields.redactConsoleValues.label": "Redact console values",
    "fields.redactEventMetadata.label": "Redact event/report metadata",
    "fields.redactWebSocketPayloads.label": "WebSocket payload redaction",
    "fields.maskDomSelectors.label": "DOM selectors to mask",
    "fields.captureConsole.label": "Capture console artifact",
    "fields.captureConsoleArgs.label": "Store console args and previews",
    "fields.consolePreviewDepth.label": "Preview depth",
    "fields.captureConsoleStacks.label": "Stacks",
    "fields.captureConsoleSourceSnippets.label": "Source snippets",
    "fields.maxConsoleEntryBytes.label": "Max entry bytes",
    "fields.captureNetwork.label": "Capture network artifact",
    "fields.captureRequestHeaders.label": "Request headers",
    "fields.captureResponseHeaders.label": "Response headers",
    "fields.captureRequestBodies.label": "Capture request bodies",
    "fields.captureResponseBodyMode.label": "Response bodies",
    "fields.maxResponseBodyBytes.label": "Max response body bytes",
    "fields.captureRedirectHeaders.label": "Redirect headers",
    "fields.captureInitiator.label": "Initiator",
    "fields.suppressRecorderInternalRequests.label": "Suppress recorder internal requests",
    "fields.captureWebSockets.label": "Capture WebSocket artifact",
    "fields.captureWebSocketFrames.label": "Store WebSocket frame payloads",
    "fields.maxWebSocketFrameBytes.label": "Max frame bytes",
    "fields.captureWebSocketInitiator.label": "Store WebSocket initiator",
    "fields.captureStorage.label": "Capture storage snapshots",
    "fields.redactStorageValues.label": "Redact storage values",
    "fields.captureDomSnapshots.label": "Capture DOM snapshots",
    "fields.redactDomTextContent.label": "Redact DOM text content",
    "fields.captureMode.label": "Capture mode",
    "options.captureModeCdp": "CDP (full fidelity, debugger banner)",
    "options.captureModeInPage": "In-page (no banner, lower fidelity)",
    "options.none": "None",
    "options.shallow": "Shallow",
    "options.fullWithinLimit": "Full within limit",
    "options.off": "Off",
    "options.errorsOnly": "Errors only",
    "options.warningsErrors": "Warnings and errors",
    "options.allEntries": "All entries",
    "options.allResolvedEntries": "All resolved entries",
    "options.minimal": "Minimal",
    "options.fullRedacted": "Full redacted",
    "options.sensitiveFields": "Sensitive fields",
    "options.allPayloads": "All payloads",
    "options.textOnly": "Text only",
    "options.textJson": "Text and JSON",
    "options.eligibleText": "All eligible text types",
    "options.locationOnly": "Location only",
    "options.summaryLocation": "Summary location",
    "options.shortStack": "Short stack",
    "options.fullStack": "Full stack",
    "placeholders.noLimit": "No limit",
    "placeholders.maskDomSelectors": "[data-private]\n.customer-email",
    "hints.visualMasking":
      "Selectors are applied before capture when possible. They do not cover canvas, video, or closed shadow DOM.",
    "hints.inspectorCapture":
      "Storage and DOM capture turn on automatically while network/request capture is enabled, and lock to it. They capture more sensitive data (storage, cookies, DOM text) and increase package size. Turn off network capture to disable them, and keep redaction on to mask values that match sensitive patterns.",
    "hints.captureMode":
      "CDP is the default for full-fidelity capture (DevTools-like network, response bodies, real source maps) and may show the chrome.debugger banner. Switch to in-page to avoid the banner; network is then limited to fetch/XHR/WebSocket with no cross-origin response bodies or real source maps.",
    "messages.settingsSaved": "Settings saved.",
    "messages.sectionSaved": "Section saved.",
    "messages.loadFailed": "Failed to load settings",
    "messages.saveFailed": "Failed to save settings",
    "info.buttonLabel": "Explain this field",
    "info.dialogTitleFallback": "Setting help",
  },
  vi: {
    "topbar.pageTitle": "Cài đặt",
    "nav.settings": "Cài đặt",
    "nav.history": "Lịch sử upload",
    "nav.connect": "Quản lý cloud",
    "theme.system": "Hệ thống",
    "theme.light": "Sáng",
    "theme.dark": "Tối",
    "theme.aria": "Giao diện: {label}",
    "theme.titleSystem": "Giao diện: {label} (theo OS). Bấm để chuyển Hệ thống → Sáng → Tối.",
    "theme.titleFixed": "Giao diện: {label}. Bấm để chuyển Hệ thống → Sáng → Tối.",
    "feedback.button": "Góp ý",
    "feedback.sectionAria": "Gửi góp ý",
    "feedback.label": "Góp ý",
    "feedback.placeholder": "Mô tả lỗi, ý tưởng hoặc câu hỏi…",
    "feedback.hint":
      "Tạo issue GitHub công khai. Chỉ kèm version extension, browser, OS và locale. Không gửi mật khẩu hay secret.",
    "feedback.submit": "Gửi",
    "feedback.cancel": "Hủy",
    "feedback.sending": "Đang gửi…",
    "feedback.success": "Đã gửi góp ý.",
    "feedback.failed": "Không gửi được góp ý.",
    "page.title": "Cài đặt",
    "page.lead":
      "Chọn dữ liệu cần capture trước khi bắt đầu phiên ghi. Lưu từng section sau khi chỉnh.",
    "actions.save": "Lưu cài đặt",
    "actions.saveSection": "Lưu section",
    "actions.savingSection": "Đang lưu…",
    "sections.privacyRedaction": "Privacy & Redaction",
    "sections.privacyData": "Che dữ liệu",
    "sections.visualMasking": "Che giao diện",
    "sections.capture": "Capture",
    "sections.console": "Console",
    "sections.network": "Network",
    "sections.websocket": "WebSocket",
    "sections.inspector": "Thu thập inspector",
    "sections.captureMode": "Chế độ capture",
    "fields.redactSensitiveHeaders.label": "Che header nhạy cảm",
    "fields.redactSensitiveQueryParams.label": "Che query param nhạy cảm",
    "fields.redactRequestBodyFields.label": "Che field request body",
    "fields.redactResponseBodyFields.label": "Che field response body",
    "fields.redactConsoleValues.label": "Che giá trị console",
    "fields.redactEventMetadata.label": "Che metadata event/report",
    "fields.redactWebSocketPayloads.label": "Che payload WebSocket",
    "fields.maskDomSelectors.label": "DOM selector cần che",
    "fields.captureConsole.label": "Capture artifact console",
    "fields.captureConsoleArgs.label": "Lưu tham số và preview console",
    "fields.consolePreviewDepth.label": "Độ sâu preview",
    "fields.captureConsoleStacks.label": "Stack",
    "fields.captureConsoleSourceSnippets.label": "Đoạn source",
    "fields.maxConsoleEntryBytes.label": "Byte tối đa mỗi entry",
    "fields.captureNetwork.label": "Capture artifact network",
    "fields.captureRequestHeaders.label": "Request headers",
    "fields.captureResponseHeaders.label": "Response headers",
    "fields.captureRequestBodies.label": "Capture request bodies",
    "fields.captureResponseBodyMode.label": "Response bodies",
    "fields.maxResponseBodyBytes.label": "Byte tối đa mỗi response body",
    "fields.captureRedirectHeaders.label": "Redirect headers",
    "fields.captureInitiator.label": "Nguồn tạo request",
    "fields.suppressRecorderInternalRequests.label": "Ẩn request nội bộ của recorder",
    "fields.captureWebSockets.label": "Capture artifact WebSocket",
    "fields.captureWebSocketFrames.label": "Lưu payload frame WebSocket",
    "fields.maxWebSocketFrameBytes.label": "Byte tối đa mỗi frame",
    "fields.captureWebSocketInitiator.label": "Lưu nguồn tạo WebSocket",
    "fields.captureStorage.label": "Capture snapshot storage",
    "fields.redactStorageValues.label": "Che giá trị storage",
    "fields.captureDomSnapshots.label": "Capture snapshot DOM",
    "fields.redactDomTextContent.label": "Che nội dung text DOM",
    "fields.captureMode.label": "Chế độ capture",
    "options.captureModeCdp": "CDP (fidelity đầy đủ, có banner debugger)",
    "options.captureModeInPage": "In-page (không banner, fidelity thấp hơn)",
    "options.none": "Không lưu",
    "options.shallow": "Nông",
    "options.fullWithinLimit": "Đầy đủ trong giới hạn",
    "options.off": "Tắt",
    "options.errorsOnly": "Chỉ lỗi",
    "options.warningsErrors": "Cảnh báo và lỗi",
    "options.allEntries": "Tất cả entry",
    "options.allResolvedEntries": "Tất cả entry resolve được",
    "options.minimal": "Tối thiểu",
    "options.fullRedacted": "Đầy đủ đã che dữ liệu nhạy cảm",
    "options.sensitiveFields": "Field nhạy cảm",
    "options.allPayloads": "Toàn bộ payload",
    "options.textOnly": "Chỉ text",
    "options.textJson": "Text và JSON",
    "options.eligibleText": "Tất cả loại text phù hợp",
    "options.locationOnly": "Chỉ Location",
    "options.summaryLocation": "Tóm tắt vị trí",
    "options.shortStack": "Stack ngắn",
    "options.fullStack": "Stack đầy đủ",
    "placeholders.noLimit": "Không giới hạn",
    "placeholders.maskDomSelectors": "[data-private]\n.customer-email",
    "hints.visualMasking":
      "Selector được áp dụng trước khi capture nếu có thể. Không che canvas, video hoặc closed shadow DOM.",
    "hints.inspectorCapture":
      "Capture storage và DOM tự động bật và khoá theo khi network/request capture đang bật. Chúng capture thêm dữ liệu nhạy cảm (storage, cookie, text DOM) và làm tăng kích thước package. Tắt network capture để tắt chúng, và giữ redaction bật để che các giá trị khớp pattern nhạy cảm.",
    "hints.captureMode":
      "CDP là mặc định cho capture fidelity đầy đủ (network kiểu DevTools, response body, source map thật) và có thể hiện banner chrome.debugger. Chọn in-page để tránh banner; khi đó network chỉ bắt fetch/XHR/WebSocket, không có response body cross-origin hay source map thật.",
    "messages.settingsSaved": "Đã lưu cài đặt.",
    "messages.sectionSaved": "Đã lưu section.",
    "messages.loadFailed": "Không tải được cài đặt",
    "messages.saveFailed": "Không lưu được cài đặt",
    "info.buttonLabel": "Giải thích field này",
    "info.dialogTitleFallback": "Giải thích cài đặt",
  },
};

const FIELD_HELP: Record<string, Record<SettingsLanguage, { title: string; body: string }>> = {
  "capture-console-input": {
    en: {
      title: "Capture console artifact",
      body: "Stores browser console logs in the replay. QC should keep this on when checking JavaScript errors, failed assertions, or warnings that explain a broken flow.",
    },
    vi: {
      title: "Capture console artifact",
      body: "Lưu log console của trình duyệt vào replay. QC nên bật khi cần kiểm tra lỗi JavaScript, assertion fail hoặc warning giải thích flow bị lỗi.",
    },
  },
  "capture-console-args-input": {
    en: {
      title: "Store console args and previews",
      body: "Keeps structured values logged with console calls, not just the text message. This helps inspect objects but can increase package size if the app logs large data.",
    },
    vi: {
      title: "Lưu tham số và preview console",
      body: "Giữ các giá trị có cấu trúc được log qua console, không chỉ message text. Hữu ích để xem object nhưng có thể làm package lớn nếu app log dữ liệu lớn.",
    },
  },
  "console-preview-depth-input": {
    en: {
      title: "Preview depth",
      body: "Controls how much nested object detail is kept for console values. Shallow is usually enough for QC; full helps when a bug depends on nested response or state objects.",
    },
    vi: {
      title: "Độ sâu preview",
      body: "Quyết định mức chi tiết object lồng nhau được giữ trong console. Nông thường đủ cho QC; đầy đủ hữu ích khi bug phụ thuộc vào response hoặc state object bên trong.",
    },
  },
  "capture-console-stacks-input": {
    en: {
      title: "Console stacks",
      body: "Stores stack traces for console entries. This helps developers jump from an error or warning to the code path that produced it.",
    },
    vi: {
      title: "Stack console",
      body: "Lưu stack trace cho console entry. Điều này giúp developer đi từ lỗi hoặc warning tới đoạn code tạo ra nó.",
    },
  },
  "capture-console-source-snippets-input": {
    en: {
      title: "Source snippets",
      body: "Stores a small source-code excerpt when sourcemaps contain source content. This helps review errors without opening the original app repository.",
    },
    vi: {
      title: "Đoạn source",
      body: "Lưu một đoạn source nhỏ khi sourcemap có source content. Hữu ích để xem lỗi mà không cần mở repository của app gốc.",
    },
  },
  "max-console-entry-bytes-input": {
    en: {
      title: "Max console entry bytes",
      body: "Limits how large each console entry can be. Leave blank for no limit; set a value when noisy logs make console.json too large.",
    },
    vi: {
      title: "Byte tối đa mỗi console entry",
      body: "Giới hạn kích thước từng console entry. Để trống là không giới hạn; nhập giá trị khi log quá ồn làm console.json quá lớn.",
    },
  },
  "capture-network-input": {
    en: {
      title: "Capture network artifact",
      body: "Stores network requests in the replay. QC should keep this on for API failures, slow requests, wrong status codes, CORS issues, or missing assets.",
    },
    vi: {
      title: "Capture network artifact",
      body: "Lưu network requests vào replay. QC nên bật cho lỗi API, request chậm, sai status code, lỗi CORS hoặc thiếu asset.",
    },
  },
  "capture-request-headers-input": {
    en: {
      title: "Request headers",
      body: "Controls how much request header detail is kept. Full redacted is useful for auth, locale, content type, and CORS debugging while sensitive header values are masked.",
    },
    vi: {
      title: "Request headers",
      body: "Quyết định mức chi tiết request header được giữ. Đầy đủ đã che dữ liệu nhạy cảm hữu ích khi debug auth, locale, content type và CORS.",
    },
  },
  "capture-response-headers-input": {
    en: {
      title: "Response headers",
      body: "Controls response header detail. Keep this on when testing cache, content type, redirects, downloads, or server-side behavior.",
    },
    vi: {
      title: "Response headers",
      body: "Quyết định mức chi tiết response header. Nên bật khi test cache, content type, redirect, download hoặc hành vi phía server.",
    },
  },
  "capture-request-bodies-input": {
    en: {
      title: "Capture request bodies",
      body: "Stores submitted payloads such as JSON, forms, or GraphQL variables. This is valuable for reproducing API bugs but may include sensitive user-entered data.",
    },
    vi: {
      title: "Capture request bodies",
      body: "Lưu payload gửi đi như JSON, form hoặc biến GraphQL. Rất hữu ích để tái hiện lỗi API nhưng có thể chứa dữ liệu người dùng nhập.",
    },
  },
  "capture-response-body-mode-input": {
    en: {
      title: "Response bodies",
      body: "Controls which response bodies are stored. Text and JSON are useful for API validation; all eligible text types can include HTML, scripts, or other text assets.",
    },
    vi: {
      title: "Response bodies",
      body: "Quyết định loại response body được lưu. Text và JSON hữu ích để validate API; tất cả loại text phù hợp có thể bao gồm HTML, script hoặc asset dạng text.",
    },
  },
  "max-response-body-bytes-input": {
    en: {
      title: "Max response body bytes",
      body: "Limits stored response body size per request. Leave blank for no limit; use a value when API responses or HTML documents make network.json too large.",
    },
    vi: {
      title: "Byte tối đa mỗi response body",
      body: "Giới hạn kích thước response body được lưu cho mỗi request. Để trống là không giới hạn; nhập giá trị khi API response hoặc HTML làm network.json quá lớn.",
    },
  },
  "capture-redirect-headers-input": {
    en: {
      title: "Redirect headers",
      body: "Stores redirect evidence. Location only is enough for most tester reports; full redacted helps when redirect behavior depends on cache or server headers.",
    },
    vi: {
      title: "Redirect headers",
      body: "Lưu bằng chứng redirect. Chỉ Location là đủ cho đa số report; đầy đủ đã che dữ liệu nhạy cảm hữu ích khi redirect phụ thuộc cache hoặc header server.",
    },
  },
  "capture-initiator-input": {
    en: {
      title: "Initiator",
      body: "Shows what code or browser action started a request. This helps developers trace a bad API call back to a screen, component, or script.",
    },
    vi: {
      title: "Nguồn tạo request",
      body: "Cho biết code hoặc hành động nào tạo request. Điều này giúp developer truy request lỗi về màn hình, component hoặc script liên quan.",
    },
  },
  "suppress-recorder-internal-requests-input": {
    en: {
      title: "Suppress recorder internal requests",
      body: "GN Tracing now resolves only inline sourcemaps by default, so it does not create external sourcemap requests during recording. Keep this on for compatibility with capture modes that may hide recorder-created requests.",
    },
    vi: {
      title: "Ẩn request nội bộ của recorder",
      body: "GN Tracing hiện chỉ resolve sourcemap inline theo mặc định, nên không tạo request sourcemap ngoài trong lúc quay. Nên bật để tương thích với các chế độ capture có thể ẩn request do recorder tạo ra.",
    },
  },
  "capture-websockets-input": {
    en: {
      title: "Capture WebSocket artifact",
      body: "Stores WebSocket connection and message evidence. QC should enable this for chat, realtime dashboards, notifications, games, or live collaboration bugs.",
    },
    vi: {
      title: "Capture WebSocket artifact",
      body: "Lưu bằng chứng kết nối và message WebSocket. QC nên bật cho lỗi chat, dashboard realtime, notification, game hoặc cộng tác live.",
    },
  },
  "capture-websocket-frames-input": {
    en: {
      title: "Store WebSocket frame payloads",
      body: "Stores the actual message payloads sent over WebSocket. This is crucial for realtime bug reproduction but can contain sensitive or high-volume data.",
    },
    vi: {
      title: "Lưu payload frame WebSocket",
      body: "Lưu payload message thực tế gửi qua WebSocket. Rất quan trọng để tái hiện bug realtime nhưng có thể chứa dữ liệu nhạy cảm hoặc khối lượng lớn.",
    },
  },
  "max-websocket-frame-bytes-input": {
    en: {
      title: "Max frame bytes",
      body: "Limits each stored WebSocket frame payload. Leave blank for no limit; set a value when realtime traffic makes websocket.json too large.",
    },
    vi: {
      title: "Byte tối đa mỗi frame",
      body: "Giới hạn payload từng frame WebSocket được lưu. Để trống là không giới hạn; nhập giá trị khi traffic realtime làm websocket.json quá lớn.",
    },
  },
  "capture-websocket-initiator-input": {
    en: {
      title: "Store WebSocket initiator",
      body: "Stores where the WebSocket connection was opened. This helps developers find the screen or module that created a problematic realtime connection.",
    },
    vi: {
      title: "Lưu nguồn tạo WebSocket",
      body: "Lưu nơi WebSocket connection được mở. Điều này giúp developer tìm màn hình hoặc module tạo connection realtime có vấn đề.",
    },
  },
  "capture-storage-input": {
    en: {
      title: "Capture storage snapshots",
      body: "Captures localStorage, sessionStorage, and cookies at recording start and stop so you can inspect how stored state changed. Off by default because storage often contains personal data, tokens, or session identifiers, and it adds a storage.json artifact to the package.",
    },
    vi: {
      title: "Capture snapshot storage",
      body: "Chụp localStorage, sessionStorage và cookie tại lúc bắt đầu và kết thúc recording để xem state lưu trữ thay đổi thế nào. Mặc định tắt vì storage thường chứa dữ liệu cá nhân, token hoặc session id, và sẽ thêm artifact storage.json vào package.",
    },
  },
  "redact-storage-values-input": {
    en: {
      title: "Redact storage values",
      body: "Masks storage and cookie values whose keys match sensitive patterns (password, token, secret, ...). Keep this on so shared replays do not leak credentials.",
    },
    vi: {
      title: "Che giá trị storage",
      body: "Che giá trị storage và cookie khi key khớp pattern nhạy cảm (password, token, secret, ...). Nên bật để bản replay chia sẻ không lộ credential.",
    },
  },
  "capture-dom-snapshots-input": {
    en: {
      title: "Capture DOM snapshots",
      body: "Captures a static DOM snapshot at start, stop, and key markers so you can inspect element structure at those moments. Off by default because DOM text can contain personal data and snapshots can grow large.",
    },
    vi: {
      title: "Capture snapshot DOM",
      body: "Chụp snapshot DOM tĩnh tại start, stop và các marker quan trọng để soi cấu trúc element tại các thời điểm đó. Mặc định tắt vì text DOM có thể chứa dữ liệu cá nhân và snapshot có thể rất lớn.",
    },
  },
  "redact-dom-text-content-input": {
    en: {
      title: "Redact DOM text content",
      body: "Masks text and attribute values for DOM nodes that match your masking selectors before they enter the snapshot. Keep this on to avoid leaking sensitive on-screen content.",
    },
    vi: {
      title: "Che nội dung text DOM",
      body: "Che text và attribute của các node DOM khớp selector che trước khi đưa vào snapshot. Nên bật để tránh lộ nội dung nhạy cảm hiển thị trên màn hình.",
    },
  },
};

const infoPopover = document.getElementById("setting-info-popover") as HTMLElement;
const infoPopoverTitle = document.getElementById("setting-info-title")!;
const infoPopoverBody = document.getElementById("setting-info-body")!;
const toastEl = document.getElementById("toast")!;
const toastIconEl = document.getElementById("toast-icon")!;
const toastMessageEl = document.getElementById("toast-message")!;
const toastCloseBtn = document.getElementById("toast-close-btn") as HTMLButtonElement;
const redactSensitiveHeadersInput = document.getElementById(
  "redact-sensitive-headers-input",
) as HTMLInputElement;
const redactSensitiveQueryParamsInput = document.getElementById(
  "redact-sensitive-query-params-input",
) as HTMLInputElement;
const redactRequestBodyFieldsInput = document.getElementById(
  "redact-request-body-fields-input",
) as HTMLInputElement;
const redactResponseBodyFieldsInput = document.getElementById(
  "redact-response-body-fields-input",
) as HTMLInputElement;
const redactConsoleValuesInput = document.getElementById(
  "redact-console-values-input",
) as HTMLInputElement;
const redactEventMetadataInput = document.getElementById(
  "redact-event-metadata-input",
) as HTMLInputElement;
const redactWebSocketPayloadsInput = document.getElementById(
  "redact-websocket-payloads-input",
) as HTMLSelectElement;
const maskDomSelectorsInput = document.getElementById(
  "mask-dom-selectors-input",
) as HTMLTextAreaElement;

const captureConsoleInput = document.getElementById("capture-console-input") as HTMLInputElement;
const captureConsoleArgsInput = document.getElementById(
  "capture-console-args-input",
) as HTMLInputElement;
const consolePreviewDepthInput = document.getElementById(
  "console-preview-depth-input",
) as HTMLSelectElement;
const captureConsoleStacksInput = document.getElementById(
  "capture-console-stacks-input",
) as HTMLSelectElement;
const captureConsoleSourceSnippetsInput = document.getElementById(
  "capture-console-source-snippets-input",
) as HTMLSelectElement;
const maxConsoleEntryBytesInput = document.getElementById(
  "max-console-entry-bytes-input",
) as HTMLInputElement;

const captureNetworkInput = document.getElementById("capture-network-input") as HTMLInputElement;
const captureRequestHeadersInput = document.getElementById(
  "capture-request-headers-input",
) as HTMLSelectElement;
const captureResponseHeadersInput = document.getElementById(
  "capture-response-headers-input",
) as HTMLSelectElement;
const captureRequestBodiesInput = document.getElementById(
  "capture-request-bodies-input",
) as HTMLInputElement;
const captureResponseBodyModeInput = document.getElementById(
  "capture-response-body-mode-input",
) as HTMLSelectElement;
const maxResponseBodyBytesInput = document.getElementById(
  "max-response-body-bytes-input",
) as HTMLInputElement;
const captureRedirectHeadersInput = document.getElementById(
  "capture-redirect-headers-input",
) as HTMLSelectElement;
const captureInitiatorInput = document.getElementById(
  "capture-initiator-input",
) as HTMLSelectElement;
const suppressRecorderInternalRequestsInput = document.getElementById(
  "suppress-recorder-internal-requests-input",
) as HTMLInputElement;

const captureWebSocketsInput = document.getElementById(
  "capture-websockets-input",
) as HTMLInputElement;
const captureWebSocketFramesInput = document.getElementById(
  "capture-websocket-frames-input",
) as HTMLInputElement;
const maxWebSocketFrameBytesInput = document.getElementById(
  "max-websocket-frame-bytes-input",
) as HTMLInputElement;
const captureWebSocketInitiatorInput = document.getElementById(
  "capture-websocket-initiator-input",
) as HTMLInputElement;

const captureStorageInput = document.getElementById("capture-storage-input") as HTMLInputElement;
const redactStorageValuesInput = document.getElementById(
  "redact-storage-values-input",
) as HTMLInputElement;
const captureDomSnapshotsInput = document.getElementById(
  "capture-dom-snapshots-input",
) as HTMLInputElement;
const redactDomTextContentInput = document.getElementById(
  "redact-dom-text-content-input",
) as HTMLInputElement;
const captureModeInput = document.getElementById("capture-mode-input") as HTMLSelectElement;

type SettingsSectionId = "privacy" | "capture" | "captureMode";

let currentSettings: UploadSettings | null = null;
let currentLanguage: SettingsLanguage = "en";

function t(key: string, replacements: Record<string, string> = {}): string {
  const template = TRANSLATIONS[currentLanguage][key] || TRANSLATIONS.en[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}

function getLabelForHelpKey(helpKey: string): string {
  const label = document
    .querySelector(`[for="${helpKey}"] [data-i18n], #${helpKey}`)
    ?.closest("label");
  const labelText = label?.querySelector("[data-i18n]")?.textContent?.trim();
  return labelText || t("info.dialogTitleFallback");
}

function applyTranslations(): void {
  document.documentElement.lang = currentLanguage;
  document.title = currentLanguage === "vi" ? "Cài đặt GN Tracing" : "GN Tracing Settings";

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n || "");
  });
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder || "");
  });
  document.querySelectorAll<HTMLButtonElement>(".field-info-btn").forEach((button) => {
    button.setAttribute("aria-label", t("info.buttonLabel"));
    button.title = t("info.buttonLabel");
  });

  if (activeInfoHelpKey && isPopoverOpen(infoPopover) && activeInfoButton) {
    fillInfoPopover(activeInfoHelpKey);
    positionInfoPopover(activeInfoButton);
  }
}

function addFieldInfoButton(label: HTMLLabelElement, helpKey: string): void {
  if (label.querySelector(".field-info-btn")) {
    return;
  }

  // Prefer explicit check-text / label span so both toggle rows and labeled controls work.
  const labelText =
    label.querySelector<HTMLElement>(".settings-check-text[data-i18n]") ||
    label.querySelector<HTMLElement>(".setting-field-label-row [data-i18n]") ||
    label.querySelector<HTMLElement>("span[data-i18n]");
  if (!labelText) {
    return;
  }

  const hasHelp = FIELD_HELP[helpKey]?.en || FIELD_HELP[helpKey]?.vi;
  if (!hasHelp) {
    return;
  }

  // Keep the label text + info button on one horizontal row. `.setting-field`
  // is a column flex, so a bare sibling button would wrap onto its own line.
  let labelRow = labelText.closest(".setting-field-label-row");
  if (!labelRow) {
    labelRow = document.createElement("div");
    labelRow.className = "setting-field-label-row";
    labelText.insertAdjacentElement("beforebegin", labelRow);
    labelRow.appendChild(labelText);
  }

  const button = document.createElement("button");
  button.className = "field-info-btn";
  button.type = "button";
  button.dataset.helpKey = helpKey;
  button.textContent = "i";
  button.setAttribute("aria-label", t("info.buttonLabel"));
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "setting-info-popover");
  button.title = t("info.buttonLabel");
  labelRow.appendChild(button);
}

function setupFieldInfoButtons(): void {
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input[id], select[id], textarea[id]",
    )
    .forEach((control) => {
      const label = control.closest("label");
      if (label) {
        addFieldInfoButton(label, control.id);
      }
    });
}

type ToastVariant = "success" | "info" | "error";

let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let activeInfoHelpKey: string | null = null;
let activeInfoButton: HTMLButtonElement | null = null;

function isPopoverOpen(element: HTMLElement): boolean {
  return element.matches(":popover-open");
}

function getToastIcon(variant: ToastVariant): string {
  switch (variant) {
    case "info":
      return "i";
    case "error":
      return "!";
    default:
      return "✓";
  }
}

function showToast(
  message: string,
  durationMs = 2200,
  options: { variant?: ToastVariant } = {},
): void {
  const variant = options.variant || "success";
  toastIconEl.textContent = getToastIcon(variant);
  toastMessageEl.textContent = message;
  toastEl.classList.remove("toast-success", "toast-info", "toast-error", "hidden");
  toastEl.classList.add(`toast-${variant}`);
  toastEl.setAttribute("role", variant === "error" ? "alert" : "status");
  toastEl.setAttribute("aria-live", variant === "error" ? "assertive" : "polite");

  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  if (durationMs > 0) {
    toastTimeout = setTimeout(() => {
      hideToast();
    }, durationMs);
  }
}

function hideToast(): void {
  toastEl.classList.add("hidden");
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
}

function fillInfoPopover(helpKey: string): void {
  const help = FIELD_HELP[helpKey]?.[currentLanguage] || FIELD_HELP[helpKey]?.en;
  infoPopoverTitle.textContent = help?.title || getLabelForHelpKey(helpKey);
  infoPopoverBody.textContent = help?.body || t("info.dialogTitleFallback");
}

function positionInfoPopover(anchor: HTMLElement): void {
  const gap = 8;
  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  // Measure after open so size is accurate.
  const popRect = infoPopover.getBoundingClientRect();
  let top = rect.bottom + gap;
  let left = rect.left;

  if (top + popRect.height > window.innerHeight - margin) {
    top = rect.top - popRect.height - gap;
  }
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  top = Math.max(margin, top);
  left = Math.max(margin, left);

  infoPopover.style.top = `${Math.round(top)}px`;
  infoPopover.style.left = `${Math.round(left)}px`;
}

function closeInfoPopover(): void {
  if (isPopoverOpen(infoPopover)) {
    infoPopover.hidePopover();
  }
  if (activeInfoButton) {
    activeInfoButton.setAttribute("aria-expanded", "false");
  }
  activeInfoHelpKey = null;
  activeInfoButton = null;
}

function openInfoPopover(helpKey: string, anchor: HTMLButtonElement): void {
  if (activeInfoHelpKey === helpKey && isPopoverOpen(infoPopover)) {
    closeInfoPopover();
    return;
  }

  if (activeInfoButton && activeInfoButton !== anchor) {
    activeInfoButton.setAttribute("aria-expanded", "false");
  }

  fillInfoPopover(helpKey);
  activeInfoHelpKey = helpKey;
  activeInfoButton = anchor;
  anchor.setAttribute("aria-expanded", "true");

  if (!isPopoverOpen(infoPopover)) {
    infoPopover.showPopover();
  }
  positionInfoPopover(anchor);
}

function withDefaultSettings(settings: Partial<UploadSettings>): UploadSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    folderInput: settings.folderInput ?? DEFAULT_SETTINGS.folderInput,
    folderId: settings.folderId ?? DEFAULT_SETTINGS.folderId,
    zipPasswordConfigured: settings.zipPasswordConfigured ?? DEFAULT_SETTINGS.zipPasswordConfigured,
    privacyProfile: settings.privacyProfile ?? DEFAULT_SETTINGS.privacyProfile,
    redactSensitiveHeaders:
      settings.redactSensitiveHeaders ?? DEFAULT_SETTINGS.redactSensitiveHeaders,
    redactSensitiveQueryParams:
      settings.redactSensitiveQueryParams ?? DEFAULT_SETTINGS.redactSensitiveQueryParams,
    redactRequestBodyFields:
      settings.redactRequestBodyFields ?? DEFAULT_SETTINGS.redactRequestBodyFields,
    redactResponseBodyFields:
      settings.redactResponseBodyFields ?? DEFAULT_SETTINGS.redactResponseBodyFields,
    redactConsoleValues: settings.redactConsoleValues ?? DEFAULT_SETTINGS.redactConsoleValues,
    redactWebSocketPayloads:
      settings.redactWebSocketPayloads ?? DEFAULT_SETTINGS.redactWebSocketPayloads,
    redactEventMetadata: settings.redactEventMetadata ?? DEFAULT_SETTINGS.redactEventMetadata,
    maskDomSelectors: normalizeMaskDomSelectors(
      settings.maskDomSelectors ?? DEFAULT_SETTINGS.maskDomSelectors,
    ),
    captureConsole: settings.captureConsole ?? DEFAULT_SETTINGS.captureConsole,
    captureConsoleArgs: settings.captureConsoleArgs ?? DEFAULT_SETTINGS.captureConsoleArgs,
    consolePreviewDepth: settings.consolePreviewDepth ?? DEFAULT_SETTINGS.consolePreviewDepth,
    captureConsoleStacks: settings.captureConsoleStacks ?? DEFAULT_SETTINGS.captureConsoleStacks,
    captureConsoleSourceSnippets:
      settings.captureConsoleSourceSnippets ?? DEFAULT_SETTINGS.captureConsoleSourceSnippets,
    maxConsoleEntryBytes: settings.maxConsoleEntryBytes ?? DEFAULT_SETTINGS.maxConsoleEntryBytes,
    captureNetwork: settings.captureNetwork ?? DEFAULT_SETTINGS.captureNetwork,
    captureRequestHeaders: settings.captureRequestHeaders ?? DEFAULT_SETTINGS.captureRequestHeaders,
    captureResponseHeaders:
      settings.captureResponseHeaders ?? DEFAULT_SETTINGS.captureResponseHeaders,
    captureRequestBodies: settings.captureRequestBodies ?? DEFAULT_SETTINGS.captureRequestBodies,
    captureResponseBodies: settings.captureResponseBodies ?? DEFAULT_SETTINGS.captureResponseBodies,
    captureResponseBodyMode:
      settings.captureResponseBodyMode ?? DEFAULT_SETTINGS.captureResponseBodyMode,
    maxResponseBodyBytes: settings.maxResponseBodyBytes ?? DEFAULT_SETTINGS.maxResponseBodyBytes,
    captureRedirectHeaders:
      settings.captureRedirectHeaders ?? DEFAULT_SETTINGS.captureRedirectHeaders,
    captureInitiator: settings.captureInitiator ?? DEFAULT_SETTINGS.captureInitiator,
    suppressRecorderInternalRequests:
      settings.suppressRecorderInternalRequests ??
      DEFAULT_SETTINGS.suppressRecorderInternalRequests,
    captureWebSockets: settings.captureWebSockets ?? DEFAULT_SETTINGS.captureWebSockets,
    captureWebSocketFrames:
      settings.captureWebSocketFrames ?? DEFAULT_SETTINGS.captureWebSocketFrames,
    maxWebSocketFrameBytes:
      settings.maxWebSocketFrameBytes ?? DEFAULT_SETTINGS.maxWebSocketFrameBytes,
    captureWebSocketInitiator:
      settings.captureWebSocketInitiator ?? DEFAULT_SETTINGS.captureWebSocketInitiator,
    captureStorage: settings.captureStorage ?? DEFAULT_SETTINGS.captureStorage,
    redactStorageValues: settings.redactStorageValues ?? DEFAULT_SETTINGS.redactStorageValues,
    captureDomSnapshots: settings.captureDomSnapshots ?? DEFAULT_SETTINGS.captureDomSnapshots,
    redactDomTextContent: settings.redactDomTextContent ?? DEFAULT_SETTINGS.redactDomTextContent,
    instantReplayEnabled: settings.instantReplayEnabled ?? DEFAULT_SETTINGS.instantReplayEnabled,
    instantReplayWindowSeconds:
      settings.instantReplayWindowSeconds ?? DEFAULT_SETTINGS.instantReplayWindowSeconds,
    instantReplayAllowedDomains: Array.isArray(settings.instantReplayAllowedDomains)
      ? [...settings.instantReplayAllowedDomains]
      : [...DEFAULT_SETTINGS.instantReplayAllowedDomains],
    captureMode: settings.captureMode ?? DEFAULT_SETTINGS.captureMode,
  };
}

function showMessage(message: string, success = false): void {
  showToast(message, success ? 2200 : 4200, {
    variant: success ? "success" : "error",
  });
}

function getOptionalNumber(input: HTMLInputElement): number | null {
  if (input.value.trim() === "") {
    return null;
  }
  const value = Number(input.value);
  return Number.isFinite(value) ? value : null;
}

function renderSettings(settings: UploadSettings): void {
  const normalizedSettings = withDefaultSettings(settings);
  currentSettings = normalizedSettings;

  redactSensitiveHeadersInput.checked = normalizedSettings.redactSensitiveHeaders;
  redactSensitiveQueryParamsInput.checked = normalizedSettings.redactSensitiveQueryParams;
  redactRequestBodyFieldsInput.checked = normalizedSettings.redactRequestBodyFields;
  redactResponseBodyFieldsInput.checked = normalizedSettings.redactResponseBodyFields;
  redactConsoleValuesInput.checked = normalizedSettings.redactConsoleValues;
  redactEventMetadataInput.checked = normalizedSettings.redactEventMetadata;
  redactWebSocketPayloadsInput.value = normalizedSettings.redactWebSocketPayloads;
  maskDomSelectorsInput.value = normalizedSettings.maskDomSelectors.join("\n");

  captureConsoleInput.checked = normalizedSettings.captureConsole;
  captureConsoleArgsInput.checked = normalizedSettings.captureConsoleArgs;
  consolePreviewDepthInput.value = normalizedSettings.consolePreviewDepth;
  captureConsoleStacksInput.value = normalizedSettings.captureConsoleStacks;
  captureConsoleSourceSnippetsInput.value = normalizedSettings.captureConsoleSourceSnippets;
  maxConsoleEntryBytesInput.value =
    normalizedSettings.maxConsoleEntryBytes == null
      ? ""
      : String(normalizedSettings.maxConsoleEntryBytes);

  captureNetworkInput.checked = normalizedSettings.captureNetwork;
  captureRequestHeadersInput.value = normalizedSettings.captureRequestHeaders;
  captureResponseHeadersInput.value = normalizedSettings.captureResponseHeaders;
  captureRequestBodiesInput.checked = normalizedSettings.captureRequestBodies;
  captureResponseBodyModeInput.value = normalizedSettings.captureResponseBodyMode;
  maxResponseBodyBytesInput.value =
    normalizedSettings.maxResponseBodyBytes == null
      ? ""
      : String(normalizedSettings.maxResponseBodyBytes);
  captureRedirectHeadersInput.value = normalizedSettings.captureRedirectHeaders;
  captureInitiatorInput.value = normalizedSettings.captureInitiator;
  suppressRecorderInternalRequestsInput.checked =
    normalizedSettings.suppressRecorderInternalRequests;

  captureWebSocketsInput.checked = normalizedSettings.captureWebSockets;
  captureWebSocketFramesInput.checked = normalizedSettings.captureWebSocketFrames;
  maxWebSocketFrameBytesInput.value =
    normalizedSettings.maxWebSocketFrameBytes == null
      ? ""
      : String(normalizedSettings.maxWebSocketFrameBytes);
  captureWebSocketInitiatorInput.checked = normalizedSettings.captureWebSocketInitiator;

  captureStorageInput.checked = normalizedSettings.captureStorage;
  redactStorageValuesInput.checked = normalizedSettings.redactStorageValues;
  captureDomSnapshotsInput.checked = normalizedSettings.captureDomSnapshots;
  redactDomTextContentInput.checked = normalizedSettings.redactDomTextContent;
  captureModeInput.value = normalizedSettings.captureMode;
  syncInspectorCaptureCoupling();
}

// When network/request capture is on, storage and DOM capture are forced on and
// their checkboxes are locked to reflect that they cannot be turned off
// independently. Mirrors the data-layer coupling in settings-store.ts and the
// service worker.
function syncInspectorCaptureCoupling(): void {
  const coupled = captureNetworkInput.checked;
  if (coupled) {
    captureStorageInput.checked = true;
    captureDomSnapshotsInput.checked = true;
  }
  captureStorageInput.disabled = coupled;
  captureDomSnapshotsInput.disabled = coupled;
}

function getPrivacySectionPayload(): Record<string, unknown> {
  return {
    privacyProfile: "custom",
    redactSensitiveHeaders: redactSensitiveHeadersInput.checked,
    redactSensitiveQueryParams: redactSensitiveQueryParamsInput.checked,
    redactRequestBodyFields: redactRequestBodyFieldsInput.checked,
    redactResponseBodyFields: redactResponseBodyFieldsInput.checked,
    redactConsoleValues: redactConsoleValuesInput.checked,
    redactWebSocketPayloads: redactWebSocketPayloadsInput.value,
    redactEventMetadata: redactEventMetadataInput.checked,
    maskDomSelectors: normalizeMaskDomSelectors(maskDomSelectorsInput.value),
  };
}

function getCaptureSectionPayload(): Record<string, unknown> {
  return {
    // Coupling: network/request capture forces storage + DOM capture on.
    captureStorage: captureStorageInput.checked || captureNetworkInput.checked,
    redactStorageValues: redactStorageValuesInput.checked,
    captureDomSnapshots: captureDomSnapshotsInput.checked || captureNetworkInput.checked,
    redactDomTextContent: redactDomTextContentInput.checked,
    captureConsole: captureConsoleInput.checked,
    captureConsoleArgs: captureConsoleArgsInput.checked,
    consolePreviewDepth: consolePreviewDepthInput.value,
    captureConsoleStacks: captureConsoleStacksInput.value,
    captureConsoleSourceSnippets: captureConsoleSourceSnippetsInput.value,
    maxConsoleEntryBytes: getOptionalNumber(maxConsoleEntryBytesInput),
    captureNetwork: captureNetworkInput.checked,
    captureRequestHeaders: captureRequestHeadersInput.value,
    captureResponseHeaders: captureResponseHeadersInput.value,
    captureRequestBodies: captureRequestBodiesInput.checked,
    captureResponseBodies: captureResponseBodyModeInput.value !== "off",
    captureResponseBodyMode: captureResponseBodyModeInput.value,
    maxResponseBodyBytes: getOptionalNumber(maxResponseBodyBytesInput),
    captureRedirectHeaders: captureRedirectHeadersInput.value,
    captureInitiator: captureInitiatorInput.value,
    suppressRecorderInternalRequests: suppressRecorderInternalRequestsInput.checked,
    captureWebSockets: captureWebSocketsInput.checked,
    captureWebSocketFrames: captureWebSocketFramesInput.checked,
    maxWebSocketFrameBytes: getOptionalNumber(maxWebSocketFrameBytesInput),
    captureWebSocketInitiator: captureWebSocketInitiatorInput.checked,
  };
}

function getCaptureModeSectionPayload(): Record<string, unknown> {
  return {
    captureMode: captureModeInput.value,
  };
}

function getSectionPayload(section: SettingsSectionId): Record<string, unknown> {
  if (section === "privacy") {
    return getPrivacySectionPayload();
  }
  if (section === "capture") {
    return getCaptureSectionPayload();
  }
  return getCaptureModeSectionPayload();
}

async function loadSettings(): Promise<void> {
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "GET_SETTINGS",
    })) as MessageResponse & {
      settings?: UploadSettings;
      uploadHistory?: UploadHistoryEntry[];
    };
    if (!result.ok || !result.settings) {
      showMessage(result.error || t("messages.loadFailed"));
      return;
    }
    renderSettings(result.settings);
  } catch (error) {
    showMessage((error as Error).message);
  }
}

async function saveSection(section: SettingsSectionId, button: HTMLButtonElement): Promise<void> {
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = t("actions.savingSection");
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: getSectionPayload(section),
    })) as MessageResponse & { settings?: UploadSettings; message?: string };
    if (!result.ok || !result.settings) {
      showMessage(result.error || t("messages.saveFailed"));
      return;
    }
    renderSettings(result.settings);
    if (typeof result.message === "string" && result.message.trim()) {
      showMessage(result.message, false);
      return;
    }
    showMessage(t("messages.sectionSaved"), true);
  } catch (error) {
    showMessage((error as Error).message);
  } finally {
    button.disabled = false;
    button.textContent = previousLabel || t("actions.saveSection");
  }
}

document.querySelectorAll("input, select, textarea").forEach((input) => {
  input.addEventListener("change", () => {
    // Keep storage/DOM toggles locked-on while network capture is enabled.
    if (input.getAttribute("id") === "capture-network-input") {
      syncInspectorCaptureCoupling();
    }
  });
});

document.querySelectorAll<HTMLButtonElement>(".settings-section-save").forEach((button) => {
  button.addEventListener("click", () => {
    const section = button.dataset.section as SettingsSectionId | undefined;
    if (section === "privacy" || section === "capture" || section === "captureMode") {
      void saveSection(section, button);
    }
  });
});

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".field-info-btn");
  if (!button?.dataset.helpKey) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  openInfoPopover(button.dataset.helpKey, button);
});

infoPopover.addEventListener("toggle", (event) => {
  const toggleEvent = event as ToggleEvent;
  if (toggleEvent.newState === "closed" && activeInfoButton) {
    activeInfoButton.setAttribute("aria-expanded", "false");
    activeInfoHelpKey = null;
    activeInfoButton = null;
  }
});

window.addEventListener(
  "resize",
  () => {
    if (activeInfoButton && isPopoverOpen(infoPopover)) {
      positionInfoPopover(activeInfoButton);
    }
  },
  { passive: true },
);

window.addEventListener(
  "scroll",
  () => {
    if (activeInfoButton && isPopoverOpen(infoPopover)) {
      positionInfoPopover(activeInfoButton);
    }
  },
  { passive: true, capture: true },
);

toastCloseBtn.addEventListener("click", () => {
  hideToast();
});

setupFieldInfoButtons();
attachPageNav({ current: "settings" });

const feedbackMount = document.getElementById("feedback-mount");
let feedbackUi: FeedbackUiController | null = null;
if (feedbackMount) {
  feedbackUi = attachFeedbackPopover({
    mount: feedbackMount,
    getLabels: () => ({
      button: t("feedback.button"),
      sectionAria: t("feedback.sectionAria"),
      label: t("feedback.label"),
      placeholder: t("feedback.placeholder"),
      hint: t("feedback.hint"),
      submit: t("feedback.submit"),
      cancel: t("feedback.cancel"),
      sending: t("feedback.sending"),
      success: t("feedback.success"),
      failed: t("feedback.failed"),
    }),
    onResult: (result) => {
      showToast(result.message, 4200, {
        variant: result.ok ? "success" : "error",
      });
    },
  });
}

const themeToggleUi: ThemeToggleController | null = attachThemeToggle(
  "theme-toggle-btn",
  "theme-toggle-icon",
  {
    getLabels: () => ({
      system: t("theme.system"),
      light: t("theme.light"),
      dark: t("theme.dark"),
      aria: t("theme.aria"),
      titleSystem: t("theme.titleSystem"),
      titleFixed: t("theme.titleFixed"),
    }),
  },
);

currentLanguage = attachLanguageSwitch({
  onChange: (language) => {
    currentLanguage = language;
    applyTranslations();
    feedbackUi?.refreshLabels();
    themeToggleUi?.refreshLabels();
  },
});
applyTranslations();
feedbackUi?.refreshLabels();
themeToggleUi?.refreshLabels();
void loadSettings();

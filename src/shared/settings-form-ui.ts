/**
 * Capture / privacy settings form shared by the full settings page and the
 * popup settings dialog. Callers own page chrome (topbar, toast host, i18n
 * language switch) and pass a root that contains the form controls.
 */

import type { MessageResponse, UploadSettings } from "../types/messages";
import { getPrivacyProfileSettings, normalizeMaskDomSelectors } from "./privacy-redaction";
import type { UiLanguage } from "./ui-language";

export const DEFAULT_SETTINGS: UploadSettings = {
  activeStorageProvider: "google-drive",
  folderInput: "/gn-tracing",
  folderId: null,
  zipPasswordConfigured: false,
  microphoneDeviceId: "",
  speakerDeviceId: "",
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
};

export type SettingsSectionId = "privacy" | "capture";

/** Form-only i18n keys used by the shared settings markup. */
export const SETTINGS_FORM_TRANSLATIONS: Record<UiLanguage, Record<string, string>> = {
  en: {
    "actions.saveSection": "Save section",
    "actions.savingSection": "Saving…",
    "sections.privacyRedaction": "Privacy & Redaction",
    "sections.privacyData": "Data redaction",
    "sections.visualMasking": "Visual masking",
    "sections.capture": "Capture",
    "sections.audio": "Audio",
    "sections.console": "Console",
    "sections.network": "Network",
    "sections.websocket": "WebSocket",
    "sections.inspector": "Inspector capture",
    "fields.redactSensitiveHeaders.label": "Redact sensitive headers",
    "fields.redactSensitiveQueryParams.label": "Redact sensitive query params",
    "fields.redactRequestBodyFields.label": "Redact request body fields",
    "fields.redactResponseBodyFields.label": "Redact response body fields",
    "fields.redactConsoleValues.label": "Redact console values",
    "fields.redactEventMetadata.label": "Redact event/report metadata",
    "fields.redactWebSocketPayloads.label": "WebSocket payload redaction",
    "fields.maskDomSelectors.label": "DOM selectors to mask",
    "fields.microphoneDeviceId.label": "Microphone",
    "fields.speakerDeviceId.label": "System audio source (loopback)",
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
    "options.browserDefault": "Browser default",
    "options.unavailable": "unavailable",
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
    "hints.audioCapture":
      "Speaker audio means audio from the shared tab or screen. It is not an output-device selector.",
    "hints.inspectorCapture":
      "Storage and DOM capture turn on automatically while network/request capture is enabled, and lock to it. They capture more sensitive data (storage, cookies, DOM text) and increase package size. Turn off network capture to disable them, and keep redaction on to mask values that match sensitive patterns.",
    "hints.inspectorCaptureCoupling":
      "Network capture keeps storage and DOM snapshots on while it is enabled.",
    "messages.settingsSaved": "Settings saved.",
    "messages.sectionSaved": "Section saved.",
    "messages.loadFailed": "Failed to load settings",
    "messages.saveFailed": "Failed to save settings",
    "info.buttonLabel": "Explain this field",
    "info.dialogTitleFallback": "Setting help",
    "settings.dialogTitle": "Settings",
    "settings.dialogLead":
      "Choose what each recording captures before you start a session. Save each section when you finish editing it.",
  },
  vi: {
    "actions.saveSection": "Lưu mục này",
    "actions.savingSection": "Đang lưu…",
    "sections.privacyRedaction": "Quyền riêng tư và che dữ liệu",
    "sections.privacyData": "Che dữ liệu",
    "sections.visualMasking": "Che giao diện",
    "sections.capture": "Thu thập dữ liệu",
    "sections.audio": "Âm thanh",
    "sections.console": "Console",
    "sections.network": "Mạng",
    "sections.websocket": "WebSocket",
    "sections.inspector": "Thu thập dữ liệu kiểm tra",
    "fields.redactSensitiveHeaders.label": "Che các tiêu đề nhạy cảm",
    "fields.redactSensitiveQueryParams.label": "Che tham số truy vấn nhạy cảm",
    "fields.redactRequestBodyFields.label": "Che trường dữ liệu gửi đi",
    "fields.redactResponseBodyFields.label": "Che trường dữ liệu phản hồi",
    "fields.redactConsoleValues.label": "Che giá trị Console",
    "fields.redactEventMetadata.label": "Che siêu dữ liệu sự kiện/báo cáo",
    "fields.redactWebSocketPayloads.label": "Che dữ liệu WebSocket",
    "fields.maskDomSelectors.label": "DOM selector cần che",
    "fields.microphoneDeviceId.label": "Micrô",
    "fields.speakerDeviceId.label": "Nguồn âm thanh hệ thống (loopback)",
    "fields.captureConsole.label": "Thu thập nhật ký Console",
    "fields.captureConsoleArgs.label": "Lưu tham số và bản xem trước của Console",
    "fields.consolePreviewDepth.label": "Độ sâu xem trước",
    "fields.captureConsoleStacks.label": "Ngăn xếp",
    "fields.captureConsoleSourceSnippets.label": "Đoạn mã nguồn",
    "fields.maxConsoleEntryBytes.label": "Số byte tối đa mỗi mục Console",
    "fields.captureNetwork.label": "Thu thập hoạt động mạng",
    "fields.captureRequestHeaders.label": "Tiêu đề yêu cầu",
    "fields.captureResponseHeaders.label": "Tiêu đề phản hồi",
    "fields.captureRequestBodies.label": "Thu thập nội dung yêu cầu",
    "fields.captureResponseBodyMode.label": "Nội dung phản hồi",
    "fields.maxResponseBodyBytes.label": "Số byte tối đa mỗi nội dung phản hồi",
    "fields.captureRedirectHeaders.label": "Tiêu đề chuyển hướng",
    "fields.captureInitiator.label": "Nguồn tạo yêu cầu",
    "fields.suppressRecorderInternalRequests.label": "Ẩn yêu cầu nội bộ của trình ghi",
    "fields.captureWebSockets.label": "Thu thập dữ liệu WebSocket",
    "fields.captureWebSocketFrames.label": "Lưu dữ liệu khung WebSocket",
    "fields.maxWebSocketFrameBytes.label": "Số byte tối đa mỗi khung",
    "fields.captureWebSocketInitiator.label": "Lưu nguồn tạo WebSocket",
    "fields.captureStorage.label": "Thu thập ảnh chụp bộ nhớ lưu trữ",
    "fields.redactStorageValues.label": "Che giá trị bộ nhớ lưu trữ",
    "fields.captureDomSnapshots.label": "Thu thập ảnh chụp DOM",
    "fields.redactDomTextContent.label": "Che nội dung văn bản DOM",
    "options.browserDefault": "Mặc định của trình duyệt",
    "options.unavailable": "không khả dụng",
    "options.none": "Không lưu",
    "options.shallow": "Nông",
    "options.fullWithinLimit": "Đầy đủ trong giới hạn",
    "options.off": "Tắt",
    "options.errorsOnly": "Chỉ lỗi",
    "options.warningsErrors": "Cảnh báo và lỗi",
    "options.allEntries": "Tất cả mục",
    "options.allResolvedEntries": "Tất cả mục phân giải được",
    "options.minimal": "Tối thiểu",
    "options.fullRedacted": "Đầy đủ đã che dữ liệu nhạy cảm",
    "options.sensitiveFields": "Trường nhạy cảm",
    "options.allPayloads": "Toàn bộ dữ liệu",
    "options.textOnly": "Chỉ văn bản",
    "options.textJson": "Văn bản và JSON",
    "options.eligibleText": "Mọi loại văn bản phù hợp",
    "options.locationOnly": "Chỉ vị trí",
    "options.summaryLocation": "Tóm tắt vị trí",
    "options.shortStack": "Ngăn xếp ngắn",
    "options.fullStack": "Ngăn xếp đầy đủ",
    "placeholders.noLimit": "Không giới hạn",
    "placeholders.maskDomSelectors": "[data-private]\n.customer-email",
    "hints.visualMasking":
      "Bộ chọn được áp dụng trước khi thu thập nếu có thể. Không che canvas, video hoặc shadow DOM đóng.",
    "hints.audioCapture":
      "Âm thanh hệ thống là âm thanh từ tab hoặc màn hình được chia sẻ, không phải thiết bị đầu ra đã chọn.",
    "hints.inspectorCapture":
      "Thu thập bộ nhớ lưu trữ và DOM tự động bật, đồng thời bị khóa khi thu thập mạng/yêu cầu đang bật. Chúng có thể chứa dữ liệu nhạy cảm (bộ nhớ lưu trữ, cookie, văn bản DOM) và làm tăng kích thước gói. Tắt thu thập mạng để tắt chúng; giữ che dữ liệu để che các giá trị khớp mẫu nhạy cảm.",
    "hints.inspectorCaptureCoupling":
      "Khi thu thập mạng đang bật, ảnh chụp bộ nhớ lưu trữ và DOM luôn được bật theo.",
    "messages.settingsSaved": "Đã lưu cài đặt.",
    "messages.sectionSaved": "Đã lưu mục này.",
    "messages.loadFailed": "Không tải được cài đặt",
    "messages.saveFailed": "Không lưu được cài đặt",
    "info.buttonLabel": "Giải thích trường này",
    "info.dialogTitleFallback": "Giải thích cài đặt",
    "settings.dialogTitle": "Cài đặt",
    "settings.dialogLead":
      "Chọn dữ liệu cần thu thập trước khi bắt đầu phiên ghi. Lưu từng mục sau khi chỉnh sửa.",
  },
};

const FIELD_HELP: Record<string, Record<UiLanguage, { title: string; body: string }>> = {
  "capture-console-input": {
    en: {
      title: "Capture console artifact",
      body: "Stores browser console logs in the replay. QC should keep this on when checking JavaScript errors, failed assertions, or warnings that explain a broken flow.",
    },
    vi: {
      title: "Thu thập nhật ký Console",
      body: "Lưu nhật ký Console của trình duyệt vào bản phát lại. Nên bật khi kiểm tra lỗi JavaScript, xác nhận thất bại hoặc cảnh báo giải thích luồng bị lỗi.",
    },
  },
  "capture-console-args-input": {
    en: {
      title: "Store console args and previews",
      body: "Keeps structured values logged with console calls, not just the text message. This helps inspect objects but can increase package size if the app logs large data.",
    },
    vi: {
      title: "Lưu tham số và bản xem trước của Console",
      body: "Giữ các giá trị có cấu trúc được ghi qua Console, không chỉ nội dung chữ. Hữu ích để xem đối tượng nhưng có thể làm gói lớn nếu ứng dụng ghi nhiều dữ liệu.",
    },
  },
  "console-preview-depth-input": {
    en: {
      title: "Preview depth",
      body: "Controls how much nested object detail is kept for console values. Shallow is usually enough for QC; full helps when a bug depends on nested response or state objects.",
    },
    vi: {
      title: "Độ sâu xem trước",
      body: "Quyết định mức chi tiết của đối tượng lồng nhau được giữ trong Console. Mức nông thường đủ; mức đầy đủ hữu ích khi lỗi phụ thuộc vào phản hồi hoặc trạng thái bên trong.",
    },
  },
  "capture-console-stacks-input": {
    en: {
      title: "Console stacks",
      body: "Stores stack traces for console entries. This helps developers jump from an error or warning to the code path that produced it.",
    },
    vi: {
      title: "Ngăn xếp Console",
      body: "Lưu dấu vết ngăn xếp cho từng mục Console. Điều này giúp lần từ lỗi hoặc cảnh báo tới đoạn mã đã tạo ra nó.",
    },
  },
  "capture-console-source-snippets-input": {
    en: {
      title: "Source snippets",
      body: "Stores a small source-code excerpt when sourcemaps contain source content. This helps review errors without opening the original app repository.",
    },
    vi: {
      title: "Đoạn mã nguồn",
      body: "Lưu một đoạn mã nhỏ khi source map có nội dung nguồn. Hữu ích để xem lỗi mà không cần mở kho mã của ứng dụng gốc.",
    },
  },
  "max-console-entry-bytes-input": {
    en: {
      title: "Max console entry bytes",
      body: "Limits how large each console entry can be. Leave blank for no limit; set a value when noisy logs make console.json too large.",
    },
    vi: {
      title: "Số byte tối đa mỗi mục Console",
      body: "Giới hạn kích thước mỗi mục Console. Để trống để không giới hạn; nhập giá trị khi nhật ký quá nhiều làm console.json quá lớn.",
    },
  },
  "capture-network-input": {
    en: {
      title: "Capture network artifact",
      body: "Stores network requests in the replay. QC should keep this on for API failures, slow requests, wrong status codes, CORS issues, or missing assets.",
    },
    vi: {
      title: "Thu thập hoạt động mạng",
      body: "Lưu các yêu cầu mạng vào bản phát lại. Nên bật khi kiểm tra lỗi API, yêu cầu chậm, mã trạng thái sai, lỗi CORS hoặc thiếu tài nguyên.",
    },
  },
  "capture-request-headers-input": {
    en: {
      title: "Request headers",
      body: "Controls how much request header detail is kept. Full redacted is useful for auth, locale, content type, and CORS debugging while sensitive header values are masked.",
    },
    vi: {
      title: "Tiêu đề yêu cầu",
      body: "Quyết định mức chi tiết tiêu đề yêu cầu được giữ. Chế độ đầy đủ đã che dữ liệu nhạy cảm hữu ích khi gỡ lỗi xác thực, ngôn ngữ, loại nội dung và CORS.",
    },
  },
  "capture-response-headers-input": {
    en: {
      title: "Response headers",
      body: "Controls response header detail. Keep this on when testing cache, content type, redirects, downloads, or server-side behavior.",
    },
    vi: {
      title: "Tiêu đề phản hồi",
      body: "Quyết định mức chi tiết tiêu đề phản hồi. Nên bật khi kiểm tra bộ nhớ đệm, loại nội dung, chuyển hướng, tải xuống hoặc hành vi phía máy chủ.",
    },
  },
  "capture-request-bodies-input": {
    en: {
      title: "Capture request bodies",
      body: "Stores submitted payloads such as JSON, forms, or GraphQL variables. This is valuable for reproducing API bugs but may include sensitive user-entered data.",
    },
    vi: {
      title: "Thu thập nội dung yêu cầu",
      body: "Lưu dữ liệu gửi đi như JSON, biểu mẫu hoặc biến GraphQL. Rất hữu ích để tái hiện lỗi API nhưng có thể chứa dữ liệu người dùng nhập.",
    },
  },
  "capture-response-body-mode-input": {
    en: {
      title: "Response bodies",
      body: "Controls which response bodies are stored. Text and JSON are useful for API validation; all eligible text types can include HTML, scripts, or other text assets.",
    },
    vi: {
      title: "Nội dung phản hồi",
      body: "Quyết định loại nội dung phản hồi được lưu. Văn bản và JSON hữu ích để kiểm tra API; mọi loại văn bản phù hợp có thể gồm HTML, mã lệnh hoặc tài nguyên dạng văn bản.",
    },
  },
  "max-response-body-bytes-input": {
    en: {
      title: "Max response body bytes",
      body: "Limits stored response body size per request. Leave blank for no limit; use a value when API responses or HTML documents make network.json too large.",
    },
    vi: {
      title: "Số byte tối đa mỗi nội dung phản hồi",
      body: "Giới hạn kích thước nội dung phản hồi được lưu cho mỗi yêu cầu. Để trống để không giới hạn; nhập giá trị khi phản hồi API hoặc tài liệu HTML làm network.json quá lớn.",
    },
  },
  "capture-redirect-headers-input": {
    en: {
      title: "Redirect headers",
      body: "Stores redirect evidence. Location only is enough for most tester reports; full redacted helps when redirect behavior depends on cache or server headers.",
    },
    vi: {
      title: "Tiêu đề chuyển hướng",
      body: "Lưu thông tin chuyển hướng. Chỉ trường Location là đủ cho đa số báo cáo; chế độ đầy đủ đã che dữ liệu nhạy cảm hữu ích khi chuyển hướng phụ thuộc bộ nhớ đệm hoặc tiêu đề máy chủ.",
    },
  },
  "capture-initiator-input": {
    en: {
      title: "Initiator",
      body: "Shows what code or browser action started a request. This helps developers trace a bad API call back to a screen, component, or script.",
    },
    vi: {
      title: "Nguồn tạo yêu cầu",
      body: "Cho biết đoạn mã hoặc hành động nào đã tạo yêu cầu. Điều này giúp lần từ yêu cầu lỗi về màn hình, thành phần hoặc mã lệnh liên quan.",
    },
  },
  "suppress-recorder-internal-requests-input": {
    en: {
      title: "Suppress recorder internal requests",
      body: "GN Tracing now resolves only inline sourcemaps by default, so it does not create external sourcemap requests during recording. Keep this on for compatibility with capture modes that may hide recorder-created requests.",
    },
    vi: {
      title: "Ẩn yêu cầu nội bộ của trình ghi",
      body: "GN Tracing hiện chỉ phân giải source map nội tuyến theo mặc định, nên không tạo yêu cầu source map bên ngoài khi ghi. Nên bật để tương thích với các chế độ thu thập có thể ẩn yêu cầu do trình ghi tạo ra.",
    },
  },
  "capture-websockets-input": {
    en: {
      title: "Capture WebSocket artifact",
      body: "Stores WebSocket connection and message evidence. QC should enable this for chat, realtime dashboards, notifications, games, or live collaboration bugs.",
    },
    vi: {
      title: "Thu thập dữ liệu WebSocket",
      body: "Lưu thông tin kết nối và thông điệp WebSocket. Nên bật khi kiểm tra lỗi chat, bảng điều khiển thời gian thực, thông báo, trò chơi hoặc cộng tác trực tiếp.",
    },
  },
  "capture-websocket-frames-input": {
    en: {
      title: "Store WebSocket frame payloads",
      body: "Stores the actual message payloads sent over WebSocket. This is crucial for realtime bug reproduction but can contain sensitive or high-volume data.",
    },
    vi: {
      title: "Lưu dữ liệu khung WebSocket",
      body: "Lưu dữ liệu thực tế của thông điệp gửi qua WebSocket. Rất quan trọng để tái hiện lỗi thời gian thực nhưng có thể chứa dữ liệu nhạy cảm hoặc khối lượng lớn.",
    },
  },
  "max-websocket-frame-bytes-input": {
    en: {
      title: "Max frame bytes",
      body: "Limits each stored WebSocket frame payload. Leave blank for no limit; set a value when realtime traffic makes websocket.json too large.",
    },
    vi: {
      title: "Số byte tối đa mỗi khung",
      body: "Giới hạn dữ liệu của mỗi khung WebSocket được lưu. Để trống để không giới hạn; nhập giá trị khi lưu lượng thời gian thực làm websocket.json quá lớn.",
    },
  },
  "capture-websocket-initiator-input": {
    en: {
      title: "Store WebSocket initiator",
      body: "Stores where the WebSocket connection was opened. This helps developers find the screen or module that created a problematic realtime connection.",
    },
    vi: {
      title: "Lưu nguồn tạo WebSocket",
      body: "Lưu nơi kết nối WebSocket được mở. Điều này giúp tìm màn hình hoặc mô-đun tạo kết nối thời gian thực có vấn đề.",
    },
  },
  "capture-storage-input": {
    en: {
      title: "Capture storage snapshots",
      body: "Captures localStorage, sessionStorage, and cookies at recording start and stop so you can inspect how stored state changed. Off by default because storage often contains personal data, tokens, or session identifiers, and it adds a storage.json artifact to the package.",
    },
    vi: {
      title: "Thu thập ảnh chụp bộ nhớ lưu trữ",
      body: "Chụp localStorage, sessionStorage và cookie khi bắt đầu và kết thúc ghi để xem trạng thái lưu trữ thay đổi thế nào. Mặc định tắt vì bộ nhớ lưu trữ thường chứa dữ liệu cá nhân, mã thông báo hoặc mã phiên, và sẽ thêm storage.json vào gói.",
    },
  },
  "redact-storage-values-input": {
    en: {
      title: "Redact storage values",
      body: "Masks storage and cookie values whose keys match sensitive patterns (password, token, secret, ...). Keep this on so shared replays do not leak credentials.",
    },
    vi: {
      title: "Che giá trị bộ nhớ lưu trữ",
      body: "Che giá trị bộ nhớ lưu trữ và cookie khi khóa khớp mẫu nhạy cảm (mật khẩu, mã thông báo, bí mật, ...). Nên bật để bản phát lại chia sẻ không lộ thông tin xác thực.",
    },
  },
  "capture-dom-snapshots-input": {
    en: {
      title: "Capture DOM snapshots",
      body: "Captures a static DOM snapshot at start, stop, and key markers so you can inspect element structure at those moments. Off by default because DOM text can contain personal data and snapshots can grow large.",
    },
    vi: {
      title: "Thu thập ảnh chụp DOM",
      body: "Chụp DOM tĩnh khi bắt đầu, kết thúc và tại các mốc quan trọng để xem cấu trúc phần tử ở những thời điểm đó. Mặc định tắt vì văn bản DOM có thể chứa dữ liệu cá nhân và ảnh chụp có thể rất lớn.",
    },
  },
  "redact-dom-text-content-input": {
    en: {
      title: "Redact DOM text content",
      body: "Masks text and attribute values for DOM nodes that match your masking selectors before they enter the snapshot. Keep this on to avoid leaking sensitive on-screen content.",
    },
    vi: {
      title: "Che nội dung văn bản DOM",
      body: "Che văn bản và thuộc tính của các nút DOM khớp bộ chọn che trước khi đưa vào ảnh chụp. Nên bật để tránh lộ nội dung nhạy cảm trên màn hình.",
    },
  },
};

export interface SettingsFormController {
  load: () => Promise<void>;
  refreshFieldInfoLabels: () => void;
  destroy: () => void;
}

export interface AttachSettingsFormOptions {
  /** Container that owns the form controls (ids below must exist under it). */
  root: HTMLElement;
  /** Optional popover host for field help (`#setting-info-popover` markup). */
  infoPopover?: HTMLElement | null;
  getLanguage: () => UiLanguage;
  t: (key: string, replacements?: Record<string, string>) => string;
  showMessage: (message: string, success?: boolean) => void;
}

function requireEl<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const el = root.querySelector<T>(`#${id}`);
  if (!el) {
    throw new Error(`settings form missing #${id}`);
  }
  return el;
}

function withDefaultSettings(settings: Partial<UploadSettings>): UploadSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    folderInput: settings.folderInput ?? DEFAULT_SETTINGS.folderInput,
    folderId: settings.folderId ?? DEFAULT_SETTINGS.folderId,
    zipPasswordConfigured: settings.zipPasswordConfigured ?? DEFAULT_SETTINGS.zipPasswordConfigured,
    microphoneDeviceId: settings.microphoneDeviceId ?? DEFAULT_SETTINGS.microphoneDeviceId,
    speakerDeviceId: settings.speakerDeviceId ?? DEFAULT_SETTINGS.speakerDeviceId,
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
  };
}

/**
 * Wire load/save/render for the capture+privacy form under `root`.
 * Safe to call once per root; returns a controller for reload and cleanup.
 */
export function attachSettingsForm(options: AttachSettingsFormOptions): SettingsFormController {
  const { root, getLanguage, t, showMessage } = options;
  const infoPopover = options.infoPopover ?? null;
  const infoPopoverTitle = infoPopover?.querySelector<HTMLElement>("#setting-info-title") ?? null;
  const infoPopoverBody = infoPopover?.querySelector<HTMLElement>("#setting-info-body") ?? null;

  const redactSensitiveHeadersInput = requireEl<HTMLInputElement>(
    root,
    "redact-sensitive-headers-input",
  );
  const redactSensitiveQueryParamsInput = requireEl<HTMLInputElement>(
    root,
    "redact-sensitive-query-params-input",
  );
  const redactRequestBodyFieldsInput = requireEl<HTMLInputElement>(
    root,
    "redact-request-body-fields-input",
  );
  const redactResponseBodyFieldsInput = requireEl<HTMLInputElement>(
    root,
    "redact-response-body-fields-input",
  );
  const redactConsoleValuesInput = requireEl<HTMLInputElement>(root, "redact-console-values-input");
  const redactEventMetadataInput = requireEl<HTMLInputElement>(root, "redact-event-metadata-input");
  const redactWebSocketPayloadsInput = requireEl<HTMLSelectElement>(
    root,
    "redact-websocket-payloads-input",
  );
  const maskDomSelectorsInput = requireEl<HTMLTextAreaElement>(root, "mask-dom-selectors-input");

  const captureConsoleInput = requireEl<HTMLInputElement>(root, "capture-console-input");
  const captureConsoleArgsInput = requireEl<HTMLInputElement>(root, "capture-console-args-input");
  const consolePreviewDepthInput = requireEl<HTMLSelectElement>(
    root,
    "console-preview-depth-input",
  );
  const captureConsoleStacksInput = requireEl<HTMLSelectElement>(
    root,
    "capture-console-stacks-input",
  );
  const captureConsoleSourceSnippetsInput = requireEl<HTMLSelectElement>(
    root,
    "capture-console-source-snippets-input",
  );
  const maxConsoleEntryBytesInput = requireEl<HTMLInputElement>(
    root,
    "max-console-entry-bytes-input",
  );

  const captureNetworkInput = requireEl<HTMLInputElement>(root, "capture-network-input");
  const captureRequestHeadersInput = requireEl<HTMLSelectElement>(
    root,
    "capture-request-headers-input",
  );
  const captureResponseHeadersInput = requireEl<HTMLSelectElement>(
    root,
    "capture-response-headers-input",
  );
  const captureRequestBodiesInput = requireEl<HTMLInputElement>(
    root,
    "capture-request-bodies-input",
  );
  const captureResponseBodyModeInput = requireEl<HTMLSelectElement>(
    root,
    "capture-response-body-mode-input",
  );
  const maxResponseBodyBytesInput = requireEl<HTMLInputElement>(
    root,
    "max-response-body-bytes-input",
  );
  const captureRedirectHeadersInput = requireEl<HTMLSelectElement>(
    root,
    "capture-redirect-headers-input",
  );
  const captureInitiatorInput = requireEl<HTMLSelectElement>(root, "capture-initiator-input");
  const suppressRecorderInternalRequestsInput = requireEl<HTMLInputElement>(
    root,
    "suppress-recorder-internal-requests-input",
  );

  const captureWebSocketsInput = requireEl<HTMLInputElement>(root, "capture-websockets-input");
  const captureWebSocketFramesInput = requireEl<HTMLInputElement>(
    root,
    "capture-websocket-frames-input",
  );
  const maxWebSocketFrameBytesInput = requireEl<HTMLInputElement>(
    root,
    "max-websocket-frame-bytes-input",
  );
  const captureWebSocketInitiatorInput = requireEl<HTMLInputElement>(
    root,
    "capture-websocket-initiator-input",
  );

  const captureStorageInput = requireEl<HTMLInputElement>(root, "capture-storage-input");
  const redactStorageValuesInput = requireEl<HTMLInputElement>(root, "redact-storage-values-input");
  const captureDomSnapshotsInput = requireEl<HTMLInputElement>(root, "capture-dom-snapshots-input");
  const redactDomTextContentInput = requireEl<HTMLInputElement>(
    root,
    "redact-dom-text-content-input",
  );

  let activeInfoHelpKey: string | null = null;
  let activeInfoButton: HTMLButtonElement | null = null;
  const abort = new AbortController();
  const { signal } = abort;

  function isPopoverOpen(element: HTMLElement): boolean {
    return element.matches(":popover-open");
  }

  function getOptionalNumber(input: HTMLInputElement): number | null {
    if (input.value.trim() === "") {
      return null;
    }
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
  }

  function getLabelForHelpKey(helpKey: string): string {
    const label = root
      .querySelector(`[for="${helpKey}"] [data-i18n], #${helpKey}`)
      ?.closest("label");
    const labelText = label?.querySelector("[data-i18n]")?.textContent?.trim();
    return labelText || t("info.dialogTitleFallback");
  }

  function fillInfoPopover(helpKey: string): void {
    if (!infoPopoverTitle || !infoPopoverBody) {
      return;
    }
    const lang = getLanguage();
    const help = FIELD_HELP[helpKey]?.[lang] || FIELD_HELP[helpKey]?.en;
    infoPopoverTitle.textContent = help?.title || getLabelForHelpKey(helpKey);
    infoPopoverBody.textContent = help?.body || t("info.dialogTitleFallback");
  }

  function positionInfoPopover(anchor: HTMLElement): void {
    if (!infoPopover) {
      return;
    }
    const gap = 8;
    const margin = 12;
    const rect = anchor.getBoundingClientRect();
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
    if (infoPopover && isPopoverOpen(infoPopover)) {
      infoPopover.hidePopover();
    }
    if (activeInfoButton) {
      activeInfoButton.setAttribute("aria-expanded", "false");
    }
    activeInfoHelpKey = null;
    activeInfoButton = null;
  }

  function openInfoPopover(helpKey: string, anchor: HTMLButtonElement): void {
    if (!infoPopover || !infoPopoverTitle || !infoPopoverBody) {
      return;
    }
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

  function addFieldInfoButton(label: HTMLLabelElement, helpKey: string): void {
    if (label.querySelector(".field-info-btn")) {
      return;
    }

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
    if (infoPopover?.id) {
      button.setAttribute("aria-controls", infoPopover.id);
    }
    button.title = t("info.buttonLabel");
    labelRow.appendChild(button);
  }

  function setupFieldInfoButtons(): void {
    root
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

  function refreshFieldInfoLabels(): void {
    root.querySelectorAll<HTMLButtonElement>(".field-info-btn").forEach((button) => {
      button.setAttribute("aria-label", t("info.buttonLabel"));
      button.title = t("info.buttonLabel");
    });
    if (activeInfoHelpKey && infoPopover && isPopoverOpen(infoPopover) && activeInfoButton) {
      fillInfoPopover(activeInfoHelpKey);
      positionInfoPopover(activeInfoButton);
    }
  }

  // When network/request capture is on, storage and DOM capture are forced on and
  // their checkboxes are locked to reflect that they cannot be turned off
  // independently. Mirrors the data-layer coupling in settings-store.ts.
  function syncInspectorCaptureCoupling(): void {
    const coupled = captureNetworkInput.checked;
    if (coupled) {
      captureStorageInput.checked = true;
      captureDomSnapshotsInput.checked = true;
    }
    captureStorageInput.disabled = coupled;
    captureDomSnapshotsInput.disabled = coupled;
  }

  function renderSettings(settings: UploadSettings): void {
    const normalizedSettings = withDefaultSettings(settings);

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
    syncInspectorCaptureCoupling();
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

  function getSectionPayload(section: SettingsSectionId): Record<string, unknown> {
    if (section === "privacy") {
      return getPrivacySectionPayload();
    }
    return getCaptureSectionPayload();
  }

  async function load(): Promise<void> {
    try {
      const result = (await chrome.runtime.sendMessage({
        action: "GET_SETTINGS",
      })) as MessageResponse & { settings?: UploadSettings };
      if (!result.ok || !result.settings) {
        showMessage(result.error || t("messages.loadFailed"), false);
        return;
      }
      renderSettings(result.settings);
    } catch (error) {
      showMessage((error as Error).message, false);
    }
  }

  async function saveSection(section: SettingsSectionId, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.classList.add("is-saving");
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", t("actions.savingSection"));
    button.title = t("actions.savingSection");
    try {
      const result = (await chrome.runtime.sendMessage({
        action: "UPDATE_SETTINGS",
        data: getSectionPayload(section),
      })) as MessageResponse & { settings?: UploadSettings; message?: string };
      if (!result.ok || !result.settings) {
        showMessage(result.error || t("messages.saveFailed"), false);
        return;
      }
      renderSettings(result.settings);
      if (typeof result.message === "string" && result.message.trim()) {
        showMessage(result.message, false);
        return;
      }
      showMessage(t("messages.sectionSaved"), true);
    } catch (error) {
      showMessage((error as Error).message, false);
    } finally {
      button.disabled = false;
      button.classList.remove("is-saving");
      button.removeAttribute("aria-busy");
      button.setAttribute("aria-label", t("actions.saveSection"));
      button.title = t("actions.saveSection");
    }
  }

  root.addEventListener(
    "change",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.getAttribute("id") === "capture-network-input") {
        syncInspectorCaptureCoupling();
      }
    },
    { signal },
  );

  root.querySelectorAll<HTMLButtonElement>(".settings-section-save").forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        const section = button.dataset.section as SettingsSectionId | undefined;
        if (section === "privacy" || section === "capture") {
          void saveSection(section, button);
        }
      },
      { signal },
    );
  });

  root.addEventListener(
    "click",
    (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".field-info-btn");
      if (!button?.dataset.helpKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openInfoPopover(button.dataset.helpKey, button);
    },
    { signal },
  );

  if (infoPopover) {
    infoPopover.addEventListener(
      "toggle",
      (event) => {
        const toggleEvent = event as ToggleEvent;
        if (toggleEvent.newState === "closed" && activeInfoButton) {
          activeInfoButton.setAttribute("aria-expanded", "false");
          activeInfoHelpKey = null;
          activeInfoButton = null;
        }
      },
      { signal },
    );
  }

  window.addEventListener(
    "resize",
    () => {
      if (activeInfoButton && infoPopover && isPopoverOpen(infoPopover)) {
        positionInfoPopover(activeInfoButton);
      }
    },
    { passive: true, signal },
  );

  window.addEventListener(
    "scroll",
    () => {
      if (activeInfoButton && infoPopover && isPopoverOpen(infoPopover)) {
        positionInfoPopover(activeInfoButton);
      }
    },
    { passive: true, capture: true, signal },
  );

  setupFieldInfoButtons();

  return {
    load,
    refreshFieldInfoLabels,
    destroy: () => {
      closeInfoPopover();
      abort.abort();
    },
  };
}

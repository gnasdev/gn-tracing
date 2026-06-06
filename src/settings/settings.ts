/**
 * Manages the full-page settings surface for Drive, package, and capture controls.
 */

import { getPrivacyProfileSettings, normalizeMaskDomSelectors } from "../shared/privacy-redaction";
import { attachThemeToggle } from "../shared/theme";
import type {
  CaptureProfile,
  MessageResponse,
  PrivacyProfile,
  PrivacyRedactionSettings,
  UploadHistoryEntry,
  UploadSettings,
} from "../types/messages";

const DEFAULT_SETTINGS: UploadSettings = {
  folderInput: "/gn-tracing",
  folderId: null,
  zipPasswordConfigured: false,
  captureProfile: "full",
  ...getPrivacyProfileSettings("standard"),
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
};

type CapturePresetSettings = Omit<
  UploadSettings,
  | "folderInput"
  | "folderId"
  | "zipPasswordConfigured"
  | "captureProfile"
  | keyof PrivacyRedactionSettings
>;

function getCapturePresetSettings(
  profile: Exclude<CaptureProfile, "custom">,
): CapturePresetSettings {
  if (profile === "lean") {
    return {
      captureConsole: true,
      captureConsoleArgs: false,
      consolePreviewDepth: "none",
      captureConsoleStacks: "errors",
      captureConsoleSourceSnippets: "errors",
      maxConsoleEntryBytes: 16384,
      captureNetwork: true,
      captureRequestHeaders: "minimal",
      captureResponseHeaders: "minimal",
      captureRequestBodies: false,
      captureResponseBodies: false,
      captureResponseBodyMode: "off",
      maxResponseBodyBytes: 0,
      captureRedirectHeaders: "location",
      captureInitiator: "summary",
      suppressRecorderInternalRequests: true,
      captureWebSockets: true,
      captureWebSocketFrames: false,
      maxWebSocketFrameBytes: 0,
      captureWebSocketInitiator: false,
    };
  }

  if (profile === "balanced") {
    return {
      captureConsole: true,
      captureConsoleArgs: true,
      consolePreviewDepth: "shallow",
      captureConsoleStacks: "warnings-errors",
      captureConsoleSourceSnippets: "warnings-errors",
      maxConsoleEntryBytes: 32768,
      captureNetwork: true,
      captureRequestHeaders: "full",
      captureResponseHeaders: "full",
      captureRequestBodies: true,
      captureResponseBodies: true,
      captureResponseBodyMode: "eligible",
      maxResponseBodyBytes: 1024 * 1024,
      captureRedirectHeaders: "location",
      captureInitiator: "summary",
      suppressRecorderInternalRequests: true,
      captureWebSockets: true,
      captureWebSocketFrames: true,
      maxWebSocketFrameBytes: 65536,
      captureWebSocketInitiator: false,
    };
  }

  return {
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
  };
}

type SettingsLanguage = "en" | "vi";

const LANGUAGE_STORAGE_KEY = "gn_tracing_settings_language";

const TRANSLATIONS: Record<SettingsLanguage, Record<string, string>> = {
  en: {
    "page.title": "Settings",
    "page.lead": "Choose what each recording captures before you start a session.",
    "language.toggleTo": "Tiếng Việt",
    "actions.save": "Save Settings",
    "sections.captureProfile": "Capture Profile",
    "sections.privacyRedaction": "Privacy & Redaction",
    "sections.privacyData": "Data redaction",
    "sections.visualMasking": "Visual masking",
    "sections.googleDrive": "Google Drive",
    "sections.packageSecurity": "Package Security",
    "sections.console": "Console",
    "sections.network": "Network",
    "sections.websocket": "WebSocket",
    "profile.lean.label": "Lean",
    "profile.lean.help": "Metadata, minimal headers, compact console, no bodies.",
    "profile.balanced.label": "Balanced",
    "profile.balanced.help": "Useful debug details with bounded payloads.",
    "profile.full.label": "Full debug",
    "profile.full.help": "Maximum detail with blank byte limits.",
    "profile.custom.label": "Custom",
    "profile.custom.help": "Use the advanced choices below.",
    "privacy.standard.label": "Standard",
    "privacy.standard.help": "Redact high-confidence secrets across artifacts.",
    "privacy.strict.label": "Strict",
    "privacy.strict.help": "Also redact personal and opaque identifiers.",
    "privacy.custom.label": "Custom",
    "privacy.custom.help": "Use the privacy choices below.",
    "fields.folder.label": "Upload folder",
    "fields.zipPassword.label": "Zip password",
    "fields.clearZipPassword.label": "Clear configured zip password",
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
    "hints.folderDefault": "Using Google Drive folder: /gn-tracing.",
    "hints.folderRoot": "Using your Google Drive root folder.",
    "hints.folderPath": "Using Google Drive folder: {value}.",
    "hints.folderId": "Resolved folder ID: {value}",
    "hints.zipPasswordConfigured": "A zip password is configured for new uploads.",
    "hints.zipPasswordNone": "New uploads will not require a zip password.",
    "hints.visualMasking":
      "Selectors are applied before capture when possible. They do not cover canvas, video, or closed shadow DOM.",
    "messages.settingsSaved": "Settings saved.",
    "messages.profileSaved": "Capture profile saved.",
    "messages.privacyProfileSaved": "Privacy profile saved.",
    "messages.loadFailed": "Failed to load settings",
    "messages.saveFailed": "Failed to save settings",
    "messages.profileFailed": "Failed to save profile",
    "messages.privacyProfileFailed": "Failed to save privacy profile",
    "info.buttonLabel": "Explain this field",
    "info.dialogTitleFallback": "Setting help",
  },
  vi: {
    "page.title": "Cài đặt",
    "page.lead": "Chọn dữ liệu cần capture trước khi bắt đầu phiên ghi.",
    "language.toggleTo": "English",
    "actions.save": "Lưu cài đặt",
    "sections.captureProfile": "Hồ sơ capture",
    "sections.privacyRedaction": "Privacy & Redaction",
    "sections.privacyData": "Che dữ liệu",
    "sections.visualMasking": "Che giao diện",
    "sections.googleDrive": "Google Drive",
    "sections.packageSecurity": "Bảo mật gói",
    "sections.console": "Console",
    "sections.network": "Network",
    "sections.websocket": "WebSocket",
    "profile.lean.label": "Gọn nhẹ",
    "profile.lean.help": "Metadata, header tối thiểu, console gọn, không lưu body.",
    "profile.balanced.label": "Cân bằng",
    "profile.balanced.help": "Đủ dữ liệu debug phổ biến với payload có giới hạn.",
    "profile.full.label": "Debug đầy đủ",
    "profile.full.help": "Giữ tối đa chi tiết, các giới hạn byte để trống.",
    "profile.custom.label": "Tùy chỉnh",
    "profile.custom.help": "Dùng các lựa chọn chi tiết bên dưới.",
    "privacy.standard.label": "Chuẩn",
    "privacy.standard.help": "Che các secret có độ chắc cao trong artifacts.",
    "privacy.strict.label": "Nghiêm ngặt",
    "privacy.strict.help": "Che thêm thông tin cá nhân và định danh dài.",
    "privacy.custom.label": "Tùy chỉnh",
    "privacy.custom.help": "Dùng các lựa chọn privacy bên dưới.",
    "fields.folder.label": "Thư mục upload",
    "fields.zipPassword.label": "Mật khẩu zip",
    "fields.clearZipPassword.label": "Xóa mật khẩu zip đã cấu hình",
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
    "hints.folderDefault": "Đang dùng thư mục Google Drive: /gn-tracing.",
    "hints.folderRoot": "Đang dùng thư mục gốc Google Drive.",
    "hints.folderPath": "Đang dùng thư mục Google Drive: {value}.",
    "hints.folderId": "Folder ID đã resolve: {value}",
    "hints.zipPasswordConfigured": "Đã cấu hình mật khẩu zip cho các upload mới.",
    "hints.zipPasswordNone": "Các upload mới sẽ không yêu cầu mật khẩu zip.",
    "hints.visualMasking":
      "Selector được áp dụng trước khi capture nếu có thể. Không che canvas, video hoặc closed shadow DOM.",
    "messages.settingsSaved": "Đã lưu cài đặt.",
    "messages.profileSaved": "Đã lưu hồ sơ capture.",
    "messages.privacyProfileSaved": "Đã lưu hồ sơ privacy.",
    "messages.loadFailed": "Không tải được cài đặt",
    "messages.saveFailed": "Không lưu được cài đặt",
    "messages.profileFailed": "Không lưu được hồ sơ capture",
    "messages.privacyProfileFailed": "Không lưu được hồ sơ privacy",
    "info.buttonLabel": "Giải thích field này",
    "info.dialogTitleFallback": "Giải thích cài đặt",
  },
};

const FIELD_HELP: Record<string, Record<SettingsLanguage, { title: string; body: string }>> = {
  "profile:lean": {
    en: {
      title: "Lean profile",
      body: "Use this when a tester only needs the replay flow, basic errors, and request metadata. It keeps packages smaller but may miss request bodies or detailed payload evidence.",
    },
    vi: {
      title: "Hồ sơ gọn nhẹ",
      body: "Dùng khi tester chỉ cần replay flow, lỗi cơ bản và metadata request. Gói sẽ nhỏ hơn nhưng có thể thiếu request body hoặc bằng chứng payload chi tiết.",
    },
  },
  "profile:balanced": {
    en: {
      title: "Balanced profile",
      body: "Use this for most QC sessions. It keeps common debug evidence such as headers, selected bodies, WebSocket payloads, and warning/error context without collecting every possible detail.",
    },
    vi: {
      title: "Hồ sơ cân bằng",
      body: "Phù hợp cho đa số phiên QC. Chế độ này giữ các bằng chứng debug thường dùng như headers, một phần body, payload WebSocket và ngữ cảnh warning/error mà không gom mọi chi tiết.",
    },
  },
  "profile:full": {
    en: {
      title: "Full debug profile",
      body: "Use this for hard-to-reproduce bugs or internal debugging. It captures the most detail and leaves byte limits blank, so package size can grow quickly on busy pages.",
    },
    vi: {
      title: "Hồ sơ debug đầy đủ",
      body: "Dùng cho bug khó tái hiện hoặc debug nội bộ. Chế độ này capture nhiều chi tiết nhất và để trống giới hạn byte, nên package có thể lớn nhanh trên trang nhiều dữ liệu.",
    },
  },
  "profile:custom": {
    en: {
      title: "Custom profile",
      body: "Use this when a tester needs a specific evidence set, such as full headers but no response bodies. Changing any advanced field switches the profile to Custom.",
    },
    vi: {
      title: "Hồ sơ tùy chỉnh",
      body: "Dùng khi tester cần bộ bằng chứng cụ thể, ví dụ giữ full headers nhưng không lưu response bodies. Khi chỉnh field nâng cao, profile sẽ chuyển sang Tùy chỉnh.",
    },
  },
  "folder-input": {
    en: {
      title: "Upload folder",
      body: "Controls where recording packages are uploaded in Google Drive. QC can use a shared folder path, folder ID, or Drive folder link so reports are grouped by project or test run.",
    },
    vi: {
      title: "Thư mục upload",
      body: "Quyết định nơi upload recording package trong Google Drive. QC có thể dùng đường dẫn thư mục chung, folder ID hoặc link Drive để gom report theo dự án hoặc test run.",
    },
  },
  "zip-password-input": {
    en: {
      title: "Zip password",
      body: "Adds a password to new recording zips. Use it when recordings may contain customer data, tokens, request bodies, or other sensitive test evidence.",
    },
    vi: {
      title: "Mật khẩu zip",
      body: "Thêm mật khẩu cho các file zip recording mới. Dùng khi recording có thể chứa dữ liệu khách hàng, token, request body hoặc bằng chứng test nhạy cảm.",
    },
  },
  "clear-zip-password-input": {
    en: {
      title: "Clear zip password",
      body: "Removes the saved password for future uploads. Existing password-protected recordings keep their original password.",
    },
    vi: {
      title: "Xóa mật khẩu zip",
      body: "Xóa mật khẩu đã lưu cho các upload sau này. Những recording đã được bảo vệ bằng mật khẩu trước đó vẫn giữ mật khẩu cũ.",
    },
  },
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
};

const saveBtn = document.getElementById("save-settings-btn") as HTMLButtonElement;
const errorMsg = document.getElementById("error-msg")!;
const languageToggleBtn = document.getElementById("language-toggle-btn") as HTMLButtonElement;
const infoDialog = document.getElementById("setting-info-dialog") as HTMLDialogElement;
const infoDialogTitle = document.getElementById("setting-info-title")!;
const infoDialogBody = document.getElementById("setting-info-body")!;
const folderInput = document.getElementById("folder-input") as HTMLInputElement;
const folderHint = document.getElementById("folder-hint")!;
const zipPasswordInput = document.getElementById("zip-password-input") as HTMLInputElement;
const clearZipPasswordInput = document.getElementById(
  "clear-zip-password-input",
) as HTMLInputElement;
const zipPasswordHint = document.getElementById("zip-password-hint")!;

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

let currentSettings: UploadSettings | null = null;
let currentLanguage: SettingsLanguage = getInitialLanguage();
let lastProfileSaveRequest: { profile: string; requestedAt: number } | null = null;
let lastPrivacyProfileSaveRequest: { profile: string; requestedAt: number } | null = null;

function getInitialLanguage(): SettingsLanguage {
  const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (saved === "en" || saved === "vi") {
    return saved;
  }
  return navigator.language.toLowerCase().startsWith("vi") ? "vi" : "en";
}

function t(key: string, replacements: Record<string, string> = {}): string {
  const template = TRANSLATIONS[currentLanguage][key] || TRANSLATIONS.en[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}

function getLabelForHelpKey(helpKey: string): string {
  if (helpKey.startsWith("profile:")) {
    return t(`profile.${helpKey.slice("profile:".length)}.label`);
  }

  const label = document
    .querySelector(`[for="${helpKey}"] [data-i18n], #${helpKey}`)
    ?.closest("label");
  const labelText = label?.querySelector("[data-i18n]")?.textContent?.trim();
  return labelText || t("info.dialogTitleFallback");
}

function applyTranslations(): void {
  document.documentElement.lang = currentLanguage;
  languageToggleBtn.textContent = t("language.toggleTo");

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

  if (currentSettings) {
    updateFolderHint(currentSettings);
    updateZipPasswordHint(currentSettings);
  }
}

function addFieldInfoButton(label: HTMLLabelElement, helpKey: string): void {
  if (label.querySelector(".field-info-btn")) {
    return;
  }

  const labelText = label.querySelector<HTMLElement>("span[data-i18n]");
  if (!labelText) {
    return;
  }

  const hasHelp = FIELD_HELP[helpKey]?.en || FIELD_HELP[helpKey]?.vi;
  if (!hasHelp) {
    return;
  }
  const button = document.createElement("button");
  button.className = "field-info-btn";
  button.type = "button";
  button.dataset.helpKey = helpKey;
  button.textContent = "i";
  button.setAttribute("aria-label", t("info.buttonLabel"));
  button.title = t("info.buttonLabel");
  labelText.insertAdjacentElement("afterend", button);
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

function openInfoDialog(helpKey: string): void {
  const help = FIELD_HELP[helpKey]?.[currentLanguage] || FIELD_HELP[helpKey]?.en;
  infoDialogTitle.textContent = help?.title || getLabelForHelpKey(helpKey);
  infoDialogBody.textContent = help?.body || t("info.dialogTitleFallback");
  infoDialog.showModal();
}

function withDefaultSettings(settings: Partial<UploadSettings>): UploadSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    folderInput: settings.folderInput ?? DEFAULT_SETTINGS.folderInput,
    folderId: settings.folderId ?? DEFAULT_SETTINGS.folderId,
    zipPasswordConfigured: settings.zipPasswordConfigured ?? DEFAULT_SETTINGS.zipPasswordConfigured,
    captureProfile: settings.captureProfile ?? DEFAULT_SETTINGS.captureProfile,
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
  };
}

function showMessage(message: string, success = false): void {
  errorMsg.textContent = message;
  errorMsg.className = success ? "success-msg" : "";
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), success ? 2200 : 5000);
}

function getProfileInput(): HTMLInputElement {
  return document.querySelector('input[name="capture-profile"]:checked') as HTMLInputElement;
}

function getPrivacyProfileInput(): HTMLInputElement {
  return document.querySelector('input[name="privacy-profile"]:checked') as HTMLInputElement;
}

function setProfile(profile: string): void {
  const input = document.querySelector(
    `input[name="capture-profile"][value="${profile}"]`,
  ) as HTMLInputElement | null;
  if (input) {
    input.checked = true;
  }
}

function setPrivacyProfile(profile: string): void {
  const input = document.querySelector(
    `input[name="privacy-profile"][value="${profile}"]`,
  ) as HTMLInputElement | null;
  if (input) {
    input.checked = true;
  }
}

function getOptionalNumber(input: HTMLInputElement): number | null {
  if (input.value.trim() === "") {
    return null;
  }
  const value = Number(input.value);
  return Number.isFinite(value) ? value : null;
}

function updateFolderHint(settings: UploadSettings): void {
  if (settings.folderId) {
    folderHint.textContent = t("hints.folderId", { value: settings.folderId });
    return;
  }
  folderHint.textContent =
    settings.folderInput && settings.folderInput !== "/"
      ? t("hints.folderPath", { value: settings.folderInput })
      : t("hints.folderRoot");
}

function updateZipPasswordHint(settings: UploadSettings): void {
  zipPasswordHint.textContent = settings.zipPasswordConfigured
    ? t("hints.zipPasswordConfigured")
    : t("hints.zipPasswordNone");
}

function renderSettings(settings: UploadSettings): void {
  const normalizedSettings = withDefaultSettings(settings);
  currentSettings = normalizedSettings;
  setProfile(normalizedSettings.captureProfile);
  setPrivacyProfile(normalizedSettings.privacyProfile);
  folderInput.value = normalizedSettings.folderInput || "/";
  updateFolderHint(normalizedSettings);
  zipPasswordInput.value = "";
  clearZipPasswordInput.checked = false;
  updateZipPasswordHint(normalizedSettings);

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
}

function getSettingsPayload(): Record<string, unknown> {
  const zipPassword = zipPasswordInput.value;
  const captureProfile = getProfileInput()?.value || "custom";
  const privacyProfile = getPrivacyProfileInput()?.value || "custom";
  const payload: Record<string, unknown> = {
    folderInput: folderInput.value.trim() === "/" ? "" : folderInput.value.trim(),
    ...(zipPassword ? { zipPassword } : {}),
    clearZipPassword: clearZipPasswordInput.checked,
    captureProfile,
    privacyProfile,
  };

  if (privacyProfile === "custom") {
    Object.assign(payload, {
      redactSensitiveHeaders: redactSensitiveHeadersInput.checked,
      redactSensitiveQueryParams: redactSensitiveQueryParamsInput.checked,
      redactRequestBodyFields: redactRequestBodyFieldsInput.checked,
      redactResponseBodyFields: redactResponseBodyFieldsInput.checked,
      redactConsoleValues: redactConsoleValuesInput.checked,
      redactWebSocketPayloads: redactWebSocketPayloadsInput.value,
      redactEventMetadata: redactEventMetadataInput.checked,
      maskDomSelectors: normalizeMaskDomSelectors(maskDomSelectorsInput.value),
    });
  }

  if (captureProfile !== "custom") {
    return payload;
  }

  return {
    ...payload,
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

async function saveSettings(): Promise<void> {
  saveBtn.disabled = true;
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: getSettingsPayload(),
    })) as MessageResponse & { settings?: UploadSettings };
    if (!result.ok || !result.settings) {
      showMessage(result.error || t("messages.saveFailed"));
      return;
    }
    renderSettings(result.settings);
    showMessage(t("messages.settingsSaved"), true);
  } catch (error) {
    showMessage((error as Error).message);
  } finally {
    saveBtn.disabled = false;
  }
}

async function saveProfile(profile: string): Promise<void> {
  const captureProfile = profile as CaptureProfile;
  const previousSettings = currentSettings;
  saveBtn.disabled = true;
  if (captureProfile !== "custom") {
    // Apply the preset locally before the async save so the selected card and advanced fields switch together.
    renderSettings({
      ...withDefaultSettings(currentSettings || DEFAULT_SETTINGS),
      ...getCapturePresetSettings(captureProfile),
      captureProfile,
    });
  }
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { captureProfile },
    })) as MessageResponse & { settings?: UploadSettings };
    if (!result.ok || !result.settings) {
      if (previousSettings) {
        renderSettings(previousSettings);
      }
      showMessage(result.error || t("messages.profileFailed"));
      return;
    }
    renderSettings(result.settings);
    showMessage(t("messages.profileSaved"), true);
  } catch (error) {
    if (previousSettings) {
      renderSettings(previousSettings);
    }
    showMessage((error as Error).message);
  } finally {
    saveBtn.disabled = false;
  }
}

async function savePrivacyProfile(profile: string): Promise<void> {
  const privacyProfile = profile as PrivacyProfile;
  const previousSettings = currentSettings;
  saveBtn.disabled = true;
  if (privacyProfile !== "custom") {
    renderSettings({
      ...withDefaultSettings(currentSettings || DEFAULT_SETTINGS),
      ...getPrivacyProfileSettings(privacyProfile),
      privacyProfile,
    });
  }
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { privacyProfile },
    })) as MessageResponse & { settings?: UploadSettings };
    if (!result.ok || !result.settings) {
      if (previousSettings) {
        renderSettings(previousSettings);
      }
      showMessage(result.error || t("messages.privacyProfileFailed"));
      return;
    }
    renderSettings(result.settings);
    showMessage(t("messages.privacyProfileSaved"), true);
  } catch (error) {
    if (previousSettings) {
      renderSettings(previousSettings);
    }
    showMessage((error as Error).message);
  } finally {
    saveBtn.disabled = false;
  }
}

function requestProfileSave(input: HTMLInputElement): void {
  if (input.value === "custom") {
    return;
  }

  const now = Date.now();
  if (
    lastProfileSaveRequest?.profile === input.value &&
    now - lastProfileSaveRequest.requestedAt < 100
  ) {
    return;
  }
  lastProfileSaveRequest = { profile: input.value, requestedAt: now };
  void saveProfile(input.value);
}

function requestPrivacyProfileSave(input: HTMLInputElement): void {
  if (input.value === "custom") {
    return;
  }

  const now = Date.now();
  if (
    lastPrivacyProfileSaveRequest?.profile === input.value &&
    now - lastPrivacyProfileSaveRequest.requestedAt < 100
  ) {
    return;
  }
  lastPrivacyProfileSaveRequest = { profile: input.value, requestedAt: now };
  void savePrivacyProfile(input.value);
}

document.querySelectorAll<HTMLLabelElement>(".profile-option").forEach((label) => {
  label.addEventListener("click", () => {
    const input = label.querySelector<HTMLInputElement>('input[name="capture-profile"]');
    if (!input) {
      const privacyInput = label.querySelector<HTMLInputElement>('input[name="privacy-profile"]');
      if (!privacyInput) {
        return;
      }
      privacyInput.checked = true;
      requestPrivacyProfileSave(privacyInput);
      return;
    }
    input.checked = true;
    requestProfileSave(input);
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="capture-profile"]').forEach((input) => {
  input.addEventListener("change", () => {
    requestProfileSave(input);
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="privacy-profile"]').forEach((input) => {
  input.addEventListener("change", () => {
    requestPrivacyProfileSave(input);
  });
});

document.querySelectorAll("input, select, textarea").forEach((input) => {
  input.addEventListener("change", () => {
    const profile = getProfileInput();
    const privacyProfile = getPrivacyProfileInput();
    const inputName = input.getAttribute("name");
    const inputId = input.getAttribute("id") || "";
    if (
      profile &&
      profile.value !== "custom" &&
      inputName !== "capture-profile" &&
      inputName !== "privacy-profile" &&
      !inputId.startsWith("redact-") &&
      inputId !== "mask-dom-selectors-input"
    ) {
      setProfile("custom");
    }
    if (
      privacyProfile &&
      privacyProfile.value !== "custom" &&
      inputName !== "privacy-profile" &&
      (inputId.startsWith("redact-") || inputId === "mask-dom-selectors-input")
    ) {
      setPrivacyProfile("custom");
    }
  });
});

saveBtn.addEventListener("click", () => {
  void saveSettings();
});

languageToggleBtn.addEventListener("click", () => {
  currentLanguage = currentLanguage === "en" ? "vi" : "en";
  localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguage);
  applyTranslations();
});

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".field-info-btn");
  if (!button?.dataset.helpKey) {
    return;
  }
  event.preventDefault();
  openInfoDialog(button.dataset.helpKey);
});

infoDialog.addEventListener("click", (event) => {
  if (event.target === infoDialog) {
    infoDialog.close();
  }
});

setupFieldInfoButtons();
applyTranslations();
void loadSettings();

attachThemeToggle("theme-toggle-btn", "theme-toggle-icon");

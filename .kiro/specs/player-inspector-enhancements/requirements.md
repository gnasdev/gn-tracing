# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho feature `player-inspector-enhancements` — 4 hạng mục mở rộng năng lực debug theo phong cách [eruda](https://github.com/liriliri/eruda) / [chii](https://github.com/liriliri/chii) cho hệ thống GN Tracing (extension MV3 + standalone replay player). Requirements được suy ra (derived) từ `design.md` theo luồng design-first.

Phần diễn giải dùng tiếng Việt; code/type/identifier, từ khóa EARS (WHEN/IF/THEN/SHALL) và thuật ngữ kỹ thuật giữ tiếng Anh để đồng bộ với codebase và design.

Phạm vi gồm 4 hạng mục (theo thứ tự triển khai khuyến nghị) cộng với các nền tảng dùng chung:

| Thứ tự | Hạng mục | Requirement liên quan |
| --- | --- | --- |
| Nền tảng | Privacy-first, redaction, pipeline, licensing | R1, R2, R3 |
| 1 (làm trước) | Item 2 — Resources/Storage panel | R4, R5 |
| 2 | Item 1 — luna-* UI components | R6 |
| 3 | Item 3 — Elements/DOM snapshot panel | R7, R8 |
| 4 (dài hạn) | Item 4 — Low-friction in-page capture mode | R9 |

Quy ước traceability: mỗi acceptance criterion được đánh số `R<requirement>.<criterion>` (ví dụ `R4.1`). Các Correctness Properties trong `design.md` tham chiếu ngược về các id này qua dòng `Validates: Requirements X.Y`.

## Requirements

### Requirement 1: Privacy-first defaults và nền tảng redaction (shared)

**User Story:** Là người dùng ghi lại session để chia sẻ, tôi muốn mọi capture nhạy cảm mặc định tắt và được redact mạnh khi bật, để không vô tình lộ dữ liệu cá nhân hoặc credential trong bản replay chia sẻ.

#### Acceptance Criteria

1. WHEN một recording bắt đầu mà người dùng chưa thay đổi cài đặt, THEN system SHALL giữ `captureStorage` và `captureDomSnapshots` ở giá trị mặc định `false`.
2. WHEN `captureStorage === false`, THEN system SHALL NOT gọi các lệnh CDP storage và SHALL NOT tạo artifact `storage` (`sessionArtifacts[id].storage === undefined`).
3. WHEN `captureDomSnapshots === false`, THEN system SHALL NOT gọi `DOMSnapshot.captureSnapshot` và SHALL NOT tạo artifact `dom` (`sessionArtifacts[id].dom === undefined`).
4. WHEN một storage value hoặc cookie có key khớp sensitive pattern qua `classifyKey` và `redactStorageValues === true`, THEN system SHALL thay value bằng `REDACTED_VALUE` và đánh dấu `redacted === true` trước khi đưa vào artifact.
5. WHEN một node DOM khớp một selector trong `maskDomSelectors`, THEN system SHALL mask `nodeValue`/attribute values của node đó và set `masked === true` trước khi đưa vào artifact.
6. THEN system SHALL mở rộng union `RedactionArtifact` để bao gồm `"storage"` và `"dom"`, và SHALL ghi nhận redaction hit theo đúng `artifact` tương ứng.
7. WHEN một recording hoàn tất, THEN system SHALL phản ánh trạng thái capture của storage/dom trong `RecordingPrivacySummary.artifactFlags` (`storage`, `dom`) và đếm redaction hit tương ứng trong `counts`.

### Requirement 2: Toàn vẹn artifact pipeline (shared)

**User Story:** Là maintainer, tôi muốn mỗi artifact mới đi trọn vẹn từ capture tới replay, để dữ liệu được ghi luôn tới được player mà không thất lạc ở một mắt xích.

#### Acceptance Criteria

1. WHEN một artifact mới (`storage.json`, `dom.json`) được tạo, THEN system SHALL buffer nó trong `StorageManager` và serialize trong `finalizeCurrentSession()` thành chuỗi JSON.
2. THEN system SHALL khai báo key của artifact mới trong union `UploadArtifactKey` và trong hàm guard `isUploadArtifactKey()`.
3. WHEN artifact được đóng gói, THEN system SHALL ghi đường dẫn của nó vào cả `RecordingManifest.artifacts` (`<name>`) và `recording-index.json` (`<name>Path`), và SHALL push blob tương ứng vào `zipEntries`.
4. WHEN player nạp package, THEN `buildRecordingFilesFromPackageEntries()` SHALL phân giải đường dẫn artifact ưu tiên `recording-index.json` rồi fallback `manifest.json`, và SHALL nạp qua `loadJsonDescriptor`.
5. WHEN một artifact được serialize rồi parse lại, THEN dữ liệu SHALL được bảo toàn (`parse(JSON.stringify(artifact))` deep-equals `artifact`).

### Requirement 3: Licensing và attribution cho component được vendor (shared)

**User Story:** Là maintainer của một dự án GPL-3.0, tôi muốn mọi component bên thứ ba được vendor đều giữ đúng license và attribution, để tuân thủ pháp lý.

#### Acceptance Criteria

1. WHEN một component bên thứ ba (luna-*, hoặc bất kỳ phần nào của chobitsu/DevTools frontend) được vendor vào repo, THEN system SHALL kèm theo license text gốc và copyright notice của upstream.
2. THEN system SHALL chỉ vendor các component có license tương thích GPL-3.0 (MIT, BSD-3-Clause).
3. WHEN một bundle được vendor, THEN system SHALL pin version chính xác để build tái lập được (ví dụ qua `player/vendor/luna/VERSIONS.md` hoặc comment header).

### Requirement 4: Capture localStorage/sessionStorage/cookies (Item 2)

**User Story:** Là kỹ sư debug một bug phụ thuộc state lưu trữ, tôi muốn snapshot storage tại lúc bắt đầu và kết thúc recording, để thấy state thay đổi thế nào trong quá trình tái hiện bug.

#### Acceptance Criteria

1. WHEN `captureStorage === true` và recording bắt đầu, THEN system SHALL capture một `StorageSnapshot` với `phase === "start"` gồm `localStorage`, `sessionStorage`, và `cookies`.
2. WHEN `captureStorage === true` và recording dừng, THEN system SHALL capture một `StorageSnapshot` với `phase === "stop"`.
3. WHEN capture storage, THEN system SHALL dùng `DOMStorage.getDOMStorageItems` cho local và session, và `Network.getAllCookies` cho cookies.
4. IF một lệnh CDP storage thất bại (target detach, origin sai, iframe cross-origin), THEN system SHALL bỏ qua snapshot lỗi, ghi một entry vào `RecordingPrivacySummary.limitations`, và SHALL tiếp tục recording mà không hỏng.
5. WHEN snapshot được capture, THEN system SHALL áp redaction (`redactJsonValue`, `artifact = "storage"`) trước khi đưa vào buffer.
6. WHEN serialize, THEN system SHALL đóng gói các snapshot vào `StorageArtifact { schemaVersion: 1; snapshots: StorageSnapshot[] }` thành `storage.json`.

### Requirement 5: Storage panel và diff start↔stop (Item 2)

**User Story:** Là người xem replay, tôi muốn một tab "Storage" hiển thị 3 nhóm và làm nổi thay đổi giữa start và stop, để nhanh chóng thấy key nào được thêm/xóa/đổi.

#### Acceptance Criteria

1. WHEN package chứa `storage.json`, THEN player SHALL hiển thị một tab "Storage" với 3 nhóm: localStorage, sessionStorage, cookies.
2. WHEN cả snapshot start và stop tồn tại, THEN player SHALL tính diff sao cho mỗi key xuất hiện ở start hoặc stop có đúng một row diff với trạng thái `added` / `removed` / `changed` / `unchanged`.
3. WHEN người dùng chuyển sang tab "Storage", THEN `showLogsTab()` SHALL kích hoạt `#storage-viewer` và bỏ kích hoạt các viewer khác.
4. WHEN package không chứa `storage.json`, THEN player SHALL NOT hiển thị tab "Storage".

### Requirement 6: luna-* UI components cho rendering (Item 1)

**User Story:** Là người xem replay, tôi muốn object/JSON được render bằng viewer chuẩn có expand/collapse, để đọc dữ liệu console/network/storage dễ hơn; là maintainer tôi muốn có fallback an toàn nếu component không nạp được.

#### Acceptance Criteria

1. THEN system SHALL vendor các bản prebuilt standalone (IIFE/UMD) của `luna-object-viewer` và `luna-json-editor` vào `player/vendor/luna/` và mirror chúng qua `sync-player.js` vào `public/` và `dist/`.
2. WHEN player render console args / response body / WS payload / storage value và global luna tương ứng tồn tại, THEN system SHALL render bằng component luna.
3. IF global luna tương ứng không tồn tại (`window.LunaObjectViewer === undefined`), THEN system SHALL fallback về legacy renderer và SHALL NOT ném lỗi.
4. WHEN dùng `luna-json-editor` trong player, THEN system SHALL cấu hình ở chế độ read-only (`readOnly === true`) vì player chỉ replay.
5. THEN luna renderer SHALL phủ mọi value type mà legacy renderer phủ (string, number, object, array, null, undefined, function preview).

### Requirement 7: Capture DOM snapshot tĩnh (Item 3)

**User Story:** Là kỹ sư debug UI bug, tôi muốn snapshot DOM tại các thời điểm quan trọng, để soi cấu trúc DOM tại thời điểm xảy ra bug.

#### Acceptance Criteria

1. WHEN `captureDomSnapshots === true`, THEN system SHALL capture một `DomSnapshot` tại start, tại stop, và tại mỗi marker event quan trọng — KHÔNG capture liên tục.
2. WHEN capture DOM, THEN system SHALL dùng `DOMSnapshot.captureSnapshot` và flatten cấu trúc index-array thành một cây `DomNode` hợp lệ (mỗi node có ≤ 1 parent, không cycle).
3. WHEN một node khớp `maskDomSelectors`, THEN system SHALL mask text/attribute của node đó (`masked === true`, không lộ text gốc) trước khi đưa vào artifact.
4. WHEN `dom.json` có nguy cơ vượt giới hạn size, THEN system SHALL giảm dữ liệu (bỏ `computedStyles`, giới hạn depth); IF vẫn quá lớn, THEN system SHALL skip snapshot và ghi một entry vào `limitations`.
5. WHEN serialize, THEN system SHALL đóng gói vào `DomArtifact { schemaVersion: 1; snapshots: DomSnapshot[] }` thành `dom.json`.

### Requirement 8: DOM panel rendering (Item 3)

**User Story:** Là người xem replay, tôi muốn duyệt cây DOM đã snapshot trong player, để inspect element tại từng thời điểm.

#### Acceptance Criteria

1. WHEN package chứa `dom.json`, THEN player SHALL hiển thị một tab "Elements" với cây DOM inspectable.
2. WHEN có nhiều snapshot, THEN player SHALL cho phép chọn snapshot theo label/time qua một dropdown.
3. WHEN global `window.LunaDomViewer` tồn tại, THEN player SHALL render cây bằng nó; IF không, THEN player SHALL fallback về tree renderer dựa trên `<details>/<summary>` và SHALL NOT ném lỗi.

### Requirement 9: Low-friction in-page capture mode (Item 4)

**User Story:** Là người dùng trên môi trường không chấp nhận banner "đang debug", tôi muốn một chế độ capture in-page opt-in không hiện banner `chrome.debugger`, chấp nhận fidelity thấp hơn, để vẫn ghi được console/network/storage.

#### Acceptance Criteria

1. THEN system SHALL cung cấp cài đặt `captureMode: "cdp" | "in-page"` với giá trị mặc định `"cdp"`.
2. WHEN `captureMode === "in-page"`, THEN system SHALL NOT gọi `chrome.debugger.attach` và SHALL inject instrumentation in-page (MAIN world) để capture console/network/WebSocket/storage.
3. WHEN một entry được capture ở mode in-page, THEN nó SHALL hợp lệ theo schema mà player đang đọc (`ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot`), để player không cần biết nguồn capture.
4. WHEN recording dừng ở mode in-page, THEN system SHALL khôi phục mọi global đã monkey-patch về nguyên trạng (`console.log === origLog`, `window.fetch === origFetch`, v.v.).
5. WHEN dùng mode in-page, THEN system SHALL khai báo các hạn chế fidelity (no cross-origin response bodies, no real source maps) vào `RecordingPrivacySummary.limitations`.
6. IF MAIN-world injection bị CSP của trang chặn, THEN system SHALL ghi một limitation và đề xuất chuyển về `captureMode: "cdp"`.

## Glossary

- **Artifact**: Một file dữ liệu được ghi trong recording (ví dụ `console.json`, `network.json`, `storage.json`, `dom.json`) và đóng gói trong zip package trên Drive.
- **Artifact pipeline**: Chuỗi xử lý đưa dữ liệu từ capture tới replay: `cdp-manager.ts` → `storage-manager.ts` → `service-worker.ts` → `upload-orchestrator.ts` → `offscreen.ts` → `player.js`.
- **CDP (Chrome Debugger Protocol)**: Giao thức debug của Chromium mà extension dùng qua `chrome.debugger` để capture console/network/storage/DOM.
- **`captureMode`**: Cài đặt chọn cơ chế capture: `"cdp"` (qua `chrome.debugger`, full fidelity, có banner) hoặc `"in-page"` (instrumentation in-page, không banner, fidelity thấp hơn).
- **`classifyKey`**: Hàm trong `privacy-redaction.ts` nhận diện key/field nhạy cảm (password/token/secret/...).
- **`maskDomSelectors`**: Danh sách CSS selector mà người dùng cấu hình để che (mask) nội dung nhạy cảm; đã dùng cho visual blur trong `recording-events.ts`.
- **`RedactionArtifact`**: Union type phân loại artifact mà một redaction hit áp lên; được mở rộng thêm `"storage"` và `"dom"`.
- **`REDACTED_VALUE`**: Giá trị thay thế chuẩn dùng khi che dữ liệu nhạy cảm.
- **`RecordingPrivacySummary`**: Bản tóm tắt privacy (artifactFlags, counts, limitations) hiển thị trong player.
- **luna-***: Bộ UI components độc lập (MIT) của liriliri (`luna-object-viewer`, `luna-json-editor`, `luna-data-grid`, `luna-dom-viewer`) được vendor dưới dạng prebuilt bundle.
- **chobitsu**: Thư viện implement CDP bằng JS in-page (MIT), nguồn cảm hứng cho mode in-page của Item 4.
- **DOM snapshot tĩnh**: Bản chụp cây DOM tại một thời điểm (start/stop/marker) qua `DOMSnapshot.captureSnapshot`, KHÔNG phải replay DOM liên tục kiểu rrweb.
- **Marker**: Một mốc thời gian quan trọng trong recording (ví dụ click, navigation) được hiển thị trên thanh tiến trình của player.
- **Vendoring**: Sao chép bản build sẵn của thư viện bên thứ ba vào repo (`player/vendor/luna/`) kèm license, thay vì import qua npm.

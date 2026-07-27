# Player Screenshot Mode — Thiết Kế Phù Hợp Screenshot Report

> **Status: shipped (P0–P2).** Player resolve **presentation mode** (`recording` | `screenshot` | `sdk-logs` | `empty-evidence`) từ artifact thực có (`src/shared/player-presentation.ts` → `gnCore.presentation`). Screenshot mode ẩn cột video + splitter, primary Screenshots, ẩn Console/Network khi không có data. HTML parity extension/standalone được test. P3 (wire console/network lúc screenshot save) **không** làm trong vòng này — screenshot path không có recording session buffer.

## Bối Cảnh

Hai loại package hợp lệ cùng mở bằng một player:

| Loại | Producer | Video | Evidence chính | Use case user |
| --- | --- | --- | --- | --- |
| **Full recording** | Extension start/stop | Có | Timeline + console/network + events | Reproduce + scrub |
| **Screenshot report** | Extension Screenshot → Annotate → Save | **Không** | Ảnh annotated + caption + (optional) instant replay | “Nhìn đây, chỗ này sai” |
| **SDK session** | In-page SDK | **Không** | Console/network/WS/storage/DOM | Debug mobile/webview không tab capture |

Package mẫu đã verify (Dropbox, 2026-07-27): chỉ có

```text
recording-index.json, manifest.json, metadata.json,
agent-summary.json, screenshots.json, screenshots/shot-*.jpg
```

→ không `video.part-*`, không `console.json` / `network.json`.

## Đánh Giá Hiện Trạng (As-Is)

### Đã có

- Load `screenshots.json` + resolve ảnh từ `packageEntries`.
- Overlay annotation qua `window.gnCore.annotate` (cùng renderer editor).
- Tab Screenshots + card instant replay (khi artifact có).
- `metadata.capabilities` không gồm `video` cho screenshot report (`SCREENSHOT_REPORT_CAPABILITIES`).
- `applyNoVideoPresentation`: ẩn `video-container` + controls; hiện `#no-video-notice`.
- Sau load: nếu no-video + có screenshots → `showLogsTab("screenshots")`.

### Lệch UX (gốc rễ)

1. **Shell vẫn là “video player + log tabs”.**
   Cột trái = video section (notice “no video” kiểu SDK). Cột phải = Console/Network luôn hiện dù rỗng. User hỏi đúng: *“làm gì trong tab trống?”* — câu trả lời hiện tại: không có việc.

2. **Ẩn tab theo artifact không nhất quán.**
   Report / Activity / Storage / Elements / Screenshots: ẩn khi thiếu.
   **Console + Network: luôn hiện** (kể cả 0 entry). Với screenshot-only package → shell rỗng.

3. **Copy “no video” sai ngữ cảnh.**
   Hint hiện: *“captured by the in-page SDK…”*. Screenshot report là extension, không phải SDK → message gây hiểu nhầm.

4. **Layout 2 cột + splitter** tối ưu cho scrub video ↔ log. Screenshot report cần **primary surface = ảnh annotated**, không phải panel phụ.

5. **Drift HTML extension vs standalone (đã vá một phần).**
   `sync-player.js` chỉ copy `player.js` + `player.css` (+ vendor). **Không** sync markup tab. `player-standalone/index.html` từng thiếu `#screenshots-tab` / `#screenshots-viewer` trong khi JS đã có — tab biến mất im lặng. Cần guard process + test.

6. **Evidence gap (producer, không chỉ player).**
   Comment packager nói screenshot report có thể kèm console/network; SW save path hiện **chỉ** attach `instantReplay`. Player mode phải đúng **kể cả khi** sau này wire thêm log — ẩn tab khi artifact vắng, hiện khi có.

### User journey mong muốn (screenshot report)

```text
Mở replay link
  → (password nếu có)
  → Landing: ảnh lớn + caption + annotation list (+ instant replay nếu có)
  → Secondary: metadata URL/viewport, Copy for AI, share
  → Không thấy video chrome / console rỗng / network rỗng
  → Nếu sau này package có console.json → tab Console xuất hiện và dùng được
```

## Mục Tiêu

1. Player **nhận diện presentation mode** từ package (không hardcode producer string duy nhất).
2. **Screenshot mode**: primary = stills + annotations; không chrome video; không tab evidence trống.
3. **SDK no-video mode**: primary = console/network (và storage/elements nếu có); notice no-video đúng ngữ cảnh SDK.
4. **Full recording mode**: giữ UX hiện tại (video + synced logs).
5. Một runtime (`player/player.js` + CSS + HTML extension); standalone markup **không drift**.
6. Backward compatible: package cũ full-recording không đổi hành vi.

## Ngoài Phạm Vi (vòng này)

- Wire console/network vào screenshot **upload** path (producer) — plan riêng nếu làm; player chỉ consume “nếu có”.
- Instant-replay frame player (scrub DOM frames) — chỉ summary card như hiện tại trừ khi phase sau.
- Redesign annotate editor / capture flow.
- Thay layout engine lớn (virtual list refactor) — chỉ CSS/mode classes cần thiết.
- Vision/OCR trên ảnh.

## Logic Nghiệp Vụ / Tiêu Chí Mode

Resolve **một lần** sau khi metadata + artifact descriptors sẵn (trước `showPlayer`):

```text
hasVideo     := videoParts.length > 0
               OR hasCapability(metadata, "video") && video artifact present
hasScreenshots := screenshotsArtifact.screenshots.length > 0
hasConsole   := console entries loaded (array length > 0)  // hoặc artifact present?
hasNetwork   := network/websocket có entry
hasLogs      := hasConsole || hasNetwork || storage || elements || activity
```

**Quyết định mode (ưu tiên trên xuống):**

| Điều kiện | Mode | Primary surface |
| --- | --- | --- |
| `hasVideo` | `recording` | Video + timeline |
| `hasScreenshots && !hasVideo` | `screenshot` | Screenshots viewer full-width (hoặc dominant column) |
| `!hasVideo && hasLogs` | `sdk-logs` | Console (default), no-video notice ngắn |
| else | `empty-evidence` | Message “package có metadata nhưng không có evidence” + agent-summary nếu có |

**Ghi chú capability vs presence:**

- Package screenshot: `capabilities` **không** có `video` → không throw “Missing video parts” (đã có).
- Tab visibility: **presence of usable data**, không chỉ capability. Capability nói “producer có thể bắt”; presence nói “phiên này có gì để xem”. Tab trống = ẩn.
- Console/Network: đổi từ “luôn hiện” → **ẩn khi 0 entry** (áp dụng mọi mode, kể cả full recording im lặng). Optional: full recording vẫn hiện Console với empty state “No console messages” vì user expect DevTools-like — **chốt đề xuất:**

| Mode | Console/Network không có data |
| --- | --- |
| `recording` | **Hiện** tab + empty state (giống DevTools; user biết session im) |
| `screenshot` | **Ẩn** tab (không phải session log-oriented) |
| `sdk-logs` | **Hiện** tab chính; empty state nếu thực sự 0 |

## Thiết Kế UI Chi Tiết

### A. Mode `screenshot`

**Layout**

- `body` / `#player-container` class: `presentation-screenshot` (và giữ `no-video` nếu hữu ích).
- **Ẩn hoàn toàn** `#video-section` (không chỉ notice bên trong) — hoặc collapse splitter để logs panel = 100% width.
- Ưu tiên: `main-layout` một cột; Screenshots viewer chiếm vùng chính.
- Ẩn layout splitter (không còn 2 pane để resize).
- Ẩn video-related header controls (play, fullscreen video) nếu đang expose global.

**Tabs**

- Default active: `screenshots`.
- Hiện: Screenshots (bắt buộc có data), Report chỉ nếu có report/privacy/legacy screenshot.jpg, Activity/Storage/Elements chỉ nếu artifact.
- Ẩn: Console, Network (trừ khi artifact **có** entries — forward-compat).

**Primary content (Screenshots tab)**

- Card ảnh lớn, caption nổi (`What is wrong here?`).
- Overlay SVG annotations.
- Danh sách mô tả annotation (đã có `describeAnnotation`).
- Meta: URL, viewport, source kind.
- Instant replay card nếu có.
- Empty trong tab này không xảy ra nếu mode = screenshot (guard).

**No-video notice**

- Không dùng bản SDK. Nếu vẫn cần badge nhỏ trên header: *“Screenshot report — no screen recording”* (i18n EN/VI).

**Copy for AI**

- Giữ; `agent-summary` / screenshots markdown đã hữu ích. Đảm bảo path không phụ thuộc video duration.

### B. Mode `sdk-logs`

- Giữ video-section collapsed + notice **SDK-specific** (copy hiện tại gần đúng).
- Default tab: Console.
- Console/Network hiện kể cả khi một bên trống (empty state rõ).

### C. Mode `recording`

- Không đổi hành vi chính.
- Có thể hiện thêm tab Screenshots nếu package full recording cũng đính annotated shots (hiếm nhưng hợp lệ).

### D. HTML parity

- `player/player.html` = source of truth cho structure tabs/viewers.
- `player-standalone/index.html` phải có cùng ids.
- Bổ sung check trong `sync-player.js` **hoặc** test: assert standalone index chứa `#screenshots-tab`, `#screenshots-viewer`, `#screenshots-content` (và các id critical khác).
- Không bắt buộc auto-generate HTML từ một template ở phase 1; test drift là đủ.

## Impact Nghiệp Vụ

| Audience | Impact |
| --- | --- |
| Reporter / teammate mở screenshot link | Thấy ngay ảnh + note; không bối rối với video/console trống |
| Dev debug full recording | Không đổi |
| SDK users | Notice no-video đúng; logs vẫn primary |
| Agent (MCP / Copy for AI) | Không đổi contract package; player mode chỉ UI |

## Phạm Vi File

| File | Việc |
| --- | --- |
| `player/player.js` | `resolvePresentationMode()`, tab visibility rules, default tab, `applyPresentationMode()` thay/ mở rộng `applyNoVideoPresentation` |
| `player/player.css` | `.presentation-screenshot` layout (full-width screenshots, hide video-section/splitter) |
| `player/player.html` | Copy no-video variants / optional screenshot chrome nếu cần |
| `player-standalone/index.html` | Đồng bộ markup + bất kỳ node mới |
| `player-standalone/public/*` | Via `sync-player` (js/css); HTML tay hoặc test |
| `player/player-i18n` strings trong `player.js` | EN/VI: screenshot mode title/hint |
| `docs/modules/replay-player.md` | Ghi presentation modes |
| Tests | Unit thuần cho mode resolver; optional DOM id parity test |

## Lộ Trình Triển Khai

### P0 — Mode resolver + ẩn chrome thừa (core)

1. Extract `resolvePresentationMode({ metadata, videoParts, artifacts })` (pure, testable).
2. Gọi sau load artifacts, trước `showPlayer`.
3. `applyPresentationMode(mode)`:
   - set class trên `body` / player container;
   - screenshot: hide `#video-section`, hide splitter, show screenshots tab, hide console/network nếu empty.
4. i18n: phân biệt notice SDK vs screenshot report.
5. Default tab theo mode (screenshot → screenshots; sdk → console; recording → giữ logic report/activity fallback hiện có).

**Acceptance P0**

- [ ] Mở package chỉ screenshots (+ metadata): không thấy video section; không tab Console/Network; tab Screenshots active; ảnh + caption + overlay.
- [ ] Full recording có video: layout/tabs như cũ.
- [ ] SDK-like package (no video, có console): notice SDK; Console visible.
- [ ] Unit tests mode resolver (bảng truth ở trên).

### P1 — Polish screenshot surface

1. Typography/spacing caption + annotation list (đọc được trên desktop/mobile width).
2. Optional: khi chỉ 1 screenshot, bỏ chrome “card list” thừa, focus figure.
3. Header subtitle: “Screenshot report” vs recording title.
4. Empty-evidence fallback message.

**Acceptance P1**

- [ ] 1-shot report trông như bug card, không như DevTools rỗng.
- [ ] Mobile/narrow: một cột, không splitter kẹt.

### P2 — Hardening & docs

1. Test parity HTML ids extension ↔ standalone (screenshots + no-video nodes).
2. Cập nhật `docs/modules/replay-player.md` Inspection UX + modes.
3. (Optional) `sync-player.js` warn nếu standalone index thiếu id critical.

**Acceptance P2**

- [ ] CI/test fail nếu standalone mất `#screenshots-tab`.
- [ ] Docs phản ánh 3 mode.

### P3 — (Optional, producer) Evidence cho screenshot report

*Tách PR; không chặn P0–P2.*

- SW `handleSaveAnnotatedScreenshot`: best-effort collect in-page console/network buffer nếu extension đang giữ (hoặc content-script snapshot ngắn).
- Player tự hiện tab khi artifact có — nhờ rule P0.

## Rủi Ro Và Mitigation

| Rủi ro | Mitigation |
| --- | --- |
| Ẩn Console trên full recording im lặng làm user tưởng hỏng | Chỉ ẩn Console/Network empty trong `screenshot` mode |
| Class CSS conflict fullscreen/layout | Screenshot mode force-off video-fullscreen; disable splitter handlers |
| `gnCore` thiếu → claimsVideo default true | Giữ check capabilities; screenshot capabilities không có video |
| Standalone HTML drift lại | Parity test P2 |
| Double-render tab flash | Set mode + default tab **trước** `showPlayer` / một frame |

## Quyết Định Cần User Xác Nhận (trước khi code lớn)

1. **Console/Network empty trên full recording:** giữ hiện + empty state (đề xuất) — OK?
2. **Screenshot layout:** ẩn hẳn video column (đề xuất) vs giữ column với notice — OK ẩn hẳn?
3. **P3 wire console/network lúc screenshot save:** làm cùng đợt hay tách sau?

## Tóm Tắt Đề Xuất Mặc Định (nếu user chỉ “làm đi”)

- Làm **P0 + P1 + P2**.
- Screenshot mode: **ẩn video section**, **ẩn Console/Network khi không có data**, primary Screenshots full width.
- Không làm P3 trong cùng PR trừ khi được yêu cầu.
- Full recording: không đổi tab Console luôn-hiện.

## Liên Quan

- [replay-player.md](../../modules/replay-player.md)
- [data-models.md](../../shared/data-models.md) — `screenshots.json`, capabilities
- [agent-integration.md](../../modules/agent-integration.md) — screenshot report skill
- Producer gap: `src/background/service-worker.ts` `handleSaveAnnotatedScreenshot`
- Packager: `src/offscreen/screenshot-package.ts`

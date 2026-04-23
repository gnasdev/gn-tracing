# Per-File Upload And Load Progress

## Context

- User muốn bỏ kiểu progress tổng quát hiện tại và thay bằng progress riêng cho từng file:
  - upload trong extension popup
  - loading trong player
- Hiện tại code và spec vừa được chỉnh theo hướng progress aggregate/generic vì transfer chạy song song.
- Yêu cầu mới đổi quyết định UX này:
  - vẫn giữ aggregate progress tổng
  - nhưng phải thêm danh sách item progress riêng cho từng artifact/file
  - mỗi item cần có:
    - label
    - percent
    - size (`loaded / total`)

## Scope

- `src/offscreen/offscreen.ts`
- `src/background/service-worker.ts`
- `src/popup/popup.ts`
- `popup/popup.html`
- `popup/popup.css`
- `player/player.js`
- `player/player.html`
- `player/player.css`
- `player-standalone/public/*` qua sync script
- `src/types/messages.ts`
- specs liên quan trong `specs/modules/drive-and-player.md` và `specs/_sync.md`

## Goals

1. Hiển thị progress riêng cho từng file/artifact trong popup upload.
2. Hiển thị progress riêng cho từng file/artifact trong player loading.
3. Giữ aggregate progress tổng vẫn đúng và không nhảy lùi sai.
4. Với artifact chạy song song, UI vẫn rõ:
   - item nào đang chạy
   - item nào hoàn tất
   - item nào bị skip hoặc failed
5. Preserve current fixes:
   - không dùng raw multipart bytes cho upload payload progress
   - không cho loading progress nhảy 100% rồi tụt khi chưa biết total thật

## Proposed UX

### 1. Popup upload

- Vẫn giữ progress bar tổng ở đầu block upload.
- Thêm danh sách file progress bên dưới, ví dụ:
  - `metadata.json`
  - `video.part-000.webm`
  - `video.part-001.webm`
  - `console.json`
  - `network.json`
  - `websocket.json`
  - `manifest.json`
- Mỗi dòng hiển thị:
  - label file
  - status nhỏ: `Queued` / `Uploading` / `Uploaded` / `Skipped` / `Failed`
  - percent riêng
  - bytes riêng

### 2. Player loading

- Vẫn giữ loading bar tổng ở loading screen.
- Thêm danh sách artifact progress bên dưới:
  - `metadata`
  - `video part N`
  - `console`
  - `network`
  - `websocket`
- Mỗi dòng hiển thị:
  - label
  - status: `Queued` / `Loading` / `Loaded` / `Unavailable` / `Failed`
  - percent riêng nếu total đã biết
  - bytes riêng

## State / Contract Changes

### 1. Upload progress payload

- Mở rộng `UPLOAD_PROGRESS` data để chứa itemized progress snapshot, ví dụ:
  - `items: Array<{ key, label, loadedBytes, totalBytes, percent, status }>`
- Service worker lưu snapshot itemized này cho popup sync.

### 2. Player loading state

- `player.js` hiện đã có `loadingProgressEntries` map nội bộ.
- Nâng nó từ internal aggregate helper thành structured render source:
  - `label`
  - `status`
  - `loaded`
  - `total`
  - `group`

## Implementation Plan

### Step 1. Define shared upload progress item model

- Cập nhật `src/types/messages.ts` cho payload progress itemized.
- Đảm bảo service worker + popup cùng hiểu chung shape mới.

### Step 2. Refactor offscreen upload progress emitter

- Mỗi `UploadQueueItem` cần có `label` ổn định, dễ render.
- `emitProgress()` sẽ build both:
  - aggregate totals
  - per-item snapshot
- Cần explicit status transitions cho item:
  - `queued`
  - `uploading`
  - `uploaded`
  - `skipped`
  - `failed`

### Step 3. Render upload item progress in popup

- Thêm container mới trong `popup.html`.
- Thêm CSS cho list progress nhỏ gọn, dễ scan.
- `popup.ts` render item list từ `uploadState`.

### Step 4. Refactor player loading progress registry

- `loadingProgressEntries` lưu thêm `label` + `status`.
- Khi metadata/video/console/network/websocket start/load/end, update entry state rõ ràng.
- Unknown-size item vẫn hiện bytes loaded và status, còn percent item chỉ khi total đã biết.

### Step 5. Render player loading item list

- Thêm markup/CSS cho loading screen item list trong `player.html` / `player.css`.
- Sync sang standalone player public assets.

### Step 6. Spec sync

- Cập nhật `specs/modules/drive-and-player.md`:
  - progress aggregate + per-file coexist
  - current “generic-only progress copy” rule phải bị thay thế
- Cập nhật `specs/_sync.md`
- Rebuild `graphify-out/`

## Risks

- UI có thể bị quá dày nếu recording có nhiều video parts; cần layout compact và giới hạn hợp lý.
- Unknown `content-length` ở player sẽ làm một số item không có percent tạm thời; cần cách hiển thị không gây hiểu nhầm.
- Upload progress item snapshot phải đủ nhẹ để không làm message/state sync quá nặng.

## Expected Outcome

- User thấy được từng artifact đang upload/load thế nào thay vì chỉ aggregate total.
- Debugging progress dễ hơn khi transfer song song.
- Vẫn giữ được byte math đúng cho cả aggregate lẫn per-item progress.

## Approval Needed

Đây là task lớn vì thay đổi:
- contract progress giữa offscreen -> service worker -> popup
- loading UI/state trong player
- spec đã có quyết định ngược lại cần cập nhật lại

Cần bạn duyệt plan này trước khi mình bắt đầu code.

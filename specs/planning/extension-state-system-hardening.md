# Extension State System Hardening

## Context

- Review vừa chỉ ra 3 vấn đề chính trong state system của extension:
  1. recording/upload state phụ thuộc quá nhiều vào in-memory state của service worker
  2. popup sync đang kéo theo live Google Drive auth check quá thường xuyên
  3. upload result cũ có thể leak sang session recording mới
- Scope của plan này giới hạn trong extension runtime:
  - `src/background/service-worker.ts`
  - `src/background/recorder-manager.ts`
  - `src/background/storage-manager.ts`
  - `src/background/google-drive-auth.ts`
  - `src/offscreen/offscreen.ts`
  - `src/popup/popup.ts`
  - `src/drive-auth/drive-auth.ts`
  - `src/types/messages.ts`

## Goals

1. Tách rõ authoritative runtime state và popup snapshot state.
2. Giảm tối đa việc popup sync làm phát sinh network/auth verification không cần thiết.
3. Reset sạch upload state khi bắt đầu session recording mới.
4. Làm auth state ổn định hơn sau extension reload.
5. Cải thiện khả năng recover tối thiểu khi service worker restart trong lúc extension còn đang có recording/capture state.

## Non-Goals

- Không thêm backend hay storage server-side.
- Không đưa toàn bộ artifact logs/video blob vào durable persistence.
- Không làm backward compatible với state contract cũ nếu contract mới gọn và rõ hơn.

## Current State Model

### 1. In-memory state

- `service-worker.ts`
  - `state`: recording lifecycle
  - `uploadState`: upload progress + result
  - `StorageManager`: console/network/websocket payloads
  - `RecorderManager`: trạng thái completion của recording
- `offscreen.ts`
  - `recordedBlob`, `chunks`, `MediaRecorder`, `AudioContext`

### 2. Mirrored state for UI

- `chrome.storage.session[gn_tracing_state]` đang là snapshot cho popup và drive-auth page.
- Popup vừa đọc snapshot vừa gọi message-based APIs riêng lẻ.

### 3. Main problem

- Snapshot hiện không phải source of truth.
- Nhưng source of truth lại mostly sống trong RAM của service worker, vốn không bền với MV3 lifecycle.
- Kết quả là state consistency yếu ở các mốc:
  - service worker restart
  - upload progress burst
  - bắt đầu session mới sau upload cũ

## Proposed State Architecture

### 1. Split state by responsibility

- **Authoritative runtime state**
  - recording session metadata
  - upload lifecycle metadata
  - google drive auth connectivity cache
- **Ephemeral heavy state**
  - console/network/websocket payload arrays
  - `recordedBlob`
  - source map caches
- **Derived UI snapshot**
  - popup-facing reduced state only

### 2. Introduce explicit runtime snapshot model

- Thêm một runtime snapshot object persist vào `chrome.storage.session`, ví dụ:
  - `recording.phase`: `idle | recording | recorded | uploading`
  - `recording.tabId`
  - `recording.startTime`
  - `recording.stopTime`
  - `recording.tabUrl`
  - `recording.hasBufferedArtifacts`
  - `upload.progress`
  - `upload.message`
  - `upload.recordingUrl`
  - `upload.error`
  - `googleDrive.isConnected`
  - `googleDrive.checkedAt`

- Snapshot này là contract chuẩn cho popup/auth page.
- Popup không tự suy luận state bằng cách merge nhiều nguồn rời rạc nữa.

### 3. Cache auth status separately

- Tách `googleDrive` status khỏi `saveStateToStorage()` kiểu current.
- `saveStateToStorage()` chỉ nên nhận auth status đã biết hoặc dùng cached auth status.
- Auth verification chỉ chạy ở các điểm hữu ích:
  - startup/install
  - popup open
  - auth connect/disconnect
  - ngay trước upload nếu cần token thật

### 4. Make recording/upload transitions explicit

- Khi `START_RECORDING`:
  - reset sạch `uploadState`
  - clear stale replay URL/error/progress
  - persist snapshot mới trước và sau attach/capture nếu cần
- Khi `STOP_RECORDING` thành công:
  - chuyển phase sang `recorded`
- Khi upload bắt đầu:
  - phase `uploading`
- Khi upload thành công:
  - phase `idle` hoặc `uploaded` tùy UX mong muốn
  - clear buffered artifacts in worker-side state

### 5. Minimal worker-restart recovery

- Không thể recover full logs/blob nếu chỉ nằm trong RAM, nhưng có thể recover UX state tốt hơn:
  - persist runtime snapshot sớm và rõ hơn
  - khi service worker boot lại:
    - hydrate snapshot từ `chrome.storage.session`
    - detect offscreen context presence nếu còn
    - nếu snapshot nói đang recording nhưng worker state rỗng:
      - degrade có chủ đích về `idle` hoặc `interrupted`
      - không được silently claim “no recording ever happened”
- Nếu feasible sau research sâu hơn:
  - thêm offscreen query message để service worker hỏi xem `recordedBlob` hoặc recorder state còn tồn tại không

## Execution Plan

### Step 1. Define runtime snapshot contract

- Chuẩn hóa shape state dùng chung giữa service worker, popup, drive-auth.
- Có thể cần update `src/types/messages.ts` để phản ánh state model mới.

### Step 2. Refactor service-worker state writes

- Tách:
  - `persistUiSnapshot()`
  - `refreshGoogleDriveState()`
  - `resetUploadState()`
- Loại bỏ việc mọi snapshot persist đều tự verify auth qua network.

### Step 3. Fix stale upload leakage

- Reset `uploadState` khi bắt đầu recording mới.
- Đảm bảo popup render logic ưu tiên `recording phase` trước replay result cũ.

### Step 4. Improve startup hydration

- Trên service worker boot:
  - sync auth state một lần
  - hydrate/publish runtime snapshot một lần
- Nếu có thể:
  - probe offscreen context để xác định khả năng recover state recording/upload hiện tại.

### Step 5. Simplify popup consumption

- Popup:
  - đọc snapshot hiện tại
  - subscribe snapshot changes
  - chỉ gọi `GOOGLE_DRIVE_STATUS` như explicit revalidate, không dùng như nguồn state chính cho mọi thứ
- Drive auth page cũng theo cùng contract.

### Step 6. Spec and graph sync

- Cập nhật:
  - `specs/modules/drive-and-player.md`
  - `specs/_sync.md`
- Rebuild `graphify-out/` sau khi sửa code.

## Risks / Decisions To Confirm During Implementation

- Cần quyết định rõ phase cuối sau upload thành công:
  - `idle` ngay
  - hay `uploaded` để popup semantics rõ hơn
- Nếu muốn recover sâu hơn sau worker restart, có thể phải thêm offscreen introspection message contract.
- `chrome.storage.session` vẫn không thay thế được persistence thực thụ; plan này chỉ harden lifecycle, không biến nó thành durable archive.

## Expected Outcome

- Popup không còn nhấp nháy hoặc bị stale vì auth verification spam.
- Session mới không còn lẫn replay result cũ.
- Auth state ổn định hơn sau reload.
- Khi worker restart, UX state degrade có chủ đích và minh bạch hơn thay vì mất dấu ngẫu nhiên.

## Approval Needed

Plan này là task đủ lớn vì có thay đổi state contract xuyên qua service worker, popup, auth page, và có thể thêm runtime snapshot model mới. Cần bạn duyệt trước khi mình bắt đầu code.

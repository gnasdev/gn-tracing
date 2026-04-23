# Fix Memory Retention After Recording And Upload

- **Status**: Draft
- **Date**: 2026-04-23
- **Owner**: Codex

## 1. Objective

Loại bỏ các điểm giữ memory quá vòng đời cần thiết trong flow recording/upload hiện tại, tập trung vào 4 finding đã review:
- offscreen giữ `recordedBlob` sau khi upload xong
- service worker giữ toàn bộ logs sau upload thành công
- source map cache không được giải phóng sau khi enrich xong
- danh sách promise source-map fetch tăng dần trong suốt recording

## 2. Research Summary

- `src/offscreen/offscreen.ts` giữ `recordedBlob` ở scope module để phục vụ upload, nhưng hiện chưa có lifecycle clear sau success/failure/idle.
- `src/background/service-worker.ts` chỉ `storage.clear()` khi bắt đầu recording mới; upload thành công không giải phóng console/network/websocket artifacts cũ.
- `src/background/cdp-manager.ts` có `#sourceMapResolver` và `#sourceMapFetches`; `flushSourceMaps()` chỉ chờ toàn bộ promise settle, chưa clear resolver sau khi apply, và chưa loại settled promise khỏi mảng trong quá trình recording.
- Phần listener/timer chính ở popup, auth page, debugger attach/detach hiện chưa thấy dấu hiệu leak tăng dần ngoài các retention points trên.

## 3. Proposed Fixes

### 3.1 Offscreen recording blob lifecycle

- Giữ `recordedBlob` đủ lâu để upload/export dùng được.
- Thêm cleanup path rõ ràng sau khi upload hoàn tất hoặc fail xong:
  - null `recordedBlob`
  - reset `recorder` references không còn cần thiết
  - bảo đảm không làm mất recording trước khi service worker hoàn tất upload request
- Nếu cần, tách helper `clearCapturedMedia()` để gom cleanup blob/chunks/audio context/references.

### 3.2 Post-upload storage release

- Sau khi `UPLOAD_TO_GOOGLE_DRIVE` thành công ở service worker:
  - clear `StorageManager`
  - reset state/flags chỉ còn đủ thông tin để popup hiển thị link upload thành công
- Giữ nguyên UX cần thiết:
  - vẫn hiển thị `recordingUrl`
  - không vô tình làm popup hiểu là đang recording
- Chấp nhận forward-only: sau upload thành công, artifacts cũ không còn được giữ trong memory.

### 3.3 Source map cache release

- Sau `storage.resolveSourceMaps(...)` ở `stopRecording()`, gọi cleanup explicit trên `CdpManager` để giải phóng source map resolver cache.
- Ưu tiên thêm method chuyên dụng trong `CdpManager` thay vì truy cập sâu vào internals từ service worker.

### 3.4 Settled source-map promise compaction

- Đổi cách quản lý `#sourceMapFetches` để settled promise tự được loại khỏi collection ngay khi hoàn tất.
- Một hướng an toàn:
  - dùng `Set<Promise<void>>`
  - add promise khi tạo
  - gắn `finally(() => set.delete(promise))`
  - `flushSourceMaps()` snapshot `Array.from(set)` rồi `Promise.allSettled(...)`
- Mục tiêu là tránh retention tuyến tính theo số script parsed trong cùng một recording.

## 4. Scope Of Code Changes

- `src/offscreen/offscreen.ts`
- `src/background/service-worker.ts`
- `src/background/cdp-manager.ts`
- có thể kèm chỉnh nhỏ `src/background/recorder-manager.ts` nếu cần đồng bộ cleanup semantics
- sau khi code xong sẽ update specs nếu flow/lifecycle thực sự thay đổi ở mức kiến trúc hoặc business-relevant constraints

## 5. Execution Plan

1. Refactor lifecycle cleanup ở offscreen để blob/chunks/references được release sau upload xong.
2. Cập nhật service worker để giải phóng storage artifacts ngay sau upload success.
3. Thêm API cleanup source-map cache trong `CdpManager` và gọi nó sau bước enrich source maps.
4. Đổi `#sourceMapFetches` sang cơ chế tự compact khi promise settle.
5. Self-review toàn bộ flow start/stop/upload để tránh race:
   - upload sau stop vẫn dùng được blob
   - clear storage không làm hỏng upload state UI
   - source-map flush vẫn complete trước detach/cleanup
6. Cập nhật specs liên quan nếu lifecycle retention rules thay đổi đáng kể.
7. Rebuild graph theo rule của repo.

## 6. Risks

- Clear blob quá sớm có thể làm upload fail hoặc làm mất khả năng retry trong cùng phiên.
- Clear storage sau upload success sẽ khiến không còn dữ liệu để upload lại lần nữa nếu user muốn retry bằng cùng artifacts.
- Compact promise collection sai cách có thể làm `flushSourceMaps()` bỏ sót promise đang pending.

## 7. Decisions To Confirm

- Sau upload thành công, có chấp nhận giải phóng toàn bộ artifacts trong memory và coi đó là kết thúc vòng đời recording hay không.
- Có giữ khả năng retry upload cùng một recording mà không record lại hay không.

Mặc định plan này giả định:
- upload success => release memory ngay
- muốn upload lại thì record lại phiên mới

## 8. Expected Outcome

- Memory sau upload giảm rõ rệt vì blob và logs lớn không còn bị giữ vô thời hạn.
- Recording dài hoặc trang nhiều script không còn tăng retention không cần thiết trong service worker/offscreen.
- Flow stop/upload giữ nguyên behavior chính nhưng lifecycle tài nguyên rõ ràng hơn và dễ bảo trì hơn.

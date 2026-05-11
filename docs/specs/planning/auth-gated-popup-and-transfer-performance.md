# Auth-Gated Popup And Transfer Performance

## Bối Cảnh

Popup hiện luôn hiển thị recording controls, live stats, và `Capture Queue` dù `PopupState.googleDrive.isConnected` đang `false`. Auth state chỉ đổi nhãn/nút trong `#google-drive-section`, còn `handleStateUpdate()` vẫn gọi `updateRecordingUI()` và `renderSessions()` độc lập với Google Drive auth. Điều này cho phép người dùng bắt đầu capture khi chưa connect Drive, tạo trải nghiệm không đúng với yêu cầu mới là chỉ mở recording flow sau khi đã auth Google Drive.

Upload hiện đi qua `src/offscreen/offscreen.ts`: video được tách thành các part `<= 32 MB`, metadata/log artifacts được build thành Blob, rồi `uploadItems` được upload song song với concurrency cố định `3`. Mỗi file dùng Google Drive multipart upload qua XHR, sau đó gọi riêng `files/{id}/permissions` để make shareable. Sau khi upload xong toàn bộ payload, hệ thống upload tiếp `manifest.json` và `recording-index.json` theo chuỗi.

Player hiện tải `recording-index.json`, sau đó tải metadata trước. Khi metadata đã có, video parts, console, network, và websocket artifacts được tải song song. Video parts đang được tải toàn bộ về memory, ghép thành một Blob lớn, rồi mới gán vào `<video>`. Standalone player đi qua `/api/drive?id=<file-id>`, function proxy có forward `Range`, giữ một số response headers, và set `cache-control: public, max-age=86400`. Trong `player/player.js`, `fetchDriveFileWithCache()` lại clone response thành Blob để lưu Cache API trước khi caller đọc, nên lần tải đầu có thể phải materialize file lớn thêm một lần.

## Mục Tiêu

1. Khi người dùng chưa auth Google Drive, popup chỉ hiển thị Google Drive connect/settings và các phần không phụ thuộc capture; ẩn recording controls, live stats, và `Capture Queue`.
2. Khi đã auth, popup hiện lại recording controls và queue bình thường, không làm mất state đang có.
3. Tối ưu tốc độ upload trong extension popup bằng cách giảm các request tuần tự không cần thiết, điều chỉnh concurrency an toàn, và tránh làm progress/state sync thành bottleneck.
4. Tối ưu tốc độ download trong player bằng cách giảm memory copy, tận dụng browser/video streaming tốt hơn, và tránh block player vì artifacts phụ không cần thiết.
5. Giữ per-file progress hiện có và aggregate progress đúng, không làm UI nhảy lùi hoặc báo 100% sớm.

## Ngoài Phạm Vi

- Không đổi storage contract công khai của replay URL: replay vẫn dùng `https://tracing.gnas.dev/<recording-index-file-id>`.
- Không chuyển sang backend riêng hoặc Drive API key bắt buộc.
- Không publish CRX/update XML.
- Không bỏ Cloudflare Pages `/api/drive` proxy trong standalone mode.

## Hướng Tiếp Cận Đề Xuất

### 1. Auth-gated popup UI

- Thêm references rõ ràng trong `src/popup/popup.ts` cho các vùng cần ẩn: recording button group/live stats và `#session-queue-section`.
- Tạo helper kiểu `setCaptureUiVisibility(isConnected: boolean)` hoặc tích hợp vào `handleStateUpdate()`.
- Khi `isConnected=false`:
  - ẩn `#toggle-btn`, `#pause-resume-btn`, `#remove-recording-btn`, `#stats`, `#status-bar`, và `#session-queue-section`;
  - không render queue list ra màn hình;
  - giữ `Latest Upload`, `Google Drive`, và community section nếu chúng vẫn có giá trị tham chiếu.
- Khi `isConnected=true`, gọi lại `updateRecordingUI(state.recording)` và `renderSessions(state.sessions)` như hiện tại.
- Với edge case user disconnect trong khi đang recording/uploading, cần quyết định behavior an toàn:
  - UI ẩn controls theo yêu cầu;
  - service worker vẫn nên hoàn tất/cleanup flow hiện có, nhưng manual upload tiếp theo vẫn bị chặn bởi `getAuthToken()`.

### 2. Upload performance

- Tách hằng số concurrency thay vì hardcode `3`, ví dụ `DRIVE_UPLOAD_CONCURRENCY`.
- Đo/so sánh các mức `3`, `4`, `5` với recordings nhiều video parts. Mức mặc định đề xuất ban đầu là `4` vì upload đang gồm nhiều file độc lập và Drive multipart request có độ trễ permission request sau mỗi file.
- Giảm progress spam:
  - throttle `sendProgress()` theo thời gian hoặc percent delta nhỏ, đồng thời vẫn emit ngay ở state transition (`queued -> uploading -> uploaded/failed`);
  - tránh ghi `chrome.storage.session` quá dày khi XHR progress event bắn liên tục.
- Parallelize permission creation có kiểm soát:
  - hiện `uploadFile()` chờ `makeShareable(fileId)` ngay sau mỗi multipart upload;
  - đề xuất upload file trả `fileId` trước, gom permission tasks vào queue riêng concurrency thấp, hoặc cho permission chạy song song ngay sau upload nhưng không block worker slot upload chính;
  - required artifacts vẫn fail upload nếu permission của required file fail.
- Cân nhắc Drive resumable upload cho video parts lớn:
  - multipart upload đơn request đơn giản nhưng mỗi part 32 MB chịu retry từ đầu nếu fail;
  - resumable upload có setup request nhưng retry tốt hơn với mạng chập chờn. Đây nên là phase 2 nếu tuning concurrency/throttle chưa đủ.
- Giữ optional artifacts best-effort và không để console/network/websocket lớn chặn video/metadata critical path nếu có thể ưu tiên required files trước.

### 3. Player download performance

- Tránh cache-first Blob clone cho video lớn:
  - chỉ dùng Cache API Blob clone cho JSON/small artifacts;
  - với video parts lớn, fetch trực tiếp để tránh double materialization trên lần tải đầu.
- Tải critical path trước:
  - index -> metadata vẫn cần trước để biết duration/title/expected bytes;
  - video loading nên bắt đầu sớm nhất có thể sau khi có file ids;
  - console/network/websocket có thể tải song song nhưng render lazily hoặc không block `showPlayer()` nếu video + metadata đã sẵn sàng.
- Đánh giá streaming video thay vì ghép Blob toàn bộ:
  - phương án ngắn hạn: vẫn ghép Blob nhưng giảm cache copy và giữ parallel parts bounded;
  - phương án tốt hơn: dùng `MediaSource` để append parts theo thứ tự, cho video bắt đầu phát trước khi tải toàn bộ xong. Cần kiểm tra MIME codec compatibility và fallback về Blob combine.
- Thêm bounded download concurrency cho video parts thay vì `Promise.all` không giới hạn. Với nhiều part, đề xuất mặc định `4` hoặc `6` để tránh nghẽn browser/network.
- Ở Cloudflare proxy, giữ `Range` support và cache headers; nếu dùng streaming/MediaSource, kiểm tra `206`/`content-range` xuyên proxy bằng player test.

## Công Việc Cần Làm

1. Cập nhật popup TS để auth state điều khiển capture UI visibility.
2. Giữ test/manual scenarios cho popup:
   - chưa connect Drive;
   - connect Drive;
   - disconnect sau khi đã có uploaded history;
   - disconnect khi có recorded session local.
3. Refactor upload constants/progress emitter trong `src/offscreen/offscreen.ts`.
4. Tune upload concurrency và progress throttling, giữ progress itemized.
5. Refactor permission handling để giảm chờ tuần tự trong từng worker slot.
6. Refactor player download path:
   - cache policy theo loại artifact;
   - bounded video download concurrency;
   - lazy/non-blocking optional logs nếu an toàn với UI.
7. Sync standalone player assets sau khi chỉnh `player/player.js` / `player/player.css`.
8. Cập nhật specs module `drive-and-player`, `recording-runtime`, và `_sync.md` sau implementation.

## Trạng Thái Implementation

- Đã triển khai auth-gated popup visibility trong `src/popup/popup.ts`.
- Đã triển khai upload concurrency constant, progress throttling, và permission sharing tách khỏi upload worker slot trong `src/offscreen/offscreen.ts`.
- Đã triển khai bounded video-part download concurrency và bỏ Cache API storage cho video downloads trong `player/player.js`, sau đó sync sang `player-standalone/public/player.js`.
- `MediaSource` streaming và lazy optional-log rendering vẫn là phase sau vì cần validation trình phát kỹ hơn.

## Rủi Ro Và Ràng Buộc

- Ẩn recording UI khi unauth có thể gây khó hiểu nếu user đang có local recorded session nhưng token hết hạn; cần copy/empty state trong Google Drive section đủ rõ qua status hiện có.
- Tăng concurrency có thể gặp Drive rate limits hoặc làm progress UI nhiều event hơn; cần throttle và fallback mức thấp.
- Permission creation song song có thể tạo race với `recording-index.json` nếu index được public trước file con; cần đảm bảo required file permissions hoàn tất trước khi trả replay URL.
- `MediaSource` phức tạp hơn Blob combine và phụ thuộc codec/container; không nên gắn vào phase 1 nếu chưa validate.
- Player hiện render console/network sau khi toàn bộ Promise hoàn tất; lazy rendering cần tránh làm tabs/search hoạt động trên dữ liệu chưa tải mà không có trạng thái rõ.

## Kiểm Chứng

- `task typecheck`
- `task build`
- `task player:sync`
- `task player:build`
- Manual popup:
  - load extension with no Google auth; verify recording controls/stats/queue hidden and Drive connect visible;
  - connect Drive; verify controls/queue appear and start/stop/upload still works;
  - disconnect; verify controls/queue hide again.
- Manual upload timing:
  - record a short session and a larger session with multiple video parts;
  - compare total upload time and verify progress rows remain monotonic.
- Manual player timing:
  - open replay with one video part and with multiple parts;
  - verify load starts, progress rows update, video plays, console/network/WebSocket tabs still populate.
- Standalone hosted/local check:
  - run player dev or built preview;
  - verify `/api/drive` proxy path still loads artifacts and respects range/header behavior.

## Ghi Chú Phase Sau

`MediaSource` streaming và lazy optional-log loading có thể giảm time-to-first-play thêm nữa, nhưng nên làm thành task riêng vì cần fallback chắc chắn cho WebM/codec support và trạng thái UI khi logs chưa tải xong.

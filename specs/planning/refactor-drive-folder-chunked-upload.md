# Refactor Drive Upload To Folder-Based Recording With Chunked Video

- **Status**: Draft
- **Date**: 2026-04-23
- **Owner**: Codex

## 1. Objective

Refactor flow upload/replay hiện tại từ mô hình "nhiều file ID rời truyền qua query params" sang mô hình "mỗi recording có một Google Drive folder riêng". Link replay chỉ truyền `folderId`; player sẽ tự liệt kê file trong folder theo naming pattern/manifest để tải toàn bộ artifact và gộp video nếu recording bị chia chunk do giới hạn upload 32 MB.

## 2. Research Summary

- `src/offscreen/offscreen.ts` hiện upload từng file riêng lẻ lên root Drive, make-shareable từng file, rồi build replay URL với query params `video`, `metadata`, `console`, `network`, `websocket`.
- `player/player.js` chỉ khởi tạo được khi URL có tối thiểu `video` và `metadata`; toàn bộ logic load dữ liệu hiện assume mỗi artifact có đúng 1 file ID.
- `player-standalone/src/drive-adapter.ts` đang load theo từng file ID riêng, chưa có API list folder contents hoặc manifest resolution.
- `src/background/service-worker.ts` chỉ cần một `recordingUrl` trả về từ offscreen; boundary này có thể giữ nguyên nếu offscreen đổi cách build URL.
- Current spec `specs/modules/drive-and-player.md` vẫn mô tả per-file-ID replay payload; spec này sẽ phải update sau khi code hoàn tất.

## 3. Proposed Architecture

### 3.1 Recording folder as primary storage unit

- Mỗi lần upload tạo 1 folder mới, ví dụ `gn-tracing-2026-04-23T...`.
- Toàn bộ artifacts của một recording nằm trong folder đó.
- Replay URL chỉ cần `?folder=<drive-folder-id>`.
- Metadata trong folder đóng vai trò source of truth cho phiên record.

### 3.2 Canonical file layout in Drive folder

- `metadata.json`
- `console.json`
- `network.json`
- `websocket.json`
- `video.part-000.webm`
- `video.part-001.webm`
- ...
- Tùy chọn thêm `manifest.json` để mô tả version schema, danh sách file, thứ tự chunk, mime type, duration, byte sizes.

Khuyến nghị:
- Dùng `manifest.json` thay vì chỉ dựa hoàn toàn vào naming pattern.
- Vẫn giữ naming pattern ổn định để player có fallback nếu manifest lỗi/missing.

### 3.3 Video chunking strategy

- Nếu `recordedBlob.size <= 32 MB`: upload 1 chunk `video.part-000.webm`.
- Nếu vượt ngưỡng: cắt `Blob` thành nhiều phần <= 32 MB và upload tuần tự hoặc song song có giới hạn.
- Chunking là byte-split ở mức `Blob.slice()`, không transcode lại video.

Giả định kỹ thuật cần chốt trước khi code:
- Player sẽ không phát từng chunk độc lập như playlist.
- Thay vào đó player phải tải toàn bộ chunk, `new Blob(chunks, { type: mimeType })`, rồi tạo một object URL duy nhất để phát.

Hệ quả:
- Cách này đơn giản nhất và khớp yêu cầu "load về và gộp lại".
- Không giải quyết streaming progressive cho recording rất lớn; player phải chờ đủ chunks cần thiết trước khi playback ổn định.

### 3.4 Folder discovery in player

- Input chính: `folder` query param.
- Player/drive-adapter gọi Google Drive API để list toàn bộ file con trong folder.
- Resolver map file theo:
  - exact names cho `metadata.json`, `console.json`, `network.json`, `websocket.json`
  - regex `^video\\.part-(\\d{3})\\.webm$` cho video chunks
- Nếu có `manifest.json`, dùng manifest trước; nếu không có thì fallback sang folder scan + pattern.

### 3.5 Shareability model

- Folder cần được set permission `anyone:reader`.
- Để an toàn, tiếp tục set permission world-readable cho từng file con sau upload vì Drive không phải lúc nào inherit link-sharing theo cách player cần.
- Replay link chỉ expose `folderId`, không expose các file IDs con.

## 4. Scope Of Code Changes

- `src/offscreen/offscreen.ts`
  - tạo folder recording
  - upload file vào folder
  - chunk video khi > 32 MB
  - tạo `manifest.json` + metadata mới
  - build replay URL với `folder`
- `src/background/service-worker.ts`
  - gần như giữ nguyên contract, chỉ nhận replay URL mới
- `src/shared/player-host.ts`
  - không đổi host, chỉ đổi query contract
- `player/player.js`
  - đổi init/load path sang folder-based resolution
  - tải và gộp video chunks trước khi bind `video.src`
- `player-standalone/src/drive-adapter.ts`
  - thêm list-folder API
  - thêm manifest/folder resolver
  - thêm helpers tải nhiều blob chunks
- `player-standalone/public/player.js`
  - sync lại từ `player/player.js`
- `specs/modules/drive-and-player.md`
- `specs/shared/data-models.md`
- `specs/_index.md`
- `specs/_sync.md`

## 5. Data Contract Changes

### 5.1 Replay URL

- Current: `/?video=<id>&metadata=<id>&console=<id>&network=<id>&websocket=<id>`
- Proposed: `/?folder=<folder-id>`

### 5.2 Metadata / manifest

Đề xuất tách vai trò:

- `metadata.json`
  - business metadata của recording: timestamp, duration, startTime, source URL, extension version
- `manifest.json`
  - storage layout metadata: schemaVersion, folderId, file names, chunk order, chunk count, mime type, total video bytes

Ví dụ manifest tối thiểu:

```json
{
  "schemaVersion": 1,
  "folderId": "drive-folder-id",
  "video": {
    "mimeType": "video/webm;codecs=vp9,opus",
    "parts": [
      "video.part-000.webm",
      "video.part-001.webm"
    ]
  },
  "artifacts": {
    "metadata": "metadata.json",
    "console": "console.json",
    "network": "network.json",
    "websocket": "websocket.json"
  }
}
```

## 6. Execution Plan

1. Refactor Drive upload helper trong offscreen để hỗ trợ create-folder + upload-into-folder + make-shareable.
2. Thêm chunking helper cho `recordedBlob` với giới hạn 32 MB và naming ổn định `video.part-XXX.webm`.
3. Đổi metadata generation và thêm `manifest.json`.
4. Đổi replay URL builder sang `folder`.
5. Thêm folder listing + manifest resolution trong `player-standalone/src/drive-adapter.ts`.
6. Refactor `player/player.js` để load theo folder, resolve artifacts, tải/gộp video chunks, rồi reuse pipeline render hiện có.
7. Sync standalone public player assets.
8. Self-review logic edge cases: missing artifact optional, chunk order, manifest missing, upload partial failure.
9. Cập nhật specs liên quan để phản ánh kiến trúc mới và quan hệ giữa upload/player/folder manifest.
10. Rebuild graph knowledge theo yêu cầu repo.

## 7. Risks

- Byte-splitting một file WebM rồi `new Blob([...chunks])` để ghép lại là hợp lệ cho tải xuống/phát lại sau khi đã ghép xong, nhưng không usable nếu muốn stream từng phần độc lập.
- Folder listing ở standalone mode có thể gặp giới hạn CORS/Drive behavior nếu chỉ dùng direct download URL; khả năng cao phải dựa vào Drive REST API endpoint list files công khai hoặc cơ chế fetch hiện có trong extension mode.
- Nếu upload một số artifact fail giữa chừng, cần rule rõ:
  - fail toàn bộ upload
  - hay cho phép replay degraded
  
Khuyến nghị:
- Fail toàn bộ nếu `metadata.json`, `manifest.json`, hoặc bất kỳ video part nào fail.
- Cho phép `console/network/websocket` optional như hiện tại, nhưng phải ghi rõ trong manifest file nào thực sự tồn tại.

## 8. Open Decisions Needing Approval

- Có thêm `manifest.json` làm source of truth thay vì chỉ scan folder theo pattern.
- Replay URL chuyển hoàn toàn sang `folder` và không còn hỗ trợ contract query per-file-ID cũ trong player mới.
- Video chunking chỉ phục vụ upload; player sẽ tải đủ parts rồi gộp local trước khi phát, không làm streaming/chuyển mã.
- Upload failure policy:
  - hard-fail nếu thiếu folder/manifest/metadata/video parts
  - soft-fail cho console/network/websocket

## 9. Expected Outcome

- Mỗi record trên Drive là một folder độc lập, dễ share và dễ quản lý.
- Link replay ngắn hơn và ổn định hơn vì chỉ mang `folderId`.
- Upload không còn bị chặn bởi file video > 32 MB.
- Player có thể tự resolve toàn bộ artifacts của một recording từ folder layout duy nhất.

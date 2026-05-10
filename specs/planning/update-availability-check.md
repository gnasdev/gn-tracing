# Auto-Update Qua GitHub Release

## Bối Cảnh

- User muốn triển khai hướng auto-update thật sự thông qua GitHub Release.
- Chrome auto-update cho extension self-hosted không dùng release `.zip` trực tiếp. Extension cần:
  - `update_url` trong `manifest.json`
  - update manifest XML ở URL đó
  - XML khai báo extension id, version mới và `codebase` trỏ tới file `.crx`
  - `.crx` phải được ký bằng cùng private key để giữ nguyên extension id
- Repo hiện có release flow theo tag `v*`, nhưng chỉ publish zip `gn-tracing-extension-${tag}.zip`.
- `manifest.template.json` đã có field `key`, nên extension id có thể ổn định nếu CRX được ký bằng private key tương ứng.

## Mục Tiêu

Thiết lập auto-update self-hosted cho Chrome/Chromium bằng GitHub Release assets:

- `manifest.template.json` có `update_url` ổn định.
- Release workflow tạo và publish `.crx`.
- Release workflow tạo và publish `updates.xml`.
- Các URL trong manifest/XML dùng dạng GitHub `releases/latest/download/...` để luôn trỏ tới release mới nhất.

## Ngoài Phạm Vi

- Không thay đổi logic recording/upload/player.
- Không tự tạo private key trong repo.
- Không commit private key.
- Không đảm bảo Chrome Web Store distribution; đây là self-hosted update path.

## Hướng Tiếp Cận Đề Xuất

### Manifest

- Thêm:
  - `update_url: "https://github.com/gnasdev/gn-tracing/releases/latest/download/updates.xml"`
- `update_url` phải xuất hiện trong `dist/manifest.json` thông qua build hiện có.

### Release Artifact

- Đổi release artifact auto-update sang tên ổn định:
  - `gn-tracing-extension.crx`
  - `updates.xml`
- Có thể vẫn giữ zip cho manual unpacked/debug distribution:
  - `gn-tracing-extension-${tag}.zip`
- `updates.xml` trỏ `codebase` tới:
  - `https://github.com/gnasdev/gn-tracing/releases/latest/download/gn-tracing-extension.crx`
- Vì GitHub documented `releases/latest/download/<asset-name>` redirect tới asset của latest release, URL này đảm bảo luôn dùng bản mới nhất nếu mỗi release upload cùng asset name.

### CRX Signing

- Release workflow cần secret chứa private key tương ứng với public `key` trong manifest.
- Đề xuất secret:
  - `CHROME_EXTENSION_PRIVATE_KEY`
- Script release sẽ:
  - đọc secret từ env
  - ghi tạm private key vào file trong runner
  - pack `dist/` thành CRX
  - xóa file tạm
- Nếu thiếu secret, release CI phải fail rõ ràng vì không thể tạo auto-update CRX hợp lệ.

### Update Manifest XML

- Script sinh `updates.xml` từ `dist/manifest.json` để lấy đúng version.
- Extension id hiện tại tính từ public key là:
  - `fomajjkcepcijpnghnkplinhibgonlpg`
- XML dùng format update manifest của Chrome:
  - root `gupdate`
  - `app appid="<extension-id>"`
  - `updatecheck codebase="<latest-crx-url>" version="<manifest-version>"`

### Popup Manual Check

- Popup thêm thao tác `Check Update` như một CTA phụ cạnh GitHub/contribution.
- Khi user bấm check:
  - hiện toast `Checking for updates...`
  - gọi `chrome.runtime.requestUpdateCheck()`
  - hiện kết quả bằng toast cho các status `update_available`, `no_update`, `throttled`
  - nếu API lỗi, vẫn hiện lỗi bằng toast thay vì dùng error block chính của recording/upload

## File Bị Ảnh Hưởng

- `manifest.template.json`
- `package.json`
- `package-lock.json`
- `.github/workflows/release.yml`
- `popup/popup.html`
- `popup/popup.css`
- `src/popup/popup.ts`
- thêm script release trong `scripts/`
- `specs/planning/update-availability-check.md`

## Công Việc Cần Làm

1. Thêm `update_url` vào manifest template.
2. Thêm script sinh `updates.xml` từ manifest built trong `dist/`.
3. Thêm dependency/tool để pack CRX3.
4. Thêm script release tạo zip manual, CRX auto-update và XML update manifest.
5. Cập nhật GitHub Actions để truyền secret private key và upload cả ba artifacts.
6. Thêm popup manual check update và toast status/result.
7. Chạy validation có mục tiêu:
   - `npm run typecheck`
   - `npm run release:build`
   - generate `updates.xml`

## Rủi Ro Và Ràng Buộc

- Auto-update sẽ không hoạt động nếu CRX không được ký bằng private key khớp với `manifest.template.json` field `key`.
- `releases/latest/download/...` phụ thuộc mỗi release upload asset cùng tên ổn định.
- Nếu package version và manifest version lệch nhau, Chrome chỉ quan tâm version trong manifest.
- Chrome/Chromium policy cho extension self-hosted có khác biệt theo OS và cách cài đặt; thay đổi này chuẩn hóa release artifacts, nhưng user vẫn cần cài bản CRX theo luồng self-hosted hợp lệ.

## Kiểm Chứng

- `dist/manifest.json` có `update_url` đúng.
- `updates.xml` có đúng extension id, version và latest CRX URL.
- Popup manual check update hiển thị toast khi bắt đầu check, khi throttled, khi không có update, khi có update, và khi API lỗi.
- Release workflow upload:
  - `gn-tracing-extension.crx`
  - `updates.xml`
  - `gn-tracing-extension-${tag}.zip`
- CRX được tạo từ `dist/` bằng private key CI.

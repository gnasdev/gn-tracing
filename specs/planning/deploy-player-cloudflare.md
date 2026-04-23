# Deploy Player To Cloudflare And Tag Release Workflow

- **Status**: Draft
- **Date**: 2026-04-23
- **Owner**: Codex

## 1. Objective

Thiết lập luồng deploy standalone player của `gn-tracing` lên Cloudflare, hardcode player host trong extension, và thêm GitHub Actions release flow chạy theo tag.

## 2. Research Summary

- `player-standalone/` là static Vite app, phù hợp với Cloudflare Pages hơn Cloudflare Workers.
- Repo hiện đã có logic popup cho phép user override `playerHostUrl` qua `chrome.storage.local`.
- `src/offscreen/offscreen.ts` tạo link replay theo thứ tự:
  - user-configured external host
  - built-in extension player
- `../infra/scripts/deploy-cf-pages.sh` đã chuẩn hóa cách dùng `wrangler pages deploy` với `CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`.
- Secret thô không còn nằm trong `../infra/credentials.txt`; source of truth đã chuyển sang `../infra/platform/shared/infra-secrets.enc.yaml` hoặc Kubernetes secret `infra-secrets`.
- `../infra/specs/modules/gn-tracing/gn-tracing.md` đã ghi nhận host mục tiêu hiện tại là `https://tracing.gnas.dev/player/`.
- Repo hiện chưa có `.github/workflows/`.

## 3. Proposed Architecture

### 3.1 Hosting choice

Chọn **Cloudflare Pages** thay vì Workers vì:

- standalone player là static bundle
- không cần server-side logic
- deploy artifact trực tiếp từ `player-standalone/dist`
- khớp với hạ tầng và script đã có trong `../infra`

### 3.2 Fixed player host

Hardcode host phát replay thành:

`https://tracing.gnas.dev/`

Hệ quả chủ động chấp nhận:

- bỏ cấu hình player host động trong popup
- bỏ phụ thuộc `PLAYER_CONFIG_KEY` trong flow upload
- link replay sau upload luôn trỏ về Cloudflare Pages host cố định

### 3.3 Release workflow by tag

Thêm GitHub Actions trigger theo tag, ví dụ `v*`, gồm:

1. checkout repo
2. setup Node
3. install dependencies cho root và `player-standalone/`
4. sync player assets
5. build extension
6. build standalone player
7. publish standalone player lên Cloudflare Pages qua Wrangler
8. đóng gói `dist/` extension thành release artifact
9. attach artifact vào GitHub Release của tag

## 4. Files Expected To Change

- `.github/workflows/release.yml`
- `player-standalone/package.json`
- `player-standalone/deploy.sh`
- `player-standalone/vite.config.ts`
- `src/offscreen/offscreen.ts`
- `src/popup/popup.ts`
- `popup/popup.html`
- `src/types/messages.ts`
- `src/background/service-worker.ts`
- `README.md`
- `specs/modules/drive-and-player.md`
- `specs/shared/data-models.md`
- `specs/_sync.md`

## 5. Secret Handling Plan

- Không commit raw Cloudflare token vào repo.
- Dùng chuẩn secret name:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- Workflow GitHub sẽ đọc từ GitHub Actions secrets.
- Ghi chú trong docs cách lấy giá trị từ `../infra`:
  - qua `task secrets:decrypt -- platform/shared/infra-secrets.enc.yaml`
  - hoặc `kubectl get secret infra-secrets -n kube-system ...`

## 6. Risks

- Nếu Cloudflare Pages project `gn-tracing-player` hoặc custom domain `tracing.gnas.dev` chưa tồn tại, workflow deploy sẽ fail dù code đúng.
- Hardcode host sẽ loại bỏ khả năng đổi player host từ popup.
- Nếu base path Pages/domain không thực sự là `/player/`, bundle assets sẽ lỗi path sau deploy.

## 7. Execution Steps

1. Chuẩn hóa Pages deploy config cho `player-standalone/`.
2. Hardcode external player host trong extension upload flow.
3. Xóa UI/config storage liên quan đến editable player host.
4. Thêm GitHub workflow release theo tag.
5. Cập nhật README và specs theo kiến trúc mới.
6. Chạy typecheck hợp lý nếu khả thi, rồi cập nhật graphify.

## 8. Approval Needed

Cần xác nhận trước khi code vì thay đổi này:

- loại bỏ player host cấu hình động trong popup
- chuyển mặc định replay sang host cố định `https://tracing.gnas.dev/player/`
- áp dụng release pipeline mới dựa trên tag + GitHub secrets

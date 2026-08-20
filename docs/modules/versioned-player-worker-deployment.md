---
title: "Versioned Player and Worker Deployment"
description: "Local development and immutable production deployment for the replay Player and OAuth Worker."
type: deployment
status: active
tags: ["player", "worker", "cloudflare", "r2", "release", "versioning"]
source_paths:
  - "Taskfile.yml"
  - "releases/registry.json"
  - "scripts/prepare-player-release-entry.mjs"
  - "scripts/release-player-version.mjs"
  - "scripts/release-worker-version.mjs"
  - "scripts/generate-player-router-config.mjs"
  - "scripts/generate-worker-router-config.mjs"
  - "edge/player-router/src/index.ts"
  - "edge/worker-router/src/index.ts"
related:
  - "./oauth-token-proxy.md"
  - "./drive-and-player.md"
  - "../build-from-scratch/09-taskfile-commands.md"
---

# Triển khai Player và Worker theo version

Chạy mọi lệnh trong tài liệu này từ repository root. Local development dùng mã hiện tại; production phát hành một Player artifact R2 và một Worker service bất biến cho từng product version.

## Mô hình route production

`releases/registry.json` là danh sách append-only của các release đã phát hành. Mỗi entry ghim:

- source commit;
- R2 prefix và checksum của Player;
- tên immutable Worker service và Service Binding của nó.

Player production không chạy từ Cloudflare Pages. `gn-tracing-player-router` đọc artifact từ bucket `gn-tracing-player-releases` theo prefix `player/<version>/`. OAuth Worker public `gn-tracing-oauth-proxy` dispatch request đến Service Binding của đúng release.

| URL | Hành vi |
| --- | --- |
| `https://tracing.gnas.dev/<version>/...` | Player artifact của đúng `<version>` |
| `https://tracing.gnas.dev/...` | Alias explicit đến `LATEST_RELEASE_VERSION` |
| `https://gn-tracing-oauth-proxy.cors-ngosangns.workers.dev/<version>/...` | Immutable OAuth Worker của đúng `<version>` |
| `https://gn-tracing-oauth-proxy.cors-ngosangns.workers.dev/...` | Alias explicit đến `LATEST_RELEASE_VERSION` |

Một route có version chưa đăng ký trả `404 release_not_found`; nó không được rơi sang release mới nhất. Player response có `x-gn-player-release`; Worker response có `x-gn-worker-release`. Route không có version còn có `x-gn-release-alias: latest`.

`task player:deploy` deploy Cloudflare Pages cũ. Không dùng lệnh đó để phát hành Player tại `tracing.gnas.dev`.

## Chạy local

### Điều kiện local

Cài dependencies theo [DEVELOPER.md](../../DEVELOPER.md), sau đó tạo root `.env` từ `.env.example`. Không commit `.env` hoặc `worker/.dev.vars`.

Development extension mặc định gọi Worker ở `http://localhost:63972` và mở Player ở `http://localhost:5176`. Có thể override bằng các biến `*_TOKEN_PROXY_URL_DEV`, `FEEDBACK_PROXY_URL_DEV`, `PLAYER_HOST_URL_DEV`, và `PLAYER_LOCAL_PORT` trong `.env`.

`task worker:sync-dev-vars` sao chép OAuth client ids, secrets và feedback token từ root `.env` vào `worker/.dev.vars`. File này có mode local, bị git-ignore, và được `task worker:dev` gọi tự động.

### Full stack

```bash
task dev
```

Lệnh này chạy extension watch cho Chrome và Firefox, Vite Player ở `http://localhost:5176`, và Wrangler Worker ở `http://localhost:63972`. Dùng một target hoặc toàn bộ matrix khi cần:

```bash
task dev                    # Chrome + Firefox (default)
task dev BROWSER=both       # tương đương default, ghi rõ khi cần
task dev BROWSER=chrome
task dev BROWSER=edge
task dev BROWSER=opera
task dev BROWSER=firefox
task dev BROWSER=all
```

Player và Worker dùng chung theo repository. Nếu một process đang phục vụ đúng port, `task dev`, `task player:dev`, và `task worker:dev` tái sử dụng nó thay vì bind thêm process.

### Chạy từng service

```bash
task player:dev
# http://localhost:5176

task worker:dev
# http://localhost:63972
```

Kiểm tra Worker bằng version hiện tại trong `package.json`:

```bash
VERSION="$(node -p \"require('./package.json').version\")"
curl -i "http://localhost:63972/${VERSION}/health"
curl -i http://localhost:63972/health
```

Worker local chấp nhận cả route có prefix version và route legacy. Extension dev build dùng endpoint versioned của version hiện tại, ví dụ `/${VERSION}/token` và `/${VERSION}/token/dropbox`.

Vite Player local chỉ phục vụ version hiện tại. Ví dụ với version `1.7.14`, `/1.7.14/gdrive/<id>` được xử lý bởi Player local; `/1.7.13/gdrive/<id>` và `/9.9.9/gdrive/<id>` trả `404 local_release_not_available`. Historical Player chỉ tồn tại trên production R2/router.

## Chuẩn bị production release

### Điều kiện trước khi mutate production

- Worktree sạch trước khi bắt đầu.
- Root, `player/`, và `worker/` cùng một core semver `MAJOR.MINOR.PATCH`.
- Cloudflare credentials đã sẵn sàng: `CLOUDFLARE_API_TOKEN` và `CLOUDFLARE_ACCOUNT_ID`.
- Ít nhất một OAuth provider Worker được cấu hình bằng client id và client secret. `worker/deploy.sh` kiểm tra điều này.
- Production proxy origins, extension id/key và OAuth client ids có trong `.env` hoặc process environment.

Kiểm tra trước:

```bash
git status --short
npx wrangler whoami
npm run quality:gate
```

### 1. Bump version và tạo pinned source commit

Thay `1.7.15` bằng release mới. Không tái sử dụng version đã có trong registry hoặc R2.

```bash
VERSION=1.7.15

npm version "$VERSION" --no-git-tag-version --ignore-scripts
(cd player && npm version "$VERSION" --no-git-tag-version --ignore-scripts)
(cd worker && npm version "$VERSION" --no-git-tag-version --ignore-scripts)

npm run version:check
git add package.json package-lock.json \
  player/package.json player/package-lock.json \
  worker/package.json worker/package-lock.json
git commit -m "chore(release): bump product version to ${VERSION}"
git push origin main
```

Commit này là source commit được ghi vào registry. Các script immutable kiểm tra `HEAD` bắt đầu bằng `sourceCommit` đã ghim.

### 2. Tạo registry entry nhưng chưa commit registry

```bash
task player:release:entry
task player:release:register
task release:registry:check
task release:registry:typecheck
```

`player:release:entry` build Player bằng `VITE_BASE_PATH=/${VERSION}/`, in candidate gồm R2 prefix/checksum/Worker naming, và không sửa registry. Kiểm tra candidate trước khi chạy `player:release:register`.

Sau `player:release:register`, `releases/registry.json` phải là thay đổi chưa commit. Đây là thứ tự bắt buộc: registry entry chứa source commit của bước 1, còn `HEAD` vẫn phải là commit đó cho bước upload/deploy bất biến ở bước 3. Nếu commit registry sớm, `HEAD` đổi sang registry commit và các script sẽ từ chối deploy vì pinned source commit không khớp.

### 3. Publish artifact và immutable Worker khi `HEAD` vẫn là source commit

```bash
task player:release:upload
task worker:release:deploy
```

`task player:release:upload` rebuild Player, kiểm tra checksum đúng registry, ghi `release.json`, kiểm tra `player/${VERSION}/release.json` chưa có trong R2, rồi upload. Prefix đã có `release.json` không được ghi đè.

`task worker:release:deploy` kiểm tra deterministic service/binding names, generate dispatcher bindings từ registry, và deploy `gn-tracing-oauth-proxy-v<version-with-dashes>`. Nó không deploy public dispatcher.

Không chạy hai lệnh này song song: cả hai dùng build/generated output và cùng dựa vào registry đang dirty.

### 4. Commit registry, rồi cập nhật public aliases

Chỉ tiếp tục khi R2 upload và immutable Worker deploy đều thành công.

```bash
git add releases/registry.json
git commit -m "chore(release): register immutable ${VERSION} artifacts"
git push origin main

task edge:worker:deploy LATEST_RELEASE_VERSION="$VERSION"
task edge:player:deploy LATEST_RELEASE_VERSION="$VERSION"
```

`edge:worker:deploy` generate một binding cho mỗi registry release rồi deploy public dispatcher `gn-tracing-oauth-proxy`. `edge:player:deploy` deploy public R2 router `gn-tracing-player-router`. Cả hai lệnh từ chối `LATEST_RELEASE_VERSION` trống hoặc absent khỏi registry.

Public dispatcher deploy có thể chạy sau registry commit vì chúng không có kiểm tra `HEAD` bằng pinned source commit.

### 5. Kiểm tra production

Dùng một historical version thực có trong registry, ở đây là `1.7.11`.

```bash
PLAYER=https://tracing.gnas.dev
WORKER=https://gn-tracing-oauth-proxy.cors-ngosangns.workers.dev

curl -i "${PLAYER}/${VERSION}/gdrive/release-smoke"
curl -i "${PLAYER}/gdrive/release-smoke"
curl -i "${PLAYER}/1.7.11/gdrive/release-smoke"
curl -i "${PLAYER}/9.9.9/gdrive/release-smoke"

curl -i "${WORKER}/${VERSION}/health"
curl -i "${WORKER}/health"
curl -i "${WORKER}/9.9.9/health"
```

Kỳ vọng:

| Request | Kết quả |
| --- | --- |
| Player `/${VERSION}/...` | `200`, `x-gn-player-release: ${VERSION}` |
| Player legacy `/...` | `200`, current release header, `x-gn-release-alias: latest` |
| Historical Player `/1.7.11/...` | `200`, `x-gn-player-release: 1.7.11` |
| Unknown Player `/9.9.9/...` | `404` và `release_not_found` |
| Worker `/${VERSION}/health` | `200`, `x-gn-worker-release: ${VERSION}` |
| Worker legacy `/health` | `200`, current Worker header, `x-gn-release-alias: latest` |
| Unknown Worker `/9.9.9/health` | `404` và `release_not_found` |

## Hoàn tất product release

Sau khi Worker/Player production smoke pass, có thể phát hành extension và GitHub Release:

```bash
task store:release

git tag -a "v${VERSION}" -m "GN Tracing v${VERSION}"
git push origin "v${VERSION}"
```

`task store:release` build, audit, zip, upload và submit Chrome package. Chrome review chạy bất đồng bộ; `task store:status` có thể vẫn hiển thị version cũ là `PUBLISHED` cùng version mới là `PENDING_REVIEW`.

Push tag chạy `.github/workflows/release.yml` để tạo GitHub Release và upload package bốn browser. Workflow này không deploy Worker hoặc Player.

```bash
gh run list --workflow release.yml --limit 3
gh release view "v${VERSION}"
git fetch --prune origin --tags
git status --short
git branch -vv
git tag --points-at HEAD
```

Repository phải sạch, `main` phải bằng `origin/main`, và local/remote annotated tag phải trỏ đến registry commit của release.

# Chrome Web Store Final Readiness Cleanup

## Bối Cảnh

GN Tracing đã có một đợt Store-readiness implementation gồm privacy docs, Store submission notes, popup privacy controls, header redaction, optional body/WebSocket payload capture, Drive share-permission hardening, manifest permission reduction, production build safeguards, and Store package validation.

Worktree hiện có nhiều thay đổi chưa commit. Claude Code sẽ được dùng như sub-agent để review và triển khai cleanup cuối cùng trên chính phần thay đổi này, không revert hoặc rewrite ngoài phạm vi.

## Mục Tiêu

1. Kiểm tra implementation hiện tại cho các lỗi nhỏ còn sót trước khi submit Store package.
2. Hoàn thiện các điểm polish có rủi ro thấp nhưng làm tăng độ chắc của Store readiness.
3. Giữ validation pass: root/player typecheck, dependency audits, production Store package check.

## Ngoài Phạm Vi

- Không thay đổi product architecture lớn.
- Không thêm backend hoặc thay hosted player model.
- Không publish Chrome Web Store listing.
- Không commit/stage/push.

## Phạm Vi File Cho Claude Code

Claude Code được phép sửa trong các khu vực sau nếu cần:

- `src/background/cdp-manager.ts`
- `src/background/service-worker.ts`
- `src/offscreen/offscreen.ts`
- `src/popup/popup.ts`
- `src/types/messages.ts`
- `popup/popup.html`
- `popup/popup.css`
- `manifest.template.json`
- `manifest.json`
- `esbuild.config.mjs`
- `Taskfile.yml`
- `scripts/check-store-package.mjs`
- `README.md`
- `DEVELOPER.md`
- `docs/compliance/`
- `docs/modules/`
- `docs/shared/`
- `docs/_index.md`
- `docs/_sync.md`

Nếu thấy cần sửa ngoài danh sách này, Claude Code phải ghi rõ lý do trong final report.

## Công Việc Cần Làm

1. Review diff hiện tại và tìm lỗi implementation rõ ràng:
   - privacy setting defaults/migration;
   - race hoặc stale UI trong popup toggles;
   - redaction coverage for redirect/request/response/early-hints headers;
   - response/request body opt-in behavior;
   - WebSocket payload opt-in behavior;
   - Store manifest/package check assumptions.
2. Sửa các lỗi nhỏ tìm thấy, ưu tiên thay đổi cục bộ.
3. Nếu không cần sửa code, chỉ cập nhật docs/checklist khi có gap rõ ràng.
4. Không revert thay đổi hiện có của main agent.
5. Chạy validation mục tiêu phù hợp:
   - `npx tsc --noEmit`
   - `npm exec -- tsc --noEmit` trong `player-standalone`
   - nếu có đủ env hoặc dùng env hiện có từ prompt, chạy Store package check.

## Rủi Ro Và Ràng Buộc

- Worktree đang dirty; mọi thay đổi cần phối hợp với diff hiện tại.
- Production build yêu cầu `GOOGLE_CLIENT_ID`, `CHROME_EXTENSION_ID`, và `CHROME_EXTENSION_PUBLIC_KEY`.
- Không dùng permission bypass nguy hiểm cho Claude Code.
- Không tạo thêm plan/changelog dài; docs phải mô tả trạng thái hiện tại.

## Acceptance Criteria

- Không còn lỗi typecheck.
- Store package check vẫn pass khi truyền identity env hợp lệ.
- Privacy behavior nhất quán giữa code, README, developer guide, module docs, compliance docs.
- Final report của Claude Code nêu rõ file đã đọc/sửa, command đã chạy, rủi ro còn lại.

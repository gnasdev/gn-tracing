# Chrome Web Store Readiness Review

## Bối Cảnh

GN Tracing là Manifest V3 extension dùng `tabCapture`, offscreen document, Chrome Debugger Protocol, Google Drive OAuth và hosted player tại `https://tracing.gnas.dev/` để tạo replay link cho phiên ghi tab. Review này đánh giá trạng thái hiện tại của repo sau đợt Store-readiness hardening.

Nguồn tham chiếu chính:

- `manifest.template.json`: manifest source of truth cho Store package.
- `src/background/service-worker.ts`: orchestration, settings, state sync, upload trigger.
- `src/background/cdp-manager.ts`: console/network/WebSocket/source map capture và data minimization.
- `src/background/google-drive-auth.ts`: Chrome/Edge OAuth token handling.
- `src/offscreen/offscreen.ts`: media capture, Drive upload, public-by-link sharing.
- `popup/`, `src/popup/popup.ts`: disclosure và capture privacy controls.
- `docs/compliance/privacy-policy.md`: privacy policy language.
- `docs/compliance/chrome-web-store-submission.md`: Store listing/reviewer notes.
- Chrome Web Store Program Policies and privacy-field guidance from official Chrome Developers docs:
  - `https://developer.chrome.com/docs/webstore/program-policies/policies`
  - `https://developer.chrome.com/docs/webstore/cws-dashboard-privacy`

## Kết Luận Readiness

Repo hiện **gần đủ điều kiện kỹ thuật để submit Chrome Web Store**, nhưng **chưa nên bấm submit cho tới khi hoàn tất các bước ngoài repo**:

1. Publish privacy policy ở một URL public ổn định và điền URL đó trong Store dashboard.
2. Điền Chrome Web Store privacy fields/data usage đúng theo docs compliance mới.
3. Chuẩn bị listing assets: screenshots, support/contact URL, short/long description, reviewer notes.
4. Chạy manual smoke test bằng Chrome stable với `dist/` production package thật.
5. Xác nhận Google Cloud OAuth consent/app publishing status phù hợp với Store release.

Các blocker code/package lớn đã được giảm đáng kể:

- Manifest không còn `host_permissions: ["<all_urls>"]`.
- Manifest không còn broad `web_accessible_resources`.
- Production build yêu cầu explicit OAuth/extension identity.
- Production artifact không chứa source maps.
- Store package check scan remote scripts, `eval`, `new Function`, placeholders, manifest shape, and source maps.
- Sensitive headers are redacted by default.
- Request bodies, response bodies, and WebSocket message payloads are opt-in.
- Popup shows capture/share disclosure.
- Drive share-permission creation now fails required upload flows instead of silently returning broken replay links.
- Compliance docs now describe privacy policy, single purpose, permission justifications, data usage, remote code answer, and reviewer instructions.

## Mục Tiêu Còn Lại

1. Hoàn tất các điều kiện submit ngoài repo.
2. Chạy manual validation trên extension package thật.
3. Giữ docs/compliance đồng bộ với Store dashboard answers.
4. Không mở rộng scope kỹ thuật nếu package hiện tại đã qua validation.

## Ngoài Phạm Vi

- Không đổi core product purpose.
- Không thay Google Drive upload hoặc hosted player model.
- Không tự động publish Chrome Web Store listing từ repo.
- Không thay thế CDP nếu reviewer chưa yêu cầu.

## Findings Hiện Tại

### Đã Đủ Tốt Trong Repo

1. Manifest scope đã được thu hẹp. Store manifest source hiện chỉ dùng `tabCapture`, `offscreen`, `debugger`, `activeTab`, `storage`, `alarms`, và `identity`; không còn broad host permissions.

2. Data minimization mặc định đã tốt hơn. Sensitive headers được redact theo header-name patterns; request/response body và WebSocket payload text đều off by default và chỉ capture khi user bật trong popup.

3. Privacy disclosure đã có trong UI và docs. Popup nói rõ selected tab video, console logs, network metadata, redacted headers, và replay files readable by link. Compliance docs mô tả Drive upload/public-by-link behavior.

4. Production package có guardrail. `task store:check` chạy typecheck, audits, production build, manifest/package sanity, source-map rejection, and remote-code static checks.

5. Drive reliability tốt hơn. Required artifact share-permission failure giờ fail upload rõ ràng thay vì tạo replay URL không chắc load được.

### Chưa Đủ Trước Khi Submit Thật

1. Privacy policy mới chỉ tồn tại trong repo. Chrome Web Store cần URL public ổn định.

2. Store dashboard answers chưa được điền/kiểm chứng. Các answer phải khớp chính xác với `docs/compliance/chrome-web-store-submission.md`.

3. Chưa có manual smoke evidence trên Chrome stable package thật. Automated checks không thay thế được flow record -> upload -> replay.

4. OAuth/Google Cloud app status chưa được xác minh trong repo. Nếu OAuth consent screen còn test/internal hoặc chưa authorized đúng extension id, reviewer/user flow có thể fail dù code pass.

5. Listing assets chưa có trong repo. Screenshots, support/contact URL, and reviewer instructions cần chuẩn bị trước submit.

## Hướng Tiếp Cận Đề Xuất

### Phase 1: External Submission Prep

- Publish `docs/compliance/privacy-policy.md` to a stable public URL.
- Use `docs/compliance/chrome-web-store-submission.md` as source for:
  - single purpose;
  - permission justifications;
  - data usage disclosure;
  - remote code answer;
  - reviewer instructions.
- Confirm support/contact URL and issue tracker URL.
- Prepare Chrome Web Store screenshots from a clean production build.

### Phase 2: Manual Smoke Test

Use a production `dist/` package generated by `task store:check` or `task store:zip`.

Test cases:

1. Load unpacked extension in Chrome stable.
2. Connect Google Drive.
3. Record a normal page with default privacy settings.
4. Confirm network headers are redacted and body/WebSocket payloads are not included by default.
5. Enable request bodies, response bodies, and WebSocket messages; record a controlled test page and confirm payloads appear only when enabled.
6. Stop recording, upload, open replay link.
7. Confirm generated Drive files/folder are readable by link and replay works.
8. Disconnect Google Drive and reconnect.
9. Confirm failure behavior when Drive sharing fails if testable.

### Phase 3: Store Package Finalization

- Run `task store:check` with real Store identity env.
- Run `task store:zip` to create `gn-tracing-store.zip`.
- Inspect `dist/manifest.json`:
  - MV3;
  - no host permissions;
  - no web accessible resources;
  - expected OAuth client id;
  - expected public key/extension id.
- Upload `gn-tracing-store.zip` to the Store dashboard.

### Phase 4: Reviewer Notes And Risk Handling

Reviewer notes should explicitly say:

- GN Tracing records only after a user clicks Start Recording in the popup.
- It rejects `chrome://` pages.
- It uses `debugger` only for the selected tab during active recording and detaches on stop/tab close.
- Google Drive scope is `drive.file`; the extension creates GN Tracing files and makes replay artifacts readable by link.
- Request bodies, response bodies, and WebSocket message payloads are off by default and require user opt-in.
- Sensitive headers are redacted by default.
- The extension does not load remote executable JavaScript inside extension pages.

## Công Việc Cần Làm

1. Publish privacy policy URL.
2. Fill Store privacy/data-use fields from `docs/compliance/chrome-web-store-submission.md`.
3. Prepare listing copy and screenshots.
4. Verify Google Cloud OAuth consent and Chrome extension ID mapping.
5. Run manual Chrome stable smoke test.
6. Run `task store:check`.
7. Run `task store:zip`.
8. Upload package and include reviewer instructions.

## Rủi Ro Và Ràng Buộc

- `debugger` remains the highest review-risk permission. The product purpose is valid, but reviewer notes must be precise.
- Public-by-link Drive replay is a deliberate product behavior and must remain disclosed everywhere.
- Removing broad host permissions should be validated on real pages; if a browser API flow unexpectedly requires host permissions, revisit manifest and Store justification.
- The hosted player and Cloudflare `/api/drive` proxy are outside the extension package but are part of the user-facing replay flow; they should be operational before submission.
- Chrome Web Store policy can change; re-check official docs immediately before final dashboard submission.

## Kiểm Chứng Đã Chạy

- `npx tsc --noEmit`: pass.
- `npm exec -- tsc --noEmit` in `player-standalone`: pass.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `npm audit` in `player-standalone`: 0 vulnerabilities.
- `task store:check` with matching test identity env: pass.

Note: one `task store:check` run intentionally failed after a mistyped `CHROME_EXTENSION_PUBLIC_KEY`; the build correctly rejected extension id/public key mismatch. Rerunning with the matching key passed.

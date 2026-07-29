# Gỡ Hồ Sơ Capture Và Privacy Profile

## Bối Cảnh

Trang Settings hiện có hai lớp **preset radio**:

1. **Capture Profile** — `lean` / `balanced` / `full` / `custom`: khi chọn preset, ghi đè hàng loạt toggle capture (console, network, WebSocket, byte limits).
2. **Privacy & Redaction profile** — `standard` / `strict` / `custom`: khi chọn preset, ghi đè hàng loạt toggle redaction; engine redaction còn dùng `privacyProfile` để bật/tắt rule (credential vs personal/location/opaque-id).

Yêu cầu sản phẩm:

- **Bỏ** tính năng hồ sơ Capture và hồ sơ Privacy & Redaction (preset).
- **Mặc định** dùng **CDP**.
- **Mặc định recording đầy đủ** (full capture, không preset “gầy”).

Toggle chi tiết (console / network / redaction checkbox / capture mode) **giữ lại** — user vẫn tinh chỉnh tay, không còn lớp preset phía trên.

## Nguyên Nhân Gốc Rễ / Lệch Hiện Trạng

| Kỳ vọng / docs | Code thực tế |
| --- | --- |
| Docs/`README` nói `captureMode` default `"cdp"` | `DEFAULT_CAPTURE_PRIVACY_SETTINGS.captureMode` và Settings UI default là **`"in-page"`** |
| Full debug là default capture profile | Đúng (`captureProfile: "full"`) nhưng vẫn có lean/balanced + logic apply preset |
| Privacy-first: storage/DOM opt-in | Default `captureStorage` / `captureDomSnapshots` = `false` (dù coupling force-on khi `captureNetwork` bật) |
| Settings “đơn giản” | Hai grid profile + auto-switch sang `custom` khi user đụng advanced control |

## Mục Tiêu

1. Xóa UI + logic preset **Capture Profile** và **Privacy profile**.
2. Default runtime: `captureMode: "cdp"`, toàn bộ capture channel bật ở mức **full** (bodies, stacks, frames, limits `null` where applicable).
3. Redaction: không còn preset standard/strict; rule set ổn định theo **một mức cố định** (standard-class rules khi toggle bật); toggle redaction từng surface vẫn hoạt động.
4. Persist/migrate: settings cũ còn `captureProfile` / `privacyProfile` không làm vỡ load; không còn phụ thuộc preset khi thiếu field.
5. Cập nhật test + docs module liên quan.

## Ngoài Phạm Vi

- Xóa engine redaction hoặc `privacy.json` artifact.
- Xóa chế độ in-page (vẫn chọn được qua `captureMode`).
- Đổi policy rule table chi tiết (credential patterns, v.v.) ngoài việc gỡ phụ thuộc UI profile.
- Instant replay default (vẫn off — cần host permission).
- Popup UX ngoài settings.

## Thiết Kế Sau Thay Đổi

```mermaid
flowchart TB
  subgraph settings [Settings page]
    Cap[Capture toggles: console / network / WS / inspector]
    Red[Redaction toggles + DOM mask selectors]
    Mode[captureMode: cdp | in-page]
  end
  subgraph store [settings-store]
    Def[DEFAULT_CAPTURE_PRIVACY_SETTINGS full + cdp]
    Norm[normalize: per-field fallback, no preset apply]
  end
  subgraph runtime [Recording]
    CDP[CdpManager default]
    InPage[In-page opt-in]
    Pol[Redaction policy fixed rule set + toggles]
  end
  Cap --> Norm
  Red --> Norm
  Mode --> Norm
  Def --> Norm
  Norm --> CDP
  Norm --> InPage
  Norm --> Pol
```

### Defaults (“recording tất cả” + CDP)

| Setting | Giá trị mặc định mới |
| --- | --- |
| `captureMode` | `"cdp"` |
| Console / network / WebSocket | full (giống preset `full` hiện tại) |
| Request/response bodies, WS frames | bật; byte limits `null` (không giới hạn) |
| `captureStorage` / `captureDomSnapshots` | **`true`** (ghi rõ “record all”; coupling network vẫn giữ nếu còn) |
| Redaction toggles | giữ bảo vệ mặc định **bật** (headers/query/body/console/event; WS = `sensitive-fields`) — “record all” = capture đầy đủ, không phải tắt redaction secrets |
| `privacyProfile` (nội bộ / artifact) | cố định `"custom"` (hoặc bỏ field UI; metadata package vẫn ghi profile ổn định) |
| `captureProfile` | **gỡ khỏi contract** (ignore khi load settings cũ) |

> **Quyết định redaction:** “recording tất cả” = capture surface đầy đủ, **không** mặc định tắt redaction credential. Nếu muốn default “không redact gì”, cần xác nhận thêm trước khi implement.

### Privacy profile trong engine

Hiện rule có `profiles: STANDARD_PROFILES | STRICT_PROFILES`. Sau khi gỡ UI:

- **Mặc định rule set = standard** (credential/payment + bearer/jwt…; **không** auto bật personal/email/uuid strict).
- Lưu settings luôn `privacyProfile: "custom"` (custom ∈ STANDARD_PROFILES → cùng rule set standard).
- User đã lưu `strict` trước đó: **migrate về `"custom"`** khi normalize (strict không còn product surface). Nếu cần giữ strict cho install cũ, ghi rõ alternate trong lúc duyệt — mặc định plan: migrate về custom/standard rules.

`getPrivacyProfileSettings` có thể giữ làm factory cho test/default toggles, hoặc thu gọn thành `DEFAULT_PRIVACY_REDACTION_SETTINGS` tĩnh.

### Capture profile

- Xóa `getCaptureProfileSettings` / `getCapturePresetSettings` và radio UI.
- `normalizeUploadSettingsStore` fallback **trực tiếp** từ `DEFAULT_CAPTURE_PRIVACY_SETTINGS`, không derive theo `captureProfile` cũ.
- Field `captureProfile` trên `UploadSettings` / snapshot: **remove**; storage cũ có field thì ignore.

## Phạm Vi File (dự kiến)

| Vùng | File |
| --- | --- |
| UI | `settings/settings.html`, `settings/settings.css` (profile grid nếu chỉ dùng cho profile), `src/settings/settings.ts` |
| Store / defaults | `src/background/settings-store.ts` |
| Types | `src/types/messages.ts` |
| Call sites privacy default | `src/background/cdp-manager.ts`, `src/background/storage-manager.ts`, `src/content/recording-events.ts` (chỉ nếu import profile helper thay đổi) |
| Tests | `src/background/settings-store.test.ts`, settings-related nếu có; factories nếu bắt buộc `captureProfile` |
| Docs | `docs/modules/privacy-and-redaction.md`, `docs/modules/recording-runtime.md` (nếu nhắc profile/default mode), `README.md` nếu mô tả preset |
| Schema package | `packages/replay-core/src/schema/privacy.ts` — **giữ** `PrivacyProfile` type cho artifact/policy (backward package); không bắt buộc gỡ khỏi redaction core trong PR này |

## Các Bước Triển Khai

1. **Defaults + normalize**
   - `captureMode: "cdp"`.
   - Full capture defaults; `captureStorage` / `captureDomSnapshots` = `true`.
   - Bỏ nhánh derive từ `captureProfile`; ignore field legacy.
   - `privacyProfile` normalize → luôn `"custom"` (migrate strict/standard stored).
2. **Types / snapshot**
   - Gỡ `CaptureProfile` và `captureProfile` khỏi `UploadSettings` / store / `getSettingsSnapshot`.
   - Giữ `privacyProfile` trên settings + privacy artifact (giá trị cố định `"custom"`) để không đụng schema package lớn; hoặc ghi `"custom"` khi build `privacy.json` only.
3. **Settings UI**
   - Xóa section Capture Profile.
   - Xóa radio grid Privacy profile; giữ “Data redaction” + “Visual masking”.
   - Xóa i18n keys preset (en/vi) và handler `applyCaptureProfileLocal` / `applyPrivacyProfileLocal` / auto-switch custom.
4. **Tests**
   - Cập nhật `settings-store.test.ts` (không còn lean → disable bodies).
   - Thêm/điều chỉnh assert default `captureMode === "cdp"`, storage/DOM default on.
5. **Docs**
   - Module privacy: không còn mô tả preset UI standard/strict/custom như product surface; mô tả toggles + rule set cố định.
   - Ghi default CDP + full capture.

## Rủi Ro

| Rủi ro | Xử lý |
| --- | --- |
| User lean cũ mất “nhẹ” sau reload nếu chỉ còn partial stored fields | Normalize không còn fill từ lean; field đã persist vẫn giữ giá trị đã lưu |
| User strict mất personal/uuid redaction | Accept theo migrate; ghi trong release note / plan |
| CDP default hiện banner debugger | Trade-off có chủ đích (fidelity); in-page vẫn chọn được |
| Storage/DOM default on tăng PII surface | Redaction companion vẫn default on; user tắt được |
| Package `privacy.profile` đổi nghĩa | Luôn `"custom"` sau migrate; player/MCP chỉ hiển thị string |

## Kiểm Chứng

- Unit: `settings-store` load empty → CDP + full capture + storage/DOM on; load legacy `{ captureProfile: "lean", ...partial }` không crash, không re-apply lean cho field thiếu.
- Settings page: không còn radio profile; Save/Load toggles redaction + capture mode.
- Smoke record (manual): default session attach CDP (banner), network/console đầy đủ.
- `task test` / suite liên quan settings-store + privacy factories vẫn pass.

## Acceptance (user impact)

- [x] Settings không còn section **Capture Profile** hay radio **Standard/Strict/Custom**.
- [x] Install mới / settings trống: **CDP**, capture full, storage + DOM snapshot on.
- [x] Redaction từng ô vẫn bật/tắt được; không còn “đổi profile ghi đè hàng loạt”.
- [x] Legacy storage không crash.
- [x] Docs module/README khớp default CDP + không quảng cáo profile preset.

## Câu Hỏi Cần Duyệt (nếu khác giả định)

1. Redaction default **giữ bật** (chỉ bỏ profile) — OK?
2. Install cũ `privacyProfile: "strict"` → migrate về custom/standard rules — OK?
3. `captureStorage` / `captureDomSnapshots` default **on** — OK, hay chỉ full network/console/WS?
`)

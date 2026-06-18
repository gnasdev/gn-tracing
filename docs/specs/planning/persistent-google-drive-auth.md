# Persistent Google Drive Auth (PKCE + Refresh Token)

## Bối Cảnh

User trên các Chromium browser không phải Chrome (Edge / Brave / Vivaldi / Opera / Arc) hiện tại bị **ép login lại mỗi ~1 giờ** và mỗi lần đóng/mở browser. Trên Chrome chính hãng, popup cũng hiện flash "Not connected" khi khởi động lại browser dù token vẫn dùng được.

Root cause đã xác định trong research trước (`common_pitfalls_experience`):
1. Web auth flow dùng **OAuth 2.0 implicit flow** (`response_type=token`) → không có `refresh_token`, access token `expires_in=3600`, hết hạn là phải login lại.
2. `prompt=consent` ép hiện consent screen → không thể silent re-auth kể cả khi Google còn session cho user.
3. Auth snapshot ghi vào `chrome.storage.session` (xóa khi browser đóng) → popup flash "Not connected" trên mọi browser.

Plan cũ `chromium-auth-and-codebase-cleanup.md` đã **loại trừ** đường fix này vì cho rằng authorization code flow cần backend giữ secret. Đây là sai lầm: **Chrome extension là public client (no client secret)** và Google hỗ trợ **Authorization Code Flow with PKCE** (`response_type=code` + `code_challenge`) cho public client từ 2019. Không cần backend.

## Nguyên Nhân Và Lý Do Thiết Kế

### Tại sao PKCE + refresh token là đường đi đúng

- Chrome extension (manifest v3) chạy trong extension context, là **public OAuth client** (không có client secret). Google hỗ trợ PKCE cho mọi public client từ OAuth 2.0 spec; đây là cách [Google khuyến nghị](https://developers.google.com/identity/protocols/oauth2/native-app) cho installed applications.
- Authorization code flow trả về cả `access_token` lẫn `refresh_token` (khi `access_type=offline`). Refresh token **không hết hạn** trừ khi user revoke hoặc 6 tháng không dùng (Google policy mới nhất 2024).
- Khi access token hết hạn, extension dùng refresh token để đổi access token mới **hoàn toàn silent** (không cần mở consent screen). Nếu Google trả `invalid_grant` (refresh token bị revoke), extension mới yêu cầu user login lại.
- PKCE bảo vệ authorization code khỏi bị đánh cắp bởi malicious app trong cùng redirect URI namespace (Chrome extension redirect URI là `https://<extension-id>.chromiumapp.org/`, đã được Chrome isolate).

### Tại sao vẫn phải mirror `isConnected` vào `chrome.storage.local`

- `chrome.storage.session` bị wipe mỗi khi browser đóng (Chrome policy).
- Service worker MV3 có thể bị terminate bất cứ lúc nào và restart, in-memory `googleDriveState.isConnected` reset về `false`.
- Popup cần paint đúng trạng thái auth ngay lần render đầu tiên trước khi service worker kịp re-verify (race window ~1s). Đây là perceived performance fix, không phải logic fix.

### Tại sao giữ nguyên strategy pattern + facade

- 2 strategy (`chrome` cho Chrome chính hãng, `web` cho Chromium khác) đã làm việc tốt.
- `chrome.identity.getAuthToken` của Chrome strategy đã tự refresh token ở OS-level; không cần thay đổi gì.
- Web strategy cần thay đổi implementation, không cần đổi interface `TokenProvider`.
- `GoogleDriveAuth` facade giữ nguyên public API → không consumer nào phải đổi.

## Mục Tiêu

1. User trên Edge/Brave/Vivaldi/Opera/Arc chỉ phải login **một lần** cho mỗi lần revoke; refresh token giữ user connected vĩnh viễn.
2. Access token hết hạn → silent refresh bằng refresh token, không mở consent screen, không popup.
3. Refresh token hết hạn / bị revoke → fallback về login flow như cũ.
4. Popup paint đúng trạng thái auth khi browser vừa khởi động, trước khi service worker re-verify (zero flicker).
5. Không đổi message contract → không consumer nào (popup, offscreen, player, drive-auth page) phải đổi code.
6. Không phá vỡ Chrome strategy (`getAuthToken` path).

## Ngoài Phạm Vi

- Không thay đổi OAuth client_id, manifest key, hay store publication.
- Không thêm backend/proxy server.
- Không đổi các module khác ngoài `src/background/google-drive-auth.ts`, `src/background/service-worker.ts`, `src/popup/popup.ts`, `src/drive-auth/drive-auth.ts` (chỉ touch nếu cần), `docs/modules/drive-and-player.md`.
- Không đổi authorization scope (vẫn `drive.file`).
- Không thêm dependency mới (dùng Web Crypto API có sẵn cho SHA-256 + base64url).

## Logic Nghiệp Vụ

### 1. Web flow dùng Authorization Code + PKCE

- Khi user click Connect, generate:
  - `code_verifier`: 32 random bytes, base64url-encoded (RFC 7636).
  - `code_challenge`: SHA-256 của `code_verifier`, base64url-encoded.
  - `state`: 16 random bytes, base64url-encoded (CSRF protection, dù verify cùng `code_verifier` cũng đủ cho extension).
- Auth URL đổi từ `response_type=token` sang `response_type=code`, thêm `code_challenge` + `code_challenge_method=S256` + `access_type=offline` + `prompt=consent` (chỉ lần đầu) hoặc `prompt=none` (lần sau nếu muốn silent re-auth khi refresh token cũng fail).
- Redirect về `https://<extension-id>.chromiumapp.org/?code=...&state=...`.
- Verify state khớp, extract `code`.
- Exchange code tại `https://oauth2.googleapis.com/token` với `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `redirect_uri`.
- Response: `{ access_token, refresh_token, expires_in, scope, token_type }`.
- Lưu vào `chrome.storage.local` dưới key `gn_tracing_webauth_tokens`:
  ```ts
  interface WebAuthTokens {
    accessToken: string;
    refreshToken: string;       // ← KEY FIX
    expiresAt: number;          // Date.now() + expires_in * 1000 - buffer
    scope: string;
    tokenType: string;
  }
  ```
- Verify token bằng `GET drive/v3/files?pageSize=1` như cũ.

### 2. Silent refresh bằng refresh token

- Khi `getAuthToken()` được gọi:
  - Nếu `Date.now() < cached.expiresAt - 30s` → trả `cached.accessToken` (không gọi mạng).
  - Nếu đã hết hạn → gọi `https://oauth2.googleapis.com/token` với `grant_type=refresh_token`, `refresh_token`, `client_id`.
  - Response thành công: cập nhật `accessToken` + `expiresAt`. **Google KHÔNG trả lại `refresh_token` mới khi refresh** (chỉ lần đầu authorize có `refresh_token`); giữ nguyên `refreshToken` cũ.
  - Response lỗi (`invalid_grant`, `invalid_client`): xóa cache, return `null` → user phải login lại.

### 3. Migration từ implicit flow tokens

- Cấu trúc token cũ (`gn_tracing_webauth_token`, schema `{ accessToken, expiresAt }`) không có `refresh_token`. Sau khi fix, các user đang connected sẽ bị "logged out" lần đầu sau khi update extension (vì cache không có `refreshToken`).
- Mitigation: xóa cache cũ khi gặp schema thiếu `refreshToken` → force user login lại 1 lần, sau đó persistent.
- Migration key cũ: `gn_tracing_webauth_token` → key mới: `gn_tracing_webauth_tokens` (số nhiều để phản ánh có cả access + refresh).

### 4. Mirror `isConnected` vào `chrome.storage.local`

- Thêm key mới: `gn_tracing_google_drive_connected` (boolean).
- Mỗi lần `refreshGoogleDriveState()` cập nhật, đồng thời write key này vào `chrome.storage.local`.
- Popup đọc key này **đầu tiên** (synchronous-like qua `chrome.storage.local.get`) để paint UI ngay khi mở, **không phụ thuộc** service worker re-hydration.
- Sau khi service worker re-verify xong và `saveStateToStorage()` chạy, popup update lại từ `chrome.storage.session` (giữ contract cũ).
- Trên Chrome strategy, cần network call để verify token (offline → fail). Có thể:
  - Option A: trust cached token (Chrome OS-level cache) khi popup khởi động, chỉ verify khi user trigger action.
  - Option B: verify với timeout ngắn (2s), nếu timeout/fail thì vẫn mark connected nếu local mirror là `true`.
  - **Chọn Option B**: vẫn verify để phát hiện token bị revoke, nhưng không block UI.

### 5. Cập nhật popup flow

- Trong `popup.ts:initPopup()`:
  - Trước khi `loadStateFromStorage()`, đọc `gn_tracing_google_drive_connected` từ `chrome.storage.local`. Nếu `true` → set UI connected ngay lập tức.
  - Sau đó, gọi `refreshGoogleDriveStatus()` (đã có) để service worker re-verify và update qua `chrome.storage.session.onChanged`.
  - Nếu service worker trả về `isConnected: false` (token bị revoke), UI update từ connected → disconnected. User click Connect lại.

### 6. disconnect() phải xóa cả 2 key

- `disconnect()` xóa `gn_tracing_webauth_tokens` (hoặc cả key mới) **và** `gn_tracing_google_drive_connected` (set về `false`).
- Revoke cả `access_token` lẫn `refresh_token` tại `https://oauth2.googleapis.com/revoke` để cleanup phía Google (giữ UX cũ: best-effort, không fail flow).

## Cấu Trúc Giải Pháp

### File thay đổi

| File | Thay đổi |
|---|---|
| [src/background/google-drive-auth.ts](file:///Users/ngosangns/Github/gn-tracing/src/background/google-drive-auth.ts) | PKCE helpers, đổi `WebAuthFlowProvider.launchInteractive` sang code flow, thêm `refreshAccessToken`, thêm `silentRefresh` vào `getAuthToken`, đổi storage key + schema, cải thiện error message từ `exchangeAuthorizationCode` để surface network/HTTP detail |
| [src/background/service-worker.ts](file:///Users/ngosangns/Github/gn-tracing/src/background/service-worker.ts) | `refreshGoogleDriveState` mirror `isConnected` vào `chrome.storage.local` key `gn_tracing_google_drive_connected` |
| [src/popup/popup.ts](file:///Users/ngosangns/Github/gn-tracing/src/popup/popup.ts) | Trong `initPopup` đọc mirror từ `chrome.storage.local` trước khi load session state |
| [docs/modules/drive-and-player.md](file:///Users/ngosangns/Github/gn-tracing/docs/modules/drive-and-player.md) | Cập nhật business rules mục 4 để phản ánh auth code + PKCE + refresh token |
| [manifest.template.json](file:///Users/ngosangns/Github/gn-tracing/manifest.template.json) + [manifest.json](file:///Users/ngosangns/Github/gn-tracing/manifest.json) | Thêm `https://oauth2.googleapis.com/` và `https://www.googleapis.com/` vào `host_permissions` để service worker được phép gọi OAuth token endpoint và Drive API (bắt buộc cho PKCE exchange + refresh + revoke + verify) |

### Không thay đổi

- `src/types/messages.ts` — `PopupState.googleDrive.isConnected` shape giữ nguyên, không cần mở rộng.
- `src/drive-auth/drive-auth.ts` — page chỉ trigger `GOOGLE_DRIVE_CONNECT` message, không cần biết flow bên trong.
- `src/offscreen/offscreen.ts` — chỉ consume token qua `GET_GOOGLE_DRIVE_TOKEN`.
- `player/player.js` — chỉ consume token qua `GET_GOOGLE_DRIVE_TOKEN`.
- OAuth redirect URI không đổi (`https://<extension-id>.chromiumapp.org/`) — vẫn dùng `chrome.identity.getRedirectURL()`.

### PKCE helpers (pseudo)

```ts
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
```

### Web flow auth URL

```ts
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth" +
  `?client_id=${GOOGLE_CLIENT_ID}` +
  "&response_type=code" +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&scope=${encodeURIComponent(DRIVE_SCOPE)}` +
  `&code_challenge=${codeChallenge}` +
  "&code_challenge_method=S256" +
  `&state=${state}` +
  "&access_type=offline" +
  "&prompt=consent"; // first run only; refresh token returned once
```

### Web flow token exchange

```ts
async function exchangeCodeForTokens(code: string, codeVerifier: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) return null;
  return await response.json();
  // { access_token, refresh_token, expires_in, scope, token_type, id_token? }
}
```

### Silent refresh

```ts
async function refreshAccessToken(refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) return null;
  return await response.json();
  // { access_token, expires_in, scope, token_type } -- no refresh_token
}
```

## Kiểm Chứng

1. **TypeScript build**: `npx tsc --noEmit` phải pass.
2. **Linter**: `npx biome check src/background/google-drive-auth.ts src/background/service-worker.ts src/popup/popup.ts` phải pass.
3. **Manual smoke** (sau khi build, load extension vào Chrome):
   - Connect Drive lần đầu → consent screen → token saved.
   - Đợi > 1 giờ (hoặc sửa `expiresAt` trong DevTools) → trigger action → silent refresh, không consent screen.
   - Đóng browser, mở lại → popup connected ngay lập tức, không flash.
   - Click Disconnect → token + mirror xóa, UI về "Not connected".

## Rủi Ro & Giảm Thiểu

- **Refresh token bị Google revoke khi không dùng 6 tháng**: User phải login lại, OK vì đây là Google policy chứ không phải bug. UI đã có flow reconnect.
- **OAuth client chưa được config để hỗ trợ PKCE**: PKCE là opt-in ở client, không cần Google config. Mọi OAuth client từ 2019 đều hỗ trợ.
- **Build size tăng**: PKCE helpers là Web Crypto API, zero dependency. Tăng < 1KB.
- **Edge case: state mismatch**: Nếu user mở tab khác trigger `launchWebAuthFlow` trong khi flow cũ đang chạy → state mismatch → reject response, user retry. Acceptable.

## Related Decisions

- Plan cũ `chromium-auth-and-codebase-cleanup.md` mục "Ngoài Phạm Vi" loại trừ auth code flow với lý do "cần backend giữ secret" — **không còn đúng** với PKCE. Plan này supersede quyết định đó.
- Chrome strategy vẫn dùng `chrome.identity.getAuthToken` (Chrome OS-level refresh tự động), không cần đổi.
- Mirror `isConnected` vào `chrome.storage.local` là fix cho race condition popup khi MV3 service worker restart, không phải cho auth logic. Nên làm như một phần của fix này để user experience hoàn chỉnh.

# Vendored webm-seek-fix

Browser build of the same WebM seek contract as `src/shared/webm-seek-fix.ts`.
Used by non-bundled `player/player.js` via `window.gnMakeWebmSeekable`.

## Primary package

| Package | Version | Role | License |
| --- | --- | --- | --- |
| [`webm-duration-fix`](https://www.npmjs.com/package/webm-duration-fix) | `1.0.4` | Rebuilds SeekHead + Duration + Cues (ts-ebml family) | ISC |

## Generated artifact

| File | Global | How built |
| --- | --- | --- |
| `webm-seek-fix.iife.js` | `window.gnMakeWebmSeekable` | `npm run vendor:webm-seek` |

Do not hand-edit `webm-seek-fix.iife.js`. Rebuild after upgrading `webm-duration-fix`.

## API (matches TypeScript)

```js
const result = await gnMakeWebmSeekable(blob, { mimeType?: string });
// { ok: true, blob, method: "cues" | "noop" }
// { ok: false, blob /* original */, reason: string }
```

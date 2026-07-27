# Screenshot Player UI Polish

> **Status: shipped (P0–P2).** Screenshot stage: ẩn tab-bar khi chỉ còn stills; report strip (badge/caption/chips/URL); figure full-bleed hơn; multi-shot nav; instant-replay accent; empty-evidence panel.

## Design read

*Product inspection UI cho teammate/agent đọc screenshot report — dark, calm, evidence-first; không landing/marketing.*

**Dials:** variance 4 · motion 2 · density 5 (focused still, meta chips, ít chrome).

## Đánh Giá Từ Screenshot Hiện Tại

### Đã ổn

| Điểm | Ghi chú |
| --- | --- |
| Presentation mode | Không còn cột video / Console / Network rỗng |
| Ảnh rõ, đủ lớn | Capture YouTube đọc được |
| Header có context | `GN Tracing · youtube.com · watch · time` |
| Dark theme nhất quán | Khớp player recording |

### Vấn đề (theo mức độ)

#### P0 — Hierarchy / “đây là gì?”

1. **Tab bar một mục “Screenshots”**
   Chỉ một tab active dưới header → cảm giác còn sót shell log-player, không phải destination. Với screenshot-only package, tab bar **không mang thông tin** (không có tab khác để chuyển).

2. **Không có report chrome**
   Không caption, không “What is wrong here?”, không badge “Screenshot report”. Người mở link chỉ thấy ảnh trang web lồng trong card — **không biết đây là bug report** hay preview ngẫu nhiên.

3. **Meta dòng dưới ảnh yếu**
   `https://www.youtube.com/watch?v=… · 1032×884 · captured image`
   - URL full dài, cạnh resolution + source kind, một dòng phụ mờ.
   - Không tách **page title** (nếu có trong artifact), **captured time**, **viewport** thành chips dễ quét.
   - “captured image” là jargon producer, không phải ngôn ngữ reporter.

#### P1 — Layout / density

4. **Card nổi giữa void**
   `max-width: 960px` + padding lớn + nền tối → nhiều dead space hai bên/dưới trên màn rộng. Ảnh là hero nhưng bị “thu nhỏ trong khung phụ”.

5. **Khung card đôi**
   Border-radius + border quanh cả page capture (vốn đã là UI browser) → double chrome: browser-in-browser. Với 1 shot, figure nên gần full-bleed hơn, meta tách layer.

6. **Figure `max-height: 70vh`**
   Trên desktop cao, ảnh bị letterbox trong card; khoảng trống dưới meta lãng phí. Nên ưu tiên **chiều rộng available** và cho scroll dọc nếu cao.

#### P2 — States & multi-shot

7. **Không empty/annotation affordance**
   Khi reporter không vẽ shape / không caption: UI im lặng. Nên có secondary line kiểu “No caption or annotations from the reporter” (không blame) để agent/human biết không sót render.

8. **N ≥ 2 screenshots**
   List card dọc OK về sau; cần thumb strip hoặc step indicator — chưa gấp nếu 95% report = 1 shot.

9. **Instant replay card**
   Khi có: đừng trông như annotation list phụ; section riêng với label rõ “Before the report”.

#### Không phải bug UI (ngoài scope polish)

- Thiếu annotation trên ảnh này = reporter không vẽ — player đúng.
- Wire console/network lúc save = producer plan khác.

## Mục Tiêu

1. Mở screenshot link → **3 giây** hiểu: đây là screenshot report, trang nào, reporter nói gì (nếu có).
2. Ảnh là **primary canvas**; chrome player lùi lại (header gọn, không tab giả).
3. Meta scannable (chips), URL truncate + copy/open.
4. 1-shot: layout gần full-bleed; multi-shot: không vỡ.
5. Giữ dark theme + token CSS hiện có; không redesign toàn player recording.

## Hướng Thiết Kế (đề xuất)

### A. Screenshot-only chrome

Khi `presentation-screenshot`:

```text
┌─ Header: logo · short page host/title · time · actions ─────────────┐
│  (không tab bar, hoặc tab bar ẩn hoàn toàn)                         │
├─ Report strip (optional) ───────────────────────────────────────────┤
│  Badge: Screenshot report                                           │
│  Caption (large) | placeholder nếu trống                            │
│  Chips: host · viewport · captured · source                         │
│  Link: truncated URL [Open ↗] [Copy]                                │
├─ Stage ─────────────────────────────────────────────────────────────┤
│  [  image + annotation overlay — max width ~min(100%, 1200px) ]     │
├─ Annotations (nếu có) ──────────────────────────────────────────────┤
│  list describeAnnotation                                            │
└─ Instant replay (nếu có) ───────────────────────────────────────────┘
```

- **Ẩn `.tab-bar`** trong screenshot mode (JS class + CSS). Một tab duy nhất không cần UI tab.
- Viewer không bọc trong “logs panel” visual (bỏ cảm giác secondary pane): background stage = `--bg-app`, figure không cần card border nặng.

### B. Meta & caption

| Element | Rule |
| --- | --- |
| Caption | Nếu có: typography title (18–20px, weight 600) phía trên ảnh. Nếu không: một dòng muted `screenshots.noCaption` |
| URL | Truncate middle/end; `title` full; button Open (đã có pattern report link) + optional copy |
| Viewport / time / source | Chips ngang, không nhét chung một câu với URL |
| Page title | Dùng `shot.title` nếu package có; fallback host từ URL |

### C. Figure / image

- Bỏ hoặc giảm border card quanh figure; shadow nhẹ hoặc hairline.
- `max-width: min(1120px, 100%)`; `max-height: min(78vh, 900px)` hoặc theo width-first.
- `object-fit: contain`; nền figure = neutral elevated, không “double browser chrome” dày.
- Overlay SVG giữ absolute trên figure (đã đúng).

### D. Header

- Giữ actions: Copy for AI, lang, theme, feedback.
- Subtitle: ưu tiên **page title hoặc path ngắn**, không cần lặp “Screenshots” ở tab + header.

## Lộ Trình

### P0 — Chrome + hierarchy (1 PR)

1. CSS/JS: `presentation-screenshot` → **hide `.tab-bar`**.
2. `buildScreenshotCard` / wrapper:
   - Report strip: badge + caption/placeholder + chips + truncated URL actions.
3. i18n EN/VI: badge, noCaption, openLink, source labels humanized.
4. Giảm card padding/border; stage full-width centered.

**Acceptance**

- [ ] Screenshot-only: không thấy tab “Screenshots” đơn độc.
- [ ] Có dòng nhận diện “Screenshot report” + caption hoặc placeholder.
- [ ] Meta không còn một dòng URL+resolution dính nhau khó đọc.
- [ ] Ảnh vẫn align annotation overlay.

### P1 — Stage polish

1. Width/height figure theo viewport; bớt letterbox thừa.
2. Hover/focus: optional zoom or “Open image in new tab” (blob URL).
3. Multi-shot: sticky thumbs hoặc “1 / N” nếu `shots.length > 1`.

**Acceptance**

- [ ] Desktop wide: ảnh dùng chiều ngang tốt hơn card 960px hiện tại.
- [ ] 2+ shots: điều hướng rõ, không chỉ scroll mù.

### P2 — Instant replay + empty evidence

1. Style block instant replay (border-left accent, title đã i18n).
2. `empty-evidence` mode: centered message (keys đã có `presentation.empty*`) — verify visual.

## Phạm Vi File

| File | Việc |
| --- | --- |
| `player/player.js` | Hide tab-bar; rebuild screenshot card structure; chips/truncate helpers |
| `player/player.css` | Stage layout, hide tab-bar, figure, chips, caption |
| `player/player.html` / standalone | Chỉ nếu cần node tĩnh (ưu tiên build DOM trong JS) |
| i18n trong `player.js` | Keys mới EN/VI |
| `docs/modules/replay-player.md` | Mô tả screenshot chrome |
| Tests | i18n key parity; optional DOM structure snapshot nhẹ |

## Ngoài Phạm Vi

- Thay đổi annotate editor / bắt buộc caption khi save.
- Producer gắn console/network.
- Light-theme-only redesign.
- Animation nặng / lightbox library mới (P1 open-in-tab đủ).

## Rủi Ro

| Rủi ro | Mitigation |
| --- | --- |
| Ẩn tab-bar làm multi-artifact screenshot+console khó khám phá | Chỉ ẩn tab-bar khi **duy nhất** screenshots tab visible; nếu plan bật console → giữ tab-bar |
| Truncate URL phá copy | Copy luôn full `shot.url` |
| Overlay lệch sau đổi figure CSS | Giữ figure `position:relative` + aspect-ratio từ viewport; test 1 fixture annotated |

## Quyết Định Mặc Định (khi implement)

1. Ẩn tab-bar **chỉ khi** không còn tab evidence nào khác (screenshot-only thuần).
2. Caption trống → placeholder muted, không fake caption.
3. Không bắt user annotate — polish pure presentation.

## Liên Quan

- [player-screenshot-mode.md](./player-screenshot-mode.md) (presentation mode — shipped)
- `src/shared/player-presentation.ts`
- `player/player.js` `buildScreenshotCard` / `renderScreenshotsTab`

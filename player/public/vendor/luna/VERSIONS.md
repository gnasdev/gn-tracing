# Vendored luna-\* bundles

Prebuilt standalone (UMD) bundles vendored from the [`liriliri/luna`](https://github.com/liriliri/luna)
UI library. These are loaded in the player via plain `<link>` + `<script>` tags
(see `player/player.html` and `player/index.html`) because
`player/player.js` is non-bundled vanilla JS and cannot `import` npm modules
(see design.md PHẦN A.2).

## Pinned versions

| Package | Version | Files | Exposed global | License |
| --- | --- | --- | --- | --- |
| [`luna-object-viewer`](https://www.npmjs.com/package/luna-object-viewer) | `0.3.2` | `luna-object-viewer.js`, `luna-object-viewer.css` | `window.LunaObjectViewer` | MIT |
| [`luna-json-editor`](https://www.npmjs.com/package/luna-json-editor) | `0.1.0` | `luna-json-editor.js`, `luna-json-editor.css` | `window.LunaJsonEditor` | MIT |

The exposed global names above were verified by inspecting the UMD wrapper of
each bundle (the `t.LunaObjectViewer=n()` / `t.LunaJsonEditor=e()` fallback
branch that assigns onto the global `window`). Task 11 (render adapter) must use
exactly these global names.

## How these were obtained (reproducible)

```sh
npm pack luna-object-viewer@0.3.2 luna-json-editor@0.1.0
tar -xzf luna-object-viewer-0.3.2.tgz
tar -xzf luna-json-editor-0.1.0.tgz
# copy the prebuilt UMD bundle + css from each package root:
#   package/luna-object-viewer.js   -> player/vendor/luna/luna-object-viewer.js
#   package/luna-object-viewer.css  -> player/vendor/luna/luna-object-viewer.css
#   package/luna-json-editor.js     -> player/vendor/luna/luna-json-editor.js
#   package/luna-json-editor.css    -> player/vendor/luna/luna-json-editor.css
```

Source maps (`*.js.map`, `*.css.map`) are intentionally NOT vendored — they are
not needed at runtime and reference upstream source paths.

## Licensing / attribution

Both packages are MIT licensed (compatible with this repo's GPL-3.0, see
design.md PHẦN A.4). The upstream MIT license text and copyright notice are
preserved in `player/vendor/luna/LICENSE`.

## Upgrading

1. Bump the versions in the `npm pack` command above and re-extract.
2. Copy the four bundle files into this directory.
3. Re-verify the exposed global name in each `.js` UMD wrapper and update the
   table above if upstream renames a global.
4. Update the version column above.

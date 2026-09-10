# Woof logo

Accepted concept 10, traced into four editable vector paths. Every logo asset is symbol-only; no visible lettering or embedded raster image.

- `woof.svg`: transparent lavender mark for dark surfaces.
- `woof-ink.svg`: transparent charcoal mark for light surfaces.
- `tile-dark.svg`: lavender mark on charcoal.
- `tile-light.svg`: charcoal mark on pale lavender.
- `icons/<variant>/<size>.png`: 16, 24, 32, 48, 64, 128, 180, 256 and 512 px exports of all four variants.
- `favicon.ico`: dark tile with 16, 32, 48, 64, 128 and 256 px frames.
- `preview.html`: theme and actual-size comparison.

The SVGs use a 1024-unit square canvas. Tiles have a 64-unit corner radius (6.25% of the side) and approximately 12% horizontal padding. Transparent marks use approximately 6% horizontal padding. Palette: lavender `#c3c7f5`, charcoal `#1c1c28`, pale lavender `#f0f0fc`. All cutouts are transparent, allowing the surrounding surface to show through.

Prefer 32 px or larger when the eye and bark details matter. The 16 px export is provided for favicon use; fine features naturally soften at that size.

## Source and review

The draw-svg run is at `../../artifacts/draw-svg/woof-20260910/`. It preserves the source, candidate, full-size render, comparison and browser review. One candidate was drawn and selected (v001); stop reason: sufficient. Browser checks covered all four panels, contrast overlays at 25% and 75%, enlarged contours, original colors, and the exported icons at their actual sizes. No conspicuous silhouette mismatch was found. The vector uses a flat fill instead of the raster's slight texture, and antialiasing differs; it is not pixel-identical.

Regenerate exports with `python3 assets/brand/export.py` from the repository root (Pillow and CairoSVG required). The export script reads the reviewed vector, not the generated concept PNG.

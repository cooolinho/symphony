// Masonry building block: a CSS grid with 4 px rows in which every card spans as many rows as it is tall.
//
// span = ceil((height + gap) / unit); the card gets `grid-row-end: span n`. The gap between cards is the card's
// margin-bottom (= column-gap), row-gap stays 0.
//
// The 4 px rows only apply with the activation class `masonry-on` (set by the observer script of E2-2, once it can
// measure). Without it (no JS, no spans) the rows are auto-high and the container is a plain, readable grid.
//
// Not wired into any page yet (E3-1), no ResizeObserver here (E2-2). All top-level names of the script start with
// `masonry` / `MASONRY_` so they cannot clash with the page script.

export const MASONRY_UNIT_PX = 4;
export const MASONRY_GAP_PX = 16;
export const MASONRY_MIN_COL_PX = 380;
export const MASONRY_WIDE_MIN_VIEWPORT_PX = 1220;

export const MASONRY_CSS = `
.masonry {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(${MASONRY_MIN_COL_PX}px, 100%), 1fr));
  column-gap: ${MASONRY_GAP_PX}px;
  row-gap: 0;
  grid-auto-flow: row dense;
  align-items: start;
}
.masonry.masonry-on { grid-auto-rows: ${MASONRY_UNIT_PX}px; }
.masonry > * { align-self: start; min-width: 0; margin-bottom: ${MASONRY_GAP_PX}px; }
@media (min-width: ${MASONRY_WIDE_MIN_VIEWPORT_PX}px) {
  .masonry > .wide { grid-column: span 2; }
}
`;

export const MASONRY_JS = `
const MASONRY_UNIT = ${MASONRY_UNIT_PX};
const MASONRY_GAP = ${MASONRY_GAP_PX};

// Pure: number of grid rows a card of the given height occupies (inputs that make no sense fall back to defaults).
function masonrySpan(height, gap, unit) {
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  const g = Number.isFinite(gap) && gap >= 0 ? gap : MASONRY_GAP;
  const u = Number.isFinite(unit) && unit > 0 ? unit : MASONRY_UNIT;
  return Math.max(1, Math.ceil((h + g) / u));
}

// Writes grid-row-end only when the span differs from the remembered one; returns whether it wrote.
function masonryApplySpan(card, span) {
  if (!Number.isInteger(span) || span < 1) return false;
  const n = String(span);
  if (card.dataset.masonrySpan === n) return false;
  card.dataset.masonrySpan = n;
  card.style.gridRowEnd = 'span ' + n;
  return true;
}
`;

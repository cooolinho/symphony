/**
 * The Laravel Boost mark (the square of the logo in laravel/boost's art/boost-dark-mode.svg). Served as a data URI
 * so the pages stay self-contained and each <img> keeps its own SVG ids.
 */
const BOOST_ICON_SVG = `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#c)">
<rect width="64" height="64" fill="url(#p)"/>
<g filter="url(#f0)"><ellipse cx="4" cy="4.5" rx="32" ry="31.5" fill="#EFB0F9"/></g>
<g filter="url(#f1)"><ellipse cx="49" cy="50.5" rx="38" ry="37.5" fill="#B29FF4"/></g>
<mask id="m" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="32" width="64" height="32">
<rect width="64" height="32" transform="matrix(1 0 0 -1 0 64)" fill="#D9D9D9"/>
</mask>
<g mask="url(#m)"><g filter="url(#f2)"><ellipse cx="17" cy="44.5" rx="32" ry="31.5" fill="#D8F8EF"/></g></g>
<rect x="15.0769" y="15.0769" width="24.6154" height="24.6154" stroke="black" stroke-width="6.15385"/>
<rect x="21.9997" y="22" width="29.2308" height="29.2308" stroke="black" stroke-width="1.53846"/>
<rect x="26.6149" y="26.6154" width="20" height="20" stroke="black" stroke-width="1.53846"/>
</g>
<defs>
<filter id="f0" x="-58" y="-57" width="124" height="123" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="15"/></filter>
<filter id="f1" x="-19" y="-17" width="136" height="135" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="15"/></filter>
<filter id="f2" x="-45" y="-17" width="124" height="123" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="15"/></filter>
<radialGradient id="p" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(32 32) scale(32)">
<stop stop-color="#EEE6F4"/><stop offset="1" stop-color="#DBE0F6"/>
</radialGradient>
<clipPath id="c"><rect width="64" height="64" rx="12" fill="white"/></clipPath>
</defs>
</svg>`;

export const BOOST_ICON_URI = `data:image/svg+xml;base64,${Buffer.from(BOOST_ICON_SVG).toString('base64')}`;

/**
 * Line icons of the mockup (24×24, stroke in currentColor, round caps). w = stroke width, j = round line joins,
 * s = shapes: a string is a path, [cx, cy, r] a circle.
 */
const ICON_DEFS: Record<string, { w: number; j?: true; s: (string | [number, number, number])[] }> = {
  // Navigation
  home: { w: 1.9, j: true, s: ['M3 11l9-7 9 7', 'M5 10v10h14V10'] },
  changes: { w: 1.9, j: true, s: [[6, 6, 2.5], [18, 18, 2.5], 'M6 8.5v4a5 5 0 0 0 5 5h4.5'] },
  tasks: { w: 1.9, j: true, s: ['M4 6h1.5', 'M4 12h1.5', 'M4 18h1.5', 'M9 6h11', 'M9 12h11', 'M9 18h11'] },
  brain: { w: 1.9, j: true, s: ['M9.5 4A3 3 0 0 0 6.5 7a3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3V4z', 'M14.5 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V4z'] },
  stats: { w: 1.9, j: true, s: ['M5 20V11', 'M12 20V4', 'M19 20v-7'] },
  // Roles
  analyst: { w: 1.8, s: [[11, 11, 6], 'M20 20l-4.5-4.5'] },
  architect: { w: 1.8, j: true, s: ['M12 3l-7 18', 'M12 3l7 18', 'M7.5 15h9', [12, 3.5, 1.5]] },
  developer: { w: 1.8, j: true, s: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M13.5 5l-3 14'] },
  tester: { w: 1.8, j: true, s: ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3', 'M7.5 15h9'] },
  docs: { w: 1.8, j: true, s: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20'] },
  reviewer: { w: 1.8, j: true, s: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', [12, 12, 3]] },
  security: { w: 1.8, j: true, s: ['M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z'] },
  human: { w: 1.8, j: true, s: [[12, 8, 4], 'M4 21a8 8 0 0 1 16 0'] },
  // Symbols
  check: { w: 3.2, j: true, s: ['M5 12.5l4.5 4.5L19 7.5'] },
  cross: { w: 3.4, s: ['M6 6l12 12', 'M18 6L6 18'] },
  search: { w: 1.9, s: [[11, 11, 6.5], 'M20 20l-4-4'] },
  refresh: { w: 1.9, j: true, s: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'] },
  alert: { w: 1.9, j: true, s: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5v.01'] },
  pause: { w: 1.9, s: ['M9 5v14', 'M15 5v14'] },
  clock: { w: 1.9, j: true, s: [[12, 12, 9], 'M12 7v5l3 2'] },
  logo: { w: 2.2, s: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 11v2'] },
};

/** Every name icon() knows; "arrow" is the text arrow ↗. */
export const ICON_NAMES = [...Object.keys(ICON_DEFS), 'arrow'] as const;

/**
 * Client icon(name, size): an aria-hidden <svg> built with svgEl() (createElementNS + setAttribute), or null for an
 * unknown name. Appended to BASE_JS after el() and svgEl().
 */
export const ICONS_JS = `
  // Line icons (navigation, roles, symbols, logo).
  const ICON_DEFS = ${JSON.stringify(ICON_DEFS)};
  function icon(name, size) {
    if (name === 'arrow') {
      const a = el('span', '↗', 'ui-ico-text');
      a.setAttribute('aria-hidden', 'true');
      return a;
    }
    const def = Object.prototype.hasOwnProperty.call(ICON_DEFS, name) ? ICON_DEFS[name] : null;
    if (!def) return null;
    const px = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 16;
    const attrs = { width: px, height: px, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': def.w, 'stroke-linecap': 'round' };
    if (def.j) attrs['stroke-linejoin'] = 'round';
    attrs['aria-hidden'] = 'true';
    attrs.focusable = 'false';
    const svg = svgEl('svg', attrs);
    for (const s of def.s) svg.append(typeof s === 'string' ? svgEl('path', { d: s }) : svgEl('circle', { cx: s[0], cy: s[1], r: s[2] }));
    return svg;
  }
`;

/** Server-side counterpart of icon(): the same icon as an aria-hidden <svg> string, or '' for an unknown name. */
export function iconSvg(name: string, size = 16): string {
  const def = Object.prototype.hasOwnProperty.call(ICON_DEFS, name) ? ICON_DEFS[name] : undefined;
  if (!def) return '';
  const shapes = def.s.map((s) => (typeof s === 'string' ? `<path d="${s}"/>` : `<circle cx="${s[0]}" cy="${s[1]}" r="${s[2]}"/>`)).join('');
  const join = def.j ? ' stroke-linejoin="round"' : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${def.w}" stroke-linecap="round"${join} aria-hidden="true" focusable="false">${shapes}</svg>`;
}

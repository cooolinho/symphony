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

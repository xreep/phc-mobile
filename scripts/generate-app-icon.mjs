/**
 * Generates the app icon set: a white ECG pulse line centered on the brand blue.
 *
 * Run with `node scripts/generate-app-icon.mjs`. Rasterizing here (rather than
 * checking in hand-drawn PNGs) keeps every layer — iOS, Android adaptive,
 * favicon — derived from the single `PULSE` geometry below, so the glyph cannot
 * drift between platforms.
 *
 * Coverage is computed analytically from the distance to the polyline, which
 * anti-aliases the stroke and gives round caps and joins for free: the minimum
 * over per-segment distances with a clamped projection *is* a round join.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { PNG } from 'pngjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ICON_ASSETS = path.join(ROOT, 'assets', 'expo.icon', 'Assets');

/** Brand blue — matches `expo-splash-screen`'s backgroundColor in app.json. */
const BLUE = [0x20, 0x8a, 0xef];
const WHITE = [0xff, 0xff, 0xff];

/**
 * Splash logo colour. The OS composites this onto the `expo-splash-screen`
 * plugin's `backgroundColor` in app.json, so the two must contrast: keep this
 * WHITE for the blue splash background, or switch it to BLUE if that background
 * is ever changed to white.
 */
const SPLASH_GLYPH = WHITE;

/**
 * The pulse, in a 100x100 design box with the baseline at y=50. The QRS complex
 * spans x=30..70 so the drawn bounding box (x 0..100, y 20..80) is centered on
 * (50, 50) — mapping that point to the canvas center centers the glyph.
 */
const PULSE = [
  [0, 50],
  [30, 50],
  [38, 61],
  [48, 20],
  [60, 80],
  [70, 50],
  [100, 50],
];

/**
 * Android composites the 108dp adaptive canvas down to a 72dp visible circle,
 * so a glyph must be drawn at 2/3 of its intended on-screen size to match the
 * iOS icon, which is masked without being scaled.
 */
const ADAPTIVE_SCALE = 72 / 108;

/** Fraction of the icon's width the glyph spans, and its stroke weight. */
const GLYPH_FRAC = 0.62;
const STROKE_FRAC = 0.062;

/** Stroke weight expressed in the 100-unit design box. */
const STROKE_DESIGN = 100 * (STROKE_FRAC / GLYPH_FRAC);

function distanceToPolyline(px, py, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
    const distance = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    if (distance < best) best = distance;
  }
  return best;
}

/** Signed distance to a rounded rectangle; negative inside. */
function distanceToRoundedRect(px, py, size, radius) {
  const qx = Math.abs(px - size / 2) - (size / 2 - radius);
  const qy = Math.abs(py - size / 2) - (size / 2 - radius);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  );
}

/** Converts a signed distance to a 0..1 coverage value, anti-aliased over 1px. */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

function scaledPulse(size, glyphFrac) {
  const scale = (size * glyphFrac) / 100;
  const origin = size / 2 - 50 * scale;
  return PULSE.map(([x, y]) => [origin + x * scale, origin + y * scale]);
}

/**
 * @param {object} options
 * @param {number} options.size            Canvas edge length in px (square).
 * @param {boolean} options.background      Fill the canvas with the brand blue.
 * @param {number|null} options.cornerRadius Rounded-corner radius, or null for
 *   full bleed. Platform icons must be full bleed — the OS applies its own mask.
 * @param {boolean} options.glyph           Draw the pulse line.
 * @param {number} options.glyphFrac
 * @param {number} options.strokeFrac
 * @param {number[]} options.glyphColor
 */
function render({
  size,
  background,
  cornerRadius = null,
  glyph = true,
  glyphFrac = GLYPH_FRAC,
  strokeFrac = STROKE_FRAC,
  glyphColor = WHITE,
}) {
  const png = new PNG({ width: size, height: size });
  const points = scaledPulse(size, glyphFrac);
  const halfStroke = (size * strokeFrac) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      let backgroundAlpha = 0;
      if (background) {
        backgroundAlpha =
          cornerRadius === null ? 1 : coverage(distanceToRoundedRect(px, py, size, cornerRadius));
      }

      const glyphAlpha = glyph
        ? coverage(distanceToPolyline(px, py, points) - halfStroke)
        : 0;

      // White glyph over the blue background, then the result over transparent.
      const alpha = glyphAlpha + backgroundAlpha * (1 - glyphAlpha);
      const offset = (size * y + x) << 2;
      for (let c = 0; c < 3; c += 1) {
        png.data[offset + c] =
          alpha === 0
            ? 0
            : Math.round(
                (glyphColor[c] * glyphAlpha + BLUE[c] * backgroundAlpha * (1 - glyphAlpha)) / alpha,
              );
      }
      png.data[offset + 3] = Math.round(alpha * 255);
    }
  }
  return PNG.sync.write(png);
}

/**
 * The splash logo: the pulse alone on transparency, tight-cropped to its own
 * bounding box so `expo-splash-screen`'s `imageWidth` maps directly to the
 * glyph's drawn width. Non-square, unlike the platform icons, which are masked.
 *
 * The glyph colour must contrast with the plugin's `backgroundColor` in
 * app.json — they are composited by the OS, not here, so a white glyph on a
 * white splash background renders as nothing at all.
 */
function renderSplash({ width, glyphColor }) {
  const pad = STROKE_DESIGN / 2;
  const boxWidth = 100 + STROKE_DESIGN;
  const boxHeight = 60 + STROKE_DESIGN;
  const scale = width / boxWidth;
  const height = Math.round(boxHeight * scale);
  const png = new PNG({ width, height });
  // Design x 0..100 and y 20..80 shifted by the stroke's half-width, so the
  // stroke's outer edge lands exactly on the canvas edge.
  const points = PULSE.map(([x, y]) => [(x + pad) * scale, (y - 20 + pad) * scale]);
  const halfStroke = pad * scale;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = coverage(distanceToPolyline(x + 0.5, y + 0.5, points) - halfStroke);
      const offset = (width * y + x) << 2;
      for (let c = 0; c < 3; c += 1) {
        png.data[offset + c] = alpha === 0 ? 0 : glyphColor[c];
      }
      png.data[offset + 3] = Math.round(alpha * 255);
    }
  }
  return PNG.sync.write(png);
}

/**
 * The pulse as fill-only geometry: one rotated rectangle per segment plus a
 * circle per vertex, which reproduces a round-capped, round-joined stroke.
 * Overlaps are harmless because every piece is the same opaque white. Filled
 * paths import more predictably into Icon Composer than SVG strokes do.
 */
function pulseSvg() {
  const strokeWidth = STROKE_DESIGN;
  const r = strokeWidth / 2;
  const round = (n) => Number(n.toFixed(3));
  const parts = [];

  for (let i = 0; i < PULSE.length - 1; i += 1) {
    const [x1, y1] = PULSE[i];
    const [x2, y2] = PULSE[i + 1];
    const length = Math.hypot(x2 - x1, y2 - y1);
    const nx = ((y1 - y2) / length) * r;
    const ny = ((x2 - x1) / length) * r;
    const corners = [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ];
    parts.push(
      `  <path d="M${corners
        .map(([x, y]) => `${round(x)} ${round(y)}`)
        .join('L')}Z" />`,
    );
  }
  for (const [x, y] of PULSE) {
    parts.push(`  <circle cx="${round(x)}" cy="${round(y)}" r="${round(r)}" />`);
  }

  const minX = -r;
  const minY = 20 - r;
  const width = 100 + strokeWidth;
  const height = 60 + strokeWidth;
  return [
    `<svg width="${round(width)}" height="${round(height)}" viewBox="${round(minX)} ${round(
      minY,
    )} ${round(width)} ${round(height)}" xmlns="http://www.w3.org/2000/svg">`,
    '<g fill="#FFFFFF">',
    ...parts,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

/** Icon Composer expects channel values in 0..1 extended-sRGB. */
const iconComposerFill = () =>
  `extended-srgb:${BLUE.map((c) => (c / 255).toFixed(5)).join(',')},1.00000`;

const outputs = [
  // Full bleed and square: iOS rejects transparency and masks the corners itself.
  ['assets/images/icon.png', render({ size: 1024, background: true })],
  ['assets/images/android-icon-background.png', render({ size: 512, background: true, glyph: false })],
  [
    'assets/images/android-icon-foreground.png',
    render({
      size: 512,
      background: false,
      glyphFrac: GLYPH_FRAC * ADAPTIVE_SCALE,
      strokeFrac: STROKE_FRAC * ADAPTIVE_SCALE,
    }),
  ],
  // Android 13+ themed icons use only this layer's alpha; white keeps it
  // correct if a launcher ever composites it untinted.
  [
    'assets/images/android-icon-monochrome.png',
    render({
      size: 512,
      background: false,
      glyphFrac: GLYPH_FRAC * ADAPTIVE_SCALE,
      strokeFrac: STROKE_FRAC * ADAPTIVE_SCALE,
    }),
  ],
  // Browsers do not mask favicons, so the rounded square is drawn in.
  [
    'assets/images/favicon.png',
    render({ size: 48, background: true, cornerRadius: 48 * 0.22, strokeFrac: 0.075 }),
  ],
  // 3x the plugin's `imageWidth: 76` so the logo is crisp at xxhdpi.
  ['assets/images/splash-icon.png', renderSplash({ width: 228, glyphColor: SPLASH_GLYPH })],
];

for (const [relative, buffer] of outputs) {
  fs.writeFileSync(path.join(ROOT, relative), buffer);
  console.log(`wrote ${relative} (${buffer.length} bytes)`);
}

fs.writeFileSync(path.join(ICON_ASSETS, 'pulse.svg'), pulseSvg());
console.log('wrote assets/expo.icon/Assets/pulse.svg');
console.log(`icon.json fill should be ${iconComposerFill()}`);

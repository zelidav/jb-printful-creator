import sharp from 'sharp';

const WRAP_HINTS = /(left|right|outside|inside|front|back|sleeve|leg|side|quarter|tongue)/i;

// classify a list of placements (strings) into a wrap kind
export function classifyPlacements(placementNames) {
  const ids = placementNames.filter(Boolean);
  if (ids.some(p => /shoe_quarters/.test(p))) return { kind: 'canvas-shoe', panels: ids };

  const wrapPanels = ids.filter(p => WRAP_HINTS.test(p));
  if (wrapPanels.length <= 1) return { kind: 'single', panels: ids };

  const hasFB = ids.some(p => /front/i.test(p)) && ids.some(p => /back/i.test(p));
  if (hasFB) return { kind: 'aop-garment', panels: ids };
  return { kind: 'unknown-wrap', panels: ids };
}

// One panel: top half = pattern (outside-of-shoe), bottom half = horizontally-flipped (inside)
// so the heel edges meet seamlessly when wrapped around the foot.
async function buildQuarterPanel(patternBuf, { width, height, flipWhole }) {
  const halfH = Math.floor(height / 2);
  const top = await sharp(patternBuf).resize(width, halfH, { fit: 'cover' }).png().toBuffer();
  const bottom = await sharp(top).flop().toBuffer();
  let combined = await sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: bottom, top: halfH, left: 0 },
    ])
    .png()
    .toBuffer();
  if (flipWhole) combined = await sharp(combined).flop().png().toBuffer();
  return combined;
}

// Build all canvas-shoe print files from one user-supplied pattern.
// dims = { quarter: {width, height}, tongue: {width, height} }
export async function buildShoeFiles(patternBuf, dims) {
  const left  = await buildQuarterPanel(patternBuf, { ...dims.quarter, flipWhole: false });
  const right = await buildQuarterPanel(patternBuf, { ...dims.quarter, flipWhole: true });
  const tongue = dims.tongue
    ? await sharp(patternBuf).resize(dims.tongue.width, dims.tongue.height, { fit: 'cover' }).png().toBuffer()
    : null;
  return { quarters_left: left, quarters_right: right, tongue };
}

export async function fitToCanvas(patternBuf, { width, height, fit = 'cover' }) {
  return sharp(patternBuf).resize(width, height, { fit }).png().toBuffer();
}

// Extract dominant color from an image (used for canvas-shoe tongue solid color)
export async function getPrimaryColor(buf) {
  const stats = await sharp(buf).stats();
  const d = stats.dominant || { r: 0, g: 0, b: 0 };
  return { r: Math.round(d.r), g: Math.round(d.g), b: Math.round(d.b) };
}

// Build a solid-color canvas with a logo centered (for canvas-shoe tongues)
export async function solidWithLogo({ width, height, color, logoBuf, logoScale = 0.5 }) {
  const meta = await sharp(logoBuf).metadata();
  const targetW = Math.round(width * logoScale);
  const targetH = Math.round((meta.height / meta.width) * targetW);
  const resized = await sharp(logoBuf).resize(targetW, targetH, { fit: 'inside' }).png().toBuffer();
  return sharp({
    create: { width, height, channels: 4, background: { ...color, alpha: 1 } },
  })
    .composite([{ input: resized, gravity: 'center' }])
    .png()
    .toBuffer();
}

// Composite logo onto pattern at a given gravity + scale
export async function compositeLogo(patternBuf, logoBuf, { gravity = 'center', scale = 0.25 } = {}) {
  const meta = await sharp(patternBuf).metadata();
  const targetW = Math.round(meta.width * scale);
  const resized = await sharp(logoBuf).resize(targetW, null, { fit: 'inside' }).png().toBuffer();
  return sharp(patternBuf).composite([{ input: resized, gravity }]).png().toBuffer();
}

// Take a Printful printfiles response and return per-placement dimensions
export function dimsFromPrintfiles(pf) {
  const idx = {};
  for (const p of pf.printfiles || []) idx[p.printfile_id] = p;
  const dims = {};
  const variant = (pf.variant_printfiles || [])[0];
  if (!variant) return dims;
  for (const [placement, pid] of Object.entries(variant.placements || {})) {
    const p = idx[pid];
    if (p) dims[placement] = { width: p.width, height: p.height, dpi: p.dpi };
  }
  return dims;
}

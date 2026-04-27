import sharp from 'sharp';

const WRAP_HINTS = /(left|right|outside|inside|front|back|sleeve|leg|side|top|bottom|quarter|tongue)/i;

export function classifyPlacements(placements) {
  const ids = placements.map(p => p.placement || p.id || p);
  const wrapPanels = ids.filter(p => WRAP_HINTS.test(p));
  if (wrapPanels.length <= 1) return { kind: 'single', panels: ids };

  const hasLR = ids.some(p => /left/i.test(p)) && ids.some(p => /right/i.test(p));
  const hasIO = ids.some(p => /outside/i.test(p)) && ids.some(p => /inside/i.test(p));
  const hasFB = ids.some(p => /front/i.test(p)) && ids.some(p => /back/i.test(p));

  if (hasLR && hasIO) return { kind: 'canvas-shoe', panels: ids };
  if (hasFB) return { kind: 'aop-garment', panels: ids };
  return { kind: 'unknown-wrap', panels: ids };
}

export async function buildShoePanel(patternBuf, { width, height, mirror }) {
  const base = sharp(patternBuf).resize(width, Math.round(height / 2), { fit: 'cover' });
  const top = await base.toBuffer();
  const bottomSrc = mirror ? sharp(top).flop() : sharp(top);
  const bottom = await bottomSrc.toBuffer();
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
  })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: bottom, top: Math.round(height / 2), left: 0 },
    ])
    .png()
    .toBuffer();
}

export async function fitToCanvas(patternBuf, { width, height, fit = 'cover' }) {
  return sharp(patternBuf).resize(width, height, { fit }).png().toBuffer();
}

// AI design edits via Replicate google/nano-banana (Gemini 2.5 Flash Image). Takes the current
// design art as a reference image plus the user's free-form notes, and returns the regenerated art
// as a Buffer. Mirrors the call used in jb-nyc-treatment/tools (image_input + prompt).
//
// LOUD on failure: throws if the token is missing or the model errors. We never return the original
// art on failure — the user asked for a change, so silently printing the un-edited design would be
// exactly the kind of silent fallback we forbid (the caller marks the design failed instead).

const REPLICATE = 'https://api.replicate.com/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function regenerateArt(refUrl, notes, { token, aspect = '1:1', maxSec = 120 } = {}) {
  if (!token) throw new Error('REPLICATE_API_TOKEN not set — cannot apply AI design notes');
  if (!refUrl) throw new Error('no reference art to edit');
  const prompt =
    'Edit this apparel print artwork according to the instructions. Keep it a flat, seamless, ' +
    'repeatable surface-pattern print suitable for printing on fabric — no garment mockup, no people, ' +
    'no 3D scene, no borders, no watermark or signature. Instructions: ' + String(notes).trim();

  // Prefer: wait holds the connection until the prediction settles (nano-banana ~10-25s).
  const res = await fetch(`${REPLICATE}/models/google/nano-banana/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ input: { prompt, image_input: [refUrl], output_format: 'jpg', aspect_ratio: aspect } }),
  });
  let pred = await res.json().catch(() => ({}));
  if (res.status >= 300 && !pred?.urls?.get) {
    throw new Error(`nano-banana request failed (${res.status}): ${(pred?.detail || pred?.error || JSON.stringify(pred)).toString().slice(0, 200)}`);
  }

  // Fall back to polling if the prediction is still running (Prefer:wait timed out).
  const getUrl = pred?.urls?.get;
  const start = Date.now();
  while (getUrl && pred.status && !['succeeded', 'failed', 'canceled'].includes(pred.status)) {
    if (Date.now() - start > maxSec * 1000) throw new Error('nano-banana timed out');
    await sleep(2500);
    const r = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
    pred = await r.json();
  }
  if (pred.status === 'failed' || pred.status === 'canceled') {
    throw new Error(`nano-banana ${pred.status}: ${(pred.error || '').toString().slice(0, 200)}`);
  }

  let out = pred.output;
  if (Array.isArray(out)) out = out[0];
  if (!out || typeof out !== 'string') throw new Error(`nano-banana returned no image: ${JSON.stringify(pred).slice(0, 200)}`);

  const img = await fetch(out);
  if (!img.ok) throw new Error(`fetch nano-banana output failed (${img.status})`);
  return Buffer.from(await img.arrayBuffer());
}

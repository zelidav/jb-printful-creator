const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM || 'JBD Orders <orders@canismajorpartners.com>';

export async function sendEmail({ to, subject, html }) {
  if (!RESEND_KEY) {
    console.warn('[email] RESEND_API_KEY not set; skipping send to', to);
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`resend ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

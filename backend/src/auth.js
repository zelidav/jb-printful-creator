import crypto from 'crypto';
import { Users, Sessions, MagicLinks, logActivity } from './db.js';
import { sendEmail } from './email.js';

const APPROVER_EMAIL = process.env.APPROVER_EMAIL || 'david@canismajorpartners.com';
const TOKEN_SECRET = process.env.TOKEN_SECRET || process.env.APP_PASSWORD || 'fallback-secret';
const SESSION_DAYS = 30;
const MAGIC_HOURS = 24;

function tokenFor(payload) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
}
function verifyToken(payload, candidate) {
  const expected = tokenFor(payload);
  return candidate.length === expected.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
function randId(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
function lower(e) { return (e || '').trim().toLowerCase(); }

async function getSessionUser(req) {
  const token = req.cookies?.jb_sess || req.header('x-jb-sess');
  if (!token) return null;
  const doc = await Sessions.doc(token).get();
  if (!doc.exists) return null;
  const sess = doc.data();
  if (sess.expires_at < Date.now()) { await Sessions.doc(token).delete().catch(() => {}); return null; }
  const u = await Users.doc(sess.email).get();
  if (!u.exists) return null;
  const user = u.data();
  if (user.status !== 'approved') return null;
  return { ...user, _token: token };
}

export function requireSession(req, res, next) {
  getSessionUser(req).then(u => {
    if (!u) return res.status(401).json({ error: 'session required' });
    req.user = u;
    next();
  }).catch(e => res.status(500).json({ error: String(e) }));
}

export function attachAuthRoutes(app) {
  // 1. Employee submits email → create pending user, email approver
  app.post('/api/auth/request-access', async (req, res) => {
    try {
      const email = lower(req.body?.email);
      const name = (req.body?.name || '').trim();
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });

      const ref = Users.doc(email);
      const existing = await ref.get();
      const now = Date.now();

      if (existing.exists) {
        const u = existing.data();
        if (u.status === 'approved') {
          // Already approved — issue a fresh magic link directly
          await issueMagicLink(req, email, name || u.name);
          await logActivity('magic_link_resent', { email });
          return res.json({ status: 'already_approved', message: 'A new sign-in link has been emailed to you.' });
        }
        if (u.status === 'blocked') {
          return res.status(403).json({ error: 'access denied' });
        }
        // pending — re-notify approver
        await emailApprover(req, email, name || u.name, true);
        await logActivity('access_re_requested', { email });
        return res.json({ status: 'pending', message: 'Approval request resent to admin.' });
      }

      await ref.set({ email, name, status: 'pending', created_at: now });
      await emailApprover(req, email, name, false);
      await logActivity('access_requested', { email, name });
      res.json({ status: 'pending', message: 'Access request sent. You\'ll get an email when approved.' });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // 2. Admin clicks Approve link in email
  app.get('/api/auth/admin/approve-user/:email/:token', async (req, res) => {
    const email = lower(req.params.email);
    if (!verifyToken(`approve-user:${email}`, req.params.token)) return res.status(403).send('Invalid link.');
    await Users.doc(email).set({ status: 'approved', approved_at: Date.now(), approved_by: APPROVER_EMAIL }, { merge: true });
    await logActivity('user_approved', { email });
    // Email the user a magic link
    await issueMagicLink(req, email);
    res.send(htmlPage('User approved ✓', `<p>${email} approved. They've been emailed a sign-in link.</p>`));
  });

  app.get('/api/auth/admin/deny-user/:email/:token', async (req, res) => {
    const email = lower(req.params.email);
    if (!verifyToken(`deny-user:${email}`, req.params.token)) return res.status(403).send('Invalid link.');
    await Users.doc(email).set({ status: 'blocked', blocked_at: Date.now() }, { merge: true });
    await logActivity('user_denied', { email });
    res.send(htmlPage('User blocked ✓', `<p>${email} blocked.</p>`));
  });

  // 3. User clicks magic link → set session cookie, redirect to shop
  app.get('/api/auth/magic/:id/:token', async (req, res) => {
    const { id, token } = req.params;
    const doc = await MagicLinks.doc(id).get();
    if (!doc.exists) return res.status(403).send(htmlPage('Link expired', '<p>This sign-in link has expired or was already used. Request a new one.</p>'));
    const ml = doc.data();
    if (ml.used || ml.expires_at < Date.now()) return res.status(403).send(htmlPage('Link expired', '<p>This sign-in link has expired or was already used. Request a new one.</p>'));
    if (!verifyToken(`magic:${id}:${ml.email}`, token)) return res.status(403).send(htmlPage('Invalid link', '<p>Bad token.</p>'));

    const u = await Users.doc(ml.email).get();
    if (!u.exists || u.data().status !== 'approved') return res.status(403).send(htmlPage('Access denied', '<p>Your account is not active.</p>'));

    // Create session
    const sessId = randId(32);
    const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    await Sessions.doc(sessId).set({ email: ml.email, created_at: Date.now(), expires_at: expires });
    await MagicLinks.doc(id).set({ used: true, used_at: Date.now() }, { merge: true });
    await Users.doc(ml.email).set({ last_login: Date.now() }, { merge: true });
    await logActivity('user_login', { email: ml.email });

    // Set cookie + redirect to shop
    const origin = process.env.ALLOWED_ORIGIN || 'https://zelidav.github.io/jb-printful-creator';
    const shopUrl = origin.endsWith('/jb-printful-creator') ? origin + '/shop.html' : origin + '/jb-printful-creator/shop.html';
    res.cookie('jb_sess', sessId, {
      httpOnly: true, secure: true, sameSite: 'none',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    });
    res.redirect(`${shopUrl}?token=${encodeURIComponent(sessId)}`);
  });

  app.get('/api/auth/me', async (req, res) => {
    const u = await getSessionUser(req).catch(() => null);
    if (!u) return res.json({ signed_in: false });
    res.json({ signed_in: true, email: u.email, name: u.name });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies?.jb_sess || req.header('x-jb-sess');
    if (token) await Sessions.doc(token).delete().catch(() => {});
    res.clearCookie('jb_sess');
    res.json({ ok: true });
  });
}

async function emailApprover(req, email, name, isResend) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const approveUrl = `${baseUrl}/api/auth/admin/approve-user/${encodeURIComponent(email)}/${tokenFor(`approve-user:${email}`)}`;
  const denyUrl = `${baseUrl}/api/auth/admin/deny-user/${encodeURIComponent(email)}/${tokenFor(`deny-user:${email}`)}`;
  const html = `
    <h2>JBD Gear — access request${isResend ? ' (resent)' : ''}</h2>
    <p><strong>Email:</strong> ${email}</p>
    ${name ? `<p><strong>Name:</strong> ${name}</p>` : ''}
    <p style="margin-top:24px;">
      <a href="${approveUrl}" style="background:#22c55e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Approve</a>
      &nbsp;&nbsp;
      <a href="${denyUrl}" style="background:#ef4444;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Deny / Block</a>
    </p>
    <p style="color:#888;font-size:12px;">Approving will email them a sign-in link automatically.</p>
  `;
  await sendEmail({ to: APPROVER_EMAIL, subject: `JBD Gear — access request: ${email}`, html });
}

async function issueMagicLink(req, email, name) {
  const id = randId(16);
  const tok = tokenFor(`magic:${id}:${email}`);
  const expires = Date.now() + MAGIC_HOURS * 60 * 60 * 1000;
  await MagicLinks.doc(id).set({ email, created_at: Date.now(), expires_at: expires, used: false });
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const link = `${baseUrl}/api/auth/magic/${id}/${tok}`;
  const html = `
    <h2>Welcome to JBD Gear</h2>
    <p>${name ? `Hey ${name},` : 'Hey,'} you're approved. Click the link below to sign in. Link is good for 24 hours.</p>
    <p style="margin:24px 0;">
      <a href="${link}" style="background:#4dffc1;color:#001b14;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Sign in to JBD Gear</a>
    </p>
    <p style="color:#888;font-size:12px;">Or paste this URL: ${link}</p>
  `;
  await sendEmail({ to: email, subject: 'Sign in to JBD Gear', html });
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head>
    <body style="font:14px sans-serif;background:#0e0f12;color:#eee;padding:40px;max-width:560px;margin:auto;">
      <h2 style="color:#4dffc1;">${title}</h2>${body}
    </body></html>`;
}

export { getSessionUser };

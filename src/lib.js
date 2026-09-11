// Shared helpers: DB, auth, uploads, CSV, ZIP, constants.
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const mysql = require('mysql2/promise');
const multer = require('multer');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: +process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rpto_portal',
  dateStrings: true,
  connectionLimit: 10,
});
const q = async (sql, params) => (await pool.query(sql, params))[0];
const one = async (sql, params) => (await q(sql, params))[0];
// Atomic per-row counter (roll / certificate / receipt numbers). LAST_INSERT_ID is per connection, so both
// statements run on the same one. `table` and `col` are code constants, never user input.
const SEQ_COLUMNS = { batches: ['roll_seq'], rptos: ['cert_seq', 'receipt_seq'] };
async function nextSeq(table, id, col) {
  if (!SEQ_COLUMNS[table]?.includes(col)) throw new Error('bad sequence');
  const conn = await pool.getConnection();
  try {
    await conn.query(`UPDATE ${table} SET ${col}=LAST_INSERT_ID(${col}+1) WHERE id=?`, [id]);
    const [[r]] = await conn.query('SELECT LAST_INSERT_ID() n');
    return r.n;
  } finally { conn.release(); }
}

// ---- passwords & signed session cookie (stdlib only) ----
const SECRET = process.env.SESSION_SECRET || 'dev-only-secret';
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set — using an insecure dev secret');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(String(pw), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const mac = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const SESSION_DAYS = 7;
// Token = userId.sessionVersion.issuedAt.hmac — bumping users.session_ver signs the user out everywhere.
// `purpose` separates token kinds (a half-finished 2FA login token must never work as a session cookie).
function makeToken(userId, ver = 0, purpose = '') { const v = `${userId}.${ver}.${Date.now()}`; return `${v}.${mac(purpose + v)}`; }
function readToken(token, purpose = '', maxMs = SESSION_DAYS * 864e5) {
  const i = String(token || '').lastIndexOf('.');
  if (i < 0) return null;
  const v = token.slice(0, i), sig = Buffer.from(token.slice(i + 1)), good = Buffer.from(mac(purpose + v));
  if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
  const [id, ver, ts] = v.split('.').map(Number);
  return Date.now() - ts < maxMs ? { id, ver } : null;
}
const setSession = (req, res, u) => res.cookie('sid', makeToken(u.id, u.session_ver || 0), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5 });
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ---- TOTP two-factor (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(s) {
  let bits = '';
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)?.map(b => parseInt(b, 2)) || []);
}
function totp(secret, step) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(ctr).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Returns the matching time step (±1 step for clock drift) so callers can refuse re-use of a code, else null.
function checkTotp(secret, code, now = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code))) return null;
  const s = Math.floor(now / 30000);
  return [s, s - 1, s + 1].find(x => totp(secret, x) === String(code)) ?? null;
}
const newTotpSecret = () => base32(crypto.randomBytes(20));

// ---- email (optional: only when SMTP_HOST is set) ----
let mailer;
const mailEnabled = () => !!process.env.SMTP_HOST;
async function sendMail(to, subject, text) {
  if (!mailEnabled() || !to) return false;
  mailer ||= require('nodemailer').createTransport({
    host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: +process.env.SMTP_PORT === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  try { await mailer.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text }); return true; }
  catch (e) { console.error('Email failed:', e.message); return false; }
}
// Public links must not trust the Host header (reset-link poisoning), so APP_URL wins when set.
const baseUrl = req => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
async function resetLink(req, userId, hours = 24) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?, NOW() + INTERVAL ? HOUR)', [sha256(token), userId, hours]);
  return `${baseUrl(req)}/reset/${token}`;
}
// New account created by an admin: email a set-password link when email works, otherwise show the password once.
async function credentialsMessage(req, u, password, label) {
  const app = process.env.APP_NAME || 'AERON';
  if (mailEnabled()) {
    const link = await resetLink(req, u.id, 24 * 7);
    if (await sendMail(u.email, `Your ${app} account`, `Hi ${u.name || ''},\n\nAn account has been created for you on ${app} (${label}).\nSet your password here (link valid for 7 days):\n${link}\n\nAfterwards log in at ${baseUrl(req)}/login`))
      return `${label} added. An invitation to set a password was emailed to ${u.email}.`;
  }
  return `${label} added. Login: ${u.email} / ${password} — share it securely.`;
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(s => s.trim().split('=')).filter(p => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
const randomPassword = () => crypto.randomBytes(6).toString('base64url') + '@9';

// ---- uploads (stored privately, served only through /files/:name with access checks) ----
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
});
const upload = multer({
  storage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(pdf|jpe?g|png|webp)$/i.test(file.originalname)),
});
const logUpload = multer({
  storage, limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(bin|log|ulg|csv|txt)$/i.test(file.originalname)),
});

// ---- CSV ----
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')); // BOM so Excel reads UTF-8
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

// ---- minimal ZIP writer (stored, no compression) for trainee record packages ----
function zip(files) {
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), data = f.data, crc = zlib.crc32(data), size = data.length;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22);
    h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(h, name, data); central.push(c, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---- constants ----
const TRAINEE_DOCS = {
  aadhaar: 'Aadhaar card', id_proof: 'ID proof (PAN / Passport)', marksheet_10: '10th class marksheet',
  medical: 'Medical certificate', photo: 'Passport photo', signature: 'Signature',
};
const TRAINEE_DOC_HELP = {
  aadhaar: 'Front and back in one PDF, or a clear photo of each side merged. Mask the first 8 digits if you prefer.',
  id_proof: 'PAN card or the photo page of your passport. The name must match your other documents.',
  marksheet_10: 'Your class 10 (or higher) marksheet — proof of the minimum education requirement.',
  medical: 'A medical fitness certificate signed by a registered doctor, issued in the last few months.',
  photo: 'A recent colour photo, plain light background, face clearly visible. JPG or PNG.',
  signature: 'Sign in dark ink on white paper, then photograph or scan and crop tightly.',
};
// Standard documents first, then extra ones the trainee added (doc_type other_<n>, each with its own label).
const docRows = docs => [...Object.entries(TRAINEE_DOCS).map(([k, label]) => [k, label, docs[k]]),
  ...Object.values(docs).filter(d => d.doc_type.startsWith('other_')).map(d => [d.doc_type, d.label || 'Other document', d])];
const RPTO_DOCS = {
  authorisation: 'DGCA RPTO Certificate of Authorisation', incorporation: 'Certificate of incorporation / registration',
  am_id: 'Accountable Manager ID proof', gst: 'GST certificate', pan: 'Company PAN card', address_proof: 'Premises address proof',
};
const RPTO_DOCS_REQUIRED = ['authorisation', 'incorporation', 'am_id'];
const MEMBER_ROLES = ['Instructor', 'Admin', 'Accountable Manager', 'Business Development'];
const ASSET_TYPES = { rpas: 'RPAS', battery: 'Batteries', charger: 'Chargers', simulator: 'Simulators', classroom: 'Classrooms', field: 'Flying fields' };
const LEAD_SOURCES = ['WhatsApp', 'Instagram', 'Referral', 'Walk-in', 'Website', 'Phone', 'Manual'];

// Razorpay checkout signature = HMAC_SHA256(order_id|payment_id, key_secret) — never trust the browser without this.
function verifyRazorpay(orderId, paymentId, signature, secret = process.env.RAZORPAY_KEY_SECRET) {
  if (!secret || typeof signature !== 'string') return false;
  const good = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return signature.length === good.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(good));
}
const razorpayKeyId = () => process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? process.env.RAZORPAY_KEY_ID : null;
// Creates a Razorpay order (amount in paise). Returns the order or null on failure.
async function razorpayOrder(amountPaise, receipt, notes) {
  if (!razorpayKeyId()) return null;
  const resp = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64') },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: String(receipt).slice(0, 40), notes }),
  }).catch(() => null);
  const order = resp && await resp.json().catch(() => null);
  if (!resp?.ok || !order?.id) { console.error('Razorpay order failed', order); return null; }
  return order;
}
// Checkout callback -> marks the payment paid exactly once.
// Returns { p } ONLY to the call that settled it (so callers grant the goods once); { already } = settled earlier; { error } = rejected.
async function settlePayment(userId, { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig }) {
  const p = oid && await one('SELECT * FROM payments WHERE order_id=? AND user_id=?', [oid, userId]);
  if (!p) return { error: 'Payment not found.' };
  if (p.status === 'paid') return { already: true };
  if (!verifyRazorpay(oid, pid, sig)) {
    await q("UPDATE payments SET status='failed' WHERE id=? AND status='created'", [p.id]);
    return { error: `Payment could not be verified. If money was deducted, contact support with order ID ${oid}.` };
  }
  const x = await q("UPDATE payments SET status='paid', payment_id=?, paid_at=NOW() WHERE id=? AND status<>'paid'", [pid, p.id]);
  return x.affectedRows ? { p: { ...p, payment_id: pid, status: 'paid' } } : { already: true };
}

// Route guard: need(u => u.isAdmin)
const need = test => (req, res, next) => {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (test(req.user)) return next();
  res.status(403).render('message', { title: 'No access', text: 'Your role does not have access to this page.' });
};
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const log = (rptoId, text) => q('INSERT INTO activity (rpto_id, text) VALUES (?,?)', [rptoId, text.slice(0, 255)]);
const daysAgo = n => new Date(Date.now() - n * 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const today = () => daysAgo(0);

module.exports = {
  pool, q, one, nextSeq, hashPassword, checkPassword, makeToken, readToken, setSession, parseCookies, randomPassword, SESSION_DAYS, sha256,
  totp, checkTotp, newTotpSecret, base32,
  mailEnabled, sendMail, baseUrl, resetLink, credentialsMessage, verifyRazorpay, razorpayKeyId, razorpayOrder, settlePayment,
  need, csvUpload, upload, logUpload, UPLOAD_DIR, sendCsv, parseCsv, zip, log, today, daysAgo,
  TRAINEE_DOCS, TRAINEE_DOC_HELP, docRows, RPTO_DOCS, RPTO_DOCS_REQUIRED, MEMBER_ROLES, ASSET_TYPES, LEAD_SOURCES,
};

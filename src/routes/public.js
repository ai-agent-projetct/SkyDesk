const r = require('express').Router();
const L = require('../lib');

const home = u => u.role === 'super_admin' ? '/super' : u.role === 'member' ? '/rpto' : '/student';
const login = (req, res, u) => L.setSession(req, res, u);
const safeNext = n => typeof n === 'string' && /^\/[a-z]/i.test(n) && !n.startsWith('//') ? n : null;

r.get('/', async (req, res) => {
  const stats = await L.one(`SELECT (SELECT COUNT(*) FROM rptos WHERE status='approved') rptos,
    (SELECT COUNT(*) FROM applications WHERE cert_no IS NOT NULL) certs,
    (SELECT COUNT(*) FROM users WHERE role='student') students`);
  const price = { month: +process.env.PRO_PRICE_MONTH || 349, year: +process.env.PRO_PRICE_YEAR || 3490, free: +process.env.FREE_FLIGHT_LIMIT || 25,
    credit: require('../training').CREDIT_PRICE };
  res.render('public/home', { stats, price });
});

r.get('/login', (req, res) => req.user ? res.redirect(home(req.user)) : res.render('public/login', { error: null, email: '' }));

// ponytail: in-memory login throttle (per process); move to a shared store if you run several instances.
const attempts = new Map();
r.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), key = req.ip + '|' + email;
  let a = attempts.get(key);
  if (!a || Date.now() - a.t > 15 * 60e3) a = { n: 0, t: Date.now() };
  if (a.n >= 5) return res.status(429).render('public/login', { error: 'Too many attempts. Try again in 15 minutes.', email });
  const u = await L.one('SELECT * FROM users WHERE email=?', [email]);
  if (!u || !L.checkPassword(req.body.password || '', u.password_hash)) {
    attempts.set(key, { n: a.n + 1, t: a.t });
    return res.status(401).render('public/login', { error: 'Invalid email or password.', email });
  }
  if (!u.active) return res.status(403).render('public/login', { error: 'This account is deactivated. Contact your administrator.', email });
  attempts.delete(key);
  const next = safeNext(req.query.next);
  if (u.totp_enabled) { // password was right; the session starts only after the second step
    res.cookie('mfa', L.makeToken(u.id, u.session_ver || 0, 'mfa:'), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MFA_MS });
    return res.redirect('/login/2fa' + (next ? '?next=' + encodeURIComponent(next) : ''));
  }
  login(req, res, u);
  res.redirect(next || home(u));
});
const MFA_MS = 10 * 60e3;
const mfaUser = req => L.readToken(L.parseCookies(req.headers.cookie).mfa, 'mfa:', MFA_MS);
const recoveryHash = c => L.sha256(String(c).toUpperCase().replace(/[^A-Z0-9]/g, ''));
const recoveryList = u => (typeof u.recovery_codes === 'string' ? JSON.parse(u.recovery_codes) : u.recovery_codes) || [];
r.get('/login/2fa', (req, res) => mfaUser(req) ? res.render('public/login-2fa', { error: null }) : res.redirect('/login'));
r.post('/login/2fa', async (req, res) => {
  const tok = mfaUser(req), key = 'mfa|' + tok?.id;
  const u = tok && await L.one('SELECT * FROM users WHERE id=?', [tok.id]);
  if (!u || !u.active || !u.totp_enabled || u.session_ver !== tok.ver) return res.redirect('/login');
  let a = attempts.get(key);
  if (!a || Date.now() - a.t > 15 * 60e3) a = { n: 0, t: Date.now() };
  if (a.n >= 5) return res.status(429).render('public/login-2fa', { error: 'Too many attempts. Try again in 15 minutes.' });
  const code = String(req.body.code || '').replace(/\s/g, ''), step = L.checkTotp(u.totp_secret, code);
  let ok = false, left = null;
  if (step !== null) // a code can be used once: totp_last only moves forward
    ok = (await L.q('UPDATE users SET totp_last=? WHERE id=? AND (totp_last IS NULL OR totp_last < ?)', [step, u.id, step])).affectedRows === 1;
  else if (code.length >= 10) {
    const h = recoveryHash(code), codes = recoveryList(u);
    if (codes.includes(h)) {
      left = codes.filter(c => c !== h);
      ok = (await L.q('UPDATE users SET recovery_codes=? WHERE id=? AND JSON_CONTAINS(recovery_codes, ?)', [JSON.stringify(left), u.id, JSON.stringify(h)])).affectedRows === 1;
    }
  }
  if (!ok) { attempts.set(key, { n: a.n + 1, t: a.t }); return res.status(401).render('public/login-2fa', { error: 'That code is not valid (codes can be used only once).' }); }
  attempts.delete(key);
  res.clearCookie('mfa');
  login(req, res, u);
  if (left) res.flash(`You signed in with a recovery code — ${left.length} left. Generate new ones under My account if you are running low.`);
  res.redirect(safeNext(req.query.next) || home(u));
});
r.post('/logout', (req, res) => { res.clearCookie('sid'); res.redirect('/login'); });

// ---- RPTO self-registration (goes to super admin for approval) ----
const rptoDocFields = Object.keys(L.RPTO_DOCS).map(name => ({ name, maxCount: 1 }));
r.get('/register-rpto', (req, res) => res.render('public/register-rpto', { error: null, b: {} }));
r.post('/register-rpto', L.upload.fields(rptoDocFields), async (req, res) => {
  const b = req.body, files = req.files || {};
  const bad = msg => res.status(400).render('public/register-rpto', { error: msg, b });
  if (!b.name || !b.city || !b.am_name || !b.email || !b.password) return bad('Please fill all required fields.');
  if (String(b.password).length < 8) return bad('Password must be at least 8 characters.');
  const missing = L.RPTO_DOCS_REQUIRED.filter(k => !files[k]);
  if (missing.length) return bad('Please upload: ' + missing.map(k => L.RPTO_DOCS[k]).join(', '));
  const email = b.email.trim().toLowerCase();
  if (await L.one('SELECT id FROM users WHERE email=?', [email])) return bad('An account with this email already exists — log in instead.');
  const conn = await L.pool.getConnection();
  let userId;
  try {
    await conn.beginTransaction();
    const [x] = await conn.query(`INSERT INTO rptos (name,city,address,auth_no,file_no,accountable_manager,contact_email,contact_phone)
      VALUES (?,?,?,?,?,?,?,?)`, [b.name, b.city, b.address, b.auth_no, b.file_no, b.am_name, email, b.phone]);
    const [y] = await conn.query("INSERT INTO users (rpto_id,name,email,phone,password_hash,role) VALUES (?,?,?,?,?,'member')",
      [x.insertId, b.am_name, email, b.phone, L.hashPassword(b.password)]);
    userId = y.insertId;
    await conn.query("INSERT INTO members (rpto_id,user_id,role) VALUES (?,?,'Accountable Manager')", [x.insertId, userId]);
    for (const [k, [f]] of Object.entries(files))
      await conn.query('INSERT INTO rpto_documents (rpto_id,doc_type,file,original_name) VALUES (?,?,?,?)', [x.insertId, k, f.filename, f.originalname]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') return bad('An account with this email already exists.');
    throw e;
  } finally { conn.release(); }
  await L.log(null, `New RPTO registration: ${b.name} (${b.city})`);
  login(req, res, { id: userId });
  res.redirect('/rpto');
});

// ---- Student self-registration ----
r.get('/register', (req, res) => res.render('public/register', { error: null, b: {} }));
r.post('/register', async (req, res) => {
  const b = req.body, email = String(b.email || '').trim().toLowerCase();
  const bad = msg => res.status(400).render('public/register', { error: msg, b });
  if (!b.name || !email || !b.password) return bad('Please fill all required fields.');
  if (String(b.password).length < 8) return bad('Password must be at least 8 characters.');
  if (await L.one('SELECT id FROM users WHERE email=?', [email])) return bad('An account with this email already exists — log in instead.');
  const x = await L.q("INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'student')", [b.name, email, b.phone, L.hashPassword(b.password)]);
  login(req, res, { id: x.insertId });
  res.redirect('/student/apply');
});

// ---- Public directory of approved RPTOs and open batches ----
r.get('/rptos', async (req, res) => {
  const rptos = await L.q(`SELECT r.id, r.name, r.city, r.tagline, r.logo,
    (SELECT COUNT(*) FROM batches b WHERE b.rpto_id=r.id AND b.accepting=1 AND b.status IN ('planned','active')) open_batches
    FROM rptos r WHERE r.status='approved' ORDER BY r.name`);
  res.render('public/rptos', { rptos });
});

// ---- Public enquiry form an RPTO shares (feeds its CRM) ----
const approvedRpto = id => L.one("SELECT id,name,city,tagline FROM rptos WHERE id=? AND status='approved'", [id]);
r.get('/enquire/:id', async (req, res) => {
  const rpto = await approvedRpto(req.params.id);
  if (!rpto) return res.status(404).render('message', { title: 'Not found', text: 'This enquiry form is not available.' });
  res.render('public/enquire', { rpto, done: false });
});
r.post('/enquire/:id', async (req, res) => {
  const rpto = await approvedRpto(req.params.id), b = req.body;
  if (!rpto) return res.status(404).render('message', { title: 'Not found', text: 'This enquiry form is not available.' });
  if (!b.name || !(b.phone || b.email)) return res.status(400).render('message', { title: 'Missing details', text: 'Please give your name and a phone number or email.' });
  await L.q("INSERT INTO leads (rpto_id,name,phone,email,city,source,interest,notes) VALUES (?,?,?,?,?,'Website',?,?)",
    [rpto.id, String(b.name).slice(0, 150), b.phone, b.email, b.city, b.interest, b.notes]);
  await L.log(rpto.id, `New web enquiry from ${b.name}`);
  res.render('public/enquire', { rpto, done: true });
});

// ---- Account (profile + password) for every signed-in user ----
const AVATARS = ['🧑‍✈️', '👨‍✈️', '👩‍✈️', '🚁', '🛩️', '✈️', '🛸', '🦅', '🛰️', '🤖', '🧑', '😎'];
r.get('/account', L.need(() => true), async (req, res) => {
  const memberships = await L.q(`SELECT r.id, r.name, r.city, r.status, GROUP_CONCAT(m.role ORDER BY m.role SEPARATOR ', ') roles
    FROM members m JOIN rptos r ON r.id=m.rpto_id WHERE m.user_id=? GROUP BY r.id`, [req.user.id]);
  const training = await L.q(`SELECT a.id, a.status, a.cert_no, a.cert_issued_at, a.rpc_no, a.rpc_issued_at, r.name rpto, b.title batch
    FROM applications a JOIN rptos r ON r.id=a.rpto_id LEFT JOIN batches b ON b.id=a.batch_id WHERE a.user_id=? ORDER BY a.applied_at DESC`, [req.user.id]);
  res.render('public/account', { memberships, training, AVATARS });
});
r.post('/account', L.need(() => true), async (req, res) => {
  const b = req.body;
  await L.q(`UPDATE users SET name=?, phone=?, dob=?, gender=?, father_name=?, address=?, is_pilot=?, license_no=?, license_expiry=?, regulator=? WHERE id=?`,
    [b.name || req.user.name, b.phone, b.dob || null, b.gender || null, b.father_name || null, b.address || null,
      b.is_pilot ? 1 : 0, b.is_pilot ? b.license_no || null : null, b.is_pilot ? b.license_expiry || null : null,
      ['DGCA', 'FAA', 'CAA', 'EASA', 'Other'].includes(b.regulator) ? b.regulator : 'DGCA', req.user.id]);
  res.flash('Profile saved.');
  res.redirect('/account');
});
r.post('/account/avatar', L.need(() => true), L.upload.single('photo'), async (req, res) => {
  const old = req.user.avatar;
  if (req.file && /\.(jpe?g|png|webp)$/i.test(req.file.filename)) await L.q('UPDATE users SET avatar=? WHERE id=?', [req.file.filename, req.user.id]);
  else if (AVATARS.includes(req.body.emoji)) await L.q('UPDATE users SET avatar=? WHERE id=?', [req.body.emoji, req.user.id]);
  else { if (req.file) require('fs').unlink(req.file.path, () => {}); return res.redirect('/account'); }
  if (old && old.includes('.')) require('fs').unlink(require('path').join(L.UPLOAD_DIR, require('path').basename(old)), () => {});
  res.redirect('/account');
});
// Instructor signature (image) — printed on certificates they sign as RPA trainer. Empty upload + remove=1 clears it.
r.post('/account/signature', L.need(u => u.role === 'member'), L.upload.single('signature'), async (req, res) => {
  const ok = req.file && /\.(jpe?g|png|webp)$/i.test(req.file.filename);
  if (req.file && !ok) require('fs').unlink(req.file.path, () => {});
  if (ok || req.body.remove) {
    const { signature } = await L.one('SELECT signature FROM users WHERE id=?', [req.user.id]);
    await L.q('UPDATE users SET signature=? WHERE id=?', [ok ? req.file.filename : null, req.user.id]);
    if (signature) require('fs').unlink(require('path').join(L.UPLOAD_DIR, require('path').basename(signature)), () => {});
    res.flash(ok ? 'Signature saved.' : 'Signature removed.');
  } else res.flash('Upload a PNG, JPG or WebP image.');
  res.redirect('/account');
});
// Changing the password signs out every other device (session version bump) and keeps this one signed in.
async function newSession(req, res) {
  await L.q('UPDATE users SET session_ver=session_ver+1 WHERE id=?', [req.user.id]);
  L.setSession(req, res, await L.one('SELECT id, session_ver FROM users WHERE id=?', [req.user.id]));
}
r.post('/account/password', L.need(() => true), async (req, res) => {
  const u = await L.one('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!L.checkPassword(req.body.current || '', u.password_hash)) res.flash('Current password is incorrect.');
  else if (String(req.body.password || '').length < 8) res.flash('New password must be at least 8 characters.');
  else {
    await L.q('UPDATE users SET password_hash=? WHERE id=?', [L.hashPassword(req.body.password), req.user.id]);
    await newSession(req, res);
    res.flash('Password changed. Other devices have been signed out.');
  }
  res.redirect('/account');
});
r.post('/account/signout-all', L.need(() => true), async (req, res) => {
  await newSession(req, res);
  res.flash('Signed out of all other devices.');
  res.redirect('/account');
});

// ---- Two-step verification (authenticator app) ----
const newRecoveryCodes = () => Array.from({ length: 8 }, () => L.base32(require('crypto').randomBytes(7)).slice(0, 10).replace(/(.{5})/, '$1-'));
async function showCodes(res, userId, title) {
  const codes = newRecoveryCodes();
  await L.q('UPDATE users SET recovery_codes=? WHERE id=?', [JSON.stringify(codes.map(recoveryHash)), userId]);
  res.render('public/twofa', { step: 'codes', codes, title, qr: null, secret: null, left: codes.length });
}
r.get('/account/2fa', L.need(() => true), async (req, res) => {
  const u = await L.one('SELECT email, totp_secret, totp_enabled, recovery_codes FROM users WHERE id=?', [req.user.id]);
  if (u.totp_enabled) return res.render('public/twofa', { step: 'on', left: recoveryList(u).length, qr: null, secret: null, codes: null, title: null });
  let secret = u.totp_secret;
  if (!secret) { secret = L.newTotpSecret(); await L.q('UPDATE users SET totp_secret=? WHERE id=?', [secret, req.user.id]); }
  const app = res.locals.appName, uri = `otpauth://totp/${encodeURIComponent(`${app}:${u.email}`)}?secret=${secret}&issuer=${encodeURIComponent(app)}`;
  res.render('public/twofa', { step: 'setup', secret: secret.replace(/(.{4})/g, '$1 ').trim(), qr: await require('qrcode').toDataURL(uri, { margin: 1, width: 220 }), codes: null, title: null, left: 0 });
});
r.post('/account/2fa/enable', L.need(() => true), async (req, res) => {
  const u = await L.one('SELECT totp_secret, totp_enabled FROM users WHERE id=?', [req.user.id]);
  const step = !u.totp_enabled && L.checkTotp(u.totp_secret, String(req.body.code || '').replace(/\s/g, ''));
  if (step === null || step === false) { res.flash('That code did not match — check the time on your phone and try again.'); return res.redirect('/account/2fa'); }
  await L.q('UPDATE users SET totp_enabled=1, totp_last=? WHERE id=?', [step, req.user.id]);
  await newSession(req, res); // other devices must sign in again with the second step
  await showCodes(res, req.user.id, 'Two-step verification is on');
});
r.post('/account/2fa/codes', L.need(() => true), async (req, res) => {
  const u = await L.one('SELECT totp_secret, totp_enabled FROM users WHERE id=?', [req.user.id]);
  if (!u.totp_enabled || L.checkTotp(u.totp_secret, String(req.body.code || '').replace(/\s/g, '')) === null) { res.flash('Enter a current code from your authenticator app.'); return res.redirect('/account/2fa'); }
  await showCodes(res, req.user.id, 'New recovery codes');
});
r.post('/account/2fa/disable', L.need(() => true), async (req, res) => {
  const u = await L.one('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!L.checkPassword(req.body.password || '', u.password_hash)) { res.flash('Password is incorrect.'); return res.redirect('/account/2fa'); }
  await L.q('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_last=NULL, recovery_codes=NULL WHERE id=?', [req.user.id]);
  res.flash('Two-step verification turned off.');
  res.redirect('/account');
});

// ---- Your data: download everything we hold about you, or delete the account ----
r.get('/account/export', L.need(() => true), async (req, res) => {
  const id = req.user.id, fs = require('fs'), path = require('path');
  const json = {
    profile: await L.one(`SELECT id,name,email,phone,role,dob,gender,father_name,address,is_pilot,license_no,license_expiry,regulator,pro_until,created_at
      FROM users WHERE id=?`, [id]),
    applications: await L.q('SELECT a.*, r.name rpto, b.title batch FROM applications a JOIN rptos r ON r.id=a.rpto_id LEFT JOIN batches b ON b.id=a.batch_id WHERE a.user_id=?', [id]),
    documents: await L.q('SELECT doc_type, label, original_name, status, note, uploaded_at FROM trainee_documents WHERE user_id=?', [id]),
    attendance: await L.q('SELECT s.date, s.start_time, s.type, s.title, at.present, at.assessment, at.remarks FROM attendance at JOIN sessions s ON s.id=at.session_id WHERE at.user_id=? ORDER BY s.date', [id]),
    test_results: await L.q('SELECT t.title, t.type, r.score, r.total, r.passed, r.remarks, r.taken_at FROM test_results r JOIN tests t ON t.id=r.test_id WHERE r.user_id=?', [id]),
    fees: await L.q('SELECT f.description, f.amount, f.gst_percent, f.paid, f.due_date, r.name rpto FROM fees f JOIN rptos r ON r.id=f.rpto_id WHERE f.user_id=?', [id]),
    fee_payments: await L.q('SELECT p.receipt_no, p.amount, p.mode, p.reference, p.paid_on FROM fee_payments p JOIN fees f ON f.id=p.fee_id WHERE f.user_id=?', [id]),
    training_flights: await L.q('SELECT date, time, activity_type, activity, place, minutes, remarks FROM flight_logs WHERE pilot_id=? ORDER BY date', [id]),
    flight_tracks: await L.q('SELECT id, original_name, format, started_at, duration_s, distance_m, max_alt_m, max_speed, notes FROM tracks WHERE user_id=?', [id]),
    pilot_logbook: await L.q('SELECT * FROM pilot_entries WHERE user_id=? ORDER BY date', [id]),
    pilot_assets: await L.q('SELECT * FROM pilot_assets WHERE user_id=?', [id]),
    pilot_maintenance: await L.q('SELECT * FROM pilot_maintenance WHERE user_id=?', [id]),
    payments: await L.q('SELECT plan, quantity, amount_paise, status, created_at, paid_at FROM payments WHERE user_id=?', [id]),
    memberships: await L.q('SELECT m.role, r.name rpto FROM members m JOIN rptos r ON r.id=m.rpto_id WHERE m.user_id=?', [id]),
  };
  const files = [{ name: 'my-data.json', data: Buffer.from(JSON.stringify(json, null, 2)) }];
  const own = [...(await L.q('SELECT file, original_name FROM trainee_documents WHERE user_id=? AND file IS NOT NULL', [id])).map(d => ['documents', d.file, d.original_name]),
    ...(await L.q('SELECT file, original_name FROM tracks WHERE user_id=? AND file IS NOT NULL', [id])).map(t => ['flight-logs', t.file, t.original_name])];
  for (const [dir, f, orig] of own) {
    try { files.push({ name: `${dir}/${path.basename(f)}-${path.basename(orig || '')}`.replace(/-$/, ''), data: fs.readFileSync(path.join(L.UPLOAD_DIR, path.basename(f))) }); } catch {}
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="my-data-${L.today()}.zip"`);
  res.send(L.zip(files));
});
// Training records are regulatory, so the account is anonymised (not erased) and personal files are removed.
r.post('/account/delete', L.need(() => true), async (req, res) => {
  const u = await L.one('SELECT * FROM users WHERE id=?', [req.user.id]), fs = require('fs'), path = require('path');
  const fail = msg => { res.flash(msg); res.redirect('/account'); };
  if (u.role === 'super_admin') return fail('Platform admin accounts cannot be deleted here.');
  if (!L.checkPassword(req.body.password || '', u.password_hash) || req.body.confirm !== 'DELETE') return fail('Type DELETE and your current password to delete your account.');
  for (const m of await L.q("SELECT rpto_id FROM members WHERE user_id=? AND role IN ('Admin','Accountable Manager')", [u.id])) {
    const { n } = await L.one("SELECT COUNT(DISTINCT user_id) n FROM members WHERE rpto_id=? AND role IN ('Admin','Accountable Manager') AND user_id<>?", [m.rpto_id, u.id]);
    if (!n) return fail('You are the last admin of your RPTO. Add another Admin or Accountable Manager under Members first.');
  }
  const gone = [u.avatar, u.signature, ...(await L.q('SELECT file FROM trainee_documents WHERE user_id=? AND file IS NOT NULL', [u.id])).map(d => d.file),
    ...(await L.q('SELECT t.file FROM tracks t WHERE t.user_id=? AND t.file IS NOT NULL AND NOT EXISTS (SELECT 1 FROM flight_logs f WHERE f.track_id=t.id) AND NOT EXISTS (SELECT 1 FROM test_results r WHERE r.track_id=t.id)', [u.id])).map(t => t.file)];
  await L.q("UPDATE trainee_documents SET file=NULL, original_name=NULL, status='purged' WHERE user_id=?", [u.id]);
  await L.q('DELETE t FROM tracks t WHERE t.user_id=? AND NOT EXISTS (SELECT 1 FROM flight_logs f WHERE f.track_id=t.id) AND NOT EXISTS (SELECT 1 FROM test_results r WHERE r.track_id=t.id)', [u.id]);
  for (const t of ['pilot_entries', 'pilot_maintenance', 'pilot_assets', 'members', 'password_resets']) await L.q(`DELETE FROM ${t} WHERE user_id=?`, [u.id]);
  await L.q("DELETE FROM applications WHERE user_id=? AND status IN ('pending','rejected','withdrawn','cancelled')", [u.id]);
  await L.q(`UPDATE users SET name=?, email=?, phone=NULL, dob=NULL, gender=NULL, father_name=NULL, address=NULL, avatar=NULL, signature=NULL, license_no=NULL,
    password_hash=?, active=0, rpto_id=NULL, totp_enabled=0, totp_secret=NULL, recovery_codes=NULL, session_ver=session_ver+1 WHERE id=?`,
    [`Deleted user #${u.id}`, `deleted-${u.id}@invalid.local`, L.hashPassword(L.randomPassword()), u.id]);
  for (const f of gone) if (f && f.includes('.')) fs.unlink(path.join(L.UPLOAD_DIR, path.basename(f)), () => {});
  res.clearCookie('sid');
  res.render('message', { title: 'Account deleted', text: 'Your account was deleted and your personal files removed. Training records your RPTO must keep by law are retained without your contact details.' });
});

// ---- Forgot / reset password (email) ----
r.get('/forgot', (req, res) => res.render('public/forgot', { sent: false, enabled: L.mailEnabled() && !!process.env.APP_URL }));
r.post('/forgot', async (req, res) => {
  const enabled = L.mailEnabled() && !!process.env.APP_URL; // APP_URL required so the emailed link can't be spoofed via the Host header
  const u = enabled && await L.one('SELECT id, name, email FROM users WHERE email=? AND active=1', [String(req.body.email || '').trim().toLowerCase()]);
  if (u) {
    const link = await L.resetLink(req, u.id, 1);
    L.sendMail(u.email, `Reset your ${res.locals.appName} password`, `Hi ${u.name},\n\nUse this link within 1 hour to set a new password:\n${link}\n\nIf you didn't ask for this, ignore this email.`);
  }
  res.render('public/forgot', { sent: true, enabled }); // same response whether or not the email exists
});
const resetUser = token => L.one('SELECT user_id FROM password_resets WHERE token_hash=? AND expires_at > NOW()', [L.sha256(String(token))]);
r.get('/reset/:token', async (req, res) => res.render('public/reset', { ok: !!(await resetUser(req.params.token)), error: null }));
r.post('/reset/:token', async (req, res) => {
  const row = await resetUser(req.params.token);
  if (!row) return res.render('public/reset', { ok: false, error: null });
  if (String(req.body.password || '').length < 8) return res.render('public/reset', { ok: true, error: 'Password must be at least 8 characters.' });
  await L.q('UPDATE users SET password_hash=?, session_ver=session_ver+1 WHERE id=?', [L.hashPassword(req.body.password), row.user_id]);
  await L.q('DELETE FROM password_resets WHERE user_id=?', [row.user_id]);
  const u = await L.one('SELECT * FROM users WHERE id=?', [row.user_id]);
  login(req, res, u);
  res.flash('Password set. Welcome!');
  res.redirect(home(u));
});

// ---- Practice simulator (any signed-in user; students also get their batch's simulator test) ----
const DRILLS = ['hover', 'square', 'eight', 'agri', 'gates', 'free'];
const openSimTest = uid => L.one(`SELECT t.* FROM tests t JOIN applications a ON a.batch_id=t.batch_id AND a.user_id=? AND a.status='accepted'
  WHERE t.type='simulator' AND t.open=1 AND NOT EXISTS (SELECT 1 FROM test_results r WHERE r.test_id=t.id AND r.user_id=? AND r.passed IS NOT NULL)
  ORDER BY t.id LIMIT 1`, [uid, uid]);
r.get('/simulator', L.need(() => true), async (req, res) => {
  const runs = await L.q('SELECT * FROM sim_runs WHERE user_id=? ORDER BY id DESC LIMIT 10', [req.user.id]);
  // "Fly like my drone": top speed / climb rate measured in the pilot's own uploaded flights.
  const profiles = (await L.q(`SELECT id, COALESCE(exercise, notes, original_name) name, DATE(COALESCE(started_at, created_at)) date, max_speed,
      JSON_EXTRACT(analysis, '$.summary.max_climb') climb FROM tracks WHERE user_id=? AND max_speed > 1 ORDER BY id DESC LIMIT 10`, [req.user.id]))
    .map(t => ({ id: t.id, name: `${String(t.name).slice(0, 40)} (${t.date})`, maxV: Math.min(25, +t.max_speed), maxVz: Math.min(8, Math.max(1, +t.climb || 2.5)) }));
  res.render('simulator', { runs, profiles, test: req.user.role === 'student' ? await openSimTest(req.user.id) : null });
});
r.post('/simulator/run', L.need(() => true), async (req, res) => {
  const b = req.body;
  if (DRILLS.includes(b.exercise)) await L.q('INSERT INTO sim_runs (user_id,exercise,passed,seconds,penalties) VALUES (?,?,?,?,?)',
    [req.user.id, b.exercise, b.passed === '1' ? 1 : 0, Math.max(0, parseInt(b.seconds) || 0), Math.max(0, parseInt(b.penalties) || 0)]);
  res.status(204).end();
});
// ponytail: the browser scores the drills (self-reported) — the instructor can review/override on the test's results page.
r.post('/simulator/test/:id', L.need(u => u.role === 'student'), async (req, res) => {
  const t = await openSimTest(req.user.id);
  if (!t || String(t.id) !== req.params.id) { res.flash('This simulator test is not open for you.'); return res.redirect('/student'); }
  let list = [];
  try { list = JSON.parse(req.body.results || '[]'); } catch { /* treated as nothing flown */ }
  const need = ['hover', 'square', 'eight'];
  const got = need.map(k => (Array.isArray(list) ? list : []).find(x => x && x.exercise === k) || { exercise: k, passed: 0, seconds: 0, penalties: 0 });
  const score = got.filter(x => +x.passed === 1).length;
  for (const x of got) await L.q('INSERT INTO sim_runs (user_id,exercise,passed,seconds,penalties) VALUES (?,?,?,?,?)', [req.user.id, x.exercise, +x.passed === 1 ? 1 : 0, parseInt(x.seconds) || 0, parseInt(x.penalties) || 0]);
  await L.q(`INSERT INTO test_results (test_id,user_id,score,total,passed,remarks,answers) VALUES (?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE score=VALUES(score), total=VALUES(total), passed=VALUES(passed), remarks=VALUES(remarks), answers=VALUES(answers), taken_at=NOW()`,
    [t.id, req.user.id, score, need.length, score === need.length ? 1 : 0, 'Browser simulator (self-reported)', JSON.stringify(got)]);
  const b = await L.one('SELECT rpto_id FROM batches WHERE id=?', [t.batch_id]);
  await L.log(b.rpto_id, `${req.user.name} completed ${t.title} (${score}/${need.length} drills)`);
  res.flash(`Simulator test submitted: ${score}/${need.length} drills passed.`);
  res.redirect('/student');
});

module.exports = r;

const r = require('express').Router();
const L = require('../lib');
const T = require('../training');
const D = require('../defaults');

r.use(L.need(u => u.role === 'super_admin'));

r.get('/', async (req, res) => {
  const c = await L.one(`SELECT
    (SELECT COUNT(*) FROM rptos) rptos, (SELECT COUNT(*) FROM rptos WHERE status='pending') pending,
    (SELECT COUNT(*) FROM rptos WHERE status='approved') approved, (SELECT COUNT(*) FROM rptos WHERE status='suspended') suspended,
    (SELECT COUNT(*) FROM users WHERE role='student') students, (SELECT COUNT(DISTINCT user_id) FROM members) staff,
    (SELECT COUNT(*) FROM batches WHERE status IN ('planned','active')) batches,
    (SELECT COUNT(*) FROM applications WHERE cert_no IS NOT NULL) certs, (SELECT COUNT(*) FROM applications WHERE rpc_no IS NOT NULL) rpcs`);
  const pending = await L.q(`SELECT r.*, (SELECT COUNT(*) FROM rpto_documents d WHERE d.rpto_id=r.id) docs
    FROM rptos r WHERE status='pending' ORDER BY created_at`);
  const recent = await L.q('SELECT a.*, r.name rpto FROM activity a LEFT JOIN rptos r ON r.id=a.rpto_id ORDER BY a.id DESC LIMIT 15');
  res.render('super/dashboard', { c, pending, recent });
});

r.get('/rptos', async (req, res) => {
  const { status = '', s = '' } = req.query;
  const rptos = await L.q(`SELECT r.*,
      (SELECT COUNT(DISTINCT user_id) FROM members m WHERE m.rpto_id=r.id) staff,
      (SELECT COUNT(DISTINCT user_id) FROM applications a WHERE a.rpto_id=r.id AND a.status='accepted') trainees,
      (SELECT COUNT(*) FROM batches b WHERE b.rpto_id=r.id) batches
    FROM rptos r WHERE (?='' OR status=?) AND (?='' OR name LIKE ? OR city LIKE ?) ORDER BY r.created_at DESC`,
    [status, status, s, `%${s}%`, `%${s}%`]);
  res.render('super/rptos', { rptos, status, s });
});

r.get('/rptos/new', (req, res) => res.render('super/rpto-new', { error: null, b: {} }));
r.post('/rptos/new', async (req, res) => {
  const b = req.body, email = String(b.email || '').trim().toLowerCase();
  const bad = msg => res.status(400).render('super/rpto-new', { error: msg, b });
  if (!b.name || !b.city || !b.am_name || !email) return bad('Please fill all required fields.');
  if (await L.one('SELECT id FROM users WHERE email=?', [email])) return bad('A user with this email already exists.');
  const pw = b.password || L.randomPassword();
  const x = await L.q(`INSERT INTO rptos (name,city,address,auth_no,file_no,accountable_manager,contact_email,contact_phone,staff_limit,status,approved_at,about_locked)
    VALUES (?,?,?,?,?,?,?,?,?,'approved',NOW(),?)`,
    [b.name, b.city, b.address, b.auth_no, b.file_no, b.am_name, email, b.phone, +b.staff_limit || 30, b.auth_no ? 1 : 0]);
  const y = await L.q("INSERT INTO users (rpto_id,name,email,phone,password_hash,role) VALUES (?,?,?,?,?,'member')", [x.insertId, b.am_name, email, b.phone, L.hashPassword(pw)]);
  await L.q("INSERT INTO members (rpto_id,user_id,role) VALUES (?,?,'Accountable Manager')", [x.insertId, y.insertId]);
  await L.log(x.insertId, `RPTO created and approved by super admin`);
  res.flash(await L.credentialsMessage(req, { id: y.insertId, email, name: b.am_name }, pw, `RPTO ${b.name} created — Accountable Manager`));
  res.redirect('/super/rptos/' + x.insertId);
});

r.get('/rptos/:id', async (req, res) => {
  const rpto = await L.one('SELECT * FROM rptos WHERE id=?', [req.params.id]);
  if (!rpto) return res.status(404).render('message', { title: 'Not found', text: 'RPTO not found.' });
  const docs = await L.q('SELECT * FROM rpto_documents WHERE rpto_id=? ORDER BY uploaded_at', [rpto.id]);
  const members = await L.q(`SELECT u.id, u.name, u.email, u.active, GROUP_CONCAT(m.role ORDER BY m.role SEPARATOR ', ') roles
    FROM members m JOIN users u ON u.id=m.user_id WHERE m.rpto_id=? GROUP BY u.id ORDER BY u.name`, [rpto.id]);
  const batches = await L.q(`SELECT b.*, (SELECT COUNT(*) FROM applications a WHERE a.batch_id=b.id AND a.status='accepted') admitted
    FROM batches b WHERE rpto_id=? ORDER BY b.created_at DESC`, [rpto.id]);
  const k = await L.one(`SELECT (SELECT COUNT(*) FROM applications WHERE rpto_id=? AND status='accepted') trainees,
    (SELECT COUNT(*) FROM applications WHERE rpto_id=? AND cert_no IS NOT NULL) certs,
    (SELECT COUNT(*) FROM assets WHERE rpto_id=?) assets`, [rpto.id, rpto.id, rpto.id]);
  const ledger = await L.q(`SELECT l.*, u.name by_name FROM credit_ledger l LEFT JOIN users u ON u.id=l.created_by
    WHERE l.rpto_id=? ORDER BY l.id DESC LIMIT 20`, [rpto.id]);
  const earnDue = (await L.one("SELECT COALESCE(SUM(amount_paise),0) n FROM partner_earnings WHERE rpto_id=? AND status='due'", [rpto.id])).n;
  res.render('super/rpto', { rpto, docs, members, batches, k, ledger, earnDue, T });
});
// Grant or deduct completion credits (never below zero).
r.post('/rptos/:id/credits', async (req, res) => {
  const delta = parseInt(req.body.delta) || 0;
  if (!delta) { res.flash('Enter a non-zero number of credits.'); return res.redirect('/super/rptos/' + req.params.id); }
  const ok = await T.addCredits(+req.params.id, delta, delta > 0 ? 'grant' : 'adjust', { note: req.body.note || null, by: req.user.id });
  res.flash(ok ? `${delta > 0 ? 'Added' : 'Removed'} ${Math.abs(delta)} credit(s).` : 'Not enough credits to remove that many.');
  res.redirect('/super/rptos/' + req.params.id);
});
// Record a payout of all partner earnings due to an RPTO.
r.post('/rptos/:id/earnings-paid', async (req, res) => {
  const x = await L.q("UPDATE partner_earnings SET status='paid', paid_at=NOW() WHERE rpto_id=? AND status='due'", [req.params.id]);
  if (x.affectedRows) await L.log(+req.params.id, `Partner earnings paid out (${x.affectedRows} item(s))`);
  res.flash(`${x.affectedRows} earning(s) marked paid.`);
  res.redirect(req.get('Referer') || '/super/payments');
});

r.post('/rptos/:id/status', async (req, res) => {
  const status = ['approved', 'rejected', 'suspended', 'pending'].find(s => s === req.body.status);
  if (!status) return res.redirect('/super/rptos/' + req.params.id);
  await L.q(`UPDATE rptos SET status=?, status_note=?, approved_at=IF(?='approved', COALESCE(approved_at, NOW()), approved_at),
    about_locked=IF(?='approved', 1, about_locked) WHERE id=?`, [status, req.body.note || null, status, status, req.params.id]);
  await L.log(+req.params.id, `RPTO ${status} by super admin${req.body.note ? ': ' + req.body.note : ''}`);
  const rp = await L.one('SELECT name, contact_email FROM rptos WHERE id=?', [req.params.id]);
  L.sendMail(rp.contact_email, `${rp.name}: registration ${status}`,
    `Your RPTO "${rp.name}" is now ${status} on ${res.locals.appName}.${req.body.note ? '\n\nNote: ' + req.body.note : ''}\n\nLog in: ${L.baseUrl(req)}/login`);
  res.flash(`RPTO marked ${status}.`);
  res.redirect('/super/rptos/' + req.params.id);
});

r.post('/rptos/:id/settings', async (req, res) => {
  await L.q('UPDATE rptos SET staff_limit=?, about_locked=? WHERE id=?', [Math.max(1, +req.body.staff_limit || 30), req.body.about_locked ? 1 : 0, req.params.id]);
  res.flash('Settings updated.');
  res.redirect('/super/rptos/' + req.params.id);
});

r.get('/users', async (req, res) => {
  const { role = '', s = '', rpto = '' } = req.query;
  const users = await L.q(`SELECT u.*, r.name rpto_name,
      (SELECT GROUP_CONCAT(role SEPARATOR ', ') FROM members m WHERE m.user_id=u.id) roles
    FROM users u LEFT JOIN rptos r ON r.id=u.rpto_id
    WHERE (?='' OR u.role=?) AND (?='' OR u.rpto_id=? OR u.id IN (SELECT user_id FROM applications WHERE rpto_id=?))
      AND (?='' OR u.name LIKE ? OR u.email LIKE ?)
    ORDER BY u.created_at DESC LIMIT 500`, [role, role, rpto, rpto, rpto, s, `%${s}%`, `%${s}%`]);
  const rptos = await L.q('SELECT id,name FROM rptos ORDER BY name');
  res.render('super/users', { users, rptos, role, s, rpto });
});

r.post('/users/:id/toggle', async (req, res) => {
  if (+req.params.id !== req.user.id) await L.q('UPDATE users SET active=1-active WHERE id=?', [req.params.id]);
  res.redirect(req.get('Referer') || '/super/users');
});
r.post('/users/:id/password', async (req, res) => {
  const pw = L.randomPassword(), u = await L.one('SELECT email FROM users WHERE id=?', [req.params.id]);
  await L.q('UPDATE users SET password_hash=?, session_ver=session_ver+1 WHERE id=?', [L.hashPassword(pw), req.params.id]);
  res.flash(`New password for ${u.email}: ${pw}`);
  res.redirect(req.get('Referer') || '/super/users');
});
// Lost phone and recovery codes: the platform admin can switch two-step verification off (after checking identity offline).
r.post('/users/:id/2fa-reset', async (req, res) => {
  const u = await L.one('SELECT email FROM users WHERE id=?', [req.params.id]);
  if (u) {
    await L.q('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_last=NULL, recovery_codes=NULL, session_ver=session_ver+1 WHERE id=?', [req.params.id]);
    res.flash(`Two-step verification turned off for ${u.email}. Ask them to set it up again.`);
  }
  res.redirect(req.get('Referer') || '/super/users');
});
// Grant / change Pilot Pro manually (e.g. offline payment or promotion). Empty date removes it.
r.post('/users/:id/pro', async (req, res) => {
  await L.q('UPDATE users SET pro_until=? WHERE id=?', [req.body.pro_until || null, req.params.id]);
  res.flash(req.body.pro_until ? `Pilot Pro active until ${req.body.pro_until}.` : 'Pilot Pro removed.');
  res.redirect(req.get('Referer') || '/super/users');
});
r.get('/payments', async (req, res) => {
  const payments = await L.q(`SELECT p.*, u.name, u.email, r.name rpto FROM payments p JOIN users u ON u.id=p.user_id
    LEFT JOIN rptos r ON r.id=p.rpto_id ORDER BY p.id DESC LIMIT 500`);
  const k = await L.one(`SELECT COALESCE(SUM(amount_paise),0)/100 total, COUNT(*) n, COALESCE(SUM(IF(plan='credits', amount_paise, 0)),0)/100 credits
    FROM payments WHERE status='paid'`);
  const pro = (await L.one('SELECT COUNT(*) n FROM users WHERE pro_until >= CURDATE()')).n;
  const earnings = await L.q(`SELECT r.id, r.name, COUNT(*) items, SUM(e.amount_paise) paise FROM partner_earnings e JOIN rptos r ON r.id=e.rpto_id
    WHERE e.status='due' GROUP BY r.id, r.name ORDER BY paise DESC`);
  res.render('super/payments', { payments, k, pro, earnings });
});

// Platform defaults (rpto_id NULL): the syllabus and question bank every RPTO uses until it customises its own.
r.get('/defaults', async (req, res) => {
  const tab = req.query.tab === 'questions' ? 'questions' : 'syllabus';
  const [syllabus, questions] = await Promise.all([D.syllabus(null), D.questions(null)]);
  const { n } = await L.one('SELECT COUNT(DISTINCT rpto_id) n FROM syllabus_items WHERE rpto_id IS NOT NULL');
  const { m } = await L.one('SELECT COUNT(DISTINCT rpto_id) m FROM questions WHERE rpto_id IS NOT NULL');
  res.render('super/defaults', { tab, syllabus, questions, customSyl: n, customQ: m });
});
D.mount(r, { base: '/defaults', guard: (req, res, next) => next(), owner: () => null, back: tab => `/super/defaults?tab=${tab}` });

// Tutorials shown in every pilot's hub.
const tutorial = x => ({ category: String(x.category || 'Getting started').slice(0, 80), title: String(x.title || '').trim().slice(0, 200),
  video_url: /^https:\/\//.test(x.video_url || '') ? x.video_url.slice(0, 500) : null, description: x.description || null,
  status: x.status === 'soon' ? 'soon' : 'live', sort: +x.sort || 0 });
r.get('/tutorials', async (req, res) => {
  const list = await L.q('SELECT t.*, (SELECT COUNT(*) FROM tutorial_comments c WHERE c.tutorial_id=t.id) comments FROM tutorials t ORDER BY t.category, t.sort, t.id');
  const comments = await L.q('SELECT c.*, u.name, t.title FROM tutorial_comments c JOIN users u ON u.id=c.user_id JOIN tutorials t ON t.id=c.tutorial_id ORDER BY c.id DESC LIMIT 50');
  res.render('super/tutorials', { list, comments });
});
r.post('/tutorials', async (req, res) => {
  const t = tutorial(req.body);
  if (t.title) await L.q('INSERT INTO tutorials SET ?', [t]); else res.flash('A title is required.');
  res.redirect('/super/tutorials');
});
r.post('/tutorials/:id', async (req, res) => {
  const t = tutorial(req.body);
  if (t.title) await L.q('UPDATE tutorials SET ? WHERE id=?', [t, req.params.id]);
  res.redirect('/super/tutorials');
});
r.post('/tutorials/:id/delete', async (req, res) => {
  await L.q('DELETE FROM tutorials WHERE id=?', [req.params.id]);
  res.redirect('/super/tutorials');
});
r.post('/comments/:id/delete', async (req, res) => { // moderation
  await L.q('DELETE FROM tutorial_comments WHERE id=?', [req.params.id]);
  res.redirect('/super/tutorials');
});

module.exports = r;

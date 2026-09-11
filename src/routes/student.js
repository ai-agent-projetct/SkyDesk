const r = require('express').Router();
const fs = require('fs');
const path = require('path');
const L = require('../lib');
const T = require('../training');

r.use(L.need(u => u.role === 'student'));
const notFound = res => res.status(404).render('message', { title: 'Not found', text: 'That record does not exist.' });

r.get('/', async (req, res) => {
  const uid = req.user.id;
  const apps = await L.q(`SELECT a.*, r.name rpto_name, r.city, b.title batch_title, b.start_date, b.end_date, b.status batch_status, b.delivery
    FROM applications a JOIN rptos r ON r.id=a.rpto_id LEFT JOIN batches b ON b.id=a.batch_id WHERE a.user_id=? ORDER BY a.applied_at DESC`, [uid]);
  const active = apps.find(a => a.status === 'accepted') || null;
  let progress = null, schedule = [], tests = [];
  if (active) {
    progress = (await T.batchProgress(active.batch_id)).trainees.find(x => x.id === uid);
    schedule = await L.q(`SELECT s.*, i.name instructor, t.present, t.assessment FROM sessions s LEFT JOIN users i ON i.id=s.instructor_id
      LEFT JOIN attendance t ON t.session_id=s.id AND t.user_id=? WHERE s.batch_id=? AND s.status<>'cancelled' ORDER BY s.date, s.start_time`, [uid, active.batch_id]);
    tests = await L.q(`SELECT t.*, r.score, r.total, r.passed, r.taken_at FROM tests t LEFT JOIN test_results r ON r.test_id=t.id AND r.user_id=?
      WHERE t.batch_id=?`, [uid, active.batch_id]);
  }
  const flights = await L.q('SELECT f.*, a.name rpas FROM flight_logs f LEFT JOIN assets a ON a.id=f.rpas_id WHERE f.pilot_id=? ORDER BY f.date DESC', [uid]);
  const fees = await L.q('SELECT f.*, r.name rpto FROM fees f JOIN rptos r ON r.id=f.rpto_id WHERE f.user_id=?', [uid]);
  const receipts = fees.length ? await L.q('SELECT id, fee_id, receipt_no, amount, paid_on FROM fee_payments WHERE fee_id IN (?) ORDER BY paid_on', [fees.map(f => f.id)]) : [];
  fees.forEach(f => { f.receipts = receipts.filter(p => p.fee_id === f.id); });
  const docs = Object.fromEntries((await L.q("SELECT doc_type, status FROM trainee_documents WHERE user_id=? AND LEFT(doc_type, 6) <> 'other_'", [uid])).map(d => [d.doc_type, d.status]));
  const { stats: career } = await require('./flights').pilotLog(uid);
  res.render('student/dashboard', { apps, active, progress, schedule, tests, flights, fees, docs, career });
});

// ---- Apply to an open batch ----
r.get('/apply', async (req, res) => {
  const batches = await L.q(`SELECT b.*, r.name rpto_name, r.city, r.tagline,
      b.seats - (SELECT COUNT(*) FROM applications a WHERE a.batch_id=b.id AND a.status='accepted') seats_left
    FROM batches b JOIN rptos r ON r.id=b.rpto_id
    WHERE r.status='approved' AND b.accepting=1 AND b.status IN ('planned','active') ORDER BY b.start_date IS NULL, b.start_date`);
  const current = await L.one("SELECT a.*, r.name rpto_name FROM applications a JOIN rptos r ON r.id=a.rpto_id WHERE a.user_id=? AND a.status IN ('pending','accepted') LIMIT 1", [req.user.id]);
  res.render('student/apply', { batches, current, rptoFilter: req.query.rpto || '' });
});
r.post('/apply/:batchId', async (req, res) => {
  const b = await L.one(`SELECT b.* FROM batches b JOIN rptos r ON r.id=b.rpto_id
    WHERE b.id=? AND r.status='approved' AND b.accepting=1 AND b.status IN ('planned','active')`, [req.params.batchId]);
  if (!b) { res.flash('This batch is not accepting applications.'); return res.redirect('/student/apply'); }
  if (await L.one("SELECT id FROM applications WHERE user_id=? AND status IN ('pending','accepted')", [req.user.id])) {
    res.flash('You already have an active application. Withdraw it first to apply elsewhere.');
    return res.redirect('/student');
  }
  await L.q('INSERT INTO applications (rpto_id,batch_id,user_id) VALUES (?,?,?)', [b.rpto_id, b.id, req.user.id]);
  await L.log(b.rpto_id, `${req.user.name} applied to ${b.title}`);
  res.flash('Application submitted. Upload your documents so the RPTO can verify and admit you.');
  res.redirect('/student/documents');
});
r.post('/applications/:id/withdraw', async (req, res) => {
  await L.q("UPDATE applications SET status='withdrawn', decided_at=NOW() WHERE id=? AND user_id=? AND status='pending'", [req.params.id, req.user.id]);
  res.redirect('/student');
});

// ---- Documents ----
r.get('/documents', async (req, res) => {
  const docs = Object.fromEntries((await L.q('SELECT * FROM trainee_documents WHERE user_id=?', [req.user.id])).map(d => [d.doc_type, d]));
  const { doc_consent_at } = await L.one('SELECT doc_consent_at FROM users WHERE id=?', [req.user.id]);
  res.render('student/documents', { docs, consent: doc_consent_at });
});
r.post('/documents/consent', async (req, res) => {
  if (req.body.agree) await L.q('UPDATE users SET doc_consent_at=NOW() WHERE id=? AND doc_consent_at IS NULL', [req.user.id]);
  res.redirect('/student/documents');
});
// Upload one document. type = a standard key, an existing other_<n>, or 'other' (new extra document with a label).
r.post('/documents/:type', L.upload.single('file'), async (req, res) => {
  const drop = () => req.file && fs.unlink(req.file.path, () => {});
  const fail = msg => { drop(); res.flash(msg); res.redirect('/student/documents'); };
  if (!(await L.one('SELECT doc_consent_at FROM users WHERE id=?', [req.user.id])).doc_consent_at) return fail('Please give your consent before uploading documents.');
  let type = req.params.type, label = null;
  if (type === 'other') {
    label = String(req.body.label || '').trim().slice(0, 100);
    if (!label) return fail('Give the document a name, e.g. "Driving licence".');
    const { n } = await L.one("SELECT COUNT(*) n FROM trainee_documents WHERE user_id=? AND LEFT(doc_type, 6)='other_'", [req.user.id]);
    if (n >= 10) return fail('You can add up to 10 extra documents.');
    type = `other_${Date.now().toString(36)}`;
  }
  const old = await L.one('SELECT * FROM trainee_documents WHERE user_id=? AND doc_type=?', [req.user.id, type]);
  if (!(L.TRAINEE_DOCS[type] || label || old) || !req.file) return fail('Upload a PDF, JPG, PNG or WEBP file (max 5 MB).');
  if (old?.status === 'verified') return fail('This document is already verified and cannot be replaced.');
  if (old?.file) fs.unlink(path.join(L.UPLOAD_DIR, path.basename(old.file)), () => {});
  await L.q(`INSERT INTO trainee_documents (user_id,doc_type,label,file,original_name,status) VALUES (?,?,?,?,?,'pending')
    ON DUPLICATE KEY UPDATE file=VALUES(file), original_name=VALUES(original_name), status='pending', note=NULL, uploaded_at=NOW()`,
    [req.user.id, type, label, req.file.filename, req.file.originalname]);
  res.flash(`${L.TRAINEE_DOCS[type] || label || old.label} uploaded — awaiting verification.`);
  res.redirect('/student/documents');
});
r.post('/documents/:type/delete', async (req, res) => {
  const d = await L.one("SELECT * FROM trainee_documents WHERE user_id=? AND doc_type=? AND LEFT(doc_type, 6)='other_' AND status<>'verified'", [req.user.id, req.params.type]);
  if (d) { await L.q('DELETE FROM trainee_documents WHERE id=?', [d.id]); if (d.file) fs.unlink(path.join(L.UPLOAD_DIR, path.basename(d.file)), () => {}); }
  res.redirect('/student/documents');
});

// ---- Online theory test ----
const myTest = (uid, id) => L.one(`SELECT t.*, b.rpto_id, b.title batch_title FROM tests t JOIN batches b ON b.id=t.batch_id
  JOIN applications a ON a.batch_id=b.id AND a.user_id=? AND a.status='accepted' WHERE t.id=? AND t.type='theory'`, [uid, id]);
r.get('/tests/:id', async (req, res) => {
  const t = await myTest(req.user.id, req.params.id);
  if (!t) return notFound(res);
  let row = await L.one('SELECT *, TIMESTAMPDIFF(SECOND, taken_at, NOW()) elapsed FROM test_results WHERE test_id=? AND user_id=?', [t.id, req.user.id]);
  if (row && row.passed !== null) return res.render('student/test', { t, row, questions: null });
  if (!t.open) return res.render('message', { title: t.title, text: 'This test is not open yet. Your RPTO will open it on the exam day.' });
  if (!row) {
    const ids = (await L.q('SELECT id FROM questions WHERE rpto_id <=> ? ORDER BY RAND() LIMIT ?', [await T.bankOwner(t.rpto_id), t.question_count || 50])).map(x => x.id);
    if (!ids.length) return res.render('message', { title: t.title, text: 'The question bank is empty. Please contact your RPTO.' });
    await L.q('INSERT INTO test_results (test_id,user_id,answers) VALUES (?,?,?)', [t.id, req.user.id, JSON.stringify({ qids: ids })]);
    row = await L.one('SELECT *, TIMESTAMPDIFF(SECOND, taken_at, NOW()) elapsed FROM test_results WHERE test_id=? AND user_id=?', [t.id, req.user.id]);
  }
  const qids = row.answers.qids;
  const qs = await L.q('SELECT id, subject, question, a, b, c, d FROM questions WHERE id IN (?)', [qids]);
  const questions = qids.map(id => qs.find(x => x.id === id)).filter(Boolean);
  res.render('student/test', { t, row, questions, secondsLeft: Math.max(0, t.duration_min * 60 - row.elapsed) });
});
r.post('/tests/:id', async (req, res) => {
  const t = await myTest(req.user.id, req.params.id);
  const row = t && await L.one('SELECT *, TIMESTAMPDIFF(SECOND, taken_at, NOW()) elapsed FROM test_results WHERE test_id=? AND user_id=?', [t.id, req.user.id]);
  if (!row || row.passed !== null) return res.redirect('/student');
  const qids = row.answers.qids;
  const key = await L.q('SELECT id, correct FROM questions WHERE id IN (?)', [qids]);
  const given = Object.fromEntries(qids.map(id => [id, String(req.body['q' + id] || '')]));
  const score = key.filter(k => given[k.id] === k.correct).length, total = qids.length;
  const late = row.elapsed > t.duration_min * 60 + 120; // 2 min grace for slow networks
  await L.q('UPDATE test_results SET score=?, total=?, passed=?, answers=?, remarks=? WHERE test_id=? AND user_id=?',
    [score, total, score / total * 100 >= t.pass_percent ? 1 : 0, JSON.stringify({ qids, given }), late ? 'Submitted after time limit' : null, t.id, req.user.id]);
  await L.log(t.rpto_id, `${req.user.name} completed ${t.title} (${score}/${total})`);
  res.redirect('/student/tests/' + t.id);
});

// ---- Plans & billing: free plan (flight-upload limit) vs Pilot Pro via Razorpay (only when keys are configured) ----
const PLANS = {
  pro_month: { label: 'Pilot Pro — monthly', rupees: +process.env.PRO_PRICE_MONTH || 349, months: 1 },
  pro_year: { label: 'Pilot Pro — yearly', rupees: +process.env.PRO_PRICE_YEAR || 3490, months: 12 },
};
r.get('/billing', async (req, res) => {
  const used = (await L.one('SELECT COUNT(*) n FROM tracks WHERE uploaded_by=? AND user_id=?', [req.user.id, req.user.id])).n;
  const payments = await L.q('SELECT * FROM payments WHERE user_id=? AND rpto_id IS NULL ORDER BY id DESC', [req.user.id]);
  res.render('student/billing', { PLANS, used, limit: +process.env.FREE_FLIGHT_LIMIT || 25, payments, keyId: L.razorpayKeyId() });
});
r.post('/billing/order', async (req, res) => {
  const plan = PLANS[req.body.plan];
  if (!plan || !L.razorpayKeyId()) return res.status(400).json({ error: 'Online payments are not configured.' });
  const amount = plan.rupees * 100;
  const order = await L.razorpayOrder(amount, `u${req.user.id}-${Date.now()}`, { user_id: String(req.user.id), plan: req.body.plan });
  if (!order) return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
  await L.q('INSERT INTO payments (user_id,plan,amount_paise,order_id) VALUES (?,?,?,?)', [req.user.id, req.body.plan, amount, order.id]);
  res.json({ key: L.razorpayKeyId(), order_id: order.id, amount, currency: 'INR', name: res.locals.appName, description: plan.label,
    prefill: { name: req.user.name, email: req.user.email, contact: req.user.phone || '' } });
});
r.post('/billing/verify', async (req, res) => {
  const s = await L.settlePayment(req.user.id, req.body);
  if (s.error) { res.flash(s.error); return res.redirect('/student/billing'); }
  if (s.p && PLANS[s.p.plan]) {
    await L.q('UPDATE users SET pro_until=DATE_ADD(GREATEST(COALESCE(pro_until, CURDATE()), CURDATE()), INTERVAL ? MONTH) WHERE id=?', [PLANS[s.p.plan].months, req.user.id]);
    await T.partnerShare(s.p);
    res.flash('Payment successful — Pilot Pro is active. Thank you!');
  }
  res.redirect('/student/billing');
});

// ---- Record & certificate ----
r.get('/receipts/:id', async (req, res) => {
  const d = await T.receiptData(req.params.id, { userId: req.user.id });
  d ? res.render('receipt', d) : notFound(res);
});
r.get('/record/:appId', async (req, res) => {
  const d = await T.recordData(req.params.appId, { userId: req.user.id });
  d ? res.render('record', d) : notFound(res);
});
r.get('/certificate/:appId', async (req, res) => {
  const d = await T.recordData(req.params.appId, { userId: req.user.id });
  d?.a.cert_no ? res.render('certificate', d) : notFound(res);
});

module.exports = r;

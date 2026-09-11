const r = require('express').Router();
const fs = require('fs');
const path = require('path');
const L = require('../lib');
const T = require('../training');
const D = require('../defaults');
const { saveTrack } = require('./flights');

const DOCN = Object.keys(L.TRAINEE_DOCS).length;
const rid = req => req.user.rpto_id;
const back = (req, fallback) => req.get('Referer') || fallback;
const arr = v => [].concat(v ?? []).filter(x => x !== '');
const removeFile = f => f && fs.unlink(path.join(L.UPLOAD_DIR, path.basename(f)), () => {});
const notFound = res => res.status(404).render('message', { title: 'Not found', text: 'That record does not exist.' });
const digits = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };

const admin = L.need(u => u.isAdmin);
const crm = L.need(u => u.isAdmin || u.isBD);
const train = L.need(u => u.isAdmin || u.isInstructor);

r.use(L.need(u => u.role === 'member'));

// ---- approval gate: until the super admin approves, only the status page + document upload work ----
const rptoDocFields = Object.keys(L.RPTO_DOCS).map(name => ({ name, maxCount: 1 }));
r.use(async (req, res, next) => {
  const u = req.user;
  if (!u.rpto) return res.render('message', { title: 'No organisation', text: 'Your account is not linked to an RPTO.' });
  if (u.rpto.status === 'approved') return next();
  if (req.method === 'POST' && req.path === '/documents' && u.isAdmin) return next();
  const docs = await L.q('SELECT * FROM rpto_documents WHERE rpto_id=? ORDER BY uploaded_at', [u.rpto_id]);
  res.render('rpto/pending', { docs });
});
r.post('/documents', L.upload.fields(rptoDocFields), async (req, res) => {
  for (const [k, [f]] of Object.entries(req.files || {})) {
    const old = await L.one('SELECT file FROM rpto_documents WHERE rpto_id=? AND doc_type=?', [rid(req), k]);
    if (old) { removeFile(old.file); await L.q('DELETE FROM rpto_documents WHERE rpto_id=? AND doc_type=?', [rid(req), k]); }
    await L.q('INSERT INTO rpto_documents (rpto_id,doc_type,file,original_name) VALUES (?,?,?,?)', [rid(req), k, f.filename, f.originalname]);
  }
  await L.q("UPDATE rptos SET status='pending', status_note=NULL WHERE id=? AND status='rejected'", [rid(req)]);
  res.flash('Documents uploaded — the platform team will review them.');
  res.redirect('/rpto');
});

// ================= DASHBOARD =================
r.get('/', async (req, res) => {
  const id = rid(req);
  const k = await L.one(`SELECT
    (SELECT COUNT(*) FROM sessions s JOIN batches b ON b.id=s.batch_id WHERE b.rpto_id=? AND s.status='scheduled' AND s.date<CURDATE() AND b.status IN ('planned','active')) unmarked,
    (SELECT COUNT(*) FROM batches WHERE rpto_id=? AND status IN ('planned','active')) active_batches,
    (SELECT COUNT(*) FROM applications WHERE rpto_id=? AND status='pending') applied,
    (SELECT COUNT(*) FROM applications WHERE rpto_id=? AND status='accepted') admitted,
    (SELECT COUNT(*) FROM applications a JOIN batches b ON b.id=a.batch_id WHERE a.rpto_id=? AND a.status='accepted' AND a.cert_no IS NULL AND b.status IN ('planned','active')) in_training,
    (SELECT COUNT(*) FROM applications WHERE rpto_id=? AND cert_no IS NOT NULL) certified,
    (SELECT COUNT(*) FROM applications WHERE rpto_id=? AND rpc_no IS NOT NULL) rpc,
    (SELECT COUNT(DISTINCT user_id) FROM members WHERE rpto_id=? AND role='Instructor') instructors,
    (SELECT COUNT(DISTINCT user_id) FROM applications WHERE rpto_id=? AND status='accepted') trainees`, Array(9).fill(id));
  const todays = await L.q(`SELECT s.*, b.title batch, u.name instructor FROM sessions s JOIN batches b ON b.id=s.batch_id
    LEFT JOIN users u ON u.id=s.instructor_id WHERE b.rpto_id=? AND s.date=CURDATE() AND s.status<>'cancelled' ORDER BY s.start_time`, [id]);
  const month = await L.q(`SELECT b.id, b.title, b.delivery, b.start_date, b.end_date,
      (SELECT COUNT(*) FROM applications a WHERE a.batch_id=b.id AND a.status='accepted') trainees,
      (SELECT COUNT(*) FROM sessions s WHERE s.batch_id=b.id AND s.status='done') done,
      (SELECT COUNT(*) FROM sessions s WHERE s.batch_id=b.id AND s.status<>'cancelled') total
    FROM batches b WHERE b.rpto_id=? AND b.status<>'cancelled'
      AND COALESCE(b.start_date, CURDATE()) <= LAST_DAY(CURDATE())
      AND COALESCE(b.end_date, b.start_date, CURDATE()) >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`, [id]);
  const att = await L.one(`SELECT COALESCE(SUM(a.present=1),0) present, COALESCE(SUM(a.present=0),0) absent,
      COALESCE(SUM(a.assessment='pass'),0) pass, COALESCE(SUM(a.assessment='needs_work'),0) needs_work
    FROM attendance a JOIN sessions s ON s.id=a.session_id JOIN batches b ON b.id=s.batch_id WHERE b.rpto_id=?`, [id]);
  const load = await L.q(`SELECT u.name, COUNT(DISTINCT s.id) sessions,
      (SELECT COALESCE(SUM(f.minutes),0) FROM flight_logs f WHERE f.instructor_id=u.id AND f.rpto_id=?) minutes
    FROM members m JOIN users u ON u.id=m.user_id LEFT JOIN sessions s ON s.instructor_id=u.id
    WHERE m.rpto_id=? AND m.role='Instructor' GROUP BY u.id, u.name ORDER BY sessions DESC`, [id, id]);
  const assets = await L.q(`SELECT a.type, COUNT(*) total, SUM(EXISTS(SELECT 1 FROM batch_resources r JOIN batches b ON b.id=r.batch_id
      WHERE r.kind='asset' AND r.ref_id=a.id AND b.status IN ('planned','active'))) used
    FROM assets a WHERE a.rpto_id=? AND a.status='in_service' GROUP BY a.type`, [id]);
  const recent = await L.q('SELECT * FROM activity WHERE rpto_id=? ORDER BY id DESC LIMIT 10', [id]);
  const credits = T.CREDIT_PRICE ? (await L.one('SELECT credits FROM rptos WHERE id=?', [id])).credits : null;
  const licences = await L.q(`SELECT DISTINCT u.name, u.license_no, u.license_expiry FROM members m JOIN users u ON u.id=m.user_id
    WHERE m.rpto_id=? AND m.role='Instructor' AND u.license_expiry IS NOT NULL AND u.license_expiry <= CURDATE() + INTERVAL 60 DAY ORDER BY u.license_expiry`, [id]);
  res.render('rpto/dashboard', { k, todays, month, att, load, assets, recent, credits, licences });
});

// ================= CRM: LEADS + FEES =================
r.get('/crm', crm, async (req, res) => {
  const id = rid(req), tab = req.query.tab === 'fees' ? 'fees' : 'leads', s = req.query.s || '', st = req.query.status || '';
  const k = await L.one(`SELECT COALESCE(SUM(created_at >= NOW() - INTERVAL 7 DAY),0) new_week,
      COALESCE(SUM(follow_up <= CURDATE() AND status NOT IN ('converted','lost')),0) due,
      COALESCE(SUM(status='converted' AND converted_at >= DATE_FORMAT(CURDATE(),'%Y-%m-01')),0) converted_month,
      COALESCE(SUM(status='converted'),0) converted, COUNT(*) total FROM leads WHERE rpto_id=?`, [id]);
  const like = `%${s}%`;
  const leads = await L.q(`SELECT * FROM leads WHERE rpto_id=? AND (?='' OR status=?)
      AND (?='' OR name LIKE ? OR phone LIKE ? OR email LIKE ? OR interest LIKE ? OR city LIKE ?)
    ORDER BY status IN ('converted','lost'), follow_up IS NULL, follow_up, created_at DESC`, [id, st, st, s, like, like, like, like, like]);
  const batches = await L.q("SELECT id,title,fee,gst_percent,status FROM batches WHERE rpto_id=? AND status<>'cancelled' ORDER BY created_at DESC", [id]);
  let fees = [], trainees = [], payments = [], batch = null;
  if (tab === 'fees') {
    batch = batches.find(b => String(b.id) === String(req.query.batch)) || batches[0] || null;
    // Fees of the selected batch plus any fee not tied to a batch (re-test fees etc.).
    fees = await L.q(`SELECT f.*, u.name, u.email, b.title batch FROM fees f JOIN users u ON u.id=f.user_id LEFT JOIN batches b ON b.id=f.batch_id
      WHERE f.rpto_id=? AND (f.batch_id <=> ? OR f.batch_id IS NULL) ORDER BY f.batch_id IS NULL, u.name`, [id, batch ? batch.id : null]);
    payments = fees.length ? await L.q('SELECT * FROM fee_payments WHERE fee_id IN (?) ORDER BY paid_on, id', [fees.map(f => f.id)]) : [];
    trainees = await L.q(`SELECT DISTINCT u.id, u.name, u.email FROM applications a JOIN users u ON u.id=a.user_id
      WHERE a.rpto_id=? AND a.status IN ('pending','accepted') ORDER BY u.name`, [id]);
  }
  const fk = fees.reduce((t, f) => {
    const due = f.amount - f.paid;
    t.billed += +f.amount; t.collected += +f.paid; t.outstanding += due;
    if (due > 0 && f.due_date && f.due_date < L.today()) { t.overdue += due; t.overdueCount++; }
    return t;
  }, { billed: 0, collected: 0, outstanding: 0, overdue: 0, overdueCount: 0 });
  if (req.query.export && tab === 'fees') return L.sendCsv(res, 'fees.csv', [['Trainee', 'Email', 'Batch', 'Description', 'Payable (incl. GST)', 'GST %', 'Paid', 'Balance', 'Due date', 'Receipts'],
    ...fees.map(f => [f.name, f.email, f.batch, f.description, f.amount, f.gst_percent, f.paid, f.amount - f.paid, f.due_date,
      payments.filter(p => p.fee_id === f.id).map(p => `${p.receipt_no} ${p.amount}`).join('; ')])]);
  if (req.query.export) return L.sendCsv(res, 'leads.csv', [['Name', 'Phone', 'Email', 'City', 'Source', 'Interested in', 'Status', 'Follow-up', 'Notes', 'Created'],
    ...leads.map(l => [l.name, l.phone, l.email, l.city, l.source, l.interest, l.status, l.follow_up, l.notes, l.created_at])]);
  const shareUrl = `${L.baseUrl(req)}/enquire/${id}`;
  res.render('rpto/crm', { tab, k, leads, fees, fk, trainees, batches, batch, payments, s, st, shareUrl });
});

r.post('/crm/leads', crm, async (req, res) => {
  const b = req.body;
  if (!b.name) { res.flash('Lead name is required.'); return res.redirect('/rpto/crm'); }
  await L.q('INSERT INTO leads (rpto_id,name,phone,email,city,source,interest,follow_up,notes) VALUES (?,?,?,?,?,?,?,?,?)',
    [rid(req), b.name, b.phone, b.email, b.city, L.LEAD_SOURCES.includes(b.source) ? b.source : 'Manual', b.interest, b.follow_up || null, b.notes]);
  await L.log(rid(req), `New lead: ${b.name}`);
  if (b.whatsapp && digits(b.phone)) {
    const msg = `Hi ${b.name}, thank you for your interest in drone pilot training at ${req.user.rpto.name}. How can we help you?`;
    return res.redirect(`https://wa.me/${digits(b.phone)}?text=${encodeURIComponent(msg)}`);
  }
  res.flash('Lead saved.');
  res.redirect('/rpto/crm');
});
r.post('/crm/leads/:id', crm, async (req, res) => {
  const b = req.body, status = ['new', 'contacted', 'interested', 'converted', 'lost'].includes(b.status) ? b.status : 'new';
  await L.q(`UPDATE leads SET status=?, follow_up=?, notes=?, converted_at=IF(?='converted', COALESCE(converted_at,NOW()), NULL)
    WHERE id=? AND rpto_id=?`, [status, b.follow_up || null, b.notes, status, req.params.id, rid(req)]);
  res.redirect(back(req, '/rpto/crm'));
});
r.post('/crm/leads/:id/delete', crm, async (req, res) => {
  await L.q('DELETE FROM leads WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  res.redirect('/rpto/crm');
});
// Convert a lead into a trainee account + pending application.
r.post('/crm/leads/:id/convert', crm, async (req, res) => {
  const lead = await L.one('SELECT * FROM leads WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  if (!lead) return notFound(res);
  const email = String(req.body.email || lead.email || '').trim().toLowerCase();
  if (!email) { res.flash('Add an email address to convert this lead into a trainee.'); return res.redirect('/rpto/crm'); }
  const r2 = await addTrainee(req, { name: lead.name, email, phone: lead.phone, batch_id: req.body.batch_id });
  if (r2.error) { res.flash(r2.error); return res.redirect('/rpto/crm'); }
  await L.q("UPDATE leads SET status='converted', converted_at=NOW(), email=? WHERE id=?", [email, lead.id]);
  res.flash(r2.message);
  res.redirect('/rpto/trainees/' + r2.userId);
});
r.post('/crm/import', crm, L.csvUpload.single('file'), async (req, res) => {
  if (!req.file) { res.flash('Choose a CSV file.'); return res.redirect('/rpto/crm'); }
  const rows = L.parseCsv(req.file.buffer.toString('utf8'));
  const cols = ['name', 'phone', 'email', 'city', 'source', 'interest', 'notes'];
  let map = cols;
  if (rows[0] && rows[0].some(c => /name/i.test(c))) map = rows.shift().map(h => cols.find(c => h.toLowerCase().includes(c === 'interest' ? 'interest' : c)) || null);
  let n = 0;
  for (const row of rows.slice(0, 5000)) {
    const o = {}; map.forEach((c, i) => { if (c) o[c] = (row[i] || '').trim(); });
    if (!o.name) continue;
    await L.q('INSERT INTO leads (rpto_id,name,phone,email,city,source,interest,notes) VALUES (?,?,?,?,?,?,?,?)',
      [rid(req), o.name.slice(0, 150), o.phone, o.email, o.city, L.LEAD_SOURCES.includes(o.source) ? o.source : 'Manual', o.interest, o.notes]);
    n++;
  }
  res.flash(`Imported ${n} lead(s).`);
  res.redirect('/rpto/crm');
});

// Set a batch's course fee + GST: updates the batch and every admitted trainee's course-fee row (payments are kept).
r.post('/crm/fees/batch/:id', crm, async (req, res) => {
  const b = await getBatch(req, req.params.id), fee = Math.max(0, +req.body.fee || 0), gst = Math.min(28, Math.max(0, +req.body.gst_percent || 0));
  if (!b) return notFound(res);
  await L.q('UPDATE batches SET fee=?, gst_percent=? WHERE id=?', [fee, gst, b.id]);
  const tr = await L.q("SELECT user_id FROM applications WHERE batch_id=? AND status='accepted'", [b.id]);
  for (const t of tr) await L.q(`INSERT INTO fees (rpto_id,user_id,batch_id,description,amount,gst_percent,due_date) VALUES (?,?,?,'Course fee',?,?,?)
    ON DUPLICATE KEY UPDATE amount=VALUES(amount), gst_percent=VALUES(gst_percent), due_date=COALESCE(VALUES(due_date), due_date)`,
    [rid(req), t.user_id, b.id, T.withGst(fee, gst), gst, req.body.due_date || null]);
  res.flash(`Course fee set: ${fee}${gst ? ` + ${gst}% GST` : ''} for ${tr.length} trainee(s).`);
  res.redirect('/rpto/crm?tab=fees&batch=' + b.id);
});
r.post('/crm/fees', crm, async (req, res) => {
  const b = req.body, gst = Math.min(28, Math.max(0, +b.gst_percent || 0));
  const ok = await L.one('SELECT 1 x FROM applications WHERE user_id=? AND rpto_id=?', [b.user_id, rid(req)]);
  if (!ok || !(+b.amount > 0)) { res.flash('Choose a trainee and a positive amount.'); return res.redirect('/rpto/crm?tab=fees'); }
  await L.q('INSERT INTO fees (rpto_id,user_id,batch_id,description,amount,gst_percent,due_date) VALUES (?,?,?,?,?,?,?)',
    [rid(req), b.user_id, b.batch_id || null, b.description || 'Other fee', T.withGst(+b.amount, gst), gst, b.due_date || null]);
  res.flash('Fee added.');
  res.redirect('/rpto/crm?tab=fees');
});
r.post('/crm/fees/:id/pay', crm, async (req, res) => {
  const f = await L.one('SELECT * FROM fees WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  const amt = Math.round((+req.body.amount || 0) * 100) / 100, go = () => res.redirect(`/rpto/crm?tab=fees&batch=${f?.batch_id || ''}`);
  if (!f) return notFound(res);
  if (!(amt > 0) || amt > f.amount - f.paid + 0.001) { res.flash(`Enter an amount between 0 and the balance (${(f.amount - f.paid).toFixed(2)}).`); return go(); }
  const receipt = `RCPT/${new Date().getFullYear()}/${String(await L.nextSeq('rptos', rid(req), 'receipt_seq')).padStart(5, '0')}`;
  const x = await L.q('INSERT INTO fee_payments (fee_id,rpto_id,amount,mode,reference,paid_on,receipt_no,created_by) VALUES (?,?,?,?,?,?,?,?)',
    [f.id, rid(req), amt, ['cash', 'upi', 'bank', 'card', 'cheque', 'other'].includes(req.body.mode) ? req.body.mode : 'upi', req.body.reference || null,
      /^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_on || '') ? req.body.paid_on : L.today(), receipt, req.user.id]);
  await L.q('UPDATE fees SET paid=(SELECT COALESCE(SUM(amount),0) FROM fee_payments WHERE fee_id=?), last_paid_at=NOW() WHERE id=?', [f.id, f.id]);
  res.flash(`Payment recorded — receipt ${receipt}.`);
  res.redirect('/rpto/receipts/' + x.insertId);
});
r.post('/crm/payments/:id/delete', admin, async (req, res) => {
  const p = await L.one('SELECT * FROM fee_payments WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  if (p) {
    await L.q('DELETE FROM fee_payments WHERE id=?', [p.id]);
    await L.q('UPDATE fees SET paid=(SELECT COALESCE(SUM(amount),0) FROM fee_payments WHERE fee_id=?) WHERE id=?', [p.fee_id, p.fee_id]);
    res.flash(`Payment ${p.receipt_no} deleted.`);
  }
  res.redirect(back(req, '/rpto/crm?tab=fees'));
});
r.post('/crm/fees/:id/delete', admin, async (req, res) => {
  await L.q('DELETE FROM fees WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  res.redirect(back(req, '/rpto/crm?tab=fees'));
});
r.get('/receipts/:id', crm, async (req, res) => {
  const d = await T.receiptData(req.params.id, { rptoId: rid(req) });
  d ? res.render('receipt', d) : notFound(res);
});

// ================= ADMISSIONS =================
async function addTrainee(req, b) {
  const email = String(b.email || '').trim().toLowerCase();
  if (!b.name || !email) return { error: 'Name and email are required.' };
  let u = await L.one('SELECT id, role FROM users WHERE email=?', [email]), message;
  if (u && u.role !== 'student') return { error: 'That email belongs to a staff/admin account.' };
  if (b.batch_id && !(await L.one('SELECT id FROM batches WHERE id=? AND rpto_id=?', [b.batch_id, rid(req)]))) return { error: 'Invalid batch.' };
  if (u && await L.one("SELECT id FROM applications WHERE user_id=? AND rpto_id=? AND status IN ('pending','accepted')", [u.id, rid(req)]))
    return { error: 'This trainee already has an active application with you.' };
  if (!u) {
    const pw = b.password || L.randomPassword();
    const x = await L.q("INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'student')", [b.name, email, b.phone, L.hashPassword(pw)]);
    u = { id: x.insertId };
    message = await L.credentialsMessage(req, { id: u.id, email, name: b.name }, pw, 'Trainee');
  } else message = 'Existing student account linked and application created.';
  await L.q('INSERT INTO applications (rpto_id,batch_id,user_id) VALUES (?,?,?)', [rid(req), b.batch_id || null, u.id]);
  await L.log(rid(req), `${b.name} applied${b.batch_id ? '' : ' (no batch yet)'}`);
  return { userId: u.id, message };
}

r.get('/admissions', admin, async (req, res) => {
  const id = rid(req), { status = '', batch = '', docs = '', s = '' } = req.query, like = `%${s}%`;
  const base = `SELECT a.*, u.name, u.email, u.phone, u.dob, b.title batch_title,
      (SELECT COUNT(*) FROM trainee_documents d WHERE d.user_id=u.id AND d.status='verified' AND LEFT(d.doc_type, 6) <> 'other_') docs_ok
    FROM applications a JOIN users u ON u.id=a.user_id LEFT JOIN batches b ON b.id=a.batch_id WHERE a.rpto_id=?`;
  const pending = await L.q(base + " AND a.status='pending' ORDER BY a.applied_at", [id]);
  const all = await L.q(base + ` AND a.status<>'pending' AND (?='' OR a.status=?) AND (?='' OR a.batch_id=?)
    AND (?='' OR u.name LIKE ? OR u.email LIKE ?) ORDER BY a.decided_at DESC`, [id, status, status, batch, batch, s, like, like]);
  const registry = docs ? all.filter(a => docs === 'complete' ? a.docs_ok >= DOCN : a.docs_ok < DOCN) : all;
  const total = (await L.one("SELECT COUNT(*) n FROM applications WHERE rpto_id=? AND status<>'pending'", [id])).n;
  if (req.query.export) return L.sendCsv(res, 'admissions.csv', [['Applicant', 'Email', 'Phone', 'Batch', 'Roll no', 'Status', 'Documents verified', 'Applied', 'Decided', 'Reason', 'Certificate', 'RPC'],
    ...registry.map(a => [a.name, a.email, a.phone, a.batch_title, a.roll_no, a.status, `${a.docs_ok}/${DOCN}`, a.applied_at, a.decided_at, a.reason, a.cert_no, a.rpc_no])]);
  const users = [...pending, ...registry].map(a => a.user_id);
  const docRows = users.length ? await L.q('SELECT user_id, doc_type, status FROM trainee_documents WHERE user_id IN (?)', [users]) : [];
  const docMap = {};
  for (const d of docRows) (docMap[d.user_id] ||= {})[d.doc_type] = d.status;
  const batches = await L.q(`SELECT b.id, b.title, b.seats, (SELECT COUNT(*) FROM applications a WHERE a.batch_id=b.id AND a.status='accepted') taken
    FROM batches b WHERE b.rpto_id=? AND b.status IN ('planned','active') ORDER BY b.title`, [id]);
  res.render('rpto/admissions', { pending, registry, total, docMap, batches, status, batch, docs, s, DOCN });
});

r.post('/admissions/add', admin, async (req, res) => {
  const x = await addTrainee(req, req.body);
  res.flash(x.error || x.message);
  res.redirect(x.error ? '/rpto/admissions' : '/rpto/trainees/' + x.userId);
});

const getApp = (req, id) => L.one(`SELECT a.*, u.name, u.email, u.dob FROM applications a JOIN users u ON u.id=a.user_id
  WHERE a.id=? AND a.rpto_id=?`, [id, rid(req)]);
const age = dob => dob ? Math.floor((Date.now() - new Date(dob + 'T00:00:00')) / 31557600000) : null;

r.post('/applications/:id/decide', admin, async (req, res) => {
  const a = await getApp(req, req.params.id), go = () => res.redirect(back(req, '/rpto/admissions'));
  if (!a || a.status !== 'pending') return go();
  if (req.body.decision === 'reject') {
    await L.q("UPDATE applications SET status='rejected', reason=?, decided_at=NOW() WHERE id=?", [req.body.reason || null, a.id]);
    await L.log(rid(req), `${a.name}'s application rejected`);
    L.sendMail(a.email, `Your application to ${req.user.rpto.name}`, `Hi ${a.name},\n\nYour application was not accepted${req.body.reason ? ': ' + req.body.reason : '.'}\nYou can log in to see details: ${L.baseUrl(req)}/login`);
    res.flash('Application rejected.');
    return go();
  }
  const batch = await L.one('SELECT * FROM batches WHERE id=? AND rpto_id=?', [req.body.batch_id || a.batch_id, rid(req)]);
  const docsOk = (await L.one("SELECT COUNT(*) n FROM trainee_documents WHERE user_id=? AND status='verified' AND LEFT(doc_type, 6) <> 'other_'", [a.user_id])).n;
  const taken = batch && (await L.one("SELECT COUNT(*) n FROM applications WHERE batch_id=? AND status='accepted'", [batch.id])).n;
  const years = age(a.dob);
  const err = !batch ? 'Choose a batch to admit the trainee into.'
    : docsOk < DOCN ? `All ${DOCN} documents must be verified before admission (${docsOk}/${DOCN} verified).`
    : years !== null && (years < 18 || years > 65) ? `Trainee must be 18–65 years old (age ${years}).`
    : taken >= batch.seats ? `${batch.title} is full (${batch.seats} seats).` : null;
  if (err) { res.flash(err); return go(); }
  const rpto = await L.one('SELECT * FROM rptos WHERE id=?', [rid(req)]);
  const roll = await T.nextRollNo(rpto, batch);
  await L.q("UPDATE applications SET status='accepted', batch_id=?, roll_no=?, reason=NULL, decided_at=NOW() WHERE id=?", [batch.id, roll, a.id]);
  if (batch.fee > 0) await L.q(`INSERT IGNORE INTO fees (rpto_id,user_id,batch_id,description,amount,gst_percent) VALUES (?,?,?,'Course fee',?,?)`,
    [rid(req), a.user_id, batch.id, T.withGst(+batch.fee, batch.gst_percent), batch.gst_percent || 0]);
  await L.log(rid(req), `${a.name} admitted to ${batch.title}`);
  L.sendMail(a.email, `Admitted to ${batch.title}`, `Hi ${a.name},\n\nYou have been admitted to ${batch.title} at ${req.user.rpto.name}. Your roll number is ${roll}.\nSee your schedule: ${L.baseUrl(req)}/student`);
  res.flash(`${a.name} admitted — roll no. ${roll}.`);
  go();
});
r.post('/applications/:id/cancel', admin, async (req, res) => {
  await L.q("UPDATE applications SET status='cancelled', reason=?, decided_at=NOW() WHERE id=? AND rpto_id=? AND status IN ('pending','accepted') AND cert_no IS NULL",
    [req.body.reason || 'Cancelled by RPTO', req.params.id, rid(req)]);
  res.flash('Admission cancelled.');
  res.redirect(back(req, '/rpto/admissions'));
});

// ---- Trainee profile + document verification ----
async function traineeInRpto(req, uid) {
  return L.one(`SELECT u.* FROM users u WHERE u.id=? AND u.role='student'
    AND EXISTS (SELECT 1 FROM applications a WHERE a.user_id=u.id AND a.rpto_id=?)`, [uid, rid(req)]);
}
r.get('/trainees/:uid', train, async (req, res) => {
  const t = await traineeInRpto(req, req.params.uid);
  if (!t) return notFound(res);
  const apps = await L.q(`SELECT a.*, b.title batch_title, b.records_locked FROM applications a LEFT JOIN batches b ON b.id=a.batch_id
    WHERE a.user_id=? AND a.rpto_id=? ORDER BY a.applied_at DESC`, [t.id, rid(req)]);
  const docs = Object.fromEntries((await L.q('SELECT * FROM trainee_documents WHERE user_id=?', [t.id])).map(d => [d.doc_type, d]));
  const active = apps.find(a => a.status === 'accepted');
  const progress = active ? (await T.batchProgress(active.batch_id)).trainees.find(x => x.id === t.id) : null;
  const flights = await L.q(`SELECT f.*, r.name rpas FROM flight_logs f LEFT JOIN assets r ON r.id=f.rpas_id
    WHERE f.pilot_id=? AND f.rpto_id=? ORDER BY f.date DESC, f.time DESC`, [t.id, rid(req)]);
  const fees = await L.q('SELECT * FROM fees WHERE user_id=? AND rpto_id=?', [t.id, rid(req)]);
  const batches = await L.q("SELECT id,title FROM batches WHERE rpto_id=? AND status IN ('planned','active')", [rid(req)]);
  res.render('rpto/trainee', { t, apps, docs, active, progress, flights, fees, batches, DOCN });
});
r.post('/trainees/:uid/documents/:type', admin, L.upload.single('file'), async (req, res) => {
  const t = await traineeInRpto(req, req.params.uid), type = req.params.type;
  const other = type.startsWith('other_') && await L.one('SELECT label FROM trainee_documents WHERE user_id=? AND doc_type=?', [t?.id, type]);
  if (!t || !(L.TRAINEE_DOCS[type] || other) || !req.file) { removeFile(req.file?.filename); res.flash('Upload a PDF/JPG/PNG file.'); return res.redirect(back(req, '/rpto/admissions')); }
  await saveTraineeDoc(t.id, type, req.file, 'verified');
  res.flash(`${L.TRAINEE_DOCS[type] || other.label} uploaded and marked verified.`);
  res.redirect('/rpto/trainees/' + t.id);
});
r.post('/trainees/:uid/documents/:type/review', admin, async (req, res) => {
  const t = await traineeInRpto(req, req.params.uid);
  const status = req.body.status === 'verified' ? 'verified' : 'rejected';
  if (t) await L.q('UPDATE trainee_documents SET status=?, note=? WHERE user_id=? AND doc_type=?', [status, req.body.note || null, t.id, req.params.type]);
  res.redirect(back(req, '/rpto/admissions'));
});
async function saveTraineeDoc(userId, type, file, status) {
  const old = await L.one('SELECT file FROM trainee_documents WHERE user_id=? AND doc_type=?', [userId, type]);
  if (old) removeFile(old.file);
  await L.q(`INSERT INTO trainee_documents (user_id,doc_type,file,original_name,status) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE file=VALUES(file), original_name=VALUES(original_name), status=VALUES(status), note=NULL, uploaded_at=NOW()`,
    [userId, type, file.filename, file.originalname, status]);
}

// ---- Certificates, RPC, records package ----
r.post('/applications/:id/certify', admin, async (req, res) => {
  const a = await getApp(req, req.params.id);
  if (!a || a.status !== 'accepted' || a.cert_no) return res.redirect(back(req, '/rpto/batches'));
  const p = (await T.batchProgress(a.batch_id)).trainees.find(x => x.app_id === a.id);
  if (!p?.eligible) { res.flash('Not eligible yet: all training sessions must be attended and every test passed.'); return res.redirect(back(req, '/rpto/batches')); }
  const rpto = await L.one('SELECT cert_prefix FROM rptos WHERE id=?', [rid(req)]);
  const b = await L.one('SELECT batch_no FROM batches WHERE id=?', [a.batch_id]);
  const seq = await L.nextSeq('rptos', rid(req), 'cert_seq'); // atomic: two admins certifying at once never share a number
  const certNo = `${rpto.cert_prefix || 'CERT'}/${b.batch_no || a.batch_id}/${String(seq).padStart(4, '0')}`;
  // Claim the certificate first (guards double-clicks), then take a completion credit; undo the claim if none are left.
  const claim = await L.q('UPDATE applications SET cert_no=?, cert_issued_at=NOW() WHERE id=? AND cert_no IS NULL', [certNo, a.id]);
  if (!claim.affectedRows) return res.redirect(back(req, '/rpto/batches/' + a.batch_id));
  const credit = await T.useCompletionCredit(rid(req), a, req.user.id);
  if (!credit.ok) {
    await L.q('UPDATE applications SET cert_no=NULL, cert_issued_at=NULL WHERE id=?', [a.id]);
    res.flash('No completion credits left. Buy credits under Billing (trainees with Pilot Pro are certified free).');
    return res.redirect(back(req, '/rpto/batches/' + a.batch_id));
  }
  await L.log(rid(req), `Certificate ${certNo} issued to ${a.name}${credit.free ? '' : ' (1 credit used)'}`);
  L.sendMail(a.email, 'Your course certificate is ready', `Hi ${a.name},\n\nCongratulations! Certificate ${certNo} has been issued by ${req.user.rpto.name}.\nDownload it: ${L.baseUrl(req)}/student`);
  res.flash(`Certificate ${certNo} issued.`);
  res.redirect(back(req, '/rpto/batches/' + a.batch_id));
});
r.post('/applications/:id/rpc', admin, async (req, res) => {
  const a = await getApp(req, req.params.id);
  if (a?.cert_no && req.body.rpc_no) {
    await L.q('UPDATE applications SET rpc_no=?, rpc_issued_at=? WHERE id=?', [req.body.rpc_no, req.body.rpc_date || L.today(), a.id]);
    // Personal KYC documents are no longer needed once the RPC is issued — delete the files, keep a 'purged' marker.
    const docs = await L.q('SELECT file FROM trainee_documents WHERE user_id=? AND file IS NOT NULL', [a.user_id]);
    await L.q("UPDATE trainee_documents SET file=NULL, status='purged', note=? WHERE user_id=? AND file IS NOT NULL", [`Deleted after RPC ${req.body.rpc_no}`, a.user_id]);
    docs.forEach(d => removeFile(d.file));
    await L.log(rid(req), `RPC ${req.body.rpc_no} recorded for ${a.name}; ${docs.length} trainee document(s) purged`);
    res.flash(`RPC recorded. ${docs.length} trainee document file(s) were deleted as they are no longer needed.`);
  } else res.flash('Issue the course certificate first, then record the RPC number.');
  res.redirect(back(req, '/rpto/admissions'));
});

const recordData = (req, appId) => T.recordData(appId, { rptoId: rid(req) });
r.get('/applications/:id/record', train, async (req, res) => {
  const d = await recordData(req, req.params.id);
  d ? res.render('record', d) : notFound(res);
});
r.get('/applications/:id/certificate', train, async (req, res) => {
  const d = await recordData(req, req.params.id);
  if (!d?.a.cert_no) return notFound(res);
  res.render('certificate', d);
});
// Submission package: training record + certificate + trainee documents in one ZIP.
r.get('/applications/:id/package.zip', admin, async (req, res) => {
  const d = await recordData(req, req.params.id);
  if (!d) return notFound(res);
  const render = (view, extra = {}) => new Promise((ok, fail) => res.app.render(view, { ...res.locals, ...d, ...extra }, (e, html) => e ? fail(e) : ok(html)));
  const files = [{ name: '01_training_record.html', data: Buffer.from(await render('record')) }];
  if (d.a.cert_no) files.push({ name: '02_course_certificate.html', data: Buffer.from(await render('certificate')) });
  for (const doc of d.docs) {
    if (!doc.file) continue; // purged after the RPC was recorded
    const p = path.join(L.UPLOAD_DIR, path.basename(doc.file));
    if (fs.existsSync(p)) files.push({ name: `documents/${doc.doc_type}${path.extname(doc.file)}`, data: fs.readFileSync(p) });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${(d.a.roll_no || 'trainee-' + d.a.id).replace(/[^\w.-]+/g, '_')}.zip"`);
  res.send(L.zip(files));
});

// ================= BATCHES =================
const getBatch = (req, id) => L.one('SELECT * FROM batches WHERE id=? AND rpto_id=?', [id, rid(req)]);
async function batchFormData(req) {
  const instructors = await L.q(`SELECT DISTINCT u.id, u.name, MAX(m.dgca_cert IS NOT NULL) certified FROM members m JOIN users u ON u.id=m.user_id
    WHERE m.rpto_id=? AND m.role='Instructor' AND u.active=1 GROUP BY u.id, u.name ORDER BY u.name`, [rid(req)]);
  const assets = await L.q("SELECT * FROM assets WHERE rpto_id=? AND status='in_service' ORDER BY type, name", [rid(req)]);
  return { instructors, assets };
}
async function saveBatch(req, id) {
  const b = req.body;
  const vals = [b.title, b.certificate, b.rpas_category, b.rpas_class, b.batch_no, b.delivery === 'hybrid' ? 'hybrid' : 'onsite',
    b.start_date || null, b.end_date || null, Math.max(1, +b.seats || 1), Math.max(0, +b.fee || 0), Math.min(28, Math.max(0, +b.gst_percent || 0))];
  if (id) await L.q(`UPDATE batches SET title=?, certificate=?, rpas_category=?, rpas_class=?, batch_no=?, delivery=?, start_date=?, end_date=?, seats=?, fee=?, gst_percent=?
    WHERE id=? AND rpto_id=?`, [...vals, id, rid(req)]);
  else id = (await L.q(`INSERT INTO batches (title,certificate,rpas_category,rpas_class,batch_no,delivery,start_date,end_date,seats,fee,gst_percent,rpto_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [...vals, rid(req)])).insertId;
  const { instructors, assets } = await batchFormData(req);
  const inst = arr(b.instructors).map(Number).filter(i => instructors.some(x => x.id === i && x.certified));
  const ast = arr(b.assets).map(Number).filter(i => assets.some(x => x.id === i));
  await L.q('DELETE FROM batch_resources WHERE batch_id=?', [id]);
  const rows = [...inst.map(i => [id, 'instructor', i]), ...ast.map(i => [id, 'asset', i])];
  if (rows.length) await L.q('INSERT INTO batch_resources (batch_id,kind,ref_id) VALUES ?', [rows]);
  return id;
}
r.get('/batches', train, async (req, res) => {
  const id = rid(req);
  const batches = await L.q(`SELECT b.*, (SELECT COUNT(*) FROM applications a WHERE a.batch_id=b.id AND a.status='accepted') admitted,
      (SELECT COUNT(*) FROM sessions s WHERE s.batch_id=b.id AND s.status='done') done,
      (SELECT COUNT(*) FROM sessions s WHERE s.batch_id=b.id AND s.status<>'cancelled') total,
      (SELECT COUNT(*) FROM sessions s WHERE s.batch_id=b.id AND s.type IN ('theory','workshop') AND s.status<>'cancelled') ground,
      (SELECT COUNT(*) FROM sessions s WHERE s.batch_id=b.id AND s.type IN ('simulator','flying') AND s.status<>'cancelled') practical
    FROM batches b WHERE b.rpto_id=? ORDER BY b.created_at DESC`, [id]);
  const unmarked = req.query.attendance === 'unmarked' ? await L.q(`SELECT s.*, b.title batch FROM sessions s JOIN batches b ON b.id=s.batch_id
    WHERE b.rpto_id=? AND s.status='scheduled' AND s.date<CURDATE() ORDER BY s.date, s.start_time`, [id]) : null;
  res.render('rpto/batches', { batches, unmarked, min: await T.minimums(id), view: req.query.view === 'list' ? 'list' : 'grid' });
});
r.get('/batches/new', admin, async (req, res) => res.render('rpto/batch-form', { b: { seats: 10, delivery: 'onsite' }, sel: [], ...(await batchFormData(req)), min: await T.minimums(rid(req)) }));
r.post('/batches', admin, async (req, res) => {
  if (!req.body.title) { res.flash('Title is required.'); return res.redirect('/rpto/batches/new'); }
  const id = await saveBatch(req);
  await L.log(rid(req), `Batch ${req.body.title} created`);
  res.flash('Batch created. Use “Auto schedule” to generate the timetable.');
  res.redirect('/rpto/batches/' + id);
});
r.get('/batches/:id/edit', admin, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (!b) return notFound(res);
  const sel = (await L.q('SELECT kind, ref_id FROM batch_resources WHERE batch_id=?', [b.id])).map(x => x.kind + x.ref_id);
  res.render('rpto/batch-form', { b, sel, ...(await batchFormData(req)), min: await T.minimums(rid(req)) });
});
r.post('/batches/:id/edit', admin, async (req, res) => {
  if (!(await getBatch(req, req.params.id))) return notFound(res);
  await saveBatch(req, req.params.id);
  res.flash('Batch updated.');
  res.redirect('/rpto/batches/' + req.params.id);
});
r.post('/batches/:id/status', admin, async (req, res) => {
  const st = ['planned', 'active', 'completed', 'cancelled'].find(s => s === req.body.status);
  if (st) await L.q('UPDATE batches SET status=? WHERE id=? AND rpto_id=?', [st, req.params.id, rid(req)]);
  res.redirect('/rpto/batches/' + req.params.id);
});
r.post('/batches/:id/accepting', admin, async (req, res) => {
  await L.q('UPDATE batches SET accepting=1-accepting WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  res.redirect('/rpto/batches/' + req.params.id);
});
r.post('/batches/:id/lock', admin, async (req, res) => {
  await L.q('UPDATE batches SET records_locked=1-records_locked WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  res.redirect('/rpto/batches/' + req.params.id);
});
r.post('/batches/:id/schedule', admin, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (!b) return notFound(res);
  if (b.records_locked) { res.flash('Records are locked for this batch.'); return res.redirect('/rpto/batches/' + b.id); }
  const r2 = await T.autoSchedule(b.id);
  res.flash(`Timetable generated: ${r2.count} session(s) scheduled. Completed sessions were kept.` +
    (r2.trainees ? '' : ' No trainees are admitted yet — admit them and run Auto schedule again to add their simulator and flying slots.'));
  res.redirect('/rpto/batches/' + b.id);
});
// Practical progress slider: mark a trainee's simulator/flying slots done up to the chosen one.
r.post('/batches/:id/progress', train, async (req, res) => {
  const b = await getBatch(req, req.params.id), type = req.body.type === 'simulator' ? 'simulator' : 'flying';
  const go = () => res.redirect(`/rpto/batches/${req.params.id}?tab=${type}&trainee=${req.body.trainee_id || ''}`);
  if (!b) return notFound(res);
  if (b.records_locked) { res.flash('Records are locked for this batch.'); return go(); }
  const ok = await L.one("SELECT 1 x FROM applications WHERE batch_id=? AND user_id=? AND status='accepted'", [b.id, req.body.trainee_id]);
  if (!ok) return go();
  const x = await T.setPracticalProgress(b, +req.body.trainee_id, type, req.body.upto || 'none', req.user.id);
  res.flash(x.error || `${x.done}/${x.total} ${type} slots done.`);
  go();
});
// Shared ground classes: mark every past/today theory+workshop session done with all trainees present.
r.post('/batches/:id/ground-done', train, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (!b || b.records_locked) return res.redirect('/rpto/batches/' + req.params.id);
  const ss = await L.q("SELECT id FROM sessions WHERE batch_id=? AND trainee_id IS NULL AND type IN ('theory','workshop') AND status='scheduled' AND date<=CURDATE()", [b.id]);
  const tr = await L.q("SELECT user_id FROM applications WHERE batch_id=? AND status='accepted'", [b.id]);
  for (const s of ss) {
    if (tr.length) await L.q('INSERT IGNORE INTO attendance (session_id,user_id,present,assessment,marked_by) VALUES ?', [tr.map(t => [s.id, t.user_id, 1, 'pass', req.user.id])]);
    await L.q("UPDATE sessions SET status='done' WHERE id=?", [s.id]);
  }
  res.flash(`${ss.length} ground class(es) marked done.`);
  res.redirect('/rpto/batches/' + b.id);
});
r.post('/batches/:id/ground-reopen', admin, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (b && !b.records_locked) await L.q("UPDATE sessions SET status='scheduled' WHERE batch_id=? AND trainee_id IS NULL AND type IN ('theory','workshop') AND status='done'", [b.id]);
  res.redirect('/rpto/batches/' + req.params.id);
});

r.get('/batches/:id', train, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (!b) return notFound(res);
  const tab = ['theory', 'simulator', 'flying', 'tests'].includes(req.query.tab) ? req.query.tab : 'theory';
  const { trainees, tests } = await T.batchProgress(b.id);
  const shared = await L.q(`SELECT s.*, u.name instructor, a.name asset,
      (SELECT COUNT(*) FROM attendance t WHERE t.session_id=s.id AND t.present=1) present
    FROM sessions s LEFT JOIN users u ON u.id=s.instructor_id LEFT JOIN assets a ON a.id=s.asset_id
    WHERE s.batch_id=? AND s.trainee_id IS NULL ORDER BY s.date, s.start_time`, [b.id]);
  // A trainee's own simulator / flying slots with their flight-log state.
  const practical = await L.q(`SELECT s.*, u.name instructor, a.name asset, tr.name trainee, f.id log_id, f.track_id, f.minutes log_minutes
    FROM sessions s JOIN users tr ON tr.id=s.trainee_id LEFT JOIN users u ON u.id=s.instructor_id LEFT JOIN assets a ON a.id=s.asset_id
    LEFT JOIN flight_logs f ON f.session_id=s.id WHERE s.batch_id=? AND s.trainee_id IS NOT NULL AND s.status<>'cancelled'
    ORDER BY s.date, s.start_time, s.id`, [b.id]);
  const resources = await L.q(`SELECT r.kind, COALESCE(u.name, a.name) name, a.type, a.uin, a.serial_no, a.quantity FROM batch_resources r
    LEFT JOIN users u ON r.kind='instructor' AND u.id=r.ref_id LEFT JOIN assets a ON r.kind='asset' AND a.id=r.ref_id WHERE r.batch_id=?`, [b.id]);
  const testStats = await L.q(`SELECT t.*, COUNT(r.user_id) taken, COALESCE(SUM(r.passed),0) passed FROM tests t
    LEFT JOIN test_results r ON r.test_id=t.id AND r.passed IS NOT NULL WHERE t.batch_id=? GROUP BY t.id`, [b.id]);
  const results = await L.q(`SELECT r.* FROM test_results r JOIN tests t ON t.id=r.test_id WHERE t.batch_id=?`, [b.id]);
  const traineeTracks = trainees.length ? await L.q(`SELECT id, user_id, original_name, started_at, created_at, duration_s FROM tracks
    WHERE user_id IN (?) ORDER BY COALESCE(started_at, created_at) DESC`, [trainees.map(t => t.id)]) : [];
  const syllabus = await T.syllabusFor(b.rpto_id);
  const doneCodes = new Set((await L.q("SELECT DISTINCT code FROM sessions WHERE batch_id=? AND status='done' AND code IS NOT NULL", [b.id])).map(x => x.code));
  const { instructors, assets } = await batchFormData(req);
  const pick = trainees.find(t => String(t.id) === String(req.query.trainee)) || trainees[0] || null;
  res.render('rpto/batch', { b, tab, trainees, pick, by: req.query.by === 'time' ? 'time' : 'trainee', tests: testStats, results, shared, practical,
    resources, instructors, assets, syllabus, doneCodes, traineeTracks, showSyllabus: req.query.syllabus === '1' });
});
r.get('/batches/:id/attendance.csv', train, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (!b) return notFound(res);
  const ss = await L.q("SELECT id, date, start_time, title FROM sessions WHERE batch_id=? AND trainee_id IS NULL AND status<>'cancelled' ORDER BY date, start_time", [b.id]);
  const { trainees: tr } = await T.batchProgress(b.id);
  const at = await L.q('SELECT t.session_id, t.user_id, t.present FROM attendance t JOIN sessions s ON s.id=t.session_id WHERE s.batch_id=?', [b.id]);
  const mark = (s, u) => { const x = at.find(a => a.session_id === s && a.user_id === u); return x ? (x.present ? 'P' : 'A') : ''; };
  L.sendCsv(res, `attendance-${b.title}.csv`.replace(/[^\w.-]+/g, '_'), [
    ['Roll no', 'Trainee', ...ss.map(s => `${s.date} ${String(s.start_time).slice(0, 5)} ${s.title}`), 'Simulator slots', 'Flying slots', 'Signature'],
    ...tr.map(t => [t.roll_no, t.name, ...ss.map(s => mark(s.id, t.id)), `${t.sim.done}/${t.sim.total}`, `${t.fly.done}/${t.fly.total}`, '']),
  ]);
});
r.get('/batches/:id/allocation.csv', train, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (!b) return notFound(res);
  const ss = await L.q(`SELECT s.date, s.start_time, s.end_time, s.type, s.code, s.title, tr.name trainee, u.name instructor, a.name asset, s.status, s.notes
    FROM sessions s LEFT JOIN users u ON u.id=s.instructor_id LEFT JOIN assets a ON a.id=s.asset_id LEFT JOIN users tr ON tr.id=s.trainee_id
    WHERE s.batch_id=? ORDER BY s.date, s.start_time`, [b.id]);
  L.sendCsv(res, `allocation-${b.title}.csv`.replace(/[^\w.-]+/g, '_'), [['Date', 'Start', 'End', 'Type', 'Code', 'Session', 'Trainee', 'Instructor', 'Resource', 'Status', 'Notes'],
    ...ss.map(s => [s.date, s.start_time, s.end_time, s.type, s.code, s.title, s.trainee || 'All trainees', s.instructor, s.asset, s.status, s.notes])]);
});
r.post('/batches/:id/sessions', train, async (req, res) => {
  const b = await getBatch(req, req.params.id), x = req.body;
  if (!b || b.records_locked || !x.title || !x.date) { res.flash('Title and date are required (and records must be unlocked).'); return res.redirect('/rpto/batches/' + req.params.id); }
  const type = ['theory', 'workshop', 'simulator', 'flying', 'test'].includes(x.type) ? x.type : 'theory';
  const trainee = x.trainee_id && ['simulator', 'flying'].includes(type)
    ? (await L.one("SELECT user_id FROM applications WHERE batch_id=? AND user_id=? AND status='accepted'", [b.id, x.trainee_id]))?.user_id : null;
  await L.q('INSERT INTO sessions (batch_id,trainee_id,code,type,title,date,start_time,end_time,instructor_id,asset_id,needs_log,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [b.id, trainee || null, x.code || null, type, x.title, x.date, x.start_time || null, x.end_time || null, x.instructor_id || null, x.asset_id || null,
      type === 'flying' && trainee ? 1 : 0, x.notes || null]);
  res.flash('Session added.');
  res.redirect(`/rpto/batches/${b.id}?tab=${trainee ? type : 'theory'}`);
});
// ---- Timeline: drag sessions to move / resize them ----
r.get('/batches/:id/timeline', train, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  if (!b) return notFound(res);
  const view = ['day', 'week', 'month'].includes(req.query.view) ? req.query.view : 'day';
  const range = await L.one("SELECT MIN(date) first, MAX(date) last FROM sessions WHERE batch_id=? AND status<>'cancelled'", [b.id]);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : (range.first && L.today() < range.first ? range.first : L.today());
  const trainees = await L.q("SELECT u.id, u.name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.batch_id=? AND a.status='accepted' ORDER BY u.name", [b.id]);
  const sessions = await L.q(`SELECT s.id, s.date, s.start_time, s.end_time, s.type, s.code, s.title, s.status, s.trainee_id, s.asset_id, a.name asset, u.name instructor
    FROM sessions s LEFT JOIN assets a ON a.id=s.asset_id LEFT JOIN users u ON u.id=s.instructor_id
    WHERE s.batch_id=? AND s.status<>'cancelled' ORDER BY s.date, s.start_time`, [b.id]);
  res.render('rpto/timeline', { b, view, date, trainees, sessions, range });
});
r.post('/sessions/:id/move', train, async (req, res) => {
  const x = req.body, start = parseInt(x.start), end = parseInt(x.end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date || '') || !Number.isFinite(start) || !Number.isFinite(end)) return res.status(400).json({ error: 'Bad move.' });
  const r2 = await T.moveSession(+req.params.id, rid(req), { date: x.date, start, end });
  res.status(r2.error ? 409 : 200).json(r2);
});
// Undo: put the sessions a move changed back where they were.
r.post('/batches/:id/timeline/restore', train, async (req, res) => {
  const b = await getBatch(req, req.params.id);
  let list = [];
  try { list = JSON.parse(req.body.changes || '[]'); } catch { /* ignored */ }
  if (!b || b.records_locked || !Array.isArray(list)) return res.status(400).json({ error: 'Cannot undo.' });
  for (const c of list.slice(0, 200)) {
    if (!c.old || !/^\d{4}-\d{2}-\d{2}$/.test(c.old.date)) continue;
    await L.q('UPDATE sessions SET date=?, start_time=?, end_time=? WHERE id=? AND batch_id=?', [c.old.date, T.hhmm(+c.old.start), T.hhmm(+c.old.end), +c.id, b.id]);
  }
  res.json({ ok: true });
});
r.post('/batches/:id/gap', train, async (req, res) => {
  const gap = Math.min(60, Math.max(0, parseInt(req.body.gap) || 0));
  await L.q('UPDATE batches SET slot_gap_min=? WHERE id=? AND rpto_id=?', [gap, req.params.id, rid(req)]);
  res.json({ gap });
});
r.post('/batches/:id/tests', admin, async (req, res) => {
  const b = await getBatch(req, req.params.id), x = req.body;
  if (b && x.title) await L.q('INSERT INTO tests (batch_id,title,type,question_count,pass_percent,duration_min) VALUES (?,?,?,?,?,?)',
    [b.id, x.title, ['theory', 'practical', 'simulator'].includes(x.type) ? x.type : 'theory', +x.question_count || 20, +x.pass_percent || 70, +x.duration_min || 30]);
  res.redirect('/rpto/batches/' + req.params.id + '#tests');
});

// ================= SESSIONS & ATTENDANCE =================
const getSession = (req, id) => L.one(`SELECT s.*, b.title batch_title, b.records_locked, b.id batch_id FROM sessions s
  JOIN batches b ON b.id=s.batch_id WHERE s.id=? AND b.rpto_id=?`, [id, rid(req)]);
r.get('/sessions/:id', train, async (req, res) => {
  const s = await getSession(req, req.params.id);
  if (!s) return notFound(res);
  const trainees = await L.q(`SELECT u.id, u.name, a.roll_no, t.present, t.assessment, t.remarks, f.minutes, f.battery_id, f.place, f.track_id
    FROM applications a JOIN users u ON u.id=a.user_id LEFT JOIN attendance t ON t.session_id=? AND t.user_id=u.id
    LEFT JOIN flight_logs f ON f.session_id=? AND f.pilot_id=u.id
    WHERE a.batch_id=? AND a.status='accepted' AND (? IS NULL OR u.id=?) ORDER BY u.name`, [s.id, s.id, s.batch_id, s.trainee_id, s.trainee_id]);
  // Each trainee's uploaded logs that are free to attach (not already part of another training flight).
  const tracks = trainees.length ? await L.q(`SELECT t.id, t.user_id, t.original_name, t.started_at, t.created_at, t.duration_s FROM tracks t
    WHERE t.user_id IN (?) AND NOT EXISTS (SELECT 1 FROM flight_logs f WHERE f.track_id=t.id AND NOT (f.session_id=? AND f.pilot_id=t.user_id))
    ORDER BY COALESCE(t.started_at, t.created_at) DESC`, [trainees.map(t => t.id), s.id]) : [];
  const { instructors, assets } = await batchFormData(req);
  res.render('rpto/session', { s, trainees, tracks, instructors, assets });
});
// Upload a trainee's flight log straight into this flying session.
// Upload a trainee's flight log into a flying session (per-trainee slots: only once the slot is done).
// Used by the session page, the Flying tab's "Choose file" and the log-folder rail (which asks for JSON).
r.post('/sessions/:id/track', train, L.logUpload.single('file'), async (req, res) => {
  const s = await getSession(req, req.params.id), json = req.query.json === '1';
  const back2 = s && s.trainee_id ? `/rpto/batches/${s.batch_id}?tab=flying&trainee=${s.trainee_id}` : '/rpto/sessions/' + req.params.id;
  const fail = msg => { if (req.file) fs.unlink(req.file.path, () => {}); if (json) return res.status(400).json({ error: msg }); res.flash(msg); res.redirect(back2); };
  const traineeId = s?.trainee_id || req.body.trainee_id;
  const t = s && await L.one("SELECT u.id, u.name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.batch_id=? AND a.status='accepted' AND u.id=?", [s.batch_id, traineeId]);
  if (!s || !t || !req.file || s.type !== 'flying') return fail('Choose a trainee and a flight log file.');
  if (s.records_locked) return fail('Records are locked for this batch.');
  if (s.trainee_id && s.status !== 'done') return fail('Mark this slot done first — logging unlocks once a slot is done.');
  const x = await saveTrack(req.file, { userId: t.id, uploadedBy: req.user.id, rptoId: rid(req), notes: `${s.batch_title} — ${s.code ? s.code + ' ' : ''}${s.title}` });
  if (x.error) return fail(x.error);
  const minutes = Math.max(1, Math.round(x.track.duration_s / 60));
  const f = await L.one('SELECT id FROM flight_logs WHERE session_id=? AND pilot_id=?', [s.id, t.id]);
  if (f) await L.q('UPDATE flight_logs SET track_id=?, minutes=GREATEST(minutes, ?) WHERE id=?', [x.id, minutes, f.id]);
  else {
    await L.q(`INSERT INTO flight_logs (rpto_id,session_id,track_id,date,time,activity_type,activity,pilot_id,pilot_name,instructor_id,rpas_id,minutes)
      VALUES (?,?,?,?,?,'training',?,?,?,?,?,?)`, [rid(req), s.id, x.id, s.date, s.start_time, `${s.batch_title} — ${s.code ? s.code + ' ' : ''}${s.title}`, t.id, t.name, s.instructor_id, s.asset_id, minutes]);
    await L.q('INSERT IGNORE INTO attendance (session_id,user_id,present,marked_by) VALUES (?,?,1,?)', [s.id, t.id, req.user.id]);
  }
  if (json) return res.json({ ok: true, track: x.id, minutes });
  res.flash(`Flight log attached to ${t.name} (${minutes} min).`);
  res.redirect(back2);
});
// Detach a flight log from a session (keeps the uploaded file in the pilot's flights).
r.post('/sessions/:id/untrack', train, async (req, res) => {
  const s = await getSession(req, req.params.id);
  if (s && !s.records_locked) await L.q('UPDATE flight_logs SET track_id=NULL WHERE session_id=? AND pilot_id=?', [s.id, req.body.trainee_id || s.trainee_id]);
  res.redirect(s?.trainee_id ? `/rpto/batches/${s.batch_id}?tab=flying&trainee=${s.trainee_id}` : '/rpto/sessions/' + req.params.id);
});
r.post('/sessions/:id', train, async (req, res) => {
  const s = await getSession(req, req.params.id), x = req.body;
  if (!s || s.records_locked) return res.redirect('/rpto/sessions/' + req.params.id);
  await L.q('UPDATE sessions SET title=?, date=?, start_time=?, end_time=?, instructor_id=?, asset_id=?, status=?, notes=? WHERE id=?',
    [x.title || s.title, x.date || s.date, x.start_time || null, x.end_time || null, x.instructor_id || null, x.asset_id || null,
      ['scheduled', 'done', 'cancelled'].includes(x.status) ? x.status : s.status, x.notes || null, s.id]);
  res.flash('Session updated.');
  res.redirect('/rpto/sessions/' + s.id);
});
r.post('/sessions/:id/attendance', train, async (req, res) => {
  const s = await getSession(req, req.params.id), x = req.body;
  if (!s) return notFound(res);
  if (s.records_locked) { res.flash('Records are locked for this batch.'); return res.redirect('/rpto/sessions/' + s.id); }
  const tr = await L.q("SELECT u.id, u.name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.batch_id=? AND a.status='accepted' AND (? IS NULL OR u.id=?)",
    [s.batch_id, s.trainee_id, s.trainee_id]);
  for (const t of tr) {
    const present = x['present_' + t.id] ? 1 : 0;
    const assess = ['pass', 'needs_work'].includes(x['assess_' + t.id]) ? x['assess_' + t.id] : null;
    await L.q(`INSERT INTO attendance (session_id,user_id,present,assessment,remarks,marked_by) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE present=VALUES(present), assessment=VALUES(assessment), remarks=VALUES(remarks), marked_by=VALUES(marked_by), marked_at=NOW()`,
      [s.id, t.id, present, present ? assess : null, x['remarks_' + t.id] || null, req.user.id]);
    if (s.type === 'flying') {
      await L.q('DELETE FROM flight_logs WHERE session_id=? AND pilot_id=?', [s.id, t.id]);
      const track = x['track_' + t.id] && await L.one('SELECT id, duration_s FROM tracks WHERE id=? AND user_id=?', [x['track_' + t.id], t.id]);
      const battery = x['battery_' + t.id] && await L.one("SELECT id FROM assets WHERE id=? AND rpto_id=? AND type='battery'", [x['battery_' + t.id], rid(req)]);
      const minutes = +x['minutes_' + t.id] || (track ? Math.max(1, Math.round(track.duration_s / 60)) : 0);
      if (present && minutes > 0) await L.q(`INSERT INTO flight_logs (rpto_id,session_id,track_id,date,time,activity,pilot_id,pilot_name,instructor_id,rpas_id,battery_id,place,minutes,remarks)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [rid(req), s.id, track?.id || null, s.date, s.start_time, `${s.batch_title} — ${s.title}`, t.id, t.name, s.instructor_id,
        s.asset_id, battery?.id || null, x.place || null, minutes, x['remarks_' + t.id] || null]);
    }
  }
  await L.q("UPDATE sessions SET status='done' WHERE id=?", [s.id]);
  res.flash('Attendance saved and session marked done.');
  res.redirect('/rpto/batches/' + s.batch_id);
});
r.post('/sessions/:id/delete', admin, async (req, res) => {
  const s = await getSession(req, req.params.id);
  if (s && !s.records_locked) await L.q('DELETE FROM sessions WHERE id=?', [s.id]);
  res.redirect(s ? '/rpto/batches/' + s.batch_id : '/rpto/batches');
});

// ================= TESTS =================
const getTest = (req, id) => L.one(`SELECT t.*, b.title batch_title, b.records_locked FROM tests t JOIN batches b ON b.id=t.batch_id
  WHERE t.id=? AND b.rpto_id=?`, [id, rid(req)]);
r.get('/tests/:id', train, async (req, res) => {
  const t = await getTest(req, req.params.id);
  if (!t) return notFound(res);
  const rows = await L.q(`SELECT u.id, u.name, a.roll_no, r.score, r.total, r.passed, r.remarks, r.taken_at FROM applications a
    JOIN users u ON u.id=a.user_id LEFT JOIN test_results r ON r.test_id=? AND r.user_id=u.id
    WHERE a.batch_id=? AND a.status='accepted' ORDER BY u.name`, [t.id, t.batch_id]);
  const owner = await T.bankOwner(rid(req));
  const bank = (await L.one('SELECT COUNT(*) n FROM questions WHERE rpto_id <=> ?', [owner])).n;
  res.render('rpto/test', { t, rows, bank, defaultBank: owner === null });
});
// Mark one trainee's result, optionally with evidence (score screenshot / scanned answer sheet) or a logged flight.
r.post('/tests/:id/mark/:uid', train, L.upload.single('evidence'), async (req, res) => {
  const t = await getTest(req, req.params.id), x = req.body;
  const go = () => res.redirect(`/rpto/batches/${t ? t.batch_id : ''}?tab=tests`);
  const drop = () => req.file && fs.unlink(req.file.path, () => {});
  if (!t) { drop(); return notFound(res); }
  if (t.records_locked) { drop(); res.flash('Records are locked for this batch.'); return go(); }
  const u = await L.one("SELECT user_id FROM applications WHERE batch_id=? AND user_id=? AND status='accepted'", [t.batch_id, req.params.uid]);
  if (!u) { drop(); return go(); }
  const prev = await L.one('SELECT * FROM test_results WHERE test_id=? AND user_id=?', [t.id, u.user_id]);
  const track = x.track_id && await L.one('SELECT id FROM tracks WHERE id=? AND user_id=?', [x.track_id, u.user_id]);
  const score = x.score === '' || x.score == null ? prev?.score ?? null : +x.score, total = x.total === '' || x.total == null ? prev?.total ?? null : +x.total;
  let passed = x.result === 'pass' ? 1 : x.result === 'fail' ? 0 : prev?.passed ?? null;
  if (x.result === 'auto' && score != null && total > 0) passed = score / total * 100 >= t.pass_percent ? 1 : 0;
  if (req.file && prev?.evidence_file) removeFile(prev.evidence_file);
  await L.q(`INSERT INTO test_results (test_id,user_id,score,total,passed,remarks,evidence_file,track_id,marked_by) VALUES (?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE score=VALUES(score), total=VALUES(total), passed=VALUES(passed), remarks=VALUES(remarks),
      evidence_file=COALESCE(VALUES(evidence_file), evidence_file), track_id=COALESCE(VALUES(track_id), track_id), marked_by=VALUES(marked_by)`,
    [t.id, u.user_id, score, total, passed, x.remarks || prev?.remarks || null, req.file?.filename || null, track?.id || null, req.user.id]);
  res.flash('Result saved.');
  go();
});
// Practical flying test: upload the flight log flown with the examiner.
r.post('/tests/:id/log/:uid', train, L.logUpload.single('file'), async (req, res) => {
  const t = await getTest(req, req.params.id);
  const u = t && await L.one("SELECT user_id FROM applications WHERE batch_id=? AND user_id=? AND status='accepted'", [t.batch_id, req.params.uid]);
  if (!t || !u || !req.file || t.records_locked) { if (req.file) fs.unlink(req.file.path, () => {}); res.flash('Choose a flight log file.'); return res.redirect(`/rpto/batches/${t?.batch_id || ''}?tab=tests`); }
  const x = await saveTrack(req.file, { userId: u.user_id, uploadedBy: req.user.id, rptoId: rid(req), notes: `${t.batch_title} — ${t.title}` });
  if (x.error) { res.flash(x.error); return res.redirect(`/rpto/batches/${t.batch_id}?tab=tests`); }
  await L.q(`INSERT INTO test_results (test_id,user_id,track_id,marked_by) VALUES (?,?,?,?)
    ON DUPLICATE KEY UPDATE track_id=VALUES(track_id), marked_by=VALUES(marked_by)`, [t.id, u.user_id, x.id, req.user.id]);
  res.flash('Test flight log attached — review it in 3D, then mark the result.');
  res.redirect(`/rpto/batches/${t.batch_id}?tab=tests`);
});
// Printable answer-bubble (OMR) sheets for a paper theory test — one page per trainee.
r.get('/tests/:id/omr', train, async (req, res) => {
  const t = await getTest(req, req.params.id);
  if (!t) return notFound(res);
  const rpto = await L.one('SELECT * FROM rptos WHERE id=?', [rid(req)]);
  const trainees = await L.q(`SELECT u.name, a.roll_no FROM applications a JOIN users u ON u.id=a.user_id
    WHERE a.batch_id=? AND a.status='accepted' AND (?='' OR u.id=?) ORDER BY u.name`, [t.batch_id, req.query.trainee || '', req.query.trainee || '']);
  res.render('omr', { t, rpto, trainees: trainees.length ? trainees : [{ name: '', roll_no: '' }] });
});
r.post('/tests/:id', admin, async (req, res) => {
  const t = await getTest(req, req.params.id), x = req.body;
  if (t) await L.q('UPDATE tests SET title=?, question_count=?, pass_percent=?, duration_min=?, open=? WHERE id=?',
    [x.title || t.title, +x.question_count || t.question_count, +x.pass_percent || t.pass_percent, +x.duration_min || t.duration_min, x.open ? 1 : 0, t.id]);
  res.flash('Test settings saved.');
  res.redirect('/rpto/tests/' + req.params.id);
});
r.post('/tests/:id/results', train, async (req, res) => {
  const t = await getTest(req, req.params.id), x = req.body;
  if (!t) return notFound(res);
  if (t.records_locked) { res.flash('Records are locked for this batch.'); return res.redirect('/rpto/tests/' + t.id); }
  const tr = await L.q("SELECT user_id FROM applications WHERE batch_id=? AND status='accepted'", [t.batch_id]);
  for (const { user_id: u } of tr) {
    const res_ = x['result_' + u], score = x['score_' + u], total = x['total_' + u];
    if (!res_ && score === '') continue;
    let passed = res_ === 'pass' ? 1 : res_ === 'fail' ? 0 : null;
    if (passed === null && score !== '' && +total > 0) passed = (+score / +total) * 100 >= t.pass_percent ? 1 : 0;
    await L.q(`INSERT INTO test_results (test_id,user_id,score,total,passed,remarks) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE score=VALUES(score), total=VALUES(total), passed=VALUES(passed), remarks=VALUES(remarks)`,
      [t.id, u, score === '' ? null : +score, total === '' ? null : +total, passed, x['remarks_' + u] || null]);
  }
  res.flash('Results saved.');
  res.redirect('/rpto/tests/' + t.id);
});
r.get('/tests/:id/pack', train, async (req, res) => {
  const t = await getTest(req, req.params.id);
  if (!t) return notFound(res);
  const questions = await L.q('SELECT * FROM questions WHERE rpto_id <=> ? ORDER BY RAND() LIMIT ?', [await T.bankOwner(rid(req)), t.question_count || 50]);
  const rpto = await L.one('SELECT * FROM rptos WHERE id=?', [rid(req)]);
  const trainees = await L.q("SELECT u.name, a.roll_no FROM applications a JOIN users u ON u.id=a.user_id WHERE a.batch_id=? AND a.status='accepted' ORDER BY u.name", [t.batch_id]);
  res.render('testpack', { t, questions, rpto, trainees });
});
r.post('/tests/:id/delete', admin, async (req, res) => {
  const t = await getTest(req, req.params.id);
  if (t && !t.records_locked) await L.q('DELETE FROM tests WHERE id=?', [t.id]);
  res.redirect(t ? '/rpto/batches/' + t.batch_id : '/rpto/batches');
});

// ================= ASSETS =================
r.get('/assets', train, async (req, res) => {
  // Battery cycles = cycles before tracking + flights logged with that pack.
  const assets = await L.q(`SELECT a.*, (SELECT COUNT(*) FROM flight_logs f WHERE f.battery_id=a.id) flights_on,
      (SELECT COUNT(*) FROM flight_logs f WHERE f.rpas_id=a.id) rpas_flights FROM assets a WHERE a.rpto_id=? ORDER BY a.type, a.status, a.name`, [rid(req)]);
  res.render('rpto/assets', { assets });
});
const assetFields = x => [x.name, x.make || null, x.serial_no || null, x.uin || null, x.category || null, x.rpas_class || null, x.type_certified ? 1 : 0,
  +x.capacity_mah || null, +x.voltage || null, +x.capacity_seats || null, Math.max(1, parseInt(x.quantity) || 1), parseInt(x.batteries_per_flight) || null,
  Math.max(0, parseInt(x.initial_cycles) || 0), parseInt(x.max_cycles) || null, x.location || null, x.acquired_on || null, x.notes || null];
const ASSET_COLS = 'name=?, make=?, serial_no=?, uin=?, category=?, rpas_class=?, type_certified=?, capacity_mah=?, voltage=?, capacity_seats=?, quantity=?, batteries_per_flight=?, initial_cycles=?, max_cycles=?, location=?, acquired_on=?, notes=?';
r.post('/assets', admin, async (req, res) => {
  const x = req.body;
  if (!L.ASSET_TYPES[x.type] || !x.name) { res.flash('Type and name are required.'); return res.redirect('/rpto/assets'); }
  await L.q(`INSERT INTO assets SET rpto_id=?, type=?, status=?, ${ASSET_COLS}`, [rid(req), x.type, x.in_service ? 'in_service' : 'maintenance', ...assetFields(x)]);
  res.flash(`${L.ASSET_TYPES[x.type]}: ${x.name} added.`);
  res.redirect('/rpto/assets#' + x.type);
});
r.post('/assets/:id/edit', admin, async (req, res) => {
  if (!req.body.name) { res.flash('Name is required.'); return res.redirect('/rpto/assets'); }
  await L.q(`UPDATE assets SET ${ASSET_COLS} WHERE id=? AND rpto_id=?`, [...assetFields(req.body), req.params.id, rid(req)]);
  res.flash('Asset updated.');
  res.redirect('/rpto/assets');
});
r.post('/assets/:id', admin, async (req, res) => {
  const st = ['in_service', 'maintenance', 'retired'].includes(req.body.status) ? req.body.status : 'in_service';
  await L.q('UPDATE assets SET status=?, notes=? WHERE id=? AND rpto_id=?', [st, req.body.notes || null, req.params.id, rid(req)]);
  res.redirect('/rpto/assets');
});
r.post('/assets/:id/delete', admin, async (req, res) => {
  await L.q('DELETE FROM assets WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  res.redirect('/rpto/assets');
});

// ================= LOGBOOK =================
r.get('/logbook', train, async (req, res) => {
  const id = rid(req), tab = ['ops', 'rpas', 'batteries', 'incidents', 'maintenance'].includes(req.query.tab) ? req.query.tab : 'ops';
  const flights = await L.q(`SELECT f.*, r.name rpas, r.uin, bt.name battery, bt.serial_no battery_sn, i.name instructor, fl.name field FROM flight_logs f
    LEFT JOIN assets r ON r.id=f.rpas_id LEFT JOIN assets bt ON bt.id=f.battery_id LEFT JOIN users i ON i.id=f.instructor_id LEFT JOIN assets fl ON fl.id=f.field_id
    WHERE f.rpto_id=? ORDER BY f.date DESC, f.time DESC`, [id]);
  if (req.query.export) return L.sendCsv(res, 'flight-log.csv', [['Date', 'Time', 'Type', 'Activity', 'Pilot', 'Instructor', 'RPAS', 'UIN', 'Battery', 'Field / place', 'Minutes', 'Remarks'],
    ...flights.map(f => [f.date, f.time, f.activity_type, f.activity, f.pilot_name, f.instructor, f.rpas, f.uin, f.battery_sn || f.battery, f.field || f.place, f.minutes, f.remarks])]);
  const perAsset = type => L.q(`SELECT a.*, COUNT(f.id) flights, COALESCE(SUM(f.minutes),0) minutes, MAX(f.date) last_used,
      (SELECT COUNT(*) FROM incident_assets ia WHERE ia.asset_id=a.id) incidents
    FROM assets a LEFT JOIN flight_logs f ON f.${type === 'rpas' ? 'rpas_id' : 'battery_id'}=a.id
    WHERE a.rpto_id=? AND a.type=? GROUP BY a.id ORDER BY a.name`, [id, type]);
  const rpas = await perAsset('rpas'), batteries = await perAsset('battery');
  const incidents = await L.q(`SELECT i.*, tr.name trainee, ins.name instructor, fl.name field,
      (SELECT GROUP_CONCAT(a.name ORDER BY a.type SEPARATOR ', ') FROM incident_assets ia JOIN assets a ON a.id=ia.asset_id WHERE ia.incident_id=i.id) assets
    FROM incidents i LEFT JOIN users tr ON tr.id=i.trainee_id LEFT JOIN users ins ON ins.id=i.instructor_id LEFT JOIN assets fl ON fl.id=i.field_id
    WHERE i.rpto_id=? ORDER BY i.date DESC, i.time DESC`, [id]);
  const pilots = await L.q("SELECT DISTINCT u.id, u.name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.rpto_id=? AND a.status='accepted' ORDER BY u.name", [id]);
  const instructors = await L.q("SELECT DISTINCT u.id, u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.rpto_id=? AND m.role='Instructor' ORDER BY u.name", [id]);
  const maintenance = await L.q('SELECT m.*, a.name asset, a.type FROM maintenance m JOIN assets a ON a.id=m.asset_id WHERE m.rpto_id=? ORDER BY m.date DESC', [id]);
  const assets = await L.q('SELECT id, name, type, serial_no, uin FROM assets WHERE rpto_id=? ORDER BY type, name', [id]);
  const totalMin = flights.reduce((t, f) => t + f.minutes, 0);
  res.render('rpto/logbook', { tab, flights, rpas, batteries, incidents, pilots, instructors, totalMin, maintenance, assets });
});
// Printable logbook for one RPAS (flights, maintenance, incidents) or one battery (cycles).
r.get('/logbook/asset/:id', train, async (req, res) => {
  const a = await L.one('SELECT * FROM assets WHERE id=? AND rpto_id=? AND type IN (?)', [req.params.id, rid(req), ['rpas', 'battery']]);
  if (!a) return notFound(res);
  const flights = await L.q(`SELECT f.*, r.name rpas, r.uin, bt.serial_no battery_sn, i.name instructor, fl.name field FROM flight_logs f
    LEFT JOIN assets r ON r.id=f.rpas_id LEFT JOIN assets bt ON bt.id=f.battery_id LEFT JOIN users i ON i.id=f.instructor_id LEFT JOIN assets fl ON fl.id=f.field_id
    WHERE f.${a.type === 'rpas' ? 'rpas_id' : 'battery_id'}=? ORDER BY f.date, f.time`, [a.id]);
  const maintenance = await L.q('SELECT * FROM maintenance WHERE asset_id=? ORDER BY date', [a.id]);
  const incidents = await L.q('SELECT i.* FROM incidents i JOIN incident_assets ia ON ia.incident_id=i.id WHERE ia.asset_id=? ORDER BY i.date', [a.id]);
  res.render('assetlog', { a, flights, maintenance, incidents, rpto: await L.one('SELECT * FROM rptos WHERE id=?', [rid(req)]) });
});
r.post('/logbook/maintenance', train, async (req, res) => {
  const x = req.body, asset = x.asset_id && await L.one('SELECT id, name FROM assets WHERE id=? AND rpto_id=?', [x.asset_id, rid(req)]);
  if (!asset || !x.date) { res.flash('Asset and date are required.'); return res.redirect('/rpto/logbook?tab=maintenance'); }
  await L.q('INSERT INTO maintenance (rpto_id,asset_id,date,type,description,done_by,next_due) VALUES (?,?,?,?,?,?,?)',
    [rid(req), asset.id, x.date, ['inspection', 'repair', 'replacement', 'firmware', 'other'].includes(x.type) ? x.type : 'other', x.description || null, x.done_by || req.user.name, x.next_due || null]);
  if (['in_service', 'maintenance', 'retired'].includes(x.set_status)) await L.q('UPDATE assets SET status=? WHERE id=?', [x.set_status, asset.id]);
  await L.log(rid(req), `Maintenance logged for ${asset.name}`);
  res.redirect('/rpto/logbook?tab=maintenance');
});

// ================= REPORTS =================
r.get('/reports', train, async (req, res) => {
  const id = rid(req);
  const monthly = await L.q(`SELECT DATE_FORMAT(date,'%Y-%m') ym, COUNT(*) flights, SUM(minutes) minutes, COUNT(DISTINCT pilot_id) pilots
    FROM flight_logs WHERE rpto_id=? AND date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY ym ORDER BY ym`, [id]);
  const sessions = await L.q(`SELECT DATE_FORMAT(s.date,'%Y-%m') ym, s.type, COUNT(*) n FROM sessions s JOIN batches b ON b.id=s.batch_id
    WHERE b.rpto_id=? AND s.status='done' AND s.date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY ym, s.type`, [id]);
  const rpas = await L.q(`SELECT a.id, a.name, a.uin, a.status, COUNT(f.id) flights, COALESCE(SUM(f.minutes),0) minutes, MAX(f.date) last_used,
      (SELECT MAX(date) FROM maintenance m WHERE m.asset_id=a.id) last_maint, (SELECT MIN(next_due) FROM maintenance m WHERE m.asset_id=a.id AND next_due >= CURDATE()) next_due
    FROM assets a LEFT JOIN flight_logs f ON f.rpas_id=a.id WHERE a.rpto_id=? AND a.type='rpas' GROUP BY a.id ORDER BY minutes DESC`, [id]);
  const batteries = await L.q(`SELECT a.id, a.name, a.serial_no, a.status, COUNT(f.id) cycles, COALESCE(SUM(f.minutes),0) minutes
    FROM assets a LEFT JOIN flight_logs f ON f.battery_id=a.id WHERE a.rpto_id=? AND a.type='battery' GROUP BY a.id ORDER BY cycles DESC`, [id]);
  const currency = await L.q(`SELECT u.id, u.name,
      (SELECT MAX(f.date) FROM flight_logs f WHERE f.instructor_id=u.id AND f.rpto_id=?) last_flight,
      (SELECT COUNT(*) FROM flight_logs f WHERE f.instructor_id=u.id AND f.rpto_id=? AND f.date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)) flights_90,
      (SELECT COUNT(*) FROM sessions s WHERE s.instructor_id=u.id AND s.status='done' AND s.date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)) sessions_90,
      (SELECT MAX(dgca_cert IS NOT NULL) FROM members m2 WHERE m2.user_id=u.id AND m2.rpto_id=? AND m2.role='Instructor') certified
    FROM members m JOIN users u ON u.id=m.user_id WHERE m.rpto_id=? AND m.role='Instructor' GROUP BY u.id, u.name ORDER BY u.name`, [id, id, id, id]);
  const incidents = await L.q(`SELECT DATE_FORMAT(date,'%Y-%m') ym, severity, COUNT(*) n FROM incidents WHERE rpto_id=? AND date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
    GROUP BY ym, severity ORDER BY ym`, [id]);
  const due = await L.q(`SELECT m.next_due, m.type, m.description, a.name FROM maintenance m JOIN assets a ON a.id=m.asset_id
    WHERE m.rpto_id=? AND m.next_due IS NOT NULL AND m.next_due <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
      AND NOT EXISTS (SELECT 1 FROM maintenance m2 WHERE m2.asset_id=m.asset_id AND m2.date > m.date) ORDER BY m.next_due`, [id]);
  const outcomes = await L.one(`SELECT COUNT(*) admitted, SUM(cert_no IS NOT NULL) certified, SUM(rpc_no IS NOT NULL) rpc,
      SUM(status='cancelled') cancelled FROM applications WHERE rpto_id=? AND status IN ('accepted','cancelled')`, [id]);
  const ex = req.query.export;
  if (ex === 'utilisation') return L.sendCsv(res, 'utilisation.csv', [['Month', 'Flights', 'Minutes', 'Pilots'], ...monthly.map(m => [m.ym, m.flights, m.minutes, m.pilots])]);
  if (ex === 'rpas') return L.sendCsv(res, 'rpas-utilisation.csv', [['RPAS', 'UIN', 'Status', 'Flights', 'Minutes', 'Last used', 'Last maintenance', 'Next due'], ...rpas.map(a => [a.name, a.uin, a.status, a.flights, a.minutes, a.last_used, a.last_maint, a.next_due])]);
  if (ex === 'currency') return L.sendCsv(res, 'instructor-currency.csv', [['Instructor', 'Certificate', 'Last supervised flight', 'Flights (90d)', 'Sessions (90d)'], ...currency.map(c => [c.name, c.certified ? 'Yes' : 'No', c.last_flight, c.flights_90, c.sessions_90])]);
  if (ex === 'incidents') return L.sendCsv(res, 'incidents.csv', [['Month', 'Severity', 'Count'], ...incidents.map(i => [i.ym, i.severity, i.n])]);
  res.render('rpto/reports', { monthly, sessions, rpas, batteries, currency, incidents, due, outcomes });
});
r.post('/logbook/flights', train, async (req, res) => {
  const x = req.body, pilot = x.pilot_id && await L.one("SELECT u.id, u.name FROM users u JOIN applications a ON a.user_id=u.id WHERE u.id=? AND a.rpto_id=? LIMIT 1", [x.pilot_id, rid(req)]);
  if (!x.date || !(pilot || x.pilot_name)) { res.flash('Date and pilot are required.'); return res.redirect('/rpto/logbook'); }
  const own = async (aid, type) => aid && (await L.one('SELECT id FROM assets WHERE id=? AND rpto_id=? AND type=?', [aid, rid(req), type])) ? aid : null;
  const types = ['training', 'test', 'maintenance', 'demonstration', 'survey', 'other'];
  await L.q(`INSERT INTO flight_logs (rpto_id,date,time,activity_type,activity,pilot_id,pilot_name,instructor_id,rpas_id,battery_id,field_id,place,minutes,remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [rid(req), x.date, x.time || null, types.includes(x.activity_type) ? x.activity_type : 'other', x.activity || 'Manual entry',
    pilot?.id || null, pilot?.name || x.pilot_name, req.user.isInstructor ? req.user.id : null, await own(x.rpas_id, 'rpas'), await own(x.battery_id, 'battery'),
    await own(x.field_id, 'field'), x.place || null, +x.minutes || 0, x.remarks || null]);
  res.flash('Flight entry added.');
  res.redirect('/rpto/logbook');
});
r.post('/logbook/flights/:id/delete', admin, async (req, res) => {
  await L.q('DELETE FROM flight_logs WHERE id=? AND rpto_id=? AND session_id IS NULL', [req.params.id, rid(req)]);
  res.redirect('/rpto/logbook');
});
r.post('/logbook/incidents', train, async (req, res) => {
  const x = req.body;
  if (!x.date || !x.description) { res.flash('Date and description are required.'); return res.redirect('/rpto/logbook?tab=incidents'); }
  const mine = await L.q('SELECT id, type FROM assets WHERE rpto_id=?', [rid(req)]);
  const assetIds = arr(x.assets).map(Number).filter(i => mine.some(a => a.id === i));
  const field = mine.find(a => a.id === +x.field_id && a.type === 'field');
  const trainee = x.trainee_id && await L.one('SELECT user_id FROM applications WHERE user_id=? AND rpto_id=? LIMIT 1', [x.trainee_id, rid(req)]);
  const instructor = x.instructor_id && await L.one("SELECT user_id FROM members WHERE user_id=? AND rpto_id=? AND role='Instructor' LIMIT 1", [x.instructor_id, rid(req)]);
  const inc = await L.q(`INSERT INTO incidents (rpto_id,date,time,field_id,location,trainee_id,instructor_id,pilot_name,severity,description,action_taken)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [rid(req), x.date, x.time || null, field?.id || null, x.location || null, trainee?.user_id || null, instructor?.user_id || null,
    x.pilot_name || null, ['minor', 'major', 'serious'].includes(x.severity) ? x.severity : 'minor', x.description, x.action_taken || null]);
  if (assetIds.length) await L.q('INSERT INTO incident_assets (incident_id, asset_id) VALUES ?', [assetIds.map(a => [inc.insertId, a])]);
  await L.log(rid(req), `Incident reported (${x.severity || 'minor'})`);
  res.redirect('/rpto/logbook?tab=incidents');
});

// ================= MEMBERS (staff) =================
r.get('/members', admin, async (req, res) => {
  const members = await L.q(`SELECT m.*, u.name, u.email, u.active FROM members m JOIN users u ON u.id=m.user_id
    WHERE m.rpto_id=? ORDER BY u.name, m.role`, [rid(req)]);
  const limit = (await L.one('SELECT staff_limit FROM rptos WHERE id=?', [rid(req)])).staff_limit;
  res.render('rpto/members', { members, limit, used: new Set(members.map(m => m.user_id)).size });
});
r.post('/members', admin, L.upload.single('cert'), async (req, res) => {
  const x = req.body, email = String(x.email || '').trim().toLowerCase(), role = L.MEMBER_ROLES.find(r2 => r2 === x.role);
  const fail = msg => { removeFile(req.file?.filename); res.flash(msg); res.redirect('/rpto/members'); };
  if (!email || !role) return fail('Email and role are required.');
  let u = await L.one('SELECT id, role, rpto_id FROM users WHERE email=?', [email]), message = `${role} added.`;
  if (u && u.role === 'student') return fail('That email belongs to a trainee account.');
  if (u && u.role === 'super_admin') return fail('That email belongs to a platform admin.');
  if (u && u.rpto_id && u.rpto_id !== rid(req)) return fail('That person already belongs to another RPTO.');
  const isMember = u && await L.one('SELECT id FROM members WHERE rpto_id=? AND user_id=? LIMIT 1', [rid(req), u.id]);
  if (!isMember) {
    const { n } = await L.one('SELECT COUNT(DISTINCT user_id) n FROM members WHERE rpto_id=?', [rid(req)]);
    const { staff_limit } = await L.one('SELECT staff_limit FROM rptos WHERE id=?', [rid(req)]);
    if (n >= staff_limit) return fail(`Staff limit reached (${staff_limit}). Ask the platform admin to raise it.`);
  }
  if (!u) {
    const pw = L.randomPassword();
    const y = await L.q("INSERT INTO users (rpto_id,name,email,password_hash,role) VALUES (?,?,?,?,'member')", [rid(req), x.name || email.split('@')[0], email, L.hashPassword(pw)]);
    u = { id: y.insertId };
    message = await L.credentialsMessage(req, { id: u.id, email, name: x.name }, pw, role);
  } else await L.q('UPDATE users SET rpto_id=?, active=1 WHERE id=?', [rid(req), u.id]);
  try {
    await L.q('INSERT INTO members (rpto_id,user_id,role,dgca_cert) VALUES (?,?,?,?)', [rid(req), u.id, role, role === 'Instructor' ? req.file?.filename || null : null]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') return fail('This person already has that role.'); throw e; }
  await L.log(rid(req), `${x.name || email} added as ${role}`);
  res.flash(message);
  res.redirect('/rpto/members');
});
r.post('/members/:id/cert', admin, L.upload.single('cert'), async (req, res) => {
  const m = await L.one("SELECT * FROM members WHERE id=? AND rpto_id=? AND role='Instructor'", [req.params.id, rid(req)]);
  if (m && req.file) { removeFile(m.dgca_cert); await L.q('UPDATE members SET dgca_cert=? WHERE id=?', [req.file.filename, m.id]); res.flash('Certificate uploaded.'); }
  else removeFile(req.file?.filename);
  res.redirect('/rpto/members');
});
r.post('/members/:id/cert/remove', admin, async (req, res) => {
  const m = await L.one("SELECT * FROM members WHERE id=? AND rpto_id=? AND role='Instructor'", [req.params.id, rid(req)]);
  if (m?.dgca_cert) { await L.q('UPDATE members SET dgca_cert=NULL WHERE id=?', [m.id]); removeFile(m.dgca_cert); res.flash('Certificate removed — this instructor can no longer be assigned to batches.'); }
  res.redirect('/rpto/members');
});
r.post('/members/:id/remove', admin, async (req, res) => {
  const m = await L.one('SELECT * FROM members WHERE id=? AND rpto_id=?', [req.params.id, rid(req)]);
  if (!m) return res.redirect('/rpto/members');
  if (['Admin', 'Accountable Manager'].includes(m.role)) {
    const { n } = await L.one("SELECT COUNT(*) n FROM members WHERE rpto_id=? AND role IN ('Admin','Accountable Manager')", [rid(req)]);
    if (n <= 1) { res.flash('You cannot remove the last admin.'); return res.redirect('/rpto/members'); }
  }
  await L.q('DELETE FROM members WHERE id=?', [m.id]);
  removeFile(m.dgca_cert);
  if (!(await L.one('SELECT id FROM members WHERE user_id=? LIMIT 1', [m.user_id]))) await L.q('UPDATE users SET active=0, rpto_id=NULL WHERE id=?', [m.user_id]);
  res.flash('Role removed.');
  res.redirect('/rpto/members');
});
// Admins reset passwords for their own staff and trainees (never platform admins, never themselves here).
r.post('/users/:id/password', admin, async (req, res) => {
  const u = await L.one(`SELECT id, name, email FROM users u WHERE id=? AND id<>? AND role<>'super_admin' AND (
      EXISTS (SELECT 1 FROM members m WHERE m.user_id=u.id AND m.rpto_id=?) OR EXISTS (SELECT 1 FROM applications a WHERE a.user_id=u.id AND a.rpto_id=?))`,
    [req.params.id, req.user.id, rid(req), rid(req)]);
  if (!u) return notFound(res);
  const pw = L.randomPassword();
  await L.q('UPDATE users SET password_hash=?, session_ver=session_ver+1 WHERE id=?', [L.hashPassword(pw), u.id]);
  const link = L.mailEnabled() && await L.resetLink(req, u.id, 24);
  const mailed = link && await L.sendMail(u.email, 'Your password was reset', `Hi ${u.name},\n\n${req.user.rpto.name} reset your password. Set a new one here (valid 24 hours):\n${link}`);
  res.flash(mailed ? `A password reset link was emailed to ${u.email}.` : `New password for ${u.email}: ${pw} — share it securely.`);
  res.redirect(back(req, '/rpto/members'));
});

// ================= SETTINGS =================
r.get('/settings', admin, async (req, res) => {
  const tab = ['about', 'branding', 'roll', 'syllabus', 'questions'].includes(req.query.tab) ? req.query.tab : 'about';
  const rpto = await L.one('SELECT * FROM rptos WHERE id=?', [rid(req)]);
  const d = { tab, rpto, questions: [], syllabus: [], custom: false, defaults: 0, instructors: [] };
  if (tab === 'questions') {
    d.questions = await D.questions(rid(req));
    d.defaults = (await L.one('SELECT COUNT(*) n FROM questions WHERE rpto_id IS NULL')).n;
  }
  if (tab === 'syllabus') { d.syllabus = await D.syllabus(rid(req)); d.custom = d.syllabus.length > 0; if (!d.custom) d.syllabus = await D.syllabus(null); }
  if (tab === 'branding') d.instructors = await L.q("SELECT DISTINCT u.id, u.name, u.signature FROM members m JOIN users u ON u.id=m.user_id WHERE m.rpto_id=? AND m.role='Instructor' ORDER BY u.name", [rid(req)]);
  res.render('rpto/settings', d);
});
r.post('/settings/about', admin, async (req, res) => {
  const x = req.body, rpto = await L.one('SELECT about_locked FROM rptos WHERE id=?', [rid(req)]);
  const gstin = String(x.gstin || '').trim().toUpperCase();
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) { res.flash('GSTIN must be 15 letters/digits.'); return res.redirect('/rpto/settings'); }
  if (rpto.about_locked) await L.q('UPDATE rptos SET contact_email=?, contact_phone=?, gstin=? WHERE id=?', [x.contact_email, x.contact_phone, gstin || null, rid(req)]);
  else await L.q('UPDATE rptos SET name=?, city=?, address=?, auth_no=?, file_no=?, accountable_manager=?, contact_email=?, contact_phone=?, gstin=? WHERE id=?',
    [x.name, x.city, x.address, x.auth_no, x.file_no, x.accountable_manager, x.contact_email, x.contact_phone, gstin || null, rid(req)]);
  res.flash('Settings saved.');
  res.redirect('/rpto/settings');
});
r.post('/settings/branding', admin, L.upload.fields([{ name: 'logo' }, { name: 'signature' }, { name: 'stamp' }]), async (req, res) => {
  const rpto = await L.one('SELECT logo, signature, stamp FROM rptos WHERE id=?', [rid(req)]);
  for (const k of ['logo', 'signature', 'stamp']) {
    const f = req.files?.[k]?.[0];
    if (f) { removeFile(rpto[k]); await L.q(`UPDATE rptos SET ${k}=? WHERE id=?`, [f.filename, rid(req)]); }
  }
  const trainer = req.body.default_trainer_id && await L.one("SELECT user_id FROM members WHERE user_id=? AND rpto_id=? AND role='Instructor' LIMIT 1", [req.body.default_trainer_id, rid(req)]);
  await L.q('UPDATE rptos SET tagline=?, brand_color=?, default_trainer_id=? WHERE id=?',
    [req.body.tagline || null, /^#[0-9a-f]{6}$/i.test(req.body.brand_color) ? req.body.brand_color : '#0d9488', trainer?.user_id || null, rid(req)]);
  res.flash('Branding saved.');
  res.redirect('/rpto/settings?tab=branding');
});
r.post('/settings/roll', admin, async (req, res) => {
  const x = req.body;
  await L.q('UPDATE rptos SET roll_code=?, roll_format=?, cert_prefix=? WHERE id=?',
    [String(x.roll_code || 'RPTO').slice(0, 20), String(x.roll_format || '{CODE}/{BATCH}/{SEQ}').slice(0, 100), String(x.cert_prefix || 'CERT').slice(0, 20), rid(req)]);
  res.flash('Numbering saved.');
  res.redirect('/rpto/settings?tab=roll');
});
D.mount(r, { base: '/settings', guard: admin, owner: rid, back: tab => `/rpto/settings?tab=${tab}` });

// ================= BILLING: completion credits + partner earnings =================
r.get('/billing', admin, async (req, res) => {
  const id = rid(req);
  const { credits } = await L.one('SELECT credits FROM rptos WHERE id=?', [id]);
  const ledger = await L.q(`SELECT l.*, u.name by_name, a.cert_no, t.name trainee FROM credit_ledger l LEFT JOIN users u ON u.id=l.created_by
    LEFT JOIN applications a ON a.id=l.application_id LEFT JOIN users t ON t.id=a.user_id WHERE l.rpto_id=? ORDER BY l.id DESC LIMIT 200`, [id]);
  const earnings = await L.q('SELECT e.*, u.name FROM partner_earnings e JOIN users u ON u.id=e.user_id WHERE e.rpto_id=? ORDER BY e.id DESC', [id]);
  const payments = await L.q("SELECT p.*, u.name FROM payments p JOIN users u ON u.id=p.user_id WHERE p.rpto_id=? ORDER BY p.id DESC", [id]);
  res.render('rpto/billing', { credits, ledger, earnings, payments, price: T.CREDIT_PRICE, share: T.PARTNER_SHARE, months: T.PARTNER_MONTHS, keyId: L.razorpayKeyId() });
});
r.post('/billing/order', admin, async (req, res) => {
  const qty = Math.min(1000, Math.max(1, parseInt(req.body.quantity) || 0));
  if (!T.CREDIT_PRICE || !L.razorpayKeyId()) return res.status(400).json({ error: 'Online payments are not configured.' });
  const amount = qty * T.CREDIT_PRICE * 100;
  const order = await L.razorpayOrder(amount, `r${rid(req)}-${Date.now()}`, { rpto_id: String(rid(req)), quantity: String(qty) });
  if (!order) return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
  await L.q("INSERT INTO payments (user_id,rpto_id,plan,quantity,amount_paise,order_id) VALUES (?,?,'credits',?,?,?)", [req.user.id, rid(req), qty, amount, order.id]);
  res.json({ key: L.razorpayKeyId(), order_id: order.id, amount, currency: 'INR', name: res.locals.appName, description: `${qty} completion credit(s)`,
    prefill: { name: req.user.name, email: req.user.email, contact: req.user.phone || '' } });
});
r.post('/billing/verify', admin, async (req, res) => {
  const s = await L.settlePayment(req.user.id, req.body);
  if (s.error) res.flash(s.error);
  else if (s.p && s.p.plan === 'credits' && s.p.rpto_id === rid(req)) {
    await T.addCredits(rid(req), s.p.quantity, 'purchase', { paymentId: s.p.id, by: req.user.id });
    await L.log(rid(req), `${s.p.quantity} completion credit(s) purchased`);
    res.flash(`Payment successful — ${s.p.quantity} credit(s) added.`);
  }
  res.redirect('/rpto/billing');
});

module.exports = r;

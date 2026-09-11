// Question bank + syllabus editing. Mounted twice: RPTO settings (owner = the RPTO, an own copy that
// overrides the platform default) and the platform admin (owner = NULL, the default every RPTO starts with).
const L = require('./lib');
const SECTIONS = ['theory', 'workshop', 'simulator', 'flying', 'test'];
const Q_HEAD = ['subject', 'question', 'a', 'b', 'c', 'd', 'correct'];
const S_HEAD = ['code', 'section', 'title', 'minutes', 'needs_log'];

const noHeader = (rows, word) => rows[0] && rows[0].some(c => String(c).trim().toLowerCase() === word) ? rows.slice(1) : rows;
function questionRows(rows) {
  return noHeader(rows, 'question')
    .map(([s, qn, a, b, c, d, k]) => [s?.trim() || null, qn?.trim(), a?.trim(), b?.trim(), c?.trim() || null, d?.trim() || null, String(k || '').trim().toLowerCase()])
    .filter(([, qn, a, b, c, d, k]) => qn && a && b && ({ a, b, c, d })[k]);
}
function syllabusRows(rows) {
  return noHeader(rows, 'section')
    .map(([code, s, t, m, log], i) => [String(code || '').trim().slice(0, 20), String(s || '').trim().toLowerCase(), String(t || '').trim().slice(0, 200),
      Math.min(600, Math.max(5, +m || 60)), /^(1|y|yes|true)$/i.test(String(log || '').trim()) ? 1 : 0, i])
    .filter(([code, s, t]) => code && SECTIONS.includes(s) && t);
}
// Swap a whole list in one transaction so a failed import never leaves the bank half-empty.
async function replaceAll(table, cols, owner, rows) {
  const conn = await L.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM ${table} WHERE rpto_id <=> ?`, [owner]);
    if (rows.length) await conn.query(`INSERT INTO ${table} (rpto_id,${cols}) VALUES ?`, [rows.map(r => [owner, ...r])]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}
const questions = owner => L.q('SELECT * FROM questions WHERE rpto_id <=> ? ORDER BY subject, id', [owner]);
const syllabus = owner => L.q('SELECT * FROM syllabus_items WHERE rpto_id <=> ? ORDER BY sort, id', [owner]);
function syllabusItem(x) {
  const section = SECTIONS.includes(x.section) ? x.section : null, code = String(x.code || '').trim().slice(0, 20), title = String(x.title || '').trim().slice(0, 200);
  return section && code && title ? { code, section, title, minutes: Math.min(600, Math.max(5, +x.minutes || 60)), needs_log: x.needs_log ? 1 : 0 } : null;
}

// base: URL prefix inside the router, e.g. '/settings'; owner(req) → rpto id or null; back(tab) → redirect URL.
function mount(r, { base, guard, owner, back }) {
  // ---- question bank ----
  r.get(`${base}/questions.csv`, guard, async (req, res) => {
    const own = await questions(owner(req)), list = own.length ? own : await questions(null);
    L.sendCsv(res, 'question-bank.csv', [Q_HEAD, ...list.map(q => [q.subject, q.question, q.a, q.b, q.c, q.d, q.correct])]);
  });
  r.post(`${base}/questions`, guard, async (req, res) => {
    const [row] = questionRows([[req.body.subject, req.body.question, req.body.a, req.body.b, req.body.c, req.body.d, req.body.correct]]);
    if (!row) res.flash('Question, options A/B and a correct option that has text are required.');
    else await L.q('INSERT INTO questions (rpto_id,subject,question,a,b,c,d,correct) VALUES (?,?,?,?,?,?,?,?)', [owner(req), ...row]);
    res.redirect(back('questions'));
  });
  r.post(`${base}/questions/import`, guard, L.csvUpload.single('file'), async (req, res) => {
    const rows = req.file ? questionRows(L.parseCsv(req.file.buffer.toString('utf8'))) : [];
    if (!rows.length) res.flash('No valid questions found — nothing was changed. Use the template columns.');
    else { await replaceAll('questions', Q_HEAD.join(','), owner(req), rows); res.flash(`Question bank replaced with ${rows.length} question(s).`); }
    res.redirect(back('questions'));
  });
  r.post(`${base}/questions/clear`, guard, async (req, res) => {
    await L.q('DELETE FROM questions WHERE rpto_id <=> ?', [owner(req)]);
    res.flash(owner(req) ? 'Your bank was removed — tests now use the platform default bank.' : 'Default bank cleared.');
    res.redirect(back('questions'));
  });
  r.post(`${base}/questions/:id/delete`, guard, async (req, res) => {
    await L.q('DELETE FROM questions WHERE id=? AND rpto_id <=> ?', [req.params.id, owner(req)]);
    res.redirect(back('questions'));
  });

  // ---- syllabus ----
  r.get(`${base}/syllabus.csv`, guard, async (req, res) => {
    const own = await syllabus(owner(req)), list = own.length ? own : await syllabus(null);
    L.sendCsv(res, 'syllabus.csv', [S_HEAD, ...list.map(s => [s.code, s.section, s.title, s.minutes, s.needs_log ? 'yes' : ''])]);
  });
  r.post(`${base}/syllabus/customise`, guard, async (req, res) => {
    if (!(await syllabus(owner(req))).length)
      await replaceAll('syllabus_items', 'code,section,title,minutes,needs_log,sort', owner(req), (await syllabus(null)).map(s => [s.code, s.section, s.title, s.minutes, s.needs_log, s.sort]));
    res.redirect(back('syllabus'));
  });
  r.post(`${base}/syllabus/reset`, guard, async (req, res) => {
    if (owner(req)) { await L.q('DELETE FROM syllabus_items WHERE rpto_id=?', [owner(req)]); res.flash('Back on the platform default syllabus.'); }
    res.redirect(back('syllabus'));
  });
  r.post(`${base}/syllabus/import`, guard, L.csvUpload.single('file'), async (req, res) => {
    const rows = req.file ? syllabusRows(L.parseCsv(req.file.buffer.toString('utf8'))) : [];
    if (!rows.length) res.flash('No valid syllabus rows found — nothing was changed. Use the template columns.');
    else { await replaceAll('syllabus_items', 'code,section,title,minutes,needs_log,sort', owner(req), rows); res.flash(`Syllabus replaced with ${rows.length} item(s). Re-run auto-schedule on batches to apply it.`); }
    res.redirect(back('syllabus'));
  });
  r.post(`${base}/syllabus`, guard, async (req, res) => {
    const it = syllabusItem(req.body);
    if (!it) res.flash('Code, section and title are required.');
    else if (owner(req) && !(await syllabus(owner(req))).length) res.flash('Customise the syllabus first.');
    else {
      const { n } = await L.one('SELECT COALESCE(MAX(sort),0)+1 n FROM syllabus_items WHERE rpto_id <=> ?', [owner(req)]);
      await L.q('INSERT INTO syllabus_items SET ?', [{ ...it, rpto_id: owner(req), sort: n }]);
    }
    res.redirect(back('syllabus'));
  });
  r.post(`${base}/syllabus/:id`, guard, async (req, res) => {
    const it = syllabusItem(req.body);
    if (it) await L.q('UPDATE syllabus_items SET ? WHERE id=? AND rpto_id <=> ?', [it, req.params.id, owner(req)]);
    else res.flash('Code, section and title are required.');
    res.redirect(back('syllabus'));
  });
  r.post(`${base}/syllabus/:id/delete`, guard, async (req, res) => {
    await L.q('DELETE FROM syllabus_items WHERE id=? AND rpto_id <=> ?', [req.params.id, owner(req)]);
    res.redirect(back('syllabus'));
  });
}

module.exports = { mount, questions, syllabus, questionRows, syllabusRows, SECTIONS };

// Training engine: syllabus, auto-scheduler (shared ground classes + per-trainee practical slots), progress,
// timeline moves, roll/certificate numbers, asset minimums, completion credits.
const { q, one, today, nextSeq } = require('./lib');

// Default syllabus (platform-wide). RPTOs can replace it under Settings → Syllabus, e.g. by importing the
// official DGCA training syllabus as CSV. Codes: G = ground class, W = workshop, S = simulator, F = flying, X = test.
const DEFAULT_SYLLABUS = [
  ['G1', 'theory', 'Drone Rules 2021 and the regulatory framework', 60],
  ['G2', 'theory', 'DigitalSky platform, airspace map and flight permissions', 45],
  ['G3', 'theory', 'Drone categories, classes and type certification', 30],
  ['G4', 'theory', 'Registration, UIN and the Remote Pilot Certificate', 30],
  ['G5', 'theory', 'Insurance, privacy and operating do’s and don’ts', 30],
  ['G6', 'theory', 'Principles of flight and aerodynamics', 60],
  ['G7', 'theory', 'Take-off, climb, cruise, turns and landing', 45],
  ['G8', 'theory', 'ATC basics and radio telephony', 60],
  ['G9', 'theory', 'Weather and meteorology for drone operations', 60],
  ['G10', 'theory', 'Batteries, motors, ESCs and propulsion', 45],
  ['G11', 'theory', 'Flight controller, GNSS and sensors', 45],
  ['G12', 'theory', 'Payloads and mission planning', 45],
  ['G13', 'theory', 'Risk assessment, safety management and TEM', 60],
  ['G14', 'theory', 'Emergency procedures and failsafes', 45],
  ['G15', 'theory', 'Drone data, mapping and basic analysis', 45],
  ['W1', 'workshop', 'Assembly, integration and pre-flight inspection', 90],
  ['W2', 'workshop', 'Maintenance, repairs and battery care', 90],
  ['S1', 'simulator', 'Simulator orientation and controls check', 15],
  ['S2', 'simulator', 'Take-off, hover and landing', 15],
  ['S3', 'simulator', 'Hover with orientation changes', 15],
  ['S4', 'simulator', 'Straight lines and rectangle pattern', 15],
  ['S5', 'simulator', 'Circuit pattern', 15],
  ['S6', 'simulator', 'Turns, climbs and descents', 15],
  ['S7', 'simulator', 'Figure-8 and orbit', 15],
  ['S8', 'simulator', 'Wind correction and drift', 15],
  ['S9', 'simulator', 'Emergency: GPS loss and manual recovery', 15],
  ['S10', 'simulator', 'Emergency: return-to-home and failsafes', 15],
  ['S11', 'simulator', 'Simulator practice assessment', 15],
  ['F1', 'flying', 'Field briefing and permission check', 15, 0],
  ['F2', 'flying', 'Pre-flight checks and safety briefing', 15, 0],
  ['F3', 'flying', 'Introductory flight with instructor', 15, 1],
  ['F4', 'flying', 'Take-off and landing', 15, 1],
  ['F5', 'flying', 'Hover control', 15, 1],
  ['F6', 'flying', 'Hover with orientation changes', 15, 1],
  ['F7', 'flying', 'Straight line forward and back', 15, 1],
  ['F8', 'flying', 'Square pattern', 15, 1],
  ['F9', 'flying', 'Rectangle / circuit pattern', 15, 1],
  ['F10', 'flying', 'Figure-8', 15, 1],
  ['F11', 'flying', 'Orbit around a point', 15, 1],
  ['F12', 'flying', 'Climbs, descents and altitude holds', 15, 1],
  ['F13', 'flying', 'Precision landing', 15, 1],
  ['F14', 'flying', 'Emergency: manual recovery', 15, 1],
  ['F15', 'flying', 'Emergency: return-to-home and failsafe', 15, 1],
  ['F16', 'flying', 'Solo practice and post-flight checks', 15, 1],
  ['X1', 'test', 'Theory examination', 60],
  ['X2', 'test', 'Simulator test', 60],
  ['X3', 'test', 'Practical flying test', 120],
].map(([code, section, title, minutes, needs_log = 0], sort) => ({ code, section, title, minutes, needs_log, sort }));

const PHASE = { theory: 'ground', workshop: 'ground', simulator: 'sim', flying: 'fly', test: 'test' };
const DAY_START = 7 * 60, DAY_END = 17 * 60;            // auto-schedule window
const TIMELINE_START = 6 * 60, TIMELINE_END = 19 * 60;   // manual moves may use 06:00–19:00

const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const iso = d => d.toISOString().slice(0, 10);
function nextWorkday(d) {
  const n = new Date(d); n.setUTCDate(n.getUTCDate() + 1);
  if (n.getUTCDay() === 0) n.setUTCDate(n.getUTCDate() + 1); // skip Sunday
  return n;
}
// Working-day index -> ISO date (Sundays skipped).
function calendar(startDate) {
  const days = [];
  let d = new Date(startDate + 'T00:00:00Z');
  if (d.getUTCDay() === 0) d = nextWorkday(d);
  return i => { while (days.length <= i) { days.push(iso(d)); d = nextWorkday(d); } return days[i]; };
}

// Shared classes, packed back to back; a new phase (ground -> test) starts on a new day.
function planShared(items, day0, delivery) {
  let day = day0, t = DAY_START, phase = null;
  const rows = items.map(it => {
    if ((phase && PHASE[it.section] !== phase) || t + it.minutes > DAY_END) { day++; t = DAY_START; }
    phase = PHASE[it.section];
    const r = { ...it, trainee: null, day, start: t, end: t + it.minutes, online: delivery === 'hybrid' && it.section === 'theory' };
    t += it.minutes;
    return r;
  });
  return { rows, next: rows.length ? day + 1 : day0 };
}

// Per-trainee simulator/flying slots. Greedy list scheduling on an absolute minute clock (day*1440 + minute):
// always book the trainee whose next exercise can start earliest. Flying needs an RPAS and an instructor,
// simulator needs a simulator seat; nothing ever double-books a trainee, RPAS, seat or instructor.
function planPractical(queues, { rpas = [], sim = [], instructors = [] }, day0, gap = 0) {
  const T0 = day0 * 1440 + DAY_START;
  const fit = (t, dur) => { let d = Math.floor(t / 1440), m = t - d * 1440; if (m < DAY_START) m = DAY_START; if (m + dur > DAY_END) { d++; m = DAY_START; } return d * 1440 + m; };
  const pool = list => (list.length ? list : [null]).map(id => ({ id, free: T0 }));
  const units = { flying: pool(rpas), simulator: pool(sim) }, inst = pool(instructors);
  const earliest = list => list.reduce((a, b) => (b.free < a.free ? b : a));
  const trFree = {}, todo = {};
  for (const [tr, list] of Object.entries(queues)) { trFree[tr] = T0; todo[tr] = [...list]; }
  const rows = [];
  let rr = 0;
  for (;;) {
    let best = null;
    for (const [tr, list] of Object.entries(todo)) {
      if (!list.length) continue;
      const it = list[0], unit = earliest(units[it.section]), ins = it.section === 'flying' ? earliest(inst) : null;
      const start = fit(Math.max(trFree[tr], unit.free, ins ? ins.free : 0), it.minutes);
      if (!best || start < best.start) best = { tr, it, unit, ins, start };
    }
    if (!best) break;
    const end = best.start + best.it.minutes;
    todo[best.tr].shift();
    trFree[best.tr] = end + gap;
    best.unit.free = end + gap;
    if (best.ins) best.ins.free = end;
    const instructor = best.ins ? best.ins.id : instructors.length ? instructors[rr++ % instructors.length] : null; // sim: assigned, not blocking
    rows.push({ ...best.it, trainee: +best.tr, asset: best.unit.id, instructor, day: Math.floor(best.start / 1440), start: best.start % 1440, end: end % 1440 });
  }
  return { rows, next: rows.length ? Math.max(...rows.map(r => r.day)) + 1 : day0 };
}

// Whole batch: ground classes -> per-trainee practical (flying/simulator interleaved) -> tests. Pure; unit-tested.
function planBatch({ startDate, items, trainees = [], units = {}, delivery = 'onsite', gap = 0, done = new Set() }) {
  const cal = calendar(startDate), isDone = (code, tr) => done.has(`${code}|${tr ?? ''}`);
  const shared = sections => items.filter(i => sections.includes(i.section) && !isDone(i.code, null));
  const g = planShared(shared(['theory', 'workshop']), 0, delivery);
  const fly = items.filter(i => i.section === 'flying'), sim = items.filter(i => i.section === 'simulator'), queues = {};
  for (const t of trainees) {
    const f = fly.filter(i => !isDone(i.code, t)), s = sim.filter(i => !isDone(i.code, t)), list = [];
    for (let k = 0; k < Math.max(f.length, s.length); k++) { if (f[k]) list.push(f[k]); if (s[k]) list.push(s[k]); }
    if (list.length) queues[t] = list;
  }
  const p = planPractical(queues, { rpas: units.rpas || [], sim: units.sim || [], instructors: units.instructors || [] }, g.next, gap);
  const x = planShared(shared(['test']), p.next, delivery);
  const ins = units.instructors || [];
  return [...g.rows, ...p.rows, ...x.rows].map((r, i) => ({
    ...r, date: cal(r.day), start: hhmm(r.start), end: hhmm(r.end),
    asset: r.trainee ? r.asset : (units.classroom || [])[0] ?? null,
    instructor: r.trainee ? r.instructor : ins.length ? ins[i % ins.length] : null,
  }));
}

// Question bank in use: the RPTO's own if it has any questions, else the platform default (rpto_id NULL).
// Use with `WHERE rpto_id <=> ?`.
async function bankOwner(rptoId) {
  return (await one('SELECT id FROM questions WHERE rpto_id=? LIMIT 1', [rptoId])) ? rptoId : null;
}

async function syllabusFor(rptoId) {
  const own = await q('SELECT * FROM syllabus_items WHERE rpto_id=? ORDER BY sort, id', [rptoId]);
  return own.length ? own : q('SELECT * FROM syllabus_items WHERE rpto_id IS NULL ORDER BY sort, id');
}

async function autoSchedule(batchId) {
  const b = await one('SELECT * FROM batches WHERE id=?', [batchId]);
  const items = await syllabusFor(b.rpto_id);
  const trainees = (await q("SELECT user_id FROM applications WHERE batch_id=? AND status='accepted' ORDER BY id", [batchId])).map(r => r.user_id);
  const alloc = await q(`SELECT r.kind, r.ref_id id, a.type, a.quantity FROM batch_resources r
    LEFT JOIN assets a ON r.kind='asset' AND a.id=r.ref_id WHERE r.batch_id=?`, [batchId]);
  const inService = await q("SELECT id, type, quantity FROM assets WHERE rpto_id=? AND status='in_service' ORDER BY id", [b.rpto_id]);
  // Allocated units of a type; if none were picked for that type, fall back to everything in service.
  const pick = type => { const a = alloc.filter(r => r.type === type); return (a.length ? a : inService.filter(x => x.type === type))
    .flatMap(x => (type === 'simulator' ? Array(Math.max(1, x.quantity || 1)).fill(x.id) : [x.id])); };
  let instructors = alloc.filter(r => r.kind === 'instructor').map(r => r.id);
  if (!instructors.length) instructors = (await q("SELECT DISTINCT user_id FROM members WHERE rpto_id=? AND role='Instructor' AND dgca_cert IS NOT NULL", [b.rpto_id])).map(r => r.user_id);
  const done = new Set((await q("SELECT code, trainee_id FROM sessions WHERE batch_id=? AND status='done' AND code IS NOT NULL", [batchId]))
    .map(r => `${r.code}|${r.trainee_id ?? ''}`));
  await q("DELETE FROM sessions WHERE batch_id=? AND status='scheduled'", [batchId]);
  const start = b.start_date && b.start_date > today() ? b.start_date : today();
  const plan = planBatch({ startDate: start, items, trainees, delivery: b.delivery, gap: b.slot_gap_min || 0, done,
    units: { rpas: pick('rpas'), sim: pick('simulator'), classroom: pick('classroom'), instructors } });
  if (plan.length) {
    await q(`INSERT INTO sessions (batch_id,trainee_id,code,type,title,date,start_time,end_time,instructor_id,asset_id,needs_log,notes) VALUES ?`,
      [plan.map(s => [batchId, s.trainee, s.code, s.section, s.title, s.date, s.start, s.end, s.instructor, s.asset, s.needs_log ? 1 : 0, s.online ? 'Online' : null])]);
    const dates = plan.map(s => s.date).sort();
    await q('UPDATE batches SET start_date=COALESCE(start_date,?), end_date=? WHERE id=?', [dates[0], dates.at(-1), batchId]);
  }
  if (!(await one('SELECT id FROM tests WHERE batch_id=? LIMIT 1', [batchId]))) {
    await q('INSERT INTO tests (batch_id,title,type,question_count) VALUES ?', [[[batchId, 'Theory examination', 'theory', 50],
      [batchId, 'Simulator test', 'simulator', 0], [batchId, 'Practical flying test', 'practical', 0]]]);
  }
  return { count: plan.length, trainees: trainees.length };
}

// Per-trainee progress. Shared classes count when the trainee was marked present; a trainee's own
// simulator/flying slots count when the slot is done.
async function batchProgress(batchId) {
  const trainees = await q(`SELECT a.id app_id, a.roll_no, a.cert_no, a.cert_issued_at, a.rpc_no, a.rpc_issued_at,
      u.id, u.name, u.email, u.phone,
      (SELECT COUNT(*) FROM trainee_documents d WHERE d.user_id=u.id AND d.status='verified' AND LEFT(d.doc_type, 6) <> 'other_') docs_ok
    FROM applications a JOIN users u ON u.id=a.user_id
    WHERE a.batch_id=? AND a.status='accepted' ORDER BY u.name`, [batchId]);
  const sessions = await q("SELECT id,type,status,trainee_id FROM sessions WHERE batch_id=? AND status<>'cancelled'", [batchId]);
  const att = await q('SELECT a.session_id, a.user_id, a.present, a.assessment FROM attendance a JOIN sessions s ON s.id=a.session_id WHERE s.batch_id=?', [batchId]);
  const tests = await q('SELECT id,title,type FROM tests WHERE batch_id=?', [batchId]);
  const results = await q('SELECT r.* FROM test_results r JOIN tests t ON t.id=r.test_id WHERE t.batch_id=? AND r.passed IS NOT NULL', [batchId]);
  for (const t of trainees) {
    const present = new Set(att.filter(a => a.user_id === t.id && a.present).map(a => a.session_id));
    const mine = sessions.filter(s => s.trainee_id === null || s.trainee_id === t.id);
    const ok = s => (s.trainee_id ? s.status === 'done' : present.has(s.id));
    const ground = mine.filter(s => s.trainee_id === null && PHASE[s.type] === 'ground');
    const training = mine.filter(s => s.type !== 'test');
    const own = type => mine.filter(s => s.trainee_id === t.id && s.type === type);
    t.classesComplete = ground.length > 0 && ground.every(s => present.has(s.id));
    t.attended = training.filter(ok).length;
    t.total = training.length;
    t.sim = { done: own('simulator').filter(ok).length, total: own('simulator').length };
    t.fly = { done: own('flying').filter(ok).length, total: own('flying').length };
    t.results = tests.map(x => ({ ...x, r: results.find(r => r.test_id === x.id && r.user_id === t.id) }));
    t.testsPassed = tests.length > 0 && t.results.every(x => x.r && x.r.passed);
    t.eligible = t.total > 0 && t.attended === t.total && t.testsPassed;
    t.stage = t.rpc_no ? 'RPC issued' : t.cert_no ? 'Certified' : t.eligible ? 'Ready to certify'
      : t.classesComplete ? 'Classes complete' : t.attended ? 'In training' : 'Admitted';
  }
  return { trainees, sessions, tests };
}

// "Slide to the last completed slot": everything up to and including `uptoId` is done, later slots are un-marked.
// Done flying slots that carry a real flight write the flight-ops log automatically.
async function setPracticalProgress(b, traineeId, type, uptoId, byUserId) {
  const list = await q(`SELECT s.*, (SELECT COUNT(*) FROM flight_logs f WHERE f.session_id=s.id AND f.track_id IS NOT NULL) has_log
    FROM sessions s WHERE s.batch_id=? AND s.trainee_id=? AND s.type=? AND s.status<>'cancelled' ORDER BY s.date, s.start_time, s.id`, [b.id, traineeId, type]);
  const idx = uptoId === 'none' ? -1 : list.findIndex(s => s.id === +uptoId);
  if (uptoId !== 'none' && idx < 0) return { error: 'Unknown session.' };
  const locked = list.slice(idx + 1).find(s => s.status === 'done' && s.has_log);
  if (locked) return { error: `${locked.code || locked.title} has a flight log attached — remove the log before un-marking it.` };
  const tr = await one('SELECT name FROM users WHERE id=?', [traineeId]);
  const field = await one("SELECT id, name FROM assets WHERE rpto_id=? AND type='field' AND status='in_service' ORDER BY id LIMIT 1", [b.rpto_id]);
  for (const [k, s] of list.entries()) {
    const done = k <= idx;
    if (done === (s.status === 'done')) continue;
    await q('UPDATE sessions SET status=? WHERE id=?', [done ? 'done' : 'scheduled', s.id]);
    if (done) {
      await q(`INSERT INTO attendance (session_id,user_id,present,marked_by) VALUES (?,?,1,?)
        ON DUPLICATE KEY UPDATE present=1, marked_by=VALUES(marked_by), marked_at=NOW()`, [s.id, traineeId, byUserId]);
      if (type === 'flying' && s.needs_log && !(await one('SELECT id FROM flight_logs WHERE session_id=? LIMIT 1', [s.id])))
        await q(`INSERT INTO flight_logs (rpto_id,session_id,date,time,activity_type,activity,pilot_id,pilot_name,instructor_id,rpas_id,field_id,place,minutes)
          VALUES (?,?,?,?,'training',?,?,?,?,?,?,?,?)`, [b.rpto_id, s.id, s.date, s.start_time, `${b.title} — ${s.code ? s.code + ' ' : ''}${s.title}`,
          traineeId, tr.name, s.instructor_id, s.asset_id, field?.id ?? null, field?.name ?? null, toMin(s.end_time) - toMin(s.start_time)]);
    } else {
      await q('DELETE FROM attendance WHERE session_id=? AND user_id=?', [s.id, traineeId]);
      if (type === 'flying') await q('DELETE FROM flight_logs WHERE session_id=? AND track_id IS NULL', [s.id]);
    }
  }
  return { done: idx + 1, total: list.length };
}

// Timeline move (pure). Lanes: a trainee's own slots form one lane; shared classes form another and may not
// overlap anyone's slots. Later neighbours in the lane are pushed only on real overlap (keeping `gap`);
// nothing may run outside 06:00–19:00 or double-book an RPAS / exceed a simulator's seats.
function applyMove(day, moved, start, end, { gap = 0, capacity = {} } = {}) {
  const label = s => s.code || s.title;
  if (start < TIMELINE_START || end > TIMELINE_END || end - start < 5) return { error: 'Sessions must stay between 06:00 and 19:00 and last at least 5 minutes.' };
  const others = day.filter(s => s.id !== moved.id).map(s => ({ ...s }));
  const inLane = s => (moved.trainee_id == null ? s.trainee_id == null : s.trainee_id === moved.trainee_id);
  const me = { ...moved, start, end }, lane = others.filter(inLane).sort((a, b) => a.start - b.start);
  const clash = lane.find(s => s.start < me.start && s.end > me.start);
  if (clash) return { error: `Overlaps ${label(clash)}.` };
  const changed = [me];
  let prevEnd = me.end;
  for (const s of lane.filter(s => s.start >= me.start)) {
    if (s.start < prevEnd) { const d = s.end - s.start; s.start = prevEnd + gap; s.end = s.start + d; changed.push(s); }
    if (s.end > TIMELINE_END) return { error: `That would push ${label(s)} past 19:00.` };
    prevEnd = Math.max(prevEnd, s.end);
  }
  const final = [...others.filter(s => !changed.includes(s)), ...changed];
  for (const c of changed) {
    const blocker = final.find(s => s !== c && s.id !== c.id && (c.trainee_id == null) !== (s.trainee_id == null)
      && (c.trainee_id == null || s.trainee_id == null) && s.start < c.end && s.end > c.start);
    if (blocker) return { error: `${label(c)} would overlap ${label(blocker)}.` };
    if (c.asset_id) {
      const busy = final.filter(s => s !== c && s.asset_id === c.asset_id && s.start < c.end && s.end > c.start).length;
      if (busy >= (capacity[c.asset_id] || 1)) return { error: `${label(c)}: that RPAS / simulator is already in use then.` };
    }
  }
  return { changes: changed.map(s => ({ id: s.id, start: s.start, end: s.end })) };
}

async function moveSession(sessionId, rptoId, { date, start, end }) {
  const s = await one(`SELECT s.*, b.rpto_id, b.records_locked, b.slot_gap_min FROM sessions s JOIN batches b ON b.id=s.batch_id
    WHERE s.id=? AND b.rpto_id=?`, [sessionId, rptoId]);
  if (!s) return { error: 'Session not found.' };
  if (s.records_locked) return { error: 'Records are locked for this batch.' };
  const day = (await q("SELECT id, trainee_id, asset_id, code, title, start_time, end_time FROM sessions WHERE batch_id=? AND date=? AND status<>'cancelled'", [s.batch_id, date]))
    .map(x => ({ ...x, start: toMin(x.start_time), end: toMin(x.end_time) }));
  const capacity = Object.fromEntries((await q("SELECT id, quantity FROM assets WHERE rpto_id=? AND type='simulator'", [rptoId])).map(a => [a.id, a.quantity || 1]));
  const r = applyMove(day, { ...s, start: toMin(s.start_time), end: toMin(s.end_time) }, start, end, { gap: s.slot_gap_min || 0, capacity });
  if (r.error) return r;
  const old = Object.fromEntries((await q('SELECT id, date, start_time, end_time FROM sessions WHERE id IN (?)', [r.changes.map(c => c.id)]))
    .map(x => [x.id, { date: x.date, start: toMin(x.start_time), end: toMin(x.end_time) }]));
  for (const c of r.changes) await q('UPDATE sessions SET date=?, start_time=?, end_time=? WHERE id=?', [date, hhmm(c.start), hhmm(c.end), c.id]);
  return { changes: r.changes.map(c => ({ ...c, date, old: old[c.id] })) };
}

async function nextRollNo(rpto, batch) {
  const n = await nextSeq('batches', batch.id, 'roll_seq');
  return (rpto.roll_format || '{CODE}/{BATCH}/{SEQ}')
    .replaceAll('{CODE}', rpto.roll_code || 'RPTO').replaceAll('{BATCH}', batch.batch_no || batch.id)
    .replaceAll('{YEAR}', new Date().getFullYear()).replaceAll('{SEQ}', String(n).padStart(3, '0'));
}

// The seven training-resource minimums checked before running batches (chargers/simulators/classrooms count their quantity).
async function minimums(rptoId) {
  const c = await one(`SELECT
    SUM(type='rpas' AND type_certified=1) rpas, SUM(type='battery') battery, SUM(IF(type='charger', COALESCE(quantity,1), 0)) charger,
    SUM(IF(type='simulator', COALESCE(quantity,1), 0)) simulator, SUM(IF(type='classroom', COALESCE(quantity,1), 0)) classroom, SUM(type='field') field
    FROM assets WHERE rpto_id=? AND status='in_service'`, [rptoId]);
  const inst = (await one(`SELECT COUNT(DISTINCT user_id) n FROM members WHERE rpto_id=? AND role='Instructor' AND dgca_cert IS NOT NULL`, [rptoId])).n;
  const list = [
    ['Type-certified RPAS', +c.rpas || 0, 1], ['Certified instructors', inst, 1], ['Batteries', +c.battery || 0, 2],
    ['Chargers', +c.charger || 0, 1], ['Simulators', +c.simulator || 0, 1], ['Classroom', +c.classroom || 0, 1], ['Flying field', +c.field || 0, 1],
  ].map(([label, have, min]) => ({ label, have, min, ok: have >= min }));
  return { list, ok: list.every(m => m.ok) };
}

// Everything needed for a trainee's training record / certificate. Scope by rptoId (staff) or userId (the trainee).
async function recordData(appId, { rptoId = null, userId = null }) {
  const a = await one(`SELECT a.*, u.name, u.email FROM applications a JOIN users u ON u.id=a.user_id
    WHERE a.id=? AND (? IS NULL OR a.rpto_id=?) AND (? IS NULL OR a.user_id=?)`, [appId, rptoId, rptoId, userId, userId]);
  if (!a || !a.batch_id) return null;
  const rpto = await one('SELECT * FROM rptos WHERE id=?', [a.rpto_id]);
  const u = await one('SELECT * FROM users WHERE id=?', [a.user_id]);
  const batch = await one('SELECT * FROM batches WHERE id=?', [a.batch_id]);
  const sessions = await q(`SELECT s.*, i.name instructor, at.present, at.assessment, at.remarks FROM sessions s
    LEFT JOIN users i ON i.id=s.instructor_id LEFT JOIN attendance at ON at.session_id=s.id AND at.user_id=?
    WHERE s.batch_id=? AND s.status<>'cancelled' AND (s.trainee_id IS NULL OR s.trainee_id=?) ORDER BY s.date, s.start_time`, [a.user_id, a.batch_id, a.user_id]);
  const results = await q(`SELECT t.title, t.type, t.pass_percent, r.score, r.total, r.passed, r.remarks, r.taken_at FROM tests t
    LEFT JOIN test_results r ON r.test_id=t.id AND r.user_id=? WHERE t.batch_id=?`, [a.user_id, a.batch_id]);
  const flights = await q(`SELECT f.*, r.name rpas, r.uin, bt.serial_no battery, i.name instructor FROM flight_logs f
    LEFT JOIN assets r ON r.id=f.rpas_id LEFT JOIN assets bt ON bt.id=f.battery_id LEFT JOIN users i ON i.id=f.instructor_id
    WHERE f.pilot_id=? AND f.rpto_id=? ORDER BY f.date, f.time`, [a.user_id, a.rpto_id]);
  const docs = await q('SELECT * FROM trainee_documents WHERE user_id=?', [a.user_id]);
  // RPA trainer signatory: the instructor who flew most with this trainee, else the RPTO's default trainer.
  const trainer = await one(`SELECT u.id, u.name, u.signature FROM flight_logs f JOIN users u ON u.id=f.instructor_id
      WHERE f.pilot_id=? AND f.rpto_id=? GROUP BY u.id, u.name, u.signature ORDER BY COUNT(*) DESC LIMIT 1`, [a.user_id, a.rpto_id])
    || (rpto.default_trainer_id && await one('SELECT id, name, signature FROM users WHERE id=?', [rpto.default_trainer_id]));
  return { a, rpto, u, batch, sessions, results, flights, docs, trainer: trainer || null };
}

// ---- Fees: amounts are stored GST-inclusive; receipts show the taxable value and GST ----
const round2 = n => Math.round(n * 100) / 100;
const withGst = (fee, gst) => round2(fee * (100 + (+gst || 0)) / 100);
function gstSplit(amount, gst) {
  const taxable = round2(amount * 100 / (100 + (+gst || 0)));
  return { taxable, gst: round2(amount - taxable) };
}
async function receiptData(paymentId, { rptoId = null, userId = null }) {
  const p = await one(`SELECT p.*, f.description, f.amount fee_amount, f.gst_percent, f.paid fee_paid, f.user_id, f.batch_id, u.name, u.email, u.phone,
      b.title batch, c.name received_by FROM fee_payments p JOIN fees f ON f.id=p.fee_id JOIN users u ON u.id=f.user_id
      LEFT JOIN batches b ON b.id=f.batch_id LEFT JOIN users c ON c.id=p.created_by
    WHERE p.id=? AND (? IS NULL OR p.rpto_id=?) AND (? IS NULL OR f.user_id=?)`, [paymentId, rptoId, rptoId, userId, userId]);
  if (!p) return null;
  const rpto = await one('SELECT * FROM rptos WHERE id=?', [p.rpto_id]);
  const paidBefore = (await one('SELECT COALESCE(SUM(amount),0) s FROM fee_payments WHERE fee_id=? AND id<?', [p.fee_id, p.id])).s;
  return { p, rpto, split: gstSplit(+p.amount, p.gst_percent), balance: round2(p.fee_amount - paidBefore - p.amount) };
}

// ---- Completion credits & partner programme (both off unless configured in .env) ----
const CREDIT_PRICE = +process.env.CREDIT_PRICE || 0;               // ₹ per completion credit; 0 = certificates are free
const PARTNER_SHARE = +process.env.PARTNER_SHARE_PERCENT || 0;     // % of Pilot Pro payments shared with the certifying RPTO
const PARTNER_MONTHS = +process.env.PARTNER_MONTHS || 12;
// "Current" pilot/instructor = at least CURRENCY.flights flights in the last CURRENCY.days days (internal recency rule).
const CURRENCY = { days: 90, flights: 1 };

// A certificate uses one completion credit unless the trainee has an active Pilot Pro plan.
// The decrement is a single conditional UPDATE, so the balance can never go below zero.
async function useCompletionCredit(rptoId, app, byUserId) {
  if (!CREDIT_PRICE) return { ok: true, free: true };
  const u = await one('SELECT pro_until >= CURDATE() pro FROM users WHERE id=?', [app.user_id]);
  if (u?.pro) return { ok: true, free: true };
  const x = await q('UPDATE rptos SET credits=credits-1 WHERE id=? AND credits>=1', [rptoId]);
  if (!x.affectedRows) return { ok: false };
  await q("INSERT INTO credit_ledger (rpto_id,delta,reason,application_id,created_by) VALUES (?,-1,'certificate',?,?)", [rptoId, app.id, byUserId]);
  return { ok: true };
}
async function addCredits(rptoId, delta, reason, { paymentId = null, note = null, by = null } = {}) {
  const x = await q('UPDATE rptos SET credits=credits+? WHERE id=? AND credits+?>=0', [delta, rptoId, delta]);
  if (x.affectedRows) await q('INSERT INTO credit_ledger (rpto_id,delta,reason,payment_id,note,created_by) VALUES (?,?,?,?,?,?)', [rptoId, delta, reason, paymentId, note, by]);
  return !!x.affectedRows;
}
// After a Pilot Pro payment: credit the RPTO that certified this pilot within PARTNER_MONTHS.
async function partnerShare(payment) {
  if (!PARTNER_SHARE || !String(payment.plan).startsWith('pro_')) return null;
  const a = await one(`SELECT rpto_id FROM applications WHERE user_id=? AND cert_no IS NOT NULL AND cert_issued_at >= NOW() - INTERVAL ? MONTH
    ORDER BY cert_issued_at DESC LIMIT 1`, [payment.user_id, PARTNER_MONTHS]);
  if (!a) return null;
  const amount = Math.round(payment.amount_paise * PARTNER_SHARE / 100);
  await q('INSERT IGNORE INTO partner_earnings (rpto_id,payment_id,user_id,amount_paise) VALUES (?,?,?,?)', [a.rpto_id, payment.id, payment.user_id, amount]);
  return { rpto_id: a.rpto_id, amount };
}

module.exports = {
  DEFAULT_SYLLABUS, PHASE, planShared, planPractical, planBatch, applyMove, hhmm, toMin,
  bankOwner, syllabusFor, autoSchedule, batchProgress, setPracticalProgress, moveSession, nextRollNo, minimums, recordData,
  CREDIT_PRICE, PARTNER_SHARE, PARTNER_MONTHS, CURRENCY, useCompletionCredit, addCredits, partnerShare,
  withGst, gstSplit, receiptData,
};

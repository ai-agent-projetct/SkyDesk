// Personal flight logs + 3D replay (any signed-in user can log their own flights).
const r = require('express').Router();
const fs = require('fs');
const L = require('../lib');
const { parse } = require('../flightlog');

r.use(L.need(() => true));
const FREE_LIMIT = +process.env.FREE_FLIGHT_LIMIT || 25;
const isPro = u => u.role !== 'student' || (u.pro_until && u.pro_until >= L.today());

// Parse an uploaded log file into a tracks row. Returns { id } or { error }.
async function saveTrack(file, { userId, uploadedBy, rptoId = null, notes = null }) {
  let t;
  try { t = parse(fs.readFileSync(file.path)); }
  catch (e) { fs.unlink(file.path, () => {}); return { error: `Could not read ${file.originalname}: ${e.message}` }; }
  const json = v => (v == null ? null : JSON.stringify(v));
  const series = { ...(t.series || {}), events: t.events, fence: t.fence, vehicle: t.vehicle }; // graphs + timeline + geofence
  const x = await L.q(`INSERT INTO tracks (user_id,uploaded_by,rpto_id,file,original_name,format,started_at,duration_s,distance_m,max_alt_m,max_speed,bat_unit,
      points,series,params,analysis,mission,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [userId, uploadedBy, rptoId, file.filename, file.originalname, t.format, t.startedAt,
    t.duration_s, t.distance_m, t.max_alt_m, t.max_speed, t.bat_unit, json(t.points), json(series), json(t.params), json(t.analysis), json(t.mission?.length ? t.mission : null), notes]);
  return { id: x.insertId, track: t };
}

// Who may open a track: the pilot, RPTO staff of an RPTO the pilot trains with, or the platform admin.
async function canView(u, t) {
  if (u.role === 'super_admin' || t.user_id === u.id) return true;
  return u.role === 'member' && (t.rpto_id === u.rpto_id || !!await L.one('SELECT 1 x FROM applications WHERE user_id=? AND rpto_id=?', [t.user_id, u.rpto_id]));
}

r.get('/', async (req, res) => {
  const tracks = await L.q(`SELECT t.id, t.original_name, t.format, t.started_at, t.duration_s, t.distance_m, t.max_alt_m, t.max_speed, t.created_at, t.notes,
      f.id log_id, f.activity FROM tracks t LEFT JOIN flight_logs f ON f.track_id=t.id WHERE t.user_id=? ORDER BY COALESCE(t.started_at, t.created_at) DESC`, [req.user.id]);
  const used = (await L.one('SELECT COUNT(*) n FROM tracks WHERE uploaded_by=? AND user_id=?', [req.user.id, req.user.id])).n;
  const months = await L.q(`SELECT DATE_FORMAT(COALESCE(started_at, created_at), '%Y-%m') ym, COUNT(*) n, SUM(duration_s) s FROM tracks
    WHERE user_id=? GROUP BY ym ORDER BY ym DESC LIMIT 6`, [req.user.id]);
  res.render('flights/list', { tracks, used, limit: isPro(req.user) ? null : FREE_LIMIT, months: months.reverse() });
});

r.post('/', L.logUpload.single('file'), async (req, res) => {
  if (!req.file) { res.flash('Choose a .bin, .log, .ulg, .csv or .txt flight log.'); return res.redirect('/flights'); }
  if (!isPro(req.user)) {
    const used = (await L.one('SELECT COUNT(*) n FROM tracks WHERE uploaded_by=? AND user_id=?', [req.user.id, req.user.id])).n;
    if (used >= FREE_LIMIT) { fs.unlink(req.file.path, () => {}); res.flash(`The free plan includes ${FREE_LIMIT} flights. Upgrade under Plans & billing for unlimited flights.`); return res.redirect('/flights'); }
  }
  const x = await saveTrack(req.file, { userId: req.user.id, uploadedBy: req.user.id, notes: req.body.notes || null });
  if (x.error) { res.flash(x.error); return res.redirect('/flights'); }
  res.redirect('/flights/' + x.id);
});

// Personal pilot logbook: RPTO training flights, own uploaded flights (a track linked to a training flight counts once),
// manual entries, and — for instructors — flights they supervised ("Instructing", kept out of the pilot's own totals).
async function pilotLog(userId) {
  const { CURRENCY } = require('../training');
  const training = await L.q(`SELECT f.date, f.time, f.activity, f.minutes, f.place, f.remarks, f.track_id, a.name rpas, a.uin, b.serial_no battery,
      i.name instructor, r.name rpto, t.max_alt_m FROM flight_logs f JOIN rptos r ON r.id=f.rpto_id LEFT JOIN assets a ON a.id=f.rpas_id
      LEFT JOIN assets b ON b.id=f.battery_id LEFT JOIN users i ON i.id=f.instructor_id LEFT JOIN tracks t ON t.id=f.track_id WHERE f.pilot_id=?`, [userId]);
  const personal = await L.q(`SELECT t.id track_id, DATE(COALESCE(t.started_at, t.created_at)) date, TIME(COALESCE(t.started_at, t.created_at)) time,
      t.original_name, t.notes, t.duration_s, t.distance_m, t.max_alt_m, t.max_speed, t.logged, t.exercise, t.rpic, t.place, d.name drone, d.uin, b.name battery, b.serial_no bsn
    FROM tracks t LEFT JOIN pilot_assets d ON d.id=t.drone_id LEFT JOIN pilot_assets b ON b.id=t.battery_id
    WHERE t.user_id=? AND NOT EXISTS (SELECT 1 FROM flight_logs f WHERE f.track_id=t.id)`, [userId]);
  const manual = await L.q(`SELECT e.*, d.name drone, d.uin, b.name battery, b.serial_no bsn FROM pilot_entries e
    LEFT JOIN pilot_assets d ON d.id=e.drone_id LEFT JOIN pilot_assets b ON b.id=e.battery_id WHERE e.user_id=?`, [userId]);
  const instructing = await L.q(`SELECT f.date, f.time, f.activity, f.minutes, f.place, f.pilot_name, f.track_id, a.name rpas, a.uin, r.name rpto
    FROM flight_logs f JOIN rptos r ON r.id=f.rpto_id LEFT JOIN assets a ON a.id=f.rpas_id WHERE f.instructor_id=? AND (f.pilot_id IS NULL OR f.pilot_id<>?)`, [userId, userId]);
  const craft = (name, uin) => [name, uin].filter(Boolean).join(' · ');
  const rows = [
    ...training.map(f => ({ kind: 'Training', date: f.date, time: f.time, activity: f.activity, aircraft: craft(f.rpas, f.uin),
      place: f.place, minutes: f.minutes, maxAlt: f.max_alt_m, instructor: f.instructor, org: f.rpto, remarks: [f.battery && 'Battery ' + f.battery, f.remarks].filter(Boolean).join(' · '), track: f.track_id })),
    ...personal.map(t => ({ kind: 'Personal', date: t.date, time: t.time, activity: t.exercise || t.notes || t.original_name, aircraft: craft(t.drone, t.uin), place: t.place || '',
      minutes: Math.ceil(t.duration_s / 60), maxAlt: t.max_alt_m, distance: t.distance_m, speed: t.max_speed, instructor: t.rpic ? 'RPIC ' + t.rpic : '', org: '',
      remarks: [t.battery && `Battery ${t.bsn || t.battery}`, `${t.distance_m} m flown`].filter(Boolean).join(' · '), track: t.track_id, logged: !!t.logged })),
    ...manual.map(e => ({ kind: 'Manual', date: e.date, time: e.start_time, activity: e.exercise || 'Flight', aircraft: craft(e.drone, e.uin), place: e.place || '',
      minutes: e.minutes, maxAlt: null, instructor: e.rpic ? 'RPIC ' + e.rpic : '', org: '', remarks: [e.battery && `Battery ${e.bsn || e.battery}`, e.remarks].filter(Boolean).join(' · '), entry: e.id })),
    ...instructing.map(f => ({ kind: 'Instructing', date: f.date, time: f.time, activity: `${f.activity} — trainee ${f.pilot_name || ''}`, aircraft: craft(f.rpas, f.uin),
      place: f.place, minutes: f.minutes, maxAlt: null, instructor: '', org: f.rpto, remarks: '', track: f.track_id })),
  ].sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));
  let total = 0, taught = 0;
  for (const row of rows) { if (row.kind === 'Instructing') taught += row.minutes; else total += row.minutes; row.cumulative = total; }
  const own = rows.filter(x => x.kind !== 'Instructing');
  const since = L.daysAgo(CURRENCY.days), recent = own.filter(x => x.date >= since).length;
  const months = Array.from({ length: 6 }, (_, k) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 5 + k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })
    .map(ym => ({ ym, minutes: own.filter(x => x.date.startsWith(ym)).reduce((s, x) => s + x.minutes, 0) }));
  return {
    rows,
    stats: { flights: own.length, minutes: total, training: training.length, personal: personal.length, manual: manual.length,
      instructing: instructing.length, instructingMinutes: taught, last: own.at(-1)?.date || null, lastRow: own.at(-1) || null,
      recent, current: recent >= CURRENCY.flights, days: CURRENCY.days, maxAlt: Math.max(0, ...own.map(x => +x.maxAlt || 0)), months },
  };
}
r.get('/logbook', (req, res) => res.redirect('/pilot/logbook' + (req.query.export ? '?export=1' : ''))); // moved to the pilot hub

// "Push to logbook": the pilot confirms which drone / battery flew, the exercise, RPIC and place.
r.post('/:id/logbook', async (req, res) => {
  const t = await L.one('SELECT * FROM tracks WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!t) return res.redirect('/flights');
  const mine = async (id, type) => id && (await L.one('SELECT id FROM pilot_assets WHERE id=? AND user_id=? AND type=?', [id, req.user.id, type])) ? +id : null;
  const x = req.body, cut = (v, n) => String(v || '').trim().slice(0, n) || null;
  await L.q('UPDATE tracks SET logged=1, drone_id=?, battery_id=?, exercise=?, rpic=?, place=?, notes=? WHERE id=?',
    [await mine(x.drone_id, 'drone'), await mine(x.battery_id, 'battery'), cut(x.exercise, 200), cut(x.rpic, 150), cut(x.place, 150), cut(x.notes, 255) ?? t.notes, t.id]);
  res.flash('Saved to your logbook.');
  res.redirect('/flights/' + t.id);
});

const viewable = async (req, res) => {
  const t = await L.one(`SELECT t.*, u.name pilot FROM tracks t JOIN users u ON u.id=t.user_id WHERE t.id=?`, [req.params.id]);
  if (t && await canView(req.user, t)) return t;
  res.status(404).render('message', { title: 'Not found', text: 'Flight not found.' });
  return null;
};
r.get('/:id', async (req, res) => {
  const t = await viewable(req, res);
  if (!t) return;
  const log = await L.one(`SELECT f.*, r.name rpas, b.title batch FROM flight_logs f LEFT JOIN assets r ON r.id=f.rpas_id
    LEFT JOIN sessions s ON s.id=f.session_id LEFT JOIN batches b ON b.id=s.batch_id WHERE f.track_id=? LIMIT 1`, [t.id]);
  const { events = null, fence = null, vehicle = null, ...series } = t.series || {};
  const data = JSON.stringify({ points: t.points, batUnit: t.bat_unit, series, events, fence, mission: t.mission || [] }).replace(/</g, '\\u003c');
  const fleet = t.user_id === req.user.id ? await L.q("SELECT id, type, name, serial_no, uin FROM pilot_assets WHERE user_id=? AND status<>'retired' ORDER BY type, name", [req.user.id]) : [];
  res.render('flights/replay', { t, log, data, fleet, events, vehicle, tab: req.query.tab || 'replay' });
});
// Suggested PID changes as a parameter file for Mission Planner / QGroundControl.
r.get('/:id/pid.param', async (req, res) => {
  const t = await viewable(req, res);
  if (!t) return;
  const vehicle = t.series?.vehicle, body = require('../analysis').paramFile(t.analysis?.pid, vehicle);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="flight-${t.id}-pid-suggestions.${vehicle === 'px4' ? 'params' : 'param'}"`);
  res.send(body);
});
// Printable flight report (Print / Save as PDF in the browser).
r.get('/:id/report', async (req, res) => {
  const t = await viewable(req, res);
  if (!t) return;
  const log = await L.one('SELECT f.*, r.name rpas, r.uin FROM flight_logs f LEFT JOIN assets r ON r.id=f.rpas_id WHERE f.track_id=? LIMIT 1', [t.id]);
  const drone = t.drone_id && await L.one('SELECT name, uin FROM pilot_assets WHERE id=?', [t.drone_id]);
  res.render('flights/report', { t, log, drone, events: t.series?.events || null });
});

r.post('/:id/delete', async (req, res) => {
  const t = await L.one('SELECT * FROM tracks WHERE id=?', [req.params.id]);
  const linked = t && await L.one('SELECT id FROM flight_logs WHERE track_id=?', [t.id]);
  if (!t || (t.user_id !== req.user.id && t.uploaded_by !== req.user.id)) return res.redirect('/flights');
  if (linked) { res.flash('This flight is part of a training record and cannot be deleted.'); return res.redirect('/flights/' + t.id); }
  await L.q('DELETE FROM tracks WHERE id=?', [t.id]);
  fs.unlink(require('path').join(L.UPLOAD_DIR, t.file), () => {});
  res.flash('Flight deleted.');
  res.redirect('/flights');
});

module.exports = r;
module.exports.saveTrack = saveTrack;
module.exports.pilotLog = pilotLog;

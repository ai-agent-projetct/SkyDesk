// Pilot hub for every signed-in pilot (students and RPTO staff): dashboard, own fleet, logbooks, tutorials, live monitor.
const r = require('express').Router();
const L = require('../lib');
const { pilotLog } = require('./flights');
const { toMin } = require('../training');

r.use(L.need(u => u.role !== 'super_admin'));
const cut = (v, n) => String(v ?? '').trim().slice(0, n) || null;
const num = v => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
const notFound = res => res.status(404).render('message', { title: 'Not found', text: 'That record does not exist.' });

// Own drones and batteries with usage: flights/minutes from uploaded logs + manual entries; battery cycles.
async function fleet(userId) {
  const assets = await L.q(`SELECT a.*,
      (SELECT COUNT(*) FROM tracks t WHERE t.user_id=a.user_id AND (t.drone_id=a.id OR t.battery_id=a.id)) +
      (SELECT COUNT(*) FROM pilot_entries e WHERE e.user_id=a.user_id AND (e.drone_id=a.id OR e.battery_id=a.id)) flights,
      COALESCE((SELECT SUM(CEIL(t.duration_s/60)) FROM tracks t WHERE t.user_id=a.user_id AND (t.drone_id=a.id OR t.battery_id=a.id)),0) +
      COALESCE((SELECT SUM(e.minutes) FROM pilot_entries e WHERE e.user_id=a.user_id AND (e.drone_id=a.id OR e.battery_id=a.id)),0) minutes,
      (SELECT MAX(DATE(COALESCE(t.started_at, t.created_at))) FROM tracks t WHERE t.user_id=a.user_id AND (t.drone_id=a.id OR t.battery_id=a.id)) track_last,
      (SELECT MAX(e.date) FROM pilot_entries e WHERE e.user_id=a.user_id AND (e.drone_id=a.id OR e.battery_id=a.id)) entry_last,
      (SELECT MIN(m.next_due) FROM pilot_maintenance m WHERE m.asset_id=a.id AND m.next_due IS NOT NULL
        AND m.date=(SELECT MAX(m2.date) FROM pilot_maintenance m2 WHERE m2.asset_id=a.id)) next_due
    FROM pilot_assets a WHERE a.user_id=? ORDER BY a.status='retired', a.type, a.name`, [userId]);
  for (const a of assets) {
    a.flights = +a.flights; a.minutes = +a.minutes;
    a.last_used = [a.track_last, a.entry_last].filter(Boolean).sort().at(-1) || null;
    a.cycles = (a.initial_cycles || 0) + a.flights;
  }
  return { drones: assets.filter(a => a.type === 'drone'), batteries: assets.filter(a => a.type === 'battery'), all: assets };
}

// What needs attention: overdue/soon maintenance, worn batteries, grounded drones, licence, currency, unreviewed uploads.
function attention(user, f, stats, unlogged) {
  const soon = L.daysAgo(-14), list = [];
  for (const a of f.all.filter(x => x.status !== 'retired')) {
    if (a.next_due && a.next_due <= soon) list.push({ level: a.next_due < L.today() ? 'bad' : 'warn', text: `${a.name}: maintenance ${a.next_due < L.today() ? 'overdue since' : 'due'} ${a.next_due}`, href: `/pilot/fleet/${a.id}` });
    if (a.status === 'maintenance') list.push({ level: 'warn', text: `${a.name} is marked in maintenance`, href: `/pilot/fleet/${a.id}` });
    if (a.type === 'battery' && a.max_cycles && a.cycles >= a.max_cycles * 0.9)
      list.push({ level: a.cycles >= a.max_cycles ? 'bad' : 'warn', text: `${a.name} ${a.serial_no || ''}: ${a.cycles}/${a.max_cycles} cycles — plan a replacement`, href: `/pilot/fleet/${a.id}` });
  }
  if (user.license_expiry && user.license_expiry <= L.daysAgo(-60))
    list.push({ level: user.license_expiry < L.today() ? 'bad' : 'warn', text: `Remote pilot licence ${user.license_expiry < L.today() ? 'expired' : 'expires'} ${user.license_expiry}`, href: '/account' });
  if (stats.flights && !stats.current) list.push({ level: 'warn', text: `No flight in the last ${stats.days} days — you are not current`, href: '/simulator' });
  if (unlogged) list.push({ level: 'info', text: `${unlogged} uploaded flight(s) not yet added to your logbook (drone, battery, exercise)`, href: '/flights' });
  return list;
}

r.get('/', async (req, res) => {
  const uid = req.user.id, { rows, stats } = await pilotLog(uid), f = await fleet(uid);
  const own = rows.filter(x => x.kind !== 'Instructing'), ym = L.today().slice(0, 7), month = own.filter(x => x.date.startsWith(ym));
  const unlogged = (await L.one('SELECT COUNT(*) n FROM tracks t WHERE t.user_id=? AND t.logged=0 AND NOT EXISTS (SELECT 1 FROM flight_logs l WHERE l.track_id=t.id)', [uid])).n;
  const best = (key) => own.reduce((b, x) => (+x[key] || 0) > (+b?.[key] || 0) ? x : b, null);
  const sim = await L.one('SELECT COUNT(*) n, SUM(passed) passed, COALESCE(SUM(seconds),0) s FROM sim_runs WHERE user_id=?', [uid]);
  res.render('pilot/home', {
    stats, f, sim, recent: own.slice(-5).reverse(), last: stats.lastRow, attention: attention(req.user, f, stats, unlogged),
    month: { flights: month.length, minutes: month.reduce((s, x) => s + x.minutes, 0) },
    bests: { longest: best('minutes'), highest: best('maxAlt'), farthest: best('distance'), fastest: best('speed') },
  });
});

// ---- Fleet ----
const ASSET_FIELDS = x => ({
  type: x.type === 'battery' ? 'battery' : 'drone', name: cut(x.name, 150), make: cut(x.make, 150), uin: cut(x.uin, 60), serial_no: cut(x.serial_no, 100),
  category: cut(x.category, 40), rpas_class: cut(x.rpas_class, 20), type_certified: x.type_certified ? 1 : 0, capacity_mah: num(x.capacity_mah), voltage: num(x.voltage),
  cells: num(x.cells), initial_cycles: Math.max(0, num(x.initial_cycles) || 0), max_cycles: num(x.max_cycles), acquired_on: /^\d{4}-\d{2}-\d{2}$/.test(x.acquired_on || '') ? x.acquired_on : null,
  status: ['active', 'maintenance', 'retired'].includes(x.status) ? x.status : 'active', notes: cut(x.notes, 255),
});
r.get('/fleet', async (req, res) => res.render('pilot/fleet', { f: await fleet(req.user.id) }));
r.post('/fleet', async (req, res) => {
  const a = ASSET_FIELDS(req.body);
  if (!a.name) res.flash('Give the drone or battery a name.');
  else await L.q('INSERT INTO pilot_assets SET ?', [{ ...a, user_id: req.user.id }]);
  res.redirect('/pilot/fleet');
});
const myAsset = (req, id) => L.one('SELECT * FROM pilot_assets WHERE id=? AND user_id=?', [id, req.user.id]);
r.get('/fleet/:id', async (req, res) => {
  const a = (await fleet(req.user.id)).all.find(x => x.id === +req.params.id);
  if (!a) return notFound(res);
  const col = a.type === 'drone' ? 'drone_id' : 'battery_id';
  const flights = [
    ...(await L.q(`SELECT t.id track, DATE(COALESCE(t.started_at, t.created_at)) date, TIME(COALESCE(t.started_at, t.created_at)) time, CEIL(t.duration_s/60) minutes,
        COALESCE(t.exercise, t.notes, t.original_name) activity, t.place FROM tracks t WHERE t.user_id=? AND t.${col}=?`, [req.user.id, a.id])),
    ...(await L.q(`SELECT NULL track, e.date, e.start_time time, e.minutes, COALESCE(e.exercise, 'Flight') activity, e.place FROM pilot_entries e WHERE e.user_id=? AND e.${col}=?`, [req.user.id, a.id])),
  ].sort((x, y) => `${x.date} ${x.time || ''}`.localeCompare(`${y.date} ${y.time || ''}`));
  const maintenance = await L.q('SELECT * FROM pilot_maintenance WHERE asset_id=? ORDER BY date DESC, id DESC', [a.id]);
  res.render('pilot/asset', { a, flights, maintenance });
});
r.post('/fleet/:id', async (req, res) => {
  const a = await myAsset(req, req.params.id), x = ASSET_FIELDS({ ...req.body, type: a?.type });
  if (a && x.name) await L.q('UPDATE pilot_assets SET ? WHERE id=?', [x, a.id]);
  res.redirect('/pilot/fleet/' + req.params.id);
});
r.post('/fleet/:id/delete', async (req, res) => {
  await L.q('DELETE FROM pilot_assets WHERE id=? AND user_id=?', [req.params.id, req.user.id]); // flights keep their record, the link is cleared
  res.flash('Removed from your fleet.');
  res.redirect('/pilot/fleet');
});
r.post('/fleet/:id/maintenance', async (req, res) => {
  const a = await myAsset(req, req.params.id), x = req.body;
  if (!a || !/^\d{4}-\d{2}-\d{2}$/.test(x.date || '')) { res.flash('Pick a date.'); return res.redirect('/pilot/fleet/' + req.params.id); }
  await L.q('INSERT INTO pilot_maintenance (user_id,asset_id,date,type,description,next_due) VALUES (?,?,?,?,?,?)',
    [req.user.id, a.id, x.date, ['inspection', 'repair', 'replacement', 'firmware', 'other'].includes(x.type) ? x.type : 'inspection', cut(x.description, 2000),
      /^\d{4}-\d{2}-\d{2}$/.test(x.next_due || '') ? x.next_due : null]);
  if (['active', 'maintenance', 'retired'].includes(x.set_status)) await L.q('UPDATE pilot_assets SET status=? WHERE id=?', [x.set_status, a.id]);
  res.redirect('/pilot/fleet/' + a.id);
});
r.post('/maintenance/:id/delete', async (req, res) => {
  const m = await L.one('SELECT * FROM pilot_maintenance WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (m) await L.q('DELETE FROM pilot_maintenance WHERE id=?', [m.id]);
  res.redirect(m ? '/pilot/fleet/' + m.asset_id : '/pilot/fleet');
});

// ---- Logbooks ----
// Times are stored as entered (local). ?utc=1 shows them in UTC using the server's time zone.
const toUtc = (date, time) => { if (!time) return [date, time]; const d = new Date(`${date}T${String(time).slice(0, 8)}`); return isNaN(d) ? [date, time] : [d.toISOString().slice(0, 10), d.toISOString().slice(11, 19)]; };
r.get('/logbook', async (req, res) => {
  const uid = req.user.id, book = ['pilot', 'drone', 'battery', 'maintenance', 'sim'].includes(req.query.book) ? req.query.book : 'pilot', utc = req.query.utc === '1';
  const { rows, stats } = await pilotLog(uid), f = await fleet(uid);
  const shown = rows.map(x => { const [date, time] = utc ? toUtc(x.date, x.time) : [x.date, x.time]; return { ...x, date, time }; });
  const d = { book, utc, stats, f, rows: shown, asset: null, maintenance: [], sims: [], simBest: [] };
  if (book === 'drone' || book === 'battery') {
    const list = book === 'drone' ? f.drones : f.batteries;
    d.asset = list.find(a => a.id === +req.query.asset) || list[0] || null;
  }
  if (book === 'maintenance') d.maintenance = await L.q('SELECT m.*, a.name, a.type, a.serial_no, a.uin FROM pilot_maintenance m JOIN pilot_assets a ON a.id=m.asset_id WHERE m.user_id=? ORDER BY m.date DESC, m.id DESC', [uid]);
  if (book === 'sim') {
    d.sims = await L.q('SELECT * FROM sim_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 500', [uid]);
    d.simBest = await L.q('SELECT exercise, COUNT(*) runs, SUM(passed) passed, MIN(IF(passed, seconds, NULL)) best, SUM(seconds) total FROM sim_runs WHERE user_id=? GROUP BY exercise ORDER BY exercise', [uid]);
  }
  if (d.asset) {
    const col = d.asset.type === 'drone' ? 'drone_id' : 'battery_id';
    const ids = new Set([...(await L.q(`SELECT id FROM tracks WHERE user_id=? AND ${col}=?`, [uid, d.asset.id])).map(t => 't' + t.id),
      ...(await L.q(`SELECT id FROM pilot_entries WHERE user_id=? AND ${col}=?`, [uid, d.asset.id])).map(e => 'e' + e.id)]);
    let run = 0, cyc = d.asset.initial_cycles || 0;
    d.rows = shown.filter(x => ids.has(x.track ? 't' + x.track : 'e' + x.entry)).map(x => ({ ...x, cumulative: run += x.minutes, cycle: ++cyc }));
  }
  if (req.query.export) {
    const tz = utc ? ' (UTC)' : '';
    if (book === 'maintenance') return L.sendCsv(res, 'maintenance-logbook.csv', [['Date', 'Asset', 'Type', 'Work done', 'Next due'], ...d.maintenance.map(m => [m.date, m.name, m.type, m.description, m.next_due])]);
    if (book === 'sim') return L.sendCsv(res, 'simulator-log.csv', [['Date', 'Exercise', 'Result', 'Seconds', 'Penalties'], ...d.sims.map(s => [s.created_at, s.exercise, s.passed ? 'Pass' : 'Fail', s.seconds, s.penalties])]);
    return L.sendCsv(res, `${book}-logbook.csv`, [['Date' + tz, 'Time' + tz, 'Type', 'Activity', 'Aircraft (UIN)', 'Place', 'Minutes', 'Cumulative minutes', ...(book === 'battery' ? ['Cycle'] : []), 'Max alt (m)', 'Instructor / RPIC', 'Organisation', 'Remarks'],
      ...d.rows.map(x => [x.date, x.time, x.kind, x.activity, x.aircraft, x.place, x.minutes, x.cumulative, ...(book === 'battery' ? [x.cycle] : []), x.maxAlt, x.instructor, x.org, x.remarks])]);
  }
  res.render('pilot/logbook', d);
});
r.post('/entries', async (req, res) => {
  const x = req.body, uid = req.user.id;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date || '')) { res.flash('Pick the flight date.'); return res.redirect('/pilot/logbook'); }
  const mine = async (id, type) => id && (await L.one('SELECT id FROM pilot_assets WHERE id=? AND user_id=? AND type=?', [id, uid, type])) ? +id : null;
  const t = v => (/^\d{2}:\d{2}/.test(v || '') ? v : null);
  const span = t(x.start_time) && t(x.end_time) ? (toMin(x.end_time) - toMin(x.start_time) + 1440) % 1440 : 0;
  const minutes = Math.max(0, Math.min(1440, num(x.minutes) ?? span));
  await L.q(`INSERT INTO pilot_entries (user_id,date,start_time,end_time,minutes,drone_id,battery_id,place,lat,lon,rpic,exercise,remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uid, x.date, t(x.start_time), t(x.end_time), minutes, await mine(x.drone_id, 'drone'), await mine(x.battery_id, 'battery'), cut(x.place, 150),
      num(x.lat), num(x.lon), cut(x.rpic, 150), cut(x.exercise, 200), cut(x.remarks, 255)]);
  res.flash('Logbook entry added.');
  res.redirect('/pilot/logbook');
});
r.post('/entries/:id/delete', async (req, res) => {
  await L.q('DELETE FROM pilot_entries WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.redirect('/pilot/logbook');
});

// ---- Tutorials (managed by the platform admin) ----
r.get('/tutorials', async (req, res) => {
  const list = await L.q('SELECT t.*, (SELECT COUNT(*) FROM tutorial_comments c WHERE c.tutorial_id=t.id) comments FROM tutorials t ORDER BY t.category, t.sort, t.id');
  res.render('pilot/tutorials', { list });
});
r.get('/tutorials/:id', async (req, res) => {
  const t = await L.one('SELECT * FROM tutorials WHERE id=?', [req.params.id]);
  if (!t) return notFound(res);
  const comments = await L.q('SELECT c.*, u.name, u.avatar FROM tutorial_comments c JOIN users u ON u.id=c.user_id WHERE c.tutorial_id=? ORDER BY c.id', [t.id]);
  res.render('pilot/tutorial', { t, comments, embed: embedUrl(t.video_url) });
});
r.post('/tutorials/:id/comments', async (req, res) => {
  const body = cut(req.body.body, 1000);
  if (body && await L.one('SELECT id FROM tutorials WHERE id=?', [req.params.id])) await L.q('INSERT INTO tutorial_comments (tutorial_id,user_id,body) VALUES (?,?,?)', [req.params.id, req.user.id, body]);
  res.redirect(`/pilot/tutorials/${req.params.id}#comments`);
});
r.post('/comments/:id/delete', async (req, res) => {
  const c = await L.one('SELECT * FROM tutorial_comments WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (c) await L.q('DELETE FROM tutorial_comments WHERE id=?', [c.id]);
  res.redirect(c ? `/pilot/tutorials/${c.tutorial_id}#comments` : '/pilot/tutorials');
});
// YouTube / Vimeo links become privacy-friendly embeds; anything else is shown as a plain link.
function embedUrl(u) {
  const s = String(u || '');
  const yt = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vm = s.match(/vimeo\.com\/(\d+)/);
  return vm ? `https://player.vimeo.com/video/${vm[1]}` : null;
}

// ---- Live monitor (read-only telemetry from a local mavlink2rest bridge; never sends commands) ----
r.get('/live', (req, res) => res.render('pilot/live'));

module.exports = r;
module.exports.embedUrl = embedUrl;
module.exports.fleet = fleet;

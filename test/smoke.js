// Smoke test: pure-logic asserts + every page for every role against a DB loaded with `npm run setup -- --demo`.
// Paid features are switched on here (before the app loads) so their code paths are exercised; no real Razorpay call is made.
process.env.CREDIT_PRICE ||= '349';
process.env.PARTNER_SHARE_PERCENT ||= '10';
process.env.RAZORPAY_KEY_ID ||= 'rzp_test_smoke';
process.env.RAZORPAY_KEY_SECRET ||= 'smoke_secret';
const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const L = require('../src/lib');
const T = require('../src/training');
const { parse } = require('../src/flightlog');
const app = require('../src/server');

const D = require('../src/defaults');

// --- scheduler: shared ground classes -> per-trainee practical slots -> tests; nothing double-booked
const items = T.DEFAULT_SYLLABUS, trs = [1, 2, 3];
const plan = T.planBatch({ startDate: '2026-09-12', items, trainees: trs, delivery: 'hybrid', // a Saturday
  units: { rpas: [10], sim: [20, 20], classroom: [30], instructors: [7, 8] } });
assert.equal(plan[0].date, '2026-09-12');
assert.ok(plan.every(s => new Date(s.date + 'T00:00:00Z').getUTCDay() !== 0), 'no Sunday sessions');
assert.ok(plan.every(s => s.start >= '07:00' && s.end <= '17:00'), 'inside 07:00-17:00');
assert.ok(plan.filter(s => s.section === 'theory').every(s => s.online), 'hybrid theory is online');
const practical = items.filter(i => ['flying', 'simulator'].includes(i.section)).length;
for (const t of trs) assert.equal(plan.filter(s => s.trainee === t).length, practical, 'every trainee gets every practical item');
assert.equal(plan.filter(s => s.trainee === null).length, items.length - practical, 'shared items once');
const at = s => [s.date + s.start, s.date + s.end];
const overlaps = list => { let maxEnd = ''; return list.map(at).sort().some(([a, b]) => { const hit = a < maxEnd; if (b > maxEnd) maxEnd = b; return hit; }); };
for (const t of trs) assert.ok(!overlaps(plan.filter(s => s.trainee === t)), 'trainee double-booked');
assert.ok(!overlaps(plan.filter(s => s.section === 'flying')), 'the single RPAS is double-booked');
const sims = plan.filter(s => s.section === 'simulator');
assert.ok(sims.every(s => sims.filter(o => at(o)[0] <= at(s)[0] && at(o)[1] > at(s)[0]).length <= 2), 'more than 2 simulator seats in use');
const lastPractical = plan.filter(s => s.trainee).map(s => s.date).sort().at(-1);
assert.ok(plan.filter(s => s.section === 'test').every(s => s.date > lastPractical), 'tests after practical');
const partial = T.planBatch({ startDate: '2026-09-14', items, trainees: [1], done: new Set(['G1|', 'F3|1']), units: { rpas: [10], sim: [20] } });
assert.ok(!partial.some(s => s.code === 'G1') && !partial.some(s => s.code === 'F3'), 'done items are not rescheduled');

// --- timeline moves: push later neighbours on overlap (keeping the gap), refuse clashes
const day = [{ id: 1, trainee_id: 5, asset_id: 10, code: 'F1', start: 480, end: 495 }, { id: 2, trainee_id: 5, asset_id: 10, code: 'F2', start: 495, end: 510 },
  { id: 3, trainee_id: null, code: 'G1', start: 600, end: 660 }, { id: 4, trainee_id: 6, asset_id: 10, code: 'F1', start: 520, end: 535 }];
assert.deepEqual(T.applyMove(day, day[0], 485, 500, { gap: 5 }).changes, [{ id: 1, start: 485, end: 500 }, { id: 2, start: 505, end: 520 }]);
assert.match(T.applyMove(day, day[3], 610, 625).error, /overlap G1/);
assert.match(T.applyMove(day, day[0], 300, 315).error, /06:00/);
assert.match(T.applyMove(day, day[3], 480, 495).error, /in use/);
assert.match(T.applyMove(day, day[1], 485, 500).error, /Overlaps F1/);

// --- GST: fees stored GST-inclusive, receipts split them back out
assert.equal(T.withGst(35000, 18), 41300);
assert.deepEqual(T.gstSplit(41300, 18), { taxable: 35000, gst: 6300 });
assert.deepEqual(T.gstSplit(1000, 0), { taxable: 1000, gst: 0 });

// --- TOTP (RFC 6238 test vectors, 6 digits) and code window
const rfc = L.base32(Buffer.from('12345678901234567890'));
assert.equal(L.totp(rfc, 1), '287082'); assert.equal(L.totp(rfc, Math.floor(1111111109 / 30)), '081804');
assert.equal(L.checkTotp(rfc, '287082', 59000), 1); assert.equal(L.checkTotp(rfc, '287082', 200000), null); assert.equal(L.checkTotp(rfc, 'abc'), null);
assert.equal(L.readToken(L.makeToken(1, 0, 'mfa:')), null, 'a 2FA-step token is not a session token');

// --- question bank / syllabus CSV validation
assert.deepEqual(D.questionRows([['subject', 'question', 'a', 'b', 'c', 'd', 'correct'], ['S', 'Q?', 'x', 'y', '', '', 'B'], ['S', 'Q2', 'x', 'y', '', '', 'c']]),
  [['S', 'Q?', 'x', 'y', null, null, 'b']]);
assert.deepEqual(D.syllabusRows([['code', 'section', 'title', 'minutes', 'needs_log'], ['F1', 'Flying', 'Hover', '15', 'yes'], ['Z', 'bogus', 't', '1', '']]),
  [['F1', 'flying', 'Hover', 15, 1, 0]]);

// --- CSV
assert.deepEqual(L.parseCsv('name,notes\r\n"Rao, V","said ""hi"""\n'), [['name', 'notes'], ['Rao, V', 'said "hi"']]);

// --- ZIP: entries readable back from central directory
const z = L.zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b/c.txt', data: Buffer.from('world') }]);
assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
assert.equal(z.readUInt16LE(z.length - 12), 2);
assert.equal(z.readUInt32LE(14), zlib.crc32(Buffer.from('hello')));

// --- Razorpay signature check
const sig = crypto.createHmac('sha256', 'sek').update('order_1|pay_1').digest('hex');
assert.ok(L.verifyRazorpay('order_1', 'pay_1', sig, 'sek'));
assert.ok(!L.verifyRazorpay('order_1', 'pay_2', sig, 'sek'));
assert.ok(!L.verifyRazorpay('order_1', 'pay_1', 'x', 'sek'));

// --- flight-log parsers on synthetic files
function apBin() {
  const fmt = (type, len, name, format, cols) => { const b = Buffer.alloc(89); b[0] = 0xa3; b[1] = 0x95; b[2] = 128; b[3] = type; b[4] = len; b.write(name, 5, 'latin1'); b.write(format, 9, 'latin1'); b.write(cols, 25, 'latin1'); return b; };
  const out = [fmt(130, 39, 'GPS', 'QBIHBLLeff', 'TimeUS,Status,GMS,GWk,NSats,Lat,Lng,Alt,Spd,GCrs'), fmt(131, 15, 'BAT', 'Qf', 'TimeUS,Volt')];
  for (let i = 0; i < 50; i++) {
    const g = Buffer.alloc(39); g[0] = 0xa3; g[1] = 0x95; g[2] = 130; let o = 3;
    g.writeBigUInt64LE(BigInt(1e6 * (10 + i)), o); o += 8; g[o++] = 3; g.writeUInt32LE(100000 + i * 1000, o); o += 4; g.writeUInt16LE(2300, o); o += 2; g[o++] = 12;
    g.writeInt32LE(Math.round((13.08 + i * 1e-5) * 1e7), o); o += 4; g.writeInt32LE(802700000, o); o += 4; g.writeInt32LE(1000 + i * 20, o); o += 4; g.writeFloatLE(1.1, o); o += 4; g.writeFloatLE(0, o);
    const b = Buffer.alloc(15); b[0] = 0xa3; b[1] = 0x95; b[2] = 131; b.writeBigUInt64LE(BigInt(1e6 * (10 + i)), 3); b.writeFloatLE(24.5, 11);
    out.push(g, b);
  }
  return Buffer.concat(out);
}
// The same flight plus mode changes, heavy vibration, an oscillating roll-rate loop, parameters, a battery failsafe and a mission.
function apBinFull() {
  const fmt = (type, len, name, format, cols) => { const b = Buffer.alloc(89); b[0] = 0xa3; b[1] = 0x95; b[2] = 128; b[3] = type; b[4] = len; b.write(name, 5, 'latin1'); b.write(format, 9, 'latin1'); b.write(cols, 25, 'latin1'); return b; };
  const msg = (type, len, write) => { const b = Buffer.alloc(len); b[0] = 0xa3; b[1] = 0x95; b[2] = type; write(b); return b; };
  const us = (b, t) => b.writeBigUInt64LE(BigInt(Math.round(t * 1e6)), 3);
  const out = [apBin(), fmt(132, 14, 'MODE', 'QMBB', 'TimeUS,Mode,ModeNum,Rsn'), fmt(133, 23, 'VIBE', 'Qfff', 'TimeUS,VibeX,VibeY,VibeZ'),
    fmt(134, 35, 'RATE', 'Qffffff', 'TimeUS,RDes,R,PDes,P,YDes,Y'), fmt(135, 31, 'PARM', 'QNf', 'TimeUS,Name,Value'), fmt(136, 13, 'ERR', 'QBB', 'TimeUS,Subsys,ECode'),
    fmt(137, 27, 'CMD', 'QHHLLf', 'TimeUS,CNum,CId,Lat,Lng,Alt')];
  for (const [n, v] of [['ATC_RAT_RLL_P', 0.135], ['ATC_RAT_RLL_I', 0.135], ['ATC_RAT_RLL_D', 0.0036], ['FENCE_ENABLE', 1], ['FENCE_RADIUS', 150]])
    out.push(msg(135, 31, b => { us(b, 1); b.write(n, 11, 'latin1'); b.writeFloatLE(v, 27); }));
  for (const [t, m] of [[10, 5], [40, 6]]) out.push(msg(132, 14, b => { us(b, t); b[11] = m; b[12] = m; }));
  for (let i = 0; i < 50; i++) out.push(msg(133, 23, b => { us(b, 10 + i); b.writeFloatLE(35, 11); b.writeFloatLE(20, 15); b.writeFloatLE(25, 19); }));
  for (let k = 0; k < 400; k++) {
    const t = 10 + k / 100, d = 60 * Math.sin(Math.PI * t);
    out.push(msg(134, 35, b => { us(b, t); b.writeFloatLE(d, 11); b.writeFloatLE(d + 12 * Math.sin(24 * Math.PI * t), 15); }));
  }
  out.push(msg(136, 13, b => { us(b, 30); b[11] = 6; b[12] = 1; }));
  for (const [n, id, lat, alt] of [[0, 16, 13.08, 0], [1, 22, 13.08, 10], [2, 16, 13.081, 20]])
    out.push(msg(137, 27, b => { us(b, 5); b.writeUInt16LE(n, 11); b.writeUInt16LE(id, 13); b.writeInt32LE(Math.round(lat * 1e7), 15); b.writeInt32LE(802700000, 19); b.writeFloatLE(alt, 23); }));
  return Buffer.concat(out);
}
const full = parse(apBinFull());
assert.equal(full.vehicle, 'copter'); assert.equal(full.points[5][9], 'Loiter'); assert.equal(full.points[45][9], 'RTL');
assert.ok(full.points[5][17] >= 35, 'vibration on the point');
assert.deepEqual(full.events.modes, [[0, 'Loiter'], [30, 'RTL']]);
assert.equal(full.params.FENCE_RADIUS, 150); assert.equal(full.fence.radius, 150);
assert.deepEqual(full.mission.map(m => m[1]), [22, 16], 'home (seq 0) is not a waypoint');
const check = area => full.analysis.checks.find(c => c.area === area);
assert.equal(check('Vibration').status, 'bad'); assert.equal(check('Errors & failsafes').status, 'bad'); assert.match(check('Errors & failsafes').value, /Battery failsafe/);
assert.equal(full.analysis.pid[0].verdict, 'oscillating'); assert.equal(full.analysis.pid[1].verdict, 'unknown');
assert.equal(require('../src/analysis').paramFile(full.analysis.pid, 'copter'), 'ATC_RAT_RLL_P,0.1148\nATC_RAT_RLL_D,0.0031\n');
// CSV whose clock doesn't start at zero still gets a speed from positions (regression: time was rebased after the step).
const offsetCsv = parse(Buffer.from('time_s,lat,lon,rel_alt\n' + Array.from({ length: 30 }, (_, i) => `${1000 + i},${13.08 + i * 1e-4},80.27,${i}`).join('\n')));
assert.ok(Math.abs(offsetCsv.max_speed - 11.1) < 0.2, 'speed ' + offsetCsv.max_speed); assert.equal(offsetCsv.points[10][10], 1, 'climb rate');

const b1 = parse(apBin());
assert.equal(b1.format, 'ardupilot_bin'); assert.equal(b1.points.length, 50); assert.equal(b1.duration_s, 49);
assert.equal(b1.max_alt_m, 9.8); assert.ok(Math.abs(b1.distance_m - 54) <= 1, 'bin distance ' + b1.distance_m);
assert.equal(b1.points[0][6], 24.5); assert.ok(b1.startedAt instanceof Date && b1.startedAt.getUTCFullYear() === 2024);

function ulog() {
  const msg = (type, payload) => { const h = Buffer.alloc(3); h.writeUInt16LE(payload.length, 0); h[2] = type.charCodeAt(0); return Buffer.concat([h, payload]); };
  const parts = [Buffer.concat([Buffer.from('ULog'), Buffer.from([1, 0x12, 0x35, 1]), Buffer.alloc(8)]),
    msg('F', Buffer.from('vehicle_gps_position:uint64_t timestamp;int32_t lat;int32_t lon;int32_t alt;float vel_m_s;float cog_rad;uint8_t fix_type;uint8_t satellites_used;uint8_t[2] _padding0;')),
    msg('A', Buffer.concat([Buffer.from([0, 7, 0]), Buffer.from('vehicle_gps_position')]))];
  for (let i = 0; i < 30; i++) {
    const d = Buffer.alloc(34); let o = 0;
    d.writeUInt16LE(7, o); o += 2; d.writeBigUInt64LE(BigInt(5e6 + i * 1e6), o); o += 8; d.writeInt32LE(130800000 + i * 100, o); o += 4; d.writeInt32LE(802700000, o); o += 4;
    d.writeInt32LE(50000 + i * 500, o); o += 4; d.writeFloatLE(2, o); o += 4; d.writeFloatLE(Math.PI / 2, o); o += 4; d[o++] = 3; d[o++] = 10;
    parts.push(msg('D', d));
  }
  return Buffer.concat(parts);
}
const u1 = parse(ulog());
assert.equal(u1.format, 'px4_ulog'); assert.equal(u1.points.length, 30); assert.equal(u1.max_alt_m, 14.5); assert.equal(u1.points[3][5], 90); assert.equal(u1.points[0][7], 10);

const txt = parse(Buffer.from('FMT, 128, 89, FMT, BBnNZ, Type,Length,Name,Format,Columns\nFMT, 130, 45, GPS, QBIHBcLLeef, TimeUS,Status,GMS,GWk,NSats,HDop,Lat,Lng,RelAlt,Alt,Spd\n' +
  [0, 1, 2, 3].map(i => `GPS, ${(i + 1) * 1e6}, 3, 0, 0, 10, 1.2, ${13.08 + i * 1e-4}, 80.27, 0, ${50 + i}, 2`).join('\n')));
assert.equal(txt.format, 'ardupilot_log'); assert.equal(txt.points.length, 4); assert.equal(txt.max_alt_m, 3);

const dji = parse(Buffer.from('time(millisecond),latitude,longitude,height_above_takeoff(feet),speed(mph),battery_percent\n' +
  [0, 1, 2].map(i => `${i * 1000},13.08${i},80.27,${i * 100},10,${90 - i}`).join('\n')));
assert.equal(dji.format, 'csv'); assert.equal(dji.duration_s, 2); assert.equal(dji.max_alt_m, 61); assert.equal(dji.points[1][4], 4.5); assert.equal(dji.bat_unit, '%');
assert.throws(() => parse(Buffer.from('a,b\n1,2\n3,4\n5,6')), /latitude/);

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const sidOf = r => r.headers.getSetCookie().find(c => c.startsWith('sid=')).split(';')[0];
  const session = async (email, password = 'Demo@1234') => {
    const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
    assert.equal(r.status, 302, 'login ' + email);
    return sidOf(r);
  };
  const get = async (cookie, url, expect = 200) => {
    const r = await fetch(base + url, { headers: { cookie }, redirect: 'manual' });
    const body = await r.text();
    assert.equal(r.status, expect, `${url} -> ${r.status}\n${body.slice(0, 300)}`);
    return body;
  };
  const post = (cookie, url, data) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const upload = (cookie, url, fields, name, content) => {
    const fd = new FormData(); Object.entries(fields).forEach(([k, v]) => fd.append(k, v)); fd.append('file', new Blob([content]), name);
    return fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie }, body: fd });
  };

  for (const u of ['/', '/login', '/register', '/register-rpto', '/rptos', '/forgot', '/reset/not-a-token', '/offline', '/manifest.webmanifest', '/sw.js']) await get('', u);
  // 3D homepage: canvas + drone markers present, three.js served locally (no CDN), scene script and styles reachable.
  const homeHtml = await get('', '/');
  assert.match(homeHtml, /id="scene3d"/); assert.match(homeHtml, /data-replay/); assert.match(homeHtml, /data-drone-at="[\d.]+,[-\d]+,[\d.]+,land"/);
  assert.match(homeHtml, /id="logbooks"[\s\S]*data-lb="manual"[\s\S]*data-lb="auto"/); // automated-compliance switch
  assert.equal((homeHtml.match(/class="card3 lb"/g) || []).length, 4, 'four logbook cards');
  assert.match(homeHtml, /id="pilots"[\s\S]*class="dash-kpis"[\s\S]*Upcoming flights/); // pilot dashboard
  assert.match(homeHtml, /Student portal[\s\S]*href="\/login\?next=\/student"/); // student log-in card
  const toStudent = await fetch(base + '/login?next=/student', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'student1@demo.test', password: 'Demo@1234' }) });
  assert.equal(toStudent.headers.get('location'), '/student', 'student log-in lands in the student portal');
  for (const u of ['/vendor/three/three.module.js', '/vendor/three/three.core.js', '/static/home3d.js', '/static/drone3d.js', '/static/home.css', '/demo/field', '/static/field3d.js', '/static/media/sim-demo.jpg']) await get('', u);
  assert.match(homeHtml, /class="sim-demo"[\s\S]*src="\/static\/media\/sim-demo\.mp4"/); // simulator demo video
  assert.equal((await fetch(base + '/static/media/sim-demo.mp4', { headers: { range: 'bytes=0-1' } })).status, 206, 'video streams with Range requests');
  assert.equal((await post('', '/forgot', { email: 'nobody@example.com' })).status, 200);
  const rid = (await L.one("SELECT id FROM rptos WHERE name='Demo Drone Academy'")).id;
  await get('', '/enquire/' + rid);
  await get('', '/rpto', 302); // not signed in -> login

  const sa = await session(process.env.SUPER_ADMIN_EMAIL || 'superadmin@example.com', process.env.SUPER_ADMIN_PASSWORD || 'Demo@1234').catch(() => null);
  if (sa) for (const u of ['/super', '/super/rptos', '/super/rptos/new', '/super/rptos/' + rid, '/super/users', '/super/payments', '/super/defaults', '/super/defaults?tab=questions']) await get(sa, u);

  const admin = await session('admin@demo.test');
  const bid = (await L.one('SELECT id FROM batches WHERE rpto_id=?', [rid])).id;
  const tid = (await L.one("SELECT id FROM tests WHERE batch_id=? AND type='theory'", [bid])).id;
  const pid = (await L.one("SELECT id FROM tests WHERE batch_id=? AND type='practical'", [bid])).id;
  const app1 = (await L.one("SELECT a.id, a.user_id FROM applications a JOIN users u ON u.id=a.user_id WHERE a.batch_id=? AND u.email='student1@demo.test'", [bid]));
  const slots = (uid, type) => L.q('SELECT * FROM sessions WHERE batch_id=? AND trainee_id=? AND type=? ORDER BY date, start_time, id', [bid, uid, type]);
  const fly1 = await slots(app1.user_id, 'flying');
  assert.ok(fly1.length >= 3, 'per-trainee flying slots were scheduled');
  const sid = fly1[0].id;
  const rpasId = (await L.one("SELECT id FROM assets WHERE rpto_id=? AND type='rpas'", [rid])).id;
  for (const u of ['/rpto', '/rpto/crm', '/rpto/crm?tab=fees', `/rpto/crm?tab=fees&batch=${bid}`, '/rpto/admissions', '/rpto/batches', '/rpto/batches?attendance=unmarked', '/rpto/batches?view=list',
    '/rpto/batches/new', `/rpto/batches/${bid}`, `/rpto/batches/${bid}/edit`, `/rpto/batches/${bid}?tab=simulator`, `/rpto/batches/${bid}?tab=flying`, `/rpto/batches/${bid}?tab=tests`,
    `/rpto/batches/${bid}/timeline`, `/rpto/batches/${bid}/timeline?view=week`, `/rpto/batches/${bid}/timeline?view=month`,
    `/rpto/sessions/${sid}`, `/rpto/tests/${tid}`, `/rpto/tests/${tid}/pack`, `/rpto/tests/${tid}/omr`,
    '/rpto/assets', '/rpto/logbook', '/rpto/logbook?tab=rpas', '/rpto/logbook?tab=batteries', '/rpto/logbook?tab=incidents', '/rpto/logbook?tab=maintenance', `/rpto/logbook/asset/${rpasId}`, '/rpto/members',
    '/rpto/settings', '/rpto/settings?tab=branding', '/rpto/settings?tab=roll', '/rpto/settings?tab=syllabus', '/rpto/settings?tab=questions', '/rpto/reports', '/rpto/reports?export=utilisation',
    `/rpto/trainees/${app1.user_id}`, `/rpto/applications/${app1.id}/record`, '/rpto/admissions?export=1', `/rpto/batches/${bid}/attendance.csv`, `/rpto/batches/${bid}/allocation.csv`,
    '/rpto/settings/questions.csv', '/rpto/settings/syllabus.csv', '/account', '/account/2fa', '/flights', '/simulator']) await get(admin, u);

  // Per-trainee flying progress: slide to the 3rd slot -> 3 done, flight-ops entries only for slots that need a log.
  assert.equal((await post(admin, `/rpto/batches/${bid}/progress`, { trainee_id: app1.user_id, type: 'flying', upto: fly1[2].id })).status, 302);
  const done3 = (await slots(app1.user_id, 'flying')).filter(s => s.status === 'done');
  assert.equal(done3.length, 3);
  assert.equal((await L.one('SELECT COUNT(*) n FROM flight_logs WHERE session_id IN (?)', [done3.map(s => s.id)])).n, done3.filter(s => s.needs_log).length);
  const logSlot = done3.find(s => s.needs_log);
  assert.ok(logSlot, 'a done slot needs a log');
  // Logging is locked until a slot is done; then a staff upload attaches the track and the replay is reachable.
  const notDone = (await slots(app1.user_id, 'flying')).find(s => s.status !== 'done');
  await upload(admin, `/rpto/sessions/${notDone.id}/track`, {}, 'flight.bin', apBin());
  assert.equal((await L.one('SELECT COUNT(*) n FROM flight_logs WHERE session_id=?', [notDone.id])).n, 0, 'no log on an undone slot');
  const j = await upload(admin, `/rpto/sessions/${logSlot.id}/track?json=1`, {}, 'flight.bin', apBin());
  assert.equal(j.status, 200); assert.ok((await j.json()).track);
  const linked = await L.one('SELECT track_id FROM flight_logs WHERE session_id=? AND pilot_id=?', [logSlot.id, app1.user_id]);
  assert.ok(linked.track_id, 'track attached');
  await get(admin, `/flights/${linked.track_id}`);
  // Rich log: every replay tab, the printable report and the suggested .param download.
  const upFull = await upload(admin, '/flights', { notes: 'full log' }, 'full.bin', apBinFull());
  const fullId = upFull.headers.get('location').split('/').pop();
  for (const tab of ['replay', 'graphs', 'performance', 'params', 'analysis']) await get(admin, `/flights/${fullId}?tab=${tab}`);
  assert.match(await get(admin, `/flights/${fullId}?tab=pid`), /oscillating/);
  assert.match(await get(admin, `/flights/${fullId}/report`), /Battery failsafe/);
  assert.equal(await get(admin, `/flights/${fullId}/pid.param`), 'ATC_RAT_RLL_P,0.1148\nATC_RAT_RLL_D,0.0031\n');
  // A slot with a log can't be un-marked.
  await post(admin, `/rpto/batches/${bid}/progress`, { trainee_id: app1.user_id, type: 'flying', upto: 'none' });
  assert.equal((await L.one('SELECT status FROM sessions WHERE id=?', [logSlot.id])).status, 'done', 'logged slot stays done');

  // Timeline: a valid drag moves the slot; one outside 06:00-19:00 is refused.
  const sim1 = (await slots(app1.user_id, 'simulator')).find(s => s.status !== 'done');
  const mv = await post(admin, `/rpto/sessions/${sim1.id}/move`, { date: sim1.date, start: String(T.toMin(sim1.start_time)), end: String(T.toMin(sim1.end_time)) });
  assert.equal(mv.status, 200, await mv.clone().text());
  assert.equal((await post(admin, `/rpto/sessions/${sim1.id}/move`, { date: sim1.date, start: '300', end: '315' })).status, 409);

  // Fees: batch fee + 18% GST, part payment -> receipt; overpayment refused; paid = sum of receipts.
  await post(admin, `/rpto/crm/fees/batch/${bid}`, { fee: '35000', gst_percent: '18' });
  const fee1 = await L.one("SELECT * FROM fees WHERE user_id=? AND batch_id=? AND description='Course fee'", [app1.user_id, bid]);
  assert.equal(+fee1.amount, 41300); assert.equal(+fee1.paid, 15000);
  const pay = await post(admin, `/rpto/crm/fees/${fee1.id}/pay`, { amount: '1000', mode: 'cash' });
  assert.match(pay.headers.get('location'), /^\/rpto\/receipts\/\d+$/);
  assert.match(await get(admin, pay.headers.get('location')), /RCPT\/\d{4}\/\d{5}[\s\S]*GST @ 18%/);
  await post(admin, `/rpto/crm/fees/${fee1.id}/pay`, { amount: '999999' });
  assert.equal(+(await L.one('SELECT paid FROM fees WHERE id=?', [fee1.id])).paid, 16000);
  const receiptId = pay.headers.get('location').split('/').pop();

  // Logbook: flight entry with type + field, incident with several assets, per-asset printable logbook.
  const fieldId = (await L.one("SELECT id FROM assets WHERE rpto_id=? AND type='field'", [rid])).id;
  const batIds = (await L.q("SELECT id FROM assets WHERE rpto_id=? AND type='battery' LIMIT 2", [rid])).map(a => a.id);
  await post(admin, '/rpto/logbook/flights', { date: L.today(), pilot_name: 'Guest pilot', activity_type: 'demonstration', field_id: fieldId, rpas_id: rpasId, minutes: '12' });
  assert.equal((await L.one("SELECT field_id FROM flight_logs WHERE pilot_name='Guest pilot'")).field_id, fieldId);
  const inc = new URLSearchParams({ date: L.today(), time: '10:30', field_id: fieldId, trainee_id: app1.user_id, severity: 'minor', description: 'Hard landing smoke' });
  [rpasId, ...batIds, 999999].forEach(a => inc.append('assets', a)); // a foreign asset id is ignored
  await fetch(base + '/rpto/logbook/incidents', { method: 'POST', redirect: 'manual', headers: { cookie: admin, 'content-type': 'application/x-www-form-urlencoded' }, body: inc });
  const incRow = await L.one("SELECT id, trainee_id FROM incidents WHERE description='Hard landing smoke'");
  assert.equal(incRow.trainee_id, app1.user_id);
  assert.equal((await L.one('SELECT COUNT(*) n FROM incident_assets WHERE incident_id=?', [incRow.id])).n, 1 + batIds.length);
  assert.match(await get(admin, '/rpto/logbook?tab=incidents'), /Hard landing smoke/);
  assert.match(await get(admin, `/rpto/logbook/asset/${rpasId}`), /Hard landing smoke/);
  await get(admin, `/rpto/logbook/asset/${fieldId}`, 404); // only RPAS / batteries have a logbook

  assert.equal((await post(admin, '/rpto/logbook/maintenance', { asset_id: rpasId, date: L.today(), type: 'repair', description: 'test' })).status, 302);
  const zipRes = await fetch(`${base}/rpto/applications/${app1.id}/package.zip`, { headers: { cookie: admin } });
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');

  // Syllabus: customise (copy of default) -> CSV replace -> reset to default.
  const defaultCount = (await L.one('SELECT COUNT(*) n FROM syllabus_items WHERE rpto_id IS NULL')).n;
  await post(admin, '/rpto/settings/syllabus/customise', {});
  assert.equal((await L.one('SELECT COUNT(*) n FROM syllabus_items WHERE rpto_id=?', [rid])).n, defaultCount);
  await upload(admin, '/rpto/settings/syllabus/import', {}, 's.csv', 'code,section,title,minutes,needs_log\nT1,theory,Rules,60,\nF1,flying,Hover,15,yes\n');
  assert.equal((await L.one('SELECT COUNT(*) n FROM syllabus_items WHERE rpto_id=?', [rid])).n, 2);
  await upload(admin, '/rpto/settings/syllabus/import', {}, 'bad.csv', 'nothing,useful\n');
  assert.equal((await L.one('SELECT COUNT(*) n FROM syllabus_items WHERE rpto_id=?', [rid])).n, 2, 'invalid import changes nothing');
  await post(admin, '/rpto/settings/syllabus/reset', {});
  assert.equal((await L.one('SELECT COUNT(*) n FROM syllabus_items WHERE rpto_id=?', [rid])).n, 0);
  // Question bank: RPTO uploads its own (replaces), then goes back to the platform default.
  await upload(admin, '/rpto/settings/questions/import', {}, 'q.csv', 'subject,question,a,b,c,d,correct\nS,Q one?,x,y,,,a\nS,Q two?,x,y,z,,c\n');
  assert.equal((await L.one('SELECT COUNT(*) n FROM questions WHERE rpto_id=?', [rid])).n, 2);
  assert.equal(await T.bankOwner(rid), rid);
  await post(admin, '/rpto/settings/questions/clear', {});
  assert.equal(await T.bankOwner(rid), null, 'back on the default bank');
  if (sa) { // platform default bank edit
    await post(sa, '/super/defaults/questions', { subject: 'S', question: 'Smoke default?', a: 'x', b: 'y', correct: 'b' });
    assert.ok(await L.one("SELECT id FROM questions WHERE rpto_id IS NULL AND question='Smoke default?'"));
  }

  const inst = await session('instructor@demo.test');
  for (const u of ['/rpto/batches', '/rpto/reports', '/flights']) await get(inst, u);
  await get(inst, '/rpto/admissions', 403);
  await get(inst, '/rpto/members', 403);
  const bd = await session('sales@demo.test');
  await get(bd, '/rpto/crm');
  await get(bd, '/rpto/batches', 403);
  await get(bd, `/flights/${linked.track_id}`, 200); // same-RPTO staff may view trainee flights

  // Student: pages, theory test, flight upload, simulator practice + test.
  const st = await session('student1@demo.test');
  for (const u of ['/student', '/student/apply', `/student/apply?rpto=${rid}`, '/student/documents', `/student/record/${app1.id}`, '/student/billing', '/flights', `/flights/${linked.track_id}`,
    '/simulator', `/student/receipts/${receiptId}`, '/account/2fa']) await get(st, u);
  await get(st, '/rpto', 403);
  // Extra "other" document (after consent) doesn't count towards the six required ones.
  await upload(st, '/student/documents/other', { label: 'Driving licence' }, 'dl.pdf', '%PDF-1.4 smoke');
  const extra = await L.one("SELECT * FROM trainee_documents WHERE user_id=? AND LEFT(doc_type, 6)='other_'", [app1.user_id]);
  assert.equal(extra.label, 'Driving licence'); assert.equal(extra.status, 'pending');
  assert.match(await get(admin, `/rpto/trainees/${app1.user_id}`), /Driving licence/);
  const html = await get(st, `/student/tests/${tid}`);
  const qids = [...new Set([...html.matchAll(/name="q(\d+)"/g)].map(m => m[1]))];
  assert.ok(qids.length > 0, 'test has questions');
  const key = await L.q('SELECT id, correct FROM questions WHERE id IN (?)', [qids]);
  await post(st, `/student/tests/${tid}`, Object.fromEntries(key.map(k => ['q' + k.id, k.correct])));
  const res = await L.one('SELECT * FROM test_results WHERE test_id=? AND user_id=?', [tid, app1.user_id]);
  assert.equal(res.passed, 1); assert.equal(res.score, res.total);

  const up = await upload(st, '/flights', { notes: 'smoke' }, 'px4.ulg', ulog());
  assert.equal(up.status, 302); assert.match(up.headers.get('location'), /^\/flights\/\d+$/);
  await get(st, up.headers.get('location'));
  const bad = await upload(st, '/flights', {}, 'junk.csv', 'a,b\n1,2\n3,4');
  assert.equal(bad.headers.get('location'), '/flights'); // parse error -> back with message

  assert.equal((await post(st, '/simulator/run', { exercise: 'hover', passed: '1', seconds: '42', penalties: '0' })).status, 204);
  await post(st, '/simulator/run', { exercise: 'gates', passed: '1', seconds: '80', penalties: '0' });
  await post(st, '/simulator/run', { exercise: 'hack', passed: '1', seconds: '1', penalties: '0' }); // unknown drills are ignored
  assert.equal((await L.one("SELECT COUNT(*) n FROM sim_runs WHERE user_id=? AND exercise IN ('gates','hack')", [app1.user_id])).n, 1);
  assert.match(await get(st, '/simulator'), /FPV gate course[\s\S]*Fly like my drone/);
  const simT = (await L.q("INSERT INTO tests (batch_id,title,type,open) VALUES (?,?,?,1)", [bid, 'Simulator test', 'simulator'])).insertId;
  assert.match(await get(st, '/simulator'), /Start simulator test/);
  const drills = ['hover', 'square', 'eight'].map(exercise => ({ exercise, passed: 1, seconds: 60, penalties: 0 }));
  assert.equal((await post(st, `/simulator/test/${simT}`, { results: JSON.stringify(drills) })).status, 302);
  assert.equal((await L.one('SELECT passed FROM test_results WHERE test_id=? AND user_id=?', [simT, app1.user_id])).passed, 1);
  assert.doesNotMatch(await get(st, '/simulator'), /Start simulator test/); // can't retake

  const other = await L.one("SELECT id FROM applications WHERE batch_id=? AND status='accepted' AND id<>?", [bid, app1.id]);
  await get(st, `/student/record/${other.id}`, 404);
  // A test marked by staff with an evidence file: visible to that trainee, not to another one.
  const s2u = (await L.one("SELECT id FROM users WHERE email='student2@demo.test'")).id;
  const ev = new FormData(); ev.append('result', 'pass'); ev.append('score', '9'); ev.append('total', '10'); ev.append('evidence', new Blob(['%PDF-1.4 smoke']), 'sheet.pdf');
  await fetch(`${base}/rpto/tests/${pid}/mark/${s2u}`, { method: 'POST', redirect: 'manual', headers: { cookie: admin }, body: ev });
  const marked = await L.one('SELECT * FROM test_results WHERE test_id=? AND user_id=?', [pid, s2u]);
  assert.equal(marked.passed, 1); assert.equal(marked.score, 9); assert.ok(marked.evidence_file);
  await get(st, `/files/${marked.evidence_file}`, 403);

  // --- Pilot logbook: training flight (with its attached log counted once) + 2 personal uploads, running totals.
  const { rows: lb, stats: ls } = await require('../src/routes/flights').pilotLog(app1.user_id);
  assert.equal(ls.training, 1); assert.equal(ls.personal, 2); assert.equal(lb.length, 3);
  assert.equal(lb.at(-1).cumulative, ls.minutes); assert.ok(ls.current);
  assert.match(await get(st, '/pilot/logbook'), /Pilot logbook/);
  assert.match(await get(st, '/pilot/logbook?export=1'), /Cumulative minutes/);
  assert.equal((await fetch(base + '/flights/logbook', { headers: { cookie: st }, redirect: 'manual' })).headers.get('location'), '/pilot/logbook');
  assert.match(await get(st, '/student'), /My pilot career/);

  // --- Pilot hub: fleet, manual entry, push-to-logbook, battery cycles, maintenance due, per-book logbooks.
  await post(st, '/pilot/fleet', { type: 'drone', name: 'Smoke quad', uin: 'UA-SMOKE-1' });
  await post(st, '/pilot/fleet', { type: 'battery', name: 'Smoke pack', serial_no: 'SP-1', initial_cycles: '10', max_cycles: '12' });
  const drone = await L.one("SELECT id FROM pilot_assets WHERE user_id=? AND name='Smoke quad'", [app1.user_id]);
  const pack = await L.one("SELECT id FROM pilot_assets WHERE user_id=? AND name='Smoke pack'", [app1.user_id]);
  await post(st, '/pilot/entries', { date: L.today(), start_time: '09:00', end_time: '09:25', drone_id: drone.id, battery_id: pack.id, exercise: 'Smoke circuit' });
  assert.equal((await L.one("SELECT minutes FROM pilot_entries WHERE user_id=? AND exercise='Smoke circuit'", [app1.user_id])).minutes, 25, 'minutes from take-off/landing');
  const other2 = await L.one("SELECT id FROM pilot_assets WHERE user_id<>? LIMIT 1", [app1.user_id]);
  const personalTrack = (await L.one('SELECT t.id FROM tracks t WHERE t.user_id=? AND NOT EXISTS (SELECT 1 FROM flight_logs f WHERE f.track_id=t.id) ORDER BY t.id DESC LIMIT 1', [app1.user_id])).id;
  await post(st, `/flights/${personalTrack}/logbook`, { drone_id: drone.id, battery_id: other2?.id || pack.id, exercise: 'Survey lap', place: 'Beach' });
  const pushed = await L.one('SELECT logged, drone_id, exercise FROM tracks WHERE id=?', [personalTrack]);
  assert.equal(pushed.logged, 1); assert.equal(pushed.drone_id, drone.id); assert.equal(pushed.exercise, 'Survey lap');
  await post(st, `/flights/${personalTrack}/logbook`, { battery_id: pack.id });
  const f1 = await require('../src/routes/pilot').fleet(app1.user_id);
  assert.equal(f1.batteries.find(b => b.id === pack.id).cycles, 12, 'battery cycles = initial + flights');
  await post(st, `/pilot/fleet/${drone.id}/maintenance`, { date: L.daysAgo(30), type: 'inspection', description: 'props', next_due: L.daysAgo(1) });
  const hub = await get(st, '/pilot');
  assert.match(hub, /maintenance overdue since/); assert.match(hub, /12\/12 cycles/); assert.match(hub, /Personal bests/);
  for (const u of ['/pilot/fleet', `/pilot/fleet/${drone.id}`, '/pilot/logbook?book=drone', `/pilot/logbook?book=battery&asset=${pack.id}`, '/pilot/logbook?book=maintenance',
    '/pilot/logbook?book=sim', '/pilot/logbook?utc=1', '/pilot/live', '/pilot/tutorials']) await get(st, u);
  assert.match(await get(st, `/pilot/logbook?book=battery&asset=${pack.id}&export=1`), /Cycle/);
  assert.match(await get(st, `/pilot/logbook?book=drone&asset=${drone.id}`), /Smoke circuit/);
  await get(st, `/pilot/fleet/${other2?.id || 0}`, 404); // someone else's asset
  const { stats: ls2 } = await require('../src/routes/flights').pilotLog(app1.user_id);
  assert.equal(ls2.manual, 1); assert.equal(ls2.minutes, ls.minutes + 25);
  const entryId = (await L.one("SELECT id FROM pilot_entries WHERE user_id=?", [app1.user_id])).id;
  await post(st, `/pilot/entries/${entryId}/delete`, {});
  assert.equal((await L.one('SELECT COUNT(*) n FROM pilot_entries WHERE user_id=?', [app1.user_id])).n, 0);
  // Instructors see the flights they supervised as "Instructing", outside their own totals.
  const trainer = (await L.one('SELECT instructor_id FROM flight_logs WHERE session_id=?', [logSlot.id])).instructor_id;
  if (trainer) assert.ok((await require('../src/routes/flights').pilotLog(trainer)).stats.instructing >= 1, 'instructing flights listed');
  // Tutorials: platform admin manages them, pilots read and comment; video links become embeds.
  assert.equal(require('../src/routes/pilot').embedUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(require('../src/routes/pilot').embedUrl('https://example.com/x'), null);
  if (sa) {
    await post(sa, '/super/tutorials', { category: 'Logbook', title: 'Smoke tutorial', video_url: 'https://vimeo.com/123456', description: 'How to' });
    const tut = await L.one("SELECT id FROM tutorials WHERE title='Smoke tutorial'");
    assert.match(await get(st, `/pilot/tutorials/${tut.id}`), /player\.vimeo\.com\/video\/123456/);
    await post(st, `/pilot/tutorials/${tut.id}/comments`, { body: 'Great guide' });
    assert.match(await get(sa, '/super/tutorials'), /Great guide/);
  }

  // --- Completion credits: one per certificate, never below zero, free for Pilot Pro trainees.
  const s2 = await L.one("SELECT a.id, a.user_id FROM applications a JOIN users u ON u.id=a.user_id WHERE u.email='student2@demo.test'");
  await L.q('UPDATE rptos SET credits=1 WHERE id=?', [rid]);
  assert.ok((await T.useCompletionCredit(rid, s2, null)).ok);
  assert.equal((await L.one('SELECT credits FROM rptos WHERE id=?', [rid])).credits, 0);
  assert.equal((await T.useCompletionCredit(rid, s2, null)).ok, false);
  assert.equal(await T.addCredits(rid, -1, 'adjust'), false, 'cannot go below zero');
  await L.q('UPDATE users SET pro_until=CURDATE() + INTERVAL 5 DAY WHERE id=?', [s2.user_id]);
  assert.ok((await T.useCompletionCredit(rid, s2, null)).free);
  await L.q('UPDATE users SET pro_until=NULL WHERE id=?', [s2.user_id]);
  // Make student2 eligible, then certify through the real route: blocked at 0 credits, succeeds with 1, second click is a no-op.
  await L.q(`INSERT INTO attendance (session_id,user_id,present) SELECT id, ?, 1 FROM sessions WHERE batch_id=? AND trainee_id IS NULL AND type<>'test' AND status<>'cancelled'
    ON DUPLICATE KEY UPDATE present=1`, [s2.user_id, bid]);
  await L.q("UPDATE sessions SET status='done' WHERE batch_id=? AND trainee_id=?", [bid, s2.user_id]);
  await L.q('INSERT INTO test_results (test_id,user_id,score,total,passed) SELECT id, ?, 1, 1, 1 FROM tests WHERE batch_id=? ON DUPLICATE KEY UPDATE passed=1', [s2.user_id, bid]);
  await post(admin, `/rpto/applications/${s2.id}/certify`, {});
  assert.equal((await L.one('SELECT cert_no FROM applications WHERE id=?', [s2.id])).cert_no, null, 'no credit -> no certificate');
  await L.q('UPDATE rptos SET credits=1 WHERE id=?', [rid]);
  await post(admin, `/rpto/applications/${s2.id}/certify`, {});
  await post(admin, `/rpto/applications/${s2.id}/certify`, {});
  assert.ok((await L.one('SELECT cert_no FROM applications WHERE id=?', [s2.id])).cert_no, 'certified');
  assert.equal((await L.one('SELECT credits FROM rptos WHERE id=?', [rid])).credits, 0, 'exactly one credit used');
  assert.match(await get(admin, `/rpto/applications/${s2.id}/certificate`), /RPA Trainer/);
  // Recording the RPC purges the trainee's document files; the package still builds.
  await post(admin, `/rpto/applications/${s2.id}/rpc`, { rpc_no: 'RPC-SMOKE-1' });
  const left = await L.one("SELECT COUNT(*) n, SUM(file IS NULL AND status='purged') purged FROM trainee_documents WHERE user_id=?", [s2.user_id]);
  assert.equal(+left.purged, left.n, 'documents purged');
  assert.equal((await fetch(`${base}/rpto/applications/${s2.id}/package.zip`, { headers: { cookie: admin } })).status, 200);
  await get(admin, `/rpto/trainees/${s2.user_id}`);

  // --- Payments: verify callback settles once, extends Pro, and pays the certifying RPTO its partner share; bad signatures fail.
  const signed = (oid, pid) => ({ razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: crypto.createHmac('sha256', 'smoke_secret').update(`${oid}|${pid}`).digest('hex') });
  const st2 = await session('student2@demo.test');
  await L.q("INSERT INTO payments (user_id,plan,amount_paise,order_id) VALUES (?, 'pro_month', 34900, 'order_smoke1')", [s2.user_id]);
  assert.equal((await post(st2, '/student/billing/verify', signed('order_smoke1', 'pay_smoke1'))).status, 302);
  const pro1 = (await L.one('SELECT pro_until FROM users WHERE id=?', [s2.user_id])).pro_until;
  assert.ok(pro1 > L.today(), 'pro active');
  await post(st2, '/student/billing/verify', signed('order_smoke1', 'pay_smoke1')); // replayed callback
  assert.equal((await L.one('SELECT pro_until FROM users WHERE id=?', [s2.user_id])).pro_until, pro1, 'no double extension');
  const earn = await L.q('SELECT * FROM partner_earnings WHERE user_id=?', [s2.user_id]);
  assert.equal(earn.length, 1); assert.equal(earn[0].rpto_id, rid); assert.equal(earn[0].amount_paise, 3490);
  await L.q("INSERT INTO payments (user_id,plan,amount_paise,order_id) VALUES (?, 'pro_month', 34900, 'order_smoke_bad')", [s2.user_id]);
  await post(st2, '/student/billing/verify', { ...signed('order_smoke_bad', 'pay_x'), razorpay_signature: 'forged' });
  assert.equal((await L.one("SELECT status FROM payments WHERE order_id='order_smoke_bad'")).status, 'failed');
  await get(st2, '/student/billing');
  // RPTO buys 3 credits.
  const adminId = (await L.one("SELECT id FROM users WHERE email='admin@demo.test'")).id;
  await L.q("INSERT INTO payments (user_id,rpto_id,plan,quantity,amount_paise,order_id) VALUES (?,?,'credits',3,104700,'order_smoke2')", [adminId, rid]);
  await post(admin, '/rpto/billing/verify', signed('order_smoke2', 'pay_smoke2'));
  await post(admin, '/rpto/billing/verify', signed('order_smoke2', 'pay_smoke2'));
  assert.equal((await L.one('SELECT credits FROM rptos WHERE id=?', [rid])).credits, 3, 'credits added once');
  assert.match(await get(admin, '/rpto/billing'), /Completion credits left/);
  assert.match(await get(admin, '/rpto'), /Completion credits left/);
  // Super admin: grant/deduct credits, pay out partner earnings.
  if (sa) {
    assert.match(await get(sa, '/super/rptos/' + rid), /completion credits/);
    await post(sa, `/super/rptos/${rid}/credits`, { delta: '2', note: 'smoke' });
    await post(sa, `/super/rptos/${rid}/credits`, { delta: '-1000' });
    assert.equal((await L.one('SELECT credits FROM rptos WHERE id=?', [rid])).credits, 5);
    assert.match(await get(sa, '/super/payments'), /Partner earnings to pay out/);
    await post(sa, `/super/rptos/${rid}/earnings-paid`, {});
    assert.equal((await L.one('SELECT status FROM partner_earnings WHERE user_id=?', [s2.user_id])).status, 'paid');
  }
  const hdr = await fetch(base + '/login');
  assert.equal(hdr.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(hdr.headers.get('x-frame-options'), 'SAMEORIGIN');

  // Password reset link (email flow) for student3, then old password fails and new one works.
  const s3 = await L.one("SELECT id FROM users WHERE email='student3@demo.test'");
  const link = await L.resetLink({ protocol: 'http', get: () => 'x' }, s3.id, 1);
  const token = link.split('/reset/')[1];
  assert.match(await get('', '/reset/' + token), /Set a new password/);
  assert.equal((await post('', '/reset/' + token, { password: 'NewPass@123' })).status, 302);
  await session('student3@demo.test', 'NewPass@123');
  assert.equal((await post('', '/reset/' + token, { password: 'Again@1234' })).status, 200); // token single-use -> invalid page

  // RPTO admin resets a trainee's password -> the trainee's existing session is revoked.
  assert.equal((await post(admin, `/rpto/users/${app1.user_id}/password`, {})).status, 302);
  await get(st, '/student', 302);
  // "Sign out of all other devices" revokes older sessions but keeps the current one.
  const i2 = await session('instructor@demo.test');
  const r2 = await post(inst, '/account/signout-all', {});
  const fresh = sidOf(r2);
  await get(fresh, '/account');
  await get(i2, '/account', 302);

  // Two-step verification: enable with a live code, then the password alone no longer signs in; each code works once.
  const bdId = (await L.one("SELECT id FROM users WHERE email='sales@demo.test'")).id;
  await get(bd, '/account/2fa');
  const secret = (await L.one('SELECT totp_secret FROM users WHERE id=?', [bdId])).totp_secret;
  const step = Math.floor(Date.now() / 30000);
  const on = await post(bd, '/account/2fa/enable', { code: L.totp(secret, step) });
  const codes = [...new Set((await on.text()).match(/[A-Z2-7]{5}-[A-Z2-7]{5}/g))]; // listed + in the Copy button
  assert.equal(codes.length, 8, 'recovery codes shown once');
  await get(bd, '/rpto/crm', 302); // enabling signs out other sessions (this one got a fresh cookie in `on`)
  const step1 = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'sales@demo.test', password: 'Demo@1234' }) });
  assert.equal(step1.headers.get('location'), '/login/2fa');
  assert.ok(!step1.headers.getSetCookie().some(c => c.startsWith('sid=')), 'no session before the second step');
  const mfa = step1.headers.getSetCookie().find(c => c.startsWith('mfa=')).split(';')[0];
  assert.equal((await post(mfa, '/login/2fa', { code: L.totp(secret, step) })).status, 401, 'a used code is refused');
  const ok2 = await post(mfa, '/login/2fa', { code: L.totp(secret, step + 1) });
  assert.equal(ok2.status, 302); await get(sidOf(ok2), '/rpto/crm');
  assert.equal((await post(mfa, '/login/2fa', { code: codes[0] })).status, 302, 'recovery code works');
  assert.equal((await post(mfa, '/login/2fa', { code: codes[0] })).status, 401, 'recovery code works once');
  if (sa) {
    await post(sa, `/super/users/${bdId}/2fa-reset`, {});
    assert.equal((await L.one('SELECT totp_enabled FROM users WHERE id=?', [bdId])).totp_enabled, 0);
    await session('sales@demo.test');
  }

  // Your data: export ZIP, delete account (anonymised), and the last admin can't delete themselves.
  const st1 = await session('student1@demo.test', 'Demo@1234').catch(() => null) || await (async () => {
    await L.q('UPDATE users SET password_hash=? WHERE id=?', [L.hashPassword('Demo@1234'), app1.user_id]); return session('student1@demo.test');
  })();
  const ex = await fetch(base + '/account/export', { headers: { cookie: st1 } });
  assert.equal(ex.headers.get('content-type'), 'application/zip');
  assert.ok((await ex.arrayBuffer()).byteLength > 200);
  const s3c = await session('student3@demo.test', 'NewPass@123');
  await post(s3c, '/account/delete', { confirm: 'DELETE', password: 'wrong' });
  assert.equal((await L.one('SELECT active FROM users WHERE id=?', [s3.id])).active, 1, 'wrong password keeps the account');
  await post(s3c, '/account/delete', { confirm: 'DELETE', password: 'NewPass@123' });
  const gone = await L.one('SELECT name, email, active, phone FROM users WHERE id=?', [s3.id]);
  assert.equal(gone.active, 0); assert.match(gone.email, /^deleted-\d+@invalid\.local$/); assert.equal(gone.phone, null);
  assert.equal((await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'student3@demo.test', password: 'NewPass@123' }) })).status, 401);
  await post(admin, '/account/delete', { confirm: 'DELETE', password: 'Demo@1234' });
  assert.equal((await L.one("SELECT active FROM users WHERE email='admin@demo.test'")).active, 1, 'last admin kept');

  server.close();
  await L.pool.end();
  console.log('smoke test passed');
})().catch(e => { console.error(e); process.exit(1); });

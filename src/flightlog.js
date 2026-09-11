// Flight-log parser: ArduPilot DataFlash (.bin), ArduPilot text (.log), PX4 ULog (.ulg) and CSV/TXT exports
// -> one normalised track: { format, startedAt, duration_s, distance_m, max_alt_m, max_speed, bat_unit, points,
//    series, params, mission, events, vehicle }  (series/params/mission only where the log has them)
// points: [[t, lat, lon, alt_rel, spd, hdg, bat, sats, msl, mode, climb, rcThr, rcYaw, rcPit, rcRol, volt, curr, vibe, pitch, roll], ...]
// ponytail: INAV/Betaflight blackbox logs are not decoded — export them to CSV from Blackbox Explorer first.

const MAX_POINTS = 3000, MAX_SERIES = 1500, MAX_STREAM = 200000;
const GPS_EPOCH = Date.UTC(1980, 0, 6), LEAP_S = 18;
const COPTER = { 0: 'Stabilize', 1: 'Acro', 2: 'AltHold', 3: 'Auto', 4: 'Guided', 5: 'Loiter', 6: 'RTL', 7: 'Circle', 9: 'Land', 11: 'Drift', 13: 'Sport', 14: 'Flip',
  15: 'AutoTune', 16: 'PosHold', 17: 'Brake', 18: 'Throw', 19: 'Avoid_ADSB', 20: 'Guided_NoGPS', 21: 'Smart_RTL', 22: 'FlowHold', 23: 'Follow', 24: 'ZigZag', 25: 'SystemID', 26: 'Heli_Autorotate', 27: 'Auto RTL' };
const PLANE = { 0: 'Manual', 1: 'Circle', 2: 'Stabilize', 3: 'Training', 4: 'Acro', 5: 'FBWA', 6: 'FBWB', 7: 'Cruise', 8: 'AutoTune', 10: 'Auto', 11: 'RTL', 12: 'Loiter',
  13: 'Takeoff', 14: 'Avoid_ADSB', 15: 'Guided', 17: 'QStabilize', 18: 'QHover', 19: 'QLoiter', 20: 'QLand', 21: 'QRTL', 22: 'QAutotune', 23: 'QAcro', 24: 'Thermal' };
const ROVER = { 0: 'Manual', 1: 'Acro', 3: 'Steering', 4: 'Hold', 5: 'Loiter', 6: 'Follow', 7: 'Simple', 10: 'Auto', 11: 'RTL', 12: 'Smart_RTL', 15: 'Guided' };
const PX4_NAV = { 0: 'Manual', 1: 'Altitude', 2: 'Position', 3: 'Mission', 4: 'Hold', 5: 'Return', 10: 'Acro', 12: 'Descend', 13: 'Termination', 14: 'Offboard',
  15: 'Stabilized', 17: 'Takeoff', 18: 'Land', 19: 'Follow', 20: 'Precision land', 21: 'Orbit', 22: 'VTOL takeoff' };
const ERR_SUBSYS = { 2: 'Radio', 3: 'Compass', 5: 'Radio failsafe', 6: 'Battery failsafe', 8: 'GCS failsafe', 10: 'Flight mode', 11: 'GPS', 12: 'Crash check',
  16: 'EKF check', 17: 'EKF failsafe', 18: 'Barometer', 19: 'CPU load', 22: 'Navigation', 24: 'EKF primary', 25: 'Thrust loss', 26: 'Sensor failsafe', 29: 'Vibration failsafe', 30: 'Internal error' };

// A growable list that halves itself (keeping every 2nd row) when full — bounded memory for 400 Hz logs.
function capped() {
  const a = []; let stride = 1, n = 0;
  a.add = row => {
    if (n++ % stride) return;
    a.push(row);
    if (a.length >= MAX_STREAM) { let w = 0; for (let r = 0; r < a.length; r += 2) a[w++] = a[r]; a.length = w; stride *= 2; }
  };
  return a;
}
// Collects the ArduPilot messages the replay/analysis use, as compact tuples [t, ...] (t = seconds since boot).
function apStreams() {
  const s = { gps: [], bat: capped(), mode: [], vibe: capped(), rc: capped(), att: capped(), rate: capped(), err: [], cmd: [], params: {}, msgs: [] };
  s.add = (name, m) => {
    const t = m.TimeUS !== undefined ? m.TimeUS / 1e6 : m.TimeMS !== undefined ? m.TimeMS / 1e3 : null;
    const first = (m.I ?? m.Inst ?? m.Instance ?? m.IMU ?? 0) === 0;
    switch (name) {
      case 'GPS': s.gps.push(m); break;
      case 'BAT': case 'CURR': if (first) s.bat.add([t, m.Volt ?? m.VoltR, m.Curr]); break;
      case 'MODE': s.mode.push([t, m.Mode ?? m.ModeNum]); break;
      case 'VIBE': if (first) s.vibe.add([t, m.VibeX, m.VibeY, m.VibeZ]); break;
      case 'RCIN': s.rc.add([t, m.C1, m.C2, m.C3, m.C4]); break;
      case 'ATT': s.att.add([t, m.DesRoll, m.Roll, m.DesPitch, m.Pitch, m.DesYaw, m.Yaw]); break;
      case 'RATE': s.rate.add([t, m.RDes, m.R, m.PDes, m.P, m.YDes, m.Y]); break;
      case 'ERR': s.err.push([t, m.Subsys, m.ECode]); break;
      case 'CMD': s.cmd.push([m.CNum, m.CId, m.Lat, m.Lng, m.Alt]); break;
      case 'PARM': if (typeof m.Name === 'string') s.params[m.Name] = Number.isFinite(m.Value) ? +m.Value.toPrecision(7) : m.Value; break; // float32 noise off
      case 'MSG': if (s.msgs.length < 60) s.msgs.push([t, String(m.Message || '')]); break;
    }
  };
  return s;
}
const AP_WANT = new Set(['GPS', 'BAT', 'CURR', 'MODE', 'VIBE', 'RCIN', 'ATT', 'RATE', 'ERR', 'CMD', 'PARM', 'MSG']);

function parse(buf) {
  let r;
  if (buf[0] === 0xa3 && buf[1] === 0x95) r = { format: 'ardupilot_bin', ...parseBin(buf) };
  else if (buf.toString('latin1', 0, 4) === 'ULog') r = { format: 'px4_ulog', ...parseULog(buf) };
  else {
    const text = buf.toString('utf8');
    r = /^\s*FMT\s*,/m.test(text.slice(0, 50000)) ? { format: 'ardupilot_log', ...parseApText(text) } : { format: 'csv', ...parseCsv(text) };
  }
  return finish(r);
}

// ---------- ArduPilot DataFlash binary ----------
const SIZE = { a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64, c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8 };
function field(buf, o, ch) {
  switch (ch) {
    case 'b': return buf.readInt8(o);
    case 'B': case 'M': return buf.readUInt8(o);
    case 'h': return buf.readInt16LE(o);
    case 'H': return buf.readUInt16LE(o);
    case 'i': return buf.readInt32LE(o);
    case 'I': return buf.readUInt32LE(o);
    case 'L': return buf.readInt32LE(o) / 1e7;
    case 'f': return buf.readFloatLE(o);
    case 'd': return buf.readDoubleLE(o);
    case 'c': return buf.readInt16LE(o) / 100;
    case 'C': return buf.readUInt16LE(o) / 100;
    case 'e': return buf.readInt32LE(o) / 100;
    case 'E': return buf.readUInt32LE(o) / 100;
    case 'q': return Number(buf.readBigInt64LE(o));
    case 'Q': return Number(buf.readBigUInt64LE(o));
    case 'n': case 'N': case 'Z': return buf.toString('latin1', o, o + SIZE[ch]).replace(/\0[\s\S]*$/, '');
    default: return null; // 'a' (int16[32]) not needed
  }
}
function parseBin(buf) {
  const fmts = { 128: { name: 'FMT', len: 89, format: 'BBnNZ', cols: ['Type', 'Length', 'Name', 'Format', 'Columns'] } };
  const s = apStreams();
  let i = 0;
  while (i + 3 <= buf.length) {
    if (buf[i] !== 0xa3 || buf[i + 1] !== 0x95) { i++; continue; }
    const type = buf[i + 2], f = fmts[type];
    if (!f || f.len < 3) { i++; continue; }
    if (i + f.len > buf.length) break;
    if (type === 128 || AP_WANT.has(f.name)) {
      const m = {};
      for (let k = 0, o = i + 3; k < f.format.length; o += SIZE[f.format[k]] || 0, k++) m[f.cols[k]] = field(buf, o, f.format[k]);
      if (type === 128) fmts[m.Type] = { name: m.Name, len: m.Length, format: m.Format, cols: m.Columns.split(',') };
      else s.add(f.name, m);
    }
    i += f.len;
  }
  return fromAp(s);
}

// ---------- ArduPilot text log (Mission Planner "log" format) ----------
function parseApText(text) {
  const cols = {}, s = apStreams();
  for (const line of text.split(/\r?\n/)) {
    const p = line.split(',').map(x => x.trim());
    if (p[0] === 'FMT' && p.length > 5) cols[p[3]] = p.slice(5);
    else if (AP_WANT.has(p[0]) && cols[p[0]]) {
      const m = {};
      cols[p[0]].forEach((c, k) => { const v = p[k + 1]; m[c] = v !== undefined && v !== '' && Number.isFinite(+v) ? +v : v; });
      s.add(p[0], m);
    }
  }
  return fromAp(s);
}

// Sample-and-hold lookup into a time-sorted stream: returns the latest row at or before t.
function holder(rows) {
  let j = 0, cur = null;
  return t => { while (j < rows.length && rows[j][0] <= t) cur = rows[j++]; return cur; };
}
const stick = (pwm, thr) => (Number.isFinite(pwm) && pwm > 800 ? +(thr ? Math.min(1, Math.max(0, (pwm - 1000) / 1000)) : Math.min(1, Math.max(-1, (pwm - 1500) / 500))).toFixed(2) : null);

function fromAp(s) {
  const fw = s.msgs.map(m => m[1]).join(' ');
  const vehicle = /ArduPlane/i.test(fw) ? 'plane' : /Rover/i.test(fw) ? 'rover' : 'copter';
  const names = { plane: PLANE, rover: ROVER, copter: COPTER }[vehicle];
  const hBat = holder(s.bat), hMode = holder(s.mode), hVibe = holder(s.vibe), hRc = holder(s.rc), hAtt = holder(s.att);
  let startedAt = null;
  const points = [];
  for (const m of s.gps) {
    if ((m.I ?? 0) !== 0 || (m.Status !== undefined && m.Status < 3)) continue; // primary GPS with 3D fix only
    const t = m.TimeUS !== undefined ? m.TimeUS / 1e6 : m.TimeMS / 1e3;
    if (!startedAt && m.GWk > 0) startedAt = new Date(GPS_EPOCH + m.GWk * 604800000 + (m.GMS || 0) - LEAP_S * 1000 - t * 1000);
    const b = hBat(t), md = hMode(t), v = hVibe(t), rc = hRc(t), at = hAtt(t);
    points.push({
      t, lat: m.Lat, lon: m.Lng, alt: m.Alt ?? m.RelAlt, msl: m.Alt, spd: m.Spd, hdg: m.GCrs, bat: b && b[1] > 0 ? b[1] : null, sats: m.NSats,
      mode: md ? names[md[1]] ?? `Mode ${md[1]}` : null, volt: b?.[1] ?? null, curr: b?.[2] ?? null, vibe: v ? Math.max(v[1], v[2], v[3]) : null,
      rc: rc ? [stick(rc[3], true), stick(rc[4]), stick(rc[2]), stick(rc[1])] : null, pitch: at?.[4] ?? null, roll: at?.[2] ?? null,
    });
  }
  if (startedAt) startedAt = new Date(startedAt.getTime() + (points[0]?.t || 0) * 1000);
  const NAV = new Set([16, 17, 18, 19, 21, 22, 82]); // waypoint, loiters, land, take-off, spline waypoint
  return {
    points, startedAt, bat_unit: 'V', vehicle, params: s.params,
    mission: s.cmd.filter(c => NAV.has(c[1]) && (c[2] || c[3])).sort((a, b) => a[0] - b[0]).map(c => [c[0], c[1], c[2], c[3], c[4]]),
    streams: {
      att: s.att, rate: s.rate, vibe: s.vibe, bat: s.bat, rc: s.rc, rateUnit: 'deg',
      modes: s.mode.map(([t, n]) => [t, names[n] ?? `Mode ${n}`]),
      errors: s.err.map(([t, sub, code]) => [t, ERR_SUBSYS[sub] || `Subsystem ${sub}`, code]),
    },
  };
}

// ---------- PX4 ULog ----------
const UT = { int8_t: 1, uint8_t: 1, int16_t: 2, uint16_t: 2, int32_t: 4, uint32_t: 4, int64_t: 8, uint64_t: 8, float: 4, double: 8, bool: 1, char: 1 };
function ulogRead(buf, o, t) {
  switch (t) {
    case 'int8_t': return buf.readInt8(o);
    case 'uint8_t': case 'bool': case 'char': return buf.readUInt8(o);
    case 'int16_t': return buf.readInt16LE(o);
    case 'uint16_t': return buf.readUInt16LE(o);
    case 'int32_t': return buf.readInt32LE(o);
    case 'uint32_t': return buf.readUInt32LE(o);
    case 'int64_t': return Number(buf.readBigInt64LE(o));
    case 'uint64_t': return Number(buf.readBigUInt64LE(o));
    case 'float': return buf.readFloatLE(o);
    case 'double': return buf.readDoubleLE(o);
  }
}
const DEG = 180 / Math.PI;
const euler = q => q && q.length === 4 ? [Math.atan2(2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[1] ** 2 + q[2] ** 2)) * DEG,
  Math.asin(Math.max(-1, Math.min(1, 2 * (q[0] * q[2] - q[3] * q[1])))) * DEG, Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)) * DEG] : null;
const PX4_WANT = new Set(['vehicle_gps_position', 'sensor_gps', 'battery_status', 'vehicle_status', 'vehicle_attitude', 'vehicle_attitude_setpoint',
  'vehicle_rates_setpoint', 'vehicle_angular_velocity', 'input_rc', 'vehicle_imu_status', 'vehicle_local_position']);
function parseULog(buf) {
  const formats = {}, subs = {}, params = {}, msgs = {};
  const sizeOf = t => UT[t] ?? (formats[t] || []).reduce((s, f) => s + sizeOf(f.type) * f.count, 0);
  const decode = (name, o, end) => {
    const m = {};
    for (const f of formats[name] || []) {
      const one = sizeOf(f.type), sz = one * f.count;
      if (UT[f.type] && o + sz <= end) m[f.name] = f.count === 1 ? ulogRead(buf, o, f.type) : Array.from({ length: f.count }, (_, k) => ulogRead(buf, o + k * one, f.type));
      o += sz;
    }
    return m;
  };
  let i = 16;
  while (i + 3 <= buf.length) {
    const size = buf.readUInt16LE(i), type = String.fromCharCode(buf[i + 2]), p = i + 3;
    if (p + size > buf.length) break;
    if (type === 'F') {
      const s = buf.toString('latin1', p, p + size), c = s.indexOf(':');
      formats[s.slice(0, c)] = s.slice(c + 1).split(';').filter(Boolean).map(x => {
        const [t, n] = x.trim().split(/\s+/), m = t.match(/^([\w]+)(?:\[(\d+)\])?$/);
        return { type: m[1], count: +(m[2] || 1), name: n };
      });
    } else if (type === 'A') {
      subs[buf.readUInt16LE(p + 1)] = { multi: buf[p], name: buf.toString('latin1', p + 3, p + size) };
    } else if (type === 'P') { // parameter: key "float NAME" / "int32_t NAME", then the value
      const kl = buf[p], [t, name] = buf.toString('latin1', p + 1, p + 1 + kl).split(' ');
      if (name && (t === 'float' || t === 'int32_t') && p + 1 + kl + 4 <= p + size) params[name] = +ulogRead(buf, p + 1 + kl, t).toFixed(6);
    } else if (type === 'D') {
      const sub = subs[buf.readUInt16LE(p)];
      if (sub && sub.multi === 0 && PX4_WANT.has(sub.name)) (msgs[sub.name] ||= []).push(decode(sub.name, p + 2, p + size));
    }
    i = p + size;
  }
  const T = m => m.timestamp / 1e6, rows = (name, fn) => (msgs[name] || []).map(m => { const r = fn(m); return r && [T(m), ...r]; }).filter(Boolean);
  // Attitude / rates as [t, desired, actual] triplets, with the latest setpoint held against each measurement.
  const sp = holder(rows('vehicle_attitude_setpoint', m => euler(m.q_d) || [m.roll_body * DEG, m.pitch_body * DEG, m.yaw_body * DEG]));
  const att = rows('vehicle_attitude', m => { const e = euler(m.q); const d = sp(T(m)); return e && [d?.[1], e[0], d?.[2], e[1], d?.[3], e[2]]; });
  const rsp = holder(rows('vehicle_rates_setpoint', m => [m.roll * DEG, m.pitch * DEG, m.yaw * DEG]));
  const rate = rows('vehicle_angular_velocity', m => { const d = rsp(T(m)); return m.xyz && [d?.[1], m.xyz[0] * DEG, d?.[2], m.xyz[1] * DEG, d?.[3], m.xyz[2] * DEG]; });
  const bat = rows('battery_status', m => [m.voltage_v, m.current_a]), vibe = rows('vehicle_imu_status', m => [m.accel_vibration_metric, m.accel_vibration_metric, m.accel_vibration_metric]);
  const rc = rows('input_rc', m => m.values && m.values.slice(0, 4)), mode = rows('vehicle_status', m => [PX4_NAV[m.nav_state] ?? `Nav ${m.nav_state}`]);
  const climb = rows('vehicle_local_position', m => [Number.isFinite(m.vz) ? -m.vz : null]);
  const modes = mode.filter((m, k) => !k || m[1] !== mode[k - 1][1]);
  const hBat = holder(bat), hMode = holder(mode), hVibe = holder(vibe), hRc = holder(rc), hAtt = holder(att), hClimb = holder(climb);
  let startedAt = null;
  const points = [];
  for (const m of msgs.vehicle_gps_position || msgs.sensor_gps || []) {
    if (m.fix_type !== undefined && m.fix_type < 3) continue;
    const t = T(m), b = hBat(t), v = hVibe(t), r = hRc(t), a = hAtt(t), md = hMode(t), c = hClimb(t);
    if (!startedAt && m.time_utc_usec > 0) startedAt = new Date(m.time_utc_usec / 1000);
    const msl = m.altitude_msl_m ?? m.alt / 1000;
    points.push({
      t, lat: m.latitude_deg ?? m.lat / 1e7, lon: m.longitude_deg ?? m.lon / 1e7, alt: msl, msl, spd: m.vel_m_s,
      hdg: m.cog_rad !== undefined ? m.cog_rad * DEG : undefined, bat: b?.[1] ?? null, sats: m.satellites_used, mode: md?.[1] ?? null,
      volt: b?.[1] ?? null, curr: b?.[2] ?? null, vibe: v?.[1] ?? null, climb: c?.[1] ?? undefined, pitch: a?.[4] ?? null, roll: a?.[2] ?? null,
      rc: r ? [stick(r[3], true), stick(r[4]), stick(r[2]), stick(r[1])] : null,
    });
  }
  return { points, startedAt, bat_unit: 'V', vehicle: 'px4', params, mission: [],
    streams: { att, rate, vibe, bat, rc, rateUnit: 'deg', modes, errors: [] } };
}

// ---------- CSV / TXT (generic, DJI/Airdata-style headers with units) ----------
const COLS = {
  t: /^(time|timestamp|datetime|date_time|t|time_s|time_us|timeus|time_ms|timems|elapsed|elapsed_time|seconds|flight_time|offset_time)$/,
  lat: /^(lat|latitude|gps_lat|lat_deg|latitude_deg|gps_latitude)$/,
  lon: /^(lon|lng|long|longitude|gps_lon|gps_lng|lon_deg|longitude_deg|gps_longitude)$/,
  rel: /^(rel_alt|relalt|relative_alt|relative_altitude|height_above_takeoff|height|alt_rel|altitude_relative)$/,
  alt: /^(alt|altitude|alt_m|altitude_m|gps_alt|altitude_above_sealevel|alt_msl|altitude_msl)$/,
  spd: /^(speed|spd|groundspeed|ground_speed|gs|gps_speed|velocity|hspeed|horizontal_speed)$/,
  hdg: /^(heading|hdg|yaw|course|cog|compass_heading|gcrs)$/,
  bat: /^(battery|voltage|volt|bat|batt|vbat|battery_v|battery_voltage|battery_percent|battery_level)$/,
  sats: /^(sats|satellites|nsats|numsat|num_sats|gps_sats|satellite_count|gps_num_sats|gps_nsats)$/,
};
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 3) return { points: [] };
  const delim = [',', '\t', ';'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const head = lines[0].split(delim).map(h => {
    const raw = h.trim().replace(/^"|"$/g, '').toLowerCase();
    return { unit: (raw.match(/[([](.*?)[)\]]/) || [])[1] || '', name: raw.replace(/[([].*?[)\]]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') };
  });
  const idx = k => head.findIndex(h => COLS[k].test(h.name));
  const c = Object.fromEntries(Object.keys(COLS).map(k => [k, idx(k)]));
  if (c.lat < 0 || c.lon < 0) throw new Error('CSV needs latitude and longitude columns (e.g. "lat,lon,alt,time").');
  const altCol = c.rel >= 0 ? c.rel : c.alt;
  const scale = (col, kind) => {
    const u = col >= 0 ? head[col].unit + ' ' + head[col].name : '';
    if (kind === 'len') return /feet|ft/.test(u) ? 0.3048 : 1;
    if (kind === 'spd') return /mph/.test(u) ? 0.44704 : /km/.test(u) ? 1 / 3.6 : /knot|kt/.test(u) ? 0.514444 : 1;
    if (kind === 't') return /micro|us/.test(u) ? 1e-6 : /milli|ms/.test(u) ? 1e-3 : 1;
  };
  const kAlt = scale(altCol, 'len'), kSpd = scale(c.spd, 'spd'), kT = scale(c.t, 't');
  const cell = (row, col) => col >= 0 ? (row[col] || '').trim().replace(/^"|"$/g, '') : '';
  const num = (row, col) => { const v = parseFloat(cell(row, col)); return Number.isFinite(v) ? v : undefined; };
  let startedAt = null;
  const points = lines.slice(1).map((line, n) => {
    const row = line.split(delim);
    let t = n;
    if (c.t >= 0) {
      const s = cell(row, c.t);
      if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(s)) t = parseFloat(s) * kT;
      else { const ms = Date.parse(s.replace(' ', 'T')); if (Number.isFinite(ms)) { t = ms / 1000; startedAt ||= new Date(ms); } }
    }
    let lat = num(row, c.lat), lon = num(row, c.lon);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { lat /= 1e7; lon /= 1e7; } // integer 1e-7 degrees
    const a = num(row, altCol), s = num(row, c.spd);
    return { t, lat, lon, alt: a === undefined ? 0 : a * kAlt, spd: s === undefined ? undefined : s * kSpd, hdg: num(row, c.hdg), bat: num(row, c.bat), sats: num(row, c.sats) };
  });
  const batUnit = c.bat >= 0 && /percent|level|%/.test(head[c.bat].name + head[c.bat].unit) ? '%' : 'V';
  return { points, startedAt, bat_unit: batUnit };
}

// ---------- normalise ----------
const R = 6371000, rad = d => d * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const r1 = (v, k) => Number.isFinite(v) ? Math.round(v * k) / k : null;
function finish(r) {
  const pts = (r.points || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t) && (p.lat || p.lon) && Math.abs(p.lat) <= 90)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) throw new Error('No usable GPS track found in this log (needs a 3D GPS fix).');
  const t0 = pts[0].t, a0 = Number.isFinite(pts[0].alt) ? pts[0].alt : 0;
  let distance = 0, maxAlt = 0, maxSpd = 0, back = 0;
  pts.forEach((p, k) => {
    const prev = pts[k - 1];
    p.t -= t0; // rebase first: prev.t is already relative
    p.alt = (Number.isFinite(p.alt) ? p.alt : a0) - a0;
    const d = prev ? dist(prev, p) : 0, dt = prev ? p.t - prev.t : 0;
    distance += d;
    if (!Number.isFinite(p.spd)) p.spd = dt > 0 ? d / dt : 0;
    if (!Number.isFinite(p.hdg)) p.hdg = prev && d > 0.3 ? bearing(prev, p) : prev ? prev.hdg : 0;
    if (!Number.isFinite(p.climb)) { // altitude change over the last ~1 s
      while (back < k - 1 && p.t - pts[back + 1].t >= 1) back++;
      const q = pts[back]; p.climb = k && p.t > q.t ? (p.alt - q.alt) / (p.t - q.t) : 0;
    }
    maxAlt = Math.max(maxAlt, p.alt); maxSpd = Math.max(maxSpd, p.spd);
  });
  const step = Math.ceil(pts.length / MAX_POINTS);
  const kept = pts.filter((_, k) => k % step === 0 || k === pts.length - 1);
  const points = kept.map(p => {
    const rc = p.rc || [];
    const a = [r1(p.t, 10), r1(p.lat, 1e7), r1(p.lon, 1e7), r1(p.alt, 10), r1(p.spd, 10), Math.round(p.hdg || 0), r1(p.bat, 100), Number.isFinite(p.sats) ? p.sats : null,
      r1(p.msl, 10), p.mode ?? null, r1(p.climb, 10), rc[0] ?? null, rc[1] ?? null, rc[2] ?? null, rc[3] ?? null, r1(p.volt, 100), r1(p.curr, 10), r1(p.vibe, 10), r1(p.pitch, 10), r1(p.roll, 10)];
    while (a.length > 8 && a.at(-1) == null) a.pop(); // simple logs stay compact
    return a;
  });
  const span = pts.at(-1).t, s = r.streams;
  const rebase = t => Math.max(0, r1(t - t0, 10));
  const series = s && Object.fromEntries(['att', 'rate', 'vibe', 'bat', 'rc'].map(k => {
    const rows = (s[k] || []).filter(x => Number.isFinite(x[0]) && x[0] - t0 >= -2 && x[0] - t0 <= span + 2), stride = Math.ceil(rows.length / MAX_SERIES) || 1;
    return [k, rows.filter((_, n) => n % stride === 0).map(x => [rebase(x[0]), ...x.slice(1).map(v => r1(v, 100))])];
  }));
  const modes = [];
  for (const [t, n] of s?.modes || []) {
    const tt = rebase(t);
    if (tt > span) break;
    if (modes.at(-1)?.[0] === tt) modes.pop(); // several changes before take-off: keep the last
    if (modes.at(-1)?.[1] !== n) modes.push([tt, n]);
  }
  const events = s && { modes, errors: (s.errors || []).filter(e => e[0] - t0 <= span).map(([t, sub, code]) => [rebase(t), sub, code]) };
  const p = r.params || {};
  const fence = p.FENCE_ENABLE ? { radius: p.FENCE_RADIUS || null, alt: p.FENCE_ALT_MAX || null } : p.GF_ACTION ? { radius: p.GF_MAX_HOR_DIST || null, alt: p.GF_MAX_VER_DIST || null } : null;
  const out = {
    format: r.format, startedAt: r.startedAt || null, bat_unit: r.bat_unit || 'V', vehicle: r.vehicle || null,
    duration_s: Math.round(span), distance_m: Math.round(distance), max_alt_m: r1(maxAlt, 10), max_speed: r1(maxSpd, 10), points,
    series: series || null, events: events || null, params: Object.keys(p).length ? p : null,
    mission: (r.mission || []).filter(m => m[0] > 0).map(m => [m[0], m[1], r1(m[2], 1e7), r1(m[3], 1e7), r1(m[4], 10)]), fence,
  };
  out.analysis = require('./analysis').analyse({ ...out, streams: s, t0 });
  return out;
}

module.exports = { parse };

// Live monitor: polls a local mavlink2rest bridge (read-only GETs) or runs a simulated demo flight,
// draws the track top-down and records points that can be saved as a CSV flight log.
(() => {
  const $ = id => document.getElementById(id), cv = $('map'), ctx = cv.getContext('2d');
  const COPTER = { 0: 'Stabilize', 1: 'Acro', 2: 'AltHold', 3: 'Auto', 4: 'Guided', 5: 'Loiter', 6: 'RTL', 7: 'Circle', 9: 'Land', 11: 'Drift', 13: 'Sport', 16: 'PosHold', 17: 'Brake', 21: 'Smart RTL' };
  let timer = null, points = [], t0 = 0, home = null, last = {}, mode = null;
  const val = v => (v && typeof v === 'object' ? v.bits ?? v.type ?? v.value : v); // mavlink2rest wraps enums/bitmasks
  const setStatus = (t, bad) => { $('status').textContent = t; $('status').style.color = bad ? 'var(--bad)' : ''; };
  const buttons = running => { $('connect').disabled = $('demo').disabled = running; $('stop').disabled = !running; $('save').disabled = points.length < 5; };

  function metres(lat, lon) { // local flat-earth offset from home, fine for a flying field
    if (!home) return [0, 0];
    return [(lon - home.lon) * 111320 * Math.cos(home.lat * Math.PI / 180), (lat - home.lat) * 110540];
  }
  function sample(s) { // s: { lat, lon, alt, spd, hdg, climb, volt, curr, pct, sats, fix, armed, mode }
    last = s;
    if (!s.lat && !s.lon) return render();
    if (!home) home = { lat: s.lat, lon: s.lon };
    if (s.armed || points.length) { // record from arming onwards
      if (!t0) t0 = Date.now();
      const t = s.t ?? (Date.now() - t0) / 1000, p = points.at(-1); // the demo supplies its own (sped-up) clock
      if (!p || t - p[0] >= 0.5) points.push([+t.toFixed(1), s.lat, s.lon, +s.alt.toFixed(1), s.volt != null ? +s.volt.toFixed(2) : '', s.sats ?? '']);
    }
    render();
  }
  function render() {
    const s = last, [x, y] = s.lat ? metres(s.lat, s.lon) : [0, 0], dist = Math.hypot(x, y);
    $('vArm').textContent = s.armed == null ? '—' : s.armed ? 'ARMED' : 'Disarmed';
    $('vArm').style.color = s.armed ? 'var(--bad)' : '';
    $('vMode').textContent = s.mode ?? '—';
    const secs = s.t ?? (t0 ? (Date.now() - t0) / 1000 : 0);
    $('vTime').textContent = new Date(secs * 1000).toISOString().slice(14, 19);
    $('vAlt').textContent = s.alt != null ? s.alt.toFixed(1) + ' m' : '—';
    $('vClimb').textContent = s.climb != null ? (s.climb >= 0 ? '+' : '') + s.climb.toFixed(1) + ' m/s' : '—';
    $('vSpd').textContent = s.spd != null ? s.spd.toFixed(1) + ' m/s' : '—';
    $('vHdg').textContent = s.hdg != null ? Math.round(s.hdg) + '°' : '—';
    $('vDist').textContent = s.lat ? dist.toFixed(0) + ' m' : '—';
    $('vGps').textContent = s.sats != null ? `${s.sats} sats${s.fix ? ' · ' + s.fix : ''}` : '—';
    $('vBat').textContent = s.volt != null ? `${s.volt.toFixed(1)} V${s.pct >= 0 ? ' · ' + s.pct + '%' : ''}` : '—';
    $('vCur').textContent = s.curr != null && s.curr >= 0 ? s.curr.toFixed(1) + ' A' : '—';
    $('vPts').textContent = points.length;
    const warn = [s.pct >= 0 && s.pct < 25 && `Battery ${s.pct}% — land soon`, s.sats != null && s.sats < 6 && 'Weak GPS (fewer than 6 satellites)', dist > 450 && 'More than 450 m from home — keep visual line of sight'].filter(Boolean);
    $('warn').hidden = !warn.length; $('warn').textContent = warn.join(' · ');
    $('save').disabled = points.length < 5;
    draw(x, y, s.hdg || 0);
  }
  function draw(x, y, hdg) {
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
    ctx.fillStyle = '#0b1324'; ctx.fillRect(0, 0, w, h);
    const track = points.map(p => metres(p[1], p[2]));
    const span = Math.max(40, ...track.map(([a, b]) => Math.max(Math.abs(a), Math.abs(b))), Math.abs(x), Math.abs(y)) * 1.2, k = Math.min(w, h) / 2 / span;
    const P = ([a, b]) => [w / 2 + a * k, h / 2 - b * k];
    ctx.strokeStyle = 'rgba(148,163,184,.25)'; ctx.lineWidth = 1;
    for (const r of [0.25, 0.5, 0.75, 1]) { ctx.beginPath(); ctx.arc(w / 2, h / 2, r * span * k, 0, 7); ctx.stroke(); }
    ctx.fillStyle = 'rgba(148,163,184,.8)'; ctx.font = `${12 * devicePixelRatio}px system-ui`; ctx.fillText(`${Math.round(span)} m`, w / 2 + span * k - 40 * devicePixelRatio, h / 2 - 4);
    if (track.length > 1) { ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2 * devicePixelRatio; ctx.beginPath(); track.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p))); ctx.stroke(); }
    ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(w / 2, h / 2, 5 * devicePixelRatio, 0, 7); ctx.fill(); // home
    if (!last.lat) return;
    const [cx, cy] = P([x, y]), a = (hdg - 90) * Math.PI / 180, r = 10 * devicePixelRatio;
    ctx.fillStyle = '#f59e0b'; ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 1.4, cy + Math.sin(a) * r * 1.4); ctx.lineTo(cx + Math.cos(a + 2.5) * r, cy + Math.sin(a + 2.5) * r); ctx.lineTo(cx + Math.cos(a - 2.5) * r, cy + Math.sin(a - 2.5) * r);
    ctx.fill();
  }

  // ---- mavlink2rest (GET only) ----
  async function poll(base, sys) {
    try {
      const r = await fetch(`${base}/v1/mavlink/vehicles/${sys}/components/1/messages`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const m = await r.json(), g = k => m[k]?.message || {};
      const pos = g('GLOBAL_POSITION_INT'), hud = g('VFR_HUD'), sys_ = g('SYS_STATUS'), gps = g('GPS_RAW_INT'), hb = g('HEARTBEAT');
      if (!m.HEARTBEAT) return setStatus('Connected to mavlink2rest, waiting for vehicle ' + sys + '…');
      const custom = val(hb.custom_mode), armed = !!(val(hb.base_mode) & 128);
      mode = COPTER[custom] ?? (custom != null ? 'Mode ' + custom : null);
      sample({
        lat: pos.lat / 1e7 || 0, lon: pos.lon / 1e7 || 0, alt: (pos.relative_alt ?? 0) / 1000, spd: hud.groundspeed, hdg: hud.heading ?? (pos.hdg ?? 0) / 100, climb: hud.climb,
        volt: sys_.voltage_battery != null ? sys_.voltage_battery / 1000 : null, curr: sys_.current_battery != null ? sys_.current_battery / 100 : null, pct: sys_.battery_remaining,
        sats: gps.satellites_visible, fix: String(val(gps.fix_type) || '').replace('GPS_FIX_TYPE_', '').replace('_', ' '), armed, mode,
      });
      setStatus(`Live · vehicle ${sys} · ${armed ? 'recording' : 'waiting for arming to record'}`);
    } catch (e) { setStatus(`Can't reach ${base} (${e.message}). Is mavlink2rest running on this computer?`, true); }
  }

  // ---- demo: a take-off, a lap of a 60 m circle and a landing, with battery drain ----
  function demoFlight() {
    const lat0 = 13.0827, lon0 = 80.2707; let t = 0;
    return () => {
      t += 0.5;
      const phase = t < 10 ? 'climb' : t < 100 ? 'circle' : t < 110 ? 'land' : 'done', ang = Math.max(0, t - 10) / 90 * 2 * Math.PI;
      const rr = phase === 'circle' ? 60 : phase === 'land' || phase === 'done' ? 60 : (t / 10) * 60;
      const alt = phase === 'climb' ? t * 2 : phase === 'circle' ? 20 : phase === 'land' ? Math.max(0, 20 - (t - 100) * 2) : 0;
      const e = Math.sin(ang) * rr, n = Math.cos(ang) * rr - rr;
      sample({ t, lat: lat0 + n / 110540, lon: lon0 + e / (111320 * Math.cos(lat0 * Math.PI / 180)), alt, spd: phase === 'circle' ? 4.2 : 1.5, hdg: (ang * 180 / Math.PI + 90) % 360,
        climb: phase === 'climb' ? 2 : phase === 'land' ? -2 : 0, volt: 25.1 - t * 0.012, curr: phase === 'done' ? 0 : 18, pct: Math.max(0, Math.round(100 - t * 0.55)), sats: 14, fix: '3D FIX',
        armed: phase !== 'done', mode: phase === 'land' ? 'Land' : 'Loiter' });
      if (phase === 'done') { stop(); setStatus('Demo landed — save it to try the logbook and 3D replay.'); }
    };
  }

  function reset() { points = []; t0 = 0; home = null; last = {}; }
  function stop() { clearInterval(timer); timer = null; buttons(false); }
  $('connect').onclick = () => {
    const base = $('url').value.replace(/\/+$/, ''), sys = +$('sys').value || 1;
    if (!/^https?:\/\//.test(base)) return setStatus('Enter an http:// address.', true);
    reset(); buttons(true); setStatus('Connecting…'); poll(base, sys); timer = setInterval(() => poll(base, sys), 500);
  };
  $('demo').onclick = () => { reset(); buttons(true); setStatus('Demo flight (simulated data)'); const step = demoFlight(); timer = setInterval(step, 100); };
  $('stop').onclick = () => { stop(); setStatus(`Stopped · ${points.length} points recorded.`); };
  $('save').onclick = async () => {
    const csv = 'time_s,lat,lon,rel_alt,voltage,sats\n' + points.map(p => p.join(',')).join('\n');
    const fd = new FormData(); fd.append('notes', 'Live monitor recording'); fd.append('file', new Blob([csv], { type: 'text/csv' }), `live-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`);
    $('save').disabled = true; setStatus('Saving…');
    const r = await fetch('/flights', { method: 'POST', body: fd });
    location = r.url; // the upload redirects to the new flight's replay (or back to My flights with a message)
  };
  addEventListener('resize', render);
  render();
})();

// Canvas 3D flight replay — no libraries, works offline. Drag to orbit, wheel to zoom, camera presets, colour-by, mission and
// geofence layers, playback + telemetry, synced graphs, WebM export. Point layout is documented in src/flightlog.js.
(function () {
  const D = JSON.parse(document.getElementById('flightData').textContent);
  const { points, batUnit } = D, series = D.series || {}, events = D.events || { modes: [], errors: [] };
  const cv = document.getElementById('view'), ctx = cv.getContext('2d');
  const pf = document.getElementById('profile'), pctx = pf.getContext('2d');
  const $ = id => document.getElementById(id), dprOf = () => window.devicePixelRatio || 1;

  // Local metres around the take-off point (x east, y north, z up).
  const lat0 = points[0][1], lon0 = points[0][2], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const toXY = (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  const P = points.map(p => {
    const [x, y] = toXY(p[1], p[2]), n = i => (p[i] ?? null);
    return { t: p[0], x, y, z: p[3] || 0, spd: p[4] || 0, hdg: p[5] || 0, bat: n(6), sats: n(7), msl: n(8), mode: n(9), climb: n(10) ?? 0,
      thr: n(11), yaw: n(12), pit: n(13), rol: n(14), volt: n(15), curr: n(16), vibe: n(17), pitch: n(18), roll: n(19),
      power: p[15] != null && p[16] != null ? p[15] * p[16] : null };
  });
  const ext = k => { const v = P.map(p => p[k]).filter(Number.isFinite); return v.length ? [Math.min(...v), Math.max(...v)] : [0, 1]; };
  const [x0, x1] = ext('x'), [y0, y1] = ext('y'), [z0, z1] = ext('z');
  const ground = Math.min(0, z0), size = Math.max(x1 - x0, y1 - y0, z1 - z0, 20), T_END = P.at(-1).t;
  const center = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 };
  const cam = { yaw: -0.6, pitch: 0.6, dist: size * 1.7, mode: 'oblique' };
  const mission = (D.mission || []).map(m => { const [x, y] = toXY(m[2], m[3]); return { seq: m[0], id: m[1], x, y, z: m[1] === 21 ? 0 : m[4] || 0 }; });
  let target = { ...center }, tNow = 0, playing = false, speed = +$('speed').value || 1, last = 0, colorBy = 'alt', recorder = null;

  // ---- colours ----
  const modeNames = [...new Set(P.map(p => p.mode).filter(Boolean))];
  const MODE_COL = ['#38bdf8', '#f59e0b', '#22c55e', '#a78bfa', '#f43f5e', '#14b8a6', '#eab308', '#fb7185', '#60a5fa', '#84cc16'];
  const modeColor = m => MODE_COL[Math.max(0, modeNames.indexOf(m)) % MODE_COL.length];
  const ranges = { alt: [z0, z1], spd: ext('spd'), power: ext('power') };
  const hue = (v, [a, b]) => 220 - 220 * Math.min(1, Math.max(0, (v - a) / ((b - a) || 1)));
  const diverge = (v, lim) => { const k = Math.max(-1, Math.min(1, (v || 0) / lim)); return k >= 0 ? `hsla(0,80%,${75 - 30 * k}%,A)` : `hsla(215,85%,${75 + 30 * k}%,A)`; };
  function colour(p, a) {
    switch (colorBy) {
      case 'spd': return `hsla(${hue(p.spd, ranges.spd)},85%,50%,${a})`;
      case 'power': return p.power == null ? `rgba(148,163,184,${a})` : `hsla(${hue(p.power, ranges.power)},85%,50%,${a})`;
      case 'climb': return diverge(p.climb, 5).replace('A', a);
      case 'pitch': return diverge(p.pitch, 30).replace('A', a);
      case 'mode': return p.mode ? modeColor(p.mode) + (a < 1 ? '55' : '') : `rgba(148,163,184,${a})`;
      default: return `hsla(${hue(p.z, ranges.alt)},85%,50%,${a})`;
    }
  }
  function legend() {
    const L = { alt: `Altitude ${z0.toFixed(0)}–${z1.toFixed(0)} m (blue → red)`, spd: `Speed ${ranges.spd[0].toFixed(1)}–${ranges.spd[1].toFixed(1)} m/s (blue → red)`,
      climb: 'Climb: blue descending · red climbing (±5 m/s)', pitch: 'Pitch: blue nose-up · red nose-down (±30°)',
      power: ranges.power[1] > 1 ? `Power ${ranges.power[0].toFixed(0)}–${ranges.power[1].toFixed(0)} W` : 'No battery current in this log' }[colorBy];
    $('legend').innerHTML = colorBy === 'mode'
      ? (modeNames.length ? modeNames.map(m => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${modeColor(m)};margin:0 4px 0 10px"></span>${m}`).join('') : 'No flight-mode data in this log')
      : L;
  }

  function resize() {
    const dpr = dprOf();
    for (const c of [cv, pf]) { c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr; }
    draw();
  }
  function proj(x, y, z) {
    const dx = x - target.x, dy = y - target.y, dz = z - target.z;
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const rx = dx * c - dy * s, fy = dx * s + dy * c;
    const depth = fy * cp - dz * sp + cam.dist;
    if (depth < 0.5) return null;
    const f = cv.height * 1.1;
    return [cv.width / 2 + f * rx / depth, cv.height / 2 - f * (fy * sp + dz * cp) / depth];
  }
  function line(a, b, style, w, dash) {
    if (!a || !b) return;
    ctx.strokeStyle = style; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
  }
  function at(t) { // interpolated state at time t
    let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; P[m].t <= t ? lo = m : hi = m; }
    const a = P[lo], b = P[hi], k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0, mix = key => a[key] + (b[key] - a[key]) * k;
    return { ...a, i: lo, x: mix('x'), y: mix('y'), z: mix('z'), spd: mix('spd') };
  }
  const angleTo = (from, to, k) => from + (((to - from + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * k;

  function draw() {
    const cur = at(tNow), dpr = dprOf(), h = cur.hdg * Math.PI / 180;
    if (cam.mode === 'chase') { target = { x: cur.x, y: cur.y, z: cur.z }; cam.yaw = h; }
    if (cam.mode === 'follow') { target = { x: cur.x, y: cur.y, z: cur.z }; cam.yaw = angleTo(cam.yaw, h, playing ? 0.08 : 1); }
    if (cam.mode === 'fpv') { const d = 30; target = { x: cur.x + Math.sin(h) * d, y: cur.y + Math.cos(h) * d, z: cur.z }; cam.yaw = h; cam.dist = d; cam.pitch = 0.04; }
    ctx.fillStyle = '#062a30'; ctx.fillRect(0, 0, cv.width, cv.height);
    // ground grid
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(s => size / s <= 12) || 1000, pad = size * 0.4;
    const gx0 = Math.floor((x0 - pad) / step) * step, gx1 = Math.ceil((x1 + pad) / step) * step;
    const gy0 = Math.floor((y0 - pad) / step) * step, gy1 = Math.ceil((y1 + pad) / step) * step;
    for (let x = gx0; x <= gx1; x += step) line(proj(x, gy0, ground), proj(x, gy1, ground), '#1e2d4a', dpr);
    for (let y = gy0; y <= gy1; y += step) line(proj(gx0, y, ground), proj(gx1, y, ground), '#1e2d4a', dpr);
    // geofence: horizontal circle on the ground and at the ceiling
    if ($('showFence').checked && D.fence && D.fence.radius) {
      const ring = z => { let prev = null; for (let a = 0; a <= 64; a++) { const q = proj(Math.sin(a / 32 * Math.PI) * D.fence.radius, Math.cos(a / 32 * Math.PI) * D.fence.radius, z); line(prev, q, 'rgba(239,68,68,.7)', 1.5 * dpr, [6 * dpr, 5 * dpr]); prev = q; } };
      ring(ground); if (D.fence.alt) ring(D.fence.alt);
    }
    // ground shadow, drop lines, path (played part bright)
    ctx.lineCap = 'round';
    for (let i = 1; i < P.length; i++) line(proj(P[i - 1].x, P[i - 1].y, ground), proj(P[i].x, P[i].y, ground), 'rgba(148,163,184,.25)', dpr);
    const every = Math.max(1, Math.ceil(P.length / 20));
    for (let i = 0; i < P.length; i += every) line(proj(P[i].x, P[i].y, ground), proj(P[i].x, P[i].y, P[i].z), 'rgba(148,163,184,.18)', dpr);
    for (let i = 1; i < P.length; i++) line(proj(P[i - 1].x, P[i - 1].y, P[i - 1].z), proj(P[i].x, P[i].y, P[i].z), colour(P[i], i <= cur.i ? 1 : 0.3), (i <= cur.i ? 2.5 : 1.5) * dpr);
    const label = (p, txt, col, r = 7) => { if (!p) return; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p[0], p[1], r * dpr, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = `bold ${9 * dpr}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(txt, p[0], p[1] + 3 * dpr); };
    // planned mission (waypoints)
    if ($('showWp').checked && mission.length) {
      let prev = proj(0, 0, mission[0].z);
      for (const w of mission) { const q = proj(w.x, w.y, w.z); line(prev, q, 'rgba(232,121,249,.8)', 1.5 * dpr, [4 * dpr, 4 * dpr]); prev = q; }
      for (const w of mission) label(proj(w.x, w.y, w.z), String(w.seq), '#c026d3', 8);
    }
    label(proj(P[0].x, P[0].y, ground), 'H', '#059669');
    label(proj(P.at(-1).x, P.at(-1).y, ground), 'L', '#dc2626');
    // aircraft + heading (not drawn from inside the cockpit)
    if (cam.mode !== 'fpv') {
      const me = proj(cur.x, cur.y, cur.z), len = size * 0.06;
      line(proj(cur.x, cur.y, ground), me, 'rgba(255,255,255,.5)', dpr);
      line(me, proj(cur.x + Math.sin(h) * len, cur.y + Math.cos(h) * len, cur.z), '#fbbf24', 3 * dpr);
      if (me) { ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(me[0], me[1], 6 * dpr, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
    } else horizon(cur, dpr);
    // north arrow
    const nx = cv.width - 34 * dpr, ny = 34 * dpr, na = -cam.yaw;
    ctx.save(); ctx.translate(nx, ny); ctx.rotate(na); ctx.fillStyle = '#e2e8f0'; ctx.beginPath(); ctx.moveTo(0, -16 * dpr); ctx.lineTo(7 * dpr, 8 * dpr); ctx.lineTo(0, 3 * dpr); ctx.lineTo(-7 * dpr, 8 * dpr); ctx.fill();
    ctx.rotate(-na); ctx.font = `bold ${11 * dpr}px system-ui`; ctx.textAlign = 'center'; ctx.fillText('N', 0, 24 * dpr); ctx.restore();
    ctx.fillStyle = '#64748b'; ctx.font = `${11 * dpr}px system-ui`; ctx.textAlign = 'left'; ctx.fillText(`grid ${step} m`, 10 * dpr, cv.height - 10 * dpr);
    if (recorder) { ctx.fillStyle = '#e2e8f0'; ctx.font = `bold ${13 * dpr}px system-ui`; ctx.fillText(`${mmss(tNow)}  ${cur.z.toFixed(0)} m  ${cur.spd.toFixed(1)} m/s${cur.mode ? '  ' + cur.mode : ''}`, 10 * dpr, 22 * dpr); }
    drawProfile(); telemetry(cur); drawGraph();
  }
  function horizon(c, dpr) { // FPV: artificial horizon line from roll/pitch
    const r = (c.roll || 0) * Math.PI / 180, off = (c.pitch || 0) * cv.height / 90, w = cv.width;
    ctx.save(); ctx.translate(w / 2, cv.height / 2 + off); ctx.rotate(-r);
    ctx.strokeStyle = 'rgba(250,204,21,.8)'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(-w * 0.3, 0); ctx.lineTo(-40 * dpr, 0); ctx.moveTo(40 * dpr, 0); ctx.lineTo(w * 0.3, 0); ctx.stroke(); ctx.restore();
    ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(w / 2, cv.height / 2, 8 * dpr, 0, 7); ctx.stroke();
  }
  function drawProfile() {
    const w = pf.width, hgt = pf.height, dpr = dprOf(), band = 10 * dpr, span = (z1 - ground) || 1, X = t => t / (T_END || 1) * w;
    pctx.clearRect(0, 0, w, hgt);
    pctx.fillStyle = 'rgba(13,148,136,.12)'; pctx.strokeStyle = '#0d9488'; pctx.lineWidth = 1.5 * dpr; pctx.beginPath();
    P.forEach((p, i) => { const Y = hgt - band - 4 * dpr - (p.z - ground) / span * (hgt - band - 10 * dpr); i ? pctx.lineTo(X(p.t), Y) : pctx.moveTo(X(p.t), Y); });
    pctx.stroke(); pctx.lineTo(w, hgt - band); pctx.lineTo(0, hgt - band); pctx.fill();
    (events.modes || []).forEach((m, k, a) => { pctx.fillStyle = modeColor(m[1]); pctx.fillRect(X(m[0]), hgt - band, X(a[k + 1]?.[0] ?? T_END) - X(m[0]), band); });
    (events.errors || []).filter(e => e[2] !== 0).forEach(e => { pctx.fillStyle = '#ef4444'; pctx.fillRect(X(e[0]) - dpr, 0, 2 * dpr, hgt - band); });
    const cx = X(tNow); pctx.strokeStyle = '#f59e0b'; pctx.beginPath(); pctx.moveTo(cx, 0); pctx.lineTo(cx, hgt); pctx.stroke();
  }
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const txt = (id, v) => { $(id).textContent = v; };
  function telemetry(c) {
    txt('tTime', `${mmss(tNow)} / ${mmss(T_END)}`);
    txt('tMode', c.mode || '—');
    txt('tAlt', `${c.z.toFixed(1)} m`);
    txt('tMsl', c.msl != null ? `${c.msl.toFixed(1)} m` : '—');
    txt('tClimb', `${c.climb >= 0 ? '+' : ''}${(+c.climb || 0).toFixed(1)} m/s`);
    txt('tSpd', `${c.spd.toFixed(1)} m/s · ${(c.spd * 3.6).toFixed(0)} km/h`);
    txt('tHdg', `${Math.round(c.hdg)}°`);
    txt('tBat', c.bat != null ? `${c.bat} ${batUnit}` : '—');
    txt('tCurr', c.curr != null ? `${c.curr.toFixed(1)} A${c.power != null ? ' · ' + c.power.toFixed(0) + ' W' : ''}` : '—');
    txt('tAtt', c.roll != null ? `${c.roll.toFixed(0)}° · ${c.pitch.toFixed(0)}°` : '—');
    txt('tVibe', c.vibe != null ? `${c.vibe.toFixed(1)} m/s²` : '—');
    txt('tSat', c.sats != null ? c.sats : '—');
    txt('tDist', `${Math.round(Math.hypot(c.x, c.y))} m`);
    $('scrub').value = Math.round(tNow / (T_END || 1) * 1000);
    sticks(c);
  }
  function sticks(c) { // Mode 2: left = throttle (up) / yaw, right = pitch / roll
    const sc = $('sticks'), g = sc.getContext('2d'), W = sc.width, H = sc.height, r = H / 2 - 8;
    g.clearRect(0, 0, W, H);
    [[W * 0.27, c.yaw, c.thr != null ? 1 - 2 * c.thr : null], [W * 0.73, c.rol, c.pit]].forEach(([cx, sx, sy]) => {
      g.strokeStyle = '#cbd5e1'; g.lineWidth = 1.5; g.strokeRect(cx - r, H / 2 - r, 2 * r, 2 * r);
      g.beginPath(); g.moveTo(cx - r, H / 2); g.lineTo(cx + r, H / 2); g.moveTo(cx, H / 2 - r); g.lineTo(cx, H / 2 + r); g.strokeStyle = '#e2e8f0'; g.stroke();
      if (sx == null && sy == null) return;
      g.fillStyle = '#0d9488'; g.beginPath(); g.arc(cx + (sx || 0) * r, H / 2 + (sy || 0) * r, 7, 0, 7); g.fill();
    });
    if (c.thr == null && c.rol == null) { g.fillStyle = '#94a3b8'; g.font = '11px system-ui'; g.textAlign = 'center'; g.fillText('no RC data in this log', W / 2, H - 2); }
  }

  // ---- graphs ----
  const gc = $('graph'), gctx = gc.getContext('2d');
  const fromPts = (...keys) => P.map(p => [p.t, ...keys.map(key => p[key])]);
  const PRESETS = [
    ['Altitude', () => ({ unit: 'm', names: ['Above take-off', 'MSL'], rows: fromPts('z', 'msl') })],
    ['Climb rate', () => ({ unit: 'm/s', names: ['Climb'], rows: fromPts('climb') })],
    ['Speed', () => ({ unit: 'm/s', names: ['Ground speed'], rows: fromPts('spd') })],
    ['Battery voltage', () => ({ unit: 'V', names: ['Voltage'], rows: series.bat?.length ? series.bat.map(r => [r[0], r[1]]) : fromPts('volt') })],
    ['Current', () => ({ unit: 'A', names: ['Current'], rows: (series.bat || []).map(r => [r[0], r[2]]) })],
    ['Roll', () => ({ unit: '°', names: ['Desired', 'Actual'], rows: (series.att || []).map(r => [r[0], r[1], r[2]]) })],
    ['Pitch', () => ({ unit: '°', names: ['Desired', 'Actual'], rows: (series.att || []).map(r => [r[0], r[3], r[4]]) })],
    ['Yaw', () => ({ unit: '°', names: ['Desired', 'Actual'], rows: (series.att || []).map(r => [r[0], r[5], r[6]]) })],
    ['Roll rate', () => ({ unit: '°/s', names: ['Desired', 'Actual'], rows: (series.rate || []).map(r => [r[0], r[1], r[2]]) })],
    ['Pitch rate', () => ({ unit: '°/s', names: ['Desired', 'Actual'], rows: (series.rate || []).map(r => [r[0], r[3], r[4]]) })],
    ['Yaw rate', () => ({ unit: '°/s', names: ['Desired', 'Actual'], rows: (series.rate || []).map(r => [r[0], r[5], r[6]]) })],
    ['Vibration', () => ({ unit: 'm/s²', names: ['X', 'Y', 'Z'], rows: series.vibe || [] })],
    ['RC input', () => ({ unit: 'PWM', names: ['Ch1 roll', 'Ch2 pitch', 'Ch3 throttle', 'Ch4 yaw'], rows: series.rc || [] })],
  ].map(([name, fn]) => ({ name, data: fn() })).filter(p => p.data.rows.some(r => r.slice(1).some(Number.isFinite)));
  const LINE_COL = ['#0d9488', '#f59e0b', '#16a34a', '#db2777'];
  let preset = PRESETS[0];
  $('presets').innerHTML = PRESETS.map((p, i) => `<button class="btn sm ${i ? '' : 'pri'}" data-preset="${i}">${p.name}</button>`).join('');
  $('presets').onclick = e => { const b = e.target.closest('[data-preset]'); if (!b) return; preset = PRESETS[+b.dataset.preset]; document.querySelectorAll('[data-preset]').forEach(x => x.classList.toggle('pri', x === b)); drawGraph(); };
  function drawGraph() {
    if (!preset || gc.offsetParent === null) return; // hidden tab
    const dpr = dprOf(); gc.width = gc.clientWidth * dpr; gc.height = gc.clientHeight * dpr;
    const W = gc.width, H = gc.height, L = 48 * dpr, B = 22 * dpr, { rows, names, unit } = preset.data;
    const vals = rows.flatMap(r => r.slice(1)).filter(Number.isFinite);
    let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const X = t => L + t / (T_END || 1) * (W - L - 8 * dpr), Y = v => H - B - (v - lo) / (hi - lo) * (H - B - 10 * dpr);
    gctx.clearRect(0, 0, W, H); gctx.font = `${10 * dpr}px system-ui`; gctx.fillStyle = '#64748b'; gctx.strokeStyle = '#e2e8f0'; gctx.lineWidth = dpr;
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4, y = Y(v); gctx.beginPath(); gctx.moveTo(L, y); gctx.lineTo(W, y); gctx.stroke(); gctx.textAlign = 'right'; gctx.fillText(v.toFixed(Math.abs(hi - lo) < 10 ? 1 : 0), L - 4 * dpr, y + 3 * dpr); }
    for (let k = 0; k <= 6; k++) { const t = T_END * k / 6; gctx.textAlign = 'center'; gctx.fillText(mmss(t), X(t), H - 6 * dpr); }
    names.forEach((n, c) => {
      gctx.strokeStyle = LINE_COL[c % 4]; gctx.lineWidth = 1.5 * dpr; gctx.beginPath(); let pen = false;
      for (const r of rows) { const v = r[c + 1]; if (!Number.isFinite(v)) { pen = false; continue; } pen ? gctx.lineTo(X(r[0]), Y(v)) : gctx.moveTo(X(r[0]), Y(v)); pen = true; }
      gctx.stroke();
    });
    gctx.strokeStyle = '#f59e0b'; gctx.beginPath(); gctx.moveTo(X(tNow), 0); gctx.lineTo(X(tNow), H - B); gctx.stroke();
    $('graphLegend').innerHTML = `<b>${preset.name}</b> (${unit}) ` + names.map((n, c) => `<span style="color:${LINE_COL[c % 4]};margin-left:12px">■ ${n}</span>`).join('');
  }
  gc.onclick = e => { const r = gc.getBoundingClientRect(), L = 48; tNow = Math.min(T_END, Math.max(0, (e.clientX - r.left - L) / (r.width - L - 8) * T_END)); draw(); };
  if (!PRESETS.length) $('presets').innerHTML = '<span class="muted small">No graphable data in this log.</span>';

  function frame(ts) {
    const dt = last ? (ts - last) / 1000 : 0; last = ts;
    if (playing) {
      tNow += dt * speed;
      if (tNow >= T_END) { tNow = T_END; playing = false; $('play').textContent = '▶ Play'; if (recorder) setTimeout(() => recorder && recorder.stop(), 300); }
    }
    if (cam.mode === 'orbit') cam.yaw += dt * 0.35;
    if (playing || cam.mode === 'orbit') draw();
    requestAnimationFrame(frame);
  }

  // ---- controls ----
  $('play').onclick = () => { if (tNow >= T_END) tNow = 0; playing = !playing; $('play').textContent = playing ? '❚❚ Pause' : '▶ Play'; };
  $('speed').onchange = e => { speed = +e.target.value; };
  $('scrub').oninput = e => { tNow = e.target.value / 1000 * T_END; draw(); };
  $('colorBy').onchange = e => { colorBy = e.target.value; legend(); draw(); };
  $('showWp').onchange = $('showFence').onchange = () => draw();
  if (!mission.length) $('showWp').parentElement.hidden = true;
  if (!(D.fence && D.fence.radius)) $('showFence').parentElement.hidden = true;
  pf.onclick = e => { const r = pf.getBoundingClientRect(); tNow = (e.clientX - r.left) / r.width * T_END; draw(); };
  document.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => {
    cam.mode = b.dataset.cam; target = { ...center };
    Object.assign(cam, { oblique: { pitch: 0.6, dist: size * 1.7 }, top: { pitch: 1.53, dist: size * 1.9 }, side: { pitch: 0.06, dist: size * 1.7 },
      chase: { pitch: 0.35, dist: Math.max(15, size * 0.35) }, follow: { pitch: 0.45, dist: Math.max(20, size * 0.5) }, fpv: {}, orbit: { pitch: 0.55, dist: size * 1.6 } }[cam.mode]);
    document.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('pri', x === b));
    draw();
  });
  // WebM export: replay from the start at the chosen speed while recording the canvas.
  $('record').onclick = () => {
    if (!cv.captureStream || !window.MediaRecorder) { alert('Video export is not supported in this browser — try Chrome, Edge or Firefox.'); return; }
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(cv.captureStream(30), type ? { mimeType: type } : undefined), chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      a.download = `flight-replay-${location.pathname.split('/').pop()}.webm`; document.body.append(a); a.click(); a.remove();
      recorder = null; $('record').disabled = false; $('record').textContent = '⏺ Record video';
    };
    recorder = rec; rec.start(); tNow = 0; playing = true; $('play').textContent = '❚❚ Pause'; $('record').disabled = true; $('record').textContent = '⏺ Recording…';
  };
  let drag = null;
  cv.onpointerdown = e => { drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); };
  cv.onpointermove = e => {
    if (!drag || cam.mode === 'fpv') return;
    cam.yaw -= (e.clientX - drag[0]) * 0.008; cam.pitch = Math.min(1.55, Math.max(0.03, cam.pitch + (e.clientY - drag[1]) * 0.006));
    drag = [e.clientX, e.clientY]; draw();
  };
  cv.onpointerup = () => { drag = null; };
  cv.onwheel = e => { e.preventDefault(); if (cam.mode !== 'fpv') cam.dist = Math.min(size * 20, Math.max(3, cam.dist * Math.exp(e.deltaY * 0.001))); draw(); };

  // ---- tabs (no reload) + parameter search ----
  document.querySelectorAll('[data-tab]').forEach(a => a.onclick = e => {
    e.preventDefault();
    document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === a));
    document.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== a.dataset.tab; });
    history.replaceState(null, '', '?tab=' + a.dataset.tab);
    if (a.dataset.tab === 'replay') resize(); else drawGraph();
  });
  const ps = $('pSearch');
  if (ps) ps.oninput = () => { const q = ps.value.trim().toUpperCase(); document.querySelectorAll('#pTable tr').forEach((tr, i) => { if (i) tr.hidden = q && !tr.cells[0].textContent.includes(q); }); };

  window.addEventListener('resize', resize);
  legend(); resize();
  requestAnimationFrame(frame);
})();

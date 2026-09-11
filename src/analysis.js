// Flight health checks, performance summary and PID copilot suggestions for a parsed log (pure; checked in test/smoke.js).
// Thresholds are common rules of thumb for small multirotors, not regulatory limits.
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const fin = a => a.filter(Number.isFinite);
const FAILSAFE = /failsafe|Crash|Thrust loss|EKF|Internal/i;

function summary({ points, duration_s, distance_m, max_alt_m, max_speed, streams, events }) {
  const col = i => fin(points.map(p => p[i] ?? NaN));
  const [, lat0, lon0] = points[0], kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const home = Math.max(0, ...points.map(p => Math.hypot((p[2] - lon0) * kx, (p[1] - lat0) * 110540)));
  const bat = (streams?.bat || []).filter(b => b[1] > 0), amps = fin(bat.map(b => b[2]));
  let mah = null;
  if (amps.length) { mah = 0; for (let k = 1; k < bat.length; k++) { const dt = bat[k][0] - bat[k - 1][0]; if (dt > 0 && dt < 5 && Number.isFinite(bat[k][2])) mah += bat[k][2] * dt / 3.6; } }
  const modeTime = {}, ms = events?.modes || [];
  ms.forEach((m, k) => { modeTime[m[1]] = (modeTime[m[1]] || 0) + Math.max(0, (ms[k + 1]?.[0] ?? duration_s) - m[0]); });
  const volts = bat.map(b => b[1]), climb = col(10), vibe = fin((streams?.vibe || []).map(v => Math.max(v[1], v[2], v[3])));
  return {
    duration_s, distance_m, max_alt_m, max_speed, avg_speed: duration_s ? +(distance_m / duration_s).toFixed(1) : 0,
    max_climb: +Math.max(0, ...climb).toFixed(1), max_descent: +Math.max(0, ...climb.map(c => -c)).toFixed(1), max_home_m: Math.round(home),
    volt_start: volts[0] ?? null, volt_end: volts.at(-1) ?? null, volt_min: volts.length ? Math.min(...volts) : null,
    curr_max: amps.length ? +Math.max(...amps).toFixed(1) : null, mah: mah === null ? null : Math.round(mah),
    vibe_avg: vibe.length ? +mean(vibe).toFixed(1) : null, modeTime,
  };
}

function checks({ points, streams, events, bat_unit }, s) {
  const out = [], add = (area, status, value, advice = '') => out.push({ area, status, value, advice });
  const sats = fin(points.map(p => p[7]));
  if (sats.length) { const m = Math.min(...sats); add('GPS', m >= 10 ? 'ok' : m >= 6 ? 'warn' : 'bad', `lowest ${m} satellites`, m < 10 ? 'Wait for more satellites before take-off and keep the GPS mast clear of wiring and carbon.' : ''); }
  const vib = fin((streams?.vibe || []).map(v => Math.max(v[1], v[2], v[3])));
  if (vib.length) {
    const hi = pct(vib, 0.99);
    add('Vibration', hi < 15 ? 'ok' : hi < 30 ? 'warn' : 'bad', `average ${mean(vib).toFixed(1)}, peak ${hi.toFixed(1)} m/s²`,
      hi >= 15 ? 'Balance or replace propellers, check motor bearings and screws, and soft-mount the flight controller.' : '');
  }
  const volts = (streams?.bat || []).map(b => b[1]).filter(v => v > 0);
  if (volts.length && bat_unit !== '%') {
    const cells = Math.max(1, Math.ceil(Math.max(...volts) / 4.25)), low = Math.min(...volts) / cells;
    add('Battery', low >= 3.5 ? 'ok' : low >= 3.3 ? 'warn' : 'bad', `${Math.max(...volts).toFixed(1)} → ${Math.min(...volts).toFixed(1)} V (${cells}S, lowest ${low.toFixed(2)} V/cell)`,
      low < 3.5 ? 'Land earlier: going below about 3.5 V per cell under load shortens pack life and risks a brown-out.' : '');
  } else {
    const pcts = fin(points.map(p => p[6]));
    if (pcts.length && bat_unit === '%') { const m = Math.min(...pcts); add('Battery', m >= 25 ? 'ok' : m >= 15 ? 'warn' : 'bad', `lowest ${m}%`, m < 25 ? 'Plan to land with at least 25% remaining.' : ''); }
  }
  const errs = (events?.errors || []).filter(e => e[2] !== 0);
  if (events) {
    const bad = errs.some(e => FAILSAFE.test(e[1]));
    add('Errors & failsafes', !errs.length ? 'ok' : bad ? 'bad' : 'warn', errs.length ? [...new Set(errs.map(e => e[1]))].join(', ') : 'none logged',
      errs.length ? 'Review what happened at the marked times on the timeline and fix the cause before the next flight.' : '');
  }
  const att = streams?.att || [];
  if (att.length > 50) {
    const rms = c => Math.sqrt(mean(fin(att.map(a => a[c] - a[c + 1])).map(e => e * e)));
    const worst = Math.max(rms(1), rms(3));
    add('Attitude control', worst < 3 ? 'ok' : worst < 6 ? 'warn' : 'bad', `roll error ${rms(1).toFixed(1)}°, pitch error ${rms(3).toFixed(1)}° (RMS)`,
      worst >= 3 ? 'The aircraft is not following its target attitude closely — check for loose parts, then see the PID copilot.' : '');
  }
  if (s.max_alt_m > 120) add('Altitude', 'warn', `${s.max_alt_m} m above take-off`, 'Above 120 m (400 ft) — check that your permission covered this height.');
  if (s.max_home_m > 500) add('Distance', 'warn', `${s.max_home_m} m from home`, 'Beyond about 500 m it is hard to keep visual line of sight.');
  const lost = (streams?.rc || []).some(r => r.slice(1, 4).some(v => Number.isFinite(v) && v > 0 && v < 900));
  if (streams?.rc?.length) add('Radio link', lost ? 'bad' : 'ok', lost ? 'RC signal loss seen' : 'no signal loss seen', lost ? 'Check antenna placement and failsafe settings.' : '');
  const auto = (events?.modes || []).filter(m => /RTL|Land|Return|Smart/i.test(m[1]));
  if (auto.length) add('Return / land', 'info', auto.map(m => `${m[1]} at ${Math.floor(m[0] / 60)}:${String(Math.round(m[0] % 60)).padStart(2, '0')}`).join(', '), 'Confirm these were commanded and not triggered by a failsafe.');
  return out;
}

// ponytail: heuristic tuning hints (oscillation = error sign flips, lag = best cross-correlation delay); a proper
// step-response / frequency analysis would need higher-rate logging and is left to dedicated tools.
function pid(rate, params = {}, vehicle) {
  const rows = (rate || []).filter(r => r.slice(1).every(Number.isFinite));
  if (rows.length < 300) return null;
  const dt = (rows.at(-1)[0] - rows[0][0]) / (rows.length - 1);
  if (!(dt > 0)) return null;
  const px4 = vehicle === 'px4';
  return [['Roll', 1, 'RLL', 'ROLL'], ['Pitch', 3, 'PIT', 'PITCH'], ['Yaw', 5, 'YAW', 'YAW']].map(([axis, c, ap, px]) => {
    const des = rows.map(r => r[c]), act = rows.map(r => r[c + 1]), err = des.map((d, k) => d - act[k]);
    const rms = Math.sqrt(mean(err.map(e => e * e))), demand = Math.sqrt(mean(des.map(d => d * d)));
    let flips = 0;
    for (let k = 1; k < err.length; k++) if (err[k] * err[k - 1] < 0 && Math.abs(err[k] - err[k - 1]) > 4) flips++;
    const osc = flips / 2 / (rows.length * dt);
    const maxLag = Math.min(Math.round(0.25 / dt), 60);
    let best = 0, bestC = -Infinity;
    for (let L = 0; L <= maxLag; L++) { let s = 0; for (let k = 0; k + L < des.length; k++) s += des[k] * act[k + L]; if (s > bestC) { bestC = s; best = L; } }
    const lag = best * dt, name = t => (px4 ? `MC_${px}RATE_${t}` : `ATC_RAT_${ap}_${t}`);
    const cur = { P: params[name('P')], I: params[name('I')], D: params[name('D')] };
    let verdict = 'good', note = 'Follows the demand well — no change suggested.', k = { P: 1, I: 1, D: 1 };
    if (demand < 5) { verdict = 'unknown'; note = 'Not enough stick input on this axis to judge. Fly some brisk inputs and upload again.'; }
    // A few degrees of fast wobble is bad however big the stick input was; lag is judged relative to the demand.
    else if (osc > 3 && rms > 4) { verdict = 'oscillating'; note = 'Fast oscillation around the demand: lower P and D by about 15%.'; k = { P: 0.85, I: 1, D: 0.85 }; }
    else if (lag > 0.06 && rms / demand > 0.3) { verdict = 'sluggish'; note = 'The response lags the demand: raise P (and I with it) by about 10%.'; k = { P: 1.1, I: 1.1, D: 1 }; }
    return {
      axis, verdict, note, rms: +rms.toFixed(1), demand: +demand.toFixed(1), osc: +osc.toFixed(1), lag_ms: Math.round(lag * 1000),
      params: ['P', 'I', 'D'].map(t => ({ name: name(t), current: Number.isFinite(cur[t]) ? cur[t] : null,
        suggested: !Number.isFinite(cur[t]) ? null : k[t] === 1 ? cur[t] : +(cur[t] * k[t]).toFixed(4) })),
    };
  });
}

// Changed parameters only: Mission Planner "NAME,VALUE" for ArduPilot, QGroundControl tab format for PX4.
function paramFile(axes, vehicle) {
  const rows = (axes || []).flatMap(a => a.params).filter(p => p.suggested != null && p.current != null && p.suggested !== p.current);
  if (vehicle === 'px4') return '# Suggested changes — QGroundControl parameter file\n' + rows.map(p => `1\t1\t${p.name}\t${p.suggested}\t9`).join('\n') + '\n';
  return rows.map(p => `${p.name},${p.suggested}`).join('\n') + '\n';
}

function analyse(track) {
  const s = summary(track);
  return { summary: s, checks: checks(track, s), pid: pid(track.streams?.rate, track.params || {}, track.vehicle) };
}

module.exports = { analyse, pid, paramFile, summary };

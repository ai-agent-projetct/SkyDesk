// Training-field demo loop (three.js): a trainee drone arms on the helipad, takes off, flies a figure-8 through the course,
// returns tail-first and lands — with altitude / speed / mode cards, multilingual voice-coaching captions and a Mode-2
// transmitter. The 3D view and the overlay are composited into one 2D canvas (#out), so the loop can be recorded as a
// video: open /demo/field?record=1 (optionally &upload=<url> to POST the file and a poster frame somewhere).
import * as THREE from 'three';
import { buildDrone, spinProps } from 'drone3d';

const W = 1280, H = 720;
const out = document.getElementById('out'), g = out.getContext('2d');
out.width = W; out.height = H;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = t => t * t * (3 - 2 * t);
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };

// ---------- scene ----------
const scene = new THREE.Scene();
const skyTex = (() => { const c = document.createElement('canvas'); c.width = 2; c.height = 256; const x = c.getContext('2d'), gr = x.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#5f9fd6'); gr.addColorStop(0.5, '#9fc9e6'); gr.addColorStop(1, '#dcecf1'); x.fillStyle = gr; x.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
scene.background = skyTex;
scene.fog = new THREE.Fog(0xcfe2ea, 90, 330);
const camera = new THREE.PerspectiveCamera(46, W / H, 0.1, 900);
camera.position.set(0, 5.4, 27);
scene.add(new THREE.HemisphereLight(0xdcefff, 0x4a6b3a, 1.35));
const sun = new THREE.DirectionalLight(0xfff3dc, 2.7); sun.position.set(-26, 48, 22); sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 140 }); sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004;
scene.add(sun);

// grass with mowing stripes
const G = new THREE.PlaneGeometry(700, 700, 175, 175); G.rotateX(-Math.PI / 2);
const col = [], c3 = new THREE.Color();
for (let i = 0; i < G.attributes.position.count; i++) {
  const x = G.attributes.position.getX(i), z = G.attributes.position.getZ(i), stripe = Math.floor((x + 350) / 8) % 2 ? 0.03 : 0, n = hash(x, z) * 0.045;
  c3.setRGB(0.3 + stripe + n, 0.5 + stripe + n, 0.22 + n * 0.5); col.push(c3.r, c3.g, c3.b);
}
G.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
const ground = new THREE.Mesh(G, new THREE.MeshLambertMaterial({ vertexColors: true })); ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(72, 18, 0xffffff, 0xffffff); grid.material.transparent = true; grid.material.opacity = 0.17; grid.position.set(0, 0.03, 2); scene.add(grid);

const flat = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo.rotateX(-Math.PI / 2), mat); m.position.set(x, y, z); m.receiveShadow = true; return m; };
const white = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });

// runway (left, running away from the pilot)
const runway = new THREE.Group(); runway.position.set(-31, 0.02, -8); runway.rotation.y = -0.25; scene.add(runway);
runway.add(flat(new THREE.PlaneGeometry(15, 230), new THREE.MeshLambertMaterial({ color: 0x3c4249 }), 0, 0, 0));
for (let z = -110; z < 110; z += 11) runway.add(flat(new THREE.PlaneGeometry(0.45, 5.5), white, 0, 0.01, z));
for (const x of [-7, 7]) runway.add(flat(new THREE.PlaneGeometry(0.3, 230), white, x, 0.01, 0));

// tree line + scattered trees (instanced low-poly cones)
const trees = [];
for (let x = -170; x <= 170; x += 5 + hash(x, 1) * 5) trees.push([x, -72 - hash(x, 2) * 22, 0.8 + hash(x, 3) * 0.7]);
for (let z = -60; z <= 10; z += 7 + hash(z, 4) * 6) { trees.push([62 + hash(z, 5) * 25, z, 0.8 + hash(z, 6) * 0.5]); trees.push([-66 - hash(z, 7) * 20, z, 0.8 + hash(z, 8) * 0.5]); }
const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 6.5, 7), new THREE.MeshLambertMaterial({ color: 0xffffff }), trees.length);
const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.3, 1.6, 6), new THREE.MeshLambertMaterial({ color: 0x5b4632 }), trees.length);
const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
trees.forEach(([x, z, s], i) => {
  mtx.compose(new THREE.Vector3(x, 0.8 * s + 3.25 * s, z), q, sc.set(s, s, s)); crowns.setMatrixAt(i, mtx);
  crowns.setColorAt(i, c3.setRGB(0.12 + hash(i, 9) * 0.08, 0.3 + hash(i, 10) * 0.12, 0.14));
  mtx.compose(new THREE.Vector3(x, 0.8 * s, z), q, sc.set(s, s, s)); trunks.setMatrixAt(i, mtx);
});
crowns.castShadow = true; scene.add(crowns, trunks);

// mountain ridges (fog adds the haze) and soft clouds
function ridge(z, h, color, seed) {
  const pos = [], idx = [], N = 120;
  for (let i = 0; i <= N; i++) {
    const x = -700 + i * (1400 / N); let y = 0, a = 1, f = 0.018;
    for (let o = 0; o < 4; o++) { y += a * (Math.sin(x * f + seed * (o + 1)) * 0.5 + 0.5) * (0.6 + hash(i, seed + o) * 0.4); a *= 0.5; f *= 2.1; }
    pos.push(x, -2, z, x, h * (0.35 + y * 0.55), z);
    if (i) { const b = (i - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, fog: true, side: THREE.DoubleSide }));
}
scene.add(ridge(-420, 95, 0xb3c5d3, 3), ridge(-300, 62, 0x8fa7b9, 7));
const cloudTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
const clouds = [[-160, 88, -380, 130], [40, 104, -420, 170], [210, 82, -360, 120], [-40, 70, -330, 90]].map(([x, y, z, s]) => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.75, fog: false, depthWrite: false })); sp.position.set(x, y, z); sp.scale.set(s, s * 0.32, 1); scene.add(sp); return sp;
});

// helipad
const PAD_Z = 7; // helipad distance in front of the course centre (kept clear of the transmitter overlay)
const pad = new THREE.Group(); pad.position.set(0, 0.03, PAD_Z); scene.add(pad);
pad.add(flat(new THREE.CircleGeometry(3.3, 56), new THREE.MeshLambertMaterial({ color: 0x0f2744 }), 0, 0, 0));
pad.add(flat(new THREE.RingGeometry(3.05, 3.3, 56), white, 0, 0.01, 0));
for (const [w, d, x] of [[0.4, 2.7, -0.95], [0.4, 2.7, 0.95], [2.3, 0.4, 0]]) pad.add(flat(new THREE.PlaneGeometry(w, d), white, x, 0.02, 0));

// figure-8 course: two magenta loops, cyan target rings, ground guides, cones, dashed boundary
const ALT = 3.46, R = 7.5;
const glow = (color, emissive) => new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 0.55, roughness: 0.4 });
for (const cx of [-R, R]) {
  const loop = new THREE.Mesh(new THREE.TorusGeometry(R, 0.13, 10, 120), glow(0xdb2777, 0x9d174d)); loop.rotation.x = Math.PI / 2; loop.position.set(cx, ALT, 0); scene.add(loop);
  scene.add(flat(new THREE.RingGeometry(R - 0.12, R + 0.12, 96), new THREE.MeshBasicMaterial({ color: 0x2f5a2a, transparent: true, opacity: 0.55 }), cx, 0.035, 0));
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.05, 18), new THREE.MeshLambertMaterial({ color: 0xf59e0b })); cone.position.set(cx, 0.52, 0); cone.castShadow = true; scene.add(cone);
}
for (const x of [-2 * R, 0, 2 * R]) { const t = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.13, 10, 60), glow(0x5b9dff, 0x1d4ed8)); t.rotation.x = Math.PI / 2; t.position.set(x, ALT, 0); scene.add(t); }
const bpts = []; for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2; bpts.push(new THREE.Vector3(Math.cos(a) * 20, 0.05, 2 + Math.sin(a) * 15)); }
const boundary = new THREE.Line(new THREE.BufferGeometry().setFromPoints(bpts), new THREE.LineDashedMaterial({ color: 0xe2e8f0, dashSize: 1.1, gapSize: 0.9, transparent: true, opacity: 0.7 }));
boundary.computeLineDistances(); scene.add(boundary);

// drones: the trainee (black with blue wings) and the instructor's demo drone (white)
const S = 1.7, GROUND = 0.27 * S;
const trainee = buildDrone(0x15171c, 0x1e293b, 0x0d5ef1), coach = buildDrone(0xe5e7eb, 0x1d4ed8);
for (const d of [trainee, coach]) { d.pose.scale.setScalar(S); d.pose.traverse(o => { if (o.isMesh) o.castShadow = true; }); scene.add(d.pose); }

// ---------- choreography (seconds). The loop starts and ends on the pad facing away, so it repeats seamlessly. ----------
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const PAD = V(0, GROUND, PAD_Z), UP = V(0, ALT, PAD_Z), MID = V(0, ALT, 0);
const LAP = 7.5, SPD = 2 * Math.PI * R / LAP, APPROACH = 2 * PAD_Z / SPD, BRAKE = 2, STOP = V(0, ALT, -SPD * BRAKE / 2);
const PLAN = [
  ['arm', 1.5], ['climb', 2.5], ['approach', APPROACH], ['loopL', LAP], ['loopR', LAP], ['brake', BRAKE], ['back', 4], ['land', 2.6], ['idle', 1.8],
];
const LOOP = PLAN.reduce((s, p) => s + p[1], 0);
function where(t) { // position, mode and phase at time t (0 … LOOP)
  let acc = 0;
  for (const [k, d] of PLAN) {
    if (t < acc + d || k === 'idle') {
      const u = clamp((t - acc) / d, 0, 1);
      switch (k) {
        case 'arm': return { p: PAD.clone(), mode: 'Armed', phase: k, spin: smooth(u) };
        case 'climb': return { p: PAD.clone().lerp(UP, smooth(u)), mode: 'Loiter', phase: k, spin: 1 };
        case 'approach': return { p: UP.clone().lerp(MID, u * u), mode: 'Loiter', phase: k, spin: 1 };             // accelerates into the loop speed
        case 'loopL': { const a = -u * 2 * Math.PI; return { p: V(-R + R * Math.cos(a), ALT, R * Math.sin(a)), mode: 'Loiter', phase: k, spin: 1 }; }
        case 'loopR': { const a = Math.PI + u * 2 * Math.PI; return { p: V(R + R * Math.cos(a), ALT, R * Math.sin(a)), mode: 'Loiter', phase: k, spin: 1 }; }
        case 'brake': return { p: MID.clone().lerp(STOP, 1 - (1 - u) * (1 - u)), mode: 'Loiter', phase: k, spin: 1 };
        case 'back': return { p: STOP.clone().lerp(UP, smooth(u)), mode: 'Loiter', phase: k, spin: 1 };            // tail-first, nose still away
        case 'land': return { p: UP.clone().lerp(PAD, smooth(u)), mode: 'Land', phase: k, spin: 1 };
        default: return { p: PAD.clone(), mode: 'Disarmed', phase: 'idle', spin: 1 - smooth(u) };
      }
    }
    acc += d;
  }
}
// Coaching lines per phase: our own phrases from the practice simulator (public/sim.js), one Indian language each.
const COACH = {
  arm: ['Motors armed.', 'English'], climb: ['टेक ऑफ करें और तीन मीटर तक ऊपर जाएं।', 'Hindi'], approach: ['அடுத்த குறியை நோக்கி பறக்கவும்.', 'Tamil'],
  loopL: ['ಮುಂದಿನ ಗುರುತಿನ ಕಡೆಗೆ ಹಾರಿ.', 'Kannada'], loopR: ['తదుపరి గుర్తు వైపు ఎగరండి.', 'Telugu'], brake: ['घरी परत येत आहे.', 'Marathi'],
  back: ['घरी परत येत आहे.', 'Marathi'], land: ['এখন প্যাডে নামুন।', 'Bengali'], idle: ['നന്നായി. പരിശീലനം പൂർത്തിയായി.', 'Malayalam'],
};

// ---------- overlay (drawn on the 2D canvas every frame) ----------
function rr(x, y, w, h, r, fill) { g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = fill; g.fill(); }
const FONT = '"Segoe UI","Nirmala UI",system-ui,sans-serif';
function card(y, label, value, color) {
  rr(40, y, 176, 104, 18, 'rgba(8,22,64,.72)');
  g.fillStyle = '#b9d3ff'; g.font = `700 15px ${FONT}`; g.letterSpacing = '2px'; g.textAlign = 'center'; g.fillText(label, 128, y + 32);
  g.fillStyle = color; g.font = `800 40px ${FONT}`; g.letterSpacing = '0px'; g.fillText(value, 128, y + 80);
}
function gimbal(cx, cy, sx, sy) {
  g.strokeStyle = 'rgba(148,163,184,.55)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, 34, 0, 7); g.stroke();
  g.beginPath(); g.moveTo(cx - 34, cy); g.lineTo(cx + 34, cy); g.moveTo(cx, cy - 34); g.lineTo(cx, cy + 34); g.strokeStyle = 'rgba(148,163,184,.25)'; g.stroke();
  g.fillStyle = '#e2e8f0'; g.beginPath(); g.arc(cx + sx * 24, cy - sy * 24, 12, 0, 7); g.fill();
}
let lastLine = '', lineAt = 0;
function overlay(t, s) {
  card(40, 'ALTITUDE', s.alt.toFixed(1), '#fff'); card(160, 'SPEED', s.spd.toFixed(1), '#fff');
  card(280, 'MODE', s.mode, { Loiter: '#4ade80', Land: '#fbbf24', Armed: '#fbbf24', Disarmed: '#cbd5e1' }[s.mode]);
  // brand + battery / timer
  g.textAlign = 'right'; g.fillStyle = 'rgba(8,22,64,.6)'; rr(W - 330, 36, 290, 46, 23, 'rgba(8,22,64,.6)');
  g.fillStyle = '#5b9dff'; g.beginPath(); g.arc(W - 308, 59, 6, 0, 7); g.fill();
  g.fillStyle = '#fff'; g.font = `800 19px ${FONT}`; g.textAlign = 'left'; g.fillText('AERON', W - 292, 66);
  const bw = g.measureText('AERON').width;
  g.fillStyle = '#cbd5e1'; g.font = `600 15px ${FONT}`; g.fillText('· Practice simulator', W - 292 + bw + 8, 66);
  const sec = Math.floor(t);
  g.textAlign = 'right'; g.fillStyle = '#e2e8f0'; g.font = `600 15px ${FONT}`;
  g.fillText(`BATT ${Math.round(100 - 22 * t / LOOP)}%   ·   ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`, W - 42, 110);
  // voice-coaching bubble (fades in when the line changes)
  const [line, lang] = COACH[s.phase];
  if (line !== lastLine) { lastLine = line; lineAt = t; }
  const a = clamp((t - lineAt) / 0.35, 0, 1), bx = W - 540, by = H - 190;
  rr(bx, by, 500, 92, 22, 'rgba(8,22,64,.78)');
  g.fillStyle = '#16307a'; g.beginPath(); g.arc(bx + 50, by + 46, 28, 0, 7); g.fill(); g.strokeStyle = '#5b9dff'; g.lineWidth = 2; g.stroke();
  g.font = `30px ${FONT}`; g.textAlign = 'center'; g.fillText('🧑‍✈️', bx + 50, by + 57);
  g.textAlign = 'left'; g.globalAlpha = a; g.fillStyle = '#fff'; g.font = `700 22px ${FONT}`; g.fillText(line, bx + 94, by + 42, 390);
  g.globalAlpha = 1; g.fillStyle = '#8fb8ff'; g.font = `600 15px ${FONT}`; g.fillText(`Instructor · voice coaching · ${lang}`, bx + 94, by + 70);
  // Mode-2 transmitter: left = throttle / yaw, right = pitch / roll
  const cx = W / 2; rr(cx - 190, H - 132, 380, 150, 26, 'rgba(10,24,64,.9)');
  g.fillStyle = '#94a3b8'; g.font = `700 13px ${FONT}`; g.letterSpacing = '3px'; g.textAlign = 'center'; g.fillText('AERON RC · MODE 2', cx, H - 104); g.letterSpacing = '0px';
  gimbal(cx - 96, H - 52, s.yawStick, s.thrStick); gimbal(cx + 96, H - 52, s.rollStick, s.pitchStick);
  g.fillStyle = s.mode === 'Disarmed' ? '#64748b' : '#4ade80'; g.beginPath(); g.arc(cx, H - 70, 6, 0, 7); g.fill();
}

// ---------- frame ----------
const look = V(0, 2.4, 2), lookTarget = V(), prev = { p: PAD.clone(), v: V(), t: 0 };
function render(t, dt) {
  const s = where(t), p = s.p, vel = dt > 0 ? p.clone().sub(prev.p).divideScalar(dt) : V(), acc = dt > 0 ? vel.clone().sub(prev.v).divideScalar(dt) : V();
  // heading follows the path on the loops, otherwise the nose stays away from the pilot (yaw π)
  const moving = s.phase === 'loopL' || s.phase === 'loopR', yaw = moving ? Math.atan2(vel.x, vel.z) : Math.PI;
  const F = V(Math.sin(yaw), 0, Math.cos(yaw)), Rt = V(Math.cos(yaw), 0, -Math.sin(yaw));
  const vf = vel.dot(F), vl = vel.dot(Rt), af = clamp(acc.dot(F), -8, 8), al = clamp(acc.dot(Rt), -8, 8);
  trainee.pose.position.copy(p); trainee.pose.rotation.set(0, yaw, 0);
  trainee.tilt.rotation.set(clamp(0.035 * vf + 0.03 * af, -0.35, 0.35), 0, clamp(-0.045 * al, -0.4, 0.4));
  spinProps(trainee, s.spin, dt);
  // instructor's drone holds a gentle hover over the runway side
  coach.pose.position.set(-21 + Math.sin(t * 0.6) * 1.2, 4.3 + Math.sin(t * 1.3) * 0.15, 3 + Math.cos(t * 0.6) * 0.8);
  coach.pose.rotation.set(0, 0.6 + Math.sin(t * 0.4) * 0.3, 0); coach.tilt.rotation.set(0.05, 0, Math.cos(t * 0.6) * 0.06); spinProps(coach, 1, dt);
  clouds.forEach((c, i) => { c.position.x += dt * (1.2 + i * 0.3); if (c.position.x > 320) c.position.x = -320; });
  // camera: fixed pilot position, gently turning to follow the trainee
  lookTarget.set(0, 2.4, 2).lerp(p, 0.3); look.lerp(lookTarget, 1 - Math.exp(-dt * 3)); camera.lookAt(look);
  renderer.render(scene, camera);
  g.drawImage(renderer.domElement, 0, 0, W, H);
  const yawRate = moving ? (Math.atan2(vel.x, vel.z) - Math.atan2(prev.v.x, prev.v.z)) : 0;
  overlay(t, {
    alt: Math.max(0, p.y - GROUND), spd: Math.hypot(vel.x, vel.z), mode: s.mode, phase: s.phase,
    thrStick: clamp(vel.y / 2.2, -1, 1), yawStick: clamp((Math.abs(yawRate) < 1 ? yawRate : 0) / Math.max(dt, 1e-3) / 1.2, -1, 1),
    pitchStick: clamp(vf / SPD, -1, 1), rollStick: clamp(-al / 9, -1, 1),
  });
  prev.p.copy(p); prev.v.copy(vel);
}

// ---------- live loop, or an offline recording of exactly one loop ----------
const params = new URLSearchParams(location.search);
let t0 = null, lastNow = null;
function frame(now) {
  if (t0 === null) { t0 = now; lastNow = now; }
  const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
  render(((now - t0) / 1000) % LOOP, dt);
  requestAnimationFrame(frame);
}
if (params.has('record')) record(); else requestAnimationFrame(frame);

// Frames are rendered at fixed 1/30 s steps and encoded with WebCodecs, so the video is frame-perfect and needs no
// visible window (requestAnimationFrame pauses in background tabs). The H.264 samples are packed into an MP4 below.
async function record() {
  const FPS = 30, N = Math.round(LOOP * FPS), up = params.get('upload'), samples = [];
  let avcC = null, poster = null, failed = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) avcC = new Uint8Array(meta.decoderConfig.description);
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); samples.push({ b, key: chunk.type === 'key' });
    },
    error: e => { failed = String(e); },
  });
  // Baseline profile: no B-frames, so decode order = display order and the MP4 needs no ctts box.
  enc.configure({ codec: 'avc1.42001f', width: W, height: H, bitrate: +params.get('bps') || 3000000, framerate: FPS, avc: { format: 'avc' } });
  for (let i = 0; i < N && !failed; i++) {
    render(i / FPS, i ? 1 / FPS : 0);
    const f = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(f, { keyFrame: i % (2 * FPS) === 0 }); f.close();
    if (i === Math.round(11.2 * FPS)) poster = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.86)); // banking on the left loop
    if (enc.encodeQueueSize > 6) await new Promise(r => enc.addEventListener('dequeue', r, { once: true }));
    window.__field = { t: +(i / FPS).toFixed(2), loop: +LOOP.toFixed(2) }; // progress for tooling
  }
  if (!failed) await enc.flush();
  if (failed || !avcC) { window.__recording = { error: failed || 'encoder gave no avcC' }; return; }
  const blob = mp4(samples, avcC, W, H, FPS);
  window.__recording = { size: blob.size, type: 'video/mp4', frames: samples.length, seconds: +(samples.length / FPS).toFixed(2) };
  if (up) {
    await fetch(`${up}?name=sim-demo.jpg`, { method: 'POST', body: poster });
    await fetch(`${up}?name=sim-demo.mp4`, { method: 'POST', body: blob });
    window.__recording.uploaded = true;
  } else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'aeron-simulator.mp4'; a.click(); }
  document.title = 'recorded';
}

// Minimal MP4 (ISO BMFF) for one constant-frame-rate H.264 track: ftyp, moov (sample tables), one mdat chunk.
function mp4(samples, avcC, w, h, fps) {
  const u32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255], u16 = n => [n >> 8 & 255, n & 255];
  const str = s => [...s].map(c => c.charCodeAt(0)), zeros = n => new Array(n).fill(0);
  const box = (type, ...c) => { c = c.flat(9); return [...u32(c.length + 8), ...str(type), ...c]; };
  const full = (type, flags, ...c) => box(type, 0, u32(flags).slice(1), ...c); // version 0
  const TS = fps * 1000, DELTA = 1000, n = samples.length, DUR = n * DELTA;
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);
  const keys = samples.map((s, i) => s.key ? i + 1 : 0).filter(Boolean);
  const moov = off => box('moov',
    full('mvhd', 0, u32(0), u32(0), u32(TS), u32(DUR), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2)),
    box('trak',
      full('tkhd', 3, u32(0), u32(0), u32(1), u32(0), u32(DUR), zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(w * 65536), u32(h * 65536)),
      box('mdia',
        full('mdhd', 0, u32(0), u32(0), u32(TS), u32(DUR), u16(0x55c4), u16(0)),
        full('hdlr', 0, u32(0), str('vide'), zeros(12), str('VideoHandler'), 0),
        box('minf',
          full('vmhd', 1, zeros(8)),
          box('dinf', full('dref', 0, u32(1), full('url ', 1))),
          box('stbl',
            full('stsd', 0, u32(1), box('avc1', zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0), u16(1),
              zeros(32), u16(0x18), u16(0xffff), box('avcC', [...avcC]))),
            full('stts', 0, u32(1), u32(n), u32(DELTA)),
            full('stss', 0, u32(keys.length), keys.map(u32)),
            full('stsc', 0, u32(1), u32(1), u32(n), u32(1)),
            full('stsz', 0, u32(0), u32(n), samples.map(s => u32(s.b.length))),
            full('stco', 0, u32(1), u32(off)))))));
  const ftyp = box('ftyp', str('isom'), u32(512), str('isomiso2avc1mp41'));
  const head = ftyp.length + moov(0).length, bytes = samples.reduce((a, s) => a + s.b.length, 0);
  return new Blob([new Uint8Array([...ftyp, ...moov(head + 8), ...u32(bytes + 8), ...str('mdat')]), ...samples.map(s => s.b)], { type: 'video/mp4' });
}

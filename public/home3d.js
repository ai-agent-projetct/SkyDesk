// Homepage 3D: a procedural quadcopter that flies through the page as you scroll (three.js, no model files).
// Screen mode: poses come from [data-drone-at] (sit on that element) and [data-drone] (x,y,scale,yaw in viewport units)
// markers, interpolated by scroll. Inside the pinned #replay section it switches to world mode: the drone flies a path over
// a procedural terrain while the camera steps through Follow / Chase / Top / Side / FPV. Spec: docs/3d-homepage-prompt.md.
import * as THREE from 'three';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = t => t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const DEG = Math.PI / 180;

const canvas = $('#scene3d'), root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer = null;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' }); } catch { /* no WebGL */ }
if (!renderer) { canvas.remove(); root.classList.add('no-webgl'); } else start();

// ---------- the drone (forward = +Z, up = +Y) ----------
function buildDrone() {
  const pose = new THREE.Group(), tilt = new THREE.Group(); pose.add(tilt);
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...o });
  const blue = M(0x1d6fe8, { roughness: 0.32, metalness: 0.25 }), dark = M(0x1e293b, { roughness: 0.55 }), grey = M(0xa3acb9, { metalness: 0.55, roughness: 0.35 });
  const orange = M(0xf97316, { roughness: 0.4 }), black = M(0x0b1220, { roughness: 0.2, metalness: 0.7 });
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = tilt) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };

  const body = add(new THREE.CapsuleGeometry(0.19, 0.34, 8, 20), blue); body.rotation.x = Math.PI / 2; body.scale.set(1.15, 1, 0.72);
  add(new THREE.SphereGeometry(0.15, 20, 14), dark, 0, 0.1, 0.1).scale.set(1, 0.55, 1.35);             // canopy
  add(new THREE.BoxGeometry(0.16, 0.05, 0.22), grey, 0, 0.14, -0.08);                                   // GPS mast base
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 16), dark, 0, 0.19, -0.08);
  const gimbal = add(new THREE.SphereGeometry(0.075, 16, 12), dark, 0, -0.14, 0.22);
  add(new THREE.CylinderGeometry(0.04, 0.045, 0.05, 16), black, 0, 0, 0.07, gimbal).rotation.x = Math.PI / 2; // lens
  const props = [];
  [45, 135, 225, 315].forEach((a, i) => {
    const r = a * DEG, ax = Math.sin(r), az = Math.cos(r), L = 0.62;
    const arm = add(new THREE.CylinderGeometry(0.03, 0.038, L, 10), grey, ax * L / 2, 0.02, az * L / 2);
    arm.rotation.z = Math.PI / 2; arm.rotation.y = -r + Math.PI / 2;
    const mx = ax * L, mz = az * L;
    add(new THREE.CylinderGeometry(0.055, 0.06, 0.08, 18), dark, mx, 0.06, mz);                        // motor bell
    const hub = new THREE.Group(); hub.position.set(mx, 0.115, mz); tilt.add(hub);
    for (const s of [0, Math.PI]) { const blade = add(new THREE.BoxGeometry(0.46, 0.008, 0.045), black, 0, 0, 0, hub); blade.rotation.y = s; blade.position.x = 0; }
    const disc = add(new THREE.CircleGeometry(0.25, 32), new THREE.MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0, depthWrite: false }), 0, 0.002, 0, hub);
    disc.rotation.x = -Math.PI / 2;                                                                         // motion blur disc when spinning fast
    const guard = add(new THREE.TorusGeometry(0.28, 0.012, 8, 40), grey, mx, 0.115, mz); guard.rotation.x = Math.PI / 2;
    for (let k = 0; k < 4; k++) { const g = k * Math.PI / 2 + r; add(new THREE.BoxGeometry(0.035, 0.03, 0.06), orange, mx + Math.cos(g) * 0.28, 0.115, mz + Math.sin(g) * 0.28).rotation.y = -g; }
    props.push({ hub, disc, dir: i % 2 ? 1 : -1 });
  });
  for (const x of [-0.16, 0.16]) {                                                                          // skids
    add(new THREE.CylinderGeometry(0.014, 0.014, 0.5, 8), grey, x, -0.27, 0).rotation.x = Math.PI / 2;
    for (const z of [-0.12, 0.12]) add(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), grey, x * 0.8, -0.19, z).rotation.z = x > 0 ? -0.35 : 0.35;
  }
  const led = (c, z) => add(new THREE.SphereGeometry(0.025, 10, 8), new THREE.MeshBasicMaterial({ color: c }), 0, 0.02, z);
  led(0x22c55e, 0.33); led(0xef4444, -0.33);
  return { pose, tilt, props };
}

// ---------- replay world: low-poly terrain + flight path ----------
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function ground(x, z) { let h = 0, amp = 1, f = 0.022; for (let o = 0; o < 5; o++) { h += amp * vnoise(x * f + 11, z * f + 7); amp *= 0.5; f *= 2.03; } return (h - 0.95) * 16 - 4; }
function buildWorld() {
  const group = new THREE.Group(), S = 170, N = 150;
  const geo = new THREE.PlaneGeometry(S, S, N, N).toNonIndexed(); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) pos.setY(i, ground(pos.getX(i), pos.getZ(i)));
  for (let i = 0; i < pos.count; i += 3) { // one colour per triangle, by height
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3, n = hash(i, 3) * 0.06;
    if (y < -9.5) c.setRGB(0.76, 0.72, 0.55); else if (y < -3) c.setRGB(0.3 + n, 0.55 + n, 0.25); else if (y < 3) c.setRGB(0.22 + n, 0.45 + n, 0.2);
    else if (y < 7) c.setRGB(0.47 + n, 0.4 + n, 0.3); else c.setRGB(0.93, 0.95, 0.97);
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.computeVertexNormals();
  group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })));
  const water = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.75 }));
  water.rotation.x = -Math.PI / 2; water.position.y = -10; group.add(water);
  const pts = [[-56, -34], [-36, -14], [-16, -26], [4, -8], [-4, 12], [16, 26], [36, 16], [46, -4], [32, -24], [12, -36]]
    .map(([x, z]) => new THREE.Vector3(x, Math.max(ground(x, z), -10) + 10, z));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35);
  const SEG = 500, RAD = 6, tube = new THREE.TubeGeometry(curve, SEG, 0.22, RAD, false);
  const trail = new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 }));
  group.add(trail);
  const ghost = new THREE.Mesh(new THREE.TubeGeometry(curve, 200, 0.06, 4, false), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
  group.add(ghost); // planned route, faint
  return { group, curve, trail, showUpTo: u => trail.geometry.setDrawRange(0, Math.floor(u * SEG) * RAD * 6) };
}

function start() {
  root.classList.add('sky-live');
  if (reduce) root.classList.add('reduce-motion');
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.05, 500);
  scene.add(new THREE.HemisphereLight(0xe0efff, 0x44403c, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(5, 9, 7); scene.add(sun);
  const fog = new THREE.Fog(0xdcecff, 45, 160);
  const D = buildDrone(); scene.add(D.pose);
  const W = buildWorld(); W.group.visible = false; scene.add(W.group);

  const SCREEN_CAM = new THREE.Vector3(0, 2.2, 10), ORIGIN = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  let keys = [], rep = { top: 0, h: 1 }, night = [], vw = 1, vh = 1;
  const stage = $('.stage'), caps = $$('[data-cap]'), pills = $$('[data-pill]'), skyNight = $('.sky-night'), skyReplay = $('.sky-replay');

  function measure() {
    vw = innerWidth; vh = innerHeight;
    renderer.setSize(vw, vh, false); camera.aspect = vw / vh; camera.updateProjectionMatrix();
    const maxS = Math.max(0, root.scrollHeight - vh), narrow = vw < 760;
    keys = $$('[data-drone-at],[data-drone]').map(el => {
      const r = el.getBoundingClientRect(), top = r.top + scrollY, cy = top + r.height / 2, cx = r.left + r.width / 2, s = clamp(cy - vh / 2, 0, maxS);
      if (el.dataset.droneAt) { // rides along with the element: its screen position is worked out at the current scroll
        const [scale, yaw, lift = 0, mode] = el.dataset.droneAt.split(',');
        return { s, sx: (cx / vw) * 2 - 1, docY: cy, lift: +lift, scale: +scale, yaw: +yaw * DEG, land: mode === 'land' };
      }
      const [x, y, scale, yaw] = el.dataset.drone.split(',').map(Number);
      return { s, sx: narrow ? x * 0.5 : x, sy: y, scale, yaw: yaw * DEG };
    }).sort((a, b) => a.s - b.s);
    const R = $('[data-replay]').getBoundingClientRect(); rep = { top: R.top + scrollY, h: R.height };
    night = $$('[data-sky="night"]').map(el => { const r = el.getBoundingClientRect(); return [r.top + scrollY, r.bottom + scrollY]; });
  }

  // screen-space pose at the current scroll: interpolate between the two surrounding markers
  function screenPose(s) {
    let i = keys.findIndex(k => k.s > s);
    if (i === -1) i = keys.length; const a = keys[Math.max(0, i - 1)], b = keys[Math.min(keys.length - 1, i)];
    const t = a === b ? 0 : ease(clamp((s - a.s) / (b.s - a.s), 0, 1));
    const sy = k => (k.docY === undefined ? k.sy : 1 - ((k.docY - s) / vh) * 2 + k.lift);
    return { sx: lerp(a.sx, b.sx, t), sy: lerp(sy(a), sy(b), t), scale: lerp(a.scale, b.scale, t), yaw: lerpAngle(a.yaw, b.yaw, t), land: b.land && t > 0.97 };
  }
  const ray = new THREE.Vector3();
  function toPlane(sx, sy) { // viewport point -> world point on the z = 0 plane seen from the screen camera
    camera.position.copy(SCREEN_CAM); camera.up.copy(UP); camera.lookAt(ORIGIN); camera.updateMatrixWorld();
    ray.set(sx, sy, 0.5).unproject(camera).sub(SCREEN_CAM).normalize();
    return SCREEN_CAM.clone().addScaledVector(ray, -SCREEN_CAM.z / ray.z);
  }

  // world-mode camera poses around the drone (P position, F forward, R right)
  const V = () => new THREE.Vector3();
  const CAMS = [
    (P, F, R) => ({ pos: V().copy(P).addScaledVector(F, -8).addScaledVector(UP, 3.4), look: V().copy(P).addScaledVector(F, 2), up: UP }),
    (P, F, R) => ({ pos: V().copy(P).addScaledVector(F, -4.2).addScaledVector(R, 2.4).addScaledVector(UP, 1.1), look: V().copy(P).addScaledVector(F, 5), up: UP }),
    (P, F, R) => ({ pos: V().copy(P).addScaledVector(UP, 30), look: P.clone(), up: F }),
    (P, F, R) => ({ pos: V().copy(P).addScaledVector(R, 13).addScaledVector(UP, 1.2), look: P.clone(), up: UP }),
    (P, F, R) => ({ pos: V().copy(P).addScaledVector(F, 0.7).addScaledVector(UP, 0.18), look: V().copy(P).addScaledVector(F, 20).addScaledVector(UP, -2.5), up: UP }),
  ];
  const NAMES = ['Follow', 'Chase', 'Top', 'Side', 'FPV'];

  const cur = { pos: new THREE.Vector3(0, -0.4, 0), yaw: -0.4, scale: 1, roll: 0, pitch: 0 }, prevSx = { v: 0 };
  let spin = 1, t0 = performance.now(), lastCap = -1;
  const hud = { spd: $('#hudSpd'), alt: $('#hudAlt'), vs: $('#hudVs'), thr: $('#hudThr'), bat: $('#hudBat'), hdg: $('#hudHdg'), time: $('#hudTime'), pos: $('#hudPos'), mode: $('#hudMode') };

  function update(dt, time) {
    const s = scrollY;
    // sky: fade to night over the pilot sections
    const c = s + vh / 2; let o = 0;
    for (const [a, b] of night) { const d = c < a ? a - c : c > b ? c - b : 0; o = Math.max(o, clamp(1 - d / (0.35 * vh), 0, 1)); }
    skyNight.style.opacity = o.toFixed(3); document.body.classList.toggle('is-night', o > 0.5);

    // 1) screen-mode target
    const sp = screenPose(s), target = toPlane(sp.sx, sp.sy + (sp.land ? 0.02 : 0));
    const narrowK = Math.min(1, camera.aspect * 1.05), sScale = sp.scale * narrowK;
    const bob = reduce || sp.land ? 0 : Math.sin(time * 1.7) * 0.05 * sScale;
    const k = 1 - Math.exp(-dt * 7); // floaty follow
    cur.pos.lerp(target.setY(target.y + bob), k); cur.scale = lerp(cur.scale, sScale, k);
    cur.yaw = lerpAngle(cur.yaw, sp.yaw + (reduce ? 0 : Math.sin(time * 0.45) * 0.12), k);
    const vx = (sp.sx - prevSx.v) / Math.max(dt, 1e-3); prevSx.v = sp.sx;
    cur.roll = lerp(cur.roll, clamp(-vx * 0.35, -0.5, 0.5), k); cur.pitch = lerp(cur.pitch, sp.land ? 0 : 0.12, k);

    // 2) replay world mode (pinned section)
    const p = clamp((s - rep.top) / (rep.h - vh), 0, 1), w = s < rep.top || s > rep.top + rep.h - vh ? 0 : smooth(0, 0.08, p) * (1 - smooth(0.92, 1, p));
    let camPos = SCREEN_CAM, camLook = ORIGIN, camUp = UP, dronePos = cur.pos, yaw = cur.yaw, roll = cur.roll, pitch = cur.pitch, scale = cur.scale, hideDrone = false, mode = -1;
    W.group.visible = w > 0.001; scene.fog = w > 0.001 ? fog : null; skyReplay.style.opacity = w.toFixed(3);
    if (w > 0.001) {
      const u = clamp((p - 0.08) / 0.84, 0, 1), P = W.curve.getPointAt(u), F = W.curve.getTangentAt(u).setY(0).normalize();
      const F2 = W.curve.getTangentAt(Math.min(1, u + 0.02)).setY(0).normalize(), R = V().crossVectors(F, UP).normalize();
      const turn = Math.atan2(F.x * F2.z - F.z * F2.x, F.x * F2.x + F.z * F2.z);
      mode = Math.min(4, Math.floor(u * 5)); const local = u * 5 - mode, kb = mode ? smooth(0, 0.3, local) : 1;
      const A = CAMS[mode](P, F, R), B = mode ? CAMS[mode - 1](P, F, R) : A;
      const wp = { pos: B.pos.clone().lerp(A.pos, kb), look: B.look.clone().lerp(A.look, kb), up: B.up.clone().lerp(A.up, kb).normalize() };
      camPos = SCREEN_CAM.clone().lerp(wp.pos, w); camLook = ORIGIN.clone().lerp(wp.look, w); camUp = UP.clone().lerp(wp.up, w).normalize();
      dronePos = cur.pos.clone().lerp(P, w); yaw = lerpAngle(cur.yaw, Math.atan2(F.x, F.z), w);
      roll = lerp(cur.roll, clamp(turn * 12, -0.55, 0.55), w); pitch = lerp(cur.pitch, 0.2, w); scale = lerp(cur.scale, 1, w);
      hideDrone = mode === 4 && kb > 0.5 && w > 0.9;
      W.showUpTo(u);
      // HUD from the path (numbers are illustrative, not a real flight)
      const agl = (P.y - Math.max(ground(P.x, P.z), -10)) * 3.2, P2 = W.curve.getPointAt(Math.min(1, u + 0.005));
      hud.spd.textContent = Math.round(38 + 9 * Math.sin(u * 17)); hud.alt.textContent = Math.round(agl);
      hud.vs.textContent = `V/S ${((P2.y - P.y) * 40).toFixed(1)}`; hud.thr.textContent = `THR ${Math.round(48 + 14 * Math.sin(u * 11))}%`;
      hud.bat.textContent = `BATT ${Math.round(100 - 27 * u)}%`; hud.hdg.textContent = String(Math.round(((Math.atan2(F.x, -F.z) / DEG) + 360) % 360)).padStart(3, '0');
      const sec = Math.round(u * 212); hud.time.textContent = `T+${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      hud.pos.textContent = `${(13.0827 - P.z * 9e-5).toFixed(4)} N · ${(80.2707 + P.x * 9e-5).toFixed(4)} E`; hud.mode.textContent = NAMES[mode];
    }
    const capOn = w > 0.5 ? mode : -1;
    if (capOn !== lastCap) { lastCap = capOn; caps.forEach((e, i) => e.classList.toggle('on', i === capOn)); pills.forEach((e, i) => e.classList.toggle('on', i === capOn)); }
    stage.classList.toggle('fpv', mode === 4 && w > 0.5);

    // 3) apply
    D.pose.position.copy(dronePos); D.pose.rotation.set(0, yaw, 0); D.pose.scale.setScalar(scale); D.tilt.rotation.set(pitch, 0, roll);
    D.pose.visible = !hideDrone;
    spin = lerp(spin, sp.land && w === 0 ? 0 : 1, 1 - Math.exp(-dt * 1.5));
    for (const pr of D.props) { pr.hub.rotation.y += pr.dir * spin * 55 * dt; pr.disc.material.opacity = 0.25 * spin; }
    camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camLook);
  }

  if (/[?&]debug3d\b/.test(location.search)) window.__home3d = { // tuning aid: the drone's current screen position in CSS px
    drone: () => { const v = D.pose.getWorldPosition(new THREE.Vector3()).project(camera); return { x: Math.round((v.x + 1) / 2 * vw), y: Math.round((1 - v.y) / 2 * vh) }; },
    keys: () => keys,
  };
  // Re-measure whenever the layout changes size (window resize, web fonts, late content) so the markers stay exact.
  let queued = false;
  const remeasure = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; measure(); }); } };
  measure(); addEventListener('resize', remeasure);
  if (window.ResizeObserver) new ResizeObserver(remeasure).observe(document.body); else addEventListener('load', measure);
  if (reduce) { // one still frame of the hero pose, hidden once you scroll away
    const still = () => { update(1, 0); renderer.render(scene, camera); canvas.style.opacity = scrollY < vh * 0.8 ? 1 : 0; };
    addEventListener('scroll', still, { passive: true }); addEventListener('resize', still); still(); return;
  }
  let last = performance.now();
  (function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    update(dt, (now - t0) / 1000); renderer.render(scene, camera);
    requestAnimationFrame(frame);
  })(last);
}

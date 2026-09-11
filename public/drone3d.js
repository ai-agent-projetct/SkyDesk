// Procedural quadcopter shared by the 3D homepage and the training-field demo (forward = +Z, up = +Y, span ≈ 1.7 units).
// Returns { pose, tilt, props }: move/yaw `pose`, pitch/roll `tilt`, spin each prop hub around Y.
import * as THREE from 'three';

const DEG = Math.PI / 180;
export function buildDrone(bodyColor, canopyColor = 0x1e293b) {
  const pose = new THREE.Group(), tilt = new THREE.Group(); pose.add(tilt);
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...o });
  const body = M(bodyColor, { roughness: 0.32, metalness: 0.25 }), dark = M(canopyColor, { roughness: 0.55 }), grey = M(0xa3acb9, { metalness: 0.55, roughness: 0.35 });
  const accent = M(0x2774ed, { roughness: 0.4 }), black = M(0x0b1220, { roughness: 0.2, metalness: 0.7 });
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = tilt) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };

  const fuselage = add(new THREE.CapsuleGeometry(0.19, 0.34, 8, 20), body); fuselage.rotation.x = Math.PI / 2; fuselage.scale.set(1.15, 1, 0.72);
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
    for (const s of [0, Math.PI]) add(new THREE.BoxGeometry(0.46, 0.008, 0.045), black, 0, 0, 0, hub).rotation.y = s;
    const disc = add(new THREE.CircleGeometry(0.25, 32), new THREE.MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0, depthWrite: false }), 0, 0.002, 0, hub);
    disc.rotation.x = -Math.PI / 2;                                                                         // motion blur disc when spinning fast
    const guard = add(new THREE.TorusGeometry(0.28, 0.012, 8, 40), grey, mx, 0.115, mz); guard.rotation.x = Math.PI / 2;
    for (let k = 0; k < 4; k++) { const g = k * Math.PI / 2 + r; add(new THREE.BoxGeometry(0.035, 0.03, 0.06), accent, mx + Math.cos(g) * 0.28, 0.115, mz + Math.sin(g) * 0.28).rotation.y = -g; }
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

// Spin the props: `spin` 0 (stopped) … 1 (flying).
export function spinProps(drone, spin, dt) {
  for (const p of drone.props) { p.hub.rotation.y += p.dir * spin * 55 * dt; p.disc.material.opacity = 0.25 * spin; }
}

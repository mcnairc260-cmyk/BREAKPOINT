import * as THREE from 'three';
import './style.css';
import { PhysicsWorld, type SimulationEvent } from './physics/PhysicsWorld';
import { PHYSICS } from './physics/PhysicsConstants';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const powerFill = document.querySelector<HTMLDivElement>('#power-fill')!;
const powerLabel = document.querySelector<HTMLElement>('#power-label')!;
const spinPad = document.querySelector<HTMLDivElement>('#spin-pad')!;
const spinDot = document.querySelector<HTMLDivElement>('#spin-dot')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030706);
scene.fog = new THREE.FogExp2(0x030706, 0.11);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 30);
camera.position.set(0, 2.7, 3.05);
camera.lookAt(0, 0.08, -0.15);

const hemi = new THREE.HemisphereLight(0xdde9e0, 0x10120f, 1.15);
scene.add(hemi);
const key = new THREE.SpotLight(0xfff4da, 48, 8, Math.PI / 4.2, 0.55, 1.5);
key.position.set(-1.4, 3.7, 1.1);
key.target.position.set(0, 0, -0.25);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
scene.add(key, key.target);
const rim = new THREE.PointLight(0x6bc9aa, 5, 5, 2);
rim.position.set(1.5, 1.4, -1.7);
scene.add(rim);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 12),
  new THREE.MeshStandardMaterial({ color: 0x070a09, roughness: 0.74, metalness: 0.08 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.12;
floor.receiveShadow = true;
scene.add(floor);

const table = new THREE.Group();
scene.add(table);
const clothY = 0.1;
const cloth = new THREE.Mesh(
  new THREE.BoxGeometry(PHYSICS.TABLE_HALF_WIDTH * 2, 0.055, PHYSICS.TABLE_HALF_LENGTH * 2),
  new THREE.MeshPhysicalMaterial({ color: 0x0b6a4d, roughness: 0.76, metalness: 0, sheen: 0.18, sheenColor: new THREE.Color(0x88d3b7) })
);
cloth.position.y = clothY - 0.035;
cloth.receiveShadow = true;
table.add(cloth);

const wood = new THREE.MeshPhysicalMaterial({ color: 0x301910, roughness: 0.28, metalness: 0.06, clearcoat: 0.8, clearcoatRoughness: 0.24 });
const railTop = clothY + 0.045;
const railW = 0.095;
const railH = 0.12;
function rail(x: number, z: number, w: number, d: number): void {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), wood);
  m.position.set(x, railTop, z); m.castShadow = true; m.receiveShadow = true; table.add(m);
}
rail(-PHYSICS.TABLE_HALF_WIDTH - railW / 2, 0, railW, PHYSICS.TABLE_HALF_LENGTH * 2 + railW * 2);
rail(PHYSICS.TABLE_HALF_WIDTH + railW / 2, 0, railW, PHYSICS.TABLE_HALF_LENGTH * 2 + railW * 2);
rail(0, -PHYSICS.TABLE_HALF_LENGTH - railW / 2, PHYSICS.TABLE_HALF_WIDTH * 2, railW);
rail(0, PHYSICS.TABLE_HALF_LENGTH + railW / 2, PHYSICS.TABLE_HALF_WIDTH * 2, railW);

const pocketMat = new THREE.MeshStandardMaterial({ color: 0x020202, roughness: 0.92 });
const pocketPositions: [number, number, number][] = [
  [-PHYSICS.TABLE_HALF_WIDTH, -PHYSICS.TABLE_HALF_LENGTH, PHYSICS.CORNER_POCKET_RADIUS],
  [PHYSICS.TABLE_HALF_WIDTH, -PHYSICS.TABLE_HALF_LENGTH, PHYSICS.CORNER_POCKET_RADIUS],
  [-PHYSICS.TABLE_HALF_WIDTH, PHYSICS.TABLE_HALF_LENGTH, PHYSICS.CORNER_POCKET_RADIUS],
  [PHYSICS.TABLE_HALF_WIDTH, PHYSICS.TABLE_HALF_LENGTH, PHYSICS.CORNER_POCKET_RADIUS],
  [-PHYSICS.TABLE_HALF_WIDTH, 0, PHYSICS.SIDE_POCKET_RADIUS],
  [PHYSICS.TABLE_HALF_WIDTH, 0, PHYSICS.SIDE_POCKET_RADIUS]
];
for (const [x, z, r] of pocketPositions) {
  const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.8, 0.045, 28), pocketMat);
  p.position.set(x, clothY + 0.002, z); p.receiveShadow = true; table.add(p);
}

for (const x of [-0.38, 0, 0.38]) {
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.12), wood);
  leg.position.set(x, -0.4, 0.95); leg.castShadow = true; table.add(leg);
  const leg2 = leg.clone(); leg2.position.z = -0.95; table.add(leg2);
}

const world = PhysicsWorld.standardRack();
const ballMeshes = new Map<number, THREE.Mesh>();
const ballColors = [0xf5f0dd,0xf0cc22,0x2752a3,0xcf2f2f,0x653596,0xe36c1d,0x26754b,0x6f171d,0x111111,0xf0cc22,0x2752a3,0xcf2f2f,0x653596,0xe36c1d,0x26754b,0x6f171d];
const sphereGeo = new THREE.SphereGeometry(PHYSICS.BALL_RADIUS, 36, 24);
for (const b of world.balls) {
  const material = new THREE.MeshPhysicalMaterial({
    color: ballColors[b.id] ?? 0xe9e8dc,
    roughness: 0.16,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.2
  });
  const mesh = new THREE.Mesh(sphereGeo, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.position.set(b.position.x, clothY + PHYSICS.BALL_RADIUS + 0.005, b.position.z);
  scene.add(mesh); ballMeshes.set(b.id, mesh);
}

const aimGeo = new THREE.BufferGeometry();
const aimLine = new THREE.Line(aimGeo, new THREE.LineDashedMaterial({ color: 0xdff8ee, dashSize: 0.045, gapSize: 0.026, transparent: true, opacity: 0.72 }));
aimLine.position.y = clothY + 0.013;
scene.add(aimLine);
const aimGhost = new THREE.Mesh(new THREE.RingGeometry(PHYSICS.BALL_RADIUS * 0.82, PHYSICS.BALL_RADIUS, 32), new THREE.MeshBasicMaterial({ color: 0xdff8ee, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
aimGhost.rotation.x = -Math.PI / 2; aimGhost.position.y = clothY + 0.014; scene.add(aimGhost);

const cue = new THREE.Mesh(
  new THREE.CylinderGeometry(0.006, 0.011, 1.42, 16),
  new THREE.MeshPhysicalMaterial({ color: 0xc6955b, roughness: 0.32, clearcoat: 0.55, clearcoatRoughness: 0.25 })
);
cue.castShadow = true; scene.add(cue);

class AudioEngine {
  private ctx: AudioContext | null = null;
  private getContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }
  tone(freq: number, duration: number, gain: number, type: OscillatorType = 'sine'): void {
    const c = this.getContext(); const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(Math.max(0.001, gain), c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + duration);
  }
  cue(power: number): void { this.tone(170, 0.045, 0.035 + power * 0.09, 'triangle'); }
  event(e: SimulationEvent): void {
    if (e.type === 'ball') this.tone(480 + Math.min(260, e.impulse * 900), 0.026, Math.min(0.12, 0.025 + e.impulse * 0.18), 'sine');
    if (e.type === 'rail') this.tone(145, 0.045, Math.min(0.1, 0.025 + e.impulse * 0.18), 'triangle');
    if (e.type === 'pocket' || e.type === 'scratch') { this.tone(82, 0.14, 0.11, 'sine'); setTimeout(() => this.tone(58, 0.13, 0.06, 'triangle'), 55); }
  }
}
const audio = new AudioEngine();
let playedEventCount = 0;
let aimAngle = 0;
let power = 0;
let spinX = 0;
let spinY = 0;
let pointerId: number | null = null;
let startX = 0;
let startY = 0;
let lastX = 0;
let charging = false;
let lastTime = performance.now();

function setPower(v: number): void {
  power = Math.max(0, Math.min(1, v));
  powerFill.style.width = `${Math.round(power * 100)}%`;
  powerLabel.textContent = `${Math.round(power * 100)}%`;
  if (!world.isMoving()) statusEl.textContent = power > 0.03 ? 'SET POWER' : 'AIM';
}

function updateSpin(clientX: number, clientY: number): void {
  if (world.isMoving()) return;
  const r = spinPad.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = (clientX - cx) / (r.width * 0.36), dy = (clientY - cy) / (r.height * 0.36);
  const len = Math.hypot(dx, dy); if (len > 1) { dx /= len; dy /= len; }
  spinX = dx; spinY = -dy;
  spinDot.style.left = `${r.width / 2 + dx * r.width * 0.32 - 5}px`;
  spinDot.style.top = `${r.height / 2 + dy * r.height * 0.32 - 5}px`;
  statusEl.textContent = 'SET SPIN';
}
spinPad.addEventListener('pointerdown', (e) => { spinPad.setPointerCapture(e.pointerId); updateSpin(e.clientX, e.clientY); e.stopPropagation(); });
spinPad.addEventListener('pointermove', (e) => { if (spinPad.hasPointerCapture(e.pointerId)) updateSpin(e.clientX, e.clientY); });
spinPad.addEventListener('pointerup', (e) => { updateSpin(e.clientX, e.clientY); statusEl.textContent = 'AIM'; });

canvas.addEventListener('pointerdown', (e) => {
  if (world.isMoving()) return;
  pointerId = e.pointerId; canvas.setPointerCapture(e.pointerId);
  startX = lastX = e.clientX; startY = e.clientY; charging = false; setPower(0);
});
canvas.addEventListener('pointermove', (e) => {
  if (pointerId !== e.pointerId || world.isMoving()) return;
  const dx = e.clientX - lastX; const dy = e.clientY - startY;
  if (Math.abs(dy) > 18) charging = true;
  if (!charging) aimAngle += dx * 0.0062;
  else {
    aimAngle += dx * 0.0025;
    setPower(Math.max(0, dy) / Math.min(280, innerHeight * 0.34));
  }
  lastX = e.clientX;
});
canvas.addEventListener('pointerup', (e) => {
  if (pointerId !== e.pointerId) return;
  pointerId = null;
  if (!world.isMoving() && charging && power > 0.035) {
    world.strikeCue(aimAngle, power, spinX, spinY);
    audio.cue(power); playedEventCount = 0; statusEl.textContent = 'WATCH';
  }
  charging = false; setPower(0);
});
canvas.addEventListener('pointercancel', () => { pointerId = null; charging = false; setPower(0); });

function aimEndpoint(): { x: number; z: number } {
  const cueBall = world.balls[0]!;
  const dx = Math.sin(aimAngle), dz = -Math.cos(aimAngle);
  let best = 4;
  const railTx = dx > 0 ? (PHYSICS.TABLE_HALF_WIDTH - PHYSICS.BALL_RADIUS - cueBall.position.x) / dx : dx < 0 ? (-PHYSICS.TABLE_HALF_WIDTH + PHYSICS.BALL_RADIUS - cueBall.position.x) / dx : Infinity;
  const railTz = dz > 0 ? (PHYSICS.TABLE_HALF_LENGTH - PHYSICS.BALL_RADIUS - cueBall.position.z) / dz : dz < 0 ? (-PHYSICS.TABLE_HALF_LENGTH + PHYSICS.BALL_RADIUS - cueBall.position.z) / dz : Infinity;
  best = Math.max(0, Math.min(best, railTx, railTz));
  const targetR = PHYSICS.BALL_RADIUS * 2;
  for (const b of world.balls.slice(1)) {
    if (b.pocketed) continue;
    const ox = b.position.x - cueBall.position.x, oz = b.position.z - cueBall.position.z;
    const proj = ox * dx + oz * dz; if (proj <= 0 || proj >= best) continue;
    const perp2 = ox * ox + oz * oz - proj * proj;
    if (perp2 <= targetR * targetR) {
      const hit = proj - Math.sqrt(Math.max(0, targetR * targetR - perp2));
      if (hit > 0) best = Math.min(best, hit);
    }
  }
  return { x: cueBall.position.x + dx * best, z: cueBall.position.z + dz * best };
}

function updateAimVisuals(): void {
  const b = world.balls[0]!;
  const visible = !world.isMoving() && !b.pocketed;
  aimLine.visible = visible; aimGhost.visible = visible; cue.visible = visible;
  if (!visible) return;
  const end = aimEndpoint();
  aimGeo.setFromPoints([new THREE.Vector3(b.position.x, 0, b.position.z), new THREE.Vector3(end.x, 0, end.z)]);
  aimLine.computeLineDistances();
  aimGhost.position.x = end.x; aimGhost.position.z = end.z;
  const dx = Math.sin(aimAngle), dz = -Math.cos(aimAngle);
  const pull = 0.12 + power * 0.24;
  cue.position.set(b.position.x - dx * (0.76 + pull), clothY + PHYSICS.BALL_RADIUS + 0.03, b.position.z - dz * (0.76 + pull));
  cue.rotation.set(Math.PI / 2, 0, aimAngle);
}

function resize(): void {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  if (w < 650) { camera.position.set(0, 3.05, 3.38); camera.lookAt(0, 0.05, -0.18); }
  else { camera.position.set(0, 2.7, 3.05); camera.lookAt(0, 0.08, -0.15); }
}
addEventListener('resize', resize); resize();

function animate(now: number): void {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000)); lastTime = now;
  world.stepFrame(dt);
  for (const b of world.balls) {
    const mesh = ballMeshes.get(b.id)!;
    mesh.visible = !b.pocketed;
    if (!b.pocketed) {
      mesh.position.x = b.position.x; mesh.position.z = b.position.z;
      const w = b.angularVelocity; const mag = Math.hypot(w.x, w.y, w.z);
      if (mag > 1e-5) mesh.rotateOnWorldAxis(new THREE.Vector3(w.x / mag, w.y / mag, w.z / mag), mag * dt);
    }
  }
  while (playedEventCount < world.events.length) audio.event(world.events[playedEventCount++]!);
  if (!world.isMoving() && world.activeShot) {
    const record = world.finishShotIfSettled();
    if (record) {
      const cb = world.balls[0]!;
      if (cb.pocketed) { cb.pocketed = false; cb.sleeping = true; cb.position = { x: 0, z: 0.72 }; cb.velocity = { x: 0, z: 0 }; cb.angularVelocity = { x: 0, y: 0, z: 0 }; }
      statusEl.textContent = 'AIM'; playedEventCount = 0;
      (window as Window & { lastBreakpointShot?: unknown }).lastBreakpointShot = record;
    }
  }
  updateAimVisuals();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

// Debug/replay surface intentionally exposed for deterministic verification.
(window as Window & { breakpoint?: unknown }).breakpoint = { world, getAim: () => aimAngle, getSpin: () => ({ x: spinX, y: spinY }) };

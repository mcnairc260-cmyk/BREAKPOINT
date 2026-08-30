import * as THREE from 'three';
import { BALL_COLORS, isStripe } from '../config/brand';

/**
 * Ball textures, drawn to canvases at load time.
 *
 * No image files: a pool ball is a solid or a stripe plus two numbered circles,
 * which is far better expressed as a few canvas calls than as fifteen PNGs to
 * ship, cache and colour-manage. The layout is equirectangular so that
 * `SphereGeometry`'s default UVs put the stripe around the equator and the two
 * number spots on opposite poles-ish, exactly like a real ball.
 */

const TEX_W = 512;
const TEX_H = 256;

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Draw one ball's albedo map. */
function drawBall(number: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  const color = hex(BALL_COLORS[number] ?? BALL_COLORS[0]);
  const striped = isStripe(number);

  if (striped) {
    // White ball with a coloured band around the equator.
    ctx.fillStyle = '#f2f0e6';
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    ctx.fillStyle = color;
    ctx.fillRect(0, TEX_H * 0.28, TEX_W, TEX_H * 0.44);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, TEX_W, TEX_H);
  }

  if (number > 0) {
    // Two number spots, half a turn apart, as on a real ball.
    for (const cx of [TEX_W * 0.25, TEX_W * 0.75]) {
      const cy = TEX_H * 0.5;
      const r = TEX_H * 0.19;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#f6f4ec';
      ctx.fill();

      ctx.fillStyle = '#111116';
      ctx.font = `bold ${Math.round(r * 1.25)}px "Helvetica Neue", Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(number), cx, cy + r * 0.06);
    }
  } else {
    // The cue ball's single red spot — and the only way to see its spin.
    for (const [cx, cy] of [
      [TEX_W * 0.25, TEX_H * 0.5],
      [TEX_W * 0.75, TEX_H * 0.5],
    ]) {
      ctx.beginPath();
      ctx.arc(cx, cy, TEX_H * 0.075, 0, Math.PI * 2);
      ctx.fillStyle = '#c8332a';
      ctx.fill();
    }
  }

  return canvas;
}

const cache = new Map<number, THREE.CanvasTexture>();

export function ballTexture(number: number): THREE.CanvasTexture {
  const existing = cache.get(number);
  if (existing) return existing;

  const texture = new THREE.CanvasTexture(drawBall(number));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  // Cached and shared between every mesh that uses this ball number, so mesh
  // disposal must not free it.
  texture.userData.shared = true;
  cache.set(number, texture);
  return texture;
}

/**
 * A subtly mottled cloth map.
 *
 * Flat-coloured cloth is the single strongest "developer demo" tell — real
 * baize has visible weave and a nap that catches the light. A little procedural
 * noise plus the woven line pattern is enough to break up the surface.
 */
export function clothTexture(base: number, repeat = 14): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = hex(base);
  ctx.fillRect(0, 0, size, size);

  // Deterministic value noise — no Math.random, so the table looks the same
  // every session and screenshots are comparable.
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const speck = ((n - Math.floor(n)) - 0.5) * 22;
      const weave = ((x % 3 === 0 ? 1 : 0) + (y % 3 === 0 ? 1 : 0)) * 4 - 4;
      data[i] = Math.max(0, Math.min(255, data[i] + speck + weave));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + speck + weave));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + speck + weave));
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  return texture;
}

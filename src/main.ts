import './style.css';
import { AudioEngine } from './audio/AudioEngine';
import { ShotSystem } from './game/ShotSystem';
import { PointerControls } from './input/PointerControls';
import { GameRenderer } from './render/GameRenderer';
import { Hud } from './ui/Hud';
import { StartOverlay } from './ui/StartOverlay';

/**
 * Entry point: wire the four independent pieces together and run the frame loop.
 *
 *   ShotSystem     owns the rules of the shot loop and the physics world
 *   GameRenderer   draws that world; it never writes to it
 *   PointerControls turns raw pointer events into intents
 *   Hud + AudioEngine are pure outputs
 *
 * The frame loop hands wall-clock time to exactly one place — `system.update`,
 * which spends it in whole 1/120 s simulation steps — and to the renderer for
 * camera easing. Nothing else sees a variable delta.
 */

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
const uiRoot = document.querySelector<HTMLElement>('#ui-root')!;

const audio = new AudioEngine();
const hud = new Hud(uiRoot);

const system = new ShotSystem({
  onEvents: (events) => audio.play(events),
  onShotComplete: (record) => {
    hud.logShot(record);
    hud.setPhase(true);
    hud.setHint(
      record.scratch
        ? 'Scratch — cue ball respotted behind the head string'
        : 'Drag the table to aim · pull the cue back and release to shoot',
    );
  },
});

const renderer = new GameRenderer(canvas, system);

/** Power held during a live pull-back gesture, before it is committed. */
let livePower: number | null = null;

new PointerControls(
  {
    anyInteraction: () => audio.unlock(),

    rotateAim: (delta) => {
      system.setAim(system.aimAngle + delta);
    },
    aimAtScreen: (x, y) => {
      const point = renderer.pickTable(x, y);
      if (point) system.aimAt(point);
    },
    adjustElevation: (delta) => renderer.gameCamera.adjustElevation(delta),
    zoom: (factor) => renderer.gameCamera.adjustDistance(factor),

    setPull: (pull) => {
      if (!system.acceptsInput) return;
      livePower = pull;
      renderer.livePull = pull;
      hud.setPower(pull);
    },
    releasePull: (power) => {
      renderer.livePull = 0;
      if (power === null || !system.acceptsInput) {
        // Cancelled: put the meter back to the committed power.
        livePower = null;
        hud.setPower(system.power);
        return;
      }
      system.setPower(power);
      hud.setPower(power);
      livePower = null;
      audio.unlock();
      if (system.strike()) {
        audio.cueStrike(power);
        hud.setPhase(false);
      }
    },

    setTip: (x, y) => {
      system.setTip(x, y);
      hud.setTip(system.tip);
    },
  },
  { table: canvas, cuePad: hud.cuePad, spinPad: hud.spinPad },
);

hud.setPower(system.power);
hud.setTip(system.tip);
hud.setPhase(true);

// The start presentation doubles as the audio unlock: browsers refuse to start
// an AudioContext outside a user gesture, so the game needs one deliberate
// first tap whether or not it shows anything on the way in.
const startOverlay = new StartOverlay(uiRoot, () => audio.unlock());

const resize = () => renderer.resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

let last = performance.now();
function frame(now: number): void {
  // Clamp the frame delta: a backgrounded tab hands back several seconds at
  // once, and the driver would otherwise try to catch up all of it in one go.
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  system.update(dt);
  if (livePower === null) hud.setPower(system.power);
  renderer.render(dt);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// A small hook for browser-driven verification and for debugging a shot from
// the console. Read-only in spirit: it exposes the systems, it does not drive
// the physics behind the shot loop's back.
declare global {
  interface Window {
    BREAKPOINT?: {
      system: ShotSystem;
      renderer: GameRenderer;
      hud: Hud;
      startOverlay: StartOverlay;
    };
  }
}
window.BREAKPOINT = { system, renderer, hud, startOverlay };

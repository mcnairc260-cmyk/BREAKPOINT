/**
 * The input model.
 *
 * One layer over PointerEvents handles mouse, touch and pen identically —
 * "desktop mouse controls use the same underlying input model" is a
 * requirement, and the way to actually guarantee it is to have no separate
 * mouse path at all.
 *
 * Three gestures, separated by where they start rather than by device:
 *
 *   • on the table    — drag horizontally to rotate aim, vertically to raise or
 *                       lower the camera; a tap without drag aims at that point
 *   • on the cue pad  — pull *back* to load power, release to shoot; sliding
 *                       back to zero and lifting cancels the shot
 *   • on the spin ball— drag to place the cue tip on the ball face
 *
 * The pull-back gesture is the touch-first one: it is the same motion as
 * drawing a real cue back, it is self-cancelling, and it needs no second hand.
 */

export interface PointerIntents {
  /** Relative aim change in radians. */
  rotateAim(delta: number): void;
  /** Relative camera elevation change in radians. */
  adjustElevation(delta: number): void;
  /** Multiply camera distance (pinch / wheel). */
  zoom(factor: number): void;
  /** Absolute aim at a screen point, if it lands on the table. */
  aimAtScreen(clientX: number, clientY: number): void;
  /** Live pull-back, 0..1. Called continuously during the gesture. */
  setPull(pull: number): void;
  /** Release the cue: fire at this power, or cancel if null. */
  releasePull(power: number | null): void;
  /** Cue tip contact point in ball radii, already inside the unit disc. */
  setTip(x: number, y: number): void;
  /** Any pointer contact at all — used to unlock audio. */
  anyInteraction(): void;
}

/** How far a drag may travel and still count as a tap. */
const TAP_SLOP = 8;
/** Screen pixels of horizontal drag for a full turn of aim. */
const AIM_PIXELS_PER_TURN = 1400;
/** Screen pixels of vertical drag for the full camera elevation range. */
const ELEVATION_PIXELS = 900;
/** Pull distance in pixels that corresponds to full power. */
const FULL_POWER_PIXELS = 220;

type Zone = 'table' | 'cue' | 'spin';

interface Track {
  id: number;
  zone: Zone;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: number;
}

export class PointerControls {
  private tracks = new Map<number, Track>();
  private pinchStart: number | null = null;
  private detachers: (() => void)[] = [];

  constructor(
    private readonly intents: PointerIntents,
    private readonly elements: {
      table: HTMLElement;
      cuePad: HTMLElement;
      spinPad: HTMLElement;
    },
  ) {
    this.attach(elements.table, 'table');
    this.attach(elements.cuePad, 'cue');
    this.attach(elements.spinPad, 'spin');

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.intents.zoom(e.deltaY > 0 ? 1.08 : 1 / 1.08);
    };
    elements.table.addEventListener('wheel', onWheel, { passive: false });
    this.detachers.push(() => elements.table.removeEventListener('wheel', onWheel));
  }

  dispose(): void {
    for (const d of this.detachers) d();
    this.detachers = [];
  }

  private attach(element: HTMLElement, zone: Zone): void {
    const down = (e: PointerEvent) => this.onDown(e, element, zone);
    const move = (e: PointerEvent) => this.onMove(e, zone);
    const up = (e: PointerEvent) => this.onUp(e, zone);

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    this.detachers.push(() => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    });
  }

  private onDown(e: PointerEvent, element: HTMLElement, zone: Zone): void {
    e.preventDefault();
    element.setPointerCapture(e.pointerId);
    this.intents.anyInteraction();

    this.tracks.set(e.pointerId, {
      id: e.pointerId,
      zone,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: 0,
    });

    if (zone === 'spin') this.applySpin(e);
    if (zone === 'cue') this.intents.setPull(0);
    if (zone === 'table' && this.tableTracks().length === 2) this.pinchStart = this.pinchSpan();
  }

  private onMove(e: PointerEvent, zone: Zone): void {
    const track = this.tracks.get(e.pointerId);
    if (!track) return;
    e.preventDefault();

    const dx = e.clientX - track.lastX;
    const dy = e.clientY - track.lastY;
    track.lastX = e.clientX;
    track.lastY = e.clientY;
    track.moved += Math.abs(dx) + Math.abs(dy);

    if (zone === 'spin') {
      this.applySpin(e);
      return;
    }

    if (zone === 'cue') {
      // Only the pull *away* from the ball counts, so wobbling sideways during
      // the gesture does not change the power.
      const pull = Math.max(0, e.clientY - track.startY);
      this.intents.setPull(Math.min(1, pull / FULL_POWER_PIXELS));
      return;
    }

    const active = this.tableTracks();
    if (active.length >= 2) {
      const span = this.pinchSpan();
      if (this.pinchStart && span > 0) {
        this.intents.zoom(this.pinchStart / span);
        this.pinchStart = span;
      }
      return;
    }

    this.intents.rotateAim((-dx / AIM_PIXELS_PER_TURN) * Math.PI * 2);
    this.intents.adjustElevation((-dy / ELEVATION_PIXELS) * Math.PI);
  }

  private onUp(e: PointerEvent, zone: Zone): void {
    const track = this.tracks.get(e.pointerId);
    if (!track) return;
    this.tracks.delete(e.pointerId);
    if (this.tableTracks().length < 2) this.pinchStart = null;

    if (zone === 'cue') {
      const pull = Math.max(0, e.clientY - track.startY) / FULL_POWER_PIXELS;
      // Pulling back and returning to the start cancels, exactly like putting a
      // real cue down without following through.
      this.intents.releasePull(pull < 0.04 ? null : Math.min(1, pull));
      return;
    }

    if (zone === 'table' && track.moved < TAP_SLOP) {
      this.intents.aimAtScreen(e.clientX, e.clientY);
    }
  }

  /** Map a pointer position on the spin pad onto the cue ball face. */
  private applySpin(e: PointerEvent): void {
    const rect = this.elements.spinPad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2;
    let x = (e.clientX - cx) / radius;
    // Screen y grows downwards; tip offset grows upwards.
    let y = -(e.clientY - cy) / radius;

    const r = Math.hypot(x, y);
    if (r > 1 && r > 0) {
      x /= r;
      y /= r;
    }
    this.intents.setTip(x, y);
  }

  private tableTracks(): Track[] {
    return [...this.tracks.values()].filter((t) => t.zone === 'table');
  }

  private pinchSpan(): number {
    const [a, b] = this.tableTracks();
    if (!a || !b) return 0;
    return Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
  }
}

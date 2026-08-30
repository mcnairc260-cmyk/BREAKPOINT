import type { ShotRecord } from '../game/ShotRecord';
import { MAX_TIP_OFFSET } from '../physics/PhysicsConstants';
import type { Vec2 } from '../physics/Vec';

/**
 * The DOM overlay: power meter, spin selector, phase readout and shot log.
 *
 * Kept as DOM rather than drawn into the canvas because it is text and controls
 * — crisp at any pixel ratio, reachable by assistive technology, and it leaves
 * the WebGL frame budget entirely to the table.
 */

export class Hud {
  /**
   * The `.hud` element, not the container it was mounted into.
   *
   * The lock-out styling is written as `.hud.is-locked .cue-pad`, so putting
   * the class on the container silently does nothing: the pads keep their full
   * opacity and, worse, keep their `pointer-events`, so they still swallow
   * touches while the balls are running. The shot system refuses the input
   * either way, but the player gets no signal that the table is busy.
   */
  readonly root: HTMLElement;
  readonly cuePad: HTMLElement;
  readonly spinPad: HTMLElement;

  private readonly powerFill: HTMLElement;
  private readonly powerValue: HTMLElement;
  private readonly spinDot: HTMLElement;
  private readonly spinReadout: HTMLElement;
  private readonly status: HTMLElement;
  private readonly log: HTMLElement;
  private readonly hint: HTMLElement;

  constructor(container: HTMLElement) {
    container.innerHTML = `
      <div class="hud">
        <header class="hud-top">
          <div class="brandmark">BREAK<span>POINT</span></div>
          <div class="status" id="hud-status">Aim</div>
        </header>

        <div class="hud-bottom">
          <div class="spin-block">
            <div class="pad-label">Spin</div>
            <div class="spin-pad" id="hud-spin" role="slider"
                 aria-label="Cue ball contact point"
                 aria-valuetext="centre">
              <div class="spin-cross"></div>
              <div class="spin-limit"></div>
              <div class="spin-dot" id="hud-spin-dot"></div>
            </div>
            <div class="pad-readout" id="hud-spin-readout">centre</div>
          </div>

          <div class="cue-block">
            <div class="pad-label">Power</div>
            <div class="cue-pad" id="hud-cue" role="slider" aria-label="Shot power">
              <div class="power-track"><div class="power-fill" id="hud-power"></div></div>
              <div class="cue-grip"></div>
              <div class="power-value" id="hud-power-value">50%</div>
            </div>
          </div>
        </div>

        <div class="log" id="hud-log" aria-live="polite"></div>
        <div class="hint" id="hud-hint">Drag the table to aim · pull the cue back and release to shoot</div>
      </div>
    `;

    this.root = container.querySelector('.hud')!;
    this.cuePad = container.querySelector('#hud-cue')!;
    this.spinPad = container.querySelector('#hud-spin')!;
    this.powerFill = container.querySelector('#hud-power')!;
    this.powerValue = container.querySelector('#hud-power-value')!;
    this.spinDot = container.querySelector('#hud-spin-dot')!;
    this.spinReadout = container.querySelector('#hud-spin-readout')!;
    this.status = container.querySelector('#hud-status')!;
    this.log = container.querySelector('#hud-log')!;
    this.hint = container.querySelector('#hud-hint')!;
  }

  setPower(power: number): void {
    this.powerFill.style.height = `${Math.round(power * 100)}%`;
    this.powerValue.textContent = `${Math.round(power * 100)}%`;
    this.cuePad.setAttribute('aria-valuenow', String(Math.round(power * 100)));
  }

  setTip(tip: Vec2): void {
    // The dot moves within the miscue disc, which is the pad's inner circle.
    const scale = 50 / MAX_TIP_OFFSET;
    this.spinDot.style.left = `calc(50% + ${tip.x * scale * MAX_TIP_OFFSET}%)`;
    this.spinDot.style.top = `calc(50% - ${tip.y * scale * MAX_TIP_OFFSET}%)`;
    this.spinReadout.textContent = describeTip(tip);
    this.spinPad.setAttribute('aria-valuetext', describeTip(tip));
  }

  setPhase(aiming: boolean): void {
    this.status.textContent = aiming ? 'Aim' : 'Running';
    this.status.dataset.phase = aiming ? 'aim' : 'run';
    this.root.classList.toggle('is-locked', !aiming);
  }

  setHint(text: string): void {
    this.hint.textContent = text;
  }

  /** Append one line summarising a completed shot. */
  logShot(record: ShotRecord): void {
    const parts: string[] = [`#${record.index + 1}`];
    if (record.ballsPocketed.length > 0) {
      parts.push(`potted ${record.ballsPocketed.join(', ')}`);
    } else if (record.firstObjectBallContact !== null) {
      parts.push(`hit ${record.firstObjectBallContact}`);
    } else {
      parts.push('missed everything');
    }
    if (record.scratch) parts.push('SCRATCH');
    parts.push(`${record.railContacts.length} rail`);
    parts.push(`${record.durationSeconds.toFixed(1)}s`);

    const line = document.createElement('div');
    line.className = 'log-line';
    if (record.scratch) line.classList.add('is-scratch');
    else if (record.ballsPocketed.length > 0) line.classList.add('is-pot');
    line.textContent = parts.join(' · ');
    this.log.prepend(line);
    while (this.log.childElementCount > 6) this.log.lastElementChild?.remove();
  }
}

function describeTip(tip: Vec2): string {
  if (Math.hypot(tip.x, tip.y) < 0.05) return 'centre';
  const vertical = tip.y > 0.08 ? 'follow' : tip.y < -0.08 ? 'draw' : '';
  const side = tip.x > 0.08 ? 'right' : tip.x < -0.08 ? 'left' : '';
  if (vertical && side) return `${vertical} + ${side}`;
  return vertical || `${side} english`;
}

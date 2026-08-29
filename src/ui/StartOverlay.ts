import { BRAND_CSS } from '../config/brand';

/**
 * The start presentation.
 *
 * This is the one screen where BREAKPOINT says out loud that it belongs to
 * Dragon Phoenix Ascension, and it is deliberately the *only* one: the Brand
 * Bible's own instruction on the fire gradient is "use sparingly — minimalism
 * creates power", and a pool table covered in brand marks would fail both the
 * Bible's command-center restraint and the game's own readability rules. So the
 * DNA lives here, in the chrome, and the table stays a table.
 *
 * What is on it comes straight from the Bible: the Ember-to-Gold fire gradient
 * on the wordmark (§5), the primary motto (§6), the squared display face over
 * monospace HUD labels (§5), Void Black and Carbon surfaces, and motion that
 * resolves into place rather than bouncing (§5 "Motion"). There is no dragon,
 * phoenix or monogram — those are reserved.
 *
 * It also earns its keep functionally: browsers will not start an AudioContext
 * outside a user gesture, so the game needs one deliberate first tap anyway.
 */

const DISMISS_MS = 420;

export class StartOverlay {
  readonly root: HTMLElement;
  private dismissed = false;

  constructor(
    container: HTMLElement,
    private readonly onStart: () => void,
  ) {
    const el = document.createElement('div');
    el.className = 'start';
    el.id = 'start-overlay';
    el.innerHTML = `
      <div class="start-inner">
        <div class="start-eyebrow">Dragon Phoenix Ascension</div>
        <h1 class="start-mark">BREAK<span>POINT</span></h1>
        <div class="start-rule"></div>
        <p class="start-motto">Fire Within. Power Unleashed.</p>
        <button class="start-action" id="start-action" type="button">
          <span>Break</span>
        </button>
        <p class="start-hint">
          Drag the table to aim · set spin on the cue ball · pull the cue back and release
        </p>
      </div>
    `;
    container.appendChild(el);
    this.root = el;

    const start = () => this.dismiss();
    el.querySelector<HTMLButtonElement>('#start-action')!.addEventListener('click', start);
    // Anywhere on the panel works too — on a phone the button is a target, not
    // a gate.
    el.addEventListener('pointerdown', (event) => {
      if (event.target === el || (event.target as HTMLElement).closest('.start-inner')) start();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') start();
    });
  }

  /** True once the player has started; the game runs regardless. */
  get isDismissed(): boolean {
    return this.dismissed;
  }

  dismiss(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    this.root.classList.add('is-gone');
    // Removed rather than left transparent, so it can never intercept a
    // pointer that was meant for the table.
    window.setTimeout(() => this.root.remove(), DISMISS_MS);
    this.onStart();
  }
}

/** Exposed so the palette stays in one place even for inline styling. */
export const START_ACCENT = BRAND_CSS.emberOrange;

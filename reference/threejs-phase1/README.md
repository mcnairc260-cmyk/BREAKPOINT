# BREAKPOINT

> *Fire Within. Power Unleashed.*

A physics-first 3D pool game. Phase 1 is a **playable vertical slice**: one
table, one rack, and the full shot loop — aim, spin, power, strike, watch,
shoot again — on a deterministic 120 Hz simulation.

This repository is the canonical home of BREAKPOINT. The implementation was
developed and hardened inside the Dragon Phoenix Ascension monorepo and
consolidated here; that copy is now historical.

BREAKPOINT is part of the Dragon Phoenix Ascension ecosystem and carries its
DNA — the palette, the type stacks and the command-center restraint of the DPA
Brand Bible — but it is a pool game first. Brand expression lives in the chrome
around the table (the start presentation, the wordmark, HUD accents) and never
on the cloth, where readability wins.

## Run it

```bash
npm install
npm run dev        # http://localhost:5174
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server, exposed on the LAN so a phone can load it |
| `npm run build` | Type-check then production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc -b --noEmit` across app, node and e2e projects |
| `npm run test` | Vitest — physics and game logic, headless, no DOM needed |
| `npm run lint` | ESLint |
| `npm run e2e` | Playwright acceptance tests against the **built** app |
| `npm run verify` | All of the above, in the order CI runs them |

`npm run e2e` builds nothing itself — run `npm run build` first, or use
`npm run verify`.

### Running the browser tests locally

Playwright needs a Chromium. Normally `npx playwright install chromium` is
enough. If your environment already ships one for a different Playwright build,
point at it instead:

```bash
BREAKPOINT_CHROMIUM=/path/to/chrome npm run e2e
```

## Controls

Mouse and touch run through one input model — there is no separate desktop
path.

| Gesture | Effect |
|---|---|
| Drag the table sideways | Rotate aim |
| Drag the table up/down | Raise or lower the camera |
| Tap the table | Aim at that point |
| Wheel / pinch | Zoom |
| Drag on the **cue ball widget** (bottom left) | Place the cue tip: follow, draw, English |
| Pull **down** on the cue pad (bottom right), then release | Load power and shoot |
| Pull back and return to the start | Cancel the shot |

Controls are locked while the balls are moving. That lock lives in
`ShotSystem`, not in the UI, so no input path can bypass it.

## Architecture

```
.github/workflows/phase1-ci.yml   the single required CI gate
e2e/                              Playwright browser acceptance suite
src/
├── physics/          the simulation — no DOM, no three.js, fully testable
│   ├── PhysicsConstants.ts   every physical constant, SI units
│   ├── Vec.ts                vector maths
│   ├── TableGeometry.ts      cushions, jaws, pockets as data
│   ├── BallBody.ts           one ball's state; cloth contact velocity
│   ├── FrictionModel.ts      sliding, sliding→rolling, rolling, spin decay
│   ├── SpinModel.ts          cue strike → linear + angular velocity
│   ├── BallCollision.ts      continuous detection, impulse + throw
│   ├── RailCollision.ts      cushion contact above centre, jaws
│   ├── PocketPhysics.ts      capture
│   └── PhysicsWorld.ts       fixed-step integrator with in-step CCD
├── core/FixedStepDriver.ts   the only bridge from frames to simulation steps
├── game/             rules-free shot loop
│   ├── Rack.ts               the opening position
│   ├── ShotRecord.ts         the replayable record of one shot
│   ├── ShotSystem.ts         AIM → SPIN → POWER → STRIKE → WATCH → NEXT
│   └── AimPredictor.ts       aiming line, ghost ball, tangent line
├── render/           three.js; reads the world, never writes to it
├── input/            PointerControls — one path for mouse, touch and pen
├── audio/            procedural WebAudio, intensity driven by real impulses
└── ui/               DOM overlay, and the DPA start presentation
```

Two invariants hold the whole thing up, and each has a regression test:

1. **Rendering cannot change physics outcomes.** The renderer only reads.
2. **Frame rate cannot change physics outcomes.** `FixedStepDriver` spends
   wall-clock time in whole 1/120 s steps, so 30 fps and 144 fps produce
   identical tables.

## The physics

The model is the standard one for pocket billiards (Alciatore's technical
proofs; Marlow, *The Physics of Pocket Billiards*), in SI units, with the cloth
as z = 0 and +z up.

- **Cloth.** Two regimes chosen by whether the contact patch
  `u = v + ω × (0,0,−R)` is slipping. Sliding applies `a = −μₛg·û` and the
  matching torque, so draw turns into follow on its own. Rolling applies
  rolling resistance and holds ω on the rolling constraint. ωz (English) decays
  separately through drilling friction, which is why side spin outlives the
  roll.
- **Cue strike.** Tip offset `(a, b)` in ball radii gives
  `Δω = (5v₀/2R)·(a·ẑ − b·ŝ)`. At `b = 0.4` that is exactly natural roll, which
  the test suite asserts rather than assumes.
- **Ball–ball.** Continuous time-of-impact, a normal impulse with restitution,
  and a Coulomb-limited tangential impulse — the source of throw and of spin
  transfer between balls.
- **Cushions.** The nose sits at 1.27 R, *above* the ball's centre, so the
  contact point is offset. The normal impulse therefore torques the ball
  forward (a ball leaves a rail with more topspin than it arrived with) and ωz
  produces a tangential friction impulse along the rail (running and reverse
  English change the rebound angle). Resolution uses the rigid-body contact
  impulse `J = −(1+e)·v_contact·n̂ / K`, which cannot increase energy.
- **Pockets.** Capture is only a proximity test against a point set back in the
  throat. Rattling and rejection come from the jaw circles, not from special
  cases — a ball rejects because it genuinely clipped a jaw.
- **Integration.** Fixed 1/120 s steps, each subdivided at the earliest
  contact. At break speed a ball covers ~10 cm per step, nearly two diameters,
  so cutting the step at the contact makes tunnelling impossible rather than
  unlikely.

Nothing in the model uses randomness. Identical inputs give identical outputs.

## Shot records

Every committed shot produces a plain-data `ShotRecord`: pre- and post-shot ball
states, cue ball position, aim angle, power, tip contact point, the generated
impulse, the full event stream, balls pocketed, rail contacts, first object-ball
contact, scratch flag, duration and step count.

Because the simulation is deterministic, the pre-shot state plus the strike is
enough to reproduce the rest exactly — which is what makes the record the
foundation for rules, AI, replay, trick shots and multiplayer sync later.
`ShotSystem.test.ts` asserts the round trip.

## Validation status

**Phase 1 hardened 2026-08-29, then consolidated into this repository as the
canonical home.** Everything below was executed in *this* repository from a
clean `npm ci`, not carried over from the monorepo.

| Check | Command | Result |
|---|---|---|
| Unit + physics tests | `npm test` | **122 passed**, 5 files |
| Typecheck | `npm run typecheck` | clean (app, node, e2e projects) |
| Lint | `npm run lint` | clean, no exceptions |
| Production build | `npm run build` | clean |
| Browser acceptance | `npm run e2e` | **39 passed, 1 skipped**, 0 failed, 4 viewport projects |
| Physics throughput | benchmark | **256× realtime** warm (~33 µs per 120 Hz step) |
| Real-device testing | — | **not performed** — see below |

Browser environment: headless Chromium under SwiftShader software rendering.
Viewport projects, each a separate CI-visible run:

| Project | Viewport | Notes |
|---|---|---|
| `desktop-1280x800` | 1280 × 800 | mouse |
| `mobile-portrait-390x844` | 390 × 844 | touch, DSR 3 |
| `mobile-portrait-430x932` | 430 × 932 | touch, DSR 3 |
| `mobile-landscape-844x390` | 844 × 390 | touch, DSR 3 |

The one skip is the touch-input test on the desktop project, which has no
touchscreen. The suite drives the real UI: it clears the start screen, asserts
real geometry was drawn, aims by drag and by tap (projected from a known table
coordinate, so a tap cannot silently land on the room), sets spin, loads power
with the pull-back gesture, confirms a 4-pixel nudge cancels instead of firing,
plays a complete shot, checks the controls are locked while the balls run and
reopen when they stop, verifies the whole table comes into frame, rotates the
viewport mid-shot, plays a second shot, and validates a full ShotRecord.

Shots are advanced by driving the real game loop with clamped frame deltas
rather than sleeping, so the suite tests the production code path without
spending eight seconds of wall clock per shot.

### Defects found and fixed during hardening

1. **Simultaneous contacts were resolved sequentially.** A cue ball splitting a
   frozen pair dead centre came off with 0.47 m/s of transverse velocity out of
   a perfectly symmetric shot, the two object balls left at speeds differing by
   48%, and swapping which ball was stored first flipped the result. A rack is
   full of frozen pairs, so this fired on every break. Contacts at the same
   instant are now solved together, matching the closed-form elastic solution.
2. **Balls could escape the table.** A 24 mm band of entry angles at each corner
   threaded the mouth, missing both jaws *and* the capture point, with nothing
   beyond to stop them. Containment now follows the rule the cushions imply.
   Rattling out is unaffected: 165 of 576 swept corner approaches still reject.
3. **The visual control lock never applied** — the class went on the wrong
   element, so the pads never dimmed and kept swallowing touches mid-shot.
4. **The overview camera did not fit a phone**, so a mobile player could not see
   the shot they had just played.
5. **The pendant lamp occluded the table** from the corrected framing.
6. **Latent GPU and memory leaks** — undisposed resources on re-rack, and
   unbounded shot history.

### Verified, and found correct

Determinism and replay; frame-rate independence at 30/60/75/120/144/240 fps and
under jittering frames; head-on, angled, glancing and stationary-target
collisions; the 90° rule; momentum conservation across a batch-resolved contact;
sliding, the transition to rolling, rolling resistance against the closed-form
stopping distance, spin decay and stable rest; draw, follow, stun and both
English directions; cushion rebound and spin-dependent cushion response; corner
and side capture from 0.25 to 12 m/s; pocket rejection; tunnelling resistance at
break speed; and 24 swept break shots settling with no energy created, no NaN,
no escapes and no overlapping balls at rest.

Two behaviours were investigated and found **correct, not defective**: a ball
rolled at 0.35 m/s from half a metre stops short of the pocket rather than being
drawn in (pockets are not vacuums), and net displacement is much shorter than
path length because each cushion contact removes most of a ball's linear energy.

Throughput was measured over five full breaks after warm-up: 904 steps in a
mean 29.5 ms, i.e. 7.5 s of table simulated per 0.03 s of wall clock, or about
0.065 ms of a 16.7 ms frame at 60 fps. A first, un-warmed break costs roughly
twice that while the JIT settles. This is CPU cost only and says nothing about
GPU cost.

### Real-device status

**No testing on physical hardware has been done.** The browser validation runs
under SwiftShader software rendering, which proves correctness, layout and
interaction but says nothing about frame rate. The 60 fps target on a real phone
GPU is unverified.

## Brand

BREAKPOINT carries Dragon Phoenix Ascension DNA under a pool game, not over it.

What is applied, all from the DPA Brand Bible §5:

- **Palette** — Void Black, Carbon, Ember Orange, Rebirth Gold, Signal Cyan,
  Ghost White, Steel, in `src/config/brand.ts`. Nothing else hard-codes a hex.
- **Typography** — a squared geometric sans for display, a monospace for HUD
  data and labels. No web font is loaded: the game ships zero external assets,
  and a render-blocking font request is the wrong trade on a phone.
- **The fire gradient** (Ember → Gold) on the wordmark only. The Bible's own
  instruction is "use sparingly — minimalism creates power".
- **A single strong light source**, dark and cinematic, per the imagery
  direction.
- **Motion that resolves into place** rather than bouncing.
- **The start presentation** carries the wordmark, the motto and the DPA
  attribution, and doubles as the gesture that unlocks audio.

Two deliberate deviations, both documented in `src/config/brand.ts` as
functional rather than brand choices: the deep-teal cloth and near-black woods,
because a table has to read as a table; and the standard fifteen ball colours,
because telling fifteen balls apart at a glance is a hard gameplay requirement
that three accent colours cannot meet.

**Readability outranks branding.** No brand treatment is applied to the cloth,
balls, pockets, rails, aiming guides, spin control or power meter.

The DPA dragon, phoenix and monogram are **not** used, and no magma or ember
effect is applied to the table. Those are reserved decisions.

## Not in Phase 1

Deliberately out of scope, and **not started**:

- the WPA 8-ball rules engine and referee (group assignment, fouls,
  ball-in-hand, win conditions)
- an AI opponent or tactical shot search
- multiplayer, networking, matchmaking, accounts
- progression, XP, cosmetics, monetisation
- menus beyond the single start screen

Scratches respot the cue ball behind the head string, which is the minimum that
keeps the table playable; ball in hand belongs with the rules engine.

The shot record is built to carry the rules engine when it arrives — see
[Shot records](#shot-records) — but no rule is implemented.

## Known limitations

- Balls never leave the cloth. There are no jumps, masse or curve from an
  elevated cue: the cue is always horizontal and vertical velocity is projected
  out at cushion contact. That projection is dissipative, so it cannot create
  energy, but a genuinely airborne ball is not modelled.
- Cushion restitution is a constant. Real cushions are noticeably less elastic
  at high speed.
- The aiming line is a straight geometric cast. It deliberately ignores curve,
  throw and spin, so it shows what a player could read off the table rather
  than the simulated answer.
- The rack is a fixed eight-ball layout with no randomisation, so every break
  from the same shot parameters is identical. That is a determinism feature
  now and will need a seeded jitter once there are rules.
- No PWA/service worker yet.
- Frame rate on real hardware is unmeasured; see the validation status above.
- Simultaneous contacts are solved by relaxation to the inelastic answer and
  then scaled by (1 + e), which is exact for a symmetric impact but an
  approximation for a general multi-contact pile-up. A batch that would create
  energy falls back to sequential resolution, so the no-energy-created
  guarantee holds either way.

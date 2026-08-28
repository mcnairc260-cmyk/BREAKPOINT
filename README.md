# BREAKPOINT

Phase 1 production vertical slice for a touch-first, deterministic 3D pool game.

## Run

```bash
npm install
npm run dev
```

Verification commands:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Controls

- Drag sideways on the table to rotate aim.
- Pull downward and release to set power and strike.
- Drag the cue-ball selector in the lower-left to apply follow, draw, stun, or side spin.
- Input is locked while balls are moving and automatically re-enables when the table settles.

## Phase 1 architecture

Physics lives under `src/physics` and is independent from Three.js rendering. `PhysicsWorld` advances only at a deterministic 120 Hz fixed timestep and uses deterministic microsteps inside each tick for high-speed collision protection. Ball state includes linear and angular velocity; cloth friction, sliding-to-rolling transition, rolling resistance, side-spin decay, cushion restitution/friction, pocket capture/rejection, overlap correction, sleep detection and finite-state guards are simulated in the physics layer.

Every committed shot creates a `ShotRecord` with the pre-shot state, cue state, aim, power, contact point, generated impulse, events, pockets, rails, first contact, scratch state, final states and duration. In the browser the last finished record is exposed as `window.lastBreakpointShot` for deterministic debugging and replay work.

## Rendering/audio

Three.js provides a regulation-ratio table presentation with physically based cloth, wood rails, reflective ball materials, dynamic lighting, shadows and a cinematic aiming camera. Rendering reads simulation state only and never decides physics outcomes. Web Audio generates distinct cue, ball, rail and pocket events with collision magnitude influencing gain/pitch.

## Scope

This branch intentionally stops at Phase 1. Networking, accounts, progression, monetization, rules, AI and multiplayer are not implemented here.

### Known temporary lint exception

`startX` is retained in the unified pointer gesture state for the next input refinement but is not currently consumed; ESLint is configured to ignore that single named variable. No other lint exceptions are permitted.

/**
 * Generates cross-implementation parity fixtures from the TypeScript reference.
 *
 * The reference implementation under `reference/threejs-phase1` is the oracle
 * for this migration. This script runs a set of canonical shots through it and
 * writes down exactly what happened — the initial layout, the strike, the whole
 * event stream, and the final state of every ball. The C# port then replays the
 * same fixtures and is compared against them.
 *
 * The format is deliberately a flat, line-based text file rather than JSON:
 * it needs no parser dependency on either side, it diffs legibly in review, and
 * a changed number is immediately visible in a pull request.
 *
 * Numbers are written with `toPrecision(17)`, which round-trips IEEE-754
 * binary64 exactly, so the fixture loses nothing the oracle knew.
 *
 * Run from the repository root:
 *   npx tsx unity/tools/parity/generate-fixtures.mts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const REF = path.join(ROOT, 'reference/threejs-phase1/src');

const { PhysicsWorld } = await import(`${REF}/physics/PhysicsWorld`);
const { createTable } = await import(`${REF}/physics/TableGeometry`);
const { applyStrike } = await import(`${REF}/physics/SpinModel`);
const { createRackedWorld } = await import(`${REF}/game/Rack`);
const C = await import(`${REF}/physics/PhysicsConstants`);

const R = C.BALL_RADIUS as number;
const W = C.TABLE_WIDTH as number;

type Ball = { number: number; x: number; y: number };
type Strike = { aim: number; speed: number; tipX: number; tipY: number };

interface Scenario {
  name: string;
  /** What behaviour this fixture pins down, copied into the file as a comment. */
  covers: string;
  balls: Ball[];
  strike: Strike;
  /** Optional: seed velocities directly instead of striking (for rail tests). */
  seed?: { number: number; vx: number; vy: number; wx?: number; wy?: number; wz?: number }[];
}

const num = (v: number) => (Object.is(v, -0) ? '0' : v.toPrecision(17));

const scenarios: Scenario[] = [
  {
    name: 'head-on-collision',
    covers: 'full-ball centre hit; near-total speed transfer, cue ball stops',
    balls: [{ number: 0, x: -0.3, y: 0 }, { number: 1, x: 0, y: 0 }],
    strike: { aim: 0, speed: 3, tipX: 0, tipY: 0 },
  },
  {
    name: 'angled-collision',
    covers: 'half-ball cut; the 90-degree rule',
    balls: [{ number: 0, x: -0.4, y: 0 }, { number: 1, x: 0, y: R }],
    strike: { aim: 0, speed: 3, tipX: 0, tipY: 0 },
  },
  {
    name: 'glancing-collision',
    covers: 'very thin cut; object ball barely moves, cue ball keeps its speed',
    balls: [{ number: 0, x: -0.5, y: 0 }, { number: 1, x: 0, y: 1.9 * R }],
    strike: { aim: 0, speed: 4, tipX: 0, tipY: 0 },
  },
  {
    name: 'natural-roll',
    covers: 'tip 2/5 of a radius high produces rolling immediately; rolling resistance',
    balls: [{ number: 0, x: -1.0, y: 0 }],
    strike: { aim: 0, speed: 0.5, tipX: 0, tipY: 0.4 },
  },
  {
    name: 'stun-slide-to-roll',
    covers: 'centre-ball hit slides, then transitions to rolling on its own',
    balls: [{ number: 0, x: -1.0, y: 0 }],
    strike: { aim: 0, speed: 3, tipX: 0, tipY: 0 },
  },
  {
    name: 'draw-shot',
    covers: 'backspin brings the cue ball back after contact',
    balls: [{ number: 0, x: -0.35, y: 0 }, { number: 1, x: 0, y: 0 }],
    strike: { aim: 0, speed: 3.2, tipX: 0, tipY: -0.45 },
  },
  {
    name: 'follow-shot',
    covers: 'topspin carries the cue ball forward through the contact point',
    balls: [{ number: 0, x: -0.35, y: 0 }, { number: 1, x: 0, y: 0 }],
    strike: { aim: 0, speed: 3.2, tipX: 0, tipY: 0.45 },
  },
  {
    name: 'right-english',
    covers: 'right English: positive omega-z, and its effect through a cushion',
    balls: [{ number: 0, x: -0.9, y: 0 }],
    strike: { aim: 0, speed: 3, tipX: 0.45, tipY: 0 },
  },
  {
    name: 'left-english',
    covers: 'left English: the exact mirror of right',
    balls: [{ number: 0, x: -0.9, y: 0 }],
    strike: { aim: 0, speed: 3, tipX: -0.45, tipY: 0 },
  },
  {
    name: 'rail-rebound-square',
    covers: 'straight cushion rebound; restitution and the topspin a cushion imparts',
    balls: [{ number: 0, x: -0.6, y: 0 }],
    seed: [{ number: 0, vx: 0, vy: 3 }],
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
  {
    name: 'rail-english-running',
    covers: 'spin-dependent cushion response, running English',
    balls: [{ number: 0, x: -0.9, y: -0.3 }],
    seed: [{ number: 0, vx: 0, vy: 3, wz: 90 }],
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
  {
    name: 'rail-english-reverse',
    covers: 'spin-dependent cushion response, reverse English',
    balls: [{ number: 0, x: -0.9, y: -0.3 }],
    seed: [{ number: 0, vx: 0, vy: 3, wz: -90 }],
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
  {
    name: 'corner-pocket-capture',
    covers: 'corner pocket capture at moderate speed',
    balls: [{ number: 1, x: 1.296 - 0.35, y: 0.661 - 0.35 }],
    seed: [{ number: 1, vx: 2 * Math.SQRT1_2, vy: 2 * Math.SQRT1_2 }],
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
  {
    name: 'side-pocket-capture',
    covers: 'side pocket capture',
    balls: [{ number: 1, x: 0, y: W / 2 - 0.3 }],
    seed: [{ number: 1, vx: 0, vy: 3 }],
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
  {
    name: 'pocket-rejection',
    covers: 'a jaw clip that rattles out instead of dropping; containment holds',
    balls: [{ number: 1, x: 0.55, y: 0.42 }],
    seed: (() => {
      const dx = 1.296 - 0.55;
      const dy = 0.69 - 0.42;
      const d = Math.hypot(dx, dy);
      return [{ number: 1, vx: (dx / d) * 3, vy: (dy / d) * 3 }];
    })(),
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
  {
    name: 'high-speed-tunnelling',
    covers: 'break-speed ball cannot pass through a stationary ball',
    balls: [{ number: 0, x: -1.0, y: 0 }, { number: 1, x: 0, y: 0 }],
    seed: [{ number: 0, vx: 12, vy: 0 }],
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
  {
    name: 'frozen-pair-split',
    covers: 'simultaneous contacts: symmetric split, cue ball stays on its line',
    balls: [
      { number: 0, x: -0.4, y: 0 },
      { number: 1, x: 0, y: R * 1.02 },
      { number: 2, x: 0, y: -R * 1.02 },
    ],
    seed: [{ number: 0, vx: 3, vy: 0 }],
    strike: { aim: 0, speed: 0, tipX: 0, tipY: 0 },
  },
];

function lines(): string[] {
  const out: string[] = [];
  out.push('# BREAKPOINT cross-implementation parity fixtures');
  out.push('# Generated from the TypeScript reference implementation (the physics oracle).');
  out.push('# Do not hand-edit: regenerate with tools/parity/generate-fixtures.ts.');
  out.push('#');
  out.push('# Numbers use 17 significant digits, which round-trips IEEE-754 binary64 exactly.');
  out.push('');

  for (const s of scenarios) {
    const world = new PhysicsWorld(createTable());
    for (const b of s.balls) world.addBall(b.number, { x: b.x, y: b.y });

    out.push(`fixture ${s.name}`);
    out.push(`covers ${s.covers}`);
    for (const b of s.balls) out.push(`ball ${b.number} ${num(b.x)} ${num(b.y)}`);

    if (s.seed) {
      for (const seed of s.seed) {
        const ball = world.balls.find((x: { number: number }) => x.number === seed.number)!;
        ball.velocity = { x: seed.vx, y: seed.vy };
        ball.spin = { x: seed.wx ?? 0, y: seed.wy ?? 0, z: seed.wz ?? 0 };
        ball.resting = false;
        out.push(
          `seed ${seed.number} ${num(seed.vx)} ${num(seed.vy)} ` +
            `${num(seed.wx ?? 0)} ${num(seed.wy ?? 0)} ${num(seed.wz ?? 0)}`,
        );
      }
    } else {
      const cue = world.balls.find((x: { number: number }) => x.number === 0)!;
      applyStrike(cue, {
        direction: { x: Math.cos(s.strike.aim), y: Math.sin(s.strike.aim) },
        speed: s.strike.speed,
        tipX: s.strike.tipX,
        tipY: s.strike.tipY,
      });
      out.push(
        `strike ${num(s.strike.aim)} ${num(s.strike.speed)} ` +
          `${num(s.strike.tipX)} ${num(s.strike.tipY)}`,
      );
    }

    const seconds = world.simulateToRest();
    const steps = Math.round(seconds / (C.FIXED_DT as number));

    for (const e of world.events) {
      if (e.type === 'ball-ball') {
        out.push(`event ball-ball ${e.a} ${e.b} - ${num(e.impulse)}`);
      } else if (e.type === 'rail') {
        out.push(`event rail ${e.ball} -1 ${e.rail} ${num(e.impulse)}`);
      } else if (e.type === 'jaw') {
        out.push(`event jaw ${e.ball} -1 ${e.jaw} ${num(e.impulse)}`);
      } else if (e.type === 'pocket') {
        out.push(`event pocket ${e.ball} -1 ${e.pocket} 0`);
      } else {
        out.push('event rest -1 -1 - 0');
      }
    }

    for (const b of world.balls) {
      out.push(
        `final ${b.number} ${num(b.position.x)} ${num(b.position.y)} ` +
          `${b.pocketed ? 1 : 0} ${b.pocketId ?? '-'}`,
      );
    }

    out.push(`duration ${num(seconds)}`);
    out.push(`steps ${steps}`);
    out.push(`settled ${world.isSettled() ? 1 : 0}`);
    out.push(`corrupted ${world.corrupted ? 1 : 0}`);
    out.push('end');
    out.push('');
  }

  // The full break is generated separately: it is by far the most demanding
  // scenario and is what actually exercises the simultaneous-contact solver.
  {
    const world = createRackedWorld();
    out.push('fixture full-break');
    out.push('covers a full rack broken hard; settling, no energy creation, no escapes');
    for (const b of world.balls) {
      out.push(`ball ${b.number} ${num(b.position.x)} ${num(b.position.y)}`);
    }
    const strike = { aim: 0.004, speed: 8.5, tipX: 0.25, tipY: -0.15 };
    applyStrike(world.cueBall!, {
      direction: { x: Math.cos(strike.aim), y: Math.sin(strike.aim) },
      speed: strike.speed,
      tipX: strike.tipX,
      tipY: strike.tipY,
    });
    out.push(
      `strike ${num(strike.aim)} ${num(strike.speed)} ${num(strike.tipX)} ${num(strike.tipY)}`,
    );

    const seconds = world.simulateToRest();
    for (const e of world.events) {
      if (e.type === 'ball-ball') out.push(`event ball-ball ${e.a} ${e.b} - ${num(e.impulse)}`);
      else if (e.type === 'rail') out.push(`event rail ${e.ball} -1 ${e.rail} ${num(e.impulse)}`);
      else if (e.type === 'jaw') out.push(`event jaw ${e.ball} -1 ${e.jaw} ${num(e.impulse)}`);
      else if (e.type === 'pocket') out.push(`event pocket ${e.ball} -1 ${e.pocket} 0`);
      else out.push('event rest -1 -1 - 0');
    }
    for (const b of world.balls) {
      out.push(
        `final ${b.number} ${num(b.position.x)} ${num(b.position.y)} ` +
          `${b.pocketed ? 1 : 0} ${b.pocketId ?? '-'}`,
      );
    }
    out.push(`duration ${num(seconds)}`);
    out.push(`steps ${Math.round(seconds / (C.FIXED_DT as number))}`);
    out.push(`settled ${world.isSettled() ? 1 : 0}`);
    out.push(`corrupted ${world.corrupted ? 1 : 0}`);
    out.push('end');
    out.push('');
  }

  return out;
}

const text = lines().join('\n');
const fs = await import('node:fs');
const target =
  path.join(ROOT, 'unity/Assets/BREAKPOINT/Tests/EditMode/Fixtures/parity.txt');
fs.writeFileSync(target, text);
console.log(`wrote ${text.split('\n').length} lines to ${target}`);
console.log(`${scenarios.length + 1} fixtures`);

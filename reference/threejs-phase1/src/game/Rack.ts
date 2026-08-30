import { BALL_RADIUS } from '../physics/PhysicsConstants';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createTable, type TableGeometry } from '../physics/TableGeometry';

/**
 * The opening position.
 *
 * A standard eight-ball rack: apex on the foot spot, the 8 in the middle of the
 * third row, corners of the back row one solid and one stripe. Phase 1 has no
 * rules engine, so the rack exists to give the shot system something worth
 * hitting rather than to enforce anything.
 */

/** Gap between neighbouring balls in the rack. Real racks are never perfect. */
const RACK_GAP = 0.0004;

/** Ball numbers by rack position, apex first, reading each row outward. */
const RACK_ORDER = [1, 9, 2, 10, 8, 3, 11, 7, 14, 4, 5, 13, 15, 6, 12];

export function rackPositions(table: TableGeometry = createTable()) {
  const spacing = 2 * BALL_RADIUS + RACK_GAP;
  const rowStep = spacing * Math.sqrt(3) * 0.5;
  const positions: { number: number; x: number; y: number }[] = [];

  let index = 0;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      positions.push({
        number: RACK_ORDER[index++],
        x: table.footSpotX + row * rowStep,
        y: (i - row / 2) * spacing,
      });
    }
  }
  return positions;
}

/** Where the cue ball sits for the break. */
export function breakCuePosition(table: TableGeometry = createTable()) {
  return { x: table.headStringX, y: 0 };
}

/** A world containing a full rack and a cue ball, ready to break. */
export function createRackedWorld(table: TableGeometry = createTable()): PhysicsWorld {
  const world = new PhysicsWorld(table);
  world.addBall(0, breakCuePosition(table));
  for (const p of rackPositions(table)) world.addBall(p.number, { x: p.x, y: p.y });
  return world;
}

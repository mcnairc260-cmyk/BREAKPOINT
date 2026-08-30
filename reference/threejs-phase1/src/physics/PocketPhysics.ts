import type { BallBody } from './BallBody';
import type { Pocket, TableGeometry } from './TableGeometry';

/**
 * Pocket capture.
 *
 * Capture is deliberately *only* a proximity test against a point set back
 * inside the throat. Everything that makes pocketing feel earned — clipping a
 * jaw, rattling between the two jaws, hanging in the mouth and rolling back
 * out — is produced by the jaw circles in `RailCollision`, not by special-cased
 * rules here. A ball rejects because it genuinely bounced off a jaw and lost
 * the line, which is why rejection looks right instead of scripted.
 */

export interface PocketCapture {
  ball: BallBody;
  pocket: Pocket;
}

/**
 * The pocket this ball has dropped into, or null.
 *
 * Two ways in. The first is the obvious one: the ball's centre reaches the
 * capture point set back inside the throat.
 *
 * The second matters more than it looks. The capture point is small and set
 * back, so a ball can thread a corner mouth on a line that misses both jaws
 * *and* stays outside the capture radius — and then there is nothing beyond the
 * mouth to stop it, so it sails off the table and comes to rest in mid-air.
 * That really happened: a 24 mm band of entry angles at each corner escaped
 * containment entirely. The cushions enclose the playing surface completely
 * except at the six mouths, so a centre that has left the rectangle can only
 * have gone through one of them, and a ball that has gone through a mouth is in
 * that pocket. Rattling out is unaffected, because a jaw deflects a ball while
 * it is still inside the rectangle, before this rule can apply.
 */
export function findCapture(ball: BallBody, table: TableGeometry): Pocket | null {
  if (ball.pocketed) return null;
  for (const pocket of table.pockets) {
    const dx = ball.position.x - pocket.centre.x;
    const dy = ball.position.y - pocket.centre.y;
    if (dx * dx + dy * dy <= pocket.captureRadius * pocket.captureRadius) {
      return pocket;
    }
  }
  // Containment backstop. A ball still travelling back towards the playing
  // area is left alone: it can reach a jaw and be kicked out, which is what
  // rattling out of a pocket is. One that has stopped, or that is still heading
  // away from the table, has nowhere left to go but down.
  if (isInPocketThroat(ball, table) && !isReturningToTable(ball, table)) {
    return nearestPocket(ball, table);
  }
  return null;
}

/** Is this ball outside the cushions but still travelling back towards them? */
function isReturningToTable(ball: BallBody, table: TableGeometry): boolean {
  const hx = table.length / 2;
  const hy = table.width / 2;
  if (Math.abs(ball.position.x) > hx && ball.position.x * ball.velocity.x < 0) return true;
  if (Math.abs(ball.position.y) > hy && ball.position.y * ball.velocity.y < 0) return true;
  return false;
}

/** The pocket whose centre is closest to this ball. */
function nearestPocket(ball: BallBody, table: TableGeometry): Pocket {
  let best = table.pockets[0];
  let bestDistance = Infinity;
  for (const pocket of table.pockets) {
    const dx = ball.position.x - pocket.centre.x;
    const dy = ball.position.y - pocket.centre.y;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) {
      bestDistance = d;
      best = pocket;
    }
  }
  return best;
}

/** Remove a ball from play. Its state freezes at the moment of capture. */
export function capture(ball: BallBody, pocket: Pocket): void {
  ball.pocketed = true;
  ball.pocketId = pocket.id;
  ball.velocity.x = 0;
  ball.velocity.y = 0;
  ball.spin.x = 0;
  ball.spin.y = 0;
  ball.spin.z = 0;
  ball.resting = true;
}

/**
 * Is this ball outside the rectangle the cushions enclose?
 *
 * Only reachable through a pocket mouth, so it means "in the throat". Used to
 * suppress cushion collisions for a ball that is already on its way down, and
 * as the escape hatch that stops a ball wedged behind the geometry from
 * bouncing forever.
 */
export function isInPocketThroat(ball: BallBody, table: TableGeometry): boolean {
  return (
    Math.abs(ball.position.x) > table.length / 2 || Math.abs(ball.position.y) > table.width / 2
  );
}

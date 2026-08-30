namespace Breakpoint.Simulation
{
    /// <summary>
    /// Pocket capture.
    ///
    /// Everything that makes pocketing feel earned — clipping a jaw, rattling
    /// between the two jaws, hanging in the mouth and rolling back out — is
    /// produced by the jaw circles in <see cref="RailCollision"/>, not by
    /// special-cased rules here. A ball rejects because it genuinely bounced off
    /// a jaw and lost the line, which is why rejection looks right instead of
    /// scripted.
    /// </summary>
    public static class PocketPhysics
    {
        /// <summary>
        /// The pocket this ball has dropped into, or null.
        ///
        /// Two ways in. The first is the obvious one: the ball's centre reaches
        /// the capture point set back inside the throat.
        ///
        /// The second matters more than it looks. The capture point is small and
        /// set back, so a ball can thread a corner mouth on a line that misses
        /// both jaws *and* stays outside the capture radius — and then there is
        /// nothing beyond the mouth to stop it, so it sails off the table and
        /// comes to rest in mid-air. That really happened in the reference
        /// implementation: a 24 mm band of entry angles at each corner escaped
        /// containment entirely. The cushions enclose the playing surface
        /// completely except at the six mouths, so a centre that has left the
        /// rectangle can only have gone through one of them, and a ball that has
        /// gone through a mouth is in that pocket — unless it is still
        /// travelling back towards the table, which is what rattling out is.
        /// </summary>
        public static Pocket FindCapture(BallBody ball, TableGeometry table)
        {
            if (ball.Pocketed) return null;

            foreach (Pocket pocket in table.Pockets)
            {
                double dx = ball.Position.X - pocket.Centre.X;
                double dy = ball.Position.Y - pocket.Centre.Y;
                if (dx * dx + dy * dy <= pocket.CaptureRadius * pocket.CaptureRadius)
                {
                    return pocket;
                }
            }

            if (IsInPocketThroat(ball, table) && !IsReturningToTable(ball, table))
            {
                return NearestPocket(ball, table);
            }

            return null;
        }

        /// <summary>The pocket whose centre is closest to this ball.</summary>
        private static Pocket NearestPocket(BallBody ball, TableGeometry table)
        {
            Pocket best = table.Pockets[0];
            double bestDistance = double.PositiveInfinity;
            foreach (Pocket pocket in table.Pockets)
            {
                double dx = ball.Position.X - pocket.Centre.X;
                double dy = ball.Position.Y - pocket.Centre.Y;
                double d = dx * dx + dy * dy;
                if (d < bestDistance)
                {
                    bestDistance = d;
                    best = pocket;
                }
            }

            return best;
        }

        /// <summary>Is this ball outside the cushions but still travelling back towards them?</summary>
        private static bool IsReturningToTable(BallBody ball, TableGeometry table)
        {
            double hx = table.Length / 2.0;
            double hy = table.Width / 2.0;
            if (System.Math.Abs(ball.Position.X) > hx && ball.Position.X * ball.Velocity.X < 0.0) return true;
            if (System.Math.Abs(ball.Position.Y) > hy && ball.Position.Y * ball.Velocity.Y < 0.0) return true;
            return false;
        }

        /// <summary>Remove a ball from play. Its state freezes at the moment of capture.</summary>
        public static void Capture(BallBody ball, Pocket pocket)
        {
            ball.Pocketed = true;
            ball.PocketId = pocket.Id;
            ball.Velocity = Vec2.Zero;
            ball.Spin = Vec3.Zero;
            ball.Resting = true;
        }

        /// <summary>
        /// Is this ball outside the rectangle the cushions enclose? Only
        /// reachable through a pocket mouth, so it means "in the throat".
        /// </summary>
        public static bool IsInPocketThroat(BallBody ball, TableGeometry table)
        {
            return System.Math.Abs(ball.Position.X) > table.Length / 2.0
                || System.Math.Abs(ball.Position.Y) > table.Width / 2.0;
        }
    }
}

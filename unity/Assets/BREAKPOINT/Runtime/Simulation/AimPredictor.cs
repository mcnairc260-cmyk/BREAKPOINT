using System;
using System.Collections.Generic;

namespace Breakpoint.Simulation
{
    /// <summary>The result of casting the aiming ray. See <see cref="AimPredictor"/>.</summary>
    public struct AimPrediction
    {
        /// <summary>True when a prediction was produced at all.</summary>
        public bool Valid;

        /// <summary>Where the cue ball's path ends: a ball, a cushion, or the ray limit.</summary>
        public Vec2 End;

        /// <summary>Ghost-ball centre at contact. Only meaningful when <see cref="Target"/> is set.</summary>
        public Vec2 Ghost;

        /// <summary>The struck ball, or null.</summary>
        public BallBody Target;

        /// <summary>Unit direction the target would set off in (the line of centres).</summary>
        public Vec2 TargetDirection;

        /// <summary>Cue ball's tangent direction at contact — the 90-degree line.</summary>
        public Vec2 CueTangent;
    }

    /// <summary>
    /// The aiming line.
    ///
    /// A purely geometric ray cast — the same maths the simulation uses for
    /// time-of-impact, but along a straight line and ignoring friction and spin.
    /// It shows where the cue ball would arrive and, if it meets a ball, the
    /// ghost-ball position and the line of centres the object ball will leave on.
    ///
    /// It deliberately does *not* run the simulation. An aiming line that
    /// predicted curve, throw and spin would tell the player the answer; a
    /// straight line is the same information a real player reads off the table,
    /// and it keeps the preview free of the cost of a full solve every frame.
    ///
    /// Ported from the TypeScript reference (src/game/AimPredictor.ts), which is
    /// the behavioural oracle for this migration.
    /// </summary>
    public static class AimPredictor
    {
        private const double MaxRay = 4.0;

        public static AimPrediction Predict(PhysicsWorld world, double angle)
        {
            var prediction = default(AimPrediction);

            BallBody cue = world == null ? null : world.CueBall;
            if (cue == null || cue.Pocketed) return prediction;

            double dx = Math.Cos(angle);
            double dy = Math.Sin(angle);
            Vec2 origin = cue.Position;

            double best = MaxRay;
            BallBody target = null;

            IReadOnlyList<BallBody> balls = world.Balls;
            for (int i = 0; i < balls.Count; i++)
            {
                BallBody ball = balls[i];
                if (ReferenceEquals(ball, cue) || ball.Pocketed) continue;

                double t;
                if (RayBall(origin, dx, dy, ball.Position, best, out t) && t < best)
                {
                    best = t;
                    target = ball;
                }
            }

            // Cushions, using the same solver the simulation uses so the preview
            // cannot disagree with what actually happens.
            var probe = new BallBody(cue.Id, cue.Number, origin);
            probe.Velocity = new Vec2(dx, dy);
            foreach (RailSegment rail in world.Table.Rails)
            {
                double? t = RailCollision.RailTimeOfImpact(probe, rail, best);
                if (t.HasValue && t.Value < best)
                {
                    best = t.Value;
                    target = null;
                }
            }

            prediction.Valid = true;
            prediction.End = new Vec2(origin.X + dx * best, origin.Y + dy * best);

            if (target == null) return prediction;

            double nx = target.Position.X - prediction.End.X;
            double ny = target.Position.Y - prediction.End.Y;
            double nLen = Math.Sqrt(nx * nx + ny * ny);
            if (nLen <= 0.0) nLen = 1.0;

            var direction = new Vec2(nx / nLen, ny / nLen);
            // The cue ball departs along the tangent, perpendicular to the line
            // of centres — the 90-degree rule, which is what a player actually
            // aims with. Of the two perpendiculars, the cue ball takes the one
            // it is already travelling towards, so the sign is taken from the
            // side of the line of centres the incoming ray passes.
            //
            // NOTE: the TypeScript reference had this vector negated, so the
            // drawn 90-degree line pointed backwards down the cue ball's path.
            // That is a defect in the *overlay*, not in the simulation — no
            // physics reads it and no parity fixture covers it — and it is
            // fixed here and in the reference. See BREAKPOINT_UNITY_MIGRATION.md.
            double cross = dx * direction.Y - dy * direction.X;
            double side = cross > 0.0 ? 1.0 : (cross < 0.0 ? -1.0 : 1.0);

            prediction.Ghost = prediction.End;
            prediction.Target = target;
            prediction.TargetDirection = direction;
            prediction.CueTangent = new Vec2(direction.Y * side, -direction.X * side);
            return prediction;
        }

        /// <summary>
        /// Distance along the ray at which a ball of radius R centred on
        /// <paramref name="origin"/> first touches a stationary ball at
        /// <paramref name="centre"/>.
        /// </summary>
        private static bool RayBall(Vec2 origin, double dx, double dy, Vec2 centre, double limit, out double t)
        {
            t = 0.0;

            double px = centre.X - origin.X;
            double py = centre.Y - origin.Y;
            double proj = px * dx + py * dy;
            if (proj <= 0.0) return false;

            double reach = 2.0 * PhysicsConstants.BallRadius;
            double perpSq = px * px + py * py - proj * proj;
            double rSq = reach * reach;
            if (perpSq > rSq) return false;

            double hit = proj - Math.Sqrt(rSq - perpSq);
            if (hit < 0.0 || hit > limit) return false;

            t = hit;
            return true;
        }
    }
}

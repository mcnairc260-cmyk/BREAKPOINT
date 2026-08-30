using System;

namespace Breakpoint.Simulation
{
    /// <summary>
    /// Cushion and jaw collisions.
    ///
    /// The detail that makes a cushion behave like a cushion rather than a wall
    /// is where it touches the ball. A regulation cushion nose sits at ~1.27 R
    /// above the cloth, which is *above* the ball's centre, so the contact point is
    ///
    ///     r = R·( −n̂·cosθ + ẑ·sinθ ),   sinθ = (h − R) / R
    ///
    /// Two consequences follow, and both are things players rely on:
    ///   • the normal impulse acts above the centre of mass, so it torques the
    ///     ball forward — a ball comes off a rail with more topspin than it
    ///     arrived with;
    ///   • the contact point has a velocity contribution from ωz, so English
    ///     produces a tangential friction impulse along the rail and the ball
    ///     rebounds off the mirror angle. That is running and reverse English.
    ///
    /// Resolution uses the textbook rigid-body contact impulse
    ///     J = −(1+e)·v_contact·n̂ / K,   K = 1/m + |r × n̂|² / I
    /// which, for e ≤ 1 and a Coulomb-limited tangential part, cannot increase
    /// the ball's total energy. That property is asserted by the test suite.
    /// </summary>
    public static class RailCollision
    {
        /// <summary>sinθ / cosθ of the contact point, from the nose height.</summary>
        private static readonly double SinTheta =
            (PhysicsConstants.CushionHeight - PhysicsConstants.BallRadius) / PhysicsConstants.BallRadius;

        private static readonly double CosTheta = Math.Sqrt(Math.Max(0.0, 1.0 - SinTheta * SinTheta));

        /// <summary>
        /// First time in (0, limit] at which the ball reaches the cushion face,
        /// or null. The contact must land within the segment's span; a ball
        /// heading past the end of a cushion is the jaws' problem.
        /// </summary>
        public static double? RailTimeOfImpact(BallBody ball, RailSegment rail, double limit)
        {
            Vec2 n = rail.Normal;
            double d = (ball.Position.X - rail.A.X) * n.X + (ball.Position.Y - rail.A.Y) * n.Y;
            double vn = ball.Velocity.X * n.X + ball.Velocity.Y * n.Y;

            double t;
            if (d <= PhysicsConstants.BallRadius)
            {
                // Already touching or through the face; only act if still closing.
                if (vn >= 0.0) return null;
                t = 0.0;
            }
            else
            {
                if (vn >= -1e-12) return null;
                t = (d - PhysicsConstants.BallRadius) / -vn;
                if (t > limit) return null;
            }

            double cx = ball.Position.X + ball.Velocity.X * t;
            double cy = ball.Position.Y + ball.Velocity.Y * t;
            double s = (cx - rail.A.X) * rail.Tangent.X + (cy - rail.A.Y) * rail.Tangent.Y;
            if (s < 0.0 || s > rail.Length) return null;
            return t;
        }

        /// <summary>Same quadratic as ball-ball, against a static circle.</summary>
        public static double? JawTimeOfImpact(BallBody ball, Jaw jaw, double limit)
        {
            double reach = PhysicsConstants.BallRadius + jaw.Radius;
            double px = jaw.Centre.X - ball.Position.X;
            double py = jaw.Centre.Y - ball.Position.Y;
            double vx = -ball.Velocity.X;
            double vy = -ball.Velocity.Y;

            double c = px * px + py * py - reach * reach;
            double b = px * vx + py * vy;
            if (c <= 0.0) return b < 0.0 ? 0.0 : (double?)null;
            if (b >= 0.0) return null;

            double a = vx * vx + vy * vy;
            if (a < 1e-16) return null;
            double disc = b * b - a * c;
            if (disc < 0.0) return null;
            double t = (-b - Math.Sqrt(disc)) / a;
            if (t < 0.0 || t > limit) return null;
            return t;
        }

        /// <summary>Signed gap between the ball surface and the cushion face; negative = inside.</summary>
        public static double RailGap(BallBody ball, RailSegment rail)
        {
            double d = (ball.Position.X - rail.A.X) * rail.Normal.X + (ball.Position.Y - rail.A.Y) * rail.Normal.Y;
            return d - PhysicsConstants.BallRadius;
        }

        /// <summary>Is the ball's closest point to the cushion within the segment span?</summary>
        public static bool WithinRailSpan(BallBody ball, RailSegment rail)
        {
            double s = (ball.Position.X - rail.A.X) * rail.Tangent.X + (ball.Position.Y - rail.A.Y) * rail.Tangent.Y;
            return s >= 0.0 && s <= rail.Length;
        }

        /// <summary>
        /// Push a penetrating ball back out of a cushion. Position only — this
        /// exists so that a ball the impulse solver declined to act on (because
        /// its contact point was already separating) still cannot sink through.
        /// </summary>
        public static void DepenetrateRail(BallBody ball, RailSegment rail)
        {
            double gap = RailGap(ball, rail);
            if (gap >= 0.0) return;
            ball.Position = new Vec2(
                ball.Position.X + rail.Normal.X * (-gap + PhysicsConstants.OverlapSlop),
                ball.Position.Y + rail.Normal.Y * (-gap + PhysicsConstants.OverlapSlop));
        }

        /// <summary>Same, for a jaw circle.</summary>
        public static void DepenetrateJaw(BallBody ball, Jaw jaw)
        {
            double dx = ball.Position.X - jaw.Centre.X;
            double dy = ball.Position.Y - jaw.Centre.Y;
            double distance = Math.Sqrt(dx * dx + dy * dy);
            double reach = PhysicsConstants.BallRadius + jaw.Radius;
            if (distance >= reach) return;

            if (distance < 1e-9)
            {
                ball.Position = new Vec2(jaw.Centre.X + reach + PhysicsConstants.OverlapSlop, ball.Position.Y);
                return;
            }

            double push = (reach - distance + PhysicsConstants.OverlapSlop) / distance;
            ball.Position = new Vec2(ball.Position.X + dx * push, ball.Position.Y + dy * push);
        }

        public static double ResolveRail(BallBody ball, RailSegment rail, double restitution)
        {
            double j = ResolveCushionContact(ball, rail.Normal.X, rail.Normal.Y, restitution, PhysicsConstants.RailFriction);

            // Push clear of the face so the next step does not re-detect the hit.
            double d = (ball.Position.X - rail.A.X) * rail.Normal.X + (ball.Position.Y - rail.A.Y) * rail.Normal.Y;
            double overlap = PhysicsConstants.BallRadius - d;
            if (overlap > 0.0)
            {
                ball.Position = new Vec2(
                    ball.Position.X + rail.Normal.X * (overlap + PhysicsConstants.OverlapSlop),
                    ball.Position.Y + rail.Normal.Y * (overlap + PhysicsConstants.OverlapSlop));
            }

            return j;
        }

        public static double ResolveRail(BallBody ball, RailSegment rail) =>
            ResolveRail(ball, rail, PhysicsConstants.RailRestitution);

        public static double ResolveJaw(BallBody ball, Jaw jaw, double restitution)
        {
            double nx = ball.Position.X - jaw.Centre.X;
            double ny = ball.Position.Y - jaw.Centre.Y;
            double distance = Math.Sqrt(nx * nx + ny * ny);
            if (distance < 1e-9)
            {
                nx = 1.0;
                ny = 0.0;
            }
            else
            {
                nx /= distance;
                ny /= distance;
            }

            double j = ResolveCushionContact(ball, nx, ny, restitution, PhysicsConstants.JawFriction);

            double reach = PhysicsConstants.BallRadius + jaw.Radius;
            double overlap = reach - distance;
            if (overlap > 0.0)
            {
                ball.Position = new Vec2(
                    ball.Position.X + nx * (overlap + PhysicsConstants.OverlapSlop),
                    ball.Position.Y + ny * (overlap + PhysicsConstants.OverlapSlop));
            }

            return j;
        }

        public static double ResolveJaw(BallBody ball, Jaw jaw) =>
            ResolveJaw(ball, jaw, PhysicsConstants.JawRestitution);

        /// <summary>
        /// The shared impulse solver for any cushion-height contact whose inward
        /// normal is (nx, ny). Returns the normal impulse magnitude.
        /// </summary>
        private static double ResolveCushionContact(
            BallBody ball, double nx, double ny, double restitution, double friction)
        {
            // Contact point on the ball, at cushion-nose height.
            double rx = -nx * CosTheta * PhysicsConstants.BallRadius;
            double ry = -ny * CosTheta * PhysicsConstants.BallRadius;
            double rz = SinTheta * PhysicsConstants.BallRadius;

            // v_contact = v + ω × r (ball velocity is planar, so vz = 0).
            Vec3 w = ball.Spin;
            double cvx = ball.Velocity.X + (w.Y * rz - w.Z * ry);
            double cvy = ball.Velocity.Y + (w.Z * rx - w.X * rz);

            double vn = cvx * nx + cvy * ny;
            if (vn >= 0.0) return 0.0; // separating

            // K = 1/m + |r × n̂|² / I — the effective mass along the normal.
            double rxnX = -rz * ny;
            double rxnY = rz * nx;
            double rxnZ = rx * ny - ry * nx;
            double kn = 1.0 / PhysicsConstants.BallMass
                + (rxnX * rxnX + rxnY * rxnY + rxnZ * rxnZ) * PhysicsConstants.InvBallInertia;

            double jn = -(1.0 + restitution) * vn / kn;
            ApplyImpulse(ball, jn * nx, jn * ny, 0.0, rx, ry, rz);

            // Friction is evaluated on the slip that remains *after* the normal
            // impulse: that impulse acts above the centre and therefore changes
            // the contact point's velocity, so using the pre-impulse slip would
            // over-apply friction and could push the contact past sticking into
            // slipping the other way.
            ApplyCushionFriction(ball, nx, ny, rx, ry, rz, jn, friction);

            // Balls stay on the cloth in this simulation: no jumps, no scoops.
            // Dropping the vertical component can only remove energy.
            ball.Resting = false;
            return jn;
        }

        private static void ApplyCushionFriction(
            BallBody ball, double nx, double ny, double rx, double ry, double rz, double jn, double friction)
        {
            Vec3 w = ball.Spin;
            double cvx = ball.Velocity.X + (w.Y * rz - w.Z * ry);
            double cvy = ball.Velocity.Y + (w.Z * rx - w.X * rz);
            double cvz = w.X * ry - w.Y * rx;
            double vn = cvx * nx + cvy * ny;

            // Tangential part of the contact velocity.
            double tx = cvx - vn * nx;
            double ty = cvy - vn * ny;
            double tz = cvz;
            double magnitude = Math.Sqrt(tx * tx + ty * ty + tz * tz);
            if (magnitude < 1e-9) return;
            tx /= magnitude;
            ty /= magnitude;
            tz /= magnitude;

            double rxtX = ry * tz - rz * ty;
            double rxtY = rz * tx - rx * tz;
            double rxtZ = rx * ty - ry * tx;
            double kt = 1.0 / PhysicsConstants.BallMass
                + (rxtX * rxtX + rxtY * rxtY + rxtZ * rxtZ) * PhysicsConstants.InvBallInertia;

            // Either friction stops the slip outright, or Coulomb caps it at μ|Jn|.
            double stick = magnitude / kt;
            double jt = -Math.Min(friction * Math.Abs(jn), stick);
            ApplyImpulse(ball, jt * tx, jt * ty, jt * tz, rx, ry, rz);
        }

        /// <summary>Δv = J/m (planar only) and Δω = (r × J)/I.</summary>
        private static void ApplyImpulse(
            BallBody ball, double jx, double jy, double jz, double rx, double ry, double rz)
        {
            ball.Velocity = new Vec2(
                ball.Velocity.X + jx / PhysicsConstants.BallMass,
                ball.Velocity.Y + jy / PhysicsConstants.BallMass);
            ball.Spin = new Vec3(
                ball.Spin.X + (ry * jz - rz * jy) * PhysicsConstants.InvBallInertia,
                ball.Spin.Y + (rz * jx - rx * jz) * PhysicsConstants.InvBallInertia,
                ball.Spin.Z + (rx * jy - ry * jx) * PhysicsConstants.InvBallInertia);
        }
    }
}

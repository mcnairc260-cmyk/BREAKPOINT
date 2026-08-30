using System;

namespace Breakpoint.Simulation
{
    /// <summary>
    /// Ball-ball detection and impulse resolution.
    ///
    /// Detection is continuous: <see cref="TimeOfImpact"/> solves the quadratic
    /// for when two balls travelling at constant velocity first touch, so a ball
    /// moving at break speed (12 m/s = 10 cm per 120 Hz step, nearly two ball
    /// radii) cannot pass through another between steps. The world uses the
    /// returned time to cut the step short at the contact rather than
    /// integrating past it.
    ///
    /// Resolution is a two-part impulse:
    ///   • a normal impulse along the line of centres with restitution e, and
    ///   • a Coulomb-limited tangential impulse from the relative surface
    ///     velocity, which is where throw and spin transfer come from.
    /// </summary>
    public static class BallCollision
    {
        private const double Diameter = 2.0 * PhysicsConstants.BallRadius;

        /// <summary>
        /// First time in (0, limit] at which the two balls touch, or null.
        ///
        /// Solves |Δp + Δv·t| = 2R. Balls already overlapping and still closing
        /// return 0 so the caller resolves them immediately instead of letting
        /// them sink in.
        /// </summary>
        public static double? TimeOfImpact(BallBody a, BallBody b, double limit)
        {
            double px = b.Position.X - a.Position.X;
            double py = b.Position.Y - a.Position.Y;
            double vx = b.Velocity.X - a.Velocity.X;
            double vy = b.Velocity.Y - a.Velocity.Y;

            double c = px * px + py * py - Diameter * Diameter;
            double bq = px * vx + py * vy;

            // Already touching and approaching: resolve now.
            if (c <= 0.0) return bq < 0.0 ? 0.0 : (double?)null;
            // Separating or parallel — a quadratic root would be in the past.
            if (bq >= 0.0) return null;

            double aq = vx * vx + vy * vy;
            if (aq < 1e-16) return null;

            double disc = bq * bq - aq * c;
            if (disc < 0.0) return null;

            double t = (-bq - Math.Sqrt(disc)) / aq;
            if (t < 0.0 || t > limit) return null;
            return t;
        }

        /// <summary>
        /// Resolve a contact between two balls, returning the normal impulse
        /// magnitude — which audio uses to scale the click and the shot record
        /// stores as the collision's strength.
        ///
        /// <paramref name="restitution"/> defaults to the real coefficient. The
        /// simultaneous-contact solver overrides it with zero to reach the
        /// perfectly inelastic solution first, then scales that result back up.
        /// </summary>
        public static double Resolve(BallBody a, BallBody b, double restitution)
        {
            double nx = b.Position.X - a.Position.X;
            double ny = b.Position.Y - a.Position.Y;
            double distance = Math.Sqrt(nx * nx + ny * ny);

            if (distance < 1e-9)
            {
                // Perfectly coincident centres cannot define a normal. Pick a
                // stable axis rather than dividing by zero and poisoning the
                // world with NaN.
                nx = 1.0;
                ny = 0.0;
            }
            else
            {
                nx /= distance;
                ny /= distance;
            }

            double rvx = b.Velocity.X - a.Velocity.X;
            double rvy = b.Velocity.Y - a.Velocity.Y;
            double vn = rvx * nx + rvy * ny;
            if (vn > 0.0) return 0.0; // already separating

            // Normal impulse. Reduced mass for equal masses is m/2.
            double j = -(1.0 + restitution) * vn * PhysicsConstants.BallMass / 2.0;
            double jx = j * nx;
            double jy = j * ny;
            a.Velocity = new Vec2(
                a.Velocity.X - jx / PhysicsConstants.BallMass,
                a.Velocity.Y - jy / PhysicsConstants.BallMass);
            b.Velocity = new Vec2(
                b.Velocity.X + jx / PhysicsConstants.BallMass,
                b.Velocity.Y + jy / PhysicsConstants.BallMass);

            ApplyTangentialImpulse(a, b, nx, ny, j);
            Separate(a, b, nx, ny, distance);

            a.Resting = false;
            b.Resting = false;
            return j;
        }

        public static double Resolve(BallBody a, BallBody b) =>
            Resolve(a, b, PhysicsConstants.BallRestitution);

        /// <summary>
        /// Surface friction at the contact point.
        ///
        /// Relative surface velocity is u = Δv + R·(ω_a + ω_b) × n̂ — both balls'
        /// spins add, because their contact points move in opposite senses. The
        /// tangential impulse opposes u and is capped by Coulomb's μ|j|.
        /// </summary>
        private static void ApplyTangentialImpulse(BallBody a, BallBody b, double nx, double ny, double j)
        {
            // (ω_a + ω_b) × n̂, with n̂ = (nx, ny, 0).
            double wx = a.Spin.X + b.Spin.X;
            double wy = a.Spin.Y + b.Spin.Y;
            double wz = a.Spin.Z + b.Spin.Z;
            double cx = -wz * ny;
            double cy = wz * nx;
            double cz = wx * ny - wy * nx;

            double ux = a.Velocity.X - b.Velocity.X + PhysicsConstants.BallRadius * cx;
            double uy = a.Velocity.Y - b.Velocity.Y + PhysicsConstants.BallRadius * cy;
            double uz = PhysicsConstants.BallRadius * cz;

            // Strip the normal component; only the tangential part is rubbed away.
            double un = ux * nx + uy * ny;
            ux -= un * nx;
            uy -= un * ny;

            double magnitude = Math.Sqrt(ux * ux + uy * uy + uz * uz);
            if (magnitude < 1e-9) return;

            // Impulse that would exactly kill the slip, versus what friction allows.
            double stick = magnitude * PhysicsConstants.BallMass / 2.0;
            double jt = Math.Min(PhysicsConstants.BallFriction * Math.Abs(j), stick);
            double tx = -ux / magnitude * jt;
            double ty = -uy / magnitude * jt;
            double tz = -uz / magnitude * jt;

            a.Velocity = new Vec2(
                a.Velocity.X + tx / PhysicsConstants.BallMass,
                a.Velocity.Y + ty / PhysicsConstants.BallMass);
            b.Velocity = new Vec2(
                b.Velocity.X - tx / PhysicsConstants.BallMass,
                b.Velocity.Y - ty / PhysicsConstants.BallMass);

            // Torque arm is +R·n̂ on a and −R·n̂ on b, and b takes −J, so both
            // balls receive the same Δω = (R·n̂ × J_t) / I.
            double ax = PhysicsConstants.BallRadius * (ny * tz);
            double ay = PhysicsConstants.BallRadius * (-nx * tz);
            double az = PhysicsConstants.BallRadius * (nx * ty - ny * tx);
            var delta = new Vec3(
                ax * PhysicsConstants.InvBallInertia,
                ay * PhysicsConstants.InvBallInertia,
                az * PhysicsConstants.InvBallInertia);
            a.Spin = a.Spin + delta;
            b.Spin = b.Spin + delta;
        }

        /// <summary>
        /// Positional overlap correction.
        ///
        /// Position only — never velocity. Nudging velocity to fix penetration is
        /// the classic way a solver starts injecting energy, and the "no energy
        /// created" regression test exists specifically to catch that.
        /// </summary>
        private static void Separate(BallBody a, BallBody b, double nx, double ny, double distance)
        {
            double overlap = Diameter - distance;
            if (overlap <= 0.0) return;

            double push = overlap / 2.0 + PhysicsConstants.OverlapSlop;
            a.Position = new Vec2(a.Position.X - nx * push, a.Position.Y - ny * push);
            b.Position = new Vec2(b.Position.X + nx * push, b.Position.Y + ny * push);
        }
    }
}

using System;

namespace Breakpoint.Simulation
{
    /// <summary>A cue strike, as plain data. This is the whole of a player's shot input.</summary>
    public struct CueStrike
    {
        /// <summary>Aim direction. Need not be normalised.</summary>
        public Vec2 Direction;
        /// <summary>Cue ball speed immediately after contact, m/s.</summary>
        public double Speed;
        /// <summary>Tip offset right of centre, in ball radii. Positive = right English.</summary>
        public double TipX;
        /// <summary>Tip offset above centre, in ball radii. Positive = follow/topspin.</summary>
        public double TipY;
    }

    /// <summary>What a strike actually produced, kept for the shot record.</summary>
    public struct StrikeImpulse
    {
        public Vec2 Velocity;
        public Vec3 Spin;
        /// <summary>The tip offsets actually used, after clamping to the miscue disc.</summary>
        public double TipX;
        public double TipY;
        public double Speed;
    }

    /// <summary>
    /// Turns a cue strike into linear and angular velocity.
    ///
    /// The tip contacts the ball at
    ///     r = R·( −c·â + a·ŝ + b·ẑ )
    /// where â is the aim direction, ŝ = â × ẑ is "right of aim", a and b are the
    /// tip offsets in ball radii, and c = sqrt(1 − a² − b²) puts the point on the
    /// sphere. A central impulse J = m·v₀·â then produces
    ///     Δω = (r × J) / I = (5·v₀ / 2R)·( a·ẑ − b·ŝ )
    ///
    /// Two sanity checks fall straight out of that expression, and both are
    /// asserted by the test suite:
    ///   • b = 0.4 gives ω = −v₀/R about ŝ, exactly the natural-roll condition —
    ///     the classic "strike 2/5 of a radius high and the ball rolls at once".
    ///   • a > 0 (right English) gives ωz > 0, i.e. the right-hand side of the
    ///     ball moving forward. That is the correct sense.
    ///
    /// Nothing here is decorative. The ω this returns is the ω the trajectory uses.
    /// </summary>
    public static class SpinModel
    {
        /// <summary>
        /// Clamp a requested tip offset onto the miscue disc, preserving its
        /// direction so the player's intent survives rather than snapping to an axis.
        /// </summary>
        public static void ClampTipOffset(double tipX, double tipY, out double outX, out double outY)
        {
            double r = Math.Sqrt(tipX * tipX + tipY * tipY);
            if (r <= PhysicsConstants.MaxTipOffset || r == 0.0)
            {
                outX = tipX;
                outY = tipY;
                return;
            }

            double scale = PhysicsConstants.MaxTipOffset / r;
            outX = tipX * scale;
            outY = tipY * scale;
        }

        public static StrikeImpulse Compute(CueStrike strike)
        {
            double dirLength = Math.Sqrt(
                strike.Direction.X * strike.Direction.X + strike.Direction.Y * strike.Direction.Y);
            double ax = dirLength > 1e-12 ? strike.Direction.X / dirLength : 1.0;
            double ay = dirLength > 1e-12 ? strike.Direction.Y / dirLength : 0.0;

            double speed = Numeric.Clamp(strike.Speed, 0.0, PhysicsConstants.MaxCueSpeed);
            ClampTipOffset(strike.TipX, strike.TipY, out double tipX, out double tipY);

            // ŝ = â × ẑ — "right of aim" when looking down the shot.
            double sx = ay;
            double sy = -ax;

            double k = 2.5 * speed / PhysicsConstants.BallRadius;

            return new StrikeImpulse
            {
                Velocity = new Vec2(ax * speed, ay * speed),
                // Δω = k·( a·ẑ − b·ŝ )
                Spin = new Vec3(-k * tipY * sx, -k * tipY * sy, k * tipX),
                TipX = tipX,
                TipY = tipY,
                Speed = speed,
            };
        }

        /// <summary>Apply a strike to the cue ball in place.</summary>
        public static StrikeImpulse Apply(BallBody cueBall, CueStrike strike)
        {
            StrikeImpulse impulse = Compute(strike);
            cueBall.Velocity = impulse.Velocity;
            cueBall.Spin = impulse.Spin;
            cueBall.Resting = false;
            return impulse;
        }
    }
}

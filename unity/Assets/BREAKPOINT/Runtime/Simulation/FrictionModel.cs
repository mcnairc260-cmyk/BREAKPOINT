using System;

namespace Breakpoint.Simulation
{
    public enum ClothPhase
    {
        Stationary,
        Sliding,
        Rolling
    }

    /// <summary>
    /// Ball-cloth interaction: the sliding phase, the transition to rolling,
    /// rolling resistance, and the independent decay of English.
    ///
    /// The model is the standard one for pocket billiards (Alciatore TP A.14 /
    /// A.19, Marlow ch. 2). Two regimes, chosen by whether the contact patch is
    /// slipping:
    ///
    ///   SLIDING (|u| > 0)
    ///     a = −μ_s·g·û
    ///     α = (5 / 2R)·(−μ_s·g)·(û_y, −û_x, 0)
    ///     — the same friction force that decelerates the centre of mass also
    ///       torques the ball, which is why draw turns into follow on its own.
    ///
    ///   ROLLING (u ≈ 0)
    ///     a = −μ_r·g·v̂, and ω is held on the rolling constraint.
    ///
    /// ωz (English) is part of neither constraint. It decays on its own through
    /// drilling friction, which is why side spin outlives the shot's roll.
    /// </summary>
    public static class FrictionModel
    {
        /// <summary>Below this contact-patch speed the ball is rolling, not sliding.</summary>
        private const double SlideEpsilon = 1e-4;

        public static ClothPhase PhaseOf(BallBody ball)
        {
            if (ball.Velocity.X == 0.0 && ball.Velocity.Y == 0.0 &&
                ball.Spin.X == 0.0 && ball.Spin.Y == 0.0 && ball.Spin.Z == 0.0)
            {
                return ClothPhase.Stationary;
            }

            Vec2 u = ball.ContactVelocity();
            return Math.Sqrt(u.X * u.X + u.Y * u.Y) > SlideEpsilon ? ClothPhase.Sliding : ClothPhase.Rolling;
        }

        /// <summary>
        /// Advance one ball's velocity and spin under cloth friction for
        /// <paramref name="dt"/>. Position integration is the world's job — it
        /// has to interleave that with collision resolution.
        /// </summary>
        public static void Apply(BallBody ball, double dt)
        {
            if (dt <= 0.0) return;

            Vec2 u = ball.ContactVelocity();
            double magnitude = Math.Sqrt(u.X * u.X + u.Y * u.Y);

            if (magnitude > SlideEpsilon)
            {
                ApplySliding(ball, u, magnitude, dt);
            }
            else
            {
                ApplyRolling(ball, dt);
            }

            DecaySpin(ball, dt);
        }

        /// <summary>
        /// Sliding phase.
        ///
        /// The friction impulse is capped at exactly what it takes to kill the
        /// slip, so a long step can never overshoot into slipping the other way
        /// — overshoot is how a naive integrator manufactures energy.
        /// </summary>
        private static void ApplySliding(BallBody ball, Vec2 u, double magnitude, double dt)
        {
            double ux = u.X / magnitude;
            double uy = u.Y / magnitude;

            // Rate at which friction closes the slip: linear (μg) plus the
            // rotational contribution (5/2 μg), because one force does both jobs.
            double closeRate = PhysicsConstants.MuSlide * PhysicsConstants.Gravity * (1.0 + 2.5);
            double dtSlip = Math.Min(dt, magnitude / closeRate);

            double dv = PhysicsConstants.MuSlide * PhysicsConstants.Gravity * dtSlip;
            ball.Velocity = new Vec2(ball.Velocity.X - dv * ux, ball.Velocity.Y - dv * uy);

            // α = (5 / 2R)·a_tangential, with the cross product for r = (0,0,−R) folded in.
            double dw = 2.5 * PhysicsConstants.MuSlide * PhysicsConstants.Gravity * dtSlip / PhysicsConstants.BallRadius;
            ball.Spin = new Vec3(ball.Spin.X - dw * uy, ball.Spin.Y + dw * ux, ball.Spin.Z);

            // Any remaining time in this step is spent rolling.
            double rest = dt - dtSlip;
            if (rest > 0.0)
            {
                SnapToRolling(ball);
                ApplyRolling(ball, rest);
            }
        }

        /// <summary>Force the exact rolling constraint, removing numerical slip.</summary>
        public static void SnapToRolling(BallBody ball)
        {
            ball.Spin = new Vec3(
                -ball.Velocity.Y / PhysicsConstants.BallRadius,
                ball.Velocity.X / PhysicsConstants.BallRadius,
                ball.Spin.Z);
        }

        /// <summary>
        /// Rolling phase: rolling resistance decelerates the ball, and ω is
        /// dragged along by the constraint rather than integrated independently.
        /// </summary>
        private static void ApplyRolling(BallBody ball, double dt)
        {
            double speed = Math.Sqrt(ball.Velocity.X * ball.Velocity.X + ball.Velocity.Y * ball.Velocity.Y);
            if (speed <= 0.0)
            {
                ball.Spin = new Vec3(0.0, 0.0, ball.Spin.Z);
                return;
            }

            double dv = Math.Min(speed, PhysicsConstants.MuRoll * PhysicsConstants.Gravity * dt);
            double scale = (speed - dv) / speed;
            ball.Velocity = new Vec2(ball.Velocity.X * scale, ball.Velocity.Y * scale);
            SnapToRolling(ball);
        }

        /// <summary>
        /// English decays independently of the roll. Clamped at zero so a long
        /// step can never flip the spin direction.
        /// </summary>
        private static void DecaySpin(BallBody ball, double dt)
        {
            double wz = ball.Spin.Z;
            if (wz == 0.0) return;

            double rate = 2.5 * PhysicsConstants.MuSpin * PhysicsConstants.Gravity / PhysicsConstants.BallRadius;
            double drop = rate * dt;
            double magnitude = Math.Abs(wz);
            double next = magnitude <= drop ? 0.0 : wz - Math.Sign(wz) * drop;
            ball.Spin = new Vec3(ball.Spin.X, ball.Spin.Y, next);
        }
    }
}

namespace Breakpoint.Simulation
{
    /// <summary>
    /// Every physical constant the simulation uses, in SI units (metres,
    /// kilograms, seconds, radians). Nothing else in the simulation may
    /// hard-code a magic number.
    ///
    /// These values are a direct transcription of the TypeScript reference's
    /// <c>PhysicsConstants.ts</c>. They are the regulation figures for a 9-foot
    /// American pool table and 2 1/4" phenolic balls, with friction and
    /// restitution coefficients from the billiards-physics literature
    /// (Alciatore's technical proofs; Marlow, *The Physics of Pocket
    /// Billiards*).
    ///
    /// Changing any of them breaks parity with the reference implementation.
    /// The cross-implementation fixtures will catch it, which is the point.
    /// </summary>
    public static class PhysicsConstants
    {
        /// <summary>Gravity.</summary>
        public const double Gravity = 9.80665;

        /// <summary>Ball radius (2 1/4" diameter).</summary>
        public const double BallRadius = 0.028575;

        /// <summary>Ball mass (6 oz).</summary>
        public const double BallMass = 0.17;

        /// <summary>Moment of inertia of a solid sphere, I = 2/5 m R².</summary>
        public const double BallInertia = 0.4 * BallMass * BallRadius * BallRadius;

        /// <summary>Reciprocal inertia, for turning a surface impulse into Δω.</summary>
        public const double InvBallInertia = 1.0 / BallInertia;

        /// <summary>Playing surface, cushion nose to cushion nose: 100" x 50".</summary>
        public const double TableLength = 2.54;

        public const double TableWidth = 1.27;

        /// <summary>Cushion nose height above the cloth — the regulation 0.635 × ball diameter.</summary>
        public const double CushionHeight = 1.27 * BallRadius;

        /// <summary>Coefficient of sliding friction between ball and cloth.</summary>
        public const double MuSlide = 0.2;

        /// <summary>Rolling resistance once the ball rolls without slipping.</summary>
        public const double MuRoll = 0.01;

        /// <summary>Spinning ("drilling") friction that bleeds English away.</summary>
        public const double MuSpin = 0.044;

        /// <summary>Ball-ball normal restitution. Phenolic on phenolic is nearly elastic.</summary>
        public const double BallRestitution = 0.95;

        /// <summary>
        /// Ball-ball surface friction, the source of "throw" — a cut shot pushing
        /// the object ball off the pure line of centres — and of spin transfer.
        /// </summary>
        public const double BallFriction = 0.06;

        /// <summary>Cushion normal restitution. Cushions eat far more energy than balls.</summary>
        public const double RailRestitution = 0.75;

        /// <summary>Cushion tangential friction — the source of spin-dependent rebound angles.</summary>
        public const double RailFriction = 0.2;

        /// <summary>Pocket jaws are rubber-faced like the cushions, but deader.</summary>
        public const double JawRestitution = 0.55;

        public const double JawFriction = 0.2;

        /// <summary>
        /// Rest thresholds. A ball below both is snapped to exactly zero so a
        /// shot terminates in finite time instead of creeping asymptotically.
        /// </summary>
        public const double RestSpeed = 0.005;

        public const double RestSpin = 0.05;

        /// <summary>Simulation cadence. Rendering never changes this.</summary>
        public const double FixedDt = 1.0 / 120.0;

        /// <summary>Hard cap on simulated seconds for one shot, so a bug cannot hang.</summary>
        public const double MaxShotSeconds = 60.0;

        /// <summary>
        /// Separation pushed between overlapping bodies after an impulse is
        /// resolved. Position only: correcting overlap must never touch
        /// velocity, or the correction becomes an energy source.
        /// </summary>
        public const double OverlapSlop = 1e-6;

        /// <summary>Fastest legal cue-ball speed — a hard break is about 12 m/s.</summary>
        public const double MaxCueSpeed = 12.0;

        /// <summary>
        /// Furthest from centre the cue tip may strike, in ball radii. Beyond
        /// about 0.5 R a real tip miscues.
        /// </summary>
        public const double MaxTipOffset = 0.5;
    }
}

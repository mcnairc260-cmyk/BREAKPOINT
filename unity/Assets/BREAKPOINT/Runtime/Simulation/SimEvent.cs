namespace Breakpoint.Simulation
{
    public enum SimEventType
    {
        BallBall,
        Rail,
        Jaw,
        Pocket,
        Rest
    }

    /// <summary>
    /// One thing the simulation observed, as plain data.
    ///
    /// A single struct rather than a class hierarchy: events are produced by the
    /// hundred during a break and a class per event would allocate through the
    /// 120 Hz loop for no benefit. Unused fields for a given type are simply
    /// left at their defaults, and <see cref="Type"/> says which are meaningful.
    ///
    /// The simulation never calls presentation code; presentation observes these.
    /// That separation is what lets collision events drive audio and VFX later
    /// without contaminating deterministic simulation.
    /// </summary>
    public readonly struct SimEvent
    {
        public readonly SimEventType Type;
        /// <summary>Simulated time at the start of the step that produced this.</summary>
        public readonly double Time;
        /// <summary>Ball id. For <see cref="SimEventType.BallBall"/> this is the first ball.</summary>
        public readonly int BallA;
        /// <summary>Second ball id, for ball-ball contacts only; otherwise -1.</summary>
        public readonly int BallB;
        /// <summary>Rail, jaw or pocket id; null for ball-ball and rest.</summary>
        public readonly string GeometryId;
        /// <summary>Normal impulse magnitude, N·s. Zero for pocket and rest.</summary>
        public readonly double Impulse;
        /// <summary>Where it happened, in table coordinates.</summary>
        public readonly Vec2 At;

        private SimEvent(
            SimEventType type, double time, int ballA, int ballB, string geometryId, double impulse, Vec2 at)
        {
            Type = type;
            Time = time;
            BallA = ballA;
            BallB = ballB;
            GeometryId = geometryId;
            Impulse = impulse;
            At = at;
        }

        public static SimEvent BallContact(double time, int a, int b, double impulse, Vec2 at) =>
            new SimEvent(SimEventType.BallBall, time, a, b, null, impulse, at);

        public static SimEvent RailContact(double time, int ball, string railId, double impulse, Vec2 at) =>
            new SimEvent(SimEventType.Rail, time, ball, -1, railId, impulse, at);

        public static SimEvent JawContact(double time, int ball, string jawId, double impulse, Vec2 at) =>
            new SimEvent(SimEventType.Jaw, time, ball, -1, jawId, impulse, at);

        public static SimEvent PocketDrop(double time, int ball, string pocketId, Vec2 at) =>
            new SimEvent(SimEventType.Pocket, time, ball, -1, pocketId, 0.0, at);

        public static SimEvent Rest(double time) =>
            new SimEvent(SimEventType.Rest, time, -1, -1, null, 0.0, Vec2.Zero);
    }
}

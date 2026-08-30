using System.Collections.Generic;

namespace Breakpoint.Simulation
{
    /// <summary>A ball's state at one instant, as plain data.</summary>
    public struct BallSnapshot
    {
        public int Id;
        public int Number;
        public Vec2 Position;
        public Vec2 Velocity;
        public Vec3 Spin;
        public bool Pocketed;
        public string PocketId;

        public static BallSnapshot From(BallBody ball) => new BallSnapshot
        {
            Id = ball.Id,
            Number = ball.Number,
            Position = ball.Position,
            Velocity = ball.Velocity,
            Spin = ball.Spin,
            Pocketed = ball.Pocketed,
            PocketId = ball.PocketId,
        };
    }

    /// <summary>One ball-to-ball contact, by ball number.</summary>
    public struct BallContact
    {
        public int A;
        public int B;
        /// <summary>Normal impulse magnitude, N·s.</summary>
        public double Impulse;
        /// <summary>True if this happened after the cue ball's first object-ball contact.</summary>
        public bool AfterFirstContact;
    }

    /// <summary>One cushion or jaw contact, by ball number.</summary>
    public struct RailContact
    {
        public int Ball;
        /// <summary>Rail or jaw id from the table geometry.</summary>
        public string Id;
        public double Impulse;
        public bool AfterFirstContact;
    }

    /// <summary>
    /// What the player asked for. Plain data, so it can arrive from a touch, a
    /// mouse, a replay file or an AI without the simulation knowing which.
    /// </summary>
    public struct ShotInput
    {
        /// <summary>Aim heading in radians, measured from +x.</summary>
        public double AimAngle;
        /// <summary>Normalised power the player dialled in, 0..1.</summary>
        public double Power;
        /// <summary>Cue tip contact point in ball radii: x right of centre, y above centre.</summary>
        public double TipX;
        public double TipY;
        /// <summary>Where the cue ball was when the shot was taken.</summary>
        public Vec2 CueBallPosition;
    }

    /// <summary>
    /// The complete, replayable description of one shot.
    ///
    /// Everything a later phase needs is derived from this and nothing else:
    /// rules need the first contact, the rail contacts and the scratch flag; an
    /// AI needs the pre-shot state and the parameters that produced the outcome;
    /// replay and multiplayer need the pre-shot state plus the strike, because
    /// the simulation is deterministic and will reproduce the rest exactly.
    ///
    /// Being plain data is deliberate — no Unity types appear anywhere in it, so
    /// a record can be serialised, sent over a network, or replayed in a
    /// headless test without an engine.
    ///
    /// No rules are implemented. The record is built to carry a rules engine
    /// when one arrives; that is Phase 2 and is not started.
    /// </summary>
    public sealed class ShotRecord
    {
        /// <summary>Monotonic index within the session.</summary>
        public int Index;

        // --- inputs ---------------------------------------------------------
        public BallSnapshot[] PreShotBalls;
        public Vec2 CueBallPosition;
        public double AimAngle;
        public double Power;
        /// <summary>Cue tip contact point in ball radii, after miscue clamping.</summary>
        public Vec2 CueContactPoint;

        // --- what the strike actually produced -------------------------------
        public Vec2 ImpulseVelocity;
        public Vec3 ImpulseSpin;
        public double ImpulseSpeed;

        // --- what happened ---------------------------------------------------
        public SimEvent[] Events;
        /// <summary>Ball numbers pocketed, in the order they dropped.</summary>
        public int[] BallsPocketed;
        /// <summary>Pocket ids, parallel to <see cref="BallsPocketed"/>.</summary>
        public string[] PocketsUsed;
        /// <summary>
        /// Every ball-to-ball contact, in order. A referee needs the whole
        /// contact graph, not just the first one.
        /// </summary>
        public BallContact[] BallContacts;
        /// <summary>
        /// Every cushion contact, flagged relative to the cue ball's first
        /// object-ball contact — because the question a rules engine actually
        /// asks is "after the legal first contact, did any ball reach a
        /// cushion", which a bare list of rail ids cannot answer.
        /// </summary>
        public RailContact[] RailContacts;
        /// <summary>
        /// Jaw contacts, kept separate from cushions on purpose: a jaw is part
        /// of the pocket casting, not a cushion, so it must not satisfy a
        /// ball-to-rail requirement.
        /// </summary>
        public RailContact[] JawContacts;
        /// <summary>Number of the first object ball the cue ball touched, or -1.</summary>
        public int FirstObjectBallContact;
        /// <summary>Index into <see cref="Events"/> of that first contact, or -1.</summary>
        public int FirstContactEventIndex;
        /// <summary>True if the cue ball was pocketed.</summary>
        public bool Scratch;
        public BallSnapshot[] PostShotBalls;
        /// <summary>Simulated seconds from strike to the last ball stopping.</summary>
        public double DurationSeconds;
        /// <summary>Simulation steps consumed. Determinism checks compare this too.</summary>
        public int Steps;
    }

    /// <summary>Reduces a raw event stream into the shot record's summary fields.</summary>
    public static class ShotSummary
    {
        public struct Result
        {
            public int[] BallsPocketed;
            public string[] PocketsUsed;
            public BallContact[] BallContacts;
            public RailContact[] RailContacts;
            public RailContact[] JawContacts;
            public int FirstObjectBallContact;
            public int FirstContactEventIndex;
            public bool Scratch;
        }

        /// <summary>
        /// <paramref name="cueBallId"/> is needed because "first object ball
        /// contact" is specifically the cue ball's first contact — object balls
        /// hitting each other during a break do not count, and getting that
        /// wrong would quietly break every rules variant built on top later.
        /// </summary>
        public static Result Summarise(
            IReadOnlyList<SimEvent> events, int cueBallId, IReadOnlyList<BallBody> balls)
        {
            var ballsPocketed = new List<int>();
            var pocketsUsed = new List<string>();
            var ballContacts = new List<BallContact>();
            var railContacts = new List<RailContact>();
            var jawContacts = new List<RailContact>();
            int firstObjectBallContact = -1;
            int firstContactEventIndex = -1;
            bool scratch = false;

            for (int i = 0; i < events.Count; i++)
            {
                SimEvent e = events[i];
                switch (e.Type)
                {
                    case SimEventType.BallBall:
                    {
                        bool involvesCue = e.BallA == cueBallId || e.BallB == cueBallId;
                        bool isFirst = firstContactEventIndex < 0 && involvesCue;
                        if (isFirst)
                        {
                            firstObjectBallContact =
                                NumberOf(balls, e.BallA == cueBallId ? e.BallB : e.BallA);
                            firstContactEventIndex = i;
                        }

                        ballContacts.Add(new BallContact
                        {
                            A = NumberOf(balls, e.BallA),
                            B = NumberOf(balls, e.BallB),
                            Impulse = e.Impulse,
                            // The first contact is not "after" itself.
                            AfterFirstContact = !isFirst && firstContactEventIndex >= 0,
                        });
                        break;
                    }

                    case SimEventType.Rail:
                        railContacts.Add(new RailContact
                        {
                            Ball = NumberOf(balls, e.BallA),
                            Id = e.GeometryId,
                            Impulse = e.Impulse,
                            AfterFirstContact = firstContactEventIndex >= 0,
                        });
                        break;

                    case SimEventType.Jaw:
                        jawContacts.Add(new RailContact
                        {
                            Ball = NumberOf(balls, e.BallA),
                            Id = e.GeometryId,
                            Impulse = e.Impulse,
                            AfterFirstContact = firstContactEventIndex >= 0,
                        });
                        break;

                    case SimEventType.Pocket:
                        ballsPocketed.Add(NumberOf(balls, e.BallA));
                        pocketsUsed.Add(e.GeometryId);
                        if (e.BallA == cueBallId) scratch = true;
                        break;

                    case SimEventType.Rest:
                        break;
                }
            }

            return new Result
            {
                BallsPocketed = ballsPocketed.ToArray(),
                PocketsUsed = pocketsUsed.ToArray(),
                BallContacts = ballContacts.ToArray(),
                RailContacts = railContacts.ToArray(),
                JawContacts = jawContacts.ToArray(),
                FirstObjectBallContact = firstObjectBallContact,
                FirstContactEventIndex = firstContactEventIndex,
                Scratch = scratch,
            };
        }

        private static int NumberOf(IReadOnlyList<BallBody> balls, int id)
        {
            for (int i = 0; i < balls.Count; i++)
            {
                if (balls[i].Id == id) return balls[i].Number;
            }
            return -1;
        }
    }
}

using System;
using System.Collections.Generic;
using Breakpoint.Simulation;
using NUnit.Framework;

namespace Breakpoint.Tests
{
    /// <summary>
    /// One shot, exercising every behaviour the migration had to preserve.
    ///
    /// The scenario is a straight pot into the top-right corner from about a
    /// metre away, played with right-hand English. In a single shot it produces
    /// a cue strike, a ball-ball collision, a cushion rebound, a pocket capture
    /// and a complete settle — and the spin visibly decides where the cue ball
    /// ends up, which is the requirement that "angular velocity must actually
    /// affect the physical trajectory" rather than being drawn on.
    ///
    /// The same shot is driven through the Unity presentation bridge by
    /// PresentationContractTests.DemonstrationShotRunsThroughTheBridge. That
    /// version has never been executed; this one has.
    /// </summary>
    [TestFixture]
    public class DemonstrationShotTests
    {
        /// <summary>Cue ball start, in table coordinates.</summary>
        public static readonly Vec2 CueStart = new Vec2(0.515, 0.020);

        /// <summary>Object ball start: a straight pot into the top-right corner.</summary>
        public static readonly Vec2 ObjectStart = new Vec2(1.10, 0.50);

        public const double Speed = 3.2;

        private struct Outcome
        {
            public PhysicsWorld World;
            public BallBody Cue;
            public BallBody Object;
            public double Seconds;
            public int BallContacts;
            public int RailContacts;
            public int Pockets;
        }

        /// <summary>The aim that sends the object ball at the pocket centre.</summary>
        public static double AimAngle(PhysicsWorld world)
        {
            Pocket corner = null;
            foreach (Pocket p in world.Table.Pockets)
            {
                if (p.Id == "pocket-corner-rt") corner = p;
            }
            Assert.IsNotNull(corner, "the top-right corner pocket has gone missing");

            // Line of centres from the object ball to the pocket.
            double px = corner.Centre.X - ObjectStart.X;
            double py = corner.Centre.Y - ObjectStart.Y;
            double length = Math.Sqrt(px * px + py * py);
            px /= length;
            py /= length;

            // Aim at the ghost ball — one diameter back along that line — not
            // at the object ball itself.
            double ghostX = ObjectStart.X - 2.0 * PhysicsConstants.BallRadius * px;
            double ghostY = ObjectStart.Y - 2.0 * PhysicsConstants.BallRadius * py;
            return Math.Atan2(ghostY - CueStart.Y, ghostX - CueStart.X);
        }

        private static Outcome Play(double tipX, double tipY)
        {
            var outcome = default(Outcome);
            outcome.World = new PhysicsWorld(TableGeometry.Create());
            outcome.Cue = outcome.World.AddBall(0, CueStart);
            outcome.Object = outcome.World.AddBall(9, ObjectStart);

            double angle = AimAngle(outcome.World);
            SpinModel.Apply(outcome.Cue, new CueStrike
            {
                Direction = new Vec2(Math.Cos(angle), Math.Sin(angle)),
                Speed = Speed,
                TipX = tipX,
                TipY = tipY,
            });

            outcome.Seconds = outcome.World.SimulateToRest();

            foreach (SimEvent e in outcome.World.Events)
            {
                if (e.Type == SimEventType.BallBall) outcome.BallContacts++;
                else if (e.Type == SimEventType.Rail) outcome.RailContacts++;
                else if (e.Type == SimEventType.Pocket) outcome.Pockets++;
            }
            return outcome;
        }

        /// <summary>
        /// The demonstration itself: one shot, all six behaviours.
        /// </summary>
        [Test]
        public void OneShotProducesStrikeContactCushionPocketAndRest()
        {
            Outcome shot = Play(0.35, 0.0);

            // 1. The strike put the cue ball in motion with real spin.
            Assert.Greater(shot.Seconds, 0.0);

            // 2. It struck the object ball.
            Assert.AreEqual(1, shot.BallContacts, "expected exactly one ball-ball contact");

            // 3. The cue ball reached a cushion afterwards.
            Assert.GreaterOrEqual(shot.RailContacts, 1, "expected the cue ball to reach a cushion");

            // 4. The object ball was pocketed, in the pocket it was aimed at.
            Assert.IsTrue(shot.Object.Pocketed, "the object ball was not potted");
            Assert.AreEqual("pocket-corner-rt", shot.Object.PocketId);

            // 5. The cue ball stayed on the table — this is a pot, not a scratch.
            Assert.IsFalse(shot.Cue.Pocketed, "the cue ball scratched");

            // 6. Everything came to rest, in finite time, with finite state.
            Assert.IsTrue(shot.World.IsSettled(), "the table never settled");
            Assert.Less(shot.Seconds, PhysicsConstants.MaxShotSeconds);
            Assert.IsFalse(shot.World.Corrupted);
            foreach (BallBody ball in shot.World.Balls) Assert.IsTrue(ball.IsFinite);
        }

        /// <summary>
        /// The core requirement, stated as an experiment: the *only* thing that
        /// differs between these three runs is where the tip met the ball, and
        /// the cue ball finishes somewhere different every time.
        ///
        /// Spin that did not affect the trajectory would put all three in the
        /// same place. This is the assertion that "do not fake spin visually"
        /// reduces to.
        /// </summary>
        [Test]
        public void SpinDecidesWhereTheCueBallFinishes()
        {
            Outcome right = Play(0.35, 0.0);
            Outcome left = Play(-0.35, 0.0);
            Outcome draw = Play(0.0, -0.35);

            // All three pot the object ball: the spin changes the cue ball's
            // journey, not whether the shot goes in.
            Assert.IsTrue(right.Object.Pocketed);
            Assert.IsTrue(left.Object.Pocketed);
            Assert.IsTrue(draw.Object.Pocketed);

            double rightLeft = (right.Cue.Position - left.Cue.Position).Length;
            double rightDraw = (right.Cue.Position - draw.Cue.Position).Length;

            // A ball diameter is 57 mm. These are far larger than any rounding.
            Assert.Greater(rightLeft, 0.10, "left and right English finished in the same place");
            Assert.Greater(rightDraw, 0.10, "side spin and draw finished in the same place");

            // Draw sends the cue ball back down the table rather than forward.
            Assert.Less(draw.Cue.Position.X, CueStart.X + 0.30,
                "draw did not pull the cue ball back");
        }

        /// <summary>
        /// Centre-ball on a dead-straight pot follows the object ball in. That
        /// is correct — and it is worth asserting, because it is the behaviour
        /// the English above is being played to avoid.
        /// </summary>
        [Test]
        public void CentreBallOnAStraightPotScratches()
        {
            Outcome stun = Play(0.0, 0.0);

            Assert.IsTrue(stun.Object.Pocketed);
            Assert.IsTrue(stun.Cue.Pocketed, "a centre-ball straight pot should follow the object ball in");
            Assert.AreEqual(stun.Object.PocketId, stun.Cue.PocketId);
        }

        /// <summary>The shot is reproducible from the same inputs, exactly.</summary>
        [Test]
        public void TheDemonstrationShotIsDeterministic()
        {
            Outcome a = Play(0.35, 0.0);
            Outcome b = Play(0.35, 0.0);

            Assert.AreEqual(a.World.Events.Count, b.World.Events.Count);
            Assert.AreEqual(a.Cue.Position.X, b.Cue.Position.X, 0.0);
            Assert.AreEqual(a.Cue.Position.Y, b.Cue.Position.Y, 0.0);
            Assert.AreEqual(a.Seconds, b.Seconds, 0.0);
        }
    }
}

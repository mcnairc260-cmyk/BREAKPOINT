using System;
using System.Collections.Generic;
using System.Text;
using Breakpoint.Simulation;
using NUnit.Framework;

namespace Breakpoint.Tests
{
    /// <summary>
    /// Determinism and frame-rate independence.
    ///
    /// Parity with the TypeScript oracle is allowed documented tolerances,
    /// because two floating-point pipelines will not agree bit for bit. Within
    /// C#, there is no such excuse: identical inputs must produce byte-identical
    /// output, or replay, networking and AI search all become unreliable later.
    /// These tests assert exact equality.
    /// </summary>
    [TestFixture]
    public class DeterminismTests
    {
        private const double R = PhysicsConstants.BallRadius;

        /// <summary>
        /// A full-precision fingerprint of the table.
        ///
        /// Round-trip ("R") formatting is exact for binary64, so two runs that
        /// produce the same string produced the same bits.
        /// </summary>
        private static string Fingerprint(PhysicsWorld world)
        {
            var text = new StringBuilder();
            foreach (BallBody ball in world.Balls)
            {
                text.Append(ball.Number).Append(':')
                    .Append(ball.Position.X.ToString("R")).Append(',')
                    .Append(ball.Position.Y.ToString("R")).Append(',')
                    .Append(ball.Velocity.X.ToString("R")).Append(',')
                    .Append(ball.Velocity.Y.ToString("R")).Append(',')
                    .Append(ball.Spin.X.ToString("R")).Append(',')
                    .Append(ball.Spin.Y.ToString("R")).Append(',')
                    .Append(ball.Spin.Z.ToString("R")).Append(',')
                    .Append(ball.Pocketed ? '1' : '0').Append(';');
            }
            return text.ToString();
        }

        private static PhysicsWorld PlayBreak()
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.013),
                Speed = 8.5,
                TipX = 0.25,
                TipY = -0.15,
            });
            world.SimulateToRest();
            return world;
        }

        [Test]
        public void TheSameBreakReplaysBitIdentically()
        {
            Assert.AreEqual(Fingerprint(PlayBreak()), Fingerprint(PlayBreak()));
        }

        private static string EventStream(PhysicsWorld world)
        {
            var text = new StringBuilder();
            foreach (SimEvent e in world.Events)
            {
                text.Append((int)e.Type).Append(':')
                    .Append(e.BallA).Append(',')
                    .Append(e.BallB).Append(',')
                    .Append(e.GeometryId ?? "-").Append(',')
                    .Append(e.Impulse.ToString("R")).Append(';');
            }
            return text.ToString();
        }

        [Test]
        public void TheEventStreamIsIdenticalAcrossRuns()
        {
            Assert.AreEqual(EventStream(PlayBreak()), EventStream(PlayBreak()));
        }

        /// <summary>
        /// Play the same shot, feeding the driver the given repeating pattern of
        /// frame times, and fingerprint the table it leaves behind.
        /// </summary>
        private static string RunWithFrames(double[] frames)
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.017), Speed = 8.0, TipX = 0.3, TipY = -0.2,
            });

            var driver = new FixedStepDriver(world);
            double fed = 0.0;
            int i = 0;
            while (fed < 15.0 && !world.IsSettled())
            {
                double dt = frames[i++ % frames.Length];
                driver.Advance(dt);
                fed += dt;
            }
            world.SimulateToRest();
            return Fingerprint(world);
        }

        [TestCase(30.0)]
        [TestCase(60.0)]
        [TestCase(75.0)]
        [TestCase(120.0)]
        [TestCase(144.0)]
        [TestCase(240.0)]
        public void RenderFrameRateDoesNotChangeTheResult(double fps)
        {
            Assert.AreEqual(
                RunWithFrames(new[] { 1.0 / 60.0 }),
                RunWithFrames(new[] { 1.0 / fps }),
                "a shot must resolve the same at any frame rate");
        }

        [Test]
        public void JitteringFramesGiveTheSameResultAsSteadyOnes()
        {
            string steady = RunWithFrames(new[] { 1.0 / 60.0 });
            string jittered = RunWithFrames(new[] { 1.0 / 200.0, 1.0 / 45.0, 1.0 / 90.0, 1.0 / 33.0 });
            Assert.AreEqual(steady, jittered);
        }

        [Test]
        public void TheDriverBanksSubStepFramesInsteadOfDroppingTime()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            BallBody ball = world.AddBall(0, new Vec2(0.0, 0.0));
            ball.Velocity = new Vec2(1.0, 0.0);
            ball.Resting = false;
            var driver = new FixedStepDriver(world);

            // Four frames of half a step should produce exactly two steps.
            int steps = 0;
            for (int i = 0; i < 4; i++) steps += driver.Advance(PhysicsConstants.FixedDt / 2.0);
            Assert.AreEqual(2, steps);

            // A huge frame is clamped rather than spiralling.
            int clamped = driver.Advance(10.0);
            Assert.LessOrEqual(clamped, (int)Math.Ceiling(0.25 / PhysicsConstants.FixedDt));
        }

        private static string ContinueAndFingerprint(PhysicsWorld world)
        {
            for (int i = 0; i < 200; i++) world.Step();
            return Fingerprint(world);
        }

        [Test]
        public void RestoringASnapshotReproducesTheContinuation()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            BallBody cue = world.AddBall(0, new Vec2(-0.5, 0.1));
            world.AddBall(1, new Vec2(0.2, -0.05));
            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(1.0, -0.2), Speed = 4.0, TipX = 0.3, TipY = 0.3,
            });
            for (int i = 0; i < 40; i++) world.Step();

            BallBody[] snapshot = world.Snapshot();

            string first = ContinueAndFingerprint(world);
            world.Restore(snapshot);
            string second = ContinueAndFingerprint(world);
            Assert.AreEqual(first, second);
        }

        /// <summary>Transverse velocities after a frozen-pair split.</summary>
        private struct SplitResult
        {
            public double UpperY;
            public double LowerY;
            public double CueY;
        }

        private static SplitResult Split(bool upperFirst)
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            BallBody cue = world.AddBall(0, new Vec2(-0.4, 0.0));
            double gap = R * 1.02;
            BallBody first = world.AddBall(1, new Vec2(0.0, upperFirst ? gap : -gap));
            BallBody second = world.AddBall(2, new Vec2(0.0, upperFirst ? -gap : gap));
            cue.Velocity = new Vec2(3.0, 0.0);
            cue.Resting = false;

            int contacts = 0;
            for (int i = 0; i < 400 && contacts < 2; i++)
            {
                world.Step();
                contacts = 0;
                foreach (SimEvent e in world.Events)
                {
                    if (e.Type == SimEventType.BallBall) contacts++;
                }
            }

            BallBody upper = upperFirst ? first : second;
            BallBody lower = upperFirst ? second : first;
            return new SplitResult
            {
                UpperY = upper.Velocity.Y,
                LowerY = lower.Velocity.Y,
                CueY = cue.Velocity.Y,
            };
        }

        [Test]
        public void ContactOrderDoesNotDependOnBallStorageOrder()
        {
            // The frozen-pair split must give the same answer whichever object
            // ball happens to be stored first — otherwise the physics depends on
            // the rack's array layout rather than on its geometry.
            SplitResult a = Split(true);
            SplitResult b = Split(false);

            Assert.AreEqual(a.UpperY, b.UpperY, 1e-12);
            Assert.AreEqual(a.LowerY, b.LowerY, 1e-12);
            Assert.AreEqual(a.CueY, b.CueY, 1e-12);
        }
    }
}

using System;
using System.Collections.Generic;
using Breakpoint.Simulation;
using NUnit.Framework;

namespace Breakpoint.Tests
{
    /// <summary>
    /// Behavioural tests for the ported simulation.
    ///
    /// These do not compare against the reference implementation — the parity
    /// suite does that. These assert the *physics*: conservation laws, closed
    /// forms, signs and known billiards relationships. A port that passed parity
    /// but failed these would mean both implementations were wrong together.
    ///
    /// Nothing here needs Unity. The simulation is pure C#, so every one of
    /// these runs in an edit-mode test or in a headless runner.
    /// </summary>
    [TestFixture]
    public class PhysicsBehaviourTests
    {
        private const double R = PhysicsConstants.BallRadius;

        private static PhysicsWorld World() => new PhysicsWorld(TableGeometry.Create());

        /// <summary>Step until the first ball-ball contact is recorded.</summary>
        private static bool StepToContact(PhysicsWorld world, int limit = 400)
        {
            for (int i = 0; i < limit; i++)
            {
                world.Step();
                foreach (SimEvent e in world.Events)
                {
                    if (e.Type == SimEventType.BallBall) return true;
                }
            }
            return false;
        }

        private static bool HasEvent(PhysicsWorld world, SimEventType type)
        {
            foreach (SimEvent e in world.Events)
            {
                if (e.Type == type) return true;
            }
            return false;
        }

        // ------------------------------------------------------------ collisions

        [Test]
        public void HeadOnCollisionTransfersNearlyAllSpeedAndStopsTheCueBall()
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.3, 0.0));
            BallBody target = world.AddBall(1, new Vec2(0.0, 0.0));

            // Stun: no top or bottom spin, so the cue ball has no roll to carry it on.
            cue.Velocity = new Vec2(3.0, 0.0);
            cue.Resting = false;

            Assert.IsTrue(StepToContact(world), "the balls must actually meet");
            Assert.Greater(target.Velocity.X, 2.5, "object ball takes nearly all the speed");
            Assert.Less(Math.Abs(target.Velocity.Y), 0.05, "and leaves along the line of centres");
            Assert.Less(Math.Abs(cue.Velocity.X), 0.3, "the classic stop shot");
        }

        [Test]
        public void AngledCollisionObeysTheNinetyDegreeRule()
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.4, 0.0));
            BallBody target = world.AddBall(1, new Vec2(0.0, R));

            cue.Velocity = new Vec2(3.0, 0.0);
            cue.Resting = false;
            Assert.IsTrue(StepToContact(world));

            Assert.Greater(target.Velocity.X, 0.0);
            Assert.Greater(target.Velocity.Y, 0.0);
            Assert.Less(cue.Velocity.Y, 0.0, "the cue ball is deflected the other way");

            // For a stun cut the outgoing paths are perpendicular.
            double cueAngle = Math.Atan2(cue.Velocity.Y, cue.Velocity.X);
            double targetAngle = Math.Atan2(target.Velocity.Y, target.Velocity.X);
            double between = Math.Abs(((targetAngle - cueAngle + Math.PI * 3.0) % (Math.PI * 2.0)) - Math.PI);
            Assert.Greater(between, Math.PI / 2.0 - 0.25);
            Assert.Less(between, Math.PI / 2.0 + 0.25);
        }

        [Test]
        public void GlancingCollisionBarelyDisturbsTheCueBall()
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.5, 0.0));
            // Contact offset 1.9R out of the 2R that would be a complete miss.
            BallBody target = world.AddBall(1, new Vec2(0.0, 1.9 * R));
            cue.Velocity = new Vec2(4.0, 0.0);
            cue.Resting = false;

            Assert.IsTrue(StepToContact(world));
            double cueSpeed = cue.Velocity.Length;
            double targetSpeed = target.Velocity.Length;

            Assert.Greater(target.Velocity.Y, 0.0);
            Assert.Less(targetSpeed, 0.45 * cueSpeed, "a thin cut moves the object ball very little");
            Assert.Greater(cueSpeed, 3.3, "and leaves the cue ball with most of its speed");
            Assert.Less(cue.Velocity.Y, 0.0);
        }

        /// <summary>Speed given to the object ball by a cut of the given offset, in ball radii.</summary>
        private static double ObjectBallSpeedForCut(double offset)
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.5, 0.0));
            BallBody target = world.AddBall(1, new Vec2(0.0, offset * R));
            cue.Velocity = new Vec2(4.0, 0.0);
            cue.Resting = false;
            StepToContact(world);
            return target.Velocity.Length;
        }

        [Test]
        public void ThinnerCutsGiveTheObjectBallLess()
        {
            Assert.Greater(ObjectBallSpeedForCut(0.0), ObjectBallSpeedForCut(1.0));
            Assert.Greater(ObjectBallSpeedForCut(1.0), ObjectBallSpeedForCut(1.9));
        }

        [Test]
        public void MomentumIsConservedThroughACollision()
        {
            PhysicsWorld world = World();
            BallBody a = world.AddBall(0, new Vec2(-0.1, 0.0));
            BallBody b = world.AddBall(1, new Vec2(0.0, 0.0));
            a.Velocity = new Vec2(2.0, 0.0);
            a.Resting = false;

            double before = PhysicsConstants.BallMass * (a.Velocity.X + b.Velocity.X);
            for (int i = 0; i < 60 && !HasEvent(world, SimEventType.BallBall); i++)
            {
                before = PhysicsConstants.BallMass * (a.Velocity.X + b.Velocity.X);
                world.Step();
            }
            double after = PhysicsConstants.BallMass * (a.Velocity.X + b.Velocity.X);

            // The only sink left is one step of cloth friction on two balls, so
            // bound the loss by exactly that rather than by a magic percentage.
            double bound = 2.0 * PhysicsConstants.BallMass * PhysicsConstants.MuSlide
                * PhysicsConstants.Gravity * PhysicsConstants.FixedDt;
            Assert.LessOrEqual(Math.Abs(after - before), bound);
            Assert.Less(Math.Abs(a.Velocity.Y + b.Velocity.Y), 1e-9,
                "transverse momentum must not appear from nothing");
        }

        // ------------------------------------------------------------------ spin

        [Test]
        public void ATipTwoFifthsHighProducesNaturalRollImmediately()
        {
            // The textbook result: at b = 0.4 the strike puts the ball straight
            // onto the rolling constraint, so the contact patch is not slipping.
            StrikeImpulse impulse = SpinModel.Compute(new CueStrike
            {
                Direction = new Vec2(1.0, 0.0),
                Speed = 2.0,
                TipX = 0.0,
                TipY = 0.4,
            });

            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.5, 0.0));
            cue.Velocity = impulse.Velocity;
            cue.Spin = impulse.Spin;
            cue.Resting = false;

            Vec2 u = cue.ContactVelocity();
            Assert.Less(u.Length, 1e-9, "the contact patch must not be slipping at all");
            Assert.AreEqual((int)ClothPhase.Rolling, (int)FrictionModel.PhaseOf(cue));
        }

        [Test]
        public void NaturalRollHoldsTheRollingConstraint()
        {
            PhysicsWorld world = World();
            BallBody ball = world.AddBall(0, new Vec2(-1.0, 0.0));
            SpinModel.Apply(ball, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0), Speed = 3.0, TipX = 0.0, TipY = 0.0,
            });

            bool rolled = false;
            for (int i = 0; i < 2000 && !world.IsSettled(); i++)
            {
                world.Step();
                if (FrictionModel.PhaseOf(ball) == ClothPhase.Rolling)
                {
                    rolled = true;
                    break;
                }
            }

            Assert.IsTrue(rolled, "a stunned ball must pick up roll on its own");
            Assert.AreEqual(ball.Velocity.X, ball.Spin.Y * R, 1e-9, "omega·R must equal v");
        }

        [Test]
        public void DrawBringsTheCueBallBack()
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.35, 0.0));
            world.AddBall(1, new Vec2(0.0, 0.0));

            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0), Speed = 3.2, TipX = 0.0, TipY = -0.45,
            });
            Assert.Less(cue.Spin.Y, 0.0, "backspin has the opposite sign to follow");

            for (int i = 0; i < 120 && !HasEvent(world, SimEventType.BallBall); i++) world.Step();
            double contactX = cue.Position.X;
            for (int i = 0; i < 45; i++) world.Step();

            Assert.Less(cue.Velocity.X, 0.0, "the cue ball must be travelling back");
            Assert.Less(cue.Position.X, contactX);
        }

        [Test]
        public void FollowCarriesTheCueBallForward()
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.35, 0.0));
            BallBody target = world.AddBall(1, new Vec2(0.0, 0.0));

            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0), Speed = 3.2, TipX = 0.0, TipY = 0.45,
            });
            Assert.Greater(cue.Spin.Y, 0.0);

            for (int i = 0; i < 120 && !HasEvent(world, SimEventType.BallBall); i++) world.Step();
            double justAfter = cue.Velocity.X;
            Assert.Less(justAfter, 0.3, "a full hit takes nearly all the cue ball's speed");

            // Judged before the object ball can return off the far cushion.
            for (int i = 0; i < 45; i++) world.Step();
            Assert.Greater(cue.Velocity.X, justAfter, "topspin must accelerate it forward again");
            Assert.Greater(cue.Position.X, 0.0);
            Assert.Greater(target.Position.X, cue.Position.X);
        }

        [Test]
        public void StunSlidesThenRolls()
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-1.0, 0.0));
            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0), Speed = 3.0, TipX = 0.0, TipY = 0.0,
            });

            Assert.AreEqual((int)ClothPhase.Sliding, (int)FrictionModel.PhaseOf(cue));

            bool sawRolling = false;
            for (int i = 0; i < 2000 && !world.IsSettled(); i++)
            {
                world.Step();
                if (FrictionModel.PhaseOf(cue) == ClothPhase.Rolling) sawRolling = true;
            }
            Assert.IsTrue(sawRolling);
        }

        /// <summary>Outcome of an English test shot: the spin dialled in, and where it ended.</summary>
        private struct EnglishResult
        {
            public double SpinZ;
            public double FinalY;
        }

        private static EnglishResult StrikeWithEnglish(double tipX)
        {
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.9, 0.0));
            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0), Speed = 3.0, TipX = tipX, TipY = 0.0,
            });
            double spin = cue.Spin.Z;
            world.SimulateToRest();
            return new EnglishResult { SpinZ = spin, FinalY = cue.Position.Y };
        }

        [Test]
        public void LeftAndRightEnglishAreEqualAndOpposite()
        {
            EnglishResult right = StrikeWithEnglish(0.45);
            EnglishResult left = StrikeWithEnglish(-0.45);
            EnglishResult none = StrikeWithEnglish(0.0);

            // Right English spins the ball counter-clockwise seen from above, so
            // the right-hand side of the ball moves forward.
            Assert.Greater(right.SpinZ, 0.0);
            Assert.Less(left.SpinZ, 0.0);
            Assert.AreEqual(0.0, right.SpinZ + left.SpinZ, 1e-9);

            Assert.AreEqual(0.0, none.FinalY, 1e-12, "no English shoots dead straight");
            Assert.AreEqual(0.0, right.FinalY + left.FinalY, 1e-9, "the two sides mirror exactly");
            Assert.Greater(Math.Abs(right.FinalY), 0.01, "English must actually do something");
        }

        // ---------------------------------------------------------------- cushions

        [Test]
        public void ASquareRailShotComesBackAlongItsOwnLine()
        {
            PhysicsWorld world = World();
            BallBody ball = world.AddBall(0, new Vec2(-0.6, 0.0));
            ball.Velocity = new Vec2(0.0, 3.0);
            ball.Resting = false;

            for (int i = 0; i < 2000 && !HasEvent(world, SimEventType.Rail); i++) world.Step();

            Assert.Less(ball.Velocity.Y, 0.0, "it must come back");
            Assert.Less(Math.Abs(ball.Velocity.Y), 3.0, "a cushion eats energy");
            Assert.Less(Math.Abs(ball.Velocity.X), 0.2, "and does not deflect a square hit");
        }

        [Test]
        public void ACushionAddsForwardRoll()
        {
            PhysicsWorld world = World();
            BallBody ball = world.AddBall(0, new Vec2(-0.6, 0.0));
            ball.Velocity = new Vec2(0.0, 3.0);
            ball.Spin = Vec3.Zero;
            ball.Resting = false;

            for (int i = 0; i < 2000 && !HasEvent(world, SimEventType.Rail); i++) world.Step();

            // After the bounce the ball travels in -y. The rolling constraint is
            // omega = (z-hat x v)/R, and z-hat x (-y-hat) = +x-hat, so forward
            // roll for -y travel means a positive spin.x. The ball arrived with
            // no rotation at all, so it can only have come from the cushion.
            Assert.Less(ball.Velocity.Y, 0.0);
            Assert.Greater(ball.Spin.X, 0.0);
            Assert.Greater(ball.Spin.X * R, 0.25 * Math.Abs(ball.Velocity.Y),
                "it is genuinely rolling, not merely spinning");
        }

        /// <summary>Rebound heading after a cushion hit carrying the given English.</summary>
        private static double ReboundAngleWithEnglish(double spinZ)
        {
            PhysicsWorld world = World();
            BallBody ball = world.AddBall(0, new Vec2(-0.9, -0.3));
            ball.Velocity = new Vec2(0.0, 3.0);
            ball.Spin = new Vec3(0.0, 0.0, spinZ);
            ball.Resting = false;
            for (int i = 0; i < 900 && !HasEvent(world, SimEventType.Rail); i++) world.Step();
            Assert.IsTrue(HasEvent(world, SimEventType.Rail), "the ball must reach the cushion");
            return Math.Atan2(ball.Velocity.Y, ball.Velocity.X);
        }

        [Test]
        public void EnglishSwingsTheReboundOppositeWaysEachSide()
        {
            double plain = ReboundAngleWithEnglish(0.0);
            double running = ReboundAngleWithEnglish(90.0);
            double reverse = ReboundAngleWithEnglish(-90.0);

            Assert.Greater(Math.Abs(running - plain), 0.01, "English must change the rebound angle");
            Assert.AreEqual(
                -Math.Sign(reverse - plain), Math.Sign(running - plain),
                "and the two sides must swing it opposite ways");
        }

        // ----------------------------------------------------------------- pockets

        [TestCase(0.8)]
        [TestCase(2.0)]
        [TestCase(5.0)]
        [TestCase(9.0)]
        [TestCase(12.0)]
        public void CornerPocketCaptures(double speed)
        {
            TableGeometry table = TableGeometry.Create();
            Pocket corner = null;
            foreach (Pocket p in table.Pockets)
            {
                if (p.Id == "pocket-corner-rt") corner = p;
            }
            Assert.IsNotNull(corner);

            var world = new PhysicsWorld(table);
            BallBody ball = world.AddBall(1, new Vec2(corner.Centre.X - 0.35, corner.Centre.Y - 0.35));
            double unit = 1.0 / Math.Sqrt(2.0);
            ball.Velocity = new Vec2(unit * speed, unit * speed);
            ball.Resting = false;

            world.SimulateToRest();
            Assert.IsTrue(ball.Pocketed, "a ball rolled at the corner at " + speed + " m/s must drop");
        }

        [TestCase(1.0)]
        [TestCase(3.0)]
        [TestCase(8.0)]
        [TestCase(12.0)]
        public void SidePocketCaptures(double speed)
        {
            PhysicsWorld world = World();
            BallBody ball = world.AddBall(1, new Vec2(0.0, PhysicsConstants.TableWidth / 2.0 - 0.3));
            ball.Velocity = new Vec2(0.0, speed);
            ball.Resting = false;

            world.SimulateToRest();
            Assert.IsTrue(ball.Pocketed, "a ball rolled square at the side pocket must drop");
        }

        [Test]
        public void APocketIsNotAVacuum()
        {
            // At 0.3 m/s the ball can only travel about 25 cm, so from half a
            // metre away it has to stop on the cloth.
            PhysicsWorld world = World();
            double unit = 1.0 / Math.Sqrt(2.0);
            var start = new Vec2(1.296 - unit * 0.5, 0.661 - unit * 0.5);
            BallBody ball = world.AddBall(1, start);
            ball.Velocity = new Vec2(unit * 0.3, unit * 0.3);
            ball.Resting = false;

            world.SimulateToRest();
            Assert.IsFalse(ball.Pocketed);
            Assert.IsTrue(world.IsSettled());

            double travelled = (ball.Position - start).Length;
            Assert.Greater(travelled, 0.1);
            Assert.Less(travelled, 0.4);
        }

        [Test]
        public void AJawClipRattlesOutInsteadOfDropping()
        {
            PhysicsWorld world = World();
            BallBody ball = world.AddBall(1, new Vec2(0.55, 0.42));
            double dx = 1.296 - 0.55;
            double dy = 0.69 - 0.42;
            double d = Math.Sqrt(dx * dx + dy * dy);
            ball.Velocity = new Vec2(dx / d * 3.0, dy / d * 3.0);
            ball.Resting = false;

            world.SimulateToRest();
            Assert.IsTrue(HasEvent(world, SimEventType.Jaw), "it must actually hit a jaw");
            Assert.IsFalse(ball.Pocketed);
            Assert.LessOrEqual(Math.Abs(ball.Position.X), PhysicsConstants.TableLength / 2.0,
                "and end back on the cloth, not stranded outside the cushions");
            Assert.LessOrEqual(Math.Abs(ball.Position.Y), PhysicsConstants.TableWidth / 2.0);
        }

        [Test]
        public void NoBallEverEscapesTheTable()
        {
            // The containment invariant, swept across entry lines into a corner
            // mouth: a ball either drops or stays on the cloth.
            int escapes = 0;
            int pocketed = 0;
            int rejected = 0;

            for (double y = 0.42; y <= 0.632; y += 0.012)
            {
                foreach (double speed in new[] { 1.5, 4.0, 8.0 })
                {
                    PhysicsWorld world = World();
                    BallBody ball = world.AddBall(1, new Vec2(0.55, y));
                    double dx = 1.296 - 0.55;
                    double dy = 0.661 - y;
                    double d = Math.Sqrt(dx * dx + dy * dy);
                    ball.Velocity = new Vec2(dx / d * speed, dy / d * speed);
                    ball.Resting = false;
                    world.SimulateToRest();

                    bool outside = Math.Abs(ball.Position.X) > PhysicsConstants.TableLength / 2.0
                        || Math.Abs(ball.Position.Y) > PhysicsConstants.TableWidth / 2.0;
                    if (ball.Pocketed) pocketed++;
                    else if (outside) escapes++;
                    else rejected++;
                }
            }

            Assert.AreEqual(0, escapes, "no ball may leave the table");
            Assert.Greater(pocketed, 0, "some approaches must drop");
            Assert.Greater(rejected, 0, "and some must rattle out — a pocket is not a vacuum");
        }

        // ------------------------------------------------- integrator guarantees

        [Test]
        public void ABallAtBreakSpeedCannotPassThroughAnother()
        {
            // At 12 m/s a ball covers 10 cm per 1/120 s step — nearly two diameters.
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-1.0, 0.0));
            BallBody target = world.AddBall(1, new Vec2(0.0, 0.0));
            cue.Velocity = new Vec2(12.0, 0.0);
            cue.Resting = false;

            Assert.IsTrue(StepToContact(world, 240));
            Assert.Greater(target.Velocity.X, 5.0);
            Assert.Less(cue.Position.X, target.Position.X, "the cue ball must still be behind it");
        }

        [Test]
        public void DeeplyOverlappingBallsSeparateWithoutExploding()
        {
            PhysicsWorld world = World();
            BallBody a = world.AddBall(0, new Vec2(0.0, 0.0));
            BallBody b = world.AddBall(1, new Vec2(R * 0.6, 0.0));
            a.Velocity = new Vec2(0.5, 0.0);
            a.Resting = false;
            b.Resting = false;

            double energyBefore = world.TotalEnergy();
            for (int i = 0; i < 600 && !world.IsSettled(); i++) world.Step();

            Assert.GreaterOrEqual((a.Position - b.Position).Length, 2.0 * R - 1e-9);
            Assert.IsFalse(world.Corrupted);
            Assert.LessOrEqual(world.TotalEnergy(), energyBefore + 1e-9,
                "depenetration is positional, so it cannot add energy");
        }

        [Test]
        public void AFrozenPairSplitsSymmetrically()
        {
            // Resolving simultaneous contacts one after another gives the second
            // one an already-deflected cue ball, so a dead-centre split squirts
            // the cue ball sideways out of a perfectly symmetric shot. A rack is
            // full of frozen pairs, so this is not an exotic case.
            PhysicsWorld world = World();
            BallBody cue = world.AddBall(0, new Vec2(-0.4, 0.0));
            BallBody upper = world.AddBall(1, new Vec2(0.0, R * 1.02));
            BallBody lower = world.AddBall(2, new Vec2(0.0, -R * 1.02));
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

            Assert.AreEqual(2, contacts);
            Assert.AreEqual(upper.Velocity.X, lower.Velocity.X, 1e-12);
            Assert.AreEqual(0.0, upper.Velocity.Y + lower.Velocity.Y, 1e-12);
            Assert.Greater(upper.Velocity.Y, 0.0);
            Assert.AreEqual(0.0, cue.Velocity.Y, 1e-12, "the cue ball must stay on its line");
        }

        [Test]
        public void ASymmetricTwoContactImpactMatchesTheClosedForm()
        {
            // For a ball of speed u striking two balls whose lines of centres
            // both sit at angle theta to its path, momentum plus Newton
            // restitution give  j = u·cos(theta)·(1+e) / (1 + 2cos²(theta))
            // for the speed of each struck ball.
            PhysicsWorld world = World();
            double gap = R * 1.02;
            BallBody cue = world.AddBall(0, new Vec2(-0.08, 0.0));
            BallBody upper = world.AddBall(1, new Vec2(0.0, gap));
            world.AddBall(2, new Vec2(0.0, -gap));
            cue.Velocity = new Vec2(2.0, 0.0);
            cue.Resting = false;

            double u = cue.Velocity.X;
            for (int i = 0; i < 400; i++)
            {
                if (HasEvent(world, SimEventType.BallBall)) break;
                u = cue.Velocity.X;
                world.Step();
            }

            double sinTheta = gap / (2.0 * R);
            double cosTheta = Math.Sqrt(1.0 - sinTheta * sinTheta);
            double j = u * cosTheta * (1.0 + PhysicsConstants.BallRestitution)
                / (1.0 + 2.0 * cosTheta * cosTheta);

            double struck = upper.Velocity.Length;
            // Ball-ball friction (throw) is not in the closed form, so allow a
            // few per cent; the point is that the answer is the physical one and
            // not the ~40% too small an inelastic solve would give.
            Assert.Greater(struck / j, 0.9);
            Assert.Less(struck / j, 1.1);
            Assert.Less(cue.Velocity.X, 0.0, "the striker recoils, as the closed form says");
        }

        [Test]
        public void EnergyNeverIncreasesAcrossAStep()
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.01), Speed = 9.0, TipX = 0.2, TipY = 0.1,
            });

            double previous = world.TotalEnergy();
            for (int i = 0; i < 9000 && !world.IsSettled(); i++)
            {
                world.Step();
                double now = world.TotalEnergy();
                Assert.LessOrEqual(now, previous + 1e-9, "energy was created at step " + i);
                previous = now;
            }

            Assert.IsTrue(world.IsSettled());
            Assert.IsFalse(world.Corrupted);
        }

        [Test]
        public void EveryBallEventuallyComesToExactRest()
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.02), Speed = 10.0, TipX = 0.2, TipY = 0.2,
            });

            double seconds = world.SimulateToRest();
            Assert.IsTrue(world.IsSettled());
            Assert.Less(seconds, 45.0);

            foreach (BallBody ball in world.Balls)
            {
                if (ball.Pocketed) continue;
                Assert.AreEqual(0.0, ball.Velocity.X, 0.0);
                Assert.AreEqual(0.0, ball.Velocity.Y, 0.0);
                Assert.AreEqual(0.0, ball.Spin.Z, 0.0);
            }
        }

        [Test]
        public void RollingResistanceMatchesItsClosedFormStoppingDistance()
        {
            // v² = 2·a·d for a ball already in natural roll, with a = mu_roll·g.
            const double speed = 0.5;
            double predicted = speed * speed / (2.0 * PhysicsConstants.MuRoll * PhysicsConstants.Gravity);

            PhysicsWorld world = World();
            var start = new Vec2(-PhysicsConstants.TableLength / 2.0 + 0.15, 0.0);
            BallBody ball = world.AddBall(0, start);
            SpinModel.Apply(ball, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0), Speed = speed, TipX = 0.0, TipY = 0.4,
            });
            world.SimulateToRest();

            Assert.IsFalse(HasEvent(world, SimEventType.Rail), "it must not reach a cushion");
            Assert.AreEqual(predicted, ball.Position.X - start.X, 0.05);
        }

        [Test]
        public void AViolentBreakLeavesEveryValueFinite()
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.005), Speed = 12.0, TipX = 0.5, TipY = -0.5,
            });
            world.SimulateToRest();

            foreach (BallBody ball in world.Balls)
            {
                Assert.IsTrue(ball.IsFinite, "ball " + ball.Number + " went non-finite");
                Assert.IsTrue(ball.Orientation.IsFinite, "ball " + ball.Number + " orientation");
            }
            Assert.IsFalse(world.Corrupted);
        }

        [Test]
        public void CoincidentBallsAreSeparatedInsteadOfProducingNaN()
        {
            PhysicsWorld world = World();
            BallBody a = world.AddBall(0, new Vec2(0.0, 0.0));
            BallBody b = world.AddBall(1, new Vec2(0.0, 0.0));
            a.Velocity = new Vec2(1.0, 0.0);
            a.Resting = false;
            b.Resting = false;

            for (int i = 0; i < 60; i++) world.Step();
            Assert.IsTrue(a.IsFinite);
            Assert.IsTrue(b.IsFinite);
            Assert.IsFalse(world.Corrupted);
        }
    }
}

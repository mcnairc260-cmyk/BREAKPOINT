using System.Collections.Generic;
using Breakpoint.Simulation;
using NUnit.Framework;

namespace Breakpoint.Tests
{
    /// <summary>
    /// The shot record.
    ///
    /// No rules are implemented — that is Phase 2. What is asserted here is that
    /// the record carries enough, and carries it correctly, for a rules engine
    /// to be written against it later without changing the simulation.
    /// </summary>
    [TestFixture]
    public class ShotRecordTests
    {
        private static PhysicsWorld PlayBreak(out ShotSummary.Result summary)
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.01), Speed = 9.0, TipX = 0.2, TipY = -0.1,
            });
            world.SimulateToRest();
            summary = ShotSummary.Summarise(world.Events, world.CueBall.Id, world.Balls);
            return world;
        }

        [Test]
        public void ARecordCarriesTheWholeContactGraph()
        {
            PlayBreak(out ShotSummary.Result summary);

            Assert.Greater(summary.BallContacts.Length, 1, "a break makes many contacts");
            foreach (BallContact contact in summary.BallContacts)
            {
                Assert.GreaterOrEqual(contact.A, 0);
                Assert.GreaterOrEqual(contact.B, 0);
                Assert.Greater(contact.Impulse, 0.0);
            }

            // The cue ball is in the very first contact, and it is not "after" itself.
            BallContact first = summary.BallContacts[0];
            Assert.IsTrue(first.A == 0 || first.B == 0, "the cue ball makes the first contact");
            Assert.IsFalse(first.AfterFirstContact);
        }

        [Test]
        public void CushionContactsAreAttributedAndFlagged()
        {
            PlayBreak(out ShotSummary.Result summary);

            Assert.Greater(summary.RailContacts.Length, 0);
            foreach (RailContact contact in summary.RailContacts)
            {
                Assert.IsNotNull(contact.Id);
                Assert.GreaterOrEqual(contact.Ball, 0);
                Assert.Greater(contact.Impulse, 0.0);
            }

            // A break drives balls into the cushions, so some contact must follow
            // the first contact — exactly the question a legal-shot rule asks.
            bool anyAfter = false;
            foreach (RailContact contact in summary.RailContacts)
            {
                if (contact.AfterFirstContact) anyAfter = true;
            }
            Assert.IsTrue(anyAfter);
        }

        [Test]
        public void JawContactsAreKeptSeparateFromCushions()
        {
            // A jaw is part of the pocket casting, not a cushion, so it must
            // never be counted as a ball-to-rail contact by a rules engine.
            PhysicsWorld world = PlayBreak(out ShotSummary.Result summary);

            var railIds = new HashSet<string>();
            foreach (RailSegment rail in world.Table.Rails) railIds.Add(rail.Id);
            var jawIds = new HashSet<string>();
            foreach (Jaw jaw in world.Table.Jaws) jawIds.Add(jaw.Id);

            foreach (RailContact contact in summary.RailContacts)
            {
                Assert.IsTrue(railIds.Contains(contact.Id), contact.Id + " should be a rail");
            }
            foreach (RailContact contact in summary.JawContacts)
            {
                Assert.IsTrue(jawIds.Contains(contact.Id), contact.Id + " should be a jaw");
            }
        }

        [Test]
        public void TheFirstContactIsTheCueBallsAndIsIndexed()
        {
            PhysicsWorld world = PlayBreak(out ShotSummary.Result summary);

            Assert.GreaterOrEqual(summary.FirstObjectBallContact, 1, "an object ball, not the cue ball");
            Assert.GreaterOrEqual(summary.FirstContactEventIndex, 0);

            SimEvent first = world.Events[summary.FirstContactEventIndex];
            Assert.AreEqual((int)SimEventType.BallBall, (int)first.Type);
            Assert.IsTrue(first.BallA == world.CueBall.Id || first.BallB == world.CueBall.Id);

            // Nothing before it is a ball-ball contact.
            for (int i = 0; i < summary.FirstContactEventIndex; i++)
            {
                Assert.IsFalse(world.Events[i].Type == SimEventType.BallBall);
            }
        }

        [Test]
        public void ASquareBreakContactsTheApexBallFirst()
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0), Speed = 10.0, TipX = 0.0, TipY = 0.0,
            });
            world.SimulateToRest();

            ShotSummary.Result summary =
                ShotSummary.Summarise(world.Events, world.CueBall.Id, world.Balls);
            Assert.AreEqual(1, summary.FirstObjectBallContact, "the apex of the rack is the 1");
        }

        [Test]
        public void PocketedBallsAndPocketsAreRecordedInStep()
        {
            PlayBreak(out ShotSummary.Result summary);
            Assert.AreEqual(summary.BallsPocketed.Length, summary.PocketsUsed.Length);
        }

        [Test]
        public void AScratchIsFlagged()
        {
            // Drive the cue ball straight into a corner pocket, past the rack.
            PhysicsWorld world = Rack.CreateRackedWorld();
            BallBody cue = world.CueBall;
            Pocket corner = null;
            foreach (Pocket p in world.Table.Pockets)
            {
                if (p.Id == "pocket-corner-lb") corner = p;
            }
            Assert.IsNotNull(corner);

            double dx = corner.Centre.X - cue.Position.X;
            double dy = corner.Centre.Y - cue.Position.Y;
            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(dx, dy), Speed = 3.0, TipX = 0.0, TipY = 0.0,
            });
            world.SimulateToRest();

            ShotSummary.Result summary =
                ShotSummary.Summarise(world.Events, cue.Id, world.Balls);
            Assert.IsTrue(summary.Scratch, "pocketing the cue ball must set the scratch flag");
            Assert.IsTrue(cue.Pocketed);
        }

        [Test]
        public void ARecordReplaysToTheSameTable()
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            var preShot = new List<BallSnapshot>();
            foreach (BallBody ball in world.Balls) preShot.Add(BallSnapshot.From(ball));

            var strike = new CueStrike
            {
                Direction = new Vec2(System.Math.Cos(0.017), System.Math.Sin(0.017)),
                Speed = 8.5,
                TipX = -0.25,
                TipY = 0.3,
            };
            SpinModel.Apply(world.CueBall, strike);
            world.SimulateToRest();

            // Rebuild the pre-shot table from the record alone and re-run.
            var replay = new PhysicsWorld(TableGeometry.Create());
            foreach (BallSnapshot snapshot in preShot) replay.AddBall(snapshot.Number, snapshot.Position);
            SpinModel.Apply(replay.CueBall, strike);
            replay.SimulateToRest();

            for (int i = 0; i < world.Balls.Count; i++)
            {
                BallBody expected = world.Balls[i];
                BallBody actual = replay.Balls[i];
                Assert.AreEqual(expected.Pocketed, actual.Pocketed, "ball " + expected.Number + " pocketed");
                if (expected.Pocketed) continue;
                Assert.AreEqual(expected.Position.X, actual.Position.X, 1e-12);
                Assert.AreEqual(expected.Position.Y, actual.Position.Y, 1e-12);
            }
        }

        [Test]
        public void ShotInputIsPlainDataWithNoEngineTypes()
        {
            // A compile-time guarantee as much as a runtime one: if ShotInput
            // ever grew a UnityEngine field this file would stop compiling in
            // the standalone runner, which has no Unity at all.
            var input = new ShotInput
            {
                AimAngle = 0.4,
                Power = 0.75,
                TipX = 0.2,
                TipY = -0.3,
                CueBallPosition = new Vec2(-0.6, 0.1),
            };

            Assert.AreEqual(0.4, input.AimAngle, 0.0);
            Assert.AreEqual(0.75, input.Power, 0.0);
            Assert.AreEqual(-0.6, input.CueBallPosition.X, 0.0);
        }
    }
}

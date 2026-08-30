using System;
using Breakpoint.Simulation;
using NUnit.Framework;

namespace Breakpoint.Tests
{
    /// <summary>
    /// Tests for the two pieces of maths that presentation depends on but that
    /// must not be allowed to drift: the physics→render frame conversion, and
    /// the aiming ray.
    ///
    /// Both live in the engine-free simulation assembly precisely so they can be
    /// exercised here, without Unity. The frame conversion in particular is the
    /// kind of thing that is easy to get sign-flipped and hard to notice by
    /// eye — a mirrored spin still *looks* like spin — so it is asserted
    /// against the observable behaviour of a ball, not against itself.
    /// </summary>
    [TestFixture]
    public class PresentationMathTests
    {
        private const double R = PhysicsConstants.BallRadius;

        /// <summary>Rotate a render-frame vector by a render-frame quaternion.</summary>
        private static Vec3 Rotate(Quat q, Vec3 v)
        {
            var u = new Vec3(q.X, q.Y, q.Z);
            Vec3 t = Vec3.Cross(u, v);
            Vec3 tt = Vec3.Cross(u, t);
            return v + t * (2.0 * q.W) + tt * 2.0;
        }

        [Test]
        public void PlaneMapPutsLongAxisOnXAndShortAxisOnZ()
        {
            Vec3 p = RenderFrame.PlaneToRender(new Vec2(1.2, -0.4), R);
            Assert.AreEqual(1.2, p.X, 1e-15);
            Assert.AreEqual(R, p.Y, 1e-15);
            Assert.AreEqual(-0.4, p.Z, 1e-15);
        }

        [Test]
        public void RenderToPlaneInvertsPlaneToRender()
        {
            var original = new Vec2(-0.77, 0.31);
            Vec2 round = RenderFrame.RenderToPlane(RenderFrame.PlaneToRender(original, 0.9));
            Assert.AreEqual(original.X, round.X, 1e-15);
            Assert.AreEqual(original.Y, round.Y, 1e-15);
        }

        [Test]
        public void VectorMapIsItsOwnInverse()
        {
            var v = new Vec3(0.3, -1.1, 2.7);
            Vec3 round = RenderFrame.ToPhysics(RenderFrame.ToRender(v));
            Assert.AreEqual(v.X, round.X, 1e-15);
            Assert.AreEqual(v.Y, round.Y, 1e-15);
            Assert.AreEqual(v.Z, round.Z, 1e-15);
        }

        [Test]
        public void RenderQuaternionStaysUnit()
        {
            var q = new Quat(0.31, -0.52, 0.14, 0.78).Normalized();
            Quat r = RenderFrame.ToRender(q);
            double norm = Math.Sqrt(r.X * r.X + r.Y * r.Y + r.Z * r.Z + r.W * r.W);
            Assert.AreEqual(1.0, norm, 1e-12);
        }

        /// <summary>
        /// The one that matters. A ball rolling toward +x must, on screen, have
        /// the top of the ball moving toward +X — that is what "rolling
        /// forward" means. If the conversion mirrored the rotation, the top
        /// would travel backwards and every visible spin would be a lie.
        /// </summary>
        [Test]
        public void RollingForwardTurnsTheTopOfTheBallForward()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            BallBody ball = world.AddBall(1, new Vec2(-0.5, 0.0));
            const double speed = 1.0;
            ball.Velocity = new Vec2(speed, 0.0);
            // Natural roll: contact point stationary. Derived, not guessed.
            ball.Spin = new Vec3(0.0, speed / R, 0.0);
            ball.Resting = false;

            // A quarter turn or so — far enough to be unambiguous, short of the
            // half turn where sin changes sign and the assertion stops meaning
            // what it says.
            for (int i = 0; i < 5; i++) world.Step();

            Quat render = RenderFrame.ToRender(ball.Orientation);
            Vec3 top = Rotate(render, new Vec3(0.0, R, 0.0));

            Assert.Greater(top.X, 0.0, "top of a forward-rolling ball must move toward +X");
            Assert.AreEqual(0.0, top.Z, 1e-9, "pure forward roll must not tilt sideways");
            Assert.Greater(ball.Position.X, -0.5, "sanity: the ball actually travelled +x");
        }

        /// <summary>
        /// Vertical spin (about physics +z, which is up) must stay vertical in
        /// the render frame and keep its sense: anticlockwise seen from above.
        /// Looking down at the table, render +X reads as the long axis and
        /// render +Z as the short axis, so a mark on +X travels toward +Z.
        /// </summary>
        [Test]
        public void VerticalSpinMapsToTheVerticalRenderAxis()
        {
            var ball = new BallBody(0, 0, Vec2.Zero);
            ball.Spin = new Vec3(0.0, 0.0, 4.0);
            ball.IntegrateOrientation(0.05);

            Quat render = RenderFrame.ToRender(ball.Orientation);
            Vec3 mark = Rotate(render, new Vec3(R, 0.0, 0.0));

            Assert.AreEqual(0.0, mark.Y, 1e-12, "vertical spin must not tip the ball over");
            Assert.Greater(mark.Z, 0.0, "anticlockwise from above carries +X toward +Z");
            Assert.Greater(mark.X, 0.0, "0.2 rad is well short of a quarter turn");
        }

        [Test]
        public void AimRayFindsTheNearestBallAndTheGhostTouches()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            world.AddBall(0, new Vec2(-0.6, 0.0));
            BallBody near = world.AddBall(1, new Vec2(0.0, 0.0));
            world.AddBall(2, new Vec2(0.5, 0.0));

            AimPrediction aim = AimPredictor.Predict(world, 0.0);

            Assert.IsTrue(aim.Valid);
            Assert.IsNotNull(aim.Target);
            Assert.AreEqual(near.Id, aim.Target.Id);

            double gap = (aim.Ghost - near.Position).Length;
            Assert.AreEqual(2.0 * R, gap, 1e-12, "ghost ball must sit exactly in contact");
        }

        [Test]
        public void AimRayStopsAtACushionWhenNothingIsInTheWay()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            // Not x = 0: that is the side pocket, and the ray would leave the
            // table through the mouth rather than meet a cushion.
            world.AddBall(0, new Vec2(0.5, 0.0));

            // Straight up the short axis.
            AimPrediction aim = AimPredictor.Predict(world, Math.PI / 2.0);

            Assert.IsTrue(aim.Valid);
            Assert.IsNull(aim.Target);
            Assert.AreEqual(PhysicsConstants.TableWidth / 2.0 - R, aim.End.Y, 1e-9);
        }

        [Test]
        public void CueTangentIsPerpendicularToTheLineOfCentres()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            world.AddBall(0, new Vec2(-0.6, -0.05));
            world.AddBall(1, new Vec2(0.0, 0.0));

            AimPrediction aim = AimPredictor.Predict(world, 0.0);

            Assert.IsNotNull(aim.Target);
            Assert.AreEqual(0.0, Vec2.Dot(aim.CueTangent, aim.TargetDirection), 1e-12);
            Assert.AreEqual(1.0, aim.CueTangent.Length, 1e-12);
            // The cue ball carries on forwards, not back down its own path —
            // the sign the TypeScript overlay had inverted.
            Assert.Greater(aim.CueTangent.X, 0.0);
            // Cutting a ball that sits above the line sends the cue ball below it.
            Assert.Less(aim.CueTangent.Y, 0.0);
        }

        [Test]
        public void AimPredictionIsUnavailableWithoutACueBall()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            Assert.IsFalse(AimPredictor.Predict(world, 0.0).Valid);

            BallBody cue = world.AddBall(0, new Vec2(0.0, 0.0));
            cue.Pocketed = true;
            Assert.IsFalse(AimPredictor.Predict(world, 0.0).Valid);
        }

        /// <summary>
        /// The preview must agree with the simulation. Fire the shot the aiming
        /// line was drawn for and check the first ball actually contacted is the
        /// one the preview named.
        /// </summary>
        [Test]
        public void PredictedTargetIsTheBallTheSimulationActuallyHits()
        {
            var world = new PhysicsWorld(TableGeometry.Create());
            BallBody cue = world.AddBall(0, new Vec2(-0.7, 0.02));
            cue.Resting = false;
            world.AddBall(1, new Vec2(-0.1, 0.0));
            world.AddBall(2, new Vec2(0.4, 0.3));

            const double angle = 0.0;
            AimPrediction aim = AimPredictor.Predict(world, angle);
            Assert.IsNotNull(aim.Target);
            int predicted = aim.Target.Id;

            SpinModel.Apply(cue, new CueStrike
            {
                Direction = new Vec2(Math.Cos(angle), Math.Sin(angle)),
                Speed = 2.0,
                TipX = 0.0,
                TipY = 0.0,
            });

            int struck = -1;
            for (int i = 0; i < 2000 && struck < 0; i++)
            {
                world.Step();
                foreach (SimEvent e in world.Events)
                {
                    if (e.Type != SimEventType.BallBall) continue;
                    struck = e.BallA == cue.Id ? e.BallB : e.BallA;
                    break;
                }
            }

            Assert.AreEqual(predicted, struck);
        }
    }
}

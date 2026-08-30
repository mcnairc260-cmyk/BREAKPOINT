using System.Collections;
using System.Collections.Generic;
using Breakpoint.Presentation;
using Breakpoint.Simulation;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace Breakpoint.Tests.PlayMode
{
    /// <summary>
    /// Play-mode tests for the rule this whole migration turns on: Unity draws
    /// the game, and does not decide it.
    ///
    /// The structural half of that guarantee is in the assembly definitions —
    /// Breakpoint.Simulation and Breakpoint.Geometry both set
    /// "noEngineReferences": true, so the code that decides where a ball goes
    /// cannot name a Unity type even by accident. These tests cover the other
    /// half, which structure cannot enforce: that the *scene* does not sneak
    /// PhysX in behind it, and that presentation is genuinely read-only with
    /// respect to simulation state.
    ///
    /// These require the Unity Test Framework and a running player loop, so
    /// unlike the edit-mode suite they cannot be executed by the standalone
    /// Mono harness. They have not been run in the environment this code was
    /// written in; see BREAKPOINT_UNITY_MIGRATION.md, "What has and has not
    /// been executed".
    /// </summary>
    public class PresentationContractTests
    {
        private GameObject _root;
        private BreakpointBootstrap _game;

        [SetUp]
        public void SetUp()
        {
            _root = new GameObject("BREAKPOINT");
            _game = _root.AddComponent<BreakpointBootstrap>();
        }

        [TearDown]
        public void TearDown()
        {
            if (_root != null) Object.DestroyImmediate(_root);
        }

        [UnityTest]
        public IEnumerator SceneContainsNoRigidbodies()
        {
            yield return null;

            var bodies = _root.GetComponentsInChildren<Rigidbody>(true);
            Assert.AreEqual(0, bodies.Length,
                "a Rigidbody in the scene means PhysX has an opinion about where something goes");
        }

        [UnityTest]
        public IEnumerator TheOnlyColliderIsTheInputTarget()
        {
            yield return null;

            var colliders = _root.GetComponentsInChildren<Collider>(true);
            Assert.AreEqual(1, colliders.Length, "expected exactly one collider: the cloth raycast target");
            Assert.IsTrue(colliders[0].isTrigger, "the cloth target must be a trigger and collide with nothing");
            Assert.AreEqual("ClothTarget", colliders[0].gameObject.name);
        }

        [UnityTest]
        public IEnumerator EveryBallHasAPresenterBoundToTheRightBody()
        {
            yield return null;

            IReadOnlyList<BallPresenter> presenters = _game.Presenters;
            IReadOnlyList<BallBody> balls = _game.Runner.World.Balls;

            Assert.AreEqual(balls.Count, presenters.Count);
            for (int i = 0; i < balls.Count; i++)
            {
                Assert.AreSame(balls[i], presenters[i].Ball);
            }
        }

        [UnityTest]
        public IEnumerator BallTransformsFollowSimulationState()
        {
            yield return null;

            BallBody cue = _game.Runner.World.CueBall;
            Assert.IsTrue(_game.Fire(0.7f));

            for (int frame = 0; frame < 30; frame++) yield return null;

            BallPresenter presenter = _game.Presenters[0];
            Vector3 expected = TableFrame.Plane(cue.Position, (float)PhysicsConstants.BallRadius);
            Assert.AreEqual(expected.x, presenter.transform.position.x, 1e-4f);
            Assert.AreEqual(expected.y, presenter.transform.position.y, 1e-4f);
            Assert.AreEqual(expected.z, presenter.transform.position.z, 1e-4f);
        }

        /// <summary>
        /// The one that would catch a regression nothing else would: if a
        /// presenter ever wrote back, or a PhysX body were quietly reintroduced,
        /// shoving a Transform would move the ball.
        /// </summary>
        [UnityTest]
        public IEnumerator MovingATransformDoesNotMoveTheBall()
        {
            yield return null;

            BallPresenter presenter = _game.Presenters[1];
            Vec2 before = presenter.Ball.Position;

            presenter.transform.position += new Vector3(0.35f, 0f, 0.2f);
            for (int frame = 0; frame < 5; frame++) yield return null;

            Assert.AreEqual(before.X, presenter.Ball.Position.X, 0.0,
                "presentation wrote back into the simulation");
            Assert.AreEqual(before.Y, presenter.Ball.Position.Y, 0.0);
        }

        [UnityTest]
        public IEnumerator AShotCannotBeFiredWhileTheBallsAreRunning()
        {
            yield return null;

            Assert.IsTrue(_game.Fire(0.9f), "the first shot should be accepted");
            yield return null;
            Assert.IsFalse(_game.Fire(0.9f), "a second shot mid-rally must be refused by the simulation");
        }

        [UnityTest]
        public IEnumerator PocketedBallsDisappearAndTheRestDoNot()
        {
            yield return null;

            BallBody victim = _game.Runner.World.Balls[3];
            victim.Pocketed = true;

            for (int frame = 0; frame < 90; frame++) yield return null;

            Assert.IsFalse(_game.Presenters[3].gameObject.activeSelf);
            Assert.IsTrue(_game.Presenters[2].gameObject.activeSelf);
        }

        /// <summary>
        /// The whole point of the migration, end to end: a shot composed
        /// through the intent API, resolved by the custom simulation, and
        /// displayed by Unity — with the balls arriving where the simulation
        /// says they are and nowhere else.
        ///
        /// The same shot, and the same assertions about what it produces, run
        /// in the edit-mode suite as DemonstrationShotTests. That version has
        /// actually been executed; this one exists so the *bridge* is covered
        /// the first time this project is opened in an editor.
        /// </summary>
        [UnityTest]
        public IEnumerator DemonstrationShotRunsThroughTheBridge()
        {
            yield return null;

            PhysicsWorld world = _game.Runner.World;
            BallBody cue = world.CueBall;

            // Clear the rack down to one object ball, so the shot is the
            // straight pot the edit-mode test describes rather than a break.
            BallBody target = null;
            for (int i = 0; i < world.Balls.Count; i++)
            {
                BallBody ball = world.Balls[i];
                if (ball == cue) continue;
                if (ball.Number == 9) target = ball;
                else ball.Pocketed = true;
            }
            Assert.IsNotNull(target, "the 9 ball is missing from the rack");

            cue.Position = DemonstrationCueStart;
            cue.Resting = true;
            target.Position = DemonstrationObjectStart;
            target.Resting = true;

            // Aim through the intent API, exactly as the input layer would.
            _game.SetTip(0.35f, 0f);
            _game.AimAt(GhostBallPoint(world));

            int ballContacts = 0;
            int railContacts = 0;
            int pockets = 0;
            _game.Runner.Observed += e =>
            {
                if (e.Type == SimEventType.BallBall) ballContacts++;
                else if (e.Type == SimEventType.Rail) railContacts++;
                else if (e.Type == SimEventType.Pocket) pockets++;
            };

            Assert.IsTrue(_game.Fire(0.42f), "the shot was refused");

            for (int frame = 0; frame < 900 && _game.Runner.IsRunning; frame++) yield return null;

            Assert.IsFalse(_game.Runner.IsRunning, "the table never settled");
            Assert.GreaterOrEqual(ballContacts, 1, "no ball-ball contact was observed");
            Assert.GreaterOrEqual(railContacts, 1, "no cushion contact was observed");
            Assert.GreaterOrEqual(pockets, 1, "nothing was potted");
            Assert.IsTrue(target.Pocketed, "the object ball was not potted");
            Assert.IsFalse(world.Corrupted);

            for (int i = 0; i < world.Balls.Count; i++)
            {
                Assert.IsTrue(world.Balls[i].IsFinite, "a ball finished with a non-finite value");
            }

            // And Unity is showing what the simulation decided.
            for (int i = 0; i < _game.Presenters.Count; i++)
            {
                BallPresenter presenter = _game.Presenters[i];
                if (presenter.Ball.Pocketed) continue;

                Vector3 expected = TableFrame.Plane(
                    presenter.Ball.Position, (float)PhysicsConstants.BallRadius);
                Assert.AreEqual(expected.x, presenter.transform.position.x, 1e-4f);
                Assert.AreEqual(expected.z, presenter.transform.position.z, 1e-4f);
            }

            // A second shot can begin immediately.
            Assert.IsTrue(_game.Fire(0.3f), "a second shot was refused after the table settled");
        }

        private static readonly Vec2 DemonstrationCueStart = new Vec2(0.515, 0.020);
        private static readonly Vec2 DemonstrationObjectStart = new Vec2(1.10, 0.50);

        /// <summary>
        /// The ghost-ball point that sends the object ball at the corner
        /// pocket. Derived rather than hard-coded, so a change to the table
        /// geometry moves the aim with it instead of silently breaking the test.
        /// </summary>
        private static Vec2 GhostBallPoint(PhysicsWorld world)
        {
            Pocket corner = null;
            foreach (Pocket p in world.Table.Pockets)
            {
                if (p.Id == "pocket-corner-rt") corner = p;
            }
            Assert.IsNotNull(corner);

            double px = corner.Centre.X - DemonstrationObjectStart.X;
            double py = corner.Centre.Y - DemonstrationObjectStart.Y;
            double length = System.Math.Sqrt(px * px + py * py);

            return new Vec2(
                DemonstrationObjectStart.X - 2.0 * PhysicsConstants.BallRadius * px / length,
                DemonstrationObjectStart.Y - 2.0 * PhysicsConstants.BallRadius * py / length);
        }

        /// <summary>
        /// The camera has to survive a phone. A portrait aspect must still frame
        /// the whole table when the shot is being watched — the failure this
        /// guards against showed up only in mobile screenshots the first time.
        /// </summary>
        [UnityTest]
        public IEnumerator OverviewFramingCoversTheTableInPortrait()
        {
            yield return null;

            Camera camera = _game.Rig.Camera;
            camera.aspect = 390f / 844f;
            _game.Rig.Reset();

            TableGeometry table = _game.Runner.World.Table;
            for (int frame = 0; frame < 120; frame++)
            {
                _game.Rig.Advance(Vec2.Zero, 0.0, true, 1f / 60f);
            }

            double hx = table.Length / 2.0;
            double hy = table.Width / 2.0;
            foreach (int sx in new[] { -1, 1 })
            {
                foreach (int sy in new[] { -1, 1 })
                {
                    Vector3 corner = TableFrame.Plane(new Vec2(sx * hx, sy * hy), 0f);
                    Vector3 view = camera.WorldToViewportPoint(corner);
                    Assert.Greater(view.z, 0f, "a table corner is behind the camera");
                    Assert.GreaterOrEqual(view.x, 0f, "a table corner is off the left of the screen");
                    Assert.LessOrEqual(view.x, 1f, "a table corner is off the right of the screen");
                    Assert.GreaterOrEqual(view.y, 0f, "a table corner is off the bottom of the screen");
                    Assert.LessOrEqual(view.y, 1f, "a table corner is off the top of the screen");
                }
            }
        }
    }
}

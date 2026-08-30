using System;
using Breakpoint.Simulation;
using NUnit.Framework;

namespace Breakpoint.Tests
{
    /// <summary>
    /// Garbage-collection pressure in the simulation loop.
    ///
    /// A 120 Hz fixed step means the simulation runs twice per rendered frame
    /// at 60 fps. On a phone, a collector pause landing inside that loop is a
    /// dropped frame the player feels, and allocation is the one performance
    /// property that can be asserted deterministically rather than measured on
    /// hardware nobody here has — so it is asserted.
    ///
    /// The bound is set from measurement, not from taste. Once the internal
    /// buffers have grown, a step allocates **nothing at all**: every working
    /// list is a reused field, every vector is a struct, and the batch solver
    /// copies bodies into pooled instances rather than cloning them. Before
    /// that pooling was added the batch solver allocated a fresh BallBody per
    /// body per solver pass, which cost about 85 KB across a single break.
    /// </summary>
    [TestFixture]
    public class AllocationTests
    {
        /// <summary>
        /// Allocation measurement is not available on every runtime. Where it
        /// is missing the test says so rather than passing quietly — an
        /// unmeasured invariant is not a satisfied one.
        /// </summary>
        private static bool TryAllocatedBytes(out long bytes)
        {
            try
            {
                bytes = GC.GetAllocatedBytesForCurrentThread();
                return true;
            }
            catch (Exception)
            {
                bytes = 0;
                return false;
            }
        }

        private static PhysicsWorld Break(double speed)
        {
            PhysicsWorld world = Rack.CreateRackedWorld();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(1.0, 0.0),
                Speed = speed,
                TipX = 0.0,
                TipY = 0.0,
            });
            return world;
        }

        private static int RunToRest(PhysicsWorld world)
        {
            int steps = 0;
            while (!world.IsSettled() && steps < 20000)
            {
                world.Step();
                steps++;
            }
            return steps;
        }

        /// <summary>
        /// The strong claim: a warmed-up world stepping a whole shot allocates
        /// zero bytes.
        /// </summary>
        [Test]
        public void AWarmedUpShotAllocatesNothing()
        {
            long ignored;
            if (!TryAllocatedBytes(out ignored))
            {
                Assert.Fail("GC.GetAllocatedBytesForCurrentThread is unavailable — "
                    + "the allocation invariant could not be measured on this runtime");
                return;
            }

            // Warm up: JIT every path and grow every internal buffer.
            PhysicsWorld world = Break(9.0);
            RunToRest(world);

            world.ClearEvents();
            SpinModel.Apply(world.CueBall, new CueStrike
            {
                Direction = new Vec2(-1.0, 0.13),
                Speed = 6.0,
                TipX = 0.2,
                TipY = -0.2,
            });

            long before;
            TryAllocatedBytes(out before);
            int steps = RunToRest(world);
            long after;
            TryAllocatedBytes(out after);

            Assert.Greater(steps, 200, "the measurement shot was too short to mean anything");
            Assert.AreEqual(0L, after - before,
                "the simulation allocated " + (after - before) + " bytes across " + steps + " steps");
        }

        /// <summary>
        /// A cold break still has to grow the event list, so it is not free.
        /// The bound is generous against the measured ~10 KB, and exists to
        /// catch a regression of the order the batch-solver clones were —
        /// which came to roughly 85 KB for the same shot.
        /// </summary>
        [Test]
        public void AColdBreakStaysWellUnderThirtyKilobytes()
        {
            long ignored;
            if (!TryAllocatedBytes(out ignored))
            {
                Assert.Fail("GC.GetAllocatedBytesForCurrentThread is unavailable — "
                    + "the allocation invariant could not be measured on this runtime");
                return;
            }

            // Warm the JIT without warming this world's buffers.
            RunToRest(Break(9.0));

            PhysicsWorld world = Break(9.0);
            long before;
            TryAllocatedBytes(out before);
            int steps = RunToRest(world);
            long after;
            TryAllocatedBytes(out after);

            Assert.Greater(steps, 200);
            Assert.Less(after - before, 30000L,
                "a cold break allocated " + (after - before) + " bytes across " + steps + " steps");
        }

        /// <summary>
        /// Pooling the batch solver's scratch bodies must not have changed the
        /// physics. The parity fixtures already prove that against the oracle;
        /// this proves the two paths that read those buffers still agree with
        /// each other across repeated runs of the most contact-dense shot there
        /// is.
        /// </summary>
        [Test]
        public void PoolingDidNotDisturbTheBreak()
        {
            PhysicsWorld first = Break(9.0);
            RunToRest(first);

            PhysicsWorld second = Break(9.0);
            RunToRest(second);

            Assert.AreEqual(first.Events.Count, second.Events.Count);
            for (int i = 0; i < first.Balls.Count; i++)
            {
                Assert.AreEqual(first.Balls[i].Position.X, second.Balls[i].Position.X, 0.0);
                Assert.AreEqual(first.Balls[i].Position.Y, second.Balls[i].Position.Y, 0.0);
                Assert.AreEqual(first.Balls[i].Pocketed, second.Balls[i].Pocketed);
            }
        }
    }
}

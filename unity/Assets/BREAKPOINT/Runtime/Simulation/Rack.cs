using System.Collections.Generic;

namespace Breakpoint.Simulation
{
    /// <summary>
    /// The opening position.
    ///
    /// A standard eight-ball rack: apex on the foot spot, the 8 in the middle of
    /// the third row. Phase A has no rules engine, so the rack exists to give
    /// the simulation something worth hitting rather than to enforce anything.
    /// </summary>
    public static class Rack
    {
        /// <summary>Gap between neighbouring balls. Real racks are never perfect.</summary>
        private const double RackGap = 0.0004;

        /// <summary>Ball numbers by rack position, apex first, reading each row outward.</summary>
        private static readonly int[] Order = { 1, 9, 2, 10, 8, 3, 11, 7, 14, 4, 5, 13, 15, 6, 12 };

        public struct Placement
        {
            public int Number;
            public Vec2 Position;
        }

        public static List<Placement> Positions(TableGeometry table)
        {
            double spacing = 2.0 * PhysicsConstants.BallRadius + RackGap;
            double rowStep = spacing * System.Math.Sqrt(3.0) * 0.5;
            var placements = new List<Placement>();

            int index = 0;
            for (int row = 0; row < 5; row++)
            {
                for (int i = 0; i <= row; i++)
                {
                    placements.Add(new Placement
                    {
                        Number = Order[index++],
                        Position = new Vec2(
                            table.FootSpotX + row * rowStep,
                            (i - row / 2.0) * spacing),
                    });
                }
            }

            return placements;
        }

        /// <summary>Where the cue ball sits for the break.</summary>
        public static Vec2 BreakCuePosition(TableGeometry table) => new Vec2(table.HeadStringX, 0.0);

        /// <summary>A world containing a full rack and a cue ball, ready to break.</summary>
        public static PhysicsWorld CreateRackedWorld(TableGeometry table = null)
        {
            TableGeometry geometry = table ?? TableGeometry.Create();
            var world = new PhysicsWorld(geometry);
            world.AddBall(0, BreakCuePosition(geometry));
            foreach (Placement placement in Positions(geometry))
            {
                world.AddBall(placement.Number, placement.Position);
            }
            return world;
        }
    }
}

using System;
using System.Collections.Generic;

namespace Breakpoint.Simulation
{
    /// <summary>A straight cushion face. <see cref="Normal"/> points into the playing area.</summary>
    public sealed class RailSegment
    {
        public readonly string Id;
        public readonly Vec2 A;
        public readonly Vec2 B;
        public readonly Vec2 Normal;
        /// <summary>Unit vector from A to B, precomputed.</summary>
        public readonly Vec2 Tangent;
        public readonly double Length;

        public RailSegment(string id, Vec2 a, Vec2 b, Vec2 normal)
        {
            Id = id;
            A = a;
            B = b;
            Normal = normal;
            double dx = b.X - a.X;
            double dy = b.Y - a.Y;
            Length = Math.Sqrt(dx * dx + dy * dy);
            Tangent = new Vec2(dx / Length, dy / Length);
        }
    }

    /// <summary>A rounded cushion end. Balls collide with it as a static circle.</summary>
    public sealed class Jaw
    {
        public readonly string Id;
        public readonly Vec2 Centre;
        public readonly double Radius;

        public Jaw(string id, Vec2 centre, double radius)
        {
            Id = id;
            Centre = centre;
            Radius = radius;
        }
    }

    public enum PocketKind
    {
        Corner,
        Side
    }

    public sealed class Pocket
    {
        public readonly string Id;
        public readonly PocketKind Kind;
        public readonly Vec2 Centre;
        /// <summary>A ball whose centre comes within this of <see cref="Centre"/> has dropped.</summary>
        public readonly double CaptureRadius;
        /// <summary>Visual mouth radius, used by presentation only.</summary>
        public readonly double MouthRadius;

        public Pocket(string id, PocketKind kind, Vec2 centre, double captureRadius, double mouthRadius)
        {
            Id = id;
            Kind = kind;
            Centre = centre;
            CaptureRadius = captureRadius;
            MouthRadius = mouthRadius;
        }
    }

    /// <summary>
    /// The static collision world: cushion segments, pocket jaws, pocket mouths.
    ///
    /// Built once as plain data so presentation can draw exactly the geometry
    /// the simulation collides against — there is no second, "visual" table
    /// that could drift out of sync with the playable one.
    ///
    /// Layout (looking down, +x long axis, +y short axis, origin at centre):
    ///
    ///     C---------S---------C     y = +W/2   (top long rail, two segments)
    ///     |                   |
    ///     |                   |     x = ±L/2   (head/foot short rails)
    ///     |                   |
    ///     C---------S---------C     y = -W/2   (bottom long rail, two segments)
    ///
    /// C = corner pocket, S = side pocket. Each cushion segment ends in a
    /// rounded jaw; the jaws are what make a ball rattle instead of vanishing.
    /// </summary>
    public sealed class TableGeometry
    {
        /// <summary>Corner pocket mouth, 4 1/2" between the jaw noses.</summary>
        private const double CornerMouth = 0.1143;

        /// <summary>Side pocket mouth, 5". Sides are cut wider because the approach is worse.</summary>
        private const double SideMouth = 0.127;

        /// <summary>Radius of the rounded rubber jaw at each cushion end.</summary>
        private const double JawRadius = 0.012;

        public readonly double Length;
        public readonly double Width;
        public readonly RailSegment[] Rails;
        public readonly Jaw[] Jaws;
        public readonly Pocket[] Pockets;

        /// <summary>Head string x — where the cue ball is placed for a break.</summary>
        public readonly double HeadStringX;

        /// <summary>Foot spot x — where the apex ball of the rack sits.</summary>
        public readonly double FootSpotX;

        private TableGeometry(
            double length,
            double width,
            RailSegment[] rails,
            Jaw[] jaws,
            Pocket[] pockets,
            double headStringX,
            double footSpotX)
        {
            Length = length;
            Width = width;
            Rails = rails;
            Jaws = jaws;
            Pockets = pockets;
            HeadStringX = headStringX;
            FootSpotX = footSpotX;
        }

        /// <summary>
        /// Build the standard 9-foot table.
        ///
        /// The one number worth explaining is the corner cut. A corner pocket is
        /// cut at 45°, so the cushion has to stop <c>mouth / sqrt(2)</c> short of
        /// the corner for the mouth to measure <c>mouth</c> across the diagonal.
        /// Side pockets are cut square, so their cushions simply stop half a
        /// mouth short of x = 0.
        /// </summary>
        public static TableGeometry Create()
        {
            double l = PhysicsConstants.TableLength;
            double w = PhysicsConstants.TableWidth;
            double hx = l / 2.0;
            double hy = w / 2.0;

            double cornerCut = CornerMouth / Math.Sqrt(2.0);
            double sideCut = SideMouth / 2.0;

            var rails = new[]
            {
                // Top long rail (y = +hy), normal points down into the table.
                new RailSegment("rail-top-left", new Vec2(-hx + cornerCut, hy), new Vec2(-sideCut, hy), new Vec2(0.0, -1.0)),
                new RailSegment("rail-top-right", new Vec2(sideCut, hy), new Vec2(hx - cornerCut, hy), new Vec2(0.0, -1.0)),
                // Bottom long rail (y = -hy), normal points up.
                new RailSegment("rail-bottom-left", new Vec2(-hx + cornerCut, -hy), new Vec2(-sideCut, -hy), new Vec2(0.0, 1.0)),
                new RailSegment("rail-bottom-right", new Vec2(sideCut, -hy), new Vec2(hx - cornerCut, -hy), new Vec2(0.0, 1.0)),
                // Short rails.
                new RailSegment("rail-left", new Vec2(-hx, -hy + cornerCut), new Vec2(-hx, hy - cornerCut), new Vec2(1.0, 0.0)),
                new RailSegment("rail-right", new Vec2(hx, -hy + cornerCut), new Vec2(hx, hy - cornerCut), new Vec2(-1.0, 0.0)),
            };

            // Each jaw sits just *outside* the cushion face so a ball hugging the
            // rail clears it and drops, which is how a real table plays.
            var jaws = new List<Jaw>();
            foreach (int sy in new[] { 1, -1 })
            {
                jaws.Add(new Jaw("jaw-corner-left-long-" + sy, new Vec2(-hx + cornerCut, sy * (hy + JawRadius)), JawRadius));
                jaws.Add(new Jaw("jaw-side-left-" + sy, new Vec2(-sideCut, sy * (hy + JawRadius)), JawRadius));
                jaws.Add(new Jaw("jaw-side-right-" + sy, new Vec2(sideCut, sy * (hy + JawRadius)), JawRadius));
                jaws.Add(new Jaw("jaw-corner-right-long-" + sy, new Vec2(hx - cornerCut, sy * (hy + JawRadius)), JawRadius));
            }
            foreach (int sx in new[] { 1, -1 })
            {
                jaws.Add(new Jaw("jaw-corner-" + sx + "-short-top", new Vec2(sx * (hx + JawRadius), hy - cornerCut), JawRadius));
                jaws.Add(new Jaw("jaw-corner-" + sx + "-short-bottom", new Vec2(sx * (hx + JawRadius), -(hy - cornerCut)), JawRadius));
            }

            // Pocket centres sit back from the cushion line, inside the throat. A
            // ball has to travel past the jaws to reach the capture radius, which
            // is what makes a jaw-clipping ball rattle out instead of dropping.
            const double cornerDrop = 0.026;
            const double sideDrop = 0.030;
            var pockets = new List<Pocket>();
            foreach (int sx in new[] { 1, -1 })
            {
                foreach (int sy in new[] { 1, -1 })
                {
                    string id = "pocket-corner-" + (sx > 0 ? "r" : "l") + (sy > 0 ? "t" : "b");
                    pockets.Add(new Pocket(
                        id,
                        PocketKind.Corner,
                        new Vec2(sx * (hx + cornerDrop), sy * (hy + cornerDrop)),
                        CornerMouth / 2.0,
                        CornerMouth / 2.0));
                }
            }
            foreach (int sy in new[] { 1, -1 })
            {
                string id = "pocket-side-" + (sy > 0 ? "t" : "b");
                pockets.Add(new Pocket(
                    id,
                    PocketKind.Side,
                    new Vec2(0.0, sy * (hy + sideDrop)),
                    SideMouth / 2.0 - PhysicsConstants.BallRadius * 0.25,
                    SideMouth / 2.0));
            }

            return new TableGeometry(l, w, rails, jaws.ToArray(), pockets.ToArray(), -l / 4.0, l / 4.0);
        }
    }
}

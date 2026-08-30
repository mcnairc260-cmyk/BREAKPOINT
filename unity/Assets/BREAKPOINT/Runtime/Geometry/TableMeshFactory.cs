using System;
using System.Collections.Generic;
using Breakpoint.Simulation;

namespace Breakpoint.Geometry
{
    /// <summary>
    /// The table's meshes, generated from the same <see cref="TableGeometry"/>
    /// the simulation collides against.
    ///
    /// Every cushion is extruded along the exact segment the physics uses, and
    /// the nose of that extrusion sits on the exact line the physics measures
    /// against. There is no second, "visual" table that could drift out of
    /// agreement with the playable one: if a ball looks like it went through a
    /// rail, the rail really was there.
    ///
    /// Winding note, because it is the easiest thing in this file to get wrong:
    /// Unity treats a triangle as front-facing when its normal, taken as
    /// cross(B-A, C-A), points at the viewer. In the render frame that means an
    /// upward-facing face on the cloth plane must wind *clockwise* when read in
    /// (x, z) with the usual maths convention — the reverse of what a
    /// triangulator hands back. The reversal happens once, here, and the tests
    /// check the resulting normals rather than trusting the argument.
    /// </summary>
    public static class TableMeshFactory
    {
        /// <summary>How far the wooden rail cap extends beyond the cushion.</summary>
        public const double RailCapWidth = 0.09;

        /// <summary>Depth of the cushion body, measured back from the nose.</summary>
        public const double CushionDepth = 0.05;

        /// <summary>Height of the flat top of the cushion.</summary>
        public const double CushionTop = 0.0455;

        /// <summary>Height of the wooden rail cap.</summary>
        public const double RailCapTop = 0.058;

        /// <summary>Thickness of the slate-and-cloth slab.</summary>
        public const double BedDrop = 0.03;

        /// <summary>How deep you can see down a pocket.</summary>
        public const double PocketDepth = 0.17;

        /// <summary>Segments around a pocket mouth.</summary>
        private const int PocketSegments = 32;

        /// <summary>Cloth texture tiling, in metres per repeat.</summary>
        private const double ClothTile = 0.46;

        /// <summary>Distance from the cushion line to the outer edge of the frame.</summary>
        public static double FrameDepth => 2.0 * CushionDepth + RailCapWidth;

        /// <summary>
        /// The bed: a slab covering the whole frame footprint with the six
        /// pocket mouths punched clean through it.
        ///
        /// The holes are the point. With a solid slab a pocket is a dark disc
        /// painted on cloth, which is the single loudest tell of a cheap-looking
        /// table; with a real hole you see down the throat and the ball
        /// disappears into it.
        /// </summary>
        public static MeshData Bed(TableGeometry table)
        {
            double hx = table.Length / 2.0 + FrameDepth;
            double hy = table.Width / 2.0 + FrameDepth;

            var outer = new List<Point2>
            {
                new Point2(-hx, -hy),
                new Point2(hx, -hy),
                new Point2(hx, hy),
                new Point2(-hx, hy),
            };

            var holes = new List<IList<Point2>>();
            foreach (Pocket pocket in table.Pockets)
            {
                holes.Add(Polygon2.Circle(
                    pocket.Centre.X, pocket.Centre.Y, pocket.MouthRadius, PocketSegments, true));
            }

            List<Point2> vertices;
            List<int> triangles;
            Polygon2.Triangulate(outer, holes, out vertices, out triangles);

            var mesh = new MeshData();
            var mapped = new int[vertices.Count];
            for (int i = 0; i < vertices.Count; i++)
            {
                Point2 p = vertices[i];
                mapped[i] = mesh.AddVertex(p.X, 0.0, p.Y, 0.0, 1.0, 0.0, p.X / ClothTile, p.Y / ClothTile);
            }

            // Reversed: the triangulator winds counter-clockwise in (x, z),
            // which faces down once y is up. See the note on this class.
            for (int t = 0; t < triangles.Count; t += 3)
            {
                mesh.AddTriangle(mapped[triangles[t + 2]], mapped[triangles[t + 1]], mapped[triangles[t]]);
            }

            AddSlabEdges(mesh, hx, hy);
            foreach (Pocket pocket in table.Pockets)
            {
                AddPocketWall(mesh, pocket);
            }

            return mesh;
        }

        /// <summary>The four outer faces of the slab, so it reads as having thickness.</summary>
        private static void AddSlabEdges(MeshData mesh, double hx, double hy)
        {
            AddWallQuad(mesh, -hx, -hy, hx, -hy, 0.0, -1.0);
            AddWallQuad(mesh, hx, -hy, hx, hy, 1.0, 0.0);
            AddWallQuad(mesh, hx, hy, -hx, hy, 0.0, 1.0);
            AddWallQuad(mesh, -hx, hy, -hx, -hy, -1.0, 0.0);
        }

        private static void AddWallQuad(MeshData mesh, double x0, double z0, double x1, double z1, double nx, double nz)
        {
            int a = mesh.AddVertex(x0, 0.0, z0, nx, 0.0, nz, 0.0, 0.0);
            int b = mesh.AddVertex(x1, 0.0, z1, nx, 0.0, nz, 1.0, 0.0);
            int c = mesh.AddVertex(x1, -BedDrop, z1, nx, 0.0, nz, 1.0, 1.0);
            int d = mesh.AddVertex(x0, -BedDrop, z0, nx, 0.0, nz, 0.0, 1.0);
            mesh.AddQuad(a, b, c, d);
        }

        /// <summary>
        /// The inside of a pocket: a tapering shaft down from the mouth and a
        /// floor at the bottom. Tapered because a straight cylinder shows its
        /// far wall as a bright crescent under the overhead lamp and reads as a
        /// tube rather than a hole.
        /// </summary>
        private static void AddPocketWall(MeshData mesh, Pocket pocket)
        {
            double cx = pocket.Centre.X;
            double cz = pocket.Centre.Y;
            double top = pocket.MouthRadius;
            double bottom = pocket.MouthRadius * 0.8;
            double floorY = -PocketDepth;

            var upper = new int[PocketSegments + 1];
            var lower = new int[PocketSegments + 1];
            var floor = new int[PocketSegments + 1];

            for (int i = 0; i <= PocketSegments; i++)
            {
                double t = 2.0 * Math.PI * i / PocketSegments;
                double c = Math.Cos(t);
                double s = Math.Sin(t);
                double u = (double)i / PocketSegments;

                // Normals point inwards: the shaft is only ever seen from inside.
                upper[i] = mesh.AddVertex(cx + top * c, 0.0, cz + top * s, -c, 0.0, -s, u, 0.0);
                lower[i] = mesh.AddVertex(cx + bottom * c, floorY, cz + bottom * s, -c, 0.0, -s, u, 1.0);
                floor[i] = mesh.AddVertex(cx + bottom * c, floorY, cz + bottom * s, 0.0, 1.0, 0.0,
                    0.5 + 0.5 * c, 0.5 + 0.5 * s);
            }

            int centre = mesh.AddVertex(cx, floorY, cz, 0.0, 1.0, 0.0, 0.5, 0.5);

            for (int i = 0; i < PocketSegments; i++)
            {
                mesh.AddQuad(upper[i], lower[i], lower[i + 1], upper[i + 1]);
                mesh.AddTriangle(centre, floor[i + 1], floor[i]);
            }
        }

        /// <summary>
        /// The cushion profile, in (depth back from the nose, height).
        ///
        /// The nose sits at depth 0 and at <see cref="PhysicsConstants.CushionHeight"/>,
        /// which is 1.27 ball radii — the K-66 profile, and the same number the
        /// simulation uses to decide that a cushion strike is above centre and
        /// therefore imparts topspin. The visible nose and the colliding nose
        /// are the same line by construction.
        /// </summary>
        public static Point2[] CushionProfile()
        {
            double nose = PhysicsConstants.CushionHeight;
            return new[]
            {
                new Point2(0.010, 0.0),          // front foot, on the cloth
                new Point2(0.000, nose),         // the nose
                new Point2(0.014, CushionTop),   // top front edge
                new Point2(CushionDepth, CushionTop), // top back
                new Point2(CushionDepth, 0.0),   // back foot
            };
        }

        /// <summary>Extrude the cushion profile along one rail segment.</summary>
        public static MeshData Cushion(RailSegment rail)
        {
            Point2[] profile = CushionProfile();
            var mesh = new MeshData();

            // The nose lies on the rail line; depth runs away from the playing
            // area, which is the direction opposite the segment normal.
            double ox = -rail.Normal.X, oz = -rail.Normal.Y;

            // Opposite rails run the same way but face opposite directions, so
            // (tangent, normal) is right-handed on half of them and left-handed
            // on the other half. Emitting one fixed vertex order would turn
            // half the cushions inside out — invisible from the usual camera
            // angle, and glaringly wrong from any other.
            double handed = rail.Tangent.X * rail.Normal.Y - rail.Tangent.Y * rail.Normal.X;
            bool mirrored = handed < 0.0;

            for (int i = 0; i < profile.Length - 1; i++)
            {
                Point2 p0 = profile[i];
                Point2 p1 = profile[i + 1];

                double ed = p1.X - p0.X;
                double eh = p1.Y - p0.Y;
                double length = Math.Sqrt(ed * ed + eh * eh);
                if (length < 1e-12) continue;

                // Outward normal of the profile edge, lifted into world space.
                double nd = -eh / length;
                double nh = ed / length;
                double nx = ox * nd;
                double nz = oz * nd;

                int a = Vertex(mesh, rail, 0.0, p0, nx, nh, nz, 0.0, 0.0);
                int b = Vertex(mesh, rail, rail.Length, p0, nx, nh, nz, 1.0, 0.0);
                int c = Vertex(mesh, rail, rail.Length, p1, nx, nh, nz, 1.0, 1.0);
                int d = Vertex(mesh, rail, 0.0, p1, nx, nh, nz, 0.0, 1.0);
                if (mirrored) mesh.AddQuad(a, d, c, b);
                else mesh.AddQuad(a, b, c, d);
            }

            AddCushionCap(mesh, rail, 0.0, -rail.Tangent.X, -rail.Tangent.Y, !mirrored);
            AddCushionCap(mesh, rail, rail.Length, rail.Tangent.X, rail.Tangent.Y, mirrored);
            return mesh;
        }

        private static int Vertex(
            MeshData mesh, RailSegment rail, double s, Point2 p,
            double nx, double ny, double nz, double u, double v)
        {
            double x = rail.A.X + rail.Tangent.X * s - rail.Normal.X * p.X;
            double z = rail.A.Y + rail.Tangent.Y * s - rail.Normal.Y * p.X;
            return mesh.AddVertex(x, p.Y, z, nx, ny, nz, u, v);
        }

        /// <summary>
        /// Close off one end of the cushion. The ends are usually hidden behind
        /// a jaw, but an open prism catches the lamp through the gap and shows
        /// as a bright sliver at the pocket mouth.
        /// </summary>
        private static void AddCushionCap(
            MeshData mesh, RailSegment rail, double s, double nx, double nz, bool reversed)
        {
            Point2[] profile = CushionProfile();
            var fan = new int[profile.Length];
            for (int i = 0; i < profile.Length; i++)
            {
                fan[i] = Vertex(mesh, rail, s, profile[i], nx, 0.0, nz, 0.0, 0.0);
            }

            // The profile is convex enough for a fan from its first point.
            for (int i = 1; i < profile.Length - 1; i++)
            {
                if (reversed) mesh.AddTriangle(fan[0], fan[i], fan[i + 1]);
                else mesh.AddTriangle(fan[0], fan[i + 1], fan[i]);
            }
        }
    }
}

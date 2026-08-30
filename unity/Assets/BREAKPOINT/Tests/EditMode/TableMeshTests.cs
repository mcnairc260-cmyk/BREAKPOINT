using System;
using System.Collections.Generic;
using Breakpoint.Geometry;
using Breakpoint.Simulation;
using NUnit.Framework;

namespace Breakpoint.Tests
{
    /// <summary>
    /// Tests for the generated table meshes.
    ///
    /// A mesh is usually checked by looking at it, which is exactly why it is
    /// worth checking arithmetically: a hole that is slightly the wrong size, a
    /// face wound inside out, or a cushion nose half a millimetre off the line
    /// the physics collides against all look fine in a screenshot and are all
    /// wrong. None of this needs Unity — the geometry assembly is engine-free
    /// for this reason.
    /// </summary>
    [TestFixture]
    public class TableMeshTests
    {
        private static TableGeometry Table() => TableGeometry.Create();

        private static Vec3 Normal(MeshData mesh, int triangle)
        {
            double ax, ay, az, bx, by, bz, cx, cy, cz;
            mesh.Vertex(mesh.Indices[triangle * 3], out ax, out ay, out az);
            mesh.Vertex(mesh.Indices[triangle * 3 + 1], out bx, out by, out bz);
            mesh.Vertex(mesh.Indices[triangle * 3 + 2], out cx, out cy, out cz);

            var u = new Vec3(bx - ax, by - ay, bz - az);
            var v = new Vec3(cx - ax, cy - ay, cz - az);
            return Vec3.Cross(u, v);
        }

        // ------------------------------------------------------- triangulation

        [Test]
        public void SquareWithNoHolesTriangulatesToItsOwnArea()
        {
            var outer = new List<Point2>
            {
                new Point2(-1, -1), new Point2(1, -1), new Point2(1, 1), new Point2(-1, 1),
            };

            List<Point2> vertices;
            List<int> triangles;
            Polygon2.Triangulate(outer, null, out vertices, out triangles);

            Assert.AreEqual(2, triangles.Count / 3);
            Assert.AreEqual(4.0, TriangleArea(vertices, triangles), 1e-12);
        }

        [Test]
        public void RectangleWithOneHoleLosesExactlyTheHolesArea()
        {
            var outer = new List<Point2>
            {
                new Point2(-2, -1), new Point2(2, -1), new Point2(2, 1), new Point2(-2, 1),
            };
            const int segments = 64;
            const double radius = 0.4;
            var holes = new List<IList<Point2>> { Polygon2.Circle(0.3, 0.1, radius, segments, true) };

            List<Point2> vertices;
            List<int> triangles;
            Polygon2.Triangulate(outer, holes, out vertices, out triangles);

            // A 64-gon is not a circle; compare against the polygon's own area.
            double holeArea = 0.5 * segments * radius * radius * Math.Sin(2.0 * Math.PI / segments);
            Assert.AreEqual(8.0 - holeArea, TriangleArea(vertices, triangles), 1e-9);
        }

        [Test]
        public void EveryTriangulatedTriangleWindsTheSameWay()
        {
            var outer = new List<Point2>
            {
                new Point2(-2, -1), new Point2(2, -1), new Point2(2, 1), new Point2(-2, 1),
            };
            var holes = new List<IList<Point2>>
            {
                Polygon2.Circle(-1.2, 0.0, 0.3, 24, true),
                Polygon2.Circle(1.2, 0.0, 0.3, 24, true),
            };

            List<Point2> vertices;
            List<int> triangles;
            Polygon2.Triangulate(outer, holes, out vertices, out triangles);

            for (int t = 0; t < triangles.Count; t += 3)
            {
                Point2 a = vertices[triangles[t]];
                Point2 b = vertices[triangles[t + 1]];
                Point2 c = vertices[triangles[t + 2]];
                double cross = (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
                Assert.Greater(cross, 0.0, "triangle " + (t / 3) + " is wound backwards or degenerate");
            }
        }

        [Test]
        public void NothingCoversTheInsideOfAHole()
        {
            var outer = new List<Point2>
            {
                new Point2(-2, -1), new Point2(2, -1), new Point2(2, 1), new Point2(-2, 1),
            };
            var holes = new List<IList<Point2>> { Polygon2.Circle(0.0, 0.0, 0.5, 48, true) };

            List<Point2> vertices;
            List<int> triangles;
            Polygon2.Triangulate(outer, holes, out vertices, out triangles);

            // Sample well inside the hole so the polygon approximation cannot
            // account for a hit.
            for (int i = 0; i < 32; i++)
            {
                double angle = 2.0 * Math.PI * i / 32.0;
                var p = new Point2(0.4 * Math.Cos(angle), 0.4 * Math.Sin(angle));
                Assert.IsFalse(Covered(vertices, triangles, p), "hole is covered at sample " + i);
            }

            // And the cloth outside it is present.
            Assert.IsTrue(Covered(vertices, triangles, new Point2(-1.5, 0.6)));
            Assert.IsTrue(Covered(vertices, triangles, new Point2(1.5, -0.6)));
        }

        // ----------------------------------------------------------- the bed

        [Test]
        public void BedAreaIsTheFrameMinusSixPockets()
        {
            TableGeometry table = Table();
            MeshData mesh = TableMeshFactory.Bed(table);

            double hx = table.Length / 2.0 + TableMeshFactory.FrameDepth;
            double hy = table.Width / 2.0 + TableMeshFactory.FrameDepth;

            double holes = 0.0;
            foreach (Pocket pocket in table.Pockets)
            {
                double r = pocket.MouthRadius;
                holes += 0.5 * 32 * r * r * Math.Sin(2.0 * Math.PI / 32.0);
            }

            // Only the cloth face; the skirt and shafts are counted separately.
            double cloth = 0.0;
            for (int t = 0; t < mesh.TriangleCount; t++)
            {
                Vec3 n = Normal(mesh, t);
                if (n.Y <= 0.0 || Math.Abs(n.X) > 1e-12 || Math.Abs(n.Z) > 1e-12) continue;
                double ax, ay, az;
                mesh.Vertex(mesh.Indices[t * 3], out ax, out ay, out az);
                if (ay != 0.0) continue;
                cloth += 0.5 * n.Length;
            }

            Assert.AreEqual(4.0 * hx * hy - holes, cloth, 1e-6);
        }

        [Test]
        public void ClothFacesUpwards()
        {
            MeshData mesh = TableMeshFactory.Bed(Table());
            int upward = 0;

            for (int t = 0; t < mesh.TriangleCount; t++)
            {
                double ax, ay, az;
                mesh.Vertex(mesh.Indices[t * 3], out ax, out ay, out az);
                if (ay != 0.0) continue;

                Vec3 n = Normal(mesh, t);
                if (Math.Abs(n.X) > 1e-12 || Math.Abs(n.Z) > 1e-12) continue;

                Assert.Greater(n.Y, 0.0, "a cloth triangle is wound inside out");
                upward++;
            }

            Assert.Greater(upward, 100, "expected the cloth to be more than a handful of triangles");
        }

        [Test]
        public void BedHasNoDegenerateTriangles()
        {
            MeshData mesh = TableMeshFactory.Bed(Table());
            for (int t = 0; t < mesh.TriangleCount; t++)
            {
                Assert.Greater(Normal(mesh, t).Length, 1e-14, "degenerate triangle at " + t);
            }
        }

        [Test]
        public void BedIsPiercedExactlyWhereThePocketsAre()
        {
            TableGeometry table = Table();
            MeshData mesh = TableMeshFactory.Bed(table);

            // The shaft walls run from the mouth down to the pocket floor.
            double deepest = 0.0;
            for (int i = 0; i < mesh.VertexCount; i++)
            {
                double x, y, z;
                mesh.Vertex(i, out x, out y, out z);
                if (y < deepest) deepest = y;
            }
            Assert.AreEqual(-TableMeshFactory.PocketDepth, deepest, 1e-12);

            // No cloth vertex sits inside a pocket mouth.
            foreach (Pocket pocket in table.Pockets)
            {
                for (int i = 0; i < mesh.VertexCount; i++)
                {
                    double x, y, z;
                    mesh.Vertex(i, out x, out y, out z);
                    if (y != 0.0) continue;
                    double dx = x - pocket.Centre.X;
                    double dz = z - pocket.Centre.Y;
                    Assert.GreaterOrEqual(
                        Math.Sqrt(dx * dx + dz * dz),
                        pocket.MouthRadius - 1e-9,
                        "cloth vertex inside " + pocket.Id);
                }
            }
        }

        // ------------------------------------------------------- the cushions

        /// <summary>
        /// The whole reason the cushions are generated from
        /// <see cref="TableGeometry"/> rather than modelled: the visible nose
        /// and the line the simulation collides against have to be the same
        /// line, and at the same height, or the cushion physics is a lie.
        /// </summary>
        [Test]
        public void CushionNoseSitsOnTheLineThePhysicsUses()
        {
            TableGeometry table = Table();

            foreach (RailSegment rail in table.Rails)
            {
                MeshData mesh = TableMeshFactory.Cushion(rail);
                int onNose = 0;

                for (int i = 0; i < mesh.VertexCount; i++)
                {
                    double x, y, z;
                    mesh.Vertex(i, out x, out y, out z);
                    if (Math.Abs(y - PhysicsConstants.CushionHeight) > 1e-12) continue;

                    // Signed distance from the rail line, along its normal.
                    double gap = (x - rail.A.X) * rail.Normal.X + (z - rail.A.Y) * rail.Normal.Y;
                    Assert.AreEqual(0.0, gap, 1e-12, rail.Id + ": nose is off the collision line");
                    onNose++;
                }

                Assert.Greater(onNose, 0, rail.Id + ": no vertex at the nose height at all");
            }
        }

        [Test]
        public void CushionBodyLiesOutsideThePlayingArea()
        {
            TableGeometry table = Table();

            foreach (RailSegment rail in table.Rails)
            {
                MeshData mesh = TableMeshFactory.Cushion(rail);
                for (int i = 0; i < mesh.VertexCount; i++)
                {
                    double x, y, z;
                    mesh.Vertex(i, out x, out y, out z);
                    double gap = (x - rail.A.X) * rail.Normal.X + (z - rail.A.Y) * rail.Normal.Y;
                    Assert.LessOrEqual(gap, 1e-12, rail.Id + ": cushion overhangs the cloth");
                }
            }
        }

        [Test]
        public void CushionTopFacesUpAndItsFrontFacesTheTable()
        {
            TableGeometry table = Table();

            foreach (RailSegment rail in table.Rails)
            {
                MeshData mesh = TableMeshFactory.Cushion(rail);
                bool sawTop = false;
                bool sawFace = false;

                for (int t = 0; t < mesh.TriangleCount; t++)
                {
                    Vec3 n = Normal(mesh, t);
                    Assert.Greater(n.Length, 1e-14, rail.Id + ": degenerate cushion triangle");

                    double ax, ay, az;
                    mesh.Vertex(mesh.Indices[t * 3], out ax, out ay, out az);

                    // The flat top: every vertex at CushionTop.
                    if (Math.Abs(ay - TableMeshFactory.CushionTop) < 1e-12 && Math.Abs(n.Y) > 1e-9
                        && Math.Abs(n.X) < 1e-12 && Math.Abs(n.Z) < 1e-12)
                    {
                        Assert.Greater(n.Y, 0.0, rail.Id + ": cushion top is inside out");
                        sawTop = true;
                    }

                    // The face above the nose leans into the table.
                    double towards = n.X * rail.Normal.X + n.Z * rail.Normal.Y;
                    if (towards > 1e-9) sawFace = true;
                }

                Assert.IsTrue(sawTop, rail.Id + ": no upward-facing cushion top");
                Assert.IsTrue(sawFace, rail.Id + ": nothing on the cushion faces the playing area");
            }
        }

        [Test]
        public void EveryCushionSpansItsWholeSegment()
        {
            TableGeometry table = Table();

            foreach (RailSegment rail in table.Rails)
            {
                MeshData mesh = TableMeshFactory.Cushion(rail);
                double lowest = double.PositiveInfinity;
                double highest = double.NegativeInfinity;

                for (int i = 0; i < mesh.VertexCount; i++)
                {
                    double x, y, z;
                    mesh.Vertex(i, out x, out y, out z);
                    double s = (x - rail.A.X) * rail.Tangent.X + (z - rail.A.Y) * rail.Tangent.Y;
                    if (s < lowest) lowest = s;
                    if (s > highest) highest = s;
                }

                Assert.AreEqual(0.0, lowest, 1e-12, rail.Id);
                Assert.AreEqual(rail.Length, highest, 1e-12, rail.Id);
            }
        }

        /// <summary>
        /// Shading normals and winding have to agree. They are derived
        /// separately — the normal from the profile, the winding from the
        /// rail's handedness — so a mistake in either shows up as a surface
        /// that is lit as though it faced the other way, which reads as a
        /// black cushion under the overhead lamp.
        /// </summary>
        [Test]
        public void StoredNormalsAgreeWithWinding()
        {
            TableGeometry table = Table();
            var meshes = new List<MeshData> { TableMeshFactory.Bed(table) };
            foreach (RailSegment rail in table.Rails) meshes.Add(TableMeshFactory.Cushion(rail));

            for (int m = 0; m < meshes.Count; m++)
            {
                MeshData mesh = meshes[m];
                for (int t = 0; t < mesh.TriangleCount; t++)
                {
                    Vec3 geometric = Normal(mesh, t);
                    double length = geometric.Length;
                    Assert.Greater(length, 1e-14, "mesh " + m + " triangle " + t + " is degenerate");

                    int v = mesh.Indices[t * 3];
                    var stored = new Vec3(
                        mesh.Normals[v * 3], mesh.Normals[v * 3 + 1], mesh.Normals[v * 3 + 2]);
                    if (stored.LengthSquared < 1e-18) continue;

                    double alignment = Vec3.Dot(geometric, stored) / (length * stored.Length);
                    Assert.Greater(alignment, 0.0,
                        "mesh " + m + " triangle " + t + " is lit as though it faced backwards");
                }
            }
        }

        // ------------------------------------------------------------ helpers

        private static double TriangleArea(List<Point2> vertices, List<int> triangles)
        {
            double total = 0.0;
            for (int t = 0; t < triangles.Count; t += 3)
            {
                Point2 a = vertices[triangles[t]];
                Point2 b = vertices[triangles[t + 1]];
                Point2 c = vertices[triangles[t + 2]];
                total += 0.5 * Math.Abs((b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X));
            }
            return total;
        }

        private static bool Covered(List<Point2> vertices, List<int> triangles, Point2 p)
        {
            for (int t = 0; t < triangles.Count; t += 3)
            {
                Point2 a = vertices[triangles[t]];
                Point2 b = vertices[triangles[t + 1]];
                Point2 c = vertices[triangles[t + 2]];
                double d1 = Side(a, b, p);
                double d2 = Side(b, c, p);
                double d3 = Side(c, a, p);
                bool negative = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
                bool positive = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
                if (!(negative && positive)) return true;
            }
            return false;
        }

        private static double Side(Point2 a, Point2 b, Point2 p) =>
            (b.X - a.X) * (p.Y - a.Y) - (b.Y - a.Y) * (p.X - a.X);
    }
}

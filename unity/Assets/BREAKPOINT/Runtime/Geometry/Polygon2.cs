using System;
using System.Collections.Generic;

namespace Breakpoint.Geometry
{
    /// <summary>A point in the 2D plane a polygon is defined in.</summary>
    public struct Point2
    {
        public double X;
        public double Y;

        public Point2(double x, double y)
        {
            X = x;
            Y = y;
        }
    }

    /// <summary>
    /// Triangulation of a simple polygon with holes.
    ///
    /// This exists for one shape: the table bed, which is a rectangle with six
    /// pocket mouths punched through it. That detail is not decoration. With a
    /// solid slab the pocket throat is buried underneath and a "pocket" is a
    /// dark disc painted on cloth — the single loudest tell of a cheap-looking
    /// table. With a real hole you see down the throat and the ball disappears
    /// into it.
    ///
    /// The method is the standard one: bridge each hole into the outer contour
    /// to make a single (degenerate but simple) polygon, then ear-clip it.
    /// Holes are bridged in decreasing order of their rightmost vertex, which
    /// is what makes the mutual-visibility test on later holes see the earlier
    /// bridges and stay correct.
    ///
    /// It is here, in the engine-free assembly, because it is the one piece of
    /// mesh generation with enough arithmetic to be worth proving: the tests
    /// check the triangulated area against the closed-form area, check every
    /// triangle winds the same way, and sample points inside the holes to
    /// confirm nothing covers them.
    /// </summary>
    public static class Polygon2
    {
        private const double Epsilon = 1e-12;

        /// <summary>
        /// Triangulate <paramref name="outer"/> (counter-clockwise) with
        /// <paramref name="holes"/> (each clockwise). Returns index triples
        /// into the returned vertex list, which is the input contours merged.
        /// </summary>
        public static void Triangulate(
            IList<Point2> outer,
            IList<IList<Point2>> holes,
            out List<Point2> vertices,
            out List<int> triangles)
        {
            vertices = new List<Point2>(outer);
            triangles = new List<int>();
            if (vertices.Count < 3) return;

            var contour = new List<Point2>(outer);
            if (holes != null && holes.Count > 0)
            {
                contour = BridgeHoles(contour, holes);
            }

            vertices = contour;
            EarClip(contour, triangles);
        }

        /// <summary>A closed circle contour. <paramref name="clockwise"/> for holes.</summary>
        public static IList<Point2> Circle(double cx, double cy, double radius, int segments, bool clockwise)
        {
            var points = new List<Point2>(segments);
            for (int i = 0; i < segments; i++)
            {
                double t = 2.0 * Math.PI * i / segments;
                if (clockwise) t = -t;
                points.Add(new Point2(cx + radius * Math.Cos(t), cy + radius * Math.Sin(t)));
            }
            return points;
        }

        public static double SignedArea(IList<Point2> polygon)
        {
            double sum = 0.0;
            for (int i = 0, j = polygon.Count - 1; i < polygon.Count; j = i++)
            {
                sum += (polygon[j].X * polygon[i].Y) - (polygon[i].X * polygon[j].Y);
            }
            return sum * 0.5;
        }

        // ------------------------------------------------------------- bridging

        private static List<Point2> BridgeHoles(List<Point2> outer, IList<IList<Point2>> holes)
        {
            // Rightmost-first. A hole bridged later must be able to see the
            // bridges cut by earlier ones, and processing right to left is what
            // guarantees the ray cast below lands on an edge that is still part
            // of the contour.
            var ordered = new List<IList<Point2>>(holes);
            ordered.Sort(delegate (IList<Point2> a, IList<Point2> b)
            {
                return MaxX(b).CompareTo(MaxX(a));
            });

            List<Point2> contour = outer;
            for (int h = 0; h < ordered.Count; h++)
            {
                contour = BridgeOne(contour, ordered[h]);
            }
            return contour;
        }

        private static double MaxX(IList<Point2> polygon)
        {
            double best = double.NegativeInfinity;
            for (int i = 0; i < polygon.Count; i++)
            {
                if (polygon[i].X > best) best = polygon[i].X;
            }
            return best;
        }

        /// <summary>
        /// Splice one hole into the contour with a pair of coincident edges.
        ///
        /// Take M, the hole's rightmost vertex, and cast a ray from it along +x.
        /// The contour edge it first crosses tells us which region of the
        /// contour surrounds the hole; the bridge then runs from M to the best
        /// vertex of that edge. This is Eberly's construction.
        /// </summary>
        private static List<Point2> BridgeOne(List<Point2> contour, IList<Point2> hole)
        {
            int m = 0;
            for (int i = 1; i < hole.Count; i++)
            {
                if (hole[i].X > hole[m].X) m = i;
            }
            Point2 origin = hole[m];

            double bestT = double.PositiveInfinity;
            int bestEdge = -1;
            double hitY = 0.0;

            for (int i = 0, j = contour.Count - 1; i < contour.Count; j = i++)
            {
                Point2 a = contour[j];
                Point2 b = contour[i];
                // Only edges the ray can cross going right, and only those
                // straddling the ray's y.
                if (Math.Abs(b.Y - a.Y) < Epsilon) continue;
                double s = (origin.Y - a.Y) / (b.Y - a.Y);
                if (s < 0.0 || s > 1.0) continue;
                double x = a.X + s * (b.X - a.X);
                double t = x - origin.X;
                if (t < -Epsilon) continue;
                if (t < bestT)
                {
                    bestT = t;
                    bestEdge = j;
                    hitY = origin.Y;
                }
            }

            if (bestEdge < 0)
            {
                // Nothing to the right: the hole is outside the contour, which
                // means the caller handed us geometry that does not describe a
                // bed. Leaving the contour untouched keeps a broken table
                // visible rather than crashing the scene.
                return contour;
            }

            int next = (bestEdge + 1) % contour.Count;
            // Of the intersected edge's two ends, bridge to the one further
            // right — it is the one guaranteed visible from M.
            int p = contour[bestEdge].X >= contour[next].X ? bestEdge : next;
            p = ChooseVisible(contour, p, origin, origin.X + bestT, hitY);

            var merged = new List<Point2>(contour.Count + hole.Count + 2);
            for (int i = 0; i <= p; i++) merged.Add(contour[i]);
            for (int i = 0; i < hole.Count; i++) merged.Add(hole[(m + i) % hole.Count]);
            merged.Add(hole[m]);
            merged.Add(contour[p]);
            for (int i = p + 1; i < contour.Count; i++) merged.Add(contour[i]);
            return merged;
        }

        /// <summary>
        /// Reflex vertices of the contour can sit inside the triangle
        /// (M, hit point, P) and block the bridge. When any do, the visible
        /// vertex is the one of those with the smallest angle to the ray.
        /// </summary>
        private static int ChooseVisible(List<Point2> contour, int p, Point2 origin, double hitX, double hitY)
        {
            var a = origin;
            var b = new Point2(hitX, hitY);
            Point2 c = contour[p];

            int best = p;
            double bestAngle = double.PositiveInfinity;
            double bestDistance = double.PositiveInfinity;

            for (int i = 0; i < contour.Count; i++)
            {
                if (i == p) continue;
                Point2 q = contour[i];
                if (q.X <= origin.X) continue;
                if (!InTriangle(a, b, c, q) && !InTriangle(a, c, b, q)) continue;
                if (!IsReflex(contour, i)) continue;

                double dx = q.X - origin.X;
                double dy = q.Y - origin.Y;
                double distance = dx * dx + dy * dy;
                double angle = Math.Abs(dy) / Math.Sqrt(distance);
                if (angle < bestAngle || (angle == bestAngle && distance < bestDistance))
                {
                    bestAngle = angle;
                    bestDistance = distance;
                    best = i;
                }
            }
            return best;
        }

        private static bool IsReflex(List<Point2> contour, int i)
        {
            Point2 prev = contour[(i + contour.Count - 1) % contour.Count];
            Point2 here = contour[i];
            Point2 next = contour[(i + 1) % contour.Count];
            return Cross(prev, here, next) < 0.0;
        }

        // ------------------------------------------------------------ ear clip

        private static void EarClip(List<Point2> polygon, List<int> triangles)
        {
            int n = polygon.Count;
            if (n < 3) return;

            var indices = new List<int>(n);
            bool ccw = SignedArea(polygon) > 0.0;
            if (ccw)
            {
                for (int i = 0; i < n; i++) indices.Add(i);
            }
            else
            {
                for (int i = n - 1; i >= 0; i--) indices.Add(i);
            }

            // Every clip removes one vertex, so 2n iterations is generous; the
            // extra allowance absorbs the skips around the coincident bridge
            // edges, which are never ears.
            int guard = 2 * n;
            int cursor = 0;

            while (indices.Count > 3 && guard-- > 0)
            {
                int count = indices.Count;
                int i0 = indices[(cursor + count - 1) % count];
                int i1 = indices[cursor % count];
                int i2 = indices[(cursor + 1) % count];

                if (IsEar(polygon, indices, cursor))
                {
                    triangles.Add(i0);
                    triangles.Add(i1);
                    triangles.Add(i2);
                    indices.RemoveAt(cursor % count);
                    if (cursor >= indices.Count) cursor = 0;
                    guard = 2 * indices.Count + 8;
                }
                else
                {
                    cursor = (cursor + 1) % count;
                }
            }

            if (indices.Count == 3)
            {
                triangles.Add(indices[0]);
                triangles.Add(indices[1]);
                triangles.Add(indices[2]);
            }
        }

        private static bool IsEar(List<Point2> polygon, List<int> indices, int cursor)
        {
            int count = indices.Count;
            int i0 = indices[(cursor + count - 1) % count];
            int i1 = indices[cursor % count];
            int i2 = indices[(cursor + 1) % count];

            Point2 a = polygon[i0];
            Point2 b = polygon[i1];
            Point2 c = polygon[i2];

            // Convex, and with real area — the bridge doubles back on itself,
            // so zero-area candidates turn up and must not be accepted.
            double area = Cross(a, b, c);
            if (area <= Epsilon) return false;

            for (int k = 0; k < count; k++)
            {
                int index = indices[k];
                if (index == i0 || index == i1 || index == i2) continue;

                Point2 q = polygon[index];
                // Bridging a hole leaves two pairs of coincident vertices. A
                // point that *is* one of the corners passes a naive
                // containment test and blocks every ear touching the bridge,
                // which is how this triangulator returned nothing at all until
                // the coincidence was excluded.
                if (Coincident(q, a) || Coincident(q, b) || Coincident(q, c)) continue;

                if (InTriangle(a, b, c, q)) return false;
            }
            return true;
        }

        private static bool Coincident(Point2 a, Point2 b) =>
            Math.Abs(a.X - b.X) < 1e-12 && Math.Abs(a.Y - b.Y) < 1e-12;

        private static double Cross(Point2 a, Point2 b, Point2 c) =>
            (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);

        private static bool InTriangle(Point2 a, Point2 b, Point2 c, Point2 p)
        {
            double d1 = Cross(a, b, p);
            double d2 = Cross(b, c, p);
            double d3 = Cross(c, a, p);
            bool negative = d1 < -Epsilon || d2 < -Epsilon || d3 < -Epsilon;
            bool positive = d1 > Epsilon || d2 > Epsilon || d3 > Epsilon;
            return !(negative && positive);
        }
    }
}

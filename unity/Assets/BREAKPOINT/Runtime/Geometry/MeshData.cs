using System;
using System.Collections.Generic;

namespace Breakpoint.Geometry
{
    /// <summary>
    /// A mesh, as plain arrays.
    ///
    /// Deliberately not a UnityEngine.Mesh. Everything in this assembly is
    /// engine-free — see Breakpoint.Geometry.asmdef, "noEngineReferences" —
    /// so the table's geometry can be generated and tested by the standalone
    /// harness, without an editor, in CI. The presentation layer converts one
    /// of these into a real Mesh in a dozen lines; the interesting arithmetic
    /// all happens here where it can be checked.
    ///
    /// Positions are in the render frame (y up), because that is the frame the
    /// meshes will be handed to Unity in and converting once at the source is
    /// less error-prone than converting at every use.
    /// </summary>
    public sealed class MeshData
    {
        public readonly List<double> Positions = new List<double>();
        public readonly List<double> Normals = new List<double>();
        public readonly List<double> Uvs = new List<double>();
        public readonly List<int> Indices = new List<int>();

        public int VertexCount => Positions.Count / 3;
        public int TriangleCount => Indices.Count / 3;

        public int AddVertex(double x, double y, double z, double nx, double ny, double nz, double u, double v)
        {
            int index = VertexCount;
            Positions.Add(x); Positions.Add(y); Positions.Add(z);
            Normals.Add(nx); Normals.Add(ny); Normals.Add(nz);
            Uvs.Add(u); Uvs.Add(v);
            return index;
        }

        public void AddTriangle(int a, int b, int c)
        {
            Indices.Add(a); Indices.Add(b); Indices.Add(c);
        }

        public void AddQuad(int a, int b, int c, int d)
        {
            AddTriangle(a, b, c);
            AddTriangle(a, c, d);
        }

        /// <summary>Vertex position, for tests and for assembling composite meshes.</summary>
        public void Vertex(int index, out double x, out double y, out double z)
        {
            x = Positions[index * 3];
            y = Positions[index * 3 + 1];
            z = Positions[index * 3 + 2];
        }

        /// <summary>Total surface area. Used by the tests to prove the shape is right.</summary>
        public double SurfaceArea()
        {
            double total = 0.0;
            for (int t = 0; t < Indices.Count; t += 3)
            {
                double ax, ay, az, bx, by, bz, cx, cy, cz;
                Vertex(Indices[t], out ax, out ay, out az);
                Vertex(Indices[t + 1], out bx, out by, out bz);
                Vertex(Indices[t + 2], out cx, out cy, out cz);

                double ux = bx - ax, uy = by - ay, uz = bz - az;
                double vx = cx - ax, vy = cy - ay, vz = cz - az;
                double nx = uy * vz - uz * vy;
                double ny = uz * vx - ux * vz;
                double nz = ux * vy - uy * vx;
                total += 0.5 * Math.Sqrt(nx * nx + ny * ny + nz * nz);
            }
            return total;
        }
    }
}

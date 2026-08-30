using Breakpoint.Geometry;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// Turns engine-free <see cref="MeshData"/> into a Unity mesh.
    ///
    /// The narrowing to float happens here and only here. Table geometry is
    /// generated in double for the same reason the simulation runs in double —
    /// a millimetre of drift in a cushion nose is a physically wrong table —
    /// and is converted once, at the last possible moment, into the form the
    /// GPU wants.
    /// </summary>
    public static class MeshConverter
    {
        public static Mesh ToMesh(MeshData data, string name)
        {
            int count = data.VertexCount;
            var vertices = new Vector3[count];
            var normals = new Vector3[count];
            var uvs = new Vector2[count];

            for (int i = 0; i < count; i++)
            {
                vertices[i] = new Vector3(
                    (float)data.Positions[i * 3],
                    (float)data.Positions[i * 3 + 1],
                    (float)data.Positions[i * 3 + 2]);
                normals[i] = new Vector3(
                    (float)data.Normals[i * 3],
                    (float)data.Normals[i * 3 + 1],
                    (float)data.Normals[i * 3 + 2]);
                uvs[i] = new Vector2((float)data.Uvs[i * 2], (float)data.Uvs[i * 2 + 1]);
            }

            var mesh = new Mesh { name = name };
            // The bed comfortably exceeds 65k vertices once the pockets are
            // tessellated, so the 32-bit index buffer is not optional.
            mesh.indexFormat = count > 65000
                ? UnityEngine.Rendering.IndexFormat.UInt32
                : UnityEngine.Rendering.IndexFormat.UInt16;
            mesh.vertices = vertices;
            mesh.normals = normals;
            mesh.uv = uvs;
            mesh.triangles = data.Indices.ToArray();
            mesh.RecalculateTangents();
            mesh.RecalculateBounds();
            return mesh;
        }
    }
}

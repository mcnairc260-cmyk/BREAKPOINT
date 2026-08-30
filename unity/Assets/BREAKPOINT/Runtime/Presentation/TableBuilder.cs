using System.Collections.Generic;
using Breakpoint.Geometry;
using Breakpoint.Rendering;
using Breakpoint.Simulation;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// Assembles the table in the scene from the simulation's own geometry.
    ///
    /// Nothing here is a collider. The table a ball bounces off is
    /// <see cref="TableGeometry"/>, in the simulation; what this class builds is
    /// the picture of it. They cannot disagree, because the picture is generated
    /// from the same data — the cushion the player sees is extruded along the
    /// exact segment the physics measures against.
    ///
    /// The one exception is <see cref="ClothTarget"/>, which is a collider, and
    /// is used for exactly one thing: turning a screen tap into a table
    /// coordinate. That is input, not simulation. It never touches ball state.
    /// </summary>
    public sealed class TableBuilder
    {
        /// <summary>Layer-free raycast target covering the cushion-to-cushion rectangle.</summary>
        public Collider ClothTarget { get; private set; }

        public Transform Root { get; private set; }

        private readonly MaterialLibrary _materials;
        private readonly List<Mesh> _meshes = new List<Mesh>();

        public TableBuilder(MaterialLibrary materials)
        {
            _materials = materials;
        }

        public Transform Build(TableGeometry table, BreakpointTheme theme, Transform parent)
        {
            var root = new GameObject("Table").transform;
            root.SetParent(parent, false);
            Root = root;

            Material cloth = _materials.Surface("Cloth", theme.Cloth, 1f - theme.ClothRoughness, 0f);
            Material cushion = _materials.Surface("Cushion", theme.Cushion, 0.15f, 0.02f);
            Material wood = _materials.Surface("RailWood", theme.RailWood, 0.32f, 0.05f);
            Material trim = _materials.Surface("Trim", theme.MetalTrim, 1f - theme.TrimRoughness, theme.TrimMetallic);
            Material leather = _materials.Surface("PocketLeather", theme.PocketLeather, 0.25f, 0f);

            AddMesh(root, "Bed", TableMeshFactory.Bed(table), cloth, true, true);
            foreach (RailSegment rail in table.Rails)
            {
                AddMesh(root, "Cushion_" + rail.Id, TableMeshFactory.Cushion(rail), cushion, true, true);
            }

            BuildJaws(root, table, cushion);
            BuildRailCaps(root, table, wood);
            BuildSights(root, table, trim);
            BuildSkirt(root, table, wood);
            BuildPocketRings(root, table, leather);
            BuildClothTarget(root, table);

            return root;
        }

        private void AddMesh(
            Transform parent, string name, MeshData data, Material material,
            bool castShadows, bool receiveShadows)
        {
            Mesh mesh = MeshConverter.ToMesh(data, name);
            _meshes.Add(mesh);

            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var renderer = go.AddComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = castShadows
                ? UnityEngine.Rendering.ShadowCastingMode.On
                : UnityEngine.Rendering.ShadowCastingMode.Off;
            renderer.receiveShadows = receiveShadows;
        }

        /// <summary>
        /// The rounded cushion ends, drawn at exactly the circles the simulation
        /// bounces balls off. They share the cushion's colour: in liner black
        /// they read as free-standing posts rather than as the ends of the
        /// rubber, and it is the jaws that make a ball rattle instead of vanish.
        /// </summary>
        private static void BuildJaws(Transform parent, TableGeometry table, Material material)
        {
            foreach (Jaw jaw in table.Jaws)
            {
                var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                go.name = "Jaw_" + jaw.Id;
                Object.Destroy(go.GetComponent<Collider>());
                go.transform.SetParent(parent, false);
                // Unity's cylinder is 2 units tall and 1 unit across.
                go.transform.localScale = new Vector3(
                    (float)jaw.Radius * 2f,
                    (float)TableMeshFactory.CushionTop * 0.5f,
                    (float)jaw.Radius * 2f);
                go.transform.localPosition = TableFrame.Plane(
                    jaw.Centre, (float)TableMeshFactory.CushionTop * 0.5f);
                go.GetComponent<MeshRenderer>().sharedMaterial = material;
            }
        }

        /// <summary>
        /// One wooden cap per cushion, spanning the same stretch of rail and
        /// overhanging each end far enough to close against the pocket mouth.
        /// Building the frame as four continuous boxes instead would roof over
        /// every pocket, which is what makes a table look like a box with holes
        /// painted on it.
        /// </summary>
        private static void BuildRailCaps(Transform parent, TableGeometry table, Material material)
        {
            float capHeight = (float)TableMeshFactory.RailCapTop;
            float capDepth = (float)(TableMeshFactory.CushionDepth + TableMeshFactory.RailCapWidth);

            foreach (RailSegment rail in table.Rails)
            {
                var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                go.name = "RailCap_" + rail.Id;
                Object.Destroy(go.GetComponent<Collider>());
                go.transform.SetParent(parent, false);
                go.transform.localScale = new Vector3(
                    (float)(rail.Length + TableMeshFactory.CushionDepth * 3.2), capHeight, capDepth);

                var mid = new Vec2((rail.A.X + rail.B.X) / 2.0, (rail.A.Y + rail.B.Y) / 2.0);
                double back = TableMeshFactory.CushionDepth + capDepth / 2.0;
                var centre = new Vec2(mid.X - rail.Normal.X * back, mid.Y - rail.Normal.Y * back);

                go.transform.localPosition = TableFrame.Plane(centre, capHeight * 0.5f - 0.001f);
                go.transform.localRotation = Quaternion.Euler(
                    0f, -Mathf.Atan2((float)rail.Tangent.Y, (float)rail.Tangent.X) * Mathf.Rad2Deg, 0f);
                go.GetComponent<MeshRenderer>().sharedMaterial = material;
            }
        }

        /// <summary>
        /// Sight diamonds — the inlays players line bank shots up with. They
        /// cost almost nothing, and their absence is one of the loudest
        /// "programmer's table" signals there is.
        /// </summary>
        private static void BuildSights(Transform parent, TableGeometry table, Material material)
        {
            float capDepth = (float)(TableMeshFactory.CushionDepth + TableMeshFactory.RailCapWidth);
            double midX = table.Length / 2.0 + TableMeshFactory.CushionDepth + capDepth / 2.0;
            double midY = table.Width / 2.0 + TableMeshFactory.CushionDepth + capDepth / 2.0;
            float top = (float)TableMeshFactory.RailCapTop - 0.002f;

            foreach (int i in new[] { -3, -2, -1, 1, 2, 3 })
            {
                foreach (int sz in new[] { -1, 1 })
                {
                    AddSight(parent, material, new Vec2(i * table.Length / 8.0, sz * midY), top);
                }
            }
            foreach (int i in new[] { -1, 1 })
            {
                foreach (int sx in new[] { -1, 1 })
                {
                    AddSight(parent, material, new Vec2(sx * midX, i * table.Width / 4.0), top);
                }
            }
        }

        private static void AddSight(Transform parent, Material material, Vec2 at, float height)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = "Sight";
            Object.Destroy(go.GetComponent<Collider>());
            go.transform.SetParent(parent, false);
            go.transform.localScale = new Vector3(0.014f, 0.004f, 0.014f);
            go.transform.localPosition = TableFrame.Plane(at, height);
            go.transform.localRotation = Quaternion.Euler(0f, 45f, 0f);
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
        }

        /// <summary>The body below the slate. Plain, and mostly out of frame.</summary>
        private static void BuildSkirt(Transform parent, TableGeometry table, Material material)
        {
            double hx = table.Length / 2.0 + TableMeshFactory.FrameDepth;
            double hy = table.Width / 2.0 + TableMeshFactory.FrameDepth;

            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = "Skirt";
            Object.Destroy(go.GetComponent<Collider>());
            go.transform.SetParent(parent, false);
            go.transform.localScale = new Vector3((float)(hx * 2.0 - 0.01), 0.22f, (float)(hy * 2.0 - 0.01));
            go.transform.localPosition = new Vector3(
                0f, -(float)TableMeshFactory.BedDrop - 0.11f + 0.001f, 0f);
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
        }

        /// <summary>
        /// A flat liner ring lying on the cloth around each mouth. Flat, because
        /// a torus standing proud of the surface reads as a hoop rather than as
        /// the rim of a hole.
        /// </summary>
        private void BuildPocketRings(Transform parent, TableGeometry table, Material material)
        {
            foreach (Pocket pocket in table.Pockets)
            {
                var data = new MeshData();
                const int segments = 32;
                double inner = pocket.MouthRadius;
                double outer = pocket.MouthRadius + 0.009;

                var innerIndex = new int[segments + 1];
                var outerIndex = new int[segments + 1];
                for (int i = 0; i <= segments; i++)
                {
                    double t = 2.0 * Mathf.PI * i / segments;
                    double c = Mathf.Cos((float)t);
                    double s = Mathf.Sin((float)t);
                    double u = (double)i / segments;
                    innerIndex[i] = data.AddVertex(inner * c, 0.0, inner * s, 0.0, 1.0, 0.0, u, 0.0);
                    outerIndex[i] = data.AddVertex(outer * c, 0.0, outer * s, 0.0, 1.0, 0.0, u, 1.0);
                }
                for (int i = 0; i < segments; i++)
                {
                    // Clockwise read in (x, z) so the ring faces up. See the
                    // winding note on TableMeshFactory.
                    data.AddQuad(innerIndex[i], outerIndex[i], outerIndex[i + 1], innerIndex[i + 1]);
                }

                Mesh mesh = MeshConverter.ToMesh(data, "PocketRing");
                _meshes.Add(mesh);

                var go = new GameObject("PocketRing_" + pocket.Id);
                go.transform.SetParent(parent, false);
                go.transform.localPosition = TableFrame.Plane(pocket.Centre, 0.0006f);
                go.AddComponent<MeshFilter>().sharedMesh = mesh;
                var renderer = go.AddComponent<MeshRenderer>();
                renderer.sharedMaterial = material;
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            }
        }

        /// <summary>
        /// An invisible plane covering exactly the cushion-to-cushion rectangle,
        /// used as the ray target for tap-to-aim. It is a separate object from
        /// the bed so a tap can never land in a pocket throat or out on the rail
        /// and be read as a point on the cloth.
        /// </summary>
        private void BuildClothTarget(Transform parent, TableGeometry table)
        {
            var go = new GameObject("ClothTarget");
            go.transform.SetParent(parent, false);
            go.transform.localPosition = new Vector3(0f, 0.0004f, 0f);

            var box = go.AddComponent<BoxCollider>();
            box.size = new Vector3((float)table.Length, 0.001f, (float)table.Width);
            box.isTrigger = true;
            ClothTarget = box;
        }

        /// <summary>Release the generated meshes. Materials belong to the library.</summary>
        public void Dispose()
        {
            for (int i = 0; i < _meshes.Count; i++)
            {
                if (_meshes[i] == null) continue;
                if (Application.isPlaying) Object.Destroy(_meshes[i]);
                else Object.DestroyImmediate(_meshes[i]);
            }
            _meshes.Clear();
        }
    }
}

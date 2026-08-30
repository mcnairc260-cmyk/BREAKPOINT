using Breakpoint.Rendering;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// Lighting and the visible fixture.
    ///
    /// The look is a single low pendant lamp over a dark room, which is what a
    /// tournament table actually looks like and what both the DPA Brand Bible's
    /// dark-first design language and the approved art-direction reference ask
    /// for. Three pieces do the work:
    ///
    ///  • a shadow-casting spot standing in for the lamp, which is what makes
    ///    the balls sit *on* the cloth rather than float above it;
    ///  • two very dim rim lights, so the rails and the far side of each ball
    ///    are not solid black;
    ///  • ambient light whose ground term is the cloth colour, because the
    ///    underside of a ball on a real table is lit by light bouncing off the
    ///    baize, and without it every ball has a dead lower hemisphere.
    ///
    /// The rim lights are placed symmetrically about the long axis. Asymmetric
    /// rims make one cushion glow while the opposite one reads as broken
    /// geometry rather than as lighting.
    /// </summary>
    public sealed class SceneLighting
    {
        public const float FixtureHeight = 1.52f;

        /// <summary>
        /// The visible fixture. It hangs between an overhead camera and the
        /// table, so from the pulled-back view it is a black slab across the
        /// middle of the cloth; the bootstrap hides it whenever the camera
        /// climbs above it.
        /// </summary>
        public Transform Fixture { get; private set; }

        public Light Lamp { get; private set; }

        public void Build(MaterialLibrary materials, BreakpointTheme theme, float tableLength, Transform parent)
        {
            var root = new GameObject("Lighting").transform;
            root.SetParent(parent, false);

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.624f, 0.831f, 0.910f) * 0.30f;
            RenderSettings.ambientEquatorColor = BrandPalette.MidnightNavy * 0.5f;
            RenderSettings.ambientGroundColor = theme.Cloth * 0.30f;

            var lampObject = new GameObject("Lamp");
            lampObject.transform.SetParent(root, false);
            lampObject.transform.position = new Vector3(0f, 1.5f, 0f);
            lampObject.transform.rotation = Quaternion.Euler(90f, 0f, 0f);

            Lamp = lampObject.AddComponent<Light>();
            Lamp.type = LightType.Spot;
            Lamp.color = new Color(1f, 0.949f, 0.878f);
            Lamp.intensity = 17f;
            Lamp.range = 6f;
            Lamp.spotAngle = 133f;      // two of the reference's Math.PI / 2.7
            Lamp.innerSpotAngle = 46f;  // the reference's 0.65 penumbra, as an angle
            Lamp.shadows = LightShadows.Soft;
            Lamp.shadowBias = 0.006f;
            Lamp.shadowNormalBias = 0.012f;
            Lamp.shadowNearPlane = 0.4f;

            BuildFixture(materials, tableLength, root);
            BuildRim(root, "RimWarm", new Color(1f, 0.42f, 0.17f), 0.13f, new Vector3(-2.6f, 1.3f, -1.6f));
            BuildRim(root, "RimCool", new Color(0.133f, 0.827f, 0.933f), 0.11f, new Vector3(2.6f, 1.3f, 1.6f));
        }

        private void BuildFixture(MaterialLibrary materials, float tableLength, Transform parent)
        {
            var fixture = new GameObject("Fixture").transform;
            fixture.SetParent(parent, false);
            Fixture = fixture;

            // Emissive only — it does not light anything itself. Two lamps
            // would double-count and blow out the cloth.
            Material panel = materials.Surface("LampPanel", new Color(0.043f, 0.043f, 0.063f), 0.6f, 0f);
            panel.EnableKeyword("_EMISSION");
            panel.globalIlluminationFlags = MaterialGlobalIlluminationFlags.EmissiveIsBlack;
            if (panel.HasProperty("_EmissionColor"))
            {
                panel.SetColor("_EmissionColor", new Color(1f, 0.941f, 0.863f) * 2.4f);
            }

            Material shade = materials.Surface("LampShade", new Color(0.063f, 0.063f, 0.094f), 0.5f, 0.3f);

            Box(fixture, "Panel", panel,
                new Vector3(tableLength * 0.62f, 0.06f, 0.34f),
                new Vector3(0f, FixtureHeight, 0f));
            Box(fixture, "Shade", shade,
                new Vector3(tableLength * 0.66f, 0.12f, 0.4f),
                new Vector3(0f, FixtureHeight + 0.08f, 0f));
        }

        private static void Box(Transform parent, string name, Material material, Vector3 size, Vector3 at)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            Object.Destroy(go.GetComponent<Collider>());
            go.transform.SetParent(parent, false);
            go.transform.localScale = size;
            go.transform.localPosition = at;
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
        }

        private static void BuildRim(Transform parent, string name, Color color, float intensity, Vector3 from)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            go.transform.position = from;
            go.transform.rotation = Quaternion.LookRotation(-from.normalized, Vector3.up);

            var light = go.AddComponent<Light>();
            light.type = LightType.Directional;
            light.color = color;
            light.intensity = intensity;
            light.shadows = LightShadows.None;
        }
    }
}

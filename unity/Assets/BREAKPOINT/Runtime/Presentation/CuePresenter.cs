using Breakpoint.Rendering;
using Breakpoint.Simulation;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// The cue: where it points, how far it is drawn back, and where the tip
    /// sits on the ball.
    ///
    /// Every one of those three is read from the shot the player is composing,
    /// not invented for effect. The tip offset shown here is the same
    /// <c>tipX</c>/<c>tipY</c> that <see cref="SpinModel"/> turns into angular
    /// velocity, so a player who lines the tip up on the top of the ball sees
    /// the cue at the top of the ball and gets follow. Drawing the cue centred
    /// while applying spin would be exactly the "faked spin" this project is
    /// not allowed to ship.
    /// </summary>
    public sealed class CuePresenter
    {
        /// <summary>Gap between tip and ball when the cue is at rest.</summary>
        private const float IdleGap = 0.02f;

        /// <summary>How far back a full-power draw pulls the cue.</summary>
        private const float MaxPull = 0.34f;

        private const float ShaftLength = 1.45f;
        private const float ButtRadius = 0.0155f;
        private const float TipRadius = 0.0065f;

        private Transform _root;

        public Transform Root => _root;

        public void Build(MaterialLibrary materials, Transform parent)
        {
            _root = new GameObject("Cue").transform;
            _root.SetParent(parent, false);

            // Two tapered sections: pale maple shaft, dark stained butt with a
            // gold collar. This is the "Standard Maple" cue from the approved
            // reference sheet, built from primitives — see
            // BREAKPOINT_VISUAL_ASSET_MANIFEST.md for the authored replacement.
            Material shaftMaterial = materials.Surface(
                "CueShaft", new Color(0.847f, 0.741f, 0.545f), 0.55f, 0f);
            Material buttMaterial = materials.Surface(
                "CueButt", new Color(0.145f, 0.098f, 0.078f), 0.45f, 0.05f);
            Material collarMaterial = materials.Surface(
                "CueCollar", BrandPalette.Gold, 0.8f, 0.9f);
            Material ferruleMaterial = materials.Surface(
                "CueFerrule", new Color(0.933f, 0.925f, 0.898f), 0.7f, 0f);
            Material tipMaterial = materials.Surface(
                "CueTip", new Color(0.325f, 0.404f, 0.502f), 0.3f, 0f);

            Section(_root, "Tip", tipMaterial, TipRadius, 0.008f, 0f);
            Section(_root, "Ferrule", ferruleMaterial, TipRadius * 1.02f, 0.022f, 0.008f);
            Section(_root, "Shaft", shaftMaterial, TipRadius * 1.02f, ShaftLength * 0.55f, 0.030f);
            Section(_root, "Collar", collarMaterial, ButtRadius * 0.78f, 0.012f, 0.030f + ShaftLength * 0.55f);
            Section(_root, "Butt", buttMaterial, ButtRadius,
                ShaftLength * 0.45f, 0.042f + ShaftLength * 0.55f);
        }

        private static void Section(
            Transform parent, string name, Material material, float radius, float length, float from)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            go.name = name;
            Object.Destroy(go.GetComponent<Collider>());
            go.transform.SetParent(parent, false);
            // Unity's cylinder is 2 units tall along its own +Y; lay it along
            // the cue's local -Z, which points back from the tip.
            go.transform.localScale = new Vector3(radius * 2f, length * 0.5f, radius * 2f);
            go.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);
            go.transform.localPosition = new Vector3(0f, 0f, -(from + length * 0.5f));
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
        }

        /// <summary>
        /// Place the cue for the shot currently being composed.
        /// </summary>
        /// <param name="cueBall">Where the cue ball is, in table coordinates.</param>
        /// <param name="angle">Aim heading, radians.</param>
        /// <param name="power">Normalised power, 0..1 — how far back to draw.</param>
        /// <param name="tipX">Side spin offset, in ball radii.</param>
        /// <param name="tipY">Vertical spin offset, in ball radii.</param>
        public void Aim(Vec2 cueBall, double angle, float power, float tipX, float tipY)
        {
            if (_root == null) return;

            float radius = (float)PhysicsConstants.BallRadius;
            var forward = new Vector3(Mathf.Cos((float)angle), 0f, Mathf.Sin((float)angle));
            // Right-hand side of the aim line, on the cloth.
            var right = new Vector3(forward.z, 0f, -forward.x);

            float back = radius + IdleGap + Mathf.Clamp01(power) * MaxPull;
            Vector3 tip = TableFrame.Plane(cueBall, radius + tipY * radius)
                          - forward * back
                          + right * (tipX * radius);

            _root.position = tip;
            _root.rotation = Quaternion.LookRotation(forward, Vector3.up);
        }

        public void SetVisible(bool visible)
        {
            if (_root != null && _root.gameObject.activeSelf != visible)
            {
                _root.gameObject.SetActive(visible);
            }
        }
    }
}

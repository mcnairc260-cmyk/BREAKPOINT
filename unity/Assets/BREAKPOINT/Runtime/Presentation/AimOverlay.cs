using Breakpoint.Rendering;
using Breakpoint.Simulation;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// The aiming guides: the cue ball's path, the ghost ball, the object
    /// ball's line of centres, and the 90-degree tangent line.
    ///
    /// Drawn from <see cref="AimPredictor"/>, which is a straight geometric ray
    /// — deliberately not a simulation preview. A line that predicted curve,
    /// throw and spin would hand the player the answer; a straight line is the
    /// same information a real player reads off the table.
    ///
    /// Colours come from the brand palette rather than from the usual
    /// eye-searing overlay green: gold for the player's own line, silver for
    /// the object ball's, and a dimmer silver for the tangent. Gameplay
    /// readability outranks decoration, so all three sit above the cloth in
    /// value and none of them competes with a ball for attention.
    /// </summary>
    public sealed class AimOverlay
    {
        private const float Height = 0.0016f;
        private const float Width = 0.004f;

        private LineRenderer _cueLine;
        private LineRenderer _targetLine;
        private LineRenderer _tangentLine;
        private Transform _ghost;

        public void Build(MaterialLibrary materials, Transform parent)
        {
            var root = new GameObject("AimOverlay").transform;
            root.SetParent(parent, false);

            _cueLine = Line(root, "CueLine", materials.Flat("AimCue", Fade(BrandPalette.Gold, 0.85f)), Width);
            _targetLine = Line(root, "TargetLine", materials.Flat("AimTarget", Fade(BrandPalette.Silver, 0.7f)), Width);
            _tangentLine = Line(root, "TangentLine", materials.Flat("AimTangent", Fade(BrandPalette.Silver, 0.4f)), Width * 0.75f);

            var ghost = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            ghost.name = "GhostBall";
            Object.Destroy(ghost.GetComponent<Collider>());
            ghost.transform.SetParent(root, false);
            ghost.transform.localScale = Vector3.one * (float)(2.0 * PhysicsConstants.BallRadius);
            var renderer = ghost.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = materials.Flat("GhostBall", Fade(Color.white, 0.16f));
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            _ghost = ghost.transform;
        }

        private static Color Fade(Color color, float alpha)
        {
            color.a = alpha;
            return color;
        }

        private static LineRenderer Line(Transform parent, string name, Material material, float width)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var line = go.AddComponent<LineRenderer>();
            line.useWorldSpace = true;
            line.positionCount = 2;
            line.startWidth = width;
            line.endWidth = width;
            line.numCapVertices = 2;
            line.sharedMaterial = material;
            line.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            line.receiveShadows = false;
            // TransformZ makes the ribbon face the transform's own +Z rather
            // than the camera. Rotating -90° about X sends +Z to +Y, so the
            // line lies flat on the cloth facing up; camera-facing lines twist
            // as the camera eases between the aiming and watching poses.
            line.alignment = LineAlignment.TransformZ;
            go.transform.rotation = Quaternion.Euler(-90f, 0f, 0f);
            return line;
        }

        /// <summary>Redraw for the current aim, or hide everything if there is none.</summary>
        public void Show(PhysicsWorld world, double angle)
        {
            if (_cueLine == null) return;

            AimPrediction aim = AimPredictor.Predict(world, angle);
            BallBody cue = world == null ? null : world.CueBall;
            if (!aim.Valid || cue == null)
            {
                SetVisible(false);
                return;
            }

            _cueLine.enabled = true;
            _cueLine.SetPosition(0, TableFrame.Plane(cue.Position, Height));
            _cueLine.SetPosition(1, TableFrame.Plane(aim.End, Height));

            bool hasTarget = aim.Target != null;
            _ghost.gameObject.SetActive(hasTarget);
            _targetLine.enabled = hasTarget;
            _tangentLine.enabled = hasTarget;
            if (!hasTarget) return;

            _ghost.position = TableFrame.Plane(aim.Ghost, (float)PhysicsConstants.BallRadius);

            Vec2 from = aim.Target.Position;
            var to = new Vec2(
                from.X + aim.TargetDirection.X * 0.42,
                from.Y + aim.TargetDirection.Y * 0.42);
            _targetLine.SetPosition(0, TableFrame.Plane(from, Height));
            _targetLine.SetPosition(1, TableFrame.Plane(to, Height));

            var tangent = new Vec2(
                aim.Ghost.X + aim.CueTangent.X * 0.26,
                aim.Ghost.Y + aim.CueTangent.Y * 0.26);
            _tangentLine.SetPosition(0, TableFrame.Plane(aim.Ghost, Height));
            _tangentLine.SetPosition(1, TableFrame.Plane(tangent, Height));
        }

        public void SetVisible(bool visible)
        {
            if (_cueLine == null) return;
            _cueLine.enabled = visible;
            _targetLine.enabled = visible;
            _tangentLine.enabled = visible;
            _ghost.gameObject.SetActive(visible);
        }
    }
}

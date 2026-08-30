using Breakpoint.Simulation;
using UnityEngine;

namespace Breakpoint.Presentation
{
    /// <summary>
    /// The camera.
    ///
    /// Two framings, smoothly blended:
    ///
    ///  • AIMING — behind the cue ball, looking down the shot. This is what
    ///    makes aiming legible: the aim line runs away from the viewer, so a
    ///    small change in angle is a visible change on screen. A top-down view
    ///    makes aiming precise but flat, and a fixed three-quarter view makes
    ///    the player do the mental rotation on every shot.
    ///
    ///  • WATCHING — pulled up and back to take in the whole table while the
    ///    balls run, then eased back down for the next shot. That transition is
    ///    doing the cinematic work; nothing else needs to move.
    ///
    /// Elevation is a player control because the right height genuinely differs
    /// between a long straight pot (low, down the line) and a positional shot
    /// where you need to see the whole table (high).
    ///
    /// Ported from the TypeScript reference, including the portrait framing
    /// solve, which was written after mobile screenshots showed the fixed
    /// framing cropping half the table on a phone.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class GameCameraRig : MonoBehaviour
    {
        /// <summary>Vertical field of view, in degrees.</summary>
        public const float FieldOfView = 46f;

        /// <summary>Elevation the overview camera looks down from, radians (about 58°).</summary>
        private const float WatchElevation = 1.01f;

        private const float MinElevation = 0.16f;
        private const float MaxElevation = 1.25f;
        private const float MinDistance = 0.45f;
        private const float MaxDistance = 1.5f;

        /// <summary>Elevation of the aiming camera, radians above the cloth.</summary>
        public float Elevation = 0.52f;

        /// <summary>Distance behind the cue ball, metres.</summary>
        public float Distance = 1.02f;

        private Camera _camera;
        private TableGeometry _table;
        private float _blend;
        private Vector3 _position;
        private Vector3 _target;
        private bool _initialised;

        public Camera Camera => _camera;

        public void Bind(Camera camera, TableGeometry table)
        {
            _camera = camera;
            _table = table;
            _camera.fieldOfView = FieldOfView;
            _camera.nearClipPlane = 0.02f;
            _camera.farClipPlane = 60f;
            Reset();
        }

        public void AdjustElevation(float delta)
        {
            Elevation = Mathf.Clamp(Elevation + delta, MinElevation, MaxElevation);
        }

        public void AdjustDistance(float factor)
        {
            Distance = Mathf.Clamp(Distance * factor, MinDistance, MaxDistance);
        }

        /// <summary>Snap to the current pose — used on the first frame and after a reset.</summary>
        public void Reset()
        {
            _initialised = false;
            _blend = 0f;
        }

        /// <summary>
        /// Advance the camera one frame.
        ///
        /// <paramref name="watching"/> drives the blend rather than setting the
        /// pose, so the camera keeps easing even when a shot ends mid
        /// transition — it never snaps.
        /// </summary>
        public void Advance(Vec2 cueBall, double aimAngle, bool watching, float deltaTime)
        {
            if (_camera == null || _table == null) return;

            float targetBlend = watching ? 1f : 0f;
            // Frame-rate independent easing. The camera is presentation only,
            // so unlike the simulation it is free to depend on wall-clock time.
            float k = 1f - Mathf.Exp(-deltaTime * (watching ? 2.4f : 3.6f));
            _blend += (targetBlend - _blend) * k;

            Vector3 aimPosition, aimTarget;
            AimingPose(cueBall, aimAngle, out aimPosition, out aimTarget);

            Vector3 watchPosition, watchTarget;
            WatchingPose(out watchPosition, out watchTarget);

            Vector3 desiredPosition = Vector3.Lerp(aimPosition, watchPosition, _blend);
            Vector3 desiredTarget = Vector3.Lerp(aimTarget, watchTarget, _blend);

            if (!_initialised)
            {
                _position = desiredPosition;
                _target = desiredTarget;
                _initialised = true;
            }
            else
            {
                float follow = 1f - Mathf.Exp(-deltaTime * 9f);
                _position = Vector3.Lerp(_position, desiredPosition, follow);
                _target = Vector3.Lerp(_target, desiredTarget, follow);
            }

            _camera.transform.position = _position;
            _camera.transform.rotation = Quaternion.LookRotation(
                (_target - _position).normalized, Vector3.up);
        }

        private void AimingPose(Vec2 cueBall, double aimAngle, out Vector3 position, out Vector3 target)
        {
            float dirX = Mathf.Cos((float)aimAngle);
            float dirZ = Mathf.Sin((float)aimAngle);
            float back = Distance * Mathf.Cos(Elevation);
            float up = Distance * Mathf.Sin(Elevation);
            float radius = (float)PhysicsConstants.BallRadius;

            position = new Vector3(
                (float)cueBall.X - dirX * back,
                radius + up,
                (float)cueBall.Y - dirZ * back);

            // Look a little ahead of the ball rather than at it, so the aim
            // line has room on screen instead of running off the bottom edge.
            const float lookAhead = 0.42f;
            target = new Vector3(
                (float)cueBall.X + dirX * lookAhead,
                radius,
                (float)cueBall.Y + dirZ * lookAhead);

            // Never let the camera drop below the rail cap or clip the table.
            if (position.y < 0.14f) position.y = 0.14f;
        }

        /// <summary>
        /// The overview the camera pulls back to while the balls run.
        ///
        /// The framing is computed rather than fixed, because a fixed one does
        /// not survive a phone. Unity expresses field of view vertically, so on
        /// a tall narrow screen the horizontal field collapses: a distance
        /// chosen to fit the table in landscape shows only a patch of cloth in
        /// portrait, and the player cannot see the shot they just took — which
        /// is the entire purpose of this pose.
        ///
        /// Two things fix it. The table is turned to lie along the long axis of
        /// the screen, so a portrait phone views it end-on and a landscape
        /// screen views it side-on; and the distance is solved from both the
        /// horizontal and the vertical field, so whichever is tighter decides.
        /// </summary>
        private void WatchingPose(out Vector3 position, out Vector3 target)
        {
            float aspect = _camera.aspect;
            bool portrait = aspect < 1f;

            // Half-extents as they appear on screen. The margin is deliberately
            // wider than the rail: a fit flush against the frame edge has the
            // far corners clipping in and out as the camera eases into place.
            const float margin = 0.26f;
            float halfAcross = (float)(portrait ? _table.Width : _table.Length) / 2f + margin;
            float halfUp = (float)(portrait ? _table.Length : _table.Width) / 2f + margin;

            float tanHalfFov = Mathf.Tan(FieldOfView * Mathf.Deg2Rad * 0.5f);

            // The near edge of the table sits this much closer to the camera
            // than the centre does, and perspective makes it the widest thing
            // on screen. Fitting to the centre distance alone leaves the near
            // corners hanging off the sides, so the constraint is written at
            // the near edge and the offset added back.
            float nearEdge = halfUp * Mathf.Cos(WatchElevation);
            float forWidth = halfAcross / (tanHalfFov * aspect) + nearEdge;
            // The table lies flat, so its extent up the screen is foreshortened
            // by the viewing elevation; dividing by the sine stops a low camera
            // from cropping the far end.
            float forHeight = halfUp / (tanHalfFov * Mathf.Sin(WatchElevation)) + nearEdge;
            float distance = Mathf.Max(forWidth, forHeight);

            float horizontal = distance * Mathf.Cos(WatchElevation);
            float height = distance * Mathf.Sin(WatchElevation);

            position = portrait
                ? new Vector3(-horizontal, height, 0f)
                : new Vector3(0f, height, -horizontal);
            target = Vector3.zero;
        }
    }
}

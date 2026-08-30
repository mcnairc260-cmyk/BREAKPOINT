using System;
using Breakpoint.Presentation;
using Breakpoint.Simulation;
using UnityEngine;
using UnityEngine.EventSystems;

namespace Breakpoint.Input
{
    /// <summary>What the input layer is asking the game to do. Intent, not state.</summary>
    public interface IShotIntents
    {
        /// <summary>Relative aim change, radians.</summary>
        void RotateAim(double delta);

        /// <summary>Relative camera elevation change, radians.</summary>
        void AdjustElevation(float delta);

        /// <summary>Multiply camera distance (pinch or wheel).</summary>
        void Zoom(float factor);

        /// <summary>Absolute aim at a table point.</summary>
        void AimAt(Vec2 tablePoint);

        /// <summary>Live pull-back, 0..1, called continuously during the gesture.</summary>
        void SetPull(float pull);

        /// <summary>Release the cue: fire at this power, or cancel when null.</summary>
        void ReleasePull(float? power);

        /// <summary>Cue tip contact point in ball radii, already inside the unit disc.</summary>
        void SetTip(float x, float y);

        /// <summary>Any contact at all — used to unlock audio on platforms that need a gesture.</summary>
        void AnyInteraction();
    }

    /// <summary>
    /// The input model.
    ///
    /// One layer handles mouse, touch and pen identically. "Desktop mouse
    /// controls use the same underlying input model" is a requirement, and the
    /// way to actually guarantee it is to have no separate mouse path at all —
    /// so this reads pointer position and pointer-down, and nothing else.
    ///
    /// Three gestures, separated by where they start rather than by device:
    ///
    ///   • on the table  — drag horizontally to rotate aim, vertically to raise
    ///                     or lower the camera; a tap without drag aims there
    ///   • on the cue pad— pull *back* to load power, release to shoot; sliding
    ///                     back to zero and lifting cancels the shot
    ///   • on the spin dial — drag to place the cue tip on the ball face
    ///
    /// The pull-back gesture is the touch-first one: it is the same motion as
    /// drawing a real cue back, it is self-cancelling, and it needs no second
    /// hand. Ported from the TypeScript reference's PointerControls.
    ///
    /// This class produces intents. It never touches simulation state, and the
    /// only thing it can eventually cause is one <see cref="ShotInput"/> — which
    /// <see cref="SimulationRunner.Strike"/> is still free to refuse.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class ShotInputSource : MonoBehaviour
    {
        /// <summary>How far a drag may travel and still count as a tap.</summary>
        private const float TapSlop = 8f;

        /// <summary>Screen pixels of horizontal drag for a full turn of aim.</summary>
        private const float AimPixelsPerTurn = 1400f;

        /// <summary>Screen pixels of vertical drag for the full elevation range.</summary>
        private const float ElevationPixels = 900f;

        /// <summary>Pull distance in pixels corresponding to full power.</summary>
        private const float FullPowerPixels = 220f;

        private enum Zone
        {
            None,
            Table,
            Cue,
            Spin,
        }

        private IShotIntents _intents;
        private Camera _camera;
        private Collider _clothTarget;
        private RectTransform _cuePad;
        private RectTransform _spinDial;

        private Zone _zone = Zone.None;
        private Vector2 _start;
        private Vector2 _last;
        private float _travelled;
        private bool _down;

        /// <summary>True while a pull-back gesture is loading a shot.</summary>
        public bool IsPulling => _zone == Zone.Cue;

        public void Bind(
            IShotIntents intents,
            Camera camera,
            Collider clothTarget,
            RectTransform cuePad,
            RectTransform spinDial)
        {
            _intents = intents;
            _camera = camera;
            _clothTarget = clothTarget;
            _cuePad = cuePad;
            _spinDial = spinDial;
        }

        private void Update()
        {
            if (_intents == null || _camera == null) return;

            Vector2 position = PointerPosition();
            bool pressed = PointerPressed();

            if (pressed && !_down) Begin(position);
            else if (pressed) Drag(position);
            else if (_down) End(position);

            _down = pressed;

            float wheel = UnityEngine.Input.mouseScrollDelta.y;
            if (Mathf.Abs(wheel) > 0.01f) _intents.Zoom(Mathf.Exp(-wheel * 0.12f));
        }

        private void Begin(Vector2 position)
        {
            _start = position;
            _last = position;
            _travelled = 0f;
            _zone = ZoneAt(position);
            _intents.AnyInteraction();

            if (_zone == Zone.Spin) ApplySpin(position);
            else if (_zone == Zone.Cue) _intents.SetPull(0f);
        }

        private void Drag(Vector2 position)
        {
            Vector2 delta = position - _last;
            _last = position;
            _travelled += delta.magnitude;

            switch (_zone)
            {
                case Zone.Table:
                    // Horizontal drag turns the shot; vertical drag raises the
                    // camera. Opposite signs on purpose: dragging right should
                    // swing the aim right, and dragging up should look down.
                    _intents.RotateAim(-delta.x * (2.0 * Math.PI / AimPixelsPerTurn));
                    _intents.AdjustElevation(delta.y * (1.09f / ElevationPixels));
                    break;

                case Zone.Cue:
                    _intents.SetPull(PullFrom(position));
                    break;

                case Zone.Spin:
                    ApplySpin(position);
                    break;
            }
        }

        private void End(Vector2 position)
        {
            switch (_zone)
            {
                case Zone.Table:
                    if (_travelled <= TapSlop) AimAtScreen(position);
                    break;

                case Zone.Cue:
                    float power = PullFrom(position);
                    // Sliding back to nothing and lifting is the cancel: a
                    // player who starts a shot they did not mean to take must
                    // always have a way out that does not fire the cue.
                    _intents.ReleasePull(power <= 0.02f ? (float?)null : power);
                    break;
            }

            _zone = Zone.None;
        }

        /// <summary>Pull distance measured *backwards* from where the gesture started.</summary>
        private float PullFrom(Vector2 position)
        {
            float pulled = _start.y - position.y;
            return Mathf.Clamp01(pulled / FullPowerPixels);
        }

        private void ApplySpin(Vector2 position)
        {
            if (_spinDial == null) return;

            Vector2 local;
            if (!RectTransformUtility.ScreenPointToLocalPointInRectangle(
                    _spinDial, position, UiCamera(), out local))
            {
                return;
            }

            Rect rect = _spinDial.rect;
            float x = local.x / (rect.width * 0.5f);
            float y = local.y / (rect.height * 0.5f);

            // Clamp onto the disc rather than the square, so a corner drag
            // reads as maximum spin in that direction instead of as more spin
            // than the tip could physically reach.
            float length = Mathf.Sqrt(x * x + y * y);
            if (length > 1f)
            {
                x /= length;
                y /= length;
            }
            _intents.SetTip(x, y);
        }

        /// <summary>
        /// Turn a screen point into a table coordinate.
        ///
        /// The ray is cast against the cloth collider, which covers exactly the
        /// cushion-to-cushion rectangle, so a tap can never land in a pocket
        /// throat or out on the rail and still be read as a point on the cloth.
        /// </summary>
        private void AimAtScreen(Vector2 position)
        {
            if (_clothTarget == null) return;

            Ray ray = _camera.ScreenPointToRay(position);
            RaycastHit hit;
            if (!_clothTarget.Raycast(ray, out hit, 100f)) return;

            _intents.AimAt(TableFrame.ToPlane(hit.point));
        }

        private Zone ZoneAt(Vector2 position)
        {
            if (Inside(_spinDial, position)) return Zone.Spin;
            if (Inside(_cuePad, position)) return Zone.Cue;
            // Anything over some other piece of UI is not a table gesture.
            if (EventSystem.current != null && EventSystem.current.IsPointerOverGameObject()) return Zone.None;
            return Zone.Table;
        }

        private bool Inside(RectTransform rect, Vector2 position) =>
            rect != null && RectTransformUtility.RectangleContainsScreenPoint(rect, position, UiCamera());

        private Camera UiCamera()
        {
            // Overlay canvases want a null camera; anything else wants the one
            // rendering them. Passing the wrong one silently offsets every hit
            // test, which is a miserable bug to find by hand.
            var canvas = _cuePad != null ? _cuePad.GetComponentInParent<Canvas>() : null;
            if (canvas == null || canvas.renderMode == RenderMode.ScreenSpaceOverlay) return null;
            return canvas.worldCamera;
        }

        private static Vector2 PointerPosition()
        {
            if (UnityEngine.Input.touchCount > 0) return UnityEngine.Input.GetTouch(0).position;
            return UnityEngine.Input.mousePosition;
        }

        private static bool PointerPressed()
        {
            if (UnityEngine.Input.touchCount > 0)
            {
                TouchPhase phase = UnityEngine.Input.GetTouch(0).phase;
                return phase != TouchPhase.Ended && phase != TouchPhase.Canceled;
            }
            return UnityEngine.Input.GetMouseButton(0);
        }
    }
}

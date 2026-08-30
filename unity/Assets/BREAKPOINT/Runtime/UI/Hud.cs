using System;
using Breakpoint.Rendering;
using UnityEngine;
using UnityEngine.UI;

namespace Breakpoint.UI
{
    /// <summary>
    /// The in-game overlay: power meter, spin dial, status line, and the two
    /// gesture pads the input layer hit-tests against.
    ///
    /// The HUD shows state and offers targets. It decides nothing — the power
    /// it displays is the power the input layer measured, and the shot it
    /// eventually causes still has to be accepted by the simulation runner.
    ///
    /// Two constraints from the brand and the reference sheet shape it: dark
    /// first, and gameplay readability over decoration. So the panels sit in
    /// the screen corners rather than over the cloth, the gold is used once
    /// (for the player's own power), and nothing animates while a shot is in
    /// flight except the things that are actually changing.
    /// </summary>
    public sealed class Hud
    {
        private Canvas _canvas;
        private Image _powerFill;
        private RectTransform _spinMarker;
        private Text _status;
        private CanvasGroup _controls;

        /// <summary>The pull-back pad. Input hit-tests against this rect.</summary>
        public RectTransform CuePad { get; private set; }

        /// <summary>The spin dial. Input hit-tests against this rect.</summary>
        public RectTransform SpinDial { get; private set; }

        public Canvas Canvas => _canvas;

        public void Build(Transform parent)
        {
            _canvas = UiFactory.CreateCanvas("HUD", parent);
            var root = (RectTransform)_canvas.transform;

            _controls = _canvas.gameObject.AddComponent<CanvasGroup>();

            BuildStatus(root);
            BuildPowerMeter(root);
            BuildSpinDial(root);
        }

        private void BuildStatus(RectTransform root)
        {
            RectTransform holder = UiFactory.CreateRect("Status", root);
            holder.anchorMin = holder.anchorMax = new Vector2(0.5f, 1f);
            holder.pivot = new Vector2(0.5f, 1f);
            holder.anchoredPosition = new Vector2(0f, -UiTokens.SpaceLg);
            holder.sizeDelta = new Vector2(720f, 40f);

            _status = UiFactory.AddLabel(
                holder, "", BrandPalette.TextSecondary, UiTokens.TextLabel, TextAnchor.MiddleCenter);
            UiFactory.Stretch((RectTransform)_status.transform, 0f, 0f, 1f, 1f);
        }

        /// <summary>
        /// The power meter doubles as the pull-back pad. Putting the readout
        /// under the thumb that is drawing the cue is the whole point: a meter
        /// on the far side of the screen is a meter nobody looks at.
        /// </summary>
        private void BuildPowerMeter(RectTransform root)
        {
            RectTransform pad = UiFactory.Panel("CuePad", root, UiTokens.RadiusMd);
            pad.anchorMin = pad.anchorMax = new Vector2(1f, 0f);
            pad.pivot = new Vector2(1f, 0f);
            pad.anchoredPosition = new Vector2(-UiTokens.SpaceLg, UiTokens.SpaceLg);
            pad.sizeDelta = new Vector2(92f, 320f);
            CuePad = pad;

            RectTransform track = UiFactory.CreateRect("Track", pad);
            UiFactory.Stretch(track, 0f, 0f, 1f, 1f);
            track.offsetMin = new Vector2(UiTokens.SpaceMd, UiTokens.SpaceMd);
            track.offsetMax = new Vector2(-UiTokens.SpaceMd, -UiTokens.SpaceXl);
            UiFactory.AddRoundedImage(track, BrandPalette.SurfaceRecessed, UiTokens.RadiusSm);

            RectTransform fill = UiFactory.CreateRect("Fill", track);
            fill.anchorMin = new Vector2(0f, 0f);
            fill.anchorMax = new Vector2(1f, 0f);
            fill.pivot = new Vector2(0.5f, 0f);
            fill.offsetMin = Vector2.zero;
            fill.offsetMax = Vector2.zero;
            fill.sizeDelta = new Vector2(0f, 0f);
            _powerFill = UiFactory.AddRoundedImage(fill, BrandPalette.Gold, UiTokens.RadiusSm);

            Text label = UiFactory.AddLabel(
                pad, "POWER", BrandPalette.TextSecondary, UiTokens.TextLabel, TextAnchor.UpperCenter);
            var labelRect = (RectTransform)label.transform;
            UiFactory.Stretch(labelRect, 0f, 0f, 1f, 1f);
            labelRect.offsetMin = new Vector2(0f, 0f);
            labelRect.offsetMax = new Vector2(0f, -UiTokens.SpaceMd);
        }

        /// <summary>
        /// The spin dial: a ball face with a marker showing where the tip will
        /// land. It is the same offset the physics uses, so what the player
        /// sets is what the ball gets.
        /// </summary>
        private void BuildSpinDial(RectTransform root)
        {
            RectTransform dial = UiFactory.CreateRect("SpinDial", root);
            dial.anchorMin = dial.anchorMax = new Vector2(0f, 0f);
            dial.pivot = new Vector2(0f, 0f);
            dial.anchoredPosition = new Vector2(UiTokens.SpaceLg, UiTokens.SpaceLg);
            dial.sizeDelta = new Vector2(132f, 132f);
            SpinDial = dial;

            Image face = UiFactory.AddImage(dial, new Color(0.945f, 0.941f, 0.902f));
            face.sprite = UiSprites.Circle();
            face.type = Image.Type.Simple;

            RectTransform marker = UiFactory.CreateRect("Marker", dial);
            marker.anchorMin = marker.anchorMax = new Vector2(0.5f, 0.5f);
            marker.pivot = new Vector2(0.5f, 0.5f);
            marker.sizeDelta = new Vector2(22f, 22f);
            marker.anchoredPosition = Vector2.zero;
            Image markerImage = UiFactory.AddImage(marker, BrandPalette.Crimson);
            markerImage.sprite = UiSprites.Circle();
            markerImage.type = Image.Type.Simple;
            _spinMarker = marker;
        }

        /// <summary>Show a pull-back of 0..1.</summary>
        public void SetPower(float power)
        {
            if (_powerFill == null) return;
            var rect = (RectTransform)_powerFill.transform;
            rect.anchorMax = new Vector2(1f, Mathf.Clamp01(power));
            rect.offsetMax = new Vector2(0f, 0f);
        }

        /// <summary>Move the spin marker to a tip offset in ball radii.</summary>
        public void SetTip(float x, float y)
        {
            if (_spinMarker == null) return;
            RectTransform dial = SpinDial;
            _spinMarker.anchoredPosition = new Vector2(
                x * dial.sizeDelta.x * 0.5f * 0.82f,
                y * dial.sizeDelta.y * 0.5f * 0.82f);
        }

        public void SetStatus(string message)
        {
            if (_status != null) _status.text = message == null ? "" : message.ToUpperInvariant();
        }

        /// <summary>
        /// Dim and disable the controls while the balls are running.
        ///
        /// Presentation only. The simulation refuses a second shot on its own —
        /// see <see cref="Presentation.SimulationRunner.Strike"/> — so a HUD
        /// that forgot to lock would look wrong but could not break the game.
        /// </summary>
        public void SetInteractable(bool interactable)
        {
            if (_controls == null) return;
            _controls.interactable = interactable;
            _controls.alpha = interactable ? 1f : 0.45f;
        }
    }
}

using Breakpoint.Rendering;
using UnityEngine;
using UnityEngine.UI;

namespace Breakpoint.UI
{
    /// <summary>
    /// Builders for the interface pieces the reference sheet defines.
    ///
    /// A *foundation*, deliberately: a premium panel, a primary and secondary
    /// button, a status banner, a player panel, an icon button and a modal
    /// frame, all built from the same tokens and the same palette. No screens
    /// are assembled here and no game flow is implied — Phase A is not
    /// gameplay. What exists is the vocabulary the later screens will be
    /// written in, so they do not each invent their own spacing.
    ///
    /// Everything is built in code from Unity's own sprites. Authored art (see
    /// BREAKPOINT_VISUAL_ASSET_MANIFEST.md) drops in by swapping the sprite on
    /// each Image; the layout does not change when it does.
    ///
    /// Rounded corners come from Unity's built-in "UISprite" in sliced mode,
    /// which is a fixed radius. Where the tokens ask for a different radius the
    /// sprite is scaled by pixels-per-unit rather than by stretching, so the
    /// corner stays circular instead of turning into an ellipse.
    /// </summary>
    public static class UiFactory
    {
        /// <summary>Unity's built-in rounded sprite; the radius it draws at.</summary>
        private const float BuiltInRadius = 10f;

        public static Canvas CreateCanvas(string name, Transform parent)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);

            var canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;

            var scaler = go.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = UiTokens.ReferenceResolution;
            // Match height, not width: the table is framed vertically and the
            // HUD has to keep its relationship to it on a tall phone screen.
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 1f;

            go.AddComponent<GraphicRaycaster>();
            return canvas;
        }

        public static RectTransform CreateRect(string name, Transform parent)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            return (RectTransform)go.transform;
        }

        /// <summary>
        /// A raised panel: dark surface, a hairline bevel at the top edge and a
        /// darker one at the bottom. That pair of one-pixel lines is most of
        /// what separates a surface that looks machined from a flat grey box.
        /// </summary>
        public static RectTransform Panel(string name, Transform parent, float radius)
        {
            RectTransform rect = CreateRect(name, parent);
            AddRoundedImage(rect, BrandPalette.SurfaceRaised, radius);

            RectTransform top = CreateRect("BevelTop", rect);
            Stretch(top, 0f, 1f, 1f, 1f);
            top.sizeDelta = new Vector2(0f, 1f);
            top.anchoredPosition = Vector2.zero;
            AddImage(top, BrandPalette.BevelLight);

            RectTransform bottom = CreateRect("BevelBottom", rect);
            Stretch(bottom, 0f, 0f, 1f, 0f);
            bottom.sizeDelta = new Vector2(0f, 1f);
            bottom.anchoredPosition = Vector2.zero;
            AddImage(bottom, BrandPalette.BevelDark);

            return rect;
        }

        /// <summary>
        /// The gold primary action, as on the reference sheet's PLAY button.
        /// Dark ink on gold rather than white: white on this gold fails
        /// contrast, and the reference does not use it.
        /// </summary>
        public static Button PrimaryButton(string name, Transform parent, string label)
        {
            return MakeButton(name, parent, label, BrandPalette.Gold, BrandPalette.TextOnGold, UiTokens.RadiusMd);
        }

        /// <summary>The quiet action: a dark surface with a silver label.</summary>
        public static Button SecondaryButton(string name, Transform parent, string label)
        {
            return MakeButton(name, parent, label, BrandPalette.Surface, BrandPalette.TextPrimary, UiTokens.RadiusMd);
        }

        /// <summary>The one destructive action. Crimson, and used sparingly.</summary>
        public static Button DangerButton(string name, Transform parent, string label)
        {
            return MakeButton(name, parent, label, BrandPalette.Crimson, BrandPalette.TextPrimary, UiTokens.RadiusMd);
        }

        /// <summary>A square button holding a glyph rather than a word.</summary>
        public static Button IconButton(string name, Transform parent, string glyph)
        {
            Button button = MakeButton(name, parent, glyph, BrandPalette.Surface, BrandPalette.TextPrimary, UiTokens.RadiusSm);
            var rect = (RectTransform)button.transform;
            rect.sizeDelta = new Vector2(UiTokens.TouchTarget, UiTokens.TouchTarget);

            Text text = button.GetComponentInChildren<Text>();
            text.fontSize = Mathf.RoundToInt(UiTokens.TextBody);
            return button;
        }

        private static Button MakeButton(
            string name, Transform parent, string label, Color fill, Color ink, float radius)
        {
            RectTransform rect = CreateRect(name, parent);
            rect.sizeDelta = new Vector2(240f, UiTokens.ButtonHeight);
            Image image = AddRoundedImage(rect, fill, radius);

            var button = rect.gameObject.AddComponent<Button>();
            button.targetGraphic = image;

            var colors = button.colors;
            colors.normalColor = Color.white;
            colors.highlightedColor = new Color(1.08f, 1.08f, 1.08f, 1f);
            colors.pressedColor = new Color(0.88f, 0.88f, 0.88f, 1f);
            colors.disabledColor = new Color(1f, 1f, 1f, 0.35f);
            colors.fadeDuration = 0.08f;
            button.colors = colors;

            Text text = AddLabel(rect, label, ink, UiTokens.TextLabel, TextAnchor.MiddleCenter);
            Stretch((RectTransform)text.transform, 0f, 0f, 1f, 1f);

            return button;
        }

        /// <summary>
        /// The status banner — VICTORY, FOUL, NICE SHOT, PERFECT BREAK on the
        /// reference sheet. One component, four accents, so the wording and the
        /// colour cannot drift apart across screens.
        /// </summary>
        public static RectTransform StatusBanner(string name, Transform parent, string message, Color accent)
        {
            RectTransform rect = Panel(name, parent, UiTokens.RadiusSm);
            rect.sizeDelta = new Vector2(420f, UiTokens.BannerHeight);

            RectTransform stripe = CreateRect("Accent", rect);
            Stretch(stripe, 0f, 0f, 0f, 1f);
            stripe.sizeDelta = new Vector2(4f, 0f);
            stripe.anchoredPosition = Vector2.zero;
            stripe.pivot = new Vector2(0f, 0.5f);
            AddImage(stripe, accent);

            Text text = AddLabel(rect, message, accent, UiTokens.TextBody, TextAnchor.MiddleLeft);
            var textRect = (RectTransform)text.transform;
            Stretch(textRect, 0f, 0f, 1f, 1f);
            textRect.offsetMin = new Vector2(UiTokens.SpaceLg, 0f);
            textRect.offsetMax = new Vector2(-UiTokens.SpaceMd, 0f);

            return rect;
        }

        /// <summary>
        /// A player's name, ball group and score. Built now because the layout
        /// constrains the HUD — not because any of it is wired to rules, which
        /// belong to a later phase.
        /// </summary>
        public static RectTransform PlayerPanel(string name, Transform parent, string playerName, bool active)
        {
            RectTransform rect = Panel(name, parent, UiTokens.RadiusMd);
            rect.sizeDelta = new Vector2(280f, 88f);

            Text label = AddLabel(rect, playerName.ToUpperInvariant(),
                active ? BrandPalette.Gold : BrandPalette.TextSecondary,
                UiTokens.TextLabel, TextAnchor.UpperLeft);
            var labelRect = (RectTransform)label.transform;
            Stretch(labelRect, 0f, 0f, 1f, 1f);
            labelRect.offsetMin = new Vector2(UiTokens.SpaceMd, UiTokens.SpaceSm);
            labelRect.offsetMax = new Vector2(-UiTokens.SpaceMd, -UiTokens.SpaceSm);

            return rect;
        }

        /// <summary>A dimmed backdrop with a panel on it. The shape every dialogue takes.</summary>
        public static RectTransform ModalFrame(string name, Transform parent, Vector2 size)
        {
            RectTransform scrim = CreateRect(name, parent);
            Stretch(scrim, 0f, 0f, 1f, 1f);
            scrim.offsetMin = Vector2.zero;
            scrim.offsetMax = Vector2.zero;
            AddImage(scrim, new Color(0f, 0f, 0f, 0.72f));

            RectTransform panel = Panel("Panel", scrim, UiTokens.RadiusLg);
            panel.anchorMin = panel.anchorMax = new Vector2(0.5f, 0.5f);
            panel.pivot = new Vector2(0.5f, 0.5f);
            panel.anchoredPosition = Vector2.zero;
            panel.sizeDelta = size;
            return panel;
        }

        // ------------------------------------------------------------ plumbing

        public static Text AddLabel(
            RectTransform parent, string content, Color color, float size, TextAnchor anchor)
        {
            RectTransform rect = CreateRect("Label", parent);
            var text = rect.gameObject.AddComponent<Text>();
            text.text = content;
            text.color = color;
            text.fontSize = Mathf.RoundToInt(size);
            text.alignment = anchor;
            text.horizontalOverflow = HorizontalWrapMode.Overflow;
            text.verticalOverflow = VerticalWrapMode.Overflow;
            text.raycastTarget = false;
            text.font = DefaultFont();
            return text;
        }

        public static Image AddImage(RectTransform rect, Color color)
        {
            var image = rect.gameObject.AddComponent<Image>();
            image.color = color;
            return image;
        }

        public static Image AddRoundedImage(RectTransform rect, Color color, float radius)
        {
            var image = rect.gameObject.AddComponent<Image>();
            image.color = color;
            Sprite sprite = RoundedSprite();
            if (sprite != null)
            {
                image.sprite = sprite;
                image.type = Image.Type.Sliced;
                // Sliced corners scale with pixels-per-unit rather than being
                // stretched, so the radius stays a circle at any size.
                image.pixelsPerUnitMultiplier = Mathf.Max(0.05f, BuiltInRadius / Mathf.Max(radius, 1f));
            }
            return image;
        }

        /// <summary>Anchor a rect to a fraction of its parent.</summary>
        public static void Stretch(RectTransform rect, float minX, float minY, float maxX, float maxY)
        {
            rect.anchorMin = new Vector2(minX, minY);
            rect.anchorMax = new Vector2(maxX, maxY);
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
        }

        private static Sprite _rounded;
        private static bool _roundedLooked;

        private static Sprite RoundedSprite()
        {
            if (_roundedLooked) return _rounded;
            _roundedLooked = true;
            // Present in every Unity install that has the UI package; a null
            // here means square corners, which is a downgrade rather than a
            // failure, so it is not worth an error.
            _rounded = Resources.GetBuiltinResource<Sprite>("UI/Skin/UISprite.psd");
            return _rounded;
        }

        private static Font _font;

        private static Font DefaultFont()
        {
            if (_font == null)
            {
                // LegacyRuntime.ttf in Unity 2022+, Arial.ttf before that. The
                // production typeface is a font asset that has yet to be
                // licensed — see BREAKPOINT_VISUAL_ASSET_MANIFEST.md.
                _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
                if (_font == null) _font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            }
            return _font;
        }
    }
}

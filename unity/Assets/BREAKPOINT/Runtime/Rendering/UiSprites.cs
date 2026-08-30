using UnityEngine;

namespace Breakpoint.Rendering
{
    /// <summary>
    /// Small generated sprites the interface needs before any art exists.
    ///
    /// Only shapes that must be *correct* rather than decorative live here. The
    /// spin dial in particular has to be a circle: it represents the face of
    /// the cue ball, and the tip offset is clamped onto a disc, so a square
    /// dial would show reachable positions in its corners that the cue cannot
    /// physically reach without miscuing.
    ///
    /// Authored art replaces these; see BREAKPOINT_VISUAL_ASSET_MANIFEST.md.
    /// </summary>
    public static class UiSprites
    {
        private static Sprite _circle;

        /// <summary>A soft-edged white disc, tinted by whatever draws it.</summary>
        public static Sprite Circle()
        {
            if (_circle != null) return _circle;

            const int size = 256;
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, true, false);
            texture.name = "UiCircle";
            texture.wrapModeU = TextureWrapMode.Clamp;
            texture.wrapModeV = TextureWrapMode.Clamp;

            var pixels = new Color32[size * size];
            const float centre = size * 0.5f;
            const float radius = centre - 1f;

            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float dx = x + 0.5f - centre;
                    float dy = y + 0.5f - centre;
                    // One-pixel feather: a hard-edged disc aliases badly once
                    // the dial is scaled down on a phone.
                    float coverage = Mathf.Clamp01(radius - Mathf.Sqrt(dx * dx + dy * dy));
                    pixels[y * size + x] = new Color32(255, 255, 255, (byte)(coverage * 255f));
                }
            }

            texture.SetPixels32(pixels);
            texture.Apply(true, false);

            _circle = Sprite.Create(
                texture, new Rect(0f, 0f, size, size), new Vector2(0.5f, 0.5f), 100f);
            _circle.name = "UiCircle";
            return _circle;
        }
    }
}

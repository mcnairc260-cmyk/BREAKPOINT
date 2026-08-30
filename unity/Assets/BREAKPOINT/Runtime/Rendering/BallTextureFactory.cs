using UnityEngine;

namespace Breakpoint.Rendering
{
    /// <summary>
    /// Ball albedo maps, drawn into textures at load time.
    ///
    /// No image files: a pool ball is a solid or a stripe plus two numbered
    /// circles, which is far better expressed as a few hundred pixel writes
    /// than as sixteen PNGs to ship, cache and colour-manage. The layout is
    /// equirectangular so a UV sphere puts the stripe around the equator and
    /// the two number spots on opposite sides, exactly like a real ball.
    ///
    /// Digits are drawn from a small hand-built 5x7 bitmap font rather than
    /// from a Unity font asset. That keeps the generator free of any asset
    /// dependency, makes it deterministic across platforms, and avoids
    /// depending on a font whose licence would have to be cleared before the
    /// game ships. The result is legible at the size a ball is actually seen.
    ///
    /// Ported in behaviour, not in code, from the TypeScript reference's
    /// canvas-drawn textures (src/render/BallTextures.ts).
    /// </summary>
    public static class BallTextureFactory
    {
        private const int Width = 512;
        private const int Height = 256;

        /// <summary>The stripe band, as a fraction of texture height.</summary>
        private const float StripeTop = 0.28f;
        private const float StripeBottom = 0.72f;

        /// <summary>Number spot radius, as a fraction of texture height.</summary>
        private const float SpotRadius = 0.19f;

        public static Texture2D Create(int number)
        {
            var texture = new Texture2D(Width, Height, TextureFormat.RGBA32, true, false);
            texture.name = "BallAlbedo_" + number;
            texture.wrapModeU = TextureWrapMode.Repeat;
            texture.wrapModeV = TextureWrapMode.Clamp;
            texture.filterMode = FilterMode.Bilinear;
            texture.anisoLevel = 8;

            Color32 color = BallSet.ColorOf(number);
            bool striped = BallSet.IsStripe(number);
            var pixels = new Color32[Width * Height];

            for (int y = 0; y < Height; y++)
            {
                float v = (y + 0.5f) / Height;
                bool inBand = v >= StripeTop && v <= StripeBottom;
                Color32 row = striped && !inBand ? BallSet.Ivory : color;
                for (int x = 0; x < Width; x++) pixels[y * Width + x] = row;
            }

            if (number > 0)
            {
                // Two number spots, half a turn apart, as on a real ball.
                DrawSpot(pixels, Width * 0.25f, Height * 0.5f, number);
                DrawSpot(pixels, Width * 0.75f, Height * 0.5f, number);
            }
            else
            {
                // The cue ball's red spots — the only way to read its spin.
                var red = new Color32(0xC4, 0x3B, 0x2F, 0xFF);
                DrawDisc(pixels, Width * 0.25f, Height * 0.5f, Height * 0.055f, red);
                DrawDisc(pixels, Width * 0.75f, Height * 0.5f, Height * 0.055f, red);
            }

            texture.SetPixels32(pixels);
            texture.Apply(true, false);
            return texture;
        }

        private static void DrawSpot(Color32[] pixels, float cx, float cy, int number)
        {
            float r = Height * SpotRadius;
            DrawDisc(pixels, cx, cy, r, BallSet.Ivory);
            DrawNumber(pixels, cx, cy, r, number);
        }

        private static void DrawDisc(Color32[] pixels, float cx, float cy, float radius, Color32 fill)
        {
            int x0 = Mathf.Max(0, Mathf.FloorToInt(cx - radius) - 1);
            int x1 = Mathf.Min(Width - 1, Mathf.CeilToInt(cx + radius) + 1);
            int y0 = Mathf.Max(0, Mathf.FloorToInt(cy - radius) - 1);
            int y1 = Mathf.Min(Height - 1, Mathf.CeilToInt(cy + radius) + 1);

            for (int y = y0; y <= y1; y++)
            {
                for (int x = x0; x <= x1; x++)
                {
                    float dx = x + 0.5f - cx;
                    float dy = y + 0.5f - cy;
                    // One-pixel feather, so the spot edge does not crawl when
                    // the ball rolls.
                    float coverage = Mathf.Clamp01(radius + 0.5f - Mathf.Sqrt(dx * dx + dy * dy));
                    if (coverage <= 0f) continue;
                    int i = y * Width + x;
                    pixels[i] = Color32.Lerp(pixels[i], fill, coverage);
                }
            }
        }

        /// <summary>
        /// Draw the ball number centred on a spot, using <see cref="Digits"/>.
        /// Two-digit numbers are drawn narrower so 10-15 still fit the spot.
        /// </summary>
        private static void DrawNumber(Color32[] pixels, float cx, float cy, float radius, int number)
        {
            string text = number.ToString();
            float scale = radius / (text.Length > 1 ? 5.6f : 3.6f);
            float glyphWidth = 5f * scale;
            float gap = scale;
            float totalWidth = text.Length * glyphWidth + (text.Length - 1) * gap;
            float penX = cx - totalWidth * 0.5f;
            float top = cy - 3.5f * scale;

            for (int c = 0; c < text.Length; c++)
            {
                int digit = text[c] - '0';
                DrawGlyph(pixels, penX, top, scale, digit);
                penX += glyphWidth + gap;
            }
        }

        private static void DrawGlyph(Color32[] pixels, float left, float top, float scale, int digit)
        {
            if (digit < 0 || digit > 9) return;
            byte[] rows = Digits[digit];

            for (int row = 0; row < 7; row++)
            {
                byte bits = rows[row];
                for (int col = 0; col < 5; col++)
                {
                    if ((bits & (1 << (4 - col))) == 0) continue;
                    FillCell(pixels, left + col * scale, top + row * scale, scale);
                }
            }
        }

        private static void FillCell(Color32[] pixels, float left, float top, float size)
        {
            int x0 = Mathf.Max(0, Mathf.FloorToInt(left));
            int x1 = Mathf.Min(Width - 1, Mathf.CeilToInt(left + size));
            int y0 = Mathf.Max(0, Mathf.FloorToInt(top));
            int y1 = Mathf.Min(Height - 1, Mathf.CeilToInt(top + size));

            for (int y = y0; y <= y1; y++)
            {
                float cover = Overlap(y, y + 1f, top, top + size);
                if (cover <= 0f) continue;
                for (int x = x0; x <= x1; x++)
                {
                    float a = cover * Overlap(x, x + 1f, left, left + size);
                    if (a <= 0f) continue;
                    int i = y * Width + x;
                    pixels[i] = Color32.Lerp(pixels[i], BallSet.Ink, Mathf.Clamp01(a));
                }
            }
        }

        private static float Overlap(float a0, float a1, float b0, float b1) =>
            Mathf.Max(0f, Mathf.Min(a1, b1) - Mathf.Max(a0, b0));

        /// <summary>
        /// A 5x7 bitmap font, digits only. Each byte is one row, high bit left.
        /// Hand-set so the strokes stay even at the size a number spot occupies.
        /// </summary>
        private static readonly byte[][] Digits =
        {
            new byte[] { 0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E }, // 0
            new byte[] { 0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E }, // 1
            new byte[] { 0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F }, // 2
            new byte[] { 0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E }, // 3
            new byte[] { 0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02 }, // 4
            new byte[] { 0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E }, // 5
            new byte[] { 0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E }, // 6
            new byte[] { 0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08 }, // 7
            new byte[] { 0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E }, // 8
            new byte[] { 0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C }, // 9
        };
    }
}

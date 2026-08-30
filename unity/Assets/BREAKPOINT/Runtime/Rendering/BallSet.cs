using UnityEngine;

namespace Breakpoint.Rendering
{
    /// <summary>
    /// The sixteen balls: colours and stripe/solid classification.
    ///
    /// Carried over unchanged from the TypeScript reference
    /// (src/config/brand.ts), which in turn matches the ball row on the
    /// approved art-direction sheet. The cue ball is deliberately a warm
    /// off-white rather than pure white so it still takes shading under the
    /// low-key lighting the reference calls for — a pure-white ball reads as a
    /// flat disc and loses its spin cues.
    ///
    /// These are the *reference* colours. Production ball art (see
    /// BREAKPOINT_VISUAL_ASSET_MANIFEST.md) will replace the generated textures
    /// with authored ones; the numbers here stay as the fallback and as the
    /// definition of which ball is which.
    /// </summary>
    public static class BallSet
    {
        public const int Count = 16;

        private static readonly Color32[] Colors =
        {
            new Color32(0xF2, 0xF0, 0xE6, 0xFF), // cue — warm white
            new Color32(0xF5, 0xC5, 0x18, 0xFF), // 1 yellow
            new Color32(0x1F, 0x5F, 0xD0, 0xFF), // 2 blue
            new Color32(0xD9, 0x3A, 0x2B, 0xFF), // 3 red
            new Color32(0x6D, 0x3F, 0xA8, 0xFF), // 4 purple
            new Color32(0xF0, 0x7A, 0x1F, 0xFF), // 5 orange
            new Color32(0x1E, 0x7A, 0x4A, 0xFF), // 6 green
            new Color32(0x7D, 0x27, 0x33, 0xFF), // 7 maroon
            new Color32(0x14, 0x14, 0x1A, 0xFF), // 8 black
            new Color32(0xF5, 0xC5, 0x18, 0xFF), // 9 yellow stripe
            new Color32(0x1F, 0x5F, 0xD0, 0xFF), // 10 blue stripe
            new Color32(0xD9, 0x3A, 0x2B, 0xFF), // 11 red stripe
            new Color32(0x6D, 0x3F, 0xA8, 0xFF), // 12 purple stripe
            new Color32(0xF0, 0x7A, 0x1F, 0xFF), // 13 orange stripe
            new Color32(0x1E, 0x7A, 0x4A, 0xFF), // 14 green stripe
            new Color32(0x7D, 0x27, 0x33, 0xFF), // 15 maroon stripe
        };

        /// <summary>Ivory used for the stripe field and the number spots.</summary>
        public static readonly Color32 Ivory = new Color32(0xF6, 0xF4, 0xEC, 0xFF);

        /// <summary>Ink used for the printed number.</summary>
        public static readonly Color32 Ink = new Color32(0x11, 0x11, 0x16, 0xFF);

        public static Color32 ColorOf(int number) =>
            number >= 0 && number < Colors.Length ? Colors[number] : Colors[0];

        public static bool IsStripe(int number) => number >= 9 && number <= 15;
    }
}

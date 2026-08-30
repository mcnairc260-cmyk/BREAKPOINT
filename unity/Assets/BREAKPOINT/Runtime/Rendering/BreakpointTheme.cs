using UnityEngine;

namespace Breakpoint.Rendering
{
    /// <summary>
    /// A swappable visual theme for the table and its furniture.
    ///
    /// The reference sheet shows three table themes — Emerald Classic, Midnight
    /// Elite, Crimson Royale — differing only in cloth and trim. Making that a
    /// ScriptableObject means a theme is data, so future artwork can replace a
    /// placeholder without touching gameplay or simulation code, and a cosmetics
    /// system can be built later by adding assets rather than by editing logic.
    ///
    /// **No cosmetics system is implemented.** This is the seam it will attach
    /// to, nothing more.
    /// </summary>
    [CreateAssetMenu(menuName = "BREAKPOINT/Table Theme", fileName = "TableTheme")]
    public sealed class BreakpointTheme : ScriptableObject
    {
        [Header("Identity")]
        public string DisplayName = "Emerald Classic";

        [Header("Cloth")]
        [Tooltip("Baize colour. Ball readability is judged against this, so it stays dark and desaturated.")]
        public Color Cloth = new Color(0.059f, 0.243f, 0.180f, 1f);

        [Range(0f, 1f)]
        public float ClothRoughness = 0.95f;

        [Header("Rails")]
        [Tooltip("Rail cap. The sheet shows dark rosewood over obsidian, not bare timber.")]
        public Color RailWood = new Color(0.129f, 0.086f, 0.063f, 1f);

        [Tooltip("Cushion rubber face, kept close to the cloth so the nose does not read as a stripe.")]
        public Color Cushion = new Color(0.047f, 0.196f, 0.145f, 1f);

        [Header("Trim")]
        [Tooltip("Metal inlay and sight diamonds.")]
        public Color MetalTrim = new Color(0.831f, 0.686f, 0.216f, 1f);

        [Range(0f, 1f)]
        public float TrimMetallic = 0.9f;

        [Range(0f, 1f)]
        public float TrimRoughness = 0.25f;

        [Header("Pockets")]
        [Tooltip("Leather pocket casting.")]
        public Color PocketLeather = new Color(0.055f, 0.051f, 0.047f, 1f);

        /// <summary>The default, matching "Emerald Classic" on the reference sheet.</summary>
        public static BreakpointTheme CreateDefault()
        {
            var theme = CreateInstance<BreakpointTheme>();
            theme.DisplayName = "Emerald Classic";
            theme.Cloth = BrandPalette.Emerald;
            theme.RailWood = new Color(0.129f, 0.086f, 0.063f, 1f);
            theme.Cushion = new Color(0.055f, 0.216f, 0.161f, 1f);
            theme.MetalTrim = BrandPalette.Gold;
            theme.PocketLeather = new Color(0.055f, 0.051f, 0.047f, 1f);
            return theme;
        }
    }
}

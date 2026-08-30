using UnityEngine;

namespace Breakpoint.UI
{
    /// <summary>
    /// The measurements the interface is built from.
    ///
    /// Tokens, not magic numbers, for the usual reason: a premium interface
    /// reads as premium mostly because its spacing and corner radii are
    /// consistent, and consistency is far easier to keep when there is one
    /// place to change. The scale is a 4 px grid, matching the proportions in
    /// the approved art-direction reference.
    ///
    /// Sizes are in reference pixels at a 1080-tall canvas; the canvas scaler
    /// does the rest, so these hold on a phone and on a desktop monitor.
    /// </summary>
    public static class UiTokens
    {
        public const float SpaceXs = 4f;
        public const float SpaceSm = 8f;
        public const float SpaceMd = 16f;
        public const float SpaceLg = 24f;
        public const float SpaceXl = 40f;

        public const float RadiusSm = 6f;
        public const float RadiusMd = 12f;
        public const float RadiusLg = 20f;
        public const float RadiusPill = 999f;

        /// <summary>Minimum comfortable touch target. Below this, phones get frustrating.</summary>
        public const float TouchTarget = 48f;

        public const float ButtonHeight = 56f;
        public const float BannerHeight = 64f;

        public const float TextBody = 22f;
        public const float TextLabel = 16f;
        public const float TextTitle = 34f;
        public const float TextDisplay = 56f;

        /// <summary>
        /// Letter-spacing for the all-caps labels the reference uses
        /// throughout. Caps without tracking read as shouting; caps with
        /// tracking read as engraved, which is the intended register.
        /// </summary>
        public const float CapsTracking = 8f;

        /// <summary>Design canvas the tokens are calibrated against.</summary>
        public static readonly Vector2 ReferenceResolution = new Vector2(1920f, 1080f);
    }
}

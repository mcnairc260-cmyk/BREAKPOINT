using UnityEngine;

namespace Breakpoint.Rendering
{
    /// <summary>
    /// The BREAKPOINT visual tokens, transcribed from the approved art-direction
    /// reference at
    /// <c>Assets/BREAKPOINT/Art/Reference/BREAKPOINT_DPA_ArtDirection_Master.png</c>.
    ///
    /// The reference sheet states its palette explicitly, in hex, so these are
    /// read off it rather than interpreted. Nothing else in the project may
    /// hard-code a brand colour; everything reads from here or from a
    /// <see cref="BreakpointTheme"/> built on top of it.
    ///
    /// ## Relationship to the DPA master palette
    ///
    /// This is *not* the same palette as the Dragon Phoenix Ascension Brand
    /// Bible §5, and the difference is deliberate rather than a mistake:
    ///
    ///   DPA master        BREAKPOINT sheet
    ///   Void Black  #0A0A0F   Obsidian    #0A0A0A   — effectively the same ground
    ///   Ember       #FF6B2C   (absent)              — no ember in the product palette
    ///   Gold        #FFB300   Gold        #D4AF37   — antique/metallic rather than fire
    ///   Cyan        #22D3EE   (absent)              — replaced by Silver as the cool accent
    ///
    /// The BREAKPOINT sheet reads as forged metal — gold and silver on obsidian —
    /// where the DPA master reads as fire. Both are dark, cinematic and
    /// single-light-source, which is the shared DNA; the metallics are what make
    /// BREAKPOINT its own premium product rather than a DPA skin.
    ///
    /// **This divergence has not been reconciled and is not resolved here.** It
    /// is recorded in the visual style specification for a decision.
    /// </summary>
    public static class BrandPalette
    {
        private static Color Hex(string hex)
        {
            ColorUtility.TryParseHtmlString(hex, out Color color);
            return color;
        }

        // --- Stated palette, straight off the reference sheet -----------------

        /// <summary>Metallic gold. The primary accent: frames, trim, the mark.</summary>
        public static readonly Color Gold = Hex("#D4AF37");

        /// <summary>Silver. The secondary accent, and the alternate logo lockup.</summary>
        public static readonly Color Silver = Hex("#C0C0C0");

        /// <summary>Deep crimson. Destructive and foul states; the Crimson Royale cloth.</summary>
        public static readonly Color Crimson = Hex("#8B1E1E");

        /// <summary>Midnight navy. The Midnight Elite cloth, and cool panel washes.</summary>
        public static readonly Color MidnightNavy = Hex("#0E1A2B");

        /// <summary>Deep emerald. The Emerald Classic cloth — the default table.</summary>
        public static readonly Color Emerald = Hex("#0F3E2E");

        /// <summary>Obsidian. The ground everything sits on.</summary>
        public static readonly Color Obsidian = Hex("#0A0A0A");

        // --- Derived surface tones -------------------------------------------
        //
        // The sheet shows depth through recessed panels and beveled frames rather
        // than through flat fills, so a single "panel colour" is not enough. These
        // are the steps that treatment needs, derived from Obsidian so the whole
        // interface stays one material family.

        /// <summary>Raised panel face — a control you could press.</summary>
        public static readonly Color SurfaceRaised = new Color(0.113f, 0.117f, 0.129f, 1f);

        /// <summary>Default panel face.</summary>
        public static readonly Color Surface = new Color(0.078f, 0.082f, 0.094f, 1f);

        /// <summary>Recessed well — the inside of a frame, behind a raised control.</summary>
        public static readonly Color SurfaceRecessed = new Color(0.043f, 0.047f, 0.055f, 1f);

        /// <summary>Hairline highlight along a top bevel.</summary>
        public static readonly Color BevelLight = new Color(1f, 1f, 1f, 0.10f);

        /// <summary>Hairline shadow along a bottom bevel.</summary>
        public static readonly Color BevelDark = new Color(0f, 0f, 0f, 0.55f);

        // --- Text -------------------------------------------------------------

        public static readonly Color TextPrimary = new Color(0.957f, 0.957f, 0.961f, 1f);
        public static readonly Color TextSecondary = new Color(0.545f, 0.545f, 0.600f, 1f);
        public static readonly Color TextOnGold = Hex("#141414");

        // --- Status colours, from the banner row on the sheet -----------------

        /// <summary>VICTORY.</summary>
        public static readonly Color StatusVictory = Gold;

        /// <summary>FOUL / BALL IN HAND.</summary>
        public static readonly Color StatusFoul = Hex("#8B1E1E");

        /// <summary>NICE SHOT.</summary>
        public static readonly Color StatusInfo = Hex("#2E5F8A");

        /// <summary>PERFECT BREAK.</summary>
        public static readonly Color StatusSuccess = Hex("#1E6B4A");
    }
}

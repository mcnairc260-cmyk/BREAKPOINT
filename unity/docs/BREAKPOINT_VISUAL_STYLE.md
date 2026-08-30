# BREAKPOINT — Visual Style Specification

Derived from the approved art-direction reference at
`Assets/BREAKPOINT/Art/Reference/BREAKPOINT_DPA_ArtDirection_Master.png`.

That sheet is the **visual-direction oracle**. Where this document and the
sheet disagree, the sheet wins. Where the sheet is silent, this document is
the extrapolation, and says so.

---

## 1. The one-line brief

> Premium. Tactical. Timeless.

Forged metal on obsidian, lit by one lamp. A tournament table in a dark room,
photographed rather than illustrated. Every surface either absorbs light or
returns it with intent — nothing is flat plastic, and nothing glows for its
own sake.

The register is *engraved*, not *neon*. Gold is antique and metallic, not
fluorescent. Silver is brushed, not chrome. Restraint is the point: the sheet
uses at most two accent colours on any one element.

---

## 2. Palette

Stated explicitly on the reference sheet, in hex, and transcribed verbatim
into `Runtime/Rendering/BrandPalette.cs`.

| Token | Hex | Role |
| --- | --- | --- |
| Gold | `#D4AF37` | The single primary accent. Primary actions, victory, the player's own power. |
| Silver | `#C0C0C0` | The cool accent. Secondary information, the object ball's line. |
| Crimson | `#8B1E1E` | Fouls, destructive actions, the crimson table theme. |
| Midnight Navy | `#0E1A2B` | Deep surfaces and the midnight table theme. |
| Emerald | `#0F3E2E` | The default cloth. |
| Obsidian | `#0A0A0A` | Ground. Everything sits on this. |

Derived surface steps, extrapolated from the sheet's panels rather than stated
by it:

| Token | Value | Use |
| --- | --- | --- |
| SurfaceRaised | `rgb(29, 30, 33)` | Panels, cards, buttons |
| Surface | `rgb(20, 21, 24)` | Sunken panels |
| SurfaceRecessed | `rgb(11, 12, 14)` | Tracks, wells, insets |
| BevelLight | white @ 10% | The hairline along a panel's top edge |
| BevelDark | black @ 55% | The hairline along its bottom edge |

That pair of one-pixel bevels is most of what separates a surface that looks
machined from a flat grey box, and the reference sheet uses it on every panel.

### 2.1 Unresolved: divergence from the DPA master palette

The Dragon Phoenix Ascension Brand Bible §5 and the BREAKPOINT reference sheet
are **not the same palette**:

| DPA master | | BREAKPOINT sheet | | Note |
| --- | --- | --- | --- | --- |
| Void Black | `#0A0A0F` | Obsidian | `#0A0A0A` | Effectively the same ground |
| Ember | `#FF6B2C` | *(absent)* | | No ember in the product palette |
| Gold | `#FFB300` | Gold | `#D4AF37` | Antique/metallic rather than fire |
| Cyan | `#22D3EE` | *(absent)* | | Replaced by Silver as the cool accent |

The DPA master reads as **fire**. The BREAKPOINT sheet reads as **forged
metal**. Both are dark, cinematic and single-light-source, which is the shared
DNA; the metallics are what make BREAKPOINT its own premium product rather than
a DPA skin.

**This has not been reconciled, and is not resolved here.** The code follows
the reference sheet because the sheet is the approved BREAKPOINT artefact and
the game is the thing being built. A founder decision is needed on whether the
DPA master palette should be amended, whether BREAKPOINT is a documented
exception, or whether the two should converge.

---

## 3. Lighting

One low pendant lamp over a dark room. Three components:

1. **The lamp** — a shadow-casting spot at 1.5 m, warm white (`#FFF2E0`), wide
   cone with a soft penumbra. This is what makes the balls sit *on* the cloth
   instead of floating above it, and it is the only light that casts.
2. **Rim lights** — one warm, one cool, both very dim (0.13 and 0.11), placed
   symmetrically about the long axis. Asymmetric rims make one cushion glow
   while the opposite one reads as broken geometry rather than as lighting.
3. **Ambient** — trilight, with the *ground* term set to the cloth colour. The
   underside of a ball on a real table is lit by light bouncing off the baize;
   without that term every ball has a dead, slightly muddy lower hemisphere.

The visible fixture is emissive only. It does not light anything — two light
sources for one lamp would double-count and blow out the cloth. It hangs
between an overhead camera and the table, so it is hidden whenever the camera
climbs above it.

The camera clears to Obsidian, not to pure black: a dead-black surround makes
the cloth's own shadow terminator disappear and the table look pasted on.

---

## 4. Materials

Read off the sheet's "Materials & Textures" row.

| Surface | Character | Parameters |
| --- | --- | --- |
| Table cloth | Napped worsted, no sheen | roughness 0.95, metallic 0 |
| Rail wood | Dark stained hardwood, satin | roughness 0.68, metallic 0.05 |
| Metal inlay | Brushed antique gold | roughness 0.25, metallic 0.9 |
| Leather pocket | Matte black leather | roughness 0.75, metallic 0 |
| Cue shaft | Pale maple, satin | roughness 0.55, metallic 0 |
| Cue butt | Dark stained wood with a gold collar | roughness 0.45, metallic 0.05 |
| Balls | Phenolic resin — near-mirror at grazing angles, no metal | roughness 0.07, metallic 0 |

The pocket liner is matte and dark on purpose: a glossy liner catches the lamp
at grazing angles and flares into a bright arch over the mouth, which reads as
a hoop above the pocket rather than as the rim of a hole.

---

## 5. The table

Generated from the simulation's own `TableGeometry`, so the picture and the
playable table cannot disagree. Three things carry the "real table" read:

- **Real holes.** The bed is a slab with six pocket mouths punched clean
  through it, and you can see down the throat. With a solid slab a pocket is a
  dark disc painted on cloth — the single loudest tell of a cheap-looking
  table.
- **A real cushion profile.** The nose sits at 1.27 ball radii, which is the
  K-66 profile *and* the height the simulation uses to decide a cushion strike
  is above centre. Visible nose and colliding nose are the same line.
- **Sight diamonds.** The small inlays players line bank shots up with. They
  cost almost nothing and their absence is one of the loudest "programmer's
  table" signals there is.

### Table themes

Three, named on the sheet, expressed as `BreakpointTheme` assets:

| Theme | Cloth | Rails |
| --- | --- | --- |
| Emerald Classic *(default)* | Emerald `#0F3E2E` | Dark walnut |
| Midnight Elite | Midnight Navy `#0E1A2B` | Dark walnut |
| Crimson Royale | Crimson `#8B1E1E` | Dark walnut |

No cosmetics system exists. `BreakpointTheme` is the seam one would attach to
and nothing more.

---

## 6. Balls

Standard American set. Solids 1–8, stripes 9–15, plus a warm off-white cue
ball — off-white rather than pure white so it still takes shading under the
low-key lighting; a pure-white ball reads as a flat disc and loses its spin
cues.

Numbers sit in ivory circles, two per ball, half a turn apart, as on a real
ball. The cue ball carries a red spot, which is the only way to read its spin.

Textures are generated procedurally at load: a pool ball is a solid or a
stripe plus two numbered circles, which is far better expressed as a few
hundred pixel writes than as sixteen PNGs to ship, cache and colour-manage.
The digits come from a small hand-built 5×7 bitmap font so the generator has
no asset or font-licence dependency.

The generated colours carry over from the TypeScript reference and are close
to, but not identical with, the ball row on the art-direction sheet — the
sheet's 1-ball is a deeper gold and its 5-ball a hotter orange. Authored ball
art will supersede both; see the asset manifest.

---

## 7. Camera

Two framings, smoothly blended.

- **Aiming** — behind the cue ball, looking down the shot. The aim line runs
  away from the viewer, so a small change in angle is a visible change on
  screen. Elevation and distance are player controls, because the right height
  genuinely differs between a long straight pot and a positional shot.
- **Watching** — pulled up and back to take in the whole table while the balls
  run, then eased back down. That transition is doing the cinematic work;
  nothing else needs to move.

46° vertical field of view. The overview distance is *solved*, not fixed: the
table turns to lie along the long axis of the screen, and the distance is
computed from both the horizontal and the vertical field so whichever is
tighter decides. A fixed framing does not survive a phone.

---

## 8. Interface

Built on a 4 px grid at a 1920 × 1080 reference canvas, matched on height so
the HUD keeps its relationship to the table on a tall screen.

| | |
| --- | --- |
| Radii | 6 / 12 / 20 / pill |
| Spacing | 4 / 8 / 16 / 24 / 40 |
| Touch target | 48 px minimum |
| Type | Label 16, Body 22, Title 34, Display 56 |
| Caps tracking | 8 |

All-caps labels are tracked out. Caps without tracking read as shouting; caps
with tracking read as engraved, which is the intended register.

**Component vocabulary**, from the sheet's UI block: premium panel, primary
(gold) button, secondary (dark) button, danger (crimson) button, icon button,
status banner, player panel, modal frame. Gold ink on the primary button is
near-black — white on this gold fails contrast, and the sheet does not use it.

Status banners are one component with four accents — VICTORY (gold), FOUL
(crimson), NICE SHOT (navy), PERFECT BREAK (emerald) — so the wording and the
colour cannot drift apart across screens.

### The overriding UI rule

**Gameplay readability outranks decorative branding.** The panels sit in the
screen corners rather than over the cloth. Gold is used once per screen, for
the thing the player is doing. The aim guides are gold, silver and dim silver
rather than the usual overlay green, but all three sit above the cloth in
value and none competes with a ball for attention.

---

## 9. Brand presence

**BREAKPOINT first. DPA DNA underneath.**

The dragon-and-phoenix roundel enclosing the 8-ball is BREAKPOINT's own mark.
It belongs on the splash, the main menu, the loading screen and the app icon.
It does **not** belong on the cloth, on the rails, or anywhere it would sit in
the player's sightline during a shot.

The DPA wordmark appears once, in the footer register — "DRAGON PHOENIX
ALLIANCE · BREAKPOINT" — exactly as the reference sheet does it.

Taglines: *Premium. Tactical. Timeless.* and *MASTERY IS EARNED.*

---

## 10. Deliberately unresolved

These are **major** visual decisions and are not implemented. They need an
explicit call before any of them is built:

1. **Ember/magma rail glow on the table.** Would import the DPA master
   palette's fire into a product whose sheet is metallic. Also sits directly
   in the sightline.
2. **Cue equipment detail** — carbon-fibre grip texture and a gold collar ring
   beyond the plain one currently built.
3. **Room and environment beyond the black void.** The sheet shows the table
   in darkness; whether there is a floor, walls, spectators or nothing is open.
4. **A dragon/phoenix motif in the 3D scene** — as opposed to in the UI, where
   the sheet clearly places it.

Plus the palette question in §2.1.

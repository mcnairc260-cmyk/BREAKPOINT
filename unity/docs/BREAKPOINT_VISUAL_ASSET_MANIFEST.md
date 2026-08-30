# BREAKPOINT — Visual Asset Manifest

An inventory of the production art still required, derived from the approved
reference sheet at
`Assets/BREAKPOINT/Art/Reference/BREAKPOINT_DPA_ArtDirection_Master.png`.

## How to read this

Everything currently in the project is **generated in code** — procedural
textures, primitive meshes, code-built materials. That is a stage-one choice,
not a final one: it means the scene can be built and reviewed before any art
exists, and it gives the art pass a working target to replace piece by piece
rather than a blank project. Each row below names the code that a real asset
supersedes.

The reference sheet is a **direction document, not a source of assets.** Its
elements are rendered at thumbnail scale on a shared canvas. Nothing is cropped
out of it and shipped: the logo lockups need to be redrawn as vectors, the ball
row is at a fraction of the resolution a ball needs, and the small type on it is
illustrative rather than legible. Treating a crop as a final asset is exactly
how a premium sheet turns into a cheap-looking build.

**Status key**
`NEEDED` — no substitute exists ·
`PLACEHOLDER` — generated stand-in in place ·
`BLOCKED` — waiting on an unresolved decision

---

## BRAND

| Asset | Spec | Format | Alpha | Unity import | Status |
| --- | --- | --- | --- | --- | --- |
| Dragon-Phoenix roundel, gold | Vector master; raster 1024² | SVG + PNG | Yes | Sprite, single, no compression | NEEDED |
| Dragon-Phoenix roundel, silver | As above | SVG + PNG | Yes | Sprite | NEEDED |
| Dragon mark, standalone | Vector; raster 512² | SVG + PNG | Yes | Sprite | NEEDED |
| Phoenix mark, standalone | Vector; raster 512² | SVG + PNG | Yes | Sprite | NEEDED |
| BREAKPOINT wordmark | Vector; raster 2048 × 512 | SVG + PNG | Yes | Sprite | NEEDED |
| Full lockup (roundel + wordmark) | Vector; raster 2048 × 1024 | SVG + PNG | Yes | Sprite | NEEDED |
| App icon | 1024², plus the platform ladder | PNG | No | Icon set | NEEDED |
| Splash | 2560 × 1440 and 1440 × 2560 | PNG | No | Texture, sRGB | NEEDED |

The sheet shows four lockup variations — gold and silver, each with and without
the "DRAGON PHOENIX" sub-line. All four are needed.

---

## UI

| Asset | Spec | Format | Alpha | Unity import | Status |
| --- | --- | --- | --- | --- | --- |
| Panel frame, 9-slice | 96² with 24 px borders | PNG | Yes | Sprite, 9-slice, border 24 | PLACEHOLDER — `UiFactory.AddRoundedImage` uses Unity's built-in `UISprite` |
| Primary (gold) button, 9-slice | 96 × 64, border 20 | PNG | Yes | Sprite, 9-slice | PLACEHOLDER |
| Secondary button, 9-slice | 96 × 64, border 20 | PNG | Yes | Sprite, 9-slice | PLACEHOLDER |
| Status banner frame, 9-slice | 128 × 64, border 24 | PNG | Yes | Sprite, 9-slice | PLACEHOLDER |
| Icon set — cues, tables, chalk, avatars, stats, trophy, target, friends, settings, store | 128² each, one atlas | PNG atlas | Yes | Sprite atlas, 4 px padding | NEEDED |
| Player-panel avatar frame | 256², hexagonal | PNG | Yes | Sprite | NEEDED |
| XP / progress bar fill and track | 64 × 16, 9-slice | PNG | Yes | Sprite, 9-slice | NEEDED |
| Spin dial face | 512² | PNG | Yes | Sprite | PLACEHOLDER — flat disc in `Hud.BuildSpinDial` |
| Display typeface | Condensed geometric sans, caps-first | TTF/OTF | — | Font asset; **licence must be cleared** | NEEDED — currently Unity's `LegacyRuntime.ttf` |
| Body typeface | Same family, regular + medium | TTF/OTF | — | Font asset; licence | NEEDED |

The sheet's UI is drawn with a condensed geometric sans set in tracked caps.
No typeface has been chosen or licensed, and the current fallback is Unity's
built-in legacy font — which is the single most visible placeholder in the
build.

---

## TABLE

| Asset | Spec | Format | Alpha | Unity import | Status |
| --- | --- | --- | --- | --- | --- |
| Cloth albedo | 2048², tiling, worsted nap | PNG | No | Texture, sRGB, repeat, aniso 8 | NEEDED — currently flat colour |
| Cloth normal | 2048², tiling | PNG | No | Texture, **Normal map** | NEEDED |
| Cloth roughness | 2048², tiling | PNG | No | Texture, linear | NEEDED |
| Rail wood albedo | 2048 × 512, tiling along the rail | PNG | No | Texture, sRGB | NEEDED |
| Rail wood normal | 2048 × 512 | PNG | No | Normal map | NEEDED |
| Metal inlay albedo + metallic/smoothness | 1024² | PNG | No | Texture | NEEDED |
| Leather pocket albedo + normal | 1024² | PNG | No | Texture / Normal map | NEEDED |
| Pocket liner mesh | ~600 tris each | FBX | — | Model, no colliders, no rig | NEEDED — currently a generated tapered shaft |
| Table leg / body mesh | ~3k tris | FBX | — | Model, no colliders | NEEDED — currently a box |
| Sight diamond mesh | ~100 tris | FBX | — | Model | PLACEHOLDER — rotated cube |

The bed, the cushions and the pocket shafts are generated from
`TableGeometry` and should **stay** generated: that is what guarantees the
visible table and the colliding table are the same table. Authored art
replaces their *materials*, not their geometry.

---

## BALLS

| Asset | Spec | Format | Alpha | Unity import | Status |
| --- | --- | --- | --- | --- | --- |
| Ball albedo × 16 | 1024 × 512 equirectangular | PNG | No | Texture, sRGB, repeat U / clamp V, aniso 8 | PLACEHOLDER — `BallTextureFactory` |
| Ball roughness variation | 512 × 256, shared | PNG | No | Texture, linear | NEEDED |
| Ball normal (scuff/wear) | 1024 × 512, shared | PNG | No | Normal map | NEEDED |

The generated textures are legible and correctly laid out — stripe on the
equator, two number spots half a turn apart, red spot on the cue ball — but
they are flat vector-style art with no wear, no scuffing and no printed-decal
edge. Real balls read as *used*, and that is a large part of the premium feel.

---

## CUES

Four designs are named on the sheet. None exists as an asset.

| Asset | Spec | Format | Alpha | Unity import | Status |
| --- | --- | --- | --- | --- | --- |
| Cue mesh, shared | ~1.2k tris, single UV set | FBX | — | Model, no colliders | PLACEHOLDER — three primitives in `CuePresenter` |
| Standard Maple textures | 2048 × 512 albedo + normal + MOS | PNG | No | Texture / Normal map | NEEDED |
| Midnight Carbon textures | As above | PNG | No | As above | BLOCKED — carbon grip is an unresolved decision |
| Gilded Sovereign textures | As above | PNG | No | As above | NEEDED |
| Neon Syndicate textures | As above + emissive | PNG | No | As above | NEEDED |
| Tip / ferrule detail | 512² | PNG | No | Texture | NEEDED |

---

## ENVIRONMENT

| Asset | Spec | Format | Alpha | Unity import | Status |
| --- | --- | --- | --- | --- | --- |
| Pendant lamp fixture mesh | ~2k tris | FBX | — | Model | PLACEHOLDER — two boxes |
| Lamp shade emissive map | 1024 × 256 | PNG | No | Texture, sRGB | NEEDED |
| Reflection probe cubemap | 512² per face, HDR | EXR | No | Cubemap | NEEDED — polished phenolic with nothing to reflect reads as matte plastic |
| Floor / room geometry | — | FBX | — | Model | BLOCKED — the room is an unresolved decision |
| Backdrop / vignette | — | — | — | — | BLOCKED — same decision |

The reflection probe is the highest-value item in this section. Without an
environment to reflect, the balls lose their specular highlight and read as
plastic no matter how the lighting is set.

---

## VFX

None of this is Phase A work, and none of it is built. Listed so the manifest
is complete rather than to imply a schedule.

| Asset | Spec | Status |
| --- | --- | --- |
| Ball-impact spark/dust | Particle system + 256² sprite sheet | NEEDED |
| Cushion contact puff | Particle system + 256² sprite | NEEDED |
| Pocket-drop flash | Particle system + 512² sprite | NEEDED |
| Break shockwave | Particle system + mesh ring | NEEDED |
| Aim-line shader | Additive, scrolling, soft-edged | PLACEHOLDER — flat unlit lines |
| Ember/magma rail glow | — | BLOCKED — unresolved decision |

---

## Achievement badges

Six are drawn on the sheet: 8-ball laurel, crossed-cues skull, purple chevron,
phoenix, silver trophy, gold star. Each needs a 512² PNG with alpha, imported
as a sprite. No progression system exists to attach them to, so they are listed
as `NEEDED` rather than scheduled.

---

## Blocked on decisions

Four items above are `BLOCKED` on the major visual decisions recorded in
`BREAKPOINT_VISUAL_STYLE.md` §10:

1. Ember/magma rail glow
2. Cue equipment detail (carbon grip, gold collar)
3. Room and environment beyond the black void
4. Dragon/phoenix motif in the 3D scene

None should be commissioned before those are settled.

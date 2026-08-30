# BREAKPOINT — Unity Migration (Phase A)

Architecture, deterministic physics port, and the DPA visual foundation.

This document is the record of what was moved, what was deliberately not
moved, what was verified, and — the part that matters most — what could not
be verified in the environment this work was done in.

---

## 0. Where this work lives

This repository is BREAKPOINT's canonical home. Two implementations, with a
deliberate division of authority:

| Path | What it is |
| --- | --- |
| `unity/` | **This work.** The primary implementation: Unity 6 plus a custom deterministic C# simulation. |
| `reference/threejs-phase1/` | The hardened Phase 1 slice, preserved as the **physics oracle**. Runnable, tested, CI-gated. Not developed as a product. |

### How it got here

The Unity migration was built in the `dragon-phoenix-command` monorepo under
`games/breakpoint-unity/`, on a branch taken from `b67701f` — the verified,
hardened Phase 1 baseline. That baseline mattered: the monorepo's `main` was a
generation behind it, missing the simultaneous-contact fix, the table
containment rule, the mobile camera framing fix, the extended shot records,
the larger test suite and CI. Porting from `main` would have carried two known
physics defects into C#.

Both implementations were then moved here, which is now the source of truth.
The monorepo copies are historical.

### What changed in the move

The oracle gained the `AimPredictor` tangent-sign fix and its regression test
(§8) — found by this port, and previously present only on the migration
branch. Fixture generation became repository-relative and ESM-safe
(`generate-fixtures.mts`); regenerating from the moved oracle produces a
byte-identical fixture file, which is the evidence that the move preserved
behaviour rather than merely compiling.

---

## 1. Why Unity

The TypeScript/three.js implementation in `reference/threejs-phase1/` is a complete,
hardened, playable Phase 1 slice. Nothing about it is broken, and it is not
being deleted. It remains in the repository as the **physics oracle**: the
reference the C# port is measured against.

Unity is being adopted for what it does that a hand-written WebGL renderer
does not:

| Need | Why Unity |
| --- | --- |
| Premium lighting and materials | URP gives shadow-cast spot lighting, tone mapping, bloom, SSAO and post-processing as a pipeline, not as bespoke shader code |
| Mobile builds | iOS and Android from one project, with real profiling tooling |
| UI at scale | Canvas, scalers, safe-area handling, and a component vocabulary that survives more than one screen |
| Audio | Mixers, spatialisation and ducking, rather than raw WebAudio plumbing |
| VFX | Particles and VFX Graph, for impacts, pocket drops and break energy |
| Art pipeline | Authored meshes, textures and fonts land in a project artists can open |

What Unity is *not* being adopted for is the simulation.

---

## 2. The line: what Unity owns, what the simulation owns

**Unity owns:** rendering, cameras, lighting, materials, post-processing, UI,
audio, VFX, input capture, scene management, and builds.

**The simulation owns:** ball state, collisions, friction, spin, cushions,
pockets, rest detection, shot records, and time.

**Unity PhysX is not the authority and cannot become it.** That is not a
convention; it is enforced structurally. `Breakpoint.Simulation` and
`Breakpoint.Geometry` both declare:

```json
"noEngineReferences": true
```

An assembly with no engine reference cannot name `Rigidbody`, `Collider`,
`Transform`, `Time.deltaTime` or `UnityEngine.Random`. The compiler, not a
code review, is what stops PhysX creeping into the physics.

The one collider in the whole scene is `ClothTarget`, a trigger box used to
turn a screen tap into a table coordinate. That is input, not simulation. The
play-mode test `TheOnlyColliderIsTheInputTarget` asserts there is exactly one
and that it is a trigger; `SceneContainsNoRigidbodies` asserts there are no
rigidbodies at all.

`com.unity.modules.physics` remains in the package manifest solely so that
trigger box and its raycast exist.

---

## 3. Directory architecture

```
unity/
├── Assets/BREAKPOINT/
│   ├── Art/Reference/
│   │   └── BREAKPOINT_DPA_ArtDirection_Master.png   the approved visual oracle
│   ├── Runtime/
│   │   ├── Simulation/        pure C#, no engine references — the authority
│   │   ├── Geometry/          pure C#, no engine references — mesh generation
│   │   ├── Rendering/         palette, themes, ball art, materials
│   │   ├── Presentation/      the read-only bridge from simulation to Unity
│   │   ├── Input/             pointer and touch → shot intents
│   │   └── UI/                design tokens and the component vocabulary
│   ├── Scenes/Breakpoint.unity
│   └── Tests/
│       ├── EditMode/          runs in Unity *and* in the standalone harness
│       └── PlayMode/          Unity only
├── Packages/manifest.json
├── ProjectSettings/
├── docs/
└── tools/
    ├── parity/                fixture generator, NUnit shim, headless runner
    └── compile-check/         Unity API stub and shape check
```

The split between `Simulation` and `Geometry` is not cosmetic. Both are
engine-free, which is what lets the standalone harness compile and run them
without Unity — and the mesh maths turned out to be worth that: the
triangulator shipped with two real bugs that the tests caught (see §8).

---

## 4. The physics port

Every file in `src/physics/` and the game-level parts of `src/game/` were
ported to C#:

| TypeScript | C# |
| --- | --- |
| `Vec.ts` | `Vec.cs` (`Vec2`, `Vec3`, `Quat`, `Numeric`) |
| `PhysicsConstants.ts` | `PhysicsConstants.cs` |
| `TableGeometry.ts` | `TableGeometry.cs` |
| `BallBody.ts` | `BallBody.cs` |
| `FrictionModel.ts` | `FrictionModel.cs` |
| `SpinModel.ts` | `SpinModel.cs` |
| `BallCollision.ts` | `BallCollision.cs` |
| `RailCollision.ts` | `RailCollision.cs` |
| `PocketPhysics.ts` | `PocketPhysics.cs` |
| `PhysicsWorld.ts` | `PhysicsWorld.cs` |
| `Rack.ts` | `Rack.cs` |
| `ShotRecord.ts` | `ShotRecord.cs` |
| `AimPredictor.ts` | `AimPredictor.cs` |
| `frame.ts` | `RenderFrame.cs` |

### Precision

Everything inside the authoritative simulation is `double`. Nothing was
downgraded to `float` for convenience. `float` appears only at the boundary
where a position becomes a `Transform` or a `Mesh` — in `TableFrame.cs` and
`MeshConverter.cs` — and nothing narrowed there is ever read back.

### Fixed timestep

`PhysicsConstants.FixedDt = 1.0 / 120.0`. `FixedStepDriver` spends wall-clock
time in whole steps and keeps the remainder in an accumulator, so the
simulation advances identically whatever the frame rate. `SimulationRunner`
is the only place Unity time touches physics, and it does so through that
driver.

`DeterminismTests` fingerprints a full break run at 30, 60, 75, 120, 144 and
240 frames per second and asserts the fingerprints are bit-identical.

### Ordering

The frame order is explicit in `BreakpointBootstrap.Update`:

1. input produces intents
2. the simulation advances by whole fixed steps
3. presenters read the resulting state

`SimulationRunner.Advance` is called by the bootstrap rather than from its own
`Update`, so this cannot be reordered by Unity's script execution order.

### One deliberate implementation difference

`PhysicsWorld` keys simultaneous contacts by a packed `long` rather than by
the reference's string key. Same set, same ordering, no allocation in the hot
loop. Everything else is a transcription.

---

## 5. The render frame

The simulation is right-handed with the cloth at `z = 0` and `+z` up, because
that is the convention every billiards reference uses. Unity is y-up and
left-handed. The map is

```
render = ( x, z, y )
```

Writing the screen basis as (right, up, into-screen) — a left-handed triple —
the physics axes land as `x̂ = right`, `ẑ = up`, `ŷ = into-screen`, and Unity's
axes are already `X̂ = right`, `Ŷ = up`, `Ẑ = into-screen`. The render vector
*is* the screen vector, so the table looks the same as in the TypeScript
reference rather than mirrored.

Rotations take one more step. The map `P` is a reflection, so a physics
rotation `R` becomes `P·R·P` in render coordinates; expanding
`R = I + 2w[v]× + 2[v]×²` and using `P[v]×P⁻¹ = det(P)·[Pv]× = −[Pv]×` gives
the quaternion `(Pv, −w)`. The vector part is permuted and the scalar part is
negated.

This lives in `RenderFrame.cs`, inside the engine-free assembly, specifically
so it can be tested without Unity. `PresentationMathTests` asserts it against
observable behaviour rather than against itself: a ball given natural roll in
`+x` must have the *top* of the ball moving toward render `+X`. Get the sign
wrong and every visible spin is a lie — which is exactly the failure mode this
project is not allowed to ship.

---

## 6. Cross-implementation verification

`tools/parity/generate-fixtures.ts` runs 18 scenarios through the TypeScript
oracle and writes positions, velocities, spins, the full event stream and
final state at `toPrecision(17)`. `ParityTests` replays the same scenarios in
C# and compares.

The requirement was explicitly *not* bit-identical IEEE output — the two
implementations run on different runtimes and different JITs — but
behaviourally equivalent deterministic results within documented tolerances.

### Tolerances, and where they came from

They were measured, not guessed. A diagnostic pass recorded the actual
divergence across all 18 fixtures and all 113 recorded impulses:

| Quantity | Worst observed | Tolerance set |
| --- | --- | --- |
| Impulse, absolute | 5.367 × 10⁻⁵ N·s | 1 × 10⁻⁴ N·s |
| Impulse, relative | 4.645 × 10⁻³ | 1 × 10⁻² |
| Final ball position | 1.578 × 10⁻⁵ m (0.016 mm) | 1 × 10⁻⁴ m |

The worst position error is about 1/1800 of a ball radius.

**Every fixture produces an identical event count and an identical event
sequence, including 47 events through a full break.** That is the assertion
that actually matters: the two implementations agree on *what happened*, in
what order, to which balls, off which cushions and into which pockets. The
numeric tolerances only cover how hard.

One fixture, `full-break`, is exempt from the *position* comparison and only
from that: a 15-ball break is chaotic, and micro-differences at the first
contact are amplified across dozens of subsequent ones. Its event stream is
still compared exactly.

---

## 7. Test status

### Executed, passing

`./tools/parity/run-tests.sh` — **93 tests, 93 passed, 0 failed.**

| Suite | Tests | What it covers |
| --- | --- | --- |
| `ParityTests` | 18 + stream assertions | C# against the TypeScript oracle |
| `PhysicsBehaviourTests` | conservation laws, closed forms, known billiards relationships | |
| `DeterminismTests` | bit-exact fingerprints across six frame rates | |
| `ShotRecordTests` | contact graph, rail flags, jaw separation, scratch, replay | |
| `PresentationMathTests` | render-frame conversion, aiming ray | |
| `TableMeshTests` | triangulation, bed area, hole coverage, cushion nose alignment, winding | |
| `DemonstrationShotTests` | one shot producing strike, contact, cushion, pocket and rest; spin proven to alter the trajectory | |
| `AllocationTests` | zero steady-state allocation, bounded cold-break allocation | |

The TypeScript reference was re-validated after the changes described in §8:
`tsc -b --noEmit` clean, `eslint .` clean, **123 tests passing**, production
build succeeds.

### Executed, passing — but weaker than it sounds

`./tools/compile-check/run.sh` compiles `Runtime/Rendering`,
`Runtime/Presentation`, `Runtime/Input`, `Runtime/UI` and the play-mode tests
against a hand-written stub of the Unity API
(`tools/compile-check/UnityApiStub.cs`).

**This is not a Unity build and must not be read as one.** It proves the code
parses, that every type and member it names exists with a compatible shape,
that no `using` is missing, and that nothing was left half-edited. It cannot
prove behaviour, and if a stub signature is wrong it agrees with the mistake.

On its first run it reported fifteen errors. Every one of them turned out to be
a gap in the stub — a missing `Mathf.Min(int, int)` overload, a missing
`[Header]` attribute, a missing `Renderer.enabled` — rather than a fault in the
code. That is a real result, but it is the weaker of the two possible ones: it
says the Unity-facing code is at least self-consistent, not that it is right.

### Written, NOT executed

- **The Unity compile.** Unity is not installed in this environment and cannot
  be installed here (`dotnet` is unavailable and
  `builds.dotnet.microsoft.com` is blocked by the outbound proxy). The shape
  check above is a lower bound, not a substitute.
- **The Unity edit-mode run.** The edit-mode tests pass under the standalone
  Mono harness. They have not been run through the Unity Test Framework.
- **All play-mode tests.** `PresentationContractTests` requires a player loop
  and has never been executed — including
  `DemonstrationShotRunsThroughTheBridge`, which is the one that would prove a
  complete shot runs through Unity. Its edit-mode twin,
  `DemonstrationShotTests`, *has* been executed and passes, so the shot itself
  is verified; what is unverified is the bridge carrying it.
- **The scene.** `Breakpoint.unity` has never been opened.
- **Any visual result.** No frame of this project has been rendered. Nothing in
  `BREAKPOINT_VISUAL_STYLE.md` has been seen.

None of the above is claimed as passing. The engine-free half of the project is
genuinely verified; the Unity half is written, shape-checked and otherwise
unverified. The first task of the next session with a Unity install is to open
it, compile it, and fix whatever that surfaces.

---

## 8. Defects found during the port

Porting is a re-derivation, and re-derivation finds things.

**1. The aiming overlay's 90-degree line pointed backwards.**
`AimPredictor` computed the cue ball's tangent direction as
`(-t.y·side, t.x·side)`, which for every cut points back down the cue ball's
own path instead of forwards. The existing TypeScript test only asserted
perpendicularity, which does not pin the sign, so it survived. Fixed in both
implementations to `(t.y·side, -t.x·side)`, with a directional test added on
each side.

This is a defect in the *overlay*, not in the simulation: no physics reads it
and no parity fixture covers it. It is recorded here because the TypeScript
implementation is the oracle, and an oracle that has been corrected should say
so.

**2. Half the cushions were generated inside out.** Opposite rails run the
same way but face opposite directions, so `(tangent, normal)` is right-handed
on some segments and left-handed on others. A single fixed vertex order turns
half the cushions inside out — invisible from the usual camera angle, and
glaring from any other. Caught by `CushionTopFacesUpAndItsFrontFacesTheTable`.

**3. The bed triangulator returned nothing at all.** Bridging a hole into the
outer contour leaves two pairs of coincident vertices; a naive
point-in-triangle test treats a coincident vertex as contained, which blocks
every ear touching the bridge. Caught by
`RectangleWithOneHoleLosesExactlyTheHolesArea`.

**4. The cushion end caps were wound backwards.** Found only by
`StoredNormalsAgreeWithWinding`, which compares each triangle's geometric
normal against its stored shading normal — the earlier tests all passed with
this bug present.

---

## 9. Editor setup required on first open

These cannot be set from here without Unity, and are listed rather than
guessed at:

1. **Colour space → Linear.** Player Settings → Other Settings. URP's lighting
   model assumes it; in Gamma the low-key look goes muddy.
2. **Create a URP asset and assign it.** Graphics settings and Quality
   settings both need it. Without it, `MaterialLibrary` logs an error and
   falls back to the built-in standard shader, which will not match the art
   direction.
3. **Input handling → Input Manager (Old).** Phase A uses the legacy `Input`
   class deliberately: it works identically for mouse, touch and pen with no
   separate code path, which is the requirement. Migrating to the Input System
   package is a later task, not a Phase A one; the package has been removed
   from the manifest rather than left installed and unused.
4. **Confirm the Unity version.** `ProjectSettings/ProjectVersion.txt` pins
   `6000.0.23f1`.

`ProjectSettings/ProjectSettings.asset` and `QualitySettings.asset` are
deliberately absent. Hand-writing them blind risks producing a project that
will not open at all; Unity regenerates them with defaults, and the four
settings above are the ones that then need changing.

---

## 10. Platform packages and settings

The manifest is deliberately minimal — every package in it is used. Adding one
"for later" costs build size and a dependency that has to be kept current.

| Package | Why it is there |
| --- | --- |
| `com.unity.render-pipelines.universal` | The rendering pipeline the art direction assumes |
| `com.unity.ugui` | Canvas, Image, Text, Button — the UI foundation |
| `com.unity.test-framework` | Edit-mode and play-mode tests |
| `com.unity.modules.physics` | **Only** for the cloth trigger box and its raycast. No rigidbodies exist. |
| `com.unity.modules.particlesystem` | Present for the VFX seam; nothing uses it yet |
| `com.unity.modules.audio` | Present for the audio seam; nothing uses it yet |

`com.unity.inputsystem` was **removed**. Phase A uses the legacy `Input` class
deliberately — it handles mouse, touch and pen through one code path, which is
the requirement — and leaving an unused package installed would have forced the
project into "Both" input handling for no benefit. Migrating to the Input
System is a later task with its own testing.

### Per-platform settings

Not committed, because `ProjectSettings.asset` is not committed (see §9). These
are the settings to apply, listed rather than guessed at:

**All platforms**
- Colour space: **Linear**
- Auto Graphics API: off; assign the URP asset in Graphics *and* in every
  Quality level
- Active Input Handling: **Input Manager (Old)**
- Managed stripping level: Low, until there is a reason to raise it — the
  simulation is reflection-free, so higher levels are viable later

**iOS**
- Minimum version: iOS 13 (matches the A12-and-later target)
- Scripting backend: IL2CPP, ARM64
- Target frame rate: set explicitly to 60 in code;
  `Application.targetFrameRate` defaults to 30 on iOS
- Orientation: portrait and portrait-upside-down, with landscape allowed —
  the camera framing solves for both

**Android**
- Minimum API level: 26
- Scripting backend: IL2CPP, ARM64 only (drop ARMv7)
- Graphics APIs: Vulkan first, OpenGLES3 as fallback
- Optimized Frame Pacing: on
- Blit type: Auto

**Web**
- Secondary target, and the one with real caveats. WebGL has no multithreading
  by default, so the simulation runs on the main thread — at the measured
  throughput that is comfortable, but it has not been tested in a browser.
- Compression: Brotli, with server headers configured; Gzip if not
- Exception support: Explicitly Thrown Exceptions Only
- Decompression fallback: on

None of these has been applied or verified, because none of them can be
without the editor.

---

## 11. Mobile targets

The intended envelope, from the same requirements the TypeScript slice was
hardened against:

- **iOS** — A12 and later, 60 fps
- **Android** — Snapdragon 700-series and later, 60 fps
- **Portrait first**, 390 × 844 and 430 × 932 as the reference viewports

The camera's overview framing is solved from both the horizontal and vertical
field so that a portrait screen sees the whole table; that logic is ported from
the reference, where it was written *after* mobile screenshots showed a fixed
framing cropping half the cloth. `OverviewFramingCoversTheTableInPortrait`
asserts it — and has not been run.

### Measured performance and allocation

Measured here, under Mono on this machine — **not** on a phone, and not through
Unity's IL2CPP:

| | |
| --- | --- |
| Full break, 879 steps to rest | 7.0 ms wall clock |
| Per 120 Hz step | ~8 µs |
| Realtime factor | ~1000× |
| Steady-state allocation | **0 bytes** across 904 steps |
| Cold break allocation | ~10 KB total, all of it event-list growth |

The zero is asserted by `AllocationTests.AWarmedUpShotAllocatesNothing`, not
merely observed. Every working buffer in `PhysicsWorld` is a reused field,
every vector is a struct, and the batch solver copies bodies into pooled
instances. That last part was a change made during this phase: the solver
previously cloned a `BallBody` per body per relaxation pass, which cost about
**85 KB per break** — the allocation audit §24 asked for found it, and pooling
removed it with the parity fixtures proving the physics is bit-identical either
side of the change.

There is no LINQ anywhere in the simulation. The only `ToArray` calls are in
`ShotRecord.Summarise` (once per shot) and `TableGeometry.Create` (once at
startup).

**No claim is made about frame rate on a device.** These numbers are the
simulation only, on a desktop runtime, with no rendering. The 60 fps target on
real phone hardware remains unverified, as it did after Phase 1.

---

## 12. What was deliberately not done

Phase 2 has not been started. There are no WPA 8-ball rules, no turn or foul
logic, no AI opponent, no progression, no cosmetics system, no multiplayer and
no monetisation. `BreakpointTheme` is the seam a cosmetics system would attach
to and nothing more.

Four **major** visual decisions raised earlier remain unanswered and are
therefore not implemented:

1. Ember/magma rail glow on the table
2. Cue equipment detail (carbon grip, gold collar ring)
3. Room and environment beyond the black void
4. A dragon/phoenix motif in the 3D scene

The palette divergence between the DPA Brand Bible and the approved
BREAKPOINT reference sheet is recorded in `BREAKPOINT_VISUAL_STYLE.md` and is
also unresolved.

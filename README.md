# BREAKPOINT

A physics-first pool game. Premium, tactical, timeless.

Part of the **Dragon Phoenix Ascension** ecosystem.

---

## Two implementations, one authority

```
BREAKPOINT/
├── unity/                        the primary implementation  ← build here
├── reference/threejs-phase1/     the physics oracle          ← do not delete
├── docs/
└── .github/workflows/
```

**`unity/`** is BREAKPOINT's future: Unity 6 for rendering, cameras, lighting,
materials, UI, audio and platform builds, wrapped around a **custom
deterministic C# billiards simulation** that Unity is not allowed to touch.

**`reference/threejs-phase1/`** is the hardened TypeScript/three.js Phase 1
slice. It is complete, playable and passing, and it is kept for a specific
reason: it is the **behavioural oracle** the C# port is measured against, shot
by shot, via generated parity fixtures. Deleting it would invalidate every one
of those fixtures.

Unity is the primary implementation. The three.js build is the reference until
Unity passes parity verification in an actual editor — see
`unity/docs/BREAKPOINT_UNITY_MIGRATION.md` for exactly what that means and what
still has not been executed.

---

## The rule that matters

**Unity draws the game. It does not decide it.**

`unity/Assets/BREAKPOINT/Runtime/Simulation/` and `.../Geometry/` both declare
`"noEngineReferences": true` in their assembly definitions. The code that
decides where a ball goes cannot name `Rigidbody`, `Transform`,
`Time.deltaTime` or `UnityEngine.Random` — the compiler stops it, not a code
review. Unity PhysX is not the authority and cannot become it.

The only collider in the entire scene is a trigger box used to turn a screen
tap into a table coordinate. There are no rigidbodies. CI asserts both facts.

---

## Running the checks

### Deterministic physics — no Unity, no licence, no GPU

```sh
cd unity
./tools/parity/run-tests.sh      # 93 tests: physics, determinism, parity, geometry, allocation
./tools/compile-check/run.sh     # shape-check the Unity-facing code (NOT a Unity build)
```

Both need `mono-devel` (`sudo apt-get install -y mono-devel`). This is the
suite that matters: the simulation is engine-free by design, so its guarantees
are verifiable in CI without an editor.

### The three.js reference

```sh
cd reference/threejs-phase1
npm ci
npm run verify    # typecheck, lint, unit tests, build, browser acceptance
```

### Regenerating parity fixtures from the oracle

```sh
npx tsx unity/tools/parity/generate-fixtures.mts
```

---

## Opening the Unity project

Unity **6000.0.23f1**. Open `unity/`, then
`Assets/BREAKPOINT/Scenes/Breakpoint.unity`.

Four settings must be applied on first open — they are listed in
`unity/docs/BREAKPOINT_UNITY_MIGRATION.md` §9 rather than committed, because
hand-writing `ProjectSettings.asset` blind risks a project that will not open.

**Nothing in `unity/` has ever been compiled by Unity or rendered.** That is
stated plainly in the migration document's test-status section, and it is the
gate to Phase B.

---

## Documentation

| Document | Covers |
| --- | --- |
| `unity/docs/BREAKPOINT_UNITY_MIGRATION.md` | Why Unity, what it owns, the port, parity tolerances, test status, defects found |
| `unity/docs/BREAKPOINT_VISUAL_STYLE.md` | Visual specification from the approved art-direction reference |
| `unity/docs/BREAKPOINT_VISUAL_ASSET_MANIFEST.md` | Every production asset still required |
| `docs/REPOSITORY_LAYOUT.md` | Why this repository is shaped the way it is |
| `reference/threejs-phase1/README.md` | The Phase 1 implementation's own record |

---

## Status

Phase A of the Unity migration: **complete and verified as far as this
environment allows.** Phase 2 gameplay — WPA rules, AI, progression,
cosmetics, multiplayer, monetisation — has not been started.

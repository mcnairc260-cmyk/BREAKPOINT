# BREAKPOINT — Unity

The Unity 6 port of BREAKPOINT, with a custom deterministic C# physics engine.

The TypeScript/three.js implementation in `../reference/threejs-phase1/` is **not** replaced
by this and must not be deleted. It is the **physics oracle** — the reference
this port is measured against, fixture by fixture.

---

## Branches

This project lives on `claude/breakpoint-unity-migration-phase-a`, branched
from `b67701f` — the verified, hardened Phase 1 baseline, which is newer than
what `main` carries.

`claude/breakpoint-phase-1-pool-1sjmmi` is preserved as the historical Phase 1
implementation and is not developed on. See
`docs/BREAKPOINT_UNITY_MIGRATION.md` §0.

---

## The one rule

**Unity draws the game. It does not decide it.**

`Assets/BREAKPOINT/Runtime/Simulation/` and `Assets/BREAKPOINT/Runtime/Geometry/`
both declare `"noEngineReferences": true`. The code that decides where a ball
goes cannot name a Unity type — the compiler enforces it, not a code review.
Unity PhysX is not the authority and cannot become it.

The only collider in the scene is a trigger box used to turn a screen tap into
a table coordinate. There are no rigidbodies.

---

## Running the checks

Neither of these needs Unity, a licence, or a graphics device.

```sh
./tools/parity/run-tests.sh      # 93 tests: physics, determinism, parity, geometry, allocation
./tools/compile-check/run.sh     # shape-check the Unity-facing code (NOT a Unity build)
```

Both need `mono-devel` (`sudo apt-get install -y mono-devel`).

Regenerating the parity fixtures from the oracle:

```sh
npx tsx tools/parity/generate-fixtures.ts
```

---

## Opening it in Unity

Unity **6000.0.23f1**. Four things must be set on first open — they are listed
in `docs/BREAKPOINT_UNITY_MIGRATION.md` §9 rather than committed, because
hand-writing `ProjectSettings.asset` blind risks a project that will not open.

Then open `Assets/BREAKPOINT/Scenes/Breakpoint.unity` and press play. The scene
holds a single object: everything else is built at runtime from the
simulation's own geometry.

**Nothing in this project has ever been compiled by Unity or rendered.** See
the migration document's "Test status" section for exactly what has and has not
been executed.

---

## Documentation

| Document | What it covers |
| --- | --- |
| `docs/BREAKPOINT_UNITY_MIGRATION.md` | Why Unity, what it owns, the port, parity tolerances, test status, defects found |
| `docs/BREAKPOINT_VISUAL_STYLE.md` | The visual specification derived from the approved art-direction reference |
| `docs/BREAKPOINT_VISUAL_ASSET_MANIFEST.md` | Every production asset still required |

The approved visual reference is
`Assets/BREAKPOINT/Art/Reference/BREAKPOINT_DPA_ArtDirection_Master.png`. It is
a direction document, not a source of assets — nothing is cropped out of it and
shipped.

# Repository layout

Why this repository is shaped the way it is, and what each part is for.

---

## The shape

```
BREAKPOINT/
├── unity/                        primary implementation (Unity 6 + custom C# physics)
│   ├── Assets/BREAKPOINT/
│   │   ├── Art/Reference/        the approved art-direction master
│   │   ├── Runtime/
│   │   │   ├── Simulation/       engine-free — the authority
│   │   │   ├── Geometry/         engine-free — mesh generation
│   │   │   ├── Rendering/        palette, themes, ball art, materials
│   │   │   ├── Presentation/     read-only bridge to Unity
│   │   │   ├── Input/            pointer/touch → shot intents
│   │   │   └── UI/               design tokens and components
│   │   ├── Scenes/
│   │   └── Tests/{EditMode,PlayMode}/
│   ├── Packages/  ProjectSettings/  docs/
│   └── tools/{parity,compile-check}/
├── reference/threejs-phase1/     the physics oracle — preserved, runnable
├── docs/
└── .github/workflows/
```

## Why two implementations

The three.js Phase 1 slice is not legacy code awaiting deletion. It is the
**behavioural oracle**: 18 canonical shots are run through it and serialised at
17 significant figures, and the C# port replays those fixtures and is compared
against them. Every fixture must produce an identical event sequence.

That relationship only holds while the oracle still runs. So:

- `reference/threejs-phase1/` keeps its own `package.json`, lockfile, tests,
  linting and browser acceptance suite, and its own CI job.
- Its CI job is not optional. A parity fixture generated from a broken oracle
  is worse than no fixture at all.
- It is not developed as a product any more. Bugs are fixed there only when
  the port proves one exists — and then the fix is ported both ways.

## Why the simulation is engine-free

`Breakpoint.Simulation` and `Breakpoint.Geometry` declare
`"noEngineReferences": true`. Two things follow:

1. **PhysX cannot become the authority.** Not by convention — by compiler.
2. **The physics is testable without Unity.** The whole 93-test suite runs
   under plain Mono, in CI, with no editor and no licence. That is why the
   guarantees this game depends on — determinism, no energy created, no ball
   escaping the table — are checked on every push rather than by hand.

## Why `ProjectSettings.asset` is absent

Hand-writing Unity's serialised project settings without an editor risks
producing a project that will not open at all. Unity regenerates them with
defaults; the four settings that then need changing are listed in
`unity/docs/BREAKPOINT_UNITY_MIGRATION.md` §9.

## The other applications in this repository

Two applications unrelated to the game also live here, each in a self-contained
top-level folder:

- **`proofhound/`** — an evidence-lineage investigation tool. Next.js 15,
  React 19, TypeScript.
- **`forecaster/`** — a short-horizon crypto probability forecaster. Python
  engine, Next.js front end.

The pattern each follows, and which any future addition must follow:

- One top-level directory, entirely self-contained.
- Its own dependency manifest, lockfile, `.gitignore` and README.
- Its own CI workflow, path-filtered to that directory, so it never triggers the
  Unity or three.js jobs and they never trigger it.
- Nothing outside its own folder is modified — with the sole exception of this
  file and the root `README.md`, which have to name what exists.

## What must not happen here

- Do not delete `reference/threejs-phase1/`.
- Do not give a ball a `Rigidbody`.
- Do not flip `noEngineReferences` to `false`.
- Do not copy unrelated Dragon Phoenix Ascension monorepo files in. A separate
  application in its own self-contained folder is fine — see above — but the
  game's own code stays BREAKPOINT and the brand tokens it needs, nothing else.

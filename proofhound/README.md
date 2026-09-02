# ProofHound

**Trace claims back to the evidence.**

ProofHound investigates a claim and produces a transparent evidence map instead
of a verdict. Its central question is not "is this true" but:

> **How many of these apparent sources are actually independent?**

A search engine will hand you fifteen results. ProofHound will tell you that
eleven of them descend from one document nobody has been able to obtain.

---

## What it does

| Section | Answers |
| --- | --- |
| **Claim** | What exactly is being asserted, in what category, at what epistemic level |
| **Evidence strength** | How strong the available evidence is, 0–100, with every point accounted for |
| **Source DNA** | Where the sources actually come from — origins, families, circular citation |
| **Evidence map** | People, documents, claims and institutions as a connected network |
| **Evidence ledger** | Every evidence item, filterable by stance, independence and primacy |
| **Contradictions** | What conflicts with the claim, never hidden or collapsed |
| **Missing evidence** | What would materially settle the question, and how to get it |
| **Timeline** | The chronology, including orders that cannot be right |
| **Summary** | The strongest evidence each way, the uncertainties, the next research step |

---

## Running it locally

```sh
cd proofhound
npm install
npm run dev            # http://localhost:3210
```

No API keys are required. With none configured, ProofHound runs its
deterministic rules engine and its built-in demonstration corpora, and says so
in the workspace.

```sh
npm run verify         # typecheck + lint + tests + production build
npm run test           # vitest only
npm run build && npm start
node e2e/verify.mjs    # browser verification against a running server
```

Configuration lives in `.env.example`; copy it to `.env.local`. Every value is
read on the server only — no key is ever exposed to the browser.

---

## Honesty rules

These are enforced in code, not just intended.

- **Nothing is invented.** If no search provider is configured and the claim
  matches no built-in corpus, the investigation completes with **zero sources**
  and says so. The claim card, category and missing-evidence analysis still
  render, because those do not require sources.
- **Demonstration data is labelled everywhere it appears.** The built-in cases
  are fictional; every URL in them uses the reserved `.invalid` top-level
  domain, so no link can resolve to a real page and none is ever fetched.
- **Live research is labelled as live.** A configured search adapter always wins
  over a demonstration corpus.
- **Unread pages are marked unread.** A search hit whose page has not been
  fetched is `UNVERIFIED SOURCE` with no stance, and scoring penalises exactly
  that.
- **The score is evidence strength, not probability of truth.** A true claim
  whose records are lost scores low; a well-documented claim scores high right
  up until it is overturned. The label says so where the number is.
- **Epistemic categories are never promoted.** FACT / CLAIM / ALLEGATION /
  INTERPRETATION / SPECULATION / UNVERIFIED REPORT are ranked, and a model
  response that returns `FACT` is rejected outright.
- **Deferred features are labelled deferred.** There are no buttons that look
  live and do nothing.

---

## Architecture

```
src/
  core/
    types.ts              the domain model — the contract between pipeline, store and UI
    pipeline/
      claim.ts            normalisation, categorisation, epistemic status, dates
      entities.ts         entity extraction
      classify-sources.ts type, reliability prior, primary/secondary
      citations.ts        citation resolution; CITES vs DERIVED_FROM
      lineage.ts          ★ Source DNA — families, depth, cycles, ancestry
      evidence.ts         evidence items, independence weighting
      contradictions.ts   stance conflicts, chronology violations, retractions
      missing-evidence.ts gap analysis, structural rules + category templates
      timeline.ts         partial-date ordering, dependency conflicts
      scoring.ts          seven components, six penalties, full rationale
      synthesis.ts        the written summary
      index.ts            the staged orchestrator
    llm/                  provider interface + Anthropic / OpenAI / Gemini adapters
    research/             SearchAdapter interface + Brave / Tavily + fixture corpus
    store/                InvestigationStore interface + file and memory stores
    fixtures/             the built-in demonstration cases
  app/                    landing, workspace, case history, API routes
  components/             UI primitives, workspace panels, landing sections
```

**Provider isolation.** Business logic never imports a vendor SDK. `LLMProvider`
and `SearchAdapter` are small interfaces; adding a provider is one file.

**Persistence.** `InvestigationStore` is `save / get / list / delete`. The file
store writes one JSON document per investigation under `.data/`. Moving to
Postgres or Supabase means one new class and no call-site changes.

**Progress reporting.** The pipeline emits a record as each stage completes, and
the API streams those over Server-Sent Events. The UI shows what finished and
what it found. There is no percentage, because the pipeline cannot know one.

---

## Two ideas worth knowing about

**A source family is an origin plus everything that descends from it.** It is
deliberately not a connected component of the citation graph: one aggregator
citing five independent studies would merge them into a single component, and
calling that one family would report five separate origins as corroborating
nothing. Each source is attached to the nearest origin that reaches it, and a
family counts once however many members it has. Independence falls by distance
from that origin —
`0 → 1.0, 1 → 0.45, 2 → 0.25, 3+ → 0.15` — because the first hop is where the
information is lost and later hops add almost nothing.

**Citing is not deriving.** A replication that cites the study it re-tests is
not downstream of it. Such a source keeps its citation edges — the map still
draws them — but contributes no derivation edge, so it forms its own family and
counts as genuine corroboration.

---

## Demonstration cases

Both are fictional, and both are reachable from the home input as well as the
demo button.

**Unknown-primate DNA** (`Cryptid`) — 15 sources → **3 independent families**.
Eleven of them, including nearly all the visible coverage, descend from one
laboratory report that nobody has produced and which is dated *after* the
interview that cites it. Contains a circular citation loop between two outlets,
a retraction, a failed peer-reviewed replication and a first-party denial from
the institution named. Scores **3/100 — INSUFFICIENT**.

**Custody-held metal fragment** (`UAP`) — 9 sources → **3 independent families**.
The deliberate counterweight: the narrow, checkable claim is carried by
first-party documents and two independent laboratory analyses, and scores
**80/100 — STRONG**. ProofHound is not a debunking machine. Source DNA still
earns its place: six of the nine sources form one chain in which an anonymous
quote from a magazine feature is progressively re-attributed to a government
filing that never said it.

---

## Testing

```sh
npm run test      # 143 unit, integration and component tests
npm run verify    # the whole gate
```

Covered: source-family detection (chains, multi-root merges, cycles, dangling
references, orphans), independence weighting, ancestry resolution, evidence
scoring (every component, every penalty, banding, clamping, arithmetic),
claim normalisation and categorisation, epistemic classification, source
classification, citation resolution, partial-date ordering, chronology conflict
detection, store round-tripping and path-traversal refusal, defensive parsing of
model output, and the workspace's rendering and filtering paths.

`e2e/verify.mjs` drives the production build in real Chromium at desktop, tablet
and phone viewports: it walks the full flow, asserts no console errors, no
horizontal overflow, no text below 9.5px and no graph label pile-ups, and writes
screenshots.

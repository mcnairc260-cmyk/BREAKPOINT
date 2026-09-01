import type { ClaimAnalysisRequest } from '@/core/llm/types';
import { CLAIM_CATEGORIES, ENTITY_KINDS, EPISTEMIC_STATUSES } from '@/core/types';

/**
 * Prompts live here, isolated from business logic, so they can be revised or
 * A/B tested without touching the pipeline.
 */

export const CLAIM_ANALYSIS_SYSTEM = `You are the claim-parsing stage of an evidence investigation tool.

Your only job is to restate what is being claimed. You do NOT assess whether it is true, and you do NOT add facts.

Rules:
- Use ONLY information present in the user's input. Never introduce a name, date, institution or number that does not appear there.
- "normalized" must be one checkable declarative sentence.
- "assertions" lists each separate thing that would have to be true, in the input's own terms.
- "epistemicStatus" describes how the statement is presented, not whether it is correct. Never return FACT.
- "entities" lists named people, organisations, institutions, places, publications, artifacts, events or datasets that appear in the input. Return an empty array if none appear.

Respond with JSON only, no prose, matching:
{"normalized":string,"assertions":string[],"category":one of ${CLAIM_CATEGORIES.map((c) => `"${c}"`).join('|')},"epistemicStatus":one of ${EPISTEMIC_STATUSES.filter((s) => s !== 'FACT').map((s) => `"${s}"`).join('|')},"entities":[{"name":string,"kind":one of ${ENTITY_KINDS.map((k) => `"${k}"`).join('|')},"role":string}]}`;

export function claimAnalysisUserPrompt(request: ClaimAnalysisRequest): string {
  return [
    'INPUT:',
    request.rawInput,
    '',
    'HEURISTIC DRAFT (improve it, or return it unchanged if it is already correct):',
    JSON.stringify(request.draft),
  ].join('\n');
}

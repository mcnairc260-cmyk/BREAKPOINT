import type { ClaimAnalysisResult } from '@/core/llm/types';
import { CLAIM_CATEGORIES, ENTITY_KINDS, EPISTEMIC_STATUSES } from '@/core/types';
import type { ClaimCategory, EntityKind, EpistemicStatus } from '@/core/types';

/**
 * Defensive parsing of model output.
 *
 * Anything unexpected returns null so the caller falls back to the heuristic
 * result. A malformed model response must never become a rendered claim card.
 */

const CATEGORIES = new Set<string>(CLAIM_CATEGORIES);
const STATUSES = new Set<string>(EPISTEMIC_STATUSES);
const KINDS = new Set<string>(ENTITY_KINDS);

function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

export function parseClaimAnalysis(text: string): ClaimAnalysisResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;

  const normalized = typeof data.normalized === 'string' ? data.normalized.trim() : '';
  if (normalized.length < 8) return null;

  const assertions = Array.isArray(data.assertions)
    ? data.assertions.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
    : [];

  const category = CATEGORIES.has(String(data.category)) ? (data.category as ClaimCategory) : null;
  // A model returning FACT is refusing the instruction; drop the whole result.
  const status = String(data.epistemicStatus);
  if (status === 'FACT') return null;
  const epistemicStatus = STATUSES.has(status) ? (status as EpistemicStatus) : null;
  if (!category || !epistemicStatus) return null;

  const entities = Array.isArray(data.entities)
    ? data.entities
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({
          name: typeof e.name === 'string' ? e.name.trim() : '',
          kind: KINDS.has(String(e.kind)) ? (e.kind as EntityKind) : ('organization' as EntityKind),
          role: typeof e.role === 'string' ? e.role.trim() : '',
        }))
        .filter((e) => e.name.length > 1)
    : [];

  return {
    normalized,
    assertions: assertions.length > 0 ? assertions : [normalized],
    category,
    epistemicStatus,
    entities,
  };
}

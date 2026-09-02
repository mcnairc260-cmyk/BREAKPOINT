import type { Investigation } from '@/core/types';

/**
 * Persistence boundary.
 *
 * Deliberately small. Moving from the bundled file store to Postgres or
 * Supabase means writing one new class that satisfies this interface — no call
 * site changes, no query strings leaking into the pipeline or the UI.
 */
export interface InvestigationStore {
  readonly name: string;
  save(investigation: Investigation): Promise<void>;
  get(id: string): Promise<Investigation | null>;
  /** Newest first. */
  list(limit?: number): Promise<InvestigationSummaryRow[]>;
  delete(id: string): Promise<void>;
}

/**
 * The subset the history list needs.
 *
 * The file store still reads each document to build these rows; the point of
 * the row type is that callers of `list` never receive whole investigations,
 * so a store backed by a real database can satisfy it with one projection.
 */
export interface InvestigationSummaryRow {
  id: string;
  createdAt: string;
  claim: string;
  category: string;
  score: number;
  sourceCount: number;
  familyCount: number;
  isDemonstration: boolean;
}

export function toSummaryRow(investigation: Investigation): InvestigationSummaryRow {
  return {
    id: investigation.id,
    createdAt: investigation.createdAt,
    claim: investigation.claim.normalized,
    category: investigation.claim.category,
    score: investigation.score.value,
    sourceCount: investigation.sources.length,
    familyCount: investigation.lineage.independentFamilyCount,
    isDemonstration: investigation.isDemonstration,
  };
}

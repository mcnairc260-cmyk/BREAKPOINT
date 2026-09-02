import type { ClaimCategory, EntityKind, EpistemicStatus } from '@/core/types';

/**
 * Model abstraction.
 *
 * Business logic never imports a vendor SDK. Every provider implements this
 * interface, is selected from environment variables, and is only ever
 * constructed on the server — no key reaches the browser.
 *
 * A provider *refines* the deterministic analysis; it never replaces it. If a
 * provider is absent, misconfigured, times out or returns something malformed,
 * the pipeline keeps the heuristic result and says which engine ran.
 */

export interface ClaimAnalysisRequest {
  rawInput: string;
  /** The heuristic result, offered to the model as a starting point. */
  draft: {
    normalized: string;
    assertions: string[];
    category: ClaimCategory;
    epistemicStatus: EpistemicStatus;
  };
}

export interface ClaimAnalysisResult {
  normalized: string;
  assertions: string[];
  category: ClaimCategory;
  epistemicStatus: EpistemicStatus;
  entities: Array<{ name: string; kind: EntityKind; role: string }>;
}

export interface LLMProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Returns null when the provider cannot help; the caller then keeps the draft. */
  analyzeClaim(request: ClaimAnalysisRequest): Promise<ClaimAnalysisResult | null>;
}

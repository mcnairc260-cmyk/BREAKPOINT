import type { Investigation } from '@/core/types';
import type { InvestigationStore, InvestigationSummaryRow } from '@/core/store/types';
import { toSummaryRow } from '@/core/store/types';

/**
 * In-memory store.
 *
 * The default in tests and the fallback when the filesystem is read-only (a
 * serverless deployment, for instance). Data does not survive a restart, which
 * the UI states rather than implying durability it does not have.
 */
export class MemoryStore implements InvestigationStore {
  readonly name = 'memory';
  private readonly items = new Map<string, Investigation>();

  async save(investigation: Investigation): Promise<void> {
    this.items.set(investigation.id, investigation);
  }

  async get(id: string): Promise<Investigation | null> {
    return this.items.get(id) ?? null;
  }

  async list(limit = 50): Promise<InvestigationSummaryRow[]> {
    return [...this.items.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(toSummaryRow);
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

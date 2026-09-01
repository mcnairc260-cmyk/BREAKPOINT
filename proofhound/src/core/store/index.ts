import type { InvestigationStore } from '@/core/store/types';
import { FileStore } from '@/core/store/file-store';
import { MemoryStore } from '@/core/store/memory-store';

export type { InvestigationStore, InvestigationSummaryRow } from '@/core/store/types';
export { FileStore, MemoryStore };

/**
 * Store selection, cached across hot reloads.
 *
 * `PROOFHOUND_STORE=memory` forces the ephemeral store; anything else uses the
 * file store. The instance is stashed on `globalThis` because Next.js recreates
 * modules on every edit in development and a fresh MemoryStore each time would
 * lose every investigation the moment a file is saved.
 */
const CACHE_KEY = Symbol.for('proofhound.store');

interface StoreCache {
  [CACHE_KEY]?: InvestigationStore;
}

export function getStore(): InvestigationStore {
  const cache = globalThis as StoreCache;
  if (!cache[CACHE_KEY]) {
    cache[CACHE_KEY] =
      process.env.PROOFHOUND_STORE === 'memory' ? new MemoryStore() : new FileStore();
  }
  return cache[CACHE_KEY];
}

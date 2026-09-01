import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore, MemoryStore } from '@/core/store';
import type { InvestigationStore } from '@/core/store';
import { runInvestigation } from '@/core/pipeline';
import { HeuristicProvider } from '@/core/llm';

async function sampleInvestigation() {
  return runInvestigation('', { demoId: 'cryptid-dna', llm: new HeuristicProvider() });
}

function behavesLikeAStore(name: string, create: () => InvestigationStore): void {
  describe(name, () => {
    it('round-trips an investigation without losing structure', async () => {
      const store = create();
      const investigation = await sampleInvestigation();
      await store.save(investigation);

      const loaded = await store.get(investigation.id);
      expect(loaded?.id).toBe(investigation.id);
      expect(loaded?.sources).toHaveLength(investigation.sources.length);
      expect(loaded?.lineage.independentFamilyCount).toBe(investigation.lineage.independentFamilyCount);
      expect(loaded?.score.components).toHaveLength(investigation.score.components.length);
    });

    it('returns null for an unknown id', async () => {
      expect(await create().get('doesnotexist')).toBeNull();
    });

    it('lists newest first and summarises without loading everything', async () => {
      const store = create();
      const investigation = await sampleInvestigation();
      await store.save(investigation);
      const rows = await store.list();
      expect(rows[0]?.id).toBe(investigation.id);
      expect(rows[0]?.familyCount).toBe(investigation.lineage.independentFamilyCount);
      expect(rows[0]?.isDemonstration).toBe(true);
    });

    it('deletes', async () => {
      const store = create();
      const investigation = await sampleInvestigation();
      await store.save(investigation);
      await store.delete(investigation.id);
      expect(await store.get(investigation.id)).toBeNull();
    });
  });
}

behavesLikeAStore('MemoryStore', () => new MemoryStore());

describe('FileStore', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'proofhound-store-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  behavesLikeAStore('behaviour', () => new FileStore(root));

  it('refuses an id that would escape the store directory', async () => {
    const store = new FileStore(root);
    await expect(store.get('../../etc/passwd')).resolves.toBeNull();
    await expect(store.delete('../../etc/passwd')).rejects.toThrow('Invalid investigation id');
  });
});

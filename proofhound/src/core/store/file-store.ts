import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Investigation } from '@/core/types';
import type { InvestigationStore, InvestigationSummaryRow } from '@/core/store/types';
import { toSummaryRow } from '@/core/store/types';

/**
 * File-backed store.
 *
 * One JSON document per investigation plus a small index, which is enough for
 * local use and keeps the shape of a row-per-investigation table so the move to
 * Postgres is a translation rather than a redesign.
 */
export class FileStore implements InvestigationStore {
  readonly name = 'file';

  constructor(private readonly root = path.join(process.cwd(), '.data', 'investigations')) {}

  private file(id: string): string {
    // Ids are generated from a fixed alphabet, but a store must never trust an
    // id it is handed — a traversal here would read arbitrary files.
    if (!/^[a-z0-9]{1,64}$/.test(id)) throw new Error('Invalid investigation id.');
    return path.join(this.root, `${id}.json`);
  }

  async save(investigation: Investigation): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.file(investigation.id), JSON.stringify(investigation), 'utf8');
  }

  async get(id: string): Promise<Investigation | null> {
    try {
      const raw = await readFile(this.file(id), 'utf8');
      return JSON.parse(raw) as Investigation;
    } catch {
      return null;
    }
  }

  async list(limit = 50): Promise<InvestigationSummaryRow[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const rows: InvestigationSummaryRow[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const raw = await readFile(path.join(this.root, name), 'utf8');
        rows.push(toSummaryRow(JSON.parse(raw) as Investigation));
      } catch {
        // A corrupt file must not break the history list.
      }
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}

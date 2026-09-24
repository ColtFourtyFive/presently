import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDatabase, type Database } from '../server/db.js';

it('creates a fresh nested local database and preserves committed data after reopening', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kumon-database-'));
  const dataDir = path.join(directory, 'new', 'nested', 'postgres');
  let db: Database | null = null;
  try {
    await expect(stat(path.dirname(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
    db = await createDatabase({ url: '', dataDir });
    await db.query('CREATE TABLE persistence_check (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await db.transaction(async tx => {
      await tx.query('INSERT INTO persistence_check(id,value) VALUES($1,$2)', [1, 'Committed before restart']);
    });
    await db.close();
    db = null;

    db = await createDatabase({ url: '', dataDir });
    const result = await db.query('SELECT id,value FROM persistence_check');
    expect(result.rows).toEqual([{ id: 1, value: 'Committed before restart' }]);
    expect((await stat(dataDir)).isDirectory()).toBe(true);
  } finally {
    if (db) await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export type Row = Record<string, any>;
export interface QueryResult<T = Row> { rows: T[]; rowCount: number }
export interface Queryable { query<T = Row>(sql: string, params?: any[]): Promise<QueryResult<T>> }
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

export async function createDatabase(options: { url?: string; dataDir?: string } = {}): Promise<Database> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10000 });
    const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
      async query<T = Row>(sql: string, params: any[] = []) {
        const result = await client.query(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      },
    });
    return {
      ...wrap(pool), kind: 'postgres',
      async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const result = await fn(wrap(client)); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? './.data/postgres';
  // PGlite creates its database directory, but its filesystem adapter does not
  // create missing ancestor directories on a fresh application checkout.
  if (dataDir !== 'memory://') await mkdir(path.dirname(path.resolve(dataDir)), { recursive: true });
  const db = new PGlite(dataDir);
  await db.waitReady;
  // A single embedded connection requires one queue around whole transactions,
  // so an unrelated request cannot execute inside another request's transaction.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const current = tail.then(fn, fn); tail = current.catch(() => {}); return current;
  };
  const wrap = (client: Pick<PGlite, 'query'>): Queryable => ({
    async query<T = Row>(sql: string, params: any[] = []) {
      const result = await client.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });
  return {
    kind: 'pglite',
    query: (sql, params) => serialize(() => wrap(db).query(sql, params)),
    transaction: fn => serialize(() => db.transaction(tx => fn(wrap(tx as any)))),
    close: () => serialize(() => db.close()),
  };
}

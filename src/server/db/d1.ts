import type {
  SqlDatabase,
  SqlParam,
  SqlRunResult,
  SqlStatement,
} from "./types.ts";

export const d1Adapter = (db: D1Database): SqlDatabase => ({
  async first<T>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T | null> {
    const stmt =
      params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);

    return stmt.first<T>();
  },

  async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    const stmt =
      params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);
    const result = await stmt.all<T>();

    return result.results;
  },

  async run(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<SqlRunResult> {
    const stmt =
      params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);
    const result = await stmt.run();

    return { changes: result.meta.changes ?? 0 };
  },

  async batch(
    statements: readonly SqlStatement[],
  ): Promise<readonly SqlRunResult[]> {
    if (statements.length === 0) {
      return [];
    }
    const prepared = statements.map((statement) => {
      const params = statement.params ?? [];

      return params.length > 0
        ? db.prepare(statement.sql).bind(...params)
        : db.prepare(statement.sql);
    });
    const results = await db.batch(prepared);

    return results.map((result) => ({ changes: result.meta.changes ?? 0 }));
  },
});

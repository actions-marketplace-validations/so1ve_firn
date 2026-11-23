import type {
  SqlDatabase,
  SqlParam,
  SqlRunResult,
  SqlStatement,
} from "./types.ts";

export function d1Adapter(db: D1Database): SqlDatabase {
  const prepare = (sql: string, params: readonly SqlParam[] = []) =>
    params.length > 0 ? db.prepare(sql).bind(...params) : db.prepare(sql);

  return {
    first: <T>(sql: string, params?: readonly SqlParam[]) =>
      prepare(sql, params).first<T>(),

    async all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]> {
      const result = await prepare(sql, params).all<T>();

      return result.results;
    },

    async run(
      sql: string,
      params?: readonly SqlParam[],
    ): Promise<SqlRunResult> {
      const result = await prepare(sql, params).run();

      return { changes: result.meta.changes ?? 0 };
    },

    async batch(
      statements: readonly SqlStatement[],
    ): Promise<readonly SqlRunResult[]> {
      if (statements.length === 0) {
        return [];
      }
      const results = await db.batch(
        statements.map((s) => prepare(s.sql, s.params)),
      );

      return results.map((result) => ({ changes: result.meta.changes ?? 0 }));
    },
  };
}

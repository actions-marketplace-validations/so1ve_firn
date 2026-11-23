import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  SqlDatabase,
  SqlParam,
  SqlRunResult,
  SqlStatement,
} from "./types.ts";

export interface CloseableSqlDatabase extends SqlDatabase {
  close: () => void;
}

export function openNodeSqlite(dbPath: string): CloseableSqlDatabase {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  return {
    first<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | null> {
      const row = db.prepare(sql).get(...params);

      return Promise.resolve((row as T | undefined) ?? null);
    },

    all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
      const rows = db.prepare(sql).all(...params);

      return Promise.resolve(rows as T[]);
    },

    run(sql: string, params: readonly SqlParam[] = []): Promise<SqlRunResult> {
      const result = db.prepare(sql).run(...params);

      return Promise.resolve({ changes: Number(result.changes) });
    },

    batch(
      statements: readonly SqlStatement[],
    ): Promise<readonly SqlRunResult[]> {
      if (statements.length === 0) {
        return Promise.resolve([]);
      }

      db.exec("BEGIN IMMEDIATE;");
      try {
        const results: SqlRunResult[] = [];
        for (const statement of statements) {
          const result = db
            .prepare(statement.sql)
            .run(...(statement.params ?? []));
          results.push({ changes: Number(result.changes) });
        }
        db.exec("COMMIT;");

        return Promise.resolve(results);
      } catch (error) {
        db.exec("ROLLBACK;");

        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },

    close(): void {
      db.close();
    },
  };
}

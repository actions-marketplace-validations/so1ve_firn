import fs from "node:fs";
import path from "node:path";

import { unixNow } from "../../shared/nix-format.ts";
import type { SqlDatabase } from "./types.ts";

export interface Migration {
  name: string;
  statements: readonly string[];
}

export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "../../../migrations",
);

export function splitSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith("--") ? "" : line))
    .join("\n");

  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function loadMigrations(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Migration[] {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return files.map((name) => {
    const content = fs.readFileSync(path.join(migrationsDir, name), "utf8");

    return {
      name,
      statements: splitSqlStatements(content),
    };
  });
}

export async function applyMigrations(
  db: SqlDatabase,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS _firn_migrations (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  const existing = await db.all<{ name: string }>(
    "SELECT name FROM _firn_migrations",
  );
  const applied = new Set(existing.map((row) => row.name));
  const newlyApplied: string[] = [];

  for (const migration of loadMigrations(migrationsDir)) {
    if (applied.has(migration.name)) {
      continue;
    }

    await db.batch([
      ...migration.statements.map((sql) => ({ sql })),
      {
        sql: "INSERT INTO _firn_migrations (name, applied_at) VALUES (?1, ?2)",
        params: [migration.name, unixNow()],
      },
    ]);
    newlyApplied.push(migration.name);
  }

  return newlyApplied;
}

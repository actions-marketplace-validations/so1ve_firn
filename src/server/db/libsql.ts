import type { Row, StmtResult } from "@libsql/hrana-client";
import { BatchCond, openHttp } from "@libsql/hrana-client";

import type { CloseableSqlDatabase } from "./sqlite.ts";
import type { SqlParam, SqlRunResult, SqlStatement } from "./types.ts";

export function normalizeLibsqlHttpUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("libsql://")) {
    return `https://${trimmed.slice("libsql://".length)}`;
  }
  if (trimmed.startsWith("wss://")) {
    return `https://${trimmed.slice("wss://".length)}`;
  }
  if (trimmed.startsWith("ws://")) {
    return `http://${trimmed.slice("ws://".length)}`;
  }

  return trimmed;
}

function rowToObject<T>(
  columnNames: readonly (string | undefined)[],
  row: Row,
): T {
  const record: Record<string, unknown> = {};
  for (const [index, colName] of columnNames.entries()) {
    if (colName !== undefined) {
      record[colName] = row[index];
    }
  }

  return record as T;
}

export function openLibsql(
  url: string,
  authToken?: string,
  customFetch?: typeof globalThis.fetch,
): CloseableSqlDatabase {
  const client = openHttp(
    normalizeLibsqlHttpUrl(url),
    authToken || undefined,
    customFetch,
  );
  client.intMode = "number";

  async function withStream<T>(
    fn: (stream: ReturnType<typeof client.openStream>) => Promise<T>,
  ): Promise<T> {
    const stream = client.openStream();
    try {
      return await fn(stream);
    } finally {
      stream.closeGracefully();
    }
  }

  return {
    async first<T>(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<T | null> {
      return withStream(async (stream) => {
        const result = await stream.queryRow([sql, [...params]]);
        if (!result.row) {
          return null;
        }

        return rowToObject<T>(result.columnNames, result.row);
      });
    },

    async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
      return withStream(async (stream) => {
        const result = await stream.query([sql, [...params]]);

        return result.rows.map((row) =>
          rowToObject<T>(result.columnNames, row),
        );
      });
    },

    async run(
      sql: string,
      params: readonly SqlParam[] = [],
    ): Promise<SqlRunResult> {
      return withStream(async (stream) => {
        const result = await stream.run([sql, [...params]]);

        return { changes: result.affectedRowCount };
      });
    },

    async batch(
      statements: readonly SqlStatement[],
    ): Promise<readonly SqlRunResult[]> {
      if (statements.length === 0) {
        return [];
      }

      return withStream(async (stream) => {
        const batch = stream.batch();
        const beginStep = batch.step();
        const beginPromise = beginStep.run("BEGIN IMMEDIATE");

        let prevStep = beginStep;
        const resultPromises: Promise<StmtResult | undefined>[] = [];
        for (const statement of statements) {
          const step = batch.step().condition(BatchCond.ok(prevStep));
          resultPromises.push(
            step.run([statement.sql, [...(statement.params ?? [])]]),
          );
          prevStep = step;
        }

        const commitStep = batch.step().condition(BatchCond.ok(prevStep));
        const commitPromise = commitStep.run("COMMIT");

        const rollbackStep = batch
          .step()
          .condition(BatchCond.not(BatchCond.ok(commitStep)));
        const rollbackPromise = rollbackStep.run("ROLLBACK");

        await batch.execute();
        await beginPromise;
        const settled = await Promise.all(resultPromises);
        await commitPromise;
        await rollbackPromise.catch(() => {});

        return settled.map((res) => ({
          changes: res?.affectedRowCount ?? 0,
        }));
      });
    },

    close(): void {
      client.close();
    },
  };
}

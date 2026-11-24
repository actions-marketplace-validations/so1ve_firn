import type { Row, StmtResult } from "@libsql/hrana-client";
import { BatchCond, openHttp } from "@libsql/hrana-client";

import type {
  CloseableSqlDatabase,
  SqlParam,
  SqlRunResult,
  SqlStatement,
} from "../db.ts";

export const normalizeLibsqlHttpUrl = (rawUrl: string): string =>
  rawUrl
    .trim()
    .replace(/^libsql:\/\//, "https://")
    .replace(/^ws(s?):\/\//, "http$1://");

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
    first: <T>(sql: string, params: readonly SqlParam[] = []) =>
      withStream(async (stream) => {
        const result = await stream.queryRow([sql, [...params]]);

        return result.row
          ? rowToObject<T>(result.columnNames, result.row)
          : null;
      }),

    all: <T>(sql: string, params: readonly SqlParam[] = []) =>
      withStream(async (stream) => {
        const result = await stream.query([sql, [...params]]);

        return result.rows.map((row) =>
          rowToObject<T>(result.columnNames, row),
        );
      }),

    run: (sql: string, params: readonly SqlParam[] = []) =>
      withStream(async (stream) => ({
        changes: (await stream.run([sql, [...params]])).affectedRowCount,
      })),

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
        const rollbackPromise = batch
          .step()
          .condition(BatchCond.not(BatchCond.ok(commitStep)))
          .run("ROLLBACK");

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

    close: () => client.close(),
  };
}

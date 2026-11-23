export type SqlParam = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: readonly SqlParam[];
}

export interface SqlRunResult {
  changes: number;
}

export interface SqlDatabase {
  first: <T>(sql: string, params?: readonly SqlParam[]) => Promise<T | null>;
  all: <T>(sql: string, params?: readonly SqlParam[]) => Promise<T[]>;
  run: (sql: string, params?: readonly SqlParam[]) => Promise<SqlRunResult>;
  batch: (
    statements: readonly SqlStatement[],
  ) => Promise<readonly SqlRunResult[]>;
}

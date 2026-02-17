declare module 'pg' {
  export interface QueryResult<RowType = Record<string, unknown>> {
    rows: RowType[];
    rowCount: number | null;
  }

  export interface PoolConfig {
    connectionString?: string;
    ssl?:
      | boolean
      | {
        rejectUnauthorized?: boolean;
      };
  }

  export interface PoolClient {
    query<RowType = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<RowType>>;
    release(): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<RowType = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<RowType>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}

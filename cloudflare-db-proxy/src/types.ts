export type Env = Cloudflare.Env;

export type QueryMethod = 'get' | 'all' | 'run' | 'values';

export type QueryRequest = {
  sql: string;
  params: unknown[];
  method: QueryMethod;
};

export type BatchRequest = {
  queries: QueryRequest[];
};

export type QuerySuccessResponse = {
  rows: unknown[] | unknown[][];
};

export type BatchSuccessResponse = Array<QuerySuccessResponse>;

export type ErrorResponse = {
  error: {
    code: ErrorCode;
    message: string;
  };
};

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'SQL_ERROR'
  | 'RATE_LIMITED';

export type ProvisionResponse = {
  appId: string;
  dbUrl: string;
  dbToken: string;
};

export type SchemaResponse = {
  tables: Array<{ name: string; sql: string }>;
  indexes: Array<{ name: string; sql: string }>;
};

export type ExportResponse = {
  dump: string;
};

export type TableInfo = {
  name: string;
  type: string;
  sql: string;
};

export type IndexInfo = {
  name: string;
  sql: string;
};

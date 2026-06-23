import * as z from 'zod';

export const QueryKiloDatasetNameSchema = z.enum([
  'microdollar_usage',
  'code_reviews',
  'cloud_sessions',
  'cli_sessions',
  'vscode_sessions',
]);

const QueryKiloDatasetRangeSchema = z
  .object({
    startDate: z
      .string()
      .min(1)
      .optional()
      .describe('Inclusive ISO timestamp lower bound. Defaults to 60 days before endDate.'),
    endDate: z
      .string()
      .min(1)
      .optional()
      .describe('Exclusive ISO timestamp upper bound. Defaults to now.'),
  })
  .strict()
  .describe('Half-open createdAt range. The maximum duration is 60 days.');

const QueryKiloDatasetFilterSchema = z
  .object({
    field: z.string().min(1).describe('Public dataset field name from describe_kilo_dataset.'),
    operator: z
      .enum([
        'eq',
        'neq',
        'in',
        'notIn',
        'contains',
        'startsWith',
        'gt',
        'gte',
        'lt',
        'lte',
        'isNull',
        'isNotNull',
      ])
      .describe('Filter operator allowed for the selected field.'),
    value: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.union([z.string(), z.number(), z.boolean()])),
      ])
      .optional()
      .describe('Required for all operators except isNull and isNotNull.'),
  })
  .strict();

const QueryKiloDatasetMetricSchema = z
  .object({
    operation: z
      .enum(['count', 'countDistinct', 'sum', 'avg', 'min', 'max'])
      .describe('Metric operation. count has no field; every other operation requires a field.'),
    field: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Metric field. Omit for count; required for sum, avg, min, max, and countDistinct.'
      ),
  })
  .strict()
  .superRefine((metric, ctx) => {
    if (metric.operation === 'count' && metric.field !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['field'],
        message: 'count must not specify a field; use { "operation": "count" }',
      });
    }
    if (metric.operation !== 'count' && metric.field === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['field'],
        message: `${metric.operation} requires a field from describe_kilo_dataset`,
      });
    }
  });

export const QueryKiloDatasetInputSchema = z
  .object({
    dataset: QueryKiloDatasetNameSchema.describe(
      'Dataset to query. Use describe_kilo_dataset to inspect available fields.'
    ),
    mode: z
      .enum(['aggregate', 'timeseries'])
      .describe('aggregate returns grouped totals and has no bucket; timeseries requires bucket.'),
    range: QueryKiloDatasetRangeSchema.optional(),
    filters: z
      .array(QueryKiloDatasetFilterSchema)
      .max(8)
      .describe(
        'ANDed filters over public fields. Use describe_kilo_dataset for field capabilities.'
      )
      .optional(),
    metrics: z.array(QueryKiloDatasetMetricSchema).min(1).max(5).describe('Metrics to compute.'),
    groupBy: z
      .array(z.string().min(1))
      .max(2)
      .describe('Public group field names from describe_kilo_dataset.')
      .optional(),
    bucket: z
      .enum(['hour', 'day', 'week'])
      .describe('Required for timeseries mode and rejected for aggregate mode.')
      .optional(),
    orderBy: z
      .array(
        z
          .object({
            field: z
              .string()
              .min(1)
              .describe('Selected output field name, such as count, sum_costUsd, or bucketStart.'),
            direction: z.enum(['asc', 'desc']),
          })
          .strict()
      )
      .max(2)
      .describe('Sort selected output fields only.')
      .optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .describe('Maximum output rows. Defaults to 50.')
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.mode === 'aggregate' && input.bucket !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bucket'],
        message: 'aggregate mode does not accept bucket; remove bucket or use mode: "timeseries"',
      });
    }
    if (input.mode === 'timeseries' && input.bucket === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bucket'],
        message: 'timeseries mode requires bucket: "hour", "day", or "week"',
      });
    }
  });

export const GetKiloUsageCostInputSchema = z
  .object({
    period: z
      .enum(['today', 'yesterday', 'last_7_days', 'last_30_days'])
      .describe('Common calendar period to total.'),
    timezone: z
      .string()
      .nullable()
      .describe(
        'Exact IANA timezone for calendar boundaries, or null to use UTC when no user/local timezone is known.'
      ),
  })
  .strict();

export const DescribeKiloDatasetInputSchema = z
  .object({
    dataset: QueryKiloDatasetNameSchema.optional().describe(
      'Optional dataset name. Omit to list every available dataset.'
    ),
    includeExamples: z
      .boolean()
      .optional()
      .describe('Whether to include example query_kilo_dataset payloads. Defaults to true.'),
  })
  .strict();

export type QueryKiloDatasetInput = z.infer<typeof QueryKiloDatasetInputSchema>;
export type DescribeKiloDatasetInput = z.infer<typeof DescribeKiloDatasetInputSchema>;
export type GetKiloUsageCostInput = z.infer<typeof GetKiloUsageCostInputSchema>;

export type QueryKiloDatasetColumn = {
  name: string;
  type: 'string' | 'boolean' | 'integer' | 'decimal' | 'timestamp';
  nullable: boolean;
};

export type QueryKiloDatasetOutput = {
  dataset: QueryKiloDatasetInput['dataset'];
  mode: QueryKiloDatasetInput['mode'];
  scope: { type: 'me' };
  range: {
    startDate: string;
    endDate: string;
    timeField: 'createdAt';
  };
  columns: QueryKiloDatasetColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
};

export type GetKiloUsageCostOutput = {
  dataset: 'microdollar_usage';
  period: GetKiloUsageCostInput['period'];
  timezone: string;
  range: QueryKiloDatasetOutput['range'];
  columns: QueryKiloDatasetColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
  summary: {
    totalCostUsd: string;
    totalCostMicrodollars: number;
    rowCount: number;
  };
  query: {
    tool: 'query_kilo_dataset';
    input: QueryKiloDatasetInput;
  };
};

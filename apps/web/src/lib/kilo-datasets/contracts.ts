import * as z from 'zod';

export const QueryKiloDatasetNameSchema = z.enum([
  'microdollar_usage',
  'code_reviews',
  'cloud_sessions',
  'cli_sessions',
  'vscode_sessions',
]);

export const QueryKiloDatasetInputSchema = z
  .object({
    dataset: QueryKiloDatasetNameSchema,
    mode: z.enum(['aggregate', 'timeseries']),
    range: z
      .object({
        startDate: z.string().min(1).optional(),
        endDate: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    filters: z
      .array(
        z
          .object({
            field: z.string().min(1),
            operator: z.enum([
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
            ]),
            value: z
              .union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.union([z.string(), z.number(), z.boolean()])),
              ])
              .optional(),
          })
          .strict()
      )
      .max(8)
      .optional(),
    metrics: z
      .array(
        z
          .object({
            operation: z.enum(['count', 'countDistinct', 'sum', 'avg', 'min', 'max']),
            field: z.string().min(1).optional(),
          })
          .strict()
      )
      .min(1)
      .max(5),
    groupBy: z.array(z.string().min(1)).max(2).optional(),
    bucket: z.enum(['hour', 'day', 'week']).optional(),
    orderBy: z
      .array(
        z
          .object({
            field: z.string().min(1),
            direction: z.enum(['asc', 'desc']),
          })
          .strict()
      )
      .max(2)
      .optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();

export type QueryKiloDatasetInput = z.infer<typeof QueryKiloDatasetInputSchema>;

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

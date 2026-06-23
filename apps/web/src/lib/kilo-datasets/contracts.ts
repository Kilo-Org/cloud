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

export const QueryKiloDatasetColumnSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['string', 'boolean', 'integer', 'decimal', 'timestamp']),
    nullable: z.boolean(),
  })
  .strict();

export const QueryKiloDatasetScalarRowValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const QueryKiloDatasetOutputSchema = z
  .object({
    dataset: QueryKiloDatasetNameSchema,
    mode: QueryKiloDatasetInputSchema.shape.mode,
    scope: z.object({ type: z.literal('me') }).strict(),
    range: z
      .object({
        startDate: z.string().datetime(),
        endDate: z.string().datetime(),
        timeField: z.literal('createdAt'),
      })
      .strict(),
    columns: z.array(QueryKiloDatasetColumnSchema),
    rows: z.array(z.record(z.string(), QueryKiloDatasetScalarRowValueSchema)),
  })
  .strict();

export type QueryKiloDatasetColumn = z.infer<typeof QueryKiloDatasetColumnSchema>;
export type QueryKiloDatasetOutput = z.infer<typeof QueryKiloDatasetOutputSchema>;

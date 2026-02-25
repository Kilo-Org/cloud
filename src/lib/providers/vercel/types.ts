import * as z from 'zod';

export const ModelSchema = z.object({ id: z.string(), name: z.string() });

export const ModelsSchema = z.object({ data: z.array(ModelSchema) });

export const EndpointSchema = z.object({
  provider_name: z.string(),
  tag: z.string(),
  context_length: z.number(),
});

export const EndpointsSchema = z.object({
  data: z.object({ endpoints: z.array(EndpointSchema) }),
});

export const StoredModelSchema = ModelSchema.and(
  z.object({
    endpoints: z.array(EndpointSchema),
  })
);

export type StoredModel = z.infer<typeof StoredModelSchema>;

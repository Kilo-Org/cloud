import { z } from 'zod/v4';

const FileAnnotationSchema = z
  .object({
    type: z.literal('file'),
    file: z
      .object({
        hash: z.string(),
        name: z.string(),
        content: z
          .array(
            z
              .object({
                type: z.string(),
                text: z.string().optional(),
              })
              .catchall(z.any())
          )
          .optional(),
      })
      .catchall(z.any()),
  })
  .catchall(z.any());

export type FileAnnotation = z.infer<typeof FileAnnotationSchema>;

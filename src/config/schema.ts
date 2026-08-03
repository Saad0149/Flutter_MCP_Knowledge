import { z } from 'zod';

export const ConfigSchema = z.object({
  repositoriesRoot: z
    .string()
    .min(1, 'repositoriesRoot must be a non-empty string')
    .default('./repos'),
  indexPath: z
    .string()
    .min(1, 'indexPath must be a non-empty string')
    .default('./data/knowledge.sqlite'),
  indexOnUpdate: z.boolean().default(true),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

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
  dartSdkPath: z
    .string()
    .min(1, 'dartSdkPath must be a non-empty string')
    .optional()
    .describe('Explicit path to the `dart` executable, checked before any auto-detection'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

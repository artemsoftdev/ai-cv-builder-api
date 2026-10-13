import { z } from 'zod';
import { cvContentSchema, itemIdSchema, lineText } from './cv-content.schema.js';

export const cvParamsSchema = z.object({ id: z.uuid('Invalid CV id') });

export const questionParamsSchema = z.object({
  id: z.uuid('Invalid CV id'),
  questionId: z.uuid('Invalid question id'),
});

export const patchCvBodySchema = z.object({
  version: z.number().int().min(0).max(2_147_483_647),
  title: lineText(120).min(1, 'Title is required').optional(),
  content: cvContentSchema.optional(),
  dismissFlagIds: z.array(itemIdSchema).max(500).optional(),
});

export type PatchCvBody = z.output<typeof patchCvBodySchema>;

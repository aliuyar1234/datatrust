/**
 * Zod schemas for validating connector inputs
 */

import { z } from 'zod';

/** Filter operator enum */
export const filterOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'lt',
  'gte',
  'lte',
  'contains',
  'in',
]);

/** Single filter condition */
export const filterConditionSchema = z.object({
  field: z.string().min(1),
  op: filterOperatorSchema,
  value: z.unknown(),
});

/** Sort order */
export const orderBySchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
});

/** Complete filter options */
export const filterOptionsSchema = z.object({
  where: z.array(filterConditionSchema).optional(),
  select: z.array(z.string()).optional(),
  orderBy: z.array(orderBySchema).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});

/** Field type enum */
export const fieldTypeSchema = z.enum([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'array',
  'object',
]);

/** Field definition (recursive for nested objects) */
export const fieldDefinitionSchema: z.ZodType<{
  name: string;
  type: z.infer<typeof fieldTypeSchema>;
  required: boolean;
  description?: string;
  items?: z.infer<typeof fieldTypeSchema>;
  properties?: unknown[];
  example?: unknown;
}> = z.object({
  name: z.string().min(1),
  type: fieldTypeSchema,
  required: z.boolean(),
  description: z.string().optional(),
  items: fieldTypeSchema.optional(),
  properties: z.lazy(() => z.array(fieldDefinitionSchema)).optional(),
  example: z.unknown().optional(),
});

/** Schema definition */
export const schemaDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(fieldDefinitionSchema),
  primaryKey: z.union([z.string(), z.array(z.string())]).optional(),
  inferred: z.boolean(),
});

/** Write mode */
export const writeModeSchema = z.enum(['insert', 'update', 'upsert']);

/** Export types from schemas */
export type FilterOperatorInput = z.infer<typeof filterOperatorSchema>;
export type FilterConditionInput = z.infer<typeof filterConditionSchema>;
export type FilterOptionsInput = z.infer<typeof filterOptionsSchema>;
export type WriteModeInput = z.infer<typeof writeModeSchema>;

import type { z } from 'zod';
import { validationError, type ValidationIssue } from './errors.js';

/** Bounds the error payload when a large document (e.g. CV content) has many problems. */
const MAX_REPORTED_ISSUES = 50;

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Parses untrusted input or throws a 400 VALIDATION_ERROR with `details.issues`. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(toValidationIssues(result.error));
  return result.data;
}

import { QueryFailedError } from 'typeorm';

const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as { code?: unknown; constraint?: unknown } | undefined;
  return (
    driverError?.code === UNIQUE_VIOLATION &&
    (constraint === undefined || driverError.constraint === constraint)
  );
}

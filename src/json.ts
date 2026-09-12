// Narrow JSON-like values to a plain object. Arrays, null, and primitives
// fail closed instead of being cast.
export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

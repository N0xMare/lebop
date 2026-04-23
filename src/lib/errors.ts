/**
 * Linear's GraphQL surface returns a generic "Entity not found" error for any unknown
 * issue/project/team UUID or identifier. Surfaced verbatim, that's noisy and lacks the
 * one piece of context the caller needs: which id was missing.
 *
 * Use at catch sites; pass through unrelated errors unchanged.
 */
export function rewriteNotFound(err: unknown, identifier: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (/Entity not found/i.test(original.message)) {
    return new Error(`not found: ${identifier}`);
  }
  return original;
}

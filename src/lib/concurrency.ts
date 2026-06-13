export async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const results = new Array<R>(values.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await fn(values[index] as T, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(normalizedLimit, values.length) }, () => worker()),
  );
  return results;
}

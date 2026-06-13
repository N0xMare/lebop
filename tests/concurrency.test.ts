import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/lib/concurrency.ts";

describe("mapLimit", () => {
  it("preserves result order while capping concurrent work", async () => {
    let active = 0;
    let peak = 0;

    const result = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 10;
    });

    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

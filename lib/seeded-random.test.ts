import { describe, expect, test } from "vitest";
import { seededRandom } from "./seeded-random.fixture";

const draws = (seed: number) => {
  const next = seededRandom(seed);
  return Array.from({ length: 50 }, () => next());
};

describe("seededRandom", () => {
  test("the same seed replays the same draws, so a failing trial can be rerun by its seed", () => {
    expect(draws(42)).toEqual(draws(42));
    // A generator stuck on one value would make pick choose the same item every time.
    expect(new Set(draws(42)).size).toBeGreaterThan(1);
    // pick indexes items with floor(draw * length), so a draw outside [0, 1), or NaN, picks no item.
    expect(draws(42).filter((draw) => !(draw >= 0 && draw < 1))).toEqual([]);
  });

  test("different seeds give different draws, so the seed is not ignored", () => {
    expect(draws(1)).not.toEqual(draws(2));
  });
});

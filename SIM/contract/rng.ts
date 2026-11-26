export type Rng = () => number;

/**
 * Один генератор на прогон. Вызывающий передаёт его явно.
 * Глобальный генератор случайных чисел в модели не используется.
 */
export function createRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new Error('Seed должен быть целым числом.');
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

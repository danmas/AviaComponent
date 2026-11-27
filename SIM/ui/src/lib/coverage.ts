/**
 * Единственный перевод покрытия в визуальный вес.
 * Пороги: от 0.9 — плотная тушь, от 0.6 — обычная, от 0.3 — пунктир, ниже — контур.
 * Границы входят в более плотный вес: 0.9 уже полный, 0.6 уже обычный, 0.3 уже пунктир.
 */
export type CoverageWeight = 'full' | 'plain' | 'faded' | 'outline';

export function coverageWeight(coverage: number): CoverageWeight {
  if (coverage >= 0.9) {
    return 'full';
  }
  if (coverage >= 0.6) {
    return 'plain';
  }
  if (coverage >= 0.3) {
    return 'faded';
  }
  return 'outline';
}

/** Подпись доли. Целое — два знака («1.00»), иначе до тысячных без хвостовых нулей. */
export function coverageText(coverage: number): string {
  const rounded = Math.round(coverage * 1000) / 1000;
  if (Number.isInteger(rounded)) {
    return rounded.toFixed(2);
  }
  return String(rounded);
}

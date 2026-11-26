/**
 * Параметры стенда первой версии.
 * Диапазоны взяты из SIM/README_Game_v1.md. Точка внутри диапазона —
 * параметр стенда, не факт документов. После прогона не сдвигать
 * без записи причины в design.md изменения.
 */
export const CONTRACT_STAND = {
  shiftHours: 12,
  shiftsPerDay: 2,
  horizonShiftsMin: 10,
  horizonShiftsMax: 15,
  horizonShifts: 12,
  productCount: 1,
  orderCountMin: 3,
  orderCountMax: 5,
  orderCount: 4,
  batchCountMin: 5,
  batchCountMax: 8,
  batchCount: 6,
  routeLength: 7,
  areaCount: 7,
} as const;

export function assertStandInSpec(): void {
  const stand = CONTRACT_STAND;
  if (stand.shiftHours !== 12 || stand.shiftsPerDay !== 2) {
    throw new Error('Смена стенда — 12 часов, две смены в сутки.');
  }
  if (stand.horizonShifts < stand.horizonShiftsMin || stand.horizonShifts > stand.horizonShiftsMax) {
    throw new Error('Горизонт стенда вышел из диапазона 10–15 смен.');
  }
  if (stand.orderCount < stand.orderCountMin || stand.orderCount > stand.orderCountMax) {
    throw new Error('Число заявок стенда вышло из диапазона 3–5.');
  }
  if (stand.batchCount < stand.batchCountMin || stand.batchCount > stand.batchCountMax) {
    throw new Error('Число партий стенда вышло из диапазона 5–8.');
  }
  if (stand.routeLength !== 7 || stand.areaCount !== 7 || stand.productCount !== 1) {
    throw new Error('Маршрут стенда — один продукт и семь участков.');
  }
}

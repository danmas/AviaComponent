/**
 * Свод: показ среза, падение покрытия, цена из журнала, два экрана одной сессии.
 * Числа смены 4 — замер живого сервера (seed 42, clean, incoming), не пересчёт.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { DecisionResponse, RolesResponse, SessionResponse } from '../../api-client/types.ts';
import { buildApp } from '../../api/server.ts';
import { pathV1 } from '../../api/version.ts';
import { coverageText, coverageWeight } from '../src/lib/coverage.ts';
import { loadDashboard } from '../src/lib/dashboard.ts';
import {
  basisOf,
  counterText,
  DECISION_TYPES,
  decisionPrice,
  decisionsInShift,
  journalViews,
  limitNote,
} from '../src/lib/decisions.ts';
import {
  coverageChange,
  DASHBOARD_BLOCKS,
  metricViews,
  registryRows,
  areaViews,
  unitLabel,
  valueText,
  type MetricId,
  type MetricView,
} from '../src/lib/metrics.ts';
import { pendingOrders } from '../src/lib/orders.ts';
import { screenParams } from '../src/lib/params.ts';
import { followServer, openScreen, tabsOf } from '../src/lib/session.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const MEASURED_CONSEQUENCE = 'партии заказа запускаются в цех с этого момента, заказ входит в покрытие';
const MEASURED_BASIS = '{"openCount":5,"remainderNormHours":7,"ordersWithoutNorm":0}';

function read(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function viewOf(views: readonly MetricView[], id: MetricId): MetricView {
  const found = views.find((row) => row.id === id);
  assert.ok(found);
  return found;
}

async function incomingShift(shift: number): Promise<{
  id: string;
  session: SessionResponse;
  roles: RolesResponse;
  previous: SessionResponse | null;
  close: () => Promise<void>;
}> {
  const app = await buildApp();
  const created = await app.inject({
    method: 'POST',
    url: pathV1('/sessions'),
    payload: { seed: 42, level: 'clean', overlay: 'incoming' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as { id: string }).id;
  for (let step = 0; step < shift; step += 1) {
    const advanced = await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
    assert.equal(advanced.statusCode, 200, advanced.body);
  }
  const current = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=${shift}`) });
  assert.equal(current.statusCode, 200, current.body);
  const roles = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles?shift=${shift}`) });
  assert.equal(roles.statusCode, 200, roles.body);
  let previous: SessionResponse | null = null;
  if (shift > 0) {
    const prior = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=${shift - 1}`) });
    assert.equal(prior.statusCode, 200, prior.body);
    previous = prior.json() as SessionResponse;
  }
  return {
    id,
    session: current.json() as SessionResponse,
    roles: roles.json() as RolesResponse,
    previous,
    close: () => app.close(),
  };
}

test('вес покрытия: границы 0.9, 0.6 и 0.3 входят в более плотный вес', () => {
  assert.equal(coverageWeight(1), 'full');
  assert.equal(coverageWeight(0.9), 'full');
  assert.equal(coverageWeight(0.899), 'plain');
  assert.equal(coverageWeight(0.8), 'plain');
  assert.equal(coverageWeight(0.6), 'plain');
  assert.equal(coverageWeight(0.599), 'faded');
  assert.equal(coverageWeight(0.3), 'faded');
  assert.equal(coverageWeight(0.299), 'outline');
  assert.equal(coverageWeight(0.111), 'outline');
  assert.equal(coverageWeight(0.083), 'outline');
  assert.equal(coverageText(1), '1.00');
  assert.equal(coverageText(0.8), '0.8');
  assert.equal(coverageText(4 / 36), '0.111');
});

test('переключение экрана не меняет сессию и смену', () => {
  const play = { sessionId: 's1', viewShift: 4, serverShift: 4, shiftCount: 12, screen: 'shop' as const };
  const next = openScreen(play, 'dashboard');
  assert.equal(next.sessionId, 's1');
  assert.equal(next.viewShift, 4);
  assert.equal(next.serverShift, 4);
  assert.equal(next.shiftCount, 12);
  assert.equal(next.screen, 'dashboard');
  const tabs = tabsOf('dashboard');
  assert.deepEqual(tabs.map((tab) => tab.label), ['цех', 'свод', 'разбор', 'движение']);
  assert.equal(tabs.length, 4);
  const shop = tabs.find((tab) => tab.id === 'shop');
  const dash = tabs.find((tab) => tab.id === 'dashboard');
  assert.ok(shop);
  assert.ok(dash);
  assert.equal(shop.active, false);
  assert.equal(dash.active, true);
  assert.equal(screenParams('').view, 'shop');
  assert.equal(screenParams('?shift=4&overlay=incoming').view, 'shop');
  assert.equal(screenParams('?view=dashboard').view, 'dashboard');
});

test('сессию создаёт только каркас, цех её не создаёт', () => {
  let count = 0;
  for (const file of walk(SRC)) {
    const matches = fs.readFileSync(file, 'utf8').match(/createSession\(/g);
    count += matches === null ? 0 : matches.length;
  }
  assert.equal(count, 1);
  const shop = read('screens/ShopScreen.tsx');
  assert.equal(shop.includes('createSession'), false);
  assert.equal(shop.includes('очередь:'), true);
  assert.equal(shop.includes('waitingText'), true);
  assert.equal(shop.includes('движение'), true);
  assert.equal(shop.includes('холст'), true);
  assert.equal(shop.includes('RouteFlow'), true);
});

test('значения показателей копируются из среза, без доли и без суммы единиц', () => {
  assert.equal(
    valueText('portfolio', { openCount: 5, remainderNormHours: 7, ordersWithoutNorm: 0 }),
    'открыто 5, остаток 7 н/ч, без нормы 0',
  );
  assert.equal(
    valueText('overload', {
      overloadedCount: 2,
      areas: [{ load: 99 }, { load: 50 }, { load: 1 }],
    }),
    'участков 3, в перегрузке 2',
  );
  assert.equal(
    valueText('acceptedShift', { normHours: 4, masterCloses: 4, workerCloses: 0, duplicateFacts: 9 }),
    '4 н/ч, мастер 4, рабочий 0',
  );
  assert.equal(
    valueText('scheduleRisk', { overdue: 1, onTime: 4, unevaluated: 0 }),
    'просрочено 1, в срок 4, без оценки 0',
  );
  assert.equal(unitLabel('norm-hour'), 'н/ч');
  assert.equal(unitLabel('machine-hour'), 'станко-ч');
  assert.equal(unitLabel('person-hour'), 'чел-ч');
  assert.equal(unitLabel('furnace-hour'), 'печь-ч');
  assert.equal(unitLabel('charge-day'), 'сутки садки');
  assert.equal(unitLabel('custom-kind'), 'custom-kind');
});

test('реестр идёт первым блоком и совпадает с покрытиями показателей', async () => {
  const loaded = await incomingShift(4);
  try {
    const summary = loaded.session.summary;
    const views = metricViews(summary, loaded.previous?.summary ?? null, loaded.roles);
    const registry = registryRows(summary, loaded.previous?.summary ?? null, loaded.roles);
    assert.deepEqual([...DASHBOARD_BLOCKS], ['reliability', 'metrics', 'areas', 'decisions', 'journal']);
    const screen = read('screens/DashboardScreen.tsx');
    assert.ok(screen.indexOf('data-block="reliability"') < screen.indexOf('data-block="metrics"'));
    assert.deepEqual(
      registry.map((row) => row.coverage),
      summary.reliability.map((row) => row.coverage),
    );
    for (const row of registry) {
      const metric = views.find((item) => item.id === row.id);
      assert.ok(metric);
      assert.equal(row.coverage, metric.coverage);
    }
    assert.deepEqual(views.map((row) => row.coverageLabel), [
      'покрытие 0.8',
      'покрытие 1.00',
      'покрытие 0.111',
      'покрытие 1.00',
    ]);
    assert.equal(viewOf(views, 'portfolio').weight, 'plain');
    assert.equal(viewOf(views, 'overload').weight, 'full');
    assert.equal(viewOf(views, 'acceptedShift').weight, 'outline');
    assert.equal(viewOf(views, 'scheduleRisk').weight, 'full');
    assert.equal(viewOf(views, 'overload').quiet, true);
    assert.equal(viewOf(views, 'scheduleRisk').quiet, true);
    assert.equal(viewOf(views, 'portfolio').quiet, false);
    assert.equal(viewOf(views, 'acceptedShift').quiet, false);
    assert.equal(screen.includes('общее'), false);
  } finally {
    await loaded.close();
  }
});

test('смена 4 incoming: значения равны замеру, мощность участка не пересчитывается', async () => {
  const loaded = await incomingShift(4);
  try {
    const metrics = loaded.session.summary.metrics;
    assert.equal(metrics.portfolio.coverage, 0.8);
    assert.equal(metrics.portfolio.value.openCount, 5);
    assert.equal(metrics.portfolio.value.remainderNormHours, 7);
    assert.equal(metrics.portfolio.value.ordersWithoutNorm, 0);
    assert.equal(metrics.overload.coverage, 1);
    assert.equal(metrics.overload.value.areas.length, 6);
    assert.equal(Math.round(metrics.acceptedShift.coverage * 1000) / 1000, 0.111);
    assert.equal(metrics.acceptedShift.value.normHours, 4);
    assert.equal(metrics.acceptedShift.value.masterCloses, 4);
    assert.equal(metrics.acceptedShift.value.workerCloses, 0);
    assert.equal(metrics.scheduleRisk.coverage, 1);
    assert.equal(metrics.scheduleRisk.value.overdue, 1);
    assert.equal(metrics.scheduleRisk.value.onTime, 4);
    assert.equal(metrics.scheduleRisk.value.unevaluated, 0);

    const views = metricViews(loaded.session.summary, loaded.previous?.summary ?? null, loaded.roles);
    assert.equal(viewOf(views, 'portfolio').valueText, 'открыто 5, остаток 7 н/ч, без нормы 0');
    assert.equal(
      viewOf(views, 'overload').valueText,
      `участков ${metrics.overload.value.areas.length}, в перегрузке ${metrics.overload.value.overloadedCount}`,
    );
    assert.equal(viewOf(views, 'acceptedShift').valueText, '4 н/ч, мастер 4, рабочий 0');
    assert.equal(viewOf(views, 'acceptedShift').valueText.includes('из 36'), false);
    assert.equal(viewOf(views, 'scheduleRisk').valueText, 'просрочено 1, в срок 4, без оценки 0');
    assert.deepEqual(viewOf(views, 'portfolio').reads, metrics.portfolio.reads);

    const areas = areaViews(loaded.session.summary);
    assert.equal(areas.length, loaded.session.summary.areas.length);
    for (let index = 0; index < areas.length; index += 1) {
      const shown = areas[index];
      const source = loaded.session.summary.areas[index];
      assert.ok(shown);
      assert.ok(source);
      assert.equal(shown.capacityAmount, source.capacity.amount);
      assert.equal(shown.planAmount, source.plan.amount);
      assert.equal(shown.queueAmount, source.queue.amount);
      assert.equal(shown.capacityText.includes('/'), false);
      assert.equal(shown.planText.includes('%'), false);
    }
  } finally {
    await loaded.close();
  }
});

test('падение 1 → 0.8 называет неразобранный заказ, два заказа названы оба', async () => {
  const loaded = await incomingShift(4);
  try {
    const previous = loaded.previous;
    assert.ok(previous);
    assert.equal(previous.summary.metrics.portfolio.coverage, 1);
    const views = metricViews(loaded.session.summary, previous.summary, loaded.roles);
    const drop = viewOf(views, 'portfolio').change;
    assert.equal(drop, 'Покрытие 0.8 (было 1.00, −0.2: неразобранный заказ order-5)');
    const registry = registryRows(loaded.session.summary, previous.summary, loaded.roles);
    const portfolioRow = registry.find((row) => row.id === 'portfolio');
    assert.ok(portfolioRow);
    assert.equal(portfolioRow.change, drop);
    assert.deepEqual(pendingOrders(loaded.roles).map((order) => order.id), ['order-5']);

    const rolesTwo: RolesResponse = {
      ...loaded.roles,
      records: [
        ...loaded.roles.records,
        {
          role: 'pdo',
          kind: 'order',
          ref: 'order-9',
          at: 2880,
          status: 'unparsed',
          contractDue: 9000,
          operationId: null,
          technology: null,
          production: null,
          control: null,
        },
      ],
    };
    const both = viewOf(metricViews(loaded.session.summary, previous.summary, rolesTwo), 'portfolio').change;
    assert.equal(both, 'Покрытие 0.8 (было 1.00, −0.2: неразобранные заказы order-5, order-9)');

    for (const row of views) {
      if (row.id === 'portfolio' || row.change === null) {
        continue;
      }
      assert.match(row.change, /покрытие снизилось/);
      assert.equal(row.change.includes('order-5'), false);
    }
  } finally {
    await loaded.close();
  }
});

test('причина падения не выдумывается, первый срез без пометки', () => {
  const unknown = coverageChange({
    metricId: 'acceptedShift',
    previous: 1,
    current: 4 / 36,
    unparsedIds: ['order-5'],
  });
  assert.ok(unknown);
  assert.match(unknown, /покрытие снизилось/);
  assert.match(unknown, /−0\.889/);
  assert.equal(unknown.includes('order-5'), false);
  assert.equal(coverageChange({
    metricId: 'portfolio',
    previous: null,
    current: 0.8,
    unparsedIds: ['order-5'],
  }), null);
  assert.equal(coverageChange({
    metricId: 'portfolio',
    previous: 0.8,
    current: 1,
    unparsedIds: ['order-5'],
  }), null);
});

test('три типа решений, цена копируется, пустое последствие не выдумывается', () => {
  assert.deepEqual([...DECISION_TYPES], ['priority', 'accept-order', 'defer-order']);
  assert.equal(basisOf('priority'), 'scheduleRisk');
  assert.equal(basisOf('accept-order'), 'portfolio');
  assert.equal(basisOf('defer-order'), 'portfolio');
  const source = read('lib/decisions.ts');
  assert.equal(source.includes('запускаются'), false);
  assert.equal(source.includes('не растёт'), false);

  const echoed = decisionPrice({
    basisMetric: 'portfolio',
    basisValue: MEASURED_BASIS,
    coverage: 0.8,
    consequence: MEASURED_CONSEQUENCE,
  });
  assert.equal(echoed.basisMetric, 'portfolio');
  assert.equal(echoed.basisValue, MEASURED_BASIS);
  assert.equal(echoed.coverage, 0.8);
  assert.equal(echoed.consequence, MEASURED_CONSEQUENCE);
  assert.equal(echoed.valueText, 'открыто 5, остаток 7 н/ч, без нормы 0');

  const missing = decisionPrice({ basisMetric: 'portfolio', basisValue: MEASURED_BASIS, coverage: 0.8 });
  assert.equal(missing.consequence, 'последствие: см. журнал');
  assert.equal(missing.consequence.includes('запускаются'), false);
  assert.equal(
    decisionPrice({ basisMetric: 'portfolio', basisValue: MEASURED_BASIS, coverage: 0.8, consequence: '' }).consequence,
    'последствие: см. журнал',
  );
  assert.equal(
    decisionPrice({ basisMetric: 'portfolio', basisValue: MEASURED_BASIS, coverage: 0.8, consequence: '   ' }).consequence,
    'последствие: см. журнал',
  );
  assert.equal(
    decisionPrice({ basisMetric: 'portfolio', basisValue: MEASURED_BASIS, coverage: 0.8, consequence: null }).consequence,
    'последствие: см. журнал',
  );
});

test('после подтверждения показанное последствие совпадает с ответом сервера', async () => {
  const loaded = await incomingShift(4);
  try {
    const quote = decisionPrice({
      basisMetric: basisOf('accept-order'),
      basisValue: JSON.stringify(loaded.session.summary.metrics.portfolio.value),
      coverage: loaded.session.summary.metrics.portfolio.coverage,
    });
    assert.equal(quote.basisMetric, 'portfolio');
    assert.equal(quote.coverage, 0.8);
    assert.equal(quote.consequence, 'последствие: см. журнал');

    const app = await buildApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: pathV1('/sessions'),
        payload: { seed: 42, level: 'clean', overlay: 'incoming' },
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = (created.json() as { id: string }).id;
      for (let step = 0; step < 4; step += 1) {
        const advanced = await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
        assert.equal(advanced.statusCode, 200, advanced.body);
      }
      const accepted = await app.inject({
        method: 'POST',
        url: pathV1(`/sessions/${id}/decisions`),
        payload: { type: 'accept-order', orderId: 'order-5' },
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const body = accepted.json() as DecisionResponse;
      const shown = decisionPrice(body.journal);
      assert.equal(shown.consequence, body.journal.consequence);
      assert.equal(shown.basisMetric, body.journal.basisMetric);
      assert.equal(shown.basisValue, body.journal.basisValue);
      assert.equal(shown.coverage, body.journal.coverage);
      assert.equal(body.journal.basisMetric, 'portfolio');
      assert.equal(body.journal.coverage, 0.8);
      assert.equal(body.journal.basisValue, MEASURED_BASIS);
      assert.equal(body.journal.consequence, MEASURED_CONSEQUENCE);
      assert.equal(body.journal.at, 4 * 720);
      assert.equal(decisionsInShift([body.journal], 4).length, 1);
      assert.equal(decisionsInShift([body.journal], 5).length, 0);

      const [entry] = journalViews([body.journal]);
      assert.ok(entry);
      assert.deepEqual(Object.keys(entry).sort(), ['action', 'at', 'basis', 'consequence', 'coverage']);
      assert.equal(entry.at, body.journal.at);
      assert.equal(entry.action, body.journal.action);
      assert.equal(entry.coverage, body.journal.coverage);
      assert.equal(entry.consequence, body.journal.consequence);
      assert.match(entry.basis, /портфель/);
      assert.match(entry.basis, /открыто 5/);
    } finally {
      await app.close();
    }
  } finally {
    await loaded.close();
  }
});

test('счётчик берётся из журнала: три решения блокируют четвёртое, новая смена с нуля', () => {
  const shiftFour = [{ at: 2880 }, { at: 3000 }, { at: 3599 }];
  assert.equal(decisionsInShift(shiftFour, 4).length, 3);
  assert.equal(counterText(2), 'решено 2 из 3');
  assert.equal(counterText(decisionsInShift(shiftFour, 4).length), 'решено 3 из 3');
  const note = limitNote(3);
  assert.ok(note);
  assert.match(note, /Четвёртое действие недоступно/);
  assert.equal(limitNote(2), null);
  const moved = followServer(
    { sessionId: 's1', viewShift: 4, serverShift: 4, shiftCount: 12, screen: 'dashboard' },
    5,
  );
  assert.equal(moved.sessionId, 's1');
  assert.equal(moved.viewShift, 5);
  assert.equal(moved.serverShift, 5);
  assert.equal(counterText(decisionsInShift(shiftFour, moved.viewShift).length), 'решено 0 из 3');
  assert.equal(decisionsInShift([...shiftFour, { at: 3600 }], 5).length, 1);
});

test('журнал показывает пять полей и не оценивает решение', () => {
  const [entry] = journalViews([{
    at: 2880,
    action: 'принять заказ order-5',
    basisMetric: 'scheduleRisk',
    basisValue: '{"overdue":1,"onTime":4,"unevaluated":0}',
    coverage: 1,
    consequence: 'ранг действует с начала этой смены; уже выданный срез не пересчитывается',
  }]);
  assert.ok(entry);
  assert.equal(entry.at, 2880);
  assert.equal(entry.action, 'принять заказ order-5');
  assert.equal(entry.basis, 'риск сроков — просрочено 1, в срок 4, без оценки 0');
  assert.equal(entry.coverage, 1);
  assert.equal(entry.consequence, 'ранг действует с начала этой смены; уже выданный срез не пересчитывается');
  assert.equal('score' in entry, false);

  const screen = read('screens/DashboardScreen.tsx');
  const journal = screen.slice(screen.indexOf('data-block="journal"'));
  for (const word of ['балл', 'рейтинг', 'хорошо', 'плохо', 'успех']) {
    assert.equal(journal.includes(word), false, word);
  }
  assert.equal(/\b(good|bad|score|rating)\b/.test(journal), false);
});

test('свод читает сессию и роли и не запрашивает цех', async () => {
  const loaded = await incomingShift(4);
  try {
    const calls: string[] = [];
    const result = await loadDashboard({
      session(_id, shift) {
        calls.push(`session:${shift ?? 'none'}`);
        return Promise.resolve(shift === 3 ? loaded.previous ?? loaded.session : loaded.session);
      },
      roles() {
        calls.push('roles');
        return Promise.resolve(loaded.roles);
      },
    }, loaded.session.id, 4);
    assert.deepEqual([...calls].sort(), ['roles', 'session:3', 'session:4']);
    assert.equal(calls.some((call) => call.includes('shop')), false);
    assert.equal(result.current.summary.metrics.portfolio.coverage, 0.8);
    assert.deepEqual(pendingOrders(result.roles).map((order) => order.id), ['order-5']);

    const opened = calls.slice();
    const atStart: string[] = [];
    await loadDashboard({
      session() {
        atStart.push('session');
        return Promise.resolve(loaded.session);
      },
      roles() {
        atStart.push('roles');
        return Promise.resolve(loaded.roles);
      },
    }, loaded.session.id, 0);
    assert.deepEqual(atStart, ['session', 'roles']);
    assert.equal(opened.includes('shop'), false);

    const screen = read('screens/DashboardScreen.tsx');
    const loader = read('lib/dashboard.ts');
    assert.equal(screen.includes('/shop'), false);
    assert.equal(screen.includes('.shop('), false);
    assert.equal(loader.includes('/shop'), false);
    assert.equal(loader.includes('.shop('), false);
  } finally {
    await loaded.close();
  }
});

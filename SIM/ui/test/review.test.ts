/**
 * Разбор: три вердикта по фактам, срок против закрытия склада, цех только своей смены.
 * Числа order-5 читаются из среза (seed 42, clean, incoming), а не зашиты в правило.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RolesResponse, SessionResponse, ShopResponse } from '../../api-client/types.ts';
import { buildApp } from '../../api/server.ts';
import { pathV1 } from '../../api/version.ts';
import { screenParams } from '../src/lib/params.ts';
import {
  decisionShift,
  dueLines,
  issuedMetrics,
  loadReview,
  recordsOf,
  reviewDecisions,
  shopOf,
  type DecisionReview,
  type IssuedMetric,
  type JournalEntry,
  type ReviewRecord,
  type ReviewShop,
  type VerdictText,
} from '../src/lib/review.ts';
import { openScreen, tabsOf } from '../src/lib/session.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BANNED = ['провал', 'ошибка', 'неправильно', 'упрёк', 'по вине', 'плохо', 'хорошо', 'балл', 'рейтинг', 'успех', 'похвала', 'молодец'];

function read(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

function assertPlain(text: string): void {
  for (const word of BANNED) {
    assert.equal(text.includes(word), false, `${word} в «${text}»`);
  }
}

function entry(overrides: Partial<JournalEntry> & Pick<JournalEntry, 'action'>): JournalEntry {
  return {
    at: 3600,
    basisMetric: 'portfolio',
    basisValue: '{"openCount":5,"remainderNormHours":7,"ordersWithoutNorm":0}',
    coverage: 0.8,
    consequence: 'партии заказа запускаются в цех с этого момента, заказ входит в покрытие',
    ...overrides,
  };
}

function shopWith(shift: number, operations: ReviewShop['operations']): ReviewShop {
  return { shift, warehouseAreaIds: ['area-fg'], operations };
}

function linked(orderId: string, operationId: string): ReviewRecord {
  return { kind: 'norm', ref: `${orderId}:${operationId}`, orderId, operationId };
}

const OP = { id: 'batch-7-op-0', batchId: 'batch-7', areaId: 'area-turn', status: 'ready', readyAt: 4000 };
const PORTFOLIO_GROWN: IssuedMetric = {
  id: 'portfolio',
  coverage: 1,
  value: { openCount: 4, remainderNormHours: 3, ordersWithoutNorm: 0 },
};
const PORTFOLIO_SAME: IssuedMetric = {
  id: 'portfolio',
  coverage: 0.8,
  value: { openCount: 5, remainderNormHours: 7, ordersWithoutNorm: 0 },
};

function verdictsByAction(rows: readonly DecisionReview[]): Map<string, VerdictText> {
  return new Map(rows.map((row) => [row.action, row.verdict]));
}

test('закладка «разбор» не сбрасывает сессию и смену', () => {
  const play = { sessionId: 's1', viewShift: 4, serverShift: 4, shiftCount: 12, screen: 'dashboard' as const };
  const next = openScreen(play, 'review');
  assert.equal(next.sessionId, play.sessionId);
  assert.equal(next.viewShift, play.viewShift);
  assert.equal(next.serverShift, play.serverShift);
  assert.equal(next.shiftCount, play.shiftCount);
  assert.equal(next.screen, 'review');
  const tabs = tabsOf('review');
  assert.deepEqual(tabs.map((tab) => tab.label), ['цех', 'свод', 'разбор']);
  assert.equal(tabs.length, 3);
  const review = tabs.find((tab) => tab.id === 'review');
  const shop = tabs.find((tab) => tab.id === 'shop');
  assert.ok(review);
  assert.ok(shop);
  assert.equal(review.active, true);
  assert.equal(shop.active, false);
  assert.equal(screenParams('?view=review&shift=4').view, 'review');
  assert.equal(screenParams('?view=review&shift=4').shift, 4);
  assert.equal(screenParams('').view, 'shop');
});

test('приём с партиями и выросшим покрытием — подтвердилось', () => {
  const row = entry({ action: 'принять заказ order-5' });
  const [line] = reviewDecisions({
    journal: [row],
    shop: shopWith(5, [OP]),
    roles: [linked('order-5', OP.id)],
    metrics: [PORTFOLIO_GROWN],
  });
  assert.ok(line);
  assert.equal(line.verdict, 'подтвердилось');
  assert.match(line.fact, /совпадает с записью/);
  assertPlain(line.fact);
  assert.equal('score' in line, false);
  assert.equal('successes' in line, false);
});

test('отложенный заказ с операциями в цехе — разошлось', () => {
  const [line] = reviewDecisions({
    journal: [entry({
      action: 'отложить заказ order-5',
      consequence: 'заказ остаётся неразобранным, партии не запускаются, покрытие не растёт',
    })],
    shop: shopWith(5, [OP]),
    roles: [linked('order-5', OP.id)],
    metrics: [PORTFOLIO_SAME],
  });
  assert.ok(line);
  assert.equal(line.verdict, 'разошлось');
  assert.match(line.fact, /в цехе операции заказа есть/);
  assert.equal(line.fact.includes('провал'), false);
  assert.equal(line.fact.includes('ошибка'), false);
  assert.equal(line.fact.includes('неправильно'), false);
  assertPlain(line.fact);
});

test('нет закрытия или нет срока — невозможно проверить, а не разошлось', () => {
  const noDue = dueLines(
    [{ kind: 'order', ref: 'order-3', contractDue: null }],
    shopWith(2, []),
  );
  assert.equal(noDue.length, 1);
  assert.equal(noDue[0]?.verdict, 'невозможно проверить');
  assert.equal(noDue[0]?.dueLabel, 'срок не задан');
  assert.equal(noDue[0]?.gap, null);
  assert.notEqual(noDue[0]?.verdict, 'разошлось');

  const open = dueLines(
    [
      { kind: 'order', ref: 'order-5', contractDue: 4320 },
      linked('order-5', 'batch-7-op-6'),
    ],
    shopWith(4, [{ id: 'batch-7-op-6', batchId: 'batch-7', areaId: 'area-fg', status: 'not-ready', readyAt: null }]),
  );
  assert.equal(open[0]?.verdict, 'невозможно проверить');
  assert.equal(open[0]?.closeLabel, 'не закрыт');
  assert.equal(open[0]?.gap, null);
  assert.equal(open[0]?.gapLabel, '—');
  assert.notEqual(open[0]?.verdict, 'разошлось');

  const [blind] = reviewDecisions({
    journal: [entry({ action: 'принять заказ order-9' })],
    shop: shopWith(5, [OP]),
    roles: [],
    metrics: [PORTFOLIO_GROWN],
  });
  assert.ok(blind);
  assert.equal(blind.verdict, 'невозможно проверить');
  assert.notEqual(blind.verdict, 'разошлось');
});

test('приоритет сверяется по совпадению выданного среза, а не по выгоде ранга', () => {
  const basisValue = '{"onTime":4,"overdue":1,"unevaluated":0}';
  const row = entry({
    action: 'приоритет партии batch-7: ранг 0',
    basisMetric: 'scheduleRisk',
    basisValue,
    coverage: 1,
    consequence: 'ранг действует с начала этой смены; уже выданный срез не пересчитывается',
  });
  const metric: IssuedMetric = {
    id: 'scheduleRisk',
    coverage: 1,
    value: { overdue: 1, onTime: 4, unevaluated: 0 },
  };
  const [same] = reviewDecisions({
    journal: [row],
    shop: shopWith(5, []),
    roles: [],
    metrics: [metric],
  });
  assert.ok(same);
  assert.equal(same.verdict, 'подтвердилось');
  assert.match(same.fact, /выданный срез совпадает с записью/);
  assert.equal(same.fact.includes('без ранга'), false);
  assert.equal(same.fact.includes('стартовала'), false);

  const [moved] = reviewDecisions({
    journal: [row],
    shop: shopWith(5, []),
    roles: [],
    metrics: [{ ...metric, value: { overdue: 0, onTime: 5, unevaluated: 0 } }],
  });
  assert.ok(moved);
  assert.equal(moved.verdict, 'разошлось');
  assert.match(moved.fact, /на выданном срезе/);
  assertPlain(moved.fact);
});

test('обратный порядок журнала даёт те же вердикты', () => {
  const accept = entry({ action: 'принять заказ order-5' });
  const defer = entry({
    action: 'отложить заказ order-1',
    consequence: 'заказ остаётся неразобранным, партии не запускаются, покрытие не растёт',
  });
  const input = {
    shop: shopWith(5, [OP]),
    roles: [linked('order-5', OP.id), linked('order-1', 'batch-1-op-0')],
    metrics: [PORTFOLIO_GROWN],
  };
  const forward = reviewDecisions({ journal: [accept, defer], ...input });
  const backward = reviewDecisions({ journal: [defer, accept], ...input });
  assert.deepEqual(verdictsByAction(forward), verdictsByAction(backward));
  assert.equal(verdictsByAction(forward).get('принять заказ order-5'), 'подтвердилось');
  assert.equal(verdictsByAction(forward).get('отложить заказ order-1'), 'разошлось');
});

test('строка разбора показывает действие, основание, покрытие и факт', () => {
  const row = entry({ action: 'принять заказ order-5' });
  const [line] = reviewDecisions({
    journal: [row],
    shop: shopWith(5, [OP]),
    roles: [linked('order-5', OP.id)],
    metrics: [PORTFOLIO_GROWN],
  });
  assert.ok(line);
  assert.equal(line.action, row.action);
  assert.equal(line.basisValue, row.basisValue);
  assert.match(line.basisText, /открыто 5/);
  assert.equal(line.coverage, row.coverage);
  assert.match(line.coverageLabel, /0\.8/);
  assert.ok(line.fact.length > 0);
  const screen = read('screens/ReviewScreen.tsx');
  assert.equal(screen.includes('>Запись<'), true);
  assert.equal(screen.includes('>Основание<'), true);
  assert.equal(screen.includes('>Покрытие<'), true);
  assert.equal(screen.includes('>Факт<'), true);
});

test('решение на минуте 3600 сверяется со срезом смены 5', () => {
  assert.equal(decisionShift(3600), 5);
  const row = entry({ at: 3600, action: 'принять заказ order-5' });
  const roles = [linked('order-5', OP.id)];
  const wrong = reviewDecisions({
    journal: [row],
    shop: shopWith(4, [OP]),
    roles,
    metrics: [PORTFOLIO_GROWN],
  });
  assert.equal(wrong[0]?.verdict, 'невозможно проверить');
  assert.match(wrong[0]?.fact ?? '', /смене 5/);
  assert.match(wrong[0]?.fact ?? '', /смена 4/);
  const right = reviewDecisions({
    journal: [row],
    shop: shopWith(5, [OP]),
    roles,
    metrics: [PORTFOLIO_GROWN],
  });
  assert.equal(right[0]?.verdict, 'подтвердилось');
});

test('основание берётся из журнала и не пересчитывается', () => {
  const row = entry({ action: 'принять заказ order-5' });
  const [line] = reviewDecisions({
    journal: [row],
    shop: shopWith(5, [OP]),
    roles: [linked('order-5', OP.id)],
    metrics: [{
      id: 'portfolio',
      coverage: 1,
      value: { openCount: 1, remainderNormHours: 0, ordersWithoutNorm: 0 },
    }],
  });
  assert.ok(line);
  assert.equal(line.basisMetric, row.basisMetric);
  assert.equal(line.basisValue, row.basisValue);
  assert.match(line.basisText, /открыто 5/);
  assert.equal(line.basisText.includes('открыто 1'), false);
  assert.equal(line.coverage, 0.8);
});

test('срок не задан не подменяется нулём, незакрытый заказ — не расхождение', () => {
  const lines = dueLines(
    [
      { kind: 'order', ref: 'order-3' },
      { kind: 'order', ref: 'order-5', contractDue: 4320 },
      linked('order-5', 'batch-7-op-6'),
    ],
    shopWith(4, [{ id: 'batch-7-op-6', batchId: 'batch-7', areaId: 'area-fg', status: 'not-ready', readyAt: null }]),
  );
  const missing = lines.find((row) => row.orderId === 'order-3');
  const open = lines.find((row) => row.orderId === 'order-5');
  assert.ok(missing);
  assert.ok(open);
  assert.equal(missing.due, null);
  assert.equal(missing.dueLabel, 'срок не задан');
  assert.equal(missing.gap, null);
  assert.equal(missing.dueLabel.includes('0'), false);
  assert.equal(open.closeLabel, 'не закрыт');
  assert.equal(open.gap, null);
  assert.equal(open.gapLabel.includes('0'), false);
  assert.equal(open.verdict, 'невозможно проверить');
});

async function posted(payload: { seed?: number; level?: string; overlay?: string }, steps: number): Promise<{
  id: string;
  app: Awaited<ReturnType<typeof buildApp>>;
}> {
  const app = await buildApp();
  const created = await app.inject({
    method: 'POST',
    url: pathV1('/sessions'),
    payload: { seed: 42, level: 'clean', overlay: 'incoming', ...payload },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as { id: string }).id;
  for (let step = 0; step < steps; step += 1) {
    const advanced = await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
    assert.equal(advanced.statusCode, 200, advanced.body);
  }
  return { id, app };
}

test('открытие разбора не двигает смену и не добавляет решений', async () => {
  const { id, app } = await posted({}, 4);
  try {
    const before = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=4`) });
    assert.equal(before.statusCode, 200, before.body);
    const prior = before.json() as SessionResponse;
    await loadReview({
      async session(_sessionId, shift) {
        const response = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=${shift ?? ''}`) });
        assert.equal(response.statusCode, 200, response.body);
        return response.json() as SessionResponse;
      },
      async roles(_sessionId, shift) {
        const response = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles?shift=${shift ?? ''}`) });
        assert.equal(response.statusCode, 200, response.body);
        return response.json() as RolesResponse;
      },
      async shop(_sessionId, shift) {
        const response = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=${shift ?? ''}`) });
        assert.equal(response.statusCode, 200, response.body);
        return response.json() as ShopResponse;
      },
    }, id, 4);
    const after = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=4`) });
    assert.equal(after.statusCode, 200, after.body);
    const next = after.json() as SessionResponse;
    assert.equal(next.currentShift, prior.currentShift);
    assert.deepEqual(next.decisionJournal, prior.decisionJournal);
    assert.deepEqual(next.decisions, prior.decisions);
    const screen = read('screens/ReviewScreen.tsx');
    assert.equal(screen.includes('.decide('), false);
    assert.equal(screen.includes('createSession'), false);
  } finally {
    await app.close();
  }
});

test('разбор смены 5 запрашивает только срез цеха смены 5', async () => {
  const calls: string[] = [];
  await loadReview({
    session(_id, shift) {
      calls.push(`session:${shift ?? 'none'}`);
      return Promise.resolve({ decisionJournal: [] } as unknown as SessionResponse);
    },
    roles(_id, shift) {
      calls.push(`roles:${shift ?? 'none'}`);
      return Promise.resolve({ records: [] } as unknown as RolesResponse);
    },
    shop(_id, shift) {
      calls.push(`shop:${shift ?? 'none'}`);
      return Promise.resolve({} as ShopResponse);
    },
  }, 's1', 5);
  assert.deepEqual(calls.filter((call) => call.startsWith('shop')), ['shop:5']);
  for (const other of [1, 2, 3, 4, 6]) {
    assert.equal(calls.includes(`shop:${other}`), false);
  }
  const loader = read('lib/review.ts');
  assert.equal(loader.match(/\.shop\(/g)?.length, 1);
  assert.equal(loader.includes('.trace('), false);
  assert.equal(loader.includes('/trace'), false);
  assert.equal(read('screens/ReviewScreen.tsx').includes('.shop('), false);
  assert.equal(read('screens/ReviewScreen.tsx').includes('.trace('), false);
  assert.equal(read('lib/dashboard.ts').includes('.shop('), false);
  assert.equal(read('screens/DashboardScreen.tsx').includes('.shop('), false);
});

test('на экране цех помечен как факт, запись и факт различимы', () => {
  const screen = read('screens/ReviewScreen.tsx');
  assert.match(screen, /Это факт\./);
  assert.match(screen, /data-fact="true"/);
  assert.match(screen, /Запись\./);
  assert.match(screen, /data-record="true"/);
  assert.equal(screen.includes('data-fact="true"'), true);
  assert.equal(screen.includes('data-record="true"'), true);
});

test('в разборе нет баллов, рейтинга, процентов успеха и счёта подтверждений', () => {
  const screen = read('screens/ReviewScreen.tsx');
  const review = read('lib/review.ts');
  const classes = [...screen.matchAll(/className="([^"]+)"/g)].map((match) => match[1] ?? '');
  for (const name of classes) {
    assert.equal(/score|rating|success|good|bad|green|red|praise|fail/i.test(name), false, name);
  }
  assert.equal(classes.filter((name) => name === 'verdict').length > 0, true);
  assert.equal(screen.includes('successes'), false);
  assert.equal(screen.includes('подтверждений'), false);
  assert.equal(review.includes('successes'), false);
  assert.equal(review.includes('6420'), false);
  assert.equal(review.includes('2100'), false);
  assert.equal(review.includes('4320'), false);
});

test('order-5: срок 4320, факт 6420, расхождение 2100 читаются из среза', async () => {
  const { id, app } = await posted({}, 4);
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: pathV1(`/sessions/${id}/decisions`),
      payload: { type: 'accept-order', orderId: 'order-5' },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    for (let step = 0; step < 4; step += 1) {
      const advanced = await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
      assert.equal(advanced.statusCode, 200, advanced.body);
    }
    const roles = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles?shift=8`) });
    const shop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=8`) });
    assert.equal(roles.statusCode, 200, roles.body);
    assert.equal(shop.statusCode, 200, shop.body);
    const shopBody = shop.json() as ShopResponse;
    const viewed = shopOf(shopBody);
    const warehouse = shopBody.reality.operations.find((op) => (
      op.batchId === 'batch-7' && viewed.warehouseAreaIds.includes(op.areaId) && op.status === 'done'
    ));
    assert.ok(warehouse);
    assert.equal(typeof warehouse.readyAt, 'number');
    const line = dueLines(recordsOf(roles.json() as RolesResponse), viewed).find((row) => row.orderId === 'order-5');
    assert.ok(line);
    assert.equal(line.due, 4320);
    assert.equal(line.closedAt, warehouse.readyAt);
    assert.equal(line.closedAt, 6420);
    assert.equal(line.gap, line.closedAt - line.due);
    assert.equal(line.gap, 2100);
    assert.match(line.gapLabel, /2100/);
    assert.match(line.gapLabel, /опоздал/);
    assert.equal(line.verdict, 'разошлось');
    assertPlain(line.gapLabel);
  } finally {
    await app.close();
  }
});

test('принятый order-5 на смене 4 подтвердился, склад ещё не закрыт', async () => {
  const { id, app } = await posted({}, 4);
  try {
    const accepted = await app.inject({
      method: 'POST',
      url: pathV1(`/sessions/${id}/decisions`),
      payload: { type: 'accept-order', orderId: 'order-5' },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const session = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=4`) });
    const roles = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles?shift=4`) });
    const shop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=4`) });
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(roles.statusCode, 200, roles.body);
    assert.equal(shop.statusCode, 200, shop.body);
    const sessionBody = session.json() as SessionResponse;
    const rolesBody = roles.json() as RolesResponse;
    const shopBody = shopOf(shop.json() as ShopResponse);
    const [line] = reviewDecisions({
      journal: sessionBody.decisionJournal,
      shop: shopBody,
      roles: recordsOf(rolesBody),
      metrics: issuedMetrics(sessionBody.summary),
    });
    assert.ok(line);
    assert.equal(line.verdict, 'подтвердилось');
    assert.equal(line.basisValue, sessionBody.decisionJournal[0]?.basisValue);
    assertPlain(line.fact);
    const due = dueLines(recordsOf(rolesBody), shopBody).find((row) => row.orderId === 'order-5');
    assert.ok(due);
    assert.equal(due.due, 4320);
    assert.equal(due.closedAt, null);
    assert.equal(due.closeLabel, 'не закрыт');
    assert.equal(due.verdict, 'невозможно проверить');
  } finally {
    await app.close();
  }
});

test('прошлый срез после приоритета совпадает с исходным', async () => {
  const { id, app } = await posted({}, 4);
  try {
    const before = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=3`) });
    const beforeShop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=3`) });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(beforeShop.statusCode, 200, beforeShop.body);
    const decided = await app.inject({
      method: 'POST',
      url: pathV1(`/sessions/${id}/decisions`),
      payload: { type: 'priority', batchId: 'batch-7', rank: 0 },
    });
    assert.equal(decided.statusCode, 200, decided.body);
    const after = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=3`) });
    const afterShop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=3`) });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(afterShop.statusCode, 200, afterShop.body);
    assert.deepEqual((after.json() as SessionResponse).summary, (before.json() as SessionResponse).summary);
    assert.deepEqual(afterShop.json(), beforeShop.json());

    const current = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}?shift=4`) });
    const roles = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles?shift=4`) });
    const shop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=4`) });
    assert.equal(current.statusCode, 200, current.body);
    const sessionBody = current.json() as SessionResponse;
    const [line] = reviewDecisions({
      journal: sessionBody.decisionJournal,
      shop: shopOf(shop.json() as ShopResponse),
      roles: recordsOf(roles.json() as RolesResponse),
      metrics: issuedMetrics(sessionBody.summary),
    });
    assert.ok(line);
    assert.equal(line.action, sessionBody.decisionJournal[0]?.action);
    assert.equal(line.basisValue, sessionBody.decisionJournal[0]?.basisValue);
    assert.equal(line.verdict, 'подтвердилось');
    assertPlain(line.fact);
  } finally {
    await app.close();
  }
});

test('пустой срок на стенде пишется как «срок не задан»', async () => {
  const { id, app } = await posted({ level: 'empty', overlay: 'none' }, 0);
  try {
    const roles = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles?shift=0`) });
    const shop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=0`) });
    assert.equal(roles.statusCode, 200, roles.body);
    assert.equal(shop.statusCode, 200, shop.body);
    const line = dueLines(recordsOf(roles.json() as RolesResponse), shopOf(shop.json() as ShopResponse))
      .find((row) => row.orderId === 'order-3');
    assert.ok(line);
    assert.equal(line.due, null);
    assert.equal(line.dueLabel, 'срок не задан');
    assert.equal(line.gap, null);
    assert.equal(line.verdict, 'невозможно проверить');
  } finally {
    await app.close();
  }
});

test('раздел разбора в README описывает три вердикта, правило и пометку факта', () => {
  const readme = fs.readFileSync(path.resolve(SRC, '../README_UI.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Экран разбора'), readme.indexOf('## Что показывает'));
  assert.ok(section.startsWith('## Экран разбора'));
  const folded = section.toLowerCase();
  assert.match(folded, /подтвердилось/);
  assert.match(folded, /разошлось/);
  assert.match(folded, /невозможно проверить/);
  assert.match(section, /неизменности выданного среза/);
  assert.match(section, /Это факт/);
});

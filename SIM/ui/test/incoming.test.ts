import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../../api/server.ts';
import { pathV1 } from '../../api/version.ts';
import { pendingOrders } from '../src/lib/orders.ts';
import { arrivalText } from '../src/lib/shop.ts';

test('стартовая партия не помечается, новая помечается минутой появления', () => {
  assert.equal(arrivalText({ appearedAt: 0 }), '');
  assert.equal(arrivalText({ appearedAt: 2880 }), 'новая · 2880 мин');
});

test('в список неразобранных попадает только заказ со статусом unparsed', () => {
  const rows = pendingOrders({
    records: [
      { kind: 'order', ref: 'order-5', status: 'unparsed', contractDue: 4320 },
      { kind: 'order', ref: 'order-1', status: 'in-production', contractDue: 8640 },
      { kind: 'norm', ref: 'norm-1' },
    ],
  });
  assert.deepEqual(rows, [{ id: 'order-5', due: 4320 }]);
});

test('на смене поступления неразобранный заказ виден, партии ещё нет', async () => {
  const app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: pathV1('/sessions'),
      payload: { seed: 42, level: 'clean', overlay: 'incoming' },
    });
    const id = (created.json() as { id: string }).id;
    for (let step = 0; step < 4; step += 1) {
      const advanced = await app.inject({ method: 'POST', url: pathV1(`/sessions/${id}/advance`) });
      assert.equal(advanced.statusCode, 200, advanced.body);
    }
    const roles = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/roles?shift=4`) });
    assert.equal(roles.statusCode, 200, roles.body);
    assert.deepEqual(pendingOrders(roles.json() as { records: readonly { kind: string; ref: string; status?: string; contractDue?: number }[] }), [
      { id: 'order-5', due: 4320 },
    ]);
    const shop = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=4`) });
    assert.equal(shop.statusCode, 200, shop.body);
    const batches = (shop.json() as { reality: { batches: readonly { id: string; appearedAt: number }[] } }).reality.batches;
    assert.equal(batches.some((batch) => batch.id === 'batch-7'), false);
    for (const batch of batches) {
      assert.equal(arrivalText(batch), '');
    }
    const accepted = await app.inject({
      method: 'POST',
      url: pathV1(`/sessions/${id}/decisions`),
      payload: { type: 'accept-order', orderId: 'order-5' },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const after = await app.inject({ method: 'GET', url: pathV1(`/sessions/${id}/shop?shift=4`) });
    const launched = (after.json() as { reality: { batches: readonly { id: string; appearedAt: number }[] } }).reality.batches;
    const fresh = launched.find((batch) => batch.id === 'batch-7');
    assert.ok(fresh !== undefined);
    assert.equal(arrivalText(fresh), 'новая · 2880 мин');
    for (const batch of launched) {
      if (batch.id !== 'batch-7') {
        assert.equal(arrivalText(batch), '');
      }
    }
  } finally {
    await app.close();
  }
});

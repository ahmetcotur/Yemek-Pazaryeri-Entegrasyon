import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/index.js';

const token = 'test-token-123456789012345678';
const secret = 'test-secret-123456789012345678';

async function boot(t, config = {}, upstream = fetch) {
  const server = createApp({ FOOD_DB_PATH: ':memory:', FOOD_API_TOKEN: token, ...config }, upstream);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return (path, method = 'GET', authenticated = true) => fetch('http://127.0.0.1:' + server.address().port + path, {
    method,
    headers: authenticated ? { authorization: 'Bearer ' + token } : {},
  });
}

test('demo supports creation, pagination, ordered actions and bearer authentication', async t => {
  const request = await boot(t);
  assert.equal((await request('/health', 'GET', false)).status, 200);
  assert.equal((await request('/v1/providers', 'GET', false)).status, 401);
  assert.equal((await request('/v1/orders/tgo')).status, 503);
  assert.equal((await request('/v1/orders/demo?size=51')).status, 400);
  const created = await request('/v1/demo/orders', 'POST');
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.status, 'new');
  const url = '/v1/orders/demo/' + order.id;
  assert.equal((await request(url + '/actions/ready', 'POST')).status, 409);
  assert.equal((await (await request(url + '/actions/accept', 'POST')).json()).status, 'accepted');
  assert.equal((await request(url + '/actions/accept', 'POST')).status, 409);
  assert.equal((await (await request(url + '/actions/ready', 'POST')).json()).status, 'ready');
  assert.equal((await (await request(url + '/actions/dispatch', 'POST')).json()).status, 'out_for_delivery');
  assert.equal((await (await request(url + '/actions/deliver', 'POST')).json()).status, 'delivered');
  assert.equal((await (await request(url)).json()).status, 'delivered');
  assert.equal((await (await request('/v1/orders/demo?size=1')).json()).data[0].id, order.id);
});

test('signed webhook retries with the same event ID', async t => {
  const attempts = [];
  const request = await boot(t, { FOOD_WEBHOOK_URL: 'https://receiver.example/webhook', FOOD_WEBHOOK_SECRET: secret },
    async (url, options) => {
      attempts.push({ url: url.href, ...options });
      return new Response(null, { status: attempts.length === 1 ? 503 : 204 });
    });
  const order = await (await request('/v1/demo/orders', 'POST')).json();
  for (let i = 0; attempts.length < 2 && i < 40; i++) await delay(100);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].headers['x-food-event-id'], attempts[1].headers['x-food-event-id']);
  assert.equal(attempts[0].body, attempts[1].body);
  for (const event of attempts) {
    const signed = event.headers['x-food-timestamp'] + '.' + event.body;
    assert.equal(event.headers['x-food-signature'], 'sha256=' + createHmac('sha256', secret).update(signed).digest('hex'));
    assert.equal(JSON.parse(event.body).order.id, order.id);
  }
});

test('TGO reads from Meal Stage and only exposes the configured store', async t => {
  const remoteCalls = [];
  const packageData = {
    id: 'package1', storeId: 55, totalPrice: 60.25, packageStatus: 'Invoiced', deliveryType: 'GO',
    userInformation: { appName: 'Galaxy' }, address: { phone: 'hidden' },
    lines: [{ name: 'Demo', unitSellingPrice: 60.25, items: [{ lineItemId: 12, isCancelled: false }] }],
  };
  const request = await boot(t, {
    FOOD_TGO_ENABLED: '1', TGO_API_KEY: 'key', TGO_API_SECRET: 'secret', TGO_STORE_ID: '55',
    TGO_SUPPLIER_ID: '1234', TGO_AGENT_NAME: 'TestAgent', TGO_EXECUTOR_USER: 'test@example.com',
  }, async (url, options) => {
    remoteCalls.push([url, options]);
    if (url.pathname.endsWith('/packages')) {
      return Response.json({ content: [packageData, { ...packageData, id: 'other', storeId: 56 }], totalPages: 2 });
    }
    if (url.pathname.endsWith('/limited')) return new Response(null, { status: 429, headers: { 'Retry-After': '8' } });
    return Response.json(url.pathname.endsWith('/other') ? { ...packageData, storeId: 56 } : packageData);
  });

  const list = await (await request('/v1/orders/tgo?page=0&size=10')).json();
  assert.equal(list.data.length, 1);
  assert.equal(list.has_more, true);
  const [url, options] = remoteCalls[0];
  assert.equal(url.href, 'https://stageapi.tgoapis.com/integrator/order/meal/suppliers/1234/packages?storeId=55&page=0&size=10');
  assert.equal(options.headers['user-agent'], '1234 - TestAgent');
  assert.equal(options.headers.authorization, 'Basic ' + Buffer.from('key:secret').toString('base64'));
  const detail = await (await request('/v1/orders/tgo/package1')).json();
  assert.equal(detail.status, 'ready');
  assert.equal(detail.total_minor, 6025);
  assert.equal(detail.source_app, 'Galaxy');
  assert.equal(detail.address, undefined);
  assert.equal((await request('/v1/orders/tgo/other')).status, 404);
  const limited = await request('/v1/orders/tgo/limited');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '8');
});

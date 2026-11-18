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
  return (path, method = 'GET', authenticated = true, body = null) => fetch('http://127.0.0.1:' + server.address().port + path, {
    method,
    headers: {
      ...(authenticated ? { authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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
    userInformation: { appName: 'Galaxy' }, address: { phone: 'hidden', addressText: 'Bağdat Cad. No: 10 Kadıköy' },
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
  assert.equal(detail.address.full_address, 'Bağdat Cad. No: 10 Kadıköy');
  assert.equal(detail.customer.phone, 'hidden');
  assert.equal(detail.courier.model, 'platform');
  assert.equal((await request('/v1/orders/tgo/other')).status, 404);
  const limited = await request('/v1/orders/tgo/limited');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '8');
});

test('TGO supports real order actions: accept, ready, dispatch, cancel', async t => {
  const calls = [];
  const request = await boot(t, {
    FOOD_TGO_ENABLED: '1', TGO_API_KEY: 'key', TGO_API_SECRET: 'secret', TGO_STORE_ID: '55',
    TGO_SUPPLIER_ID: '1234', TGO_AGENT_NAME: 'TestAgent', TGO_EXECUTOR_USER: 'test@example.com',
  }, async (url, options) => {
    calls.push({ url: url.href, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return new Response(null, { status: 200 });
  });

  const acceptRes = await (await request('/v1/orders/tgo/pkg123/actions/accept', 'POST', true, { preparationTime: 25 })).json();
  assert.equal(acceptRes.status, 'accepted');
  assert.equal(calls[0].url, 'https://stageapi.tgoapis.com/integrator/order/meal/suppliers/1234/packages/picked');
  assert.equal(calls[0].body.packageId, 'pkg123');
  assert.equal(calls[0].body.preparationTime, 25);

  const readyRes = await (await request('/v1/orders/tgo/pkg123/actions/ready', 'POST')).json();
  assert.equal(readyRes.status, 'ready');
  assert.equal(calls[1].url, 'https://stageapi.tgoapis.com/integrator/order/meal/suppliers/1234/packages/pkg123/invoiced');

  const dispatchRes = await (await request('/v1/orders/tgo/pkg123/actions/dispatch', 'POST')).json();
  assert.equal(dispatchRes.status, 'out_for_delivery');
  assert.equal(calls[2].url, 'https://stageapi.tgoapis.com/integrator/order/meal/suppliers/1234/packages/pkg123/manual-shipped');

  const cancelRes = await (await request('/v1/orders/tgo/pkg123/actions/cancel', 'POST', true, { itemIdList: ['item1'], reasonId: 621 })).json();
  assert.equal(cancelRes.status, 'cancelled');
  assert.equal(calls[3].url, 'https://stageapi.tgoapis.com/integrator/order/meal/suppliers/1234/packages/unsupplied');
  assert.equal(calls[3].body.packageId, 'pkg123');
  assert.equal(calls[3].body.reasonId, 621);
});

test('TGO keeps adapter identity separate from application source', async t => {
  const variants = [
    [{ userInformation: { appName: 'Trendyol' } }, 'Trendyol', 'trendyol', 'Trendyol'],
    [{ userInformation: { appName: 'TrendyolGo' } }, 'TrendyolGo', 'trendyol_go', 'Uber Eats Trendyol Go'],
    [{ userInformation: { appName: 'Galaxy' } }, 'Galaxy', 'getir_yemek', 'GetirYemek by Uber Eats'],
    [{ userInformation: { appName: 'UberEats' } }, 'UberEats', 'uber_eats', 'Uber Eats'],
    [{ appName: 'Galaxy' }, 'Galaxy', 'getir_yemek', 'GetirYemek by Uber Eats'],
    [{ userInformation: { appName: 'FutureApp' } }, 'FutureApp', 'unknown', null],
    [{}, null, 'unknown', null],
  ];
  const packages = variants.map(([fields], index) => ({ id: 'source' + index, storeId: 55, ...fields }));
  const request = await boot(t, {
    FOOD_TGO_ENABLED: '1', TGO_API_KEY: 'key', TGO_API_SECRET: 'secret', TGO_STORE_ID: '55',
    TGO_SUPPLIER_ID: '1234', TGO_AGENT_NAME: 'TestAgent', TGO_EXECUTOR_USER: 'test@example.com',
  }, async url => {
    if (url.pathname.endsWith('/packages')) return Response.json({ content: packages, totalPages: 1 });
    return Response.json(packages.find(order => url.pathname.endsWith('/' + order.id)));
  });
  const page = await (await request('/v1/orders/tgo')).json();
  for (const [index, [, original, channel, label]] of variants.entries()) {
    const detail = await (await request('/v1/orders/tgo/source' + index)).json();
    for (const order of [detail, page.data[index]]) {
      assert.equal(order.channel, 'tgo');
      assert.equal(order.source_app, original);
      assert.equal(order.source_channel, channel);
      assert.equal(order.source_label, label);
    }
  }
  const demo = await (await request('/v1/demo/orders', 'POST')).json();
  assert.equal(demo.source_channel, 'demo');
  assert.equal(demo.source_label, 'Demo');
});

test('Yemeksepeti supports OAuth2 client credentials, order reading and status actions', async t => {
  const calls = [];
  const fakeDhOrder = {
    id: 'ys-order-99',
    orderNumber: 'YS123456',
    vendorId: 'vendor-1',
    status: 'RECEIVED',
    pricing: { total: 125.5, currency: 'TRY' },
    items: [{ name: 'Lahmacun', quantity: 2, price: { unit: 62.75 } }],
    delivery: { type: 'OWN_DELIVERY' },
  };

  const request = await boot(t, {
    FOOD_YS_ENABLED: '1',
    YS_CLIENT_ID: 'test_client',
    YS_CLIENT_SECRET: 'test_secret',
    YS_CHAIN_ID: 'chain_1',
    YS_VENDOR_ID: 'vendor-1',
  }, async (url, options) => {
    calls.push({ url: url.href, method: options.method });
    if (url.pathname === '/v1/oauth/token') {
      return Response.json({ access_token: 'fake_dh_token', expires_in: 3600 });
    }
    if (url.pathname.includes('/orders/ys-order-99/status')) {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.includes('/orders/ys-order-99')) {
      return Response.json({ data: fakeDhOrder });
    }
    if (url.pathname.includes('/orders')) {
      return Response.json({ data: [fakeDhOrder] });
    }
    return new Response(null, { status: 404 });
  });

  const list = await (await request('/v1/orders/yemeksepeti')).json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].source_channel, 'yemeksepeti');
  assert.equal(list.data[0].status, 'new');
  assert.equal(list.data[0].total_minor, 12550);
  assert.equal(list.data[0].fulfillment, 'restaurant');

  const detail = await (await request('/v1/orders/yemeksepeti/ys-order-99')).json();
  assert.equal(detail.id, 'ys-order-99');

  const actionRes = await (await request('/v1/orders/yemeksepeti/ys-order-99/actions/accept', 'POST')).json();
  assert.equal(actionRes.status, 'accepted');
  assert.equal(actionRes.channel, 'yemeksepeti');
});

test('GetirYemek supports direct API key auth, order reading and lifecycle actions', async t => {
  const calls = [];
  const fakeGetirOrder = {
    id: 'getir-555',
    clientOrderNumber: 'GTR-001',
    restaurantId: 'rest-42',
    status: '100',
    totalPrice: 240.0,
    products: [{ name: 'Burger Menü', count: 1, price: 240.0 }],
    courierType: 'GETIR',
  };

  const request = await boot(t, {
    FOOD_GETIR_ENABLED: '1',
    GETIR_API_KEY: 'test_getir_key',
    GETIR_RESTAURANT_SECRET_KEY: 'test_getir_secret',
    GETIR_RESTAURANT_ID: 'rest-42',
  }, async (url, options) => {
    calls.push({ url: url.href, method: options.method });
    if (url.pathname.endsWith('/verify')) return Response.json({ result: true });
    if (url.pathname.endsWith('/prepare')) return Response.json({ result: true });
    if (url.pathname.endsWith('/food-orders/getir-555')) return Response.json(fakeGetirOrder);
    if (url.pathname.endsWith('/food-orders')) return Response.json([fakeGetirOrder]);
    return new Response(null, { status: 404 });
  });

  const list = await (await request('/v1/orders/getir')).json();
  assert.equal(list.data[0].source_channel, 'getir_yemek');
  assert.equal(list.data[0].status, 'new');
  assert.equal(list.data[0].total_minor, 24000);
  assert.equal(list.data[0].fulfillment, 'platform');

  const accept = await (await request('/v1/orders/getir/getir-555/actions/accept', 'POST')).json();
  assert.equal(accept.status, 'accepted');

  const ready = await (await request('/v1/orders/getir/getir-555/actions/ready', 'POST')).json();
  assert.equal(ready.status, 'ready');
});

test('Migros Yemek supports XApiKey, order reading and UpdateOrderStatus', async t => {
  const calls = [];
  const fakeMigrosOrder = {
    orderId: 7891011,
    orderNumber: 'MGR-100',
    storeId: 'migros-store-1',
    status: 'NEW',
    totalAmount: 199.90,
    items: [{ name: 'Tavuk Döner Dürüm', quantity: 1, price: 199.90 }],
    deliveryModel: 'RESTAURANT',
  };

  const request = await boot(t, {
    FOOD_MIGROS_ENABLED: '1',
    MIGROS_API_KEY: 'test_migros_key',
    MIGROS_STORE_ID: 'migros-store-1',
  }, async (url, options) => {
    calls.push({ url: url.href, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (url.pathname === '/Order/v2/UpdateOrderStatus') {
      return Response.json({ isSuccess: true });
    }
    if (url.pathname.includes('/Order/GetOrderDetail')) {
      return Response.json(fakeMigrosOrder);
    }
    if (url.pathname.includes('/Order/GetOrders')) {
      return Response.json([fakeMigrosOrder]);
    }
    return new Response(null, { status: 404 });
  });

  const list = await (await request('/v1/orders/migros')).json();
  assert.equal(list.data[0].source_channel, 'migros_yemek');
  assert.equal(list.data[0].status, 'new');
  assert.equal(list.data[0].total_minor, 19990);
  assert.equal(list.data[0].fulfillment, 'restaurant');

  const accept = await (await request('/v1/orders/migros/7891011/actions/accept', 'POST')).json();
  assert.equal(accept.status, 'accepted');
  assert.equal(calls[calls.length - 1].body.status, 'APPROVED');
  assert.equal(calls[calls.length - 1].body.orderId, 7891011);
});

test('Inbound webhooks normalize and persist orders from real marketplaces', async t => {
  const request = await boot(t, {
    FOOD_GETIR_ENABLED: '1',
    GETIR_API_KEY: 'test_getir_key',
    GETIR_RESTAURANT_SECRET_KEY: 'test_getir_secret',
    GETIR_RESTAURANT_ID: 'rest-42',
  });

  const getirPayload = {
    id: 'webhook-order-1',
    restaurantId: 'rest-42',
    status: '100',
    totalPrice: 180,
    products: [{ name: 'Karışık Pizza', count: 1, price: 180 }],
  };

  const res = await request('/v1/webhooks/getir', 'POST', false, getirPayload);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.id, 'webhook-order-1');

  // Verify it exists in local store
  const orderInDb = await (await request('/v1/orders/demo/webhook-order-1')).json();
  assert.equal(orderInDb.id, 'webhook-order-1');
  assert.equal(orderInDb.source_label, 'GetirYemek');
  assert.equal(orderInDb.total_minor, 18000);
});

test('SaaS interface is public while order API still requires authentication', async t => {
  const request = await boot(t);
  const home = await request('/', 'GET', false);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /Paket API/);
  assert.equal((await request('/assets/app.js', 'GET', false)).status, 200);
  assert.equal((await request('/assets/style.css', 'GET', false)).status, 200);
  const head = await request('/app', 'HEAD', false);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await request('/v1/orders/demo', 'GET', false)).status, 401);
  assert.equal((await request('/.env', 'GET', false)).status, 401);
  assert.equal((await request('/assets/unknown.js', 'GET', false)).status, 401);
});

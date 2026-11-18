import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { createTgo, ProviderError } from './tgo.js';

const routes = {
  list: /^\/v1\/orders\/(demo|tgo)$/,
  detail: /^\/v1\/orders\/(demo|tgo)\/([\w-]{1,100})$/,
  action: /^\/v1\/orders\/demo\/([\w-]{1,100})\/actions\/(accept|ready|dispatch|deliver|cancel)$/,
};

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

function authorized(header, token) {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pagination(query) {
  const page = query.get('page') ?? '0';
  const size = query.get('size') ?? '20';
  if (!/^\d{1,6}$/.test(page) || !/^\d{1,2}$/.test(size) || Number(size) < 1 || Number(size) > 50) return null;
  return { page: Number(page), size: Number(size) };
}

export function createApp(env, fetcher = fetch) {
  const token = env.FOOD_API_TOKEN;
  if (!token || token.length < 24) throw new Error('FOOD_API_TOKEN must contain at least 24 characters');
  const destination = env.FOOD_WEBHOOK_URL ? new URL(env.FOOD_WEBHOOK_URL) : null;
  const webhookSecret = env.FOOD_WEBHOOK_SECRET;
  if (destination && (!['http:', 'https:'].includes(destination.protocol) || destination.username ||
      destination.password || !webhookSecret || webhookSecret.length < 24)) {
    throw new Error('Webhook URL must use HTTP(S) and have a separate secret of at least 24 characters');
  }
  const tgo = createTgo(env, fetcher);
  const path = env.FOOD_DB_PATH ?? './data/orders.sqlite';
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const store = createStore(path, destination, webhookSecret, fetcher);

  const server = createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://local'); } catch {
      return json(response, 400, { error: 'invalid_url' });
    }
    const { pathname, searchParams } = url;
    const method = request.method;
    if (method === 'GET' && pathname === '/health') return json(response, 200, { ok: true });
    if (!authorized(request.headers.authorization, token)) {
      return json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }

    try {
      if (method === 'GET' && pathname === '/v1/providers') {
        return json(response, 200, { data: [
          { id: 'demo', enabled: true, capabilities: ['list', 'read', 'create', 'accept', 'ready', 'dispatch', 'deliver', 'cancel'] },
          { id: 'tgo', enabled: !!tgo, environment: 'stage', capabilities: tgo ? ['list', 'read'] : [] },
        ] });
      }
      if (method === 'POST' && pathname === '/v1/demo/orders') return json(response, 201, store.create());

      const action = pathname.match(routes.action);
      if (method === 'POST' && action) {
        const result = store.act(action[1], action[2]);
        return json(response, result.code, result.data ?? { error: result.error });
      }

      const list = pathname.match(routes.list);
      const detail = pathname.match(routes.detail);
      if (method === 'GET' && (list || detail)) {
        const provider = (list || detail)[1];
        if (provider === 'tgo' && !tgo) return json(response, 503, { error: 'provider_disabled' });
        if (list) {
          const query = pagination(searchParams);
          if (!query) return json(response, 400, { error: 'invalid_pagination' });
          const result = provider === 'tgo' ? await tgo.list(query) : store.list(query.page, query.size);
          return json(response, 200, result);
        }
        const order = provider === 'tgo' ? await tgo.read(detail[2]) : store.get(detail[2]);
        return order ? json(response, 200, order) : json(response, 404, { error: 'order_not_found' });
      }
      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof ProviderError) {
        const headers = error.retryAfter ? { 'retry-after': error.retryAfter } : {};
        return json(response, error.status, { error: error.message }, headers);
      }
      console.error('Request failed');
      return json(response, 500, { error: 'internal_error' });
    }
  });

  const interval = setInterval(() => store.flush()?.catch(() => console.error('Outbox processing failed')), 500);
  interval.unref();
  server.once('close', () => {
    clearInterval(interval);
    store.close().catch(() => console.error('Database close failed'));
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp(process.env).listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
}

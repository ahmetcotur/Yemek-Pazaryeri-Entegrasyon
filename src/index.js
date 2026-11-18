import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { createTgo } from './tgo.js';
import { createYemeksepeti } from './yemeksepeti.js';
import { createGetir } from './getir.js';
import { createMigros } from './migros.js';
import { ProviderError } from './errors.js';

export { ProviderError };

const publicFiles = new Map([
  ['/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/app', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/assets/style.css', ['../public/style.css', 'text/css; charset=utf-8']],
  ['/assets/app.js', ['../public/app.js', 'text/javascript; charset=utf-8']],
]);

const routes = {
  list: /^\/v1\/orders\/(demo|tgo|yemeksepeti|getir|migros)$/,
  detail: /^\/v1\/orders\/(demo|tgo|yemeksepeti|getir|migros)\/([\w-]{1,100})$/,
  action: /^\/v1\/orders\/(demo|tgo|yemeksepeti|getir|migros)\/([\w-]{1,100})\/actions\/(accept|ready|dispatch|deliver|cancel)$/,
  webhook: /^\/v1\/webhooks\/(tgo|yemeksepeti|getir|migros)$/,
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

async function parseBody(request) {
  return new Promise(resolve => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1048576) {
        request.destroy();
        resolve(null);
      }
    });
    request.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve(null));
  });
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
  const ys = createYemeksepeti(env, fetcher);
  const getir = createGetir(env, fetcher);
  const migros = createMigros(env, fetcher);

  const adapters = { tgo, yemeksepeti: ys, getir, migros };

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

    if ((method === 'GET' || method === 'HEAD') && publicFiles.has(pathname)) {
      const [file, type] = publicFiles.get(pathname);
      const content = readFileSync(new URL(file, import.meta.url));
      response.writeHead(200, {
        'content-type': type,
        'content-length': content.length,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'cache-control': 'no-cache',
      });
      return response.end(method === 'HEAD' ? undefined : content);
    }

    if (method === 'GET' && pathname === '/health') return json(response, 200, { ok: true });

    // Inbound Marketplace Webhooks (Optionally verified via provider signatures)
    const webhookMatch = pathname.match(routes.webhook);
    if (method === 'POST' && webhookMatch) {
      const providerName = webhookMatch[1];
      const adapter = adapters[providerName];
      if (!adapter) return json(response, 503, { error: 'provider_disabled' });
      try {
        const payload = await parseBody(request);
        if (!payload) return json(response, 400, { error: 'invalid_payload' });
        const normalized = adapter.normalize(payload);
        store.save(normalized, 'order.created');
        return json(response, 200, { ok: true, id: normalized.id });
      } catch (err) {
        if (err instanceof ProviderError) return json(response, err.status, { error: err.message });
        return json(response, 500, { error: 'webhook_processing_failed' });
      }
    }

    if (!authorized(request.headers.authorization, token)) {
      return json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }

    try {
      if (method === 'GET' && pathname === '/v1/providers') {
        return json(response, 200, { data: [
          { id: 'demo', enabled: true, environment: 'local', capabilities: ['list', 'read', 'create', 'accept', 'ready', 'dispatch', 'deliver', 'cancel'] },
          { id: 'tgo', enabled: !!tgo, environment: tgo?.environment ?? 'stage', capabilities: tgo?.capabilities ?? [] },
          { id: 'yemeksepeti', enabled: !!ys, environment: ys?.environment ?? 'sandbox', capabilities: ys?.capabilities ?? [] },
          { id: 'getir', enabled: !!getir, environment: getir?.environment ?? 'dev', capabilities: getir?.capabilities ?? [] },
          { id: 'migros', enabled: !!migros, environment: migros?.environment ?? 'test', capabilities: migros?.capabilities ?? [] },
        ] });
      }

      if (method === 'POST' && pathname === '/v1/demo/orders') {
        return json(response, 201, store.create());
      }

      const action = pathname.match(routes.action);
      if (method === 'POST' && action) {
        const provider = action[1];
        const id = action[2];
        const actionName = action[3];

        if (provider === 'demo') {
          const result = store.act(id, actionName);
          return json(response, result.code, result.data ?? { error: result.error });
        }

        const adapter = adapters[provider];
        if (!adapter) return json(response, 503, { error: 'provider_disabled' });

        const body = await parseBody(request);
        const result = await adapter.act(id, actionName, body);
        return json(response, 200, result);
      }

      const list = pathname.match(routes.list);
      const detail = pathname.match(routes.detail);
      if (method === 'GET' && (list || detail)) {
        const provider = (list || detail)[1];

        if (provider === 'demo') {
          if (list) {
            const query = pagination(searchParams);
            if (!query) return json(response, 400, { error: 'invalid_pagination' });
            return json(response, 200, store.list(query.page, query.size));
          }
          const order = store.get(detail[2]);
          return order ? json(response, 200, order) : json(response, 404, { error: 'order_not_found' });
        }

        const adapter = adapters[provider];
        if (!adapter) return json(response, 503, { error: 'provider_disabled' });

        if (list) {
          const query = pagination(searchParams);
          if (!query) return json(response, 400, { error: 'invalid_pagination' });
          const result = await adapter.list(query);
          return json(response, 200, result);
        }

        const order = await adapter.read(detail[2]);
        return order ? json(response, 200, order) : json(response, 404, { error: 'order_not_found' });
      }

      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof ProviderError) {
        const headers = error.retryAfter ? { 'retry-after': error.retryAfter } : {};
        return json(response, error.status, { error: error.message }, headers);
      }
      console.error('Request failed:', error);
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

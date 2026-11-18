import { ProviderError } from './errors.js';

const PROD_URL = 'https://food-external-api-gateway.getirapi.com';
const DEV_URL = 'https://food-external-api-gateway.fooddev.getirapi.com';

const statusMap = new Map([
  ['100', 'new'],
  ['NEW', 'new'],
  ['CREATED', 'new'],
  ['200', 'accepted'],
  ['VERIFIED', 'accepted'],
  ['PREPARING', 'accepted'],
  ['300', 'ready'],
  ['PREPARED', 'ready'],
  ['400', 'out_for_delivery'],
  ['HANDOVER', 'out_for_delivery'],
  ['ON_WAY', 'out_for_delivery'],
  ['500', 'delivered'],
  ['DELIVERED', 'delivered'],
  ['600', 'cancelled'],
  ['900', 'cancelled'],
  ['CANCELLED', 'cancelled'],
]);

function minorUnits(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function normalize(order) {
  const id = order.id || order.foodOrderId || order._id;
  if (!id) throw new ProviderError(502, 'invalid_provider_response');

  const rawStatus = String(order.status || order.orderStatus || '100');
  const status = statusMap.get(rawStatus) ?? 'unknown';

  if (!statusMap.has(rawStatus)) {
    console.warn(`[GETIR_DRIFT] Bilinmeyen sipariş durumu (status): "${rawStatus}" (sipariş ID: ${id})`);
  }

  const items = (Array.isArray(order.products || order.items) ? (order.products || order.items) : []).map(p => ({
    name: p.name || p.title || 'Ürün',
    quantity: p.count || p.quantity || 1,
    cancelled_quantity: p.cancelledCount || 0,
    unit_price_minor: minorUnits(p.price || p.unitPrice || 0),
  }));

  const total = order.totalPrice ?? order.total ?? order.checkoutAmount ?? 0;

  return {
    id: String(id),
    channel: 'getir',
    store_id: String(order.restaurantId || order.restaurant || ''),
    order_number: order.clientOrderNumber ? String(order.clientOrderNumber) : String(id),
    status,
    source_status: rawStatus,
    source_app: 'GetirYemek',
    source_channel: 'getir_yemek',
    source_label: 'GetirYemek',
    fulfillment: order.courierType === 'RESTAURANT' ? 'restaurant' : 'platform',
    total_minor: minorUnits(total),
    currency: order.currency || 'TRY',
    payment_method: order.paymentMethodText || order.paymentType || 'online',
    items,
  };
}

export function createGetir(env, fetcher = fetch) {
  if (env.FOOD_GETIR_ENABLED !== '1') return null;
  const { GETIR_API_KEY, GETIR_RESTAURANT_SECRET_KEY, GETIR_RESTAURANT_ID, GETIR_ENV, GETIR_BASE_URL } = env;

  if (!GETIR_API_KEY || !GETIR_RESTAURANT_SECRET_KEY || !GETIR_RESTAURANT_ID) {
    throw new Error('Getir requires GETIR_API_KEY, GETIR_RESTAURANT_SECRET_KEY and GETIR_RESTAURANT_ID');
  }

  const baseUrl = GETIR_BASE_URL || (GETIR_ENV === 'prod' || GETIR_ENV === 'production' ? PROD_URL : DEV_URL);

  async function request(path, options = {}) {
    const url = new URL(path, baseUrl);
    let response;
    try {
      response = await fetcher(url, {
        method: options.method || 'GET',
        signal: AbortSignal.timeout(8000),
        headers: {
          accept: 'application/json',
          'x-api-key': GETIR_API_KEY,
          token: GETIR_RESTAURANT_SECRET_KEY,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        body: options.body,
      });
    } catch {
      throw new ProviderError(502, 'provider_unreachable');
    }

    if (response.status === 429) {
      throw new ProviderError(429, 'provider_rate_limited', response.headers.get('retry-after'));
    }
    if (response.status === 404) {
      throw new ProviderError(404, 'order_not_found');
    }
    if (!response.ok) {
      throw new ProviderError(502, response.status === 401 || response.status === 403 ? 'provider_access_denied' : 'provider_request_failed');
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return null;
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  return {
    environment: (GETIR_ENV === 'prod' || GETIR_ENV === 'production') ? 'prod' : 'dev',
    capabilities: ['list', 'read', 'accept', 'ready', 'dispatch', 'deliver', 'cancel'],

    async list(query) {
      const search = new URLSearchParams({
        restaurantId: GETIR_RESTAURANT_ID,
        page: String(query.page),
        limit: String(query.size),
      });
      const path = `/food-orders?` + search.toString();
      const res = await request(path);
      const list = Array.isArray(res) ? res : (res?.data || res?.orders || []);
      const data = list.map(normalize);
      return { data, page: query.page, size: query.size, has_more: data.length >= query.size };
    },

    async read(id) {
      const path = `/food-orders/${id}?restaurantId=${GETIR_RESTAURANT_ID}`;
      const res = await request(path);
      return normalize(res?.data || res);
    },

    async act(id, action, params = {}) {
      const restaurantId = GETIR_RESTAURANT_ID;
      const actionEndpoints = {
        accept: { path: `/food-orders/${id}/verify`, status: 'accepted', body: { restaurantId, preparationTime: params.preparationTime ?? 30 } },
        ready: { path: `/food-orders/${id}/prepare`, status: 'ready', body: { restaurantId } },
        dispatch: { path: `/food-orders/${id}/handover`, status: 'out_for_delivery', body: { restaurantId } },
        deliver: { path: `/food-orders/${id}/deliver`, status: 'delivered', body: { restaurantId } },
        cancel: { path: `/food-orders/${id}/cancel`, status: 'cancelled', body: { restaurantId, reasonId: params.reasonId ?? 1 } },
      };

      const step = actionEndpoints[action];
      if (!step) throw new ProviderError(409, 'action_not_available');

      await request(step.path, {
        method: 'POST',
        body: JSON.stringify(step.body),
      });

      return { id, status: step.status, action, channel: 'getir' };
    },

    normalize,
  };
}

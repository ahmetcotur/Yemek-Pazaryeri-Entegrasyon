import { ProviderError } from './errors.js';

const PROD_URL = 'https://yemek-api.migrosone.com';
const TEST_URL = 'https://test-yemek-api.migrosone.com';

const statusMap = new Map([
  ['1', 'new'],
  ['NEW', 'new'],
  ['CREATED', 'new'],
  ['2', 'accepted'],
  ['APPROVED', 'accepted'],
  ['PREPARING', 'accepted'],
  ['3', 'ready'],
  ['READY', 'ready'],
  ['4', 'out_for_delivery'],
  ['SHIPPED', 'out_for_delivery'],
  ['5', 'delivered'],
  ['DELIVERED', 'delivered'],
  ['6', 'cancelled'],
  ['REJECTED', 'cancelled'],
  ['CANCELLED', 'cancelled'],
]);

const actionStatusMap = {
  accept: 'APPROVED',
  ready: 'READY',
  dispatch: 'SHIPPED',
  deliver: 'DELIVERED',
  cancel: 'REJECTED',
};

function minorUnits(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function normalize(order) {
  const id = order.orderId || order.id;
  if (!id) throw new ProviderError(502, 'invalid_provider_response');

  const rawStatus = String(order.status || order.orderStatus || 'NEW');
  const status = statusMap.get(rawStatus) ?? 'unknown';

  if (!statusMap.has(rawStatus)) {
    console.warn(`[MIGROS_DRIFT] Bilinmeyen sipariş durumu (status): "${rawStatus}" (sipariş ID: ${id})`);
  }

  const items = (Array.isArray(order.items || order.lines) ? (order.items || order.lines) : []).map(item => ({
    name: item.name || item.productName || 'Ürün',
    quantity: item.quantity || item.count || 1,
    cancelled_quantity: item.cancelledQuantity || 0,
    unit_price_minor: minorUnits(item.price || item.unitPrice || 0),
  }));

  const total = order.totalAmount ?? order.totalPrice ?? order.total ?? 0;

  return {
    id: String(id),
    channel: 'migros',
    store_id: String(order.storeId || order.warehouseId || ''),
    order_number: order.orderNumber ? String(order.orderNumber) : String(id),
    status,
    source_status: rawStatus,
    source_app: 'MigrosYemek',
    source_channel: 'migros_yemek',
    source_label: 'Migros Yemek',
    fulfillment: order.deliveryModel === 'RESTAURANT' ? 'restaurant' : 'platform',
    total_minor: minorUnits(total),
    currency: order.currency || 'TRY',
    payment_method: order.paymentType || 'online',
    items,
  };
}

export function createMigros(env, fetcher = fetch) {
  if (env.FOOD_MIGROS_ENABLED !== '1') return null;
  const { MIGROS_API_KEY, MIGROS_STORE_ID, MIGROS_ENV, MIGROS_BASE_URL } = env;

  if (!MIGROS_API_KEY || !MIGROS_STORE_ID) {
    throw new Error('Migros requires MIGROS_API_KEY and MIGROS_STORE_ID');
  }

  const baseUrl = MIGROS_BASE_URL || (MIGROS_ENV === 'prod' || MIGROS_ENV === 'production' ? PROD_URL : TEST_URL);

  async function request(path, options = {}) {
    const url = new URL(path, baseUrl);
    let response;
    try {
      response = await fetcher(url, {
        method: options.method || 'GET',
        signal: AbortSignal.timeout(8000),
        headers: {
          accept: 'application/json',
          XApiKey: MIGROS_API_KEY,
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
    environment: (MIGROS_ENV === 'prod' || MIGROS_ENV === 'production') ? 'prod' : 'test',
    capabilities: ['list', 'read', 'accept', 'ready', 'dispatch', 'deliver', 'cancel'],

    async list(query) {
      const search = new URLSearchParams({
        storeId: MIGROS_STORE_ID,
        page: String(query.page),
        size: String(query.size),
      });
      const path = `/Order/GetOrders?` + search.toString();
      const res = await request(path);
      const list = Array.isArray(res) ? res : (res?.data || res?.orders || []);
      const data = list.map(normalize);
      return { data, page: query.page, size: query.size, has_more: data.length >= query.size };
    },

    async read(id) {
      const search = new URLSearchParams({
        orderId: String(id),
        storeId: MIGROS_STORE_ID,
      });
      const path = `/Order/GetOrderDetail?` + search.toString();
      const res = await request(path);
      return normalize(res?.data || res);
    },

    async act(id, action) {
      const migrosStatus = actionStatusMap[action];
      if (!migrosStatus) throw new ProviderError(409, 'action_not_available');

      const path = `/Order/v2/UpdateOrderStatus`;
      await request(path, {
        method: 'POST',
        body: JSON.stringify({
          orderId: Number(id) || id,
          storeId: MIGROS_STORE_ID,
          status: migrosStatus,
        }),
      });

      const mapped = statusMap.get(migrosStatus) || action;
      return { id, status: mapped, action, channel: 'migros' };
    },

    normalize,
  };
}

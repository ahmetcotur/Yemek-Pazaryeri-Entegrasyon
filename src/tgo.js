import { ProviderError } from './errors.js';

export { ProviderError };

const STAGE_URL = 'https://stageapi.tgoapis.com';
const PROD_URL = 'https://api.tgoapis.com';

const sources = new Map([
  ['Trendyol', { channel: 'trendyol', label: 'Trendyol' }],
  ['TrendyolGo', { channel: 'trendyol_go', label: 'Uber Eats Trendyol Go' }],
  ['Galaxy', { channel: 'getir_yemek', label: 'GetirYemek by Uber Eats' }],
  ['UberEats', { channel: 'uber_eats', label: 'Uber Eats' }],
]);

const statuses = new Map(Object.entries({
  Created: 'new',
  Picking: 'accepted',
  Invoiced: 'ready',
  Shipped: 'out_for_delivery',
  Delivered: 'delivered',
  Cancelled: 'cancelled',
  UnSupplied: 'cancelled',
}));

function minorUnits(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function normalize(order) {
  if (typeof order?.id !== 'string' || !order.id || !order.storeId) {
    throw new ProviderError(502, 'invalid_provider_response');
  }
  const sourceApp = order.userInformation?.appName ?? order.appName ?? null;
  const source = sources.get(sourceApp);

  if (sourceApp && !source) {
    console.warn(`[TGO_DRIFT] Bilinmeyen kaynak uygulama (appName): "${sourceApp}" (sipariş ID: ${order.id})`);
  }
  if (order.packageStatus && !statuses.has(order.packageStatus)) {
    console.warn(`[TGO_DRIFT] Bilinmeyen paket durumu (packageStatus): "${order.packageStatus}" (sipariş ID: ${order.id})`);
  }

  const delivery = { STORE: 'restaurant', GO: 'platform' };
  return {
    id: order.id,
    channel: 'tgo',
    store_id: String(order.storeId),
    order_number: order.orderNumber == null ? null : String(order.orderNumber),
    status: statuses.get(order.packageStatus) ?? 'unknown',
    source_status: order.packageStatus ?? null,
    source_app: sourceApp,
    source_channel: source?.channel ?? 'unknown',
    source_label: source?.label ?? null,
    fulfillment: order.storePickupSelected === true ? 'pickup' : delivery[order.deliveryType] ?? 'unknown',
    total_minor: minorUnits(order.totalPrice),
    currency: 'TRY',
    payment_method: order.payment?.paymentType ?? null,
    items: (Array.isArray(order.lines) ? order.lines : []).map(line => {
      const units = Array.isArray(line.items) ? line.items : [];
      return {
        name: line.name ?? line.productName ?? null,
        quantity: units.length || null,
        cancelled_quantity: units.length ? units.filter(unit => unit.isCancelled === true).length : null,
        unit_price_minor: minorUnits(line.unitSellingPrice),
      };
    }),
  };
}

export function createTgo(env, fetcher = fetch) {
  if (env.FOOD_TGO_ENABLED !== '1') return null;
  const { TGO_SUPPLIER_ID, TGO_STORE_ID, TGO_API_KEY, TGO_API_SECRET, TGO_AGENT_NAME, TGO_EXECUTOR_USER, TGO_ENV } = env;
  if (!/^\d+$/.test(TGO_SUPPLIER_ID ?? '') || !/^\d+$/.test(TGO_STORE_ID ?? '') ||
      !TGO_API_KEY || !TGO_API_SECRET || !/^[a-zA-Z0-9]{1,30}$/.test(TGO_AGENT_NAME ?? '') ||
      !TGO_EXECUTOR_USER) {
    throw new Error('TGO requires supplier ID, store ID, API credentials, agent name and executor email');
  }

  const baseUrl = (TGO_ENV === 'prod' || TGO_ENV === 'production') ? PROD_URL : STAGE_URL;

  async function request(path, options = {}) {
    const url = new URL(path, baseUrl);
    let response;
    try {
      response = await fetcher(url, {
        method: options.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          accept: 'application/json',
          authorization: 'Basic ' + Buffer.from(TGO_API_KEY + ':' + TGO_API_SECRET).toString('base64'),
          'user-agent': TGO_SUPPLIER_ID + ' - ' + TGO_AGENT_NAME,
          'x-agentname': TGO_AGENT_NAME,
          'x-executor-user': TGO_EXECUTOR_USER,
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
      throw new ProviderError(502, response.status === 401 || response.status === 403
        ? 'provider_access_denied' : 'provider_request_failed');
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
    environment: (TGO_ENV === 'prod' || TGO_ENV === 'production') ? 'prod' : 'stage',
    capabilities: ['list', 'read', 'accept', 'ready', 'dispatch', 'cancel'],

    async list(query) {
      const search = new URLSearchParams({
        storeId: TGO_STORE_ID,
        page: String(query.page),
        size: String(query.size),
      });
      const result = await request('/integrator/order/meal/suppliers/' + TGO_SUPPLIER_ID + '/packages?' + search.toString());
      if (!Array.isArray(result?.content)) throw new ProviderError(502, 'invalid_provider_response');
      const data = result.content.map(normalize).filter(order => order.store_id === TGO_STORE_ID);
      return { data, page: query.page, size: query.size, has_more: Number(result.totalPages) > query.page + 1 };
    },

    async read(id) {
      if (!/^[a-zA-Z0-9]{1,100}$/.test(id)) throw new ProviderError(404, 'order_not_found');
      const path = '/integrator/order/meal/suppliers/' + TGO_SUPPLIER_ID + '/packages/' + id;
      const order = normalize(await request(path));
      if (order.store_id !== TGO_STORE_ID) throw new ProviderError(404, 'order_not_found');
      return order;
    },

    async act(id, action, params = {}) {
      if (!/^[a-zA-Z0-9]{1,100}$/.test(id)) throw new ProviderError(404, 'order_not_found');
      
      const supplierId = TGO_SUPPLIER_ID;
      if (action === 'accept') {
        // PUT /integrator/order/meal/suppliers/{supplierid}/packages/picked
        await request(`/integrator/order/meal/suppliers/${supplierId}/packages/picked`, {
          method: 'PUT',
          body: JSON.stringify({ packageId: String(id), preparationTime: params.preparationTime ?? 30 }),
        });
        return { id, status: 'accepted', action: 'accept', channel: 'tgo' };
      }

      if (action === 'ready') {
        // PUT /integrator/order/meal/suppliers/{supplierid}/packages/{packageId}/invoiced
        await request(`/integrator/order/meal/suppliers/${supplierId}/packages/${id}/invoiced`, {
          method: 'PUT',
        });
        return { id, status: 'ready', action: 'ready', channel: 'tgo' };
      }

      if (action === 'dispatch') {
        // PUT /integrator/order/meal/suppliers/{supplierid}/packages/{packageId}/manual-shipped
        await request(`/integrator/order/meal/suppliers/${supplierId}/packages/${id}/manual-shipped`, {
          method: 'PUT',
        });
        return { id, status: 'out_for_delivery', action: 'dispatch', channel: 'tgo' };
      }

      if (action === 'cancel') {
        // PUT /integrator/order/meal/suppliers/{supplierid}/packages/unsupplied
        await request(`/integrator/order/meal/suppliers/${supplierId}/packages/unsupplied`, {
          method: 'PUT',
          body: JSON.stringify({
            packageId: String(id),
            itemIdList: params.itemIdList ?? [],
            reasonId: params.reasonId ?? 621,
          }),
        });
        return { id, status: 'cancelled', action: 'cancel', channel: 'tgo' };
      }

      throw new ProviderError(409, 'action_not_available');
    },

    normalize,
  };
}

const stage = 'https://stageapi.tgoapis.com';
const sources = new Map([
  ['Trendyol', { channel: 'trendyol', label: 'Trendyol' }],
  ['TrendyolGo', { channel: 'trendyol_go', label: 'Uber Eats Trendyol Go' }],
  ['Galaxy', { channel: 'getir_yemek', label: 'GetirYemek by Uber Eats' }],
  ['UberEats', { channel: 'uber_eats', label: 'Uber Eats' }],
]);
const statuses = new Map(Object.entries({
  Created: 'new', Picking: 'accepted', Invoiced: 'ready',
  Shipped: 'out_for_delivery', Delivered: 'delivered',
  Cancelled: 'cancelled', UnSupplied: 'cancelled',
}));

export class ProviderError extends Error {
  constructor(status, code, retryAfter) {
    super(code);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function minorUnits(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function normalize(order) {
  if (typeof order?.id !== 'string' || !order.id || !order.storeId) {
    throw new ProviderError(502, 'invalid_provider_response');
  }
  const sourceApp = order.userInformation?.appName ?? order.appName ?? null;
  const source = sources.get(sourceApp);
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
  const { TGO_SUPPLIER_ID, TGO_STORE_ID, TGO_API_KEY, TGO_API_SECRET, TGO_AGENT_NAME, TGO_EXECUTOR_USER } = env;
  if (!/^\d+$/.test(TGO_SUPPLIER_ID ?? '') || !/^\d+$/.test(TGO_STORE_ID ?? '') ||
      !TGO_API_KEY || !TGO_API_SECRET || !/^[a-zA-Z0-9]{1,30}$/.test(TGO_AGENT_NAME ?? '') ||
      !TGO_EXECUTOR_USER) {
    throw new Error('TGO Stage requires supplier ID, store ID, API credentials, agent name and executor email');
  }

  async function get(packageId, query) {
    const path = '/integrator/order/meal/suppliers/' + TGO_SUPPLIER_ID + '/packages';
    const url = new URL(path + (packageId ? '/' + packageId : ''), stage);
    if (query) {
      url.searchParams.set('storeId', TGO_STORE_ID);
      url.searchParams.set('page', String(query.page));
      url.searchParams.set('size', String(query.size));
    }
    let response;
    try {
      response = await fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          accept: 'application/json',
          authorization: 'Basic ' + Buffer.from(TGO_API_KEY + ':' + TGO_API_SECRET).toString('base64'),
          'user-agent': TGO_SUPPLIER_ID + ' - ' + TGO_AGENT_NAME,
          'x-agentname': TGO_AGENT_NAME,
          'x-executor-user': TGO_EXECUTOR_USER,
        },
      });
    } catch {
      throw new ProviderError(502, 'provider_unreachable');
    }
    if (response.status === 429) throw new ProviderError(429, 'provider_rate_limited', response.headers.get('retry-after'));
    if (response.status === 404 && packageId) throw new ProviderError(404, 'order_not_found');
    if (!response.ok) throw new ProviderError(502, response.status === 401 || response.status === 403
      ? 'provider_access_denied' : 'provider_request_failed');
    try {
      return await response.json();
    } catch {
      throw new ProviderError(502, 'invalid_provider_response');
    }
  }

  return {
    async list(query) {
      const result = await get(null, query);
      if (!Array.isArray(result?.content)) throw new ProviderError(502, 'invalid_provider_response');
      const data = result.content.map(normalize).filter(order => order.store_id === TGO_STORE_ID);
      return { data, page: query.page, size: query.size, has_more: Number(result.totalPages) > query.page + 1 };
    },
    async read(id) {
      if (!/^[a-zA-Z0-9]{1,100}$/.test(id)) throw new ProviderError(404, 'order_not_found');
      const order = normalize(await get(id));
      if (order.store_id !== TGO_STORE_ID) throw new ProviderError(404, 'order_not_found');
      return order;
    },
  };
}

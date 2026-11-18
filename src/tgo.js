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

  const isPickup = order.storePickupSelected === true;
  const deliveryModel = isPickup ? 'pickup' : (order.deliveryType === 'STORE' ? 'restaurant' : 'platform');

  const addr = order.address ?? {};
  const address = (addr.addressText || addr.address1 || addr.fullAddress || addr.city) ? {
    full_address: addr.addressText ?? addr.address1 ?? addr.fullAddress ?? null,
    description: addr.addressDescription ?? null,
    building_number: addr.apartmentNumber ?? addr.buildingNumber ?? null,
    floor: addr.floor ? String(addr.floor) : null,
    door_number: addr.doorNumber ? String(addr.doorNumber) : null,
    district: addr.district ?? null,
    city: addr.city ?? null,
    latitude: typeof addr.latitude === 'number' ? addr.latitude : null,
    longitude: typeof addr.longitude === 'number' ? addr.longitude : null,
  } : null;

  const customer = {
    name: order.customer?.name ?? order.customerName ?? order.userInformation?.name ?? null,
    phone: order.customer?.phone ?? addr.phone ?? addr.maskPhoneNumber ?? null,
    note: order.customerNote ?? order.packageNote ?? order.note ?? null,
  };

  const etaMin = order.estimatedPickupTimeMin ? Number(order.estimatedPickupTimeMin) : null;
  const etaMinutes = etaMin ? Math.max(0, Math.round((etaMin - Date.now()) / 60000)) : null;

  const courier = {
    model: deliveryModel === 'pickup' ? 'pickup' : deliveryModel,
    name: order.courier?.name ?? order.courierName ?? null,
    phone: order.courier?.phoneNumber ?? order.courierPhone ?? null,
    status: order.pickupEtaState ?? order.courierStatus ?? null,
    is_nearby: order.isCourierNearby === true,
    eta_minutes: etaMinutes,
    estimated_pickup_time: etaMin ? new Date(etaMin).toISOString() : null,
    tracking_url: order.courierTrackingUrl ?? null,
  };

  const items = (Array.isArray(order.lines) ? order.lines : []).map(line => {
    const units = Array.isArray(line.items) ? line.items : [];
    const modifierOptions = (Array.isArray(line.modifierProducts) ? line.modifierProducts : []).map(m => ({
      name: m.name ?? m.productName ?? 'Ek Seçenek',
      price_minor: minorUnits(m.price ?? m.unitSellingPrice ?? 0),
    }));
    const extraOptions = (Array.isArray(line.extraIngredients) ? line.extraIngredients : []).map(e => ({
      name: e.name ?? e.ingredientName ?? 'Ek Malzeme',
      price_minor: minorUnits(e.price ?? 0),
    }));
    const removedIngredients = (Array.isArray(line.removedIngredients) ? line.removedIngredients : []).map(r =>
      typeof r === 'string' ? r : (r.name ?? r.ingredientName ?? '')
    ).filter(Boolean);

    return {
      name: line.name ?? line.productName ?? null,
      quantity: units.length || line.quantity || 1,
      cancelled_quantity: units.length ? units.filter(unit => unit.isCancelled === true).length : 0,
      unit_price_minor: minorUnits(line.unitSellingPrice ?? line.price),
      note: line.itemNote ?? line.note ?? null,
      options: [...modifierOptions, ...extraOptions],
      removed_ingredients: removedIngredients,
    };
  });

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
    fulfillment: deliveryModel,
    total_minor: minorUnits(order.totalPrice),
    currency: 'TRY',
    payment_method: order.payment?.paymentType ?? null,
    customer,
    address,
    courier,
    items,
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
        await request(`/integrator/order/meal/suppliers/${supplierId}/packages/picked`, {
          method: 'PUT',
          body: JSON.stringify({ packageId: String(id), preparationTime: params.preparationTime ?? 30 }),
        });
        return { id, status: 'accepted', action: 'accept', channel: 'tgo' };
      }

      if (action === 'ready') {
        await request(`/integrator/order/meal/suppliers/${supplierId}/packages/${id}/invoiced`, {
          method: 'PUT',
        });
        return { id, status: 'ready', action: 'ready', channel: 'tgo' };
      }

      if (action === 'dispatch') {
        await request(`/integrator/order/meal/suppliers/${supplierId}/packages/${id}/manual-shipped`, {
          method: 'PUT',
        });
        return { id, status: 'out_for_delivery', action: 'dispatch', channel: 'tgo' };
      }

      if (action === 'cancel') {
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

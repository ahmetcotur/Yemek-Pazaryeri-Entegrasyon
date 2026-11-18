import { ProviderError } from './errors.js';

const PROD_URL = 'https://partner.deliveryhero.io';
const SANDBOX_URL = 'https://sandbox.partner.deliveryhero.io';

const statuses = new Map([
  ['RECEIVED', 'new'],
  ['ACCEPTED', 'accepted'],
  ['PREPARING', 'accepted'],
  ['READY_FOR_PICKUP', 'ready'],
  ['DISPATCHED', 'out_for_delivery'],
  ['DELIVERED', 'delivered'],
  ['CANCELLED', 'cancelled'],
]);

const actionStatusMap = {
  accept: 'ACCEPTED',
  ready: 'READY_FOR_PICKUP',
  dispatch: 'DISPATCHED',
  deliver: 'DELIVERED',
  cancel: 'CANCELLED',
};

function minorUnits(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function normalize(order) {
  const id = order.id || order.orderId || order.token;
  if (!id) throw new ProviderError(502, 'invalid_provider_response');

  const rawStatus = order.status || order.orderStatus || 'RECEIVED';
  const status = statuses.get(rawStatus) ?? 'unknown';

  if (!statuses.has(rawStatus)) {
    console.warn(`[YEMEKSEPETI_DRIFT] Bilinmeyen sipariş durumu (status): "${rawStatus}" (sipariş ID: ${id})`);
  }

  const deliveryType = (order.delivery?.type === 'OWN_DELIVERY' || order.deliveryType === 'RESTAURANT') ? 'restaurant' : 'platform';

  const rawAddr = order.delivery?.address || order.address || {};
  const address = (rawAddr.street || rawAddr.formattedAddress || rawAddr.city) ? {
    full_address: rawAddr.street || rawAddr.formattedAddress || rawAddr.addressText || null,
    description: rawAddr.instructions || rawAddr.description || null,
    building_number: rawAddr.building || rawAddr.buildingNumber || null,
    floor: rawAddr.floor ? String(rawAddr.floor) : null,
    door_number: rawAddr.intercom || rawAddr.flat || rawAddr.doorNumber || null,
    district: rawAddr.district || null,
    city: rawAddr.city || null,
    latitude: rawAddr.latitude ?? rawAddr.coordinates?.lat ?? null,
    longitude: rawAddr.longitude ?? rawAddr.coordinates?.lng ?? null,
  } : null;

  const rawCustomer = order.customer || {};
  const customerName = rawCustomer.name || (rawCustomer.firstName ? `${rawCustomer.firstName} ${rawCustomer.lastName || ''}`.trim() : null);
  const customer = {
    name: customerName,
    phone: rawCustomer.phone || rawCustomer.mobile || rawAddr.phone || null,
    note: rawCustomer.instructions || order.delivery?.instructions || order.notes || null,
  };

  const rawRider = order.delivery?.rider || order.rider || {};
  const courier = {
    model: deliveryType,
    name: rawRider.name || null,
    phone: rawRider.phone || null,
    status: rawRider.status || null,
    is_nearby: rawRider.isNearby === true,
    eta_minutes: rawRider.eta ?? order.delivery?.eta ?? null,
    estimated_pickup_time: order.delivery?.estimatedPickupTime || null,
    tracking_url: order.delivery?.trackingUrl || null,
  };

  const items = (Array.isArray(order.items || order.products) ? (order.items || order.products) : []).map(item => {
    const options = (Array.isArray(item.modifiers || item.options) ? (item.modifiers || item.options) : []).map(opt => ({
      name: opt.name || opt.title || 'Ek Seçenek',
      price_minor: minorUnits(opt.price?.unit ?? opt.unitPrice ?? opt.price ?? 0),
    }));

    return {
      name: item.name || item.productName || 'Ürün',
      quantity: item.quantity || 1,
      cancelled_quantity: item.cancelledQuantity || 0,
      unit_price_minor: minorUnits(item.price?.unit || item.unitPrice || item.price || 0),
      note: item.customerInstruction || item.note || null,
      options,
      removed_ingredients: item.removedIngredients || [],
    };
  });

  const total = order.pricing?.total ?? order.price?.total ?? order.total ?? 0;

  return {
    id: String(id),
    channel: 'yemeksepeti',
    store_id: String(order.vendorId || order.storeId || ''),
    order_number: order.orderNumber ? String(order.orderNumber) : String(id),
    status,
    source_status: rawStatus,
    source_app: 'Yemeksepeti',
    source_channel: 'yemeksepeti',
    source_label: 'Yemeksepeti',
    fulfillment: deliveryType,
    total_minor: minorUnits(total),
    currency: order.pricing?.currency || order.currency || 'TRY',
    payment_method: order.payment?.method || order.paymentMethod || 'online',
    customer,
    address,
    courier,
    items,
  };
}

export function createYemeksepeti(env, fetcher = fetch) {
  if (env.FOOD_YS_ENABLED !== '1') return null;
  const { YS_CLIENT_ID, YS_CLIENT_SECRET, YS_CHAIN_ID, YS_VENDOR_ID, YS_ENV, YS_BASE_URL } = env;

  if (!YS_CLIENT_ID || !YS_CLIENT_SECRET || !YS_CHAIN_ID || !YS_VENDOR_ID) {
    throw new Error('Yemeksepeti requires YS_CLIENT_ID, YS_CLIENT_SECRET, YS_CHAIN_ID and YS_VENDOR_ID');
  }

  const baseUrl = YS_BASE_URL || (YS_ENV === 'prod' || YS_ENV === 'production' ? PROD_URL : SANDBOX_URL);

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
      return cachedToken;
    }
    const tokenUrl = new URL('/v1/oauth/token', baseUrl);
    let res;
    try {
      res = await fetcher(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: YS_CLIENT_ID,
          client_secret: YS_CLIENT_SECRET,
        }).toString(),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new ProviderError(502, 'provider_unreachable');
    }

    if (!res.ok) {
      throw new ProviderError(502, res.status === 401 || res.status === 403 ? 'provider_access_denied' : 'provider_request_failed');
    }

    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) * 1000);
    return cachedToken;
  }

  async function request(path, options = {}) {
    const token = await getAccessToken();
    const url = new URL(path, baseUrl);
    let response;
    try {
      response = await fetcher(url, {
        method: options.method || 'GET',
        signal: AbortSignal.timeout(8000),
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + token,
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
    environment: (YS_ENV === 'prod' || YS_ENV === 'production') ? 'prod' : 'sandbox',
    capabilities: ['list', 'read', 'accept', 'ready', 'dispatch', 'deliver', 'cancel'],

    async list(query) {
      const search = new URLSearchParams({
        page: String(query.page),
        limit: String(query.size),
      });
      const path = `/v2/chains/${YS_CHAIN_ID}/vendors/${YS_VENDOR_ID}/orders?` + search.toString();
      const res = await request(path);
      const list = Array.isArray(res) ? res : (res?.data || res?.orders || []);
      const data = list.map(normalize);
      return { data, page: query.page, size: query.size, has_more: data.length >= query.size };
    },

    async read(id) {
      const path = `/v2/chains/${YS_CHAIN_ID}/vendors/${YS_VENDOR_ID}/orders/${id}`;
      const res = await request(path);
      return normalize(res?.data || res);
    },

    async act(id, action) {
      const dhStatus = actionStatusMap[action];
      if (!dhStatus) throw new ProviderError(409, 'action_not_available');

      const path = `/v2/chains/${YS_CHAIN_ID}/vendors/${YS_VENDOR_ID}/orders/${id}/status`;
      await request(path, {
        method: 'PUT',
        body: JSON.stringify({ status: dhStatus }),
      });

      const mapped = statuses.get(dhStatus) || action;
      return { id, status: mapped, action, channel: 'yemeksepeti' };
    },

    normalize,
  };
}

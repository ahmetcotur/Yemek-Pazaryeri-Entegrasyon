import { createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const transitions = {
  new: { accept: 'accepted', cancel: 'cancelled' },
  accepted: { ready: 'ready', cancel: 'cancelled' },
  ready: { dispatch: 'out_for_delivery', cancel: 'cancelled' },
  out_for_delivery: { deliver: 'delivered' },
};

export function createStore(path, destination, secret, fetcher = fetch) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0);
  `);
  const get = id => {
    const row = db.prepare('SELECT body FROM orders WHERE id = ?').get(id);
    return row ? JSON.parse(row.body) : null;
  };

  function record(order, type) {
    const event = { id: randomUUID(), type, occurred_at: new Date().toISOString(), order };
    db.prepare('INSERT INTO orders VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body')
      .run(order.id, JSON.stringify(order));
    if (destination) db.prepare('INSERT INTO outbox (id, body) VALUES (?, ?)').run(event.id, JSON.stringify(event));
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  let active;
  function flush() {
    if (!destination || active) return active;
    active = (async () => {
      const batch = db.prepare('SELECT * FROM outbox WHERE due <= ? ORDER BY rowid LIMIT 20').all(Date.now());
      for (const event of batch) {
        try {
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = createHmac('sha256', secret).update(timestamp + '.' + event.body).digest('hex');
          const response = await fetcher(destination, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: {
              'content-type': 'application/json', 'x-food-event-id': event.id,
              'x-food-timestamp': timestamp, 'x-food-signature': 'sha256=' + signature,
            },
            body: event.body,
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error('Webhook receiver rejected event');
          db.prepare('DELETE FROM outbox WHERE id = ?').run(event.id);
        } catch {
          const next = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(event.attempts, 9));
          db.prepare('UPDATE outbox SET attempts = attempts + 1, due = ? WHERE id = ?').run(next, event.id);
        }
      }
    })().finally(() => { active = undefined; });
    return active;
  }

  return {
    get,
    list(page, size) {
      const rows = db.prepare('SELECT body FROM orders ORDER BY rowid DESC LIMIT ? OFFSET ?')
        .all(size + 1, page * size);
      return { data: rows.slice(0, size).map(row => JSON.parse(row.body)), page, size, has_more: rows.length > size };
    },
    create() {
      const order = {
        id: randomUUID(), channel: 'demo', store_id: 'demo-store', order_number: null,
        status: 'new', source_status: 'new', source_app: 'demo', source_channel: 'demo', source_label: 'Demo', fulfillment: 'restaurant',
        total_minor: 15500, currency: 'TRY', payment_method: 'online',
        items: [{ name: 'Demo Pide', quantity: 1, cancelled_quantity: 0, unit_price_minor: 15500 }],
      };
      transaction(() => record(order, 'order.created'));
      return order;
    },
    act(id, action) {
      return transaction(() => {
        const order = get(id);
        if (!order) return { code: 404, error: 'order_not_found' };
        const next = transitions[order.status]?.[action];
        if (!next) return { code: 409, error: 'action_not_available' };
        order.status = next;
        order.source_status = next;
        record(order, 'order.status_changed');
        return { code: 200, data: order };
      });
    },
    flush,
    async close() {
      await active;
      db.close();
    },
  };
}

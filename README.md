# Yemek Pazaryeri Entegrasyon

**Food Order API · v0.1.0 · MIT**

A self-hosted REST service for restaurant marketplace orders. A POS or restaurant
app such as MenumQR can use the same order contract across different providers.

| Provider | Current support |
| --- | --- |
| Demo | Generate an order, read it, accept it, mark it ready, dispatch, deliver or cancel. Optional outbound webhook delivery. |
| Uber Eats Trendyol Go – Meal | Experimental, read-only adapter for one store on Stage. Reads supported Trendyol, Trendyol Go, GetirYemek by Uber Eats and Uber Eats source values. |
| Yemeksepeti Restaurants and Migros Yemek | Planned, subject to current provider documentation and test access. |

## Marketplace coverage

The connection adapter is identified by `channel`. The application where the
customer placed the order is identified by `source_channel` and `source_label`.
The original provider value is retained in `source_app`.

| Connection | Original appName | source_channel | source_label |
| --- | --- | --- | --- |
| tgo | Trendyol | trendyol | Trendyol |
| tgo | TrendyolGo | trendyol_go | Uber Eats Trendyol Go |
| tgo | Galaxy | getir_yemek | GetirYemek by Uber Eats |
| tgo | UberEats | uber_eats | Uber Eats |
| tgo | Unrecognized or missing | unknown | null |
| demo | demo | demo | Demo |

A MenumQR or POS client can show **GetirYemek by Uber Eats** on an order while
using the TGO connection and package ID for API requests. Store external
references as the adapter and package ID pair. The source identifies the
ordering application and can be used in reports.

GetirYemek coverage through this adapter depends on the restaurant's migration
and provider access. Verify Galaxy and UberEats orders against the configured
Stage store before enabling a restaurant workflow. Legacy Getir credentials and
endpoints require a separately verified contract.

These source fields are additive. Existing clients can continue using
`channel` and `source_app`. Stored demo orders created by earlier versions may
lack the new fields. Clients should handle that case with a generic channel label.

Source mapping checked against the provider's package and migration documentation
on 19 November 2026.

- [TGO package source values](https://developers.tgoapps.com/docs/trendyol-go-yemek-entegrasyonu/siparis-entegrasyonu/ymk-siparis-paketlerini.cekme)
- [Uber Eats migration fields](https://developers.tgoapps.com/en/docs/uber-eats-migration/meal-uber-eats-migration-changes)

## Run locally

Use Node.js 24 or later. The service has no npm dependencies.

~~~sh
git clone https://github.com/ahmetcotur/Yemek-Pazaryeri-Entegrasyon.git
cd Yemek-Pazaryeri-Entegrasyon
cp .env.example .env
# Set FOOD_API_TOKEN in .env to a unique secret. Generate one with: openssl rand -hex 32
node --env-file=.env src/index.js
~~~

You can also run `docker compose up --build` after setting up the same environment file. The service binds to local port 3000 by default. SQLite data persists under `data/` locally or in the Compose volume.

~~~sh
TOKEN='replace-with-your-configured-token'
BASE=http://127.0.0.1:3000
curl -fsS "$BASE/health"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/providers"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/demo/orders"
~~~

Take the `id` from the order response and accept the order.

~~~sh
ORDER_ID='paste-order-id'
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/orders/demo/$ORDER_ID/actions/accept"
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/orders/demo?page=0&size=20"
~~~

See [openapi.yaml](openapi.yaml) for the HTTP contract. The API uses zero-based
pagination, explicit provider names and amounts in minor currency units.
Order identifiers are scoped by provider.

## Optional demo webhooks

Set `FOOD_WEBHOOK_URL` and `FOOD_WEBHOOK_SECRET` in the server configuration and
restart before creating a demo order. When running inside Docker, use a receiver
address reachable from the container.

The receiver gets `order.created` and `order.status_changed` JSON events. Use
`X-Food-Event-Id` to deduplicate deliveries. Verify that `X-Food-Timestamp` is
recent and compare `X-Food-Signature` in constant time. The signature is
`sha256=` followed by the hex HMAC-SHA256 of the timestamp, a period and the raw
HTTP body, using the configured webhook secret. Return a 2xx response after
durably recording the event. Failed deliveries retry with increasing delays.
Deliveries can be repeated or arrive out of order. Fetch current order state when
a workflow depends on the latest status.

## Connect one TGO Stage store

Request Stage API access for your server and obtain test credentials from the
provider. Set `FOOD_TGO_ENABLED=1`, then set the six `TGO_*` variables from the
example environment file. `TGO_AGENT_NAME` is the authorized integration name,
and `TGO_EXECUTOR_USER` is the email to send in the executor header. Call
`GET /v1/orders/tgo` or `GET /v1/orders/tgo/{packageId}`. Use the package ID returned by the API.

The adapter calls the official Stage Meal package API and scopes reads to the
configured store. Contact/address details and raw provider payloads are omitted
in this release. Product options, incoming TGO webhooks and TGO status writes
are future work. The mock upstream test exercises the documented API request
shape and normalization. A real Stage account is needed for end-to-end verification.

- [TGO Meal package listing and detail](https://developers.tgoapps.com/docs/trendyol-go-yemek-entegrasyonu/siparis-entegrasyonu/ymk-siparis-paketlerini.cekme)
- [TGO authorization](https://developers.tgoapps.com/docs/authorization)
- [TGO Stage access](https://developers.tgoapps.com/docs/canli-test-ortam-bilgileri)

## Integrating MenumQR or another POS

Use the service token from your application's server, then list/demo or read TGO
orders. Store an external reference as the provider and order ID pair. A production
SaaS deployment will need per-tenant tokens, per-connection credentials, branch
mapping, provider status commands and provider webhook intake.

This release is a single-instance sandbox. Run one server process per SQLite
database. Its bearer token grants access to the whole instance. Keep credentials in
environment configuration, and use HTTPS if you expose the service outside localhost.

## Development

Run `npm test`. Tests cover the demo lifecycle, webhook signature and retry, and
the TGO Stage read contract with synthetic data. See [LICENSE](LICENSE) for licensing.

## Roadmap

- Verify TGO reads, including Galaxy and UberEats source orders, against a real Stage store, then implement supported order actions and incoming webhooks.
- Add tenant authentication, encrypted connection credentials and branch mapping for SaaS deployments.
- Prioritize Yemeksepeti Restaurant, followed by Migros Yemek, once current contracts and test access are available.
- Evaluate Fuudy integration when restaurant demand and a supported integration contract are available.

## Contributing

Open an issue describing a reproducible problem or proposed provider capability.
For a pull request, include the provider documentation reference when applicable,
synthetic examples and the relevant test results. Run `npm test` before submitting.

## License

Copyright (c) 2026 Ahmet Can Çötür and contributors. Distributed under the
[MIT License](LICENSE). The project is independently maintained. Provider access
and credentials are obtained from each marketplace.

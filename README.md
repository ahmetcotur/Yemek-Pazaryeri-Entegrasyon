# Yemek Pazaryeri Entegrasyon

**Food Order API · v0.2.0 · MIT**

Restoran pazaryeri siparişleri için ortak ve hafif self-hosted REST API servisi. MenumQR veya herhangi bir POS / restoran uygulaması, tüm pazaryerleri için tek bir standart sipariş sözleşmesi kullanabilir.

| Sağlayıcı / Adaptör | Desteklenen Kapsam & Gerçek API Altyapısı |
| --- | --- |
| **Demo** | Sipariş oluşturma, okuma, kabul (`accept`), hazır (`ready`), yola çıkış (`dispatch`), teslim (`deliver`), iptal (`cancel`) ve HMAC-SHA256 imzalı outbox webhook iletimi. |
| **Uber Eats Trendyol Go (TGO)** | **Stage & Prod** Meal API (`https://api.tgoapis.com` & `https://stageapi.tgoapis.com`). Sipariş listeleme, paket detayı, hazırlık süreli sipariş kabul (`picked`), hazır bildirme (`invoiced`), kurye teslimi (`manual-shipped`) ve iptal (`unsupplied`). |
| **Yemeksepeti (Delivery Hero)** | **Delivery Hero Partner API** (`https://partner.deliveryhero.io` & Sandbox). OAuth 2.0 (Client Credentials), sipariş çekme ve durum güncelleme (`ACCEPTED`, `READY_FOR_PICKUP`, `DISPATCHED`, `DELIVERED`, `CANCELLED`). |
| **GetirYemek** | **Getir Food API** (`https://food-external-api-gateway.getirapi.com` & Dev). API Key + Token yetkilendirmesi, sipariş çekme ve yaşam döngüsü aksiyonları (`verify`, `prepare`, `handover`, `deliver`, `cancel`). Ayrıca TGO Galaxy kanalı desteği. |
| **Migros Yemek** | **Migros One Restoran API** (`https://yemek-api.migrosone.com` & Test). `XApiKey` ile sipariş çekme ve `UpdateOrderStatus` durum yönetimi (`APPROVED`, `READY`, `SHIPPED`, `DELIVERED`, `REJECTED`). |

---

## Pazaryeri ve Kaynak Kapsamı

Entegrasyon adaptörü `channel` ile, müşterinin siparişi verdiği gerçek uygulama ise `source_channel` ve `source_label` ile tanımlanır. Orijinal sağlayıcı değeri `source_app` alanında saklanır.

| Kanal (Adapter) | Orijinal Sağlayıcı Değeri | source_channel | source_label |
| --- | --- | --- | --- |
| **tgo** | Trendyol | `trendyol` | Trendyol |
| **tgo** | TrendyolGo | `trendyol_go` | Uber Eats Trendyol Go |
| **tgo** | Galaxy | `getir_yemek` | GetirYemek by Uber Eats |
| **tgo** | UberEats | `uber_eats` | Uber Eats |
| **yemeksepeti** | Yemeksepeti | `yemeksepeti` | Yemeksepeti |
| **getir** | GetirYemek | `getir_yemek` | GetirYemek |
| **migros** | MigrosYemek | `migros_yemek` | Migros Yemek |
| **demo** | demo | `demo` | Demo |

---

## Gerçek API Uç Noktaları ve Özellikler

### Ortak Sipariş Modeli ve Durum Eşleşmesi

| Ortak Statü | Açıklama | TGO Karşılığı | Delivery Hero | Getir Food | Migros Yemek |
| --- | --- | --- | --- | --- | --- |
| `new` | Yeni Sipariş | `Created` | `RECEIVED` | `100` / `NEW` | `NEW` / `1` |
| `accepted` | Onaylandı / Hazırlanıyor | `Picking` | `ACCEPTED` / `PREPARING` | `200` / `VERIFIED` | `APPROVED` / `2` |
| `ready` | Paket Hazır | `Invoiced` | `READY_FOR_PICKUP` | `300` / `PREPARED` | `READY` / `3` |
| `out_for_delivery` | Yolda / Kuryede | `Shipped` | `DISPATCHED` | `400` / `HANDOVER` | `SHIPPED` / `4` |
| `delivered` | Teslim Edildi | `Delivered` | `DELIVERED` | `500` / `DELIVERED` | `DELIVERED` / `5` |
| `cancelled` | İptal Edildi | `Cancelled` / `UnSupplied` | `CANCELLED` | `600` / `900` | `REJECTED` / `6` |

### Sipariş Aksiyonları (`POST /v1/orders/{provider}/{id}/actions/{action}`)
- `accept`: Siparişi onayla (TGO için opsiyonel `preparationTime` iletilir).
- `ready`: Siparişin mutfakta hazırlandığını bildir.
- `dispatch`: Restoran veya platform kuryesine teslim et.
- `deliver`: Siparişi teslim edildi olarak tamamla.
- `cancel`: Siparişi iptal et (TGO için opsiyonel `itemIdList` ve `reasonId` iletilir).

### Gelen Pazaryeri Webhook'ları (`POST /v1/webhooks/{provider}`)
Pazaryerlerinin (Getir, Yemeksepeti, Migros, TGO) gerçek zamanlı sipariş bildirimleri bu uç noktaya düşer, standart formata dönüştürülerek SQLite veritabanına ve POS outbox kuyruğuna yazılır.

### Kurye, Paket Servisi ve Müşteri Detayları
Ortak sipariş modelinde MenumQR gibi POS ve KDS sistemlerinin ihtiyaç duyduğu tüm detaylar yer alır:
- **`customer`**: Müşteri adı, telefonu ve sipariş özel notu (`customerNote`).
- **`address`**: Açık teslimat adresi (`full_address`), tarif (`description`), bina/kat/kapı no ve harita koordinatları (`latitude`, `longitude`).
- **`courier`**: Kurye modeli (`platform` veya `restaurant`), kurye adı/telefonu, tahmini varış süresi (`eta_minutes`) ve mutfak uyarısı için `is_nearby: true` bayrağı.
- **`items.options` & `removed_ingredients`**: Ürün seçenekleri (sos, içecek vb.) ve çıkarılan malzemeler ("Soğansız" vb.).

### Versiyon ve Şema Kayması İzleme (Drift Detection)
Pazaryerleri yeni bir `appName`, yeni bir statü veya yeni bir ödeme türü eklediğinde sistem bunu sessizce yutmak yerine konsola ve telemetriye anında `[PROVIDER_DRIFT]` uyarısı kaydeder.

---

## API Dokümantasyon Kaynakları ve Güncellik Takibi

Tüm pazaryerlerinin resmi geliştirici portalları, API referans adresleri, duyuru sayfaları ve sürüm takip yöntemleri için [API_SOURCES_AND_CHANGELOG.md](API_SOURCES_AND_CHANGELOG.md) dokümanını inceleyin:
- **Uber Eats Trendyol Go:** [developers.tgoapps.com](https://developers.tgoapps.com/)
- **Yemeksepeti / Delivery Hero:** [partner.deliveryhero.io](https://partner.deliveryhero.io/)
- **GetirYemek:** [developers.getir.com](https://developers.getir.com/)
- **Migros Yemek:** Migros One Restoran Portalı / [test-yemek-api.migrosone.com](https://test-yemek-api.migrosone.com/)

---

## Kurulum ve Çalıştırma

Node.js 22 veya 24+ kullanın. Harici hiçbir npm bağımlılığı gerektirmez (`zero dependencies`).

```sh
git clone https://github.com/ahmetcotur/Yemek-Pazaryeri-Entegrasyon.git
cd Yemek-Pazaryeri-Entegrasyon
cp .env.example .env

# FOOD_API_TOKEN için en az 24 karakterli rastgele anahtar belirleyin:
# openssl rand -hex 32

# Servisi başlatın:
node --env-file=.env src/index.js
```

### Testleri Çalıştırma
```sh
node --test
```
Tüm sağlayıcı mock ve akış testleri (10/10) başarıyla çalışır.

---

## Arayüz ve API Konsolu

Servis başlatıldıktan sonra tarayıcınızda `http://127.0.0.1:3000` adresini açarak:
- Türkçe SaaS paneli ve genel bakış metriklerini inceleyebilir,
- **API anahtarları** ekranından `FOOD_API_TOKEN` ile canlı sunucuya bağlanabilir,
- Demo veya aktif pazaryeri siparişlerini görüntüleyebilir ve aksiyonları yönetebilirsiniz.

---

## Lisans

MIT Lisansı © 2026 Ahmet Can Çötür ve katkıda bulunanlar.

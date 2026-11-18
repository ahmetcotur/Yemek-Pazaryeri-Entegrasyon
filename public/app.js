const root = document.querySelector('#root');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
const formatMoney = value => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value / 100);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const platforms = {
  tgo: { name: 'Uber Eats Trendyol Go', logo: 'UE', style: 'tgo', status: 'Stage / Prod · Tam Yönetim' },
  getir: { name: 'GetirYemek Partner', logo: 'g', style: 'getir', status: 'Doğrudan API / TGO' },
  ys: { name: 'Yemeksepeti Partner', logo: 'ys', style: 'ys', status: 'Delivery Hero API' },
  migros: { name: 'Migros Yemek Restoran', logo: 'm', style: 'migros', status: 'Migros One API' },
};
const statusText = { new: 'Yeni sipariş', accepted: 'Hazırlanıyor', ready: 'Hazır', out_for_delivery: 'Yolda', delivered: 'Teslim edildi', cancelled: 'İptal edildi', unknown: 'Bilinmiyor' };
const statusStyle = { new: 'orange', accepted: 'purple', ready: 'blue', out_for_delivery: 'blue', delivered: 'green', cancelled: 'red' };
const steps = { new: ['accept', 'Kabul et'], accepted: ['ready', 'Hazır işaretle'], ready: ['dispatch', 'Kuryeye ver'], out_for_delivery: ['deliver', 'Teslim edildi'] };
const names = { overview: 'Genel bakış', orders: 'Siparişler', integrations: 'Pazaryerleri', keys: 'API anahtarları', webhooks: 'Webhook', usage: 'Kullanım', plans: 'Paketler', docs: 'Dokümantasyon' };
const state = {
  token: '', connected: false, providers: [], orders: [], filter: 'all', search: '', period: 'week', plan: 'Geliştirici',
  demoKey: '', webhook: '', attempts: [], sampleConnections: new Set(), activeChannel: 'demo',
};
function seedOrders() {
  const examples = [
    ['8472', 'tgo', 'new', 48500, '2 ürün', '12:48'],
    ['8471', 'getir', 'accepted', 32000, '3 ürün', '12:45'],
    ['8470', 'ys', 'delivered', 67500, '4 ürün', '12:42'],
    ['8469', 'tgo', 'ready', 29000, '2 ürün', '12:39'],
    ['8468', 'migros', 'delivered', 54000, '3 ürün', '12:35'],
    ['8467', 'getir', 'out_for_delivery', 41000, '2 ürün', '12:31'],
  ];
  return examples.map(([id, source, status, total_minor, description, time]) => ({
    id, channel: 'demo', source, status, total_minor, description, time, store_id: 'demo-store',
    items: [{ name: 'Demo menü', quantity: 1, unit_price_minor: total_minor }],
  }));
}
state.orders = seedOrders();

function toast(text) {
  const target = document.querySelector('#toast');
  target.textContent = text;
  target.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove('show'), 3500);
}
function logo(key) {
  const p = platforms[key] ?? { logo: 'D', style: 'tgo' };
  return '<span class="platform-logo ' + p.style + '">' + p.logo + '</span>';
}
function badge(status) {
  return '<span class="pill ' + (statusStyle[status] ?? '') + '"><span class="dot"></span>' + escapeHtml(statusText[status] ?? status) + '</span>';
}
function orderPlatform(order) {
  if (order.source) return platforms[order.source]?.name ?? 'Demo';
  return order.source_label ?? order.source_app ?? (order.channel === 'tgo' ? 'TGO' : 'Demo');
}
function orderLogo(order) {
  if (order.source) return logo(order.source);
  if (order.channel === 'demo') return logo('demo');
  return logo(order.source_channel === 'getir_yemek' ? 'getir' : 'tgo');
}
function showModal(title, body) {
  modalContent.innerHTML = '<div class="modal-top"><h2>' + escapeHtml(title) + '</h2><button class="close" data-action="close" aria-label="Pencereyi kapat">×</button></div>' + body;
  if (!modal.open) modal.showModal();
}
function code(value) {
  return '<pre class="code-block">' + escapeHtml(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '</pre>';
}
function route() {
  return location.hash.replace('#', '') || 'home';
}
function banner() {
  return state.connected
    ? '<div class="demo-banner"><span class="dot"></span> Kendi API sunucuna bağlısın. Gösterilen siparişler seçili API kanalından okunur.</div>'
    : '<div class="demo-banner"><span>◉</span> Demo çalışma alanı · Siparişler, metrikler ve bağlantı durumları örnektir. <a href="#keys">Kendi API’ne bağlan ↗</a></div>';
}
function heading(title, description, action = '') {
  return '<div class="page-heading"><div><h1>' + title + '</h1><p>' + description + '</p></div>' + action + '</div>';
}
function landing() {
  root.innerHTML = '<div class="landing">' +
    '<nav class="landing-nav"><a href="#home" class="brand"><span class="brand-mark">››</span>Paket API</a><div class="landing-links"><a href="#features">Nasıl çalışır?</a><a href="#plans">Paketler</a><a href="#docs">Geliştiriciler</a><a class="btn primary" href="#overview">Demoyu aç <span>↗</span></a></div></nav>' +
    '<main><section class="hero"><div><span class="hero-label"><span class="dot"></span> Açık kaynak · Kendi sunucunda çalıştır</span><h1>Tüm siparişler.<br>Tek bağlantı.<br><span>Senin yazılımın.</span></h1><p>Yemek pazaryerlerini POS’una, restoran uygulamana veya SaaS ürününe ortak bir API ile bağla.</p><div class="hero-buttons"><a class="btn primary" href="#overview">Paneli keşfet <span>↗</span></a><a class="btn" href="#docs">API’yi incele <span>⌘</span></a></div><div class="hero-note">Anahtar gerektirmeyen demo · MIT lisansı</div></div>' +
    '<div class="hero-code"><div class="code-top"><div class="window-dots"><i></i><i></i><i></i></div><span>İstek → ortak sipariş modeli</span><span>⌘</span></div><pre><span class="code-muted">// Sipariş kaynağı değişir. API deneyimi aynı.</span>\n<span class="code-green">GET</span> /v1/orders/tgo\nAuthorization: Bearer YOUR_API_TOKEN\n\n{\n  <span class="code-yellow">"channel"</span>: <span class="code-green">"tgo"</span>,\n  <span class="code-yellow">"source_label"</span>: <span class="code-green">"GetirYemek by Uber Eats"</span>,\n  <span class="code-yellow">"status"</span>: <span class="code-green">"ready"</span>,\n  <span class="code-yellow">"total_minor"</span>: 48500,\n  <span class="code-yellow">"currency"</span>: <span class="code-green">"TRY"</span>\n}</pre><div class="code-result"><span>✓ Ortak veri modeli</span><span>Örnek yanıt</span></div></div></section>' +
    '<section class="platform-strip"><p>Entegrasyon yol haritası</p><div class="platform-names"><span>Uber Eats<small>TGO Stage · okuma adaptörü</small></span><span>getir<span class="muted">yemek</span><small>TGO kaynak ayrımı</small></span><span>yemeksepeti<small>Planlanıyor</small></span><span>Migros Yemek<small>Planlanıyor</small></span></div></section>' +
    '<section class="landing-section"><span class="eyebrow muted">Geliştiriciler için tasarlandı</span><h2>Pazaryeri bağlantısından<br>ürün deneyimine.</h2><p class="section-copy">Tekrarlayan entegrasyon işlerini ortak bir katmanda topla. Kendi uygulamanın sipariş deneyimine odaklan.</p><div class="feature-grid">' +
    [['⇄', 'Tek sipariş sözleşmesi', 'Kaynak uygulama, ödeme ve teslimat bilgilerini standart alanlarla işle.'], ['⌘', 'Çalışan demo akışı', 'Sipariş oluştur, kabul et, hazırlık ve teslim aşamalarını kendi API’nle dene.'], ['↗', 'Açık ve taşınabilir', 'Node.js ve Docker ile kendi sunucunda çalıştır. Kodu MIT lisansıyla ürününe dahil et.']].map(([icon, title, text]) => '<article class="feature card"><span class="feature-symbol">' + icon + '</span><h3>' + title + '</h3><p>' + text + '</p></article>').join('') +
    '</div></section><section class="landing-section"><div class="cta"><div><h2>Bir sonraki entegrasyonun<br>buradan başlasın.</h2><p>Örnek siparişlerle paneli hemen deneyimle.</p></div><a href="#overview" class="btn lime">Demo çalışma alanına geç ↗</a></div></section></main>' +
    '<footer class="landing-footer"><span>© ' + new Date().getFullYear() + ' Paket API · Ahmet Can Çötür</span><a href="https://github.com/ahmetcotur/Yemek-Pazaryeri-Entegrasyon" target="_blank" rel="noopener">GitHub ↗</a></footer></div>';
}
function shell(page) {
  const nav = [
    ['overview', '◫'], ['orders', '▤'], ['integrations', '⊞'], ['keys', '⚿'], ['webhooks', '⇄'], ['usage', '▥'],
  ];
  root.innerHTML = '<div class="app-shell"><aside class="sidebar" id="sidebar"><a class="brand" href="#home"><span class="brand-mark">››</span>Paket API</a>' +
    '<div class="workspace"><span class="workspace-icon">M</span><div><strong>MenumQR</strong><small>Demo çalışma alanı</small></div><span class="grow"></span><span>⌄</span></div><div class="nav-section">ÇALIŞMA ALANI</div>' +
    nav.map(([key, icon]) => '<a class="nav-item ' + (key === page ? 'active' : '') + '" href="#' + key + '"><span class="nav-icon">' + icon + '</span>' + names[key] + (key === 'orders' ? '<span class="nav-counter">' + state.orders.filter(o => o.status === 'new').length + '</span>' : '') + '</a>').join('') +
    '<div class="sidebar-divider"></div><a class="nav-item ' + (page === 'docs' ? 'active' : '') + '" href="#docs"><span class="nav-icon">⌘</span>Dokümantasyon</a><a class="nav-item ' + (page === 'plans' ? 'active' : '') + '" href="#plans"><span class="nav-icon">◇</span>Paketler</a>' +
    '<div class="sidebar-bottom"><div class="upgrade"><strong>Birlikte daha fazlasını bağlayalım.</strong><p>API hizmetini ürününe uygun bir paketle sun.</p><a class="btn lime" href="#plans">Paketleri incele ↗</a></div><div class="profile"><span class="avatar">AC</span><div><strong>Ahmet Çötür</strong><br><small>Demo yöneticisi</small></div></div></div></aside>' +
    '<div class="app-main"><header class="topbar"><div class="row"><button class="mobile-toggle" data-action="menu" aria-label="Menüyü aç">☰</button><span class="breadcrumb">Çalışma alanı <span class="muted"> / </span> <strong>' + names[page] + '</strong></span></div><div class="top-actions"><span class="pill ' + (state.connected ? 'green' : '') + '"><span class="dot"></span>' + (state.connected ? 'API bağlı' : 'Demo modu') + '</span><a href="#docs">Geliştirici rehberi ↗</a><a href="#keys" class="avatar" aria-label="API bağlantı ayarları">M</a></div></header>' +
    '<main class="content" id="page"></main></div></div>';
  const views = { overview, orders, integrations, keys, webhooks, usage, plans, docs };
  document.querySelector('#page').innerHTML = views[page]() +
    '<footer class="page-footer"><span>Paket API · ' + (state.connected ? 'Bağlı çalışma alanı' : 'Demo çalışma alanı') + '</span><span><a href="#docs">API dokümanı</a><a href="https://github.com/ahmetcotur/Yemek-Pazaryeri-Entegrasyon" target="_blank" rel="noopener">GitHub ↗</a></span></footer>';
}
function stats() {
  if (state.connected) {
    const total = state.orders.reduce((sum, o) => sum + (o.total_minor ?? 0), 0);
    return statCards([
      ['Bu sayfadaki sipariş', String(state.orders.length), 'Seçili kanalın ilk 50 kaydı', '▤'],
      ['Sipariş tutarı', formatMoney(total), 'Listelenen siparişlerin toplamı', '₺'],
      ['Aktif sipariş', String(state.orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length), 'Yeni, hazırlanan ve yoldaki', '↗'],
      ['Kanal', state.activeChannel === 'demo' ? 'Demo' : 'TGO', 'Sunucudan alınan veriler', '⊞'],
    ]);
  }
  return statCards([
    ['Toplam sipariş', '1.284', '+%12,8', '▤'],
    ['Sipariş hacmi', '₺186.450', '+%8,2', '₺'],
    ['API başarı oranı', '%99,8', 'Örnek hizmet metriği', '↗'],
    ['Bağlantı kapsamı', 'TGO + Getir', '2 sipariş kaynağı · tek adaptör', '⊞'],
  ]);
}
function statCards(items) {
  return '<div class="stats">' + items.map(([label, value, text, icon]) =>
    '<div class="card stat"><div class="stat-label"><span>' + label + '</span><span class="stat-icon">' + icon + '</span></div><div class="stat-value">' + escapeHtml(value) + '</div><div class="stat-bottom">' + (text.startsWith('+') ? '<strong>' + text + ' ↗</strong> önceki döneme göre' : escapeHtml(text)) + '</div></div>').join('') + '</div>';
}
function chart() {
  const heights = state.period === 'week' ? [40, 58, 45, 75, 58, 90, 70] : [70, 45, 82, 60, 91, 66, 95];
  return '<div class="card"><div class="card-head"><h3>Sipariş akışı</h3><select id="period" aria-label="Grafik dönemi" class="btn small"><option value="week"' + (state.period === 'week' ? ' selected' : '') + '>Son 7 gün</option><option value="month"' + (state.period === 'month' ? ' selected' : '') + '>Aylık örnek</option></select></div><div class="chart-legend"><span><i class="chart-key"></i>Siparişler</span><span><i class="chart-key light"></i>Önceki dönem</span></div>' +
    '<div class="chart"><div class="axis-y"><span>300</span><span>200</span><span>100</span><span>0</span></div><div class="plot">' +
    heights.map((height, i) => '<div class="bar-group"><div class="bar light" style="--h:' + (height - 15) + '%"></div><div class="bar" style="--h:' + height + '%"></div><span class="bar-label">' + ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'][i] + '</span></div>').join('') +
    '</div></div><div class="chart-footer"><span>Örnek veri · API’den ölçülmedi</span><span>En yoğun gün: Cumartesi ↗</span></div></div>';
}
function connectionSummary() {
  return '<div class="card"><div class="card-head"><h3>Pazaryeri bağlantıları</h3><span class="muted">⊞</span></div><div class="connections-list">' +
    Object.entries(platforms).map(([key, p]) => '<div class="connection-item">' + logo(key) + '<div class="grow"><strong>' + p.name + '</strong><small>' + (key === 'getir' ? 'Aynı TGO adaptörü' : key === 'tgo' ? 'Test ortamı · sipariş okuma' : 'Entegrasyon yol haritası') + '</small></div><span class="pill ' + (['tgo', 'getir'].includes(key) ? 'green' : '') + '">' + (key === 'tgo' ? 'Stage' : key === 'getir' ? 'TGO' : 'Yakında') + '</span></div>').join('') +
    '</div><a class="connect-link" href="#integrations">Bağlantıları yönet ↗</a></div>';
}
function overview() {
  return heading('Her sipariş, tek bir yerde.', 'Pazaryeri bağlantılarını ve sipariş akışını buradan takip et.',
    '<button class="btn primary" data-action="create">＋ Demo siparişi oluştur</button>') + banner() + stats() +
    (state.connected ? '<div class="api-notice hint">Bağlı modda metrikler, aşağıda listelenen API siparişlerinden hesaplanır.</div>' : '<div class="overview-grid">' + chart() + connectionSummary() + '</div>') +
    '<section class="card"><div class="card-head"><h3>Son siparişler</h3><a class="link-btn" href="#orders">Tümünü gör ↗</a></div>' + orderTable(state.orders.slice(0, 5)) + '</section>';
}
function orderTable(list) {
  if (!list.length) return '<div class="empty">Bu görünümde sipariş yok. Demo siparişi oluşturarak başla.</div>';
  return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Sipariş</th><th>Pazaryeri</th><th>Durum</th><th>Tutar</th><th>Zaman</th><th></th></tr></thead><tbody>' +
    list.map(o => '<tr><td><div class="order-number">#' + escapeHtml(o.order_number ?? o.id.slice(0, 8)) + '</div><div class="cell-sub">' + escapeHtml(o.description ?? (o.items?.length ?? 0) + ' kalem') + '</div></td><td><div class="row">' + orderLogo(o) + '<span>' + escapeHtml(orderPlatform(o)) + '</span></div></td><td>' + badge(o.status) + '</td><td><strong>' + escapeHtml(o.total_minor == null ? '—' : formatMoney(o.total_minor)) + '</strong></td><td class="muted">' + escapeHtml(o.time ?? 'API kaydı') + '</td><td><button class="link-btn" data-order="' + escapeHtml(o.id) + '">Detay ↗</button></td></tr>').join('') + '</tbody></table></div>';
}
function orders() {
  const filtered = state.orders.filter(o => (state.filter === 'all' || o.status === state.filter) &&
    (String(o.order_number ?? o.id) + ' ' + orderPlatform(o)).toLocaleLowerCase('tr').includes(state.search.toLocaleLowerCase('tr')));
  return heading('Siparişler', 'Kaynağı gör, sipariş detayını aç ve demo akışını yönet.',
    '<div class="row">' + (state.connected ? '<button class="btn" data-action="refresh">↻ Yenile</button>' : '') +
    '<button class="btn primary" data-action="create">＋ Yeni demo siparişi</button></div>') + banner() +
    '<section class="card" style="margin-top:22px"><div class="card-head"><h3>' + filtered.length + ' sipariş</h3><input id="search" class="search" placeholder="Sipariş veya pazaryeri ara" aria-label="Sipariş ara" value="' + escapeHtml(state.search) + '"></div><div class="filters">' +
    [['all', 'Tümü'], ['new', 'Yeni'], ['accepted', 'Hazırlanıyor'], ['ready', 'Hazır'], ['delivered', 'Teslim edildi']].map(([id, title]) => '<button class="filter ' + (state.filter === id ? 'active' : '') + '" data-filter="' + id + '">' + title + '</button>').join('') +
    '</div>' + orderTable(filtered) + '</section>';
}
function integrations() {
  return heading('Pazaryeri bağlantıları', 'Tek adaptör üzerinden sipariş kaynaklarını ürününe bağla.') + banner() +
    '<div class="integration-grid" style="margin-top:22px">' + Object.entries(platforms).map(([key, p]) => {
      const text = {
        tgo: 'API anahtarlarını sunucunun ortam değişkenlerine girerek bir TGO Stage şubesinin siparişlerini oku.',
        getir: 'Galaxy kaynaklı siparişler, geçişi ve erişimi uygun restoranlarda TGO bağlantısı üzerinden tanınır.',
        ys: 'Restoran POS dokümanı ve test erişimi doğrulandıktan sonra ayrı sağlayıcı adaptörü eklenecek.',
        migros: 'POS firma kaydı, güncel teknik sözleşme ve test ortamı doğrulamasının ardından geliştirilecek.',
      };
      return '<article class="card integration-card"><div class="row between"><div class="row">' + logo(key) + '<div><h3>' + p.name + '</h3><small>' + p.status + '</small></div></div><span class="pill ' + (key === 'tgo' ? 'green' : '') + '">' + (key === 'tgo' ? 'Deneysel' : key === 'getir' ? 'Kaynak eşleme' : 'Planlanan') + '</span></div><p>' + text[key] + '</p><div class="integration-bottom"><small>' + (state.sampleConnections.has(key) ? 'Demo yapılandırması kaydedildi' : 'Bağlantı ve yetki şubeye göre değişir') + '</small><button class="btn small" data-integration="' + key + '">' + (['ys', 'migros'].includes(key) ? 'Kapsamı gör' : 'Yapılandır') + ' ↗</button></div></article>';
    }).join('') + '</div>';
}
function keys() {
  return heading('API anahtarları', 'Paneli çalışan servisine bağla veya anahtar deneyimini demo olarak incele.') + banner() +
    '<div class="detail-grid" style="margin-top:22px"><section class="card padded"><h3>Sunucu bağlantısı</h3><p>Aynı adreste çalışan API’nin FOOD_API_TOKEN değerini kullan. Anahtar yalnızca bu sekmenin belleğinde tutulur.</p><form id="connect-form"><label for="api-token">API erişim anahtarı</label><input id="api-token" type="password" autocomplete="off" placeholder="Sunucundaki FOOD_API_TOKEN" required minlength="24"><label for="api-channel">Sipariş kanalı</label><select id="api-channel"><option value="demo">Demo siparişleri</option><option value="tgo">Uber Eats Trendyol Go</option><option value="yemeksepeti">Yemeksepeti (Delivery Hero)</option><option value="getir">GetirYemek Partner</option><option value="migros">Migros Yemek Restoran</option></select><div class="modal-actions">' + (state.connected ? '<button type="button" class="btn" data-action="disconnect">Bağlantıyı kes</button>' : '') + '<button class="btn primary" type="submit">Bağlantıyı doğrula ↗</button></div></form><p id="connection-result" class="hint" role="status"></p></section>' +
    '<section class="card padded"><div class="row between"><h3>Örnek geliştirici anahtarı</h3><span class="pill">Demo</span></div><p>SaaS müşterisinin kendi erişim anahtarını oluşturacağı ekranın önizlemesi.</p><div class="key-row"><div><code>' + escapeHtml(state.demoKey || 'pk_demo_••••••••••••••••') + '</code><div class="cell-sub">Çalışan API’de geçerli değildir</div></div></div><div class="modal-actions"><button class="btn" data-action="copy-key">Kopyala</button><button class="btn primary" data-action="generate-key">Demo anahtar oluştur</button></div><p class="hint">Müşteri bazlı anahtar üretimi ve iptali, çok kiracılı SaaS backend aşamasında eklenecek.</p></section></div>';
}
function webhooks() {
  return heading('Webhook', 'Sipariş olaylarını uygulamana gönderen deneyimi incele.') + banner() +
    '<div class="detail-grid" style="margin-top:22px"><section class="card padded"><div class="row between"><h3>Olay hedefi</h3><span class="pill">Önizleme</span></div><p>Çalışan servis FOOD_WEBHOOK_URL ve FOOD_WEBHOOK_SECRET ile yapılandırılır. Bu form, panel deneyimini sekme içinde gösterir.</p><form id="webhook-form"><label for="webhook-url">Hedef URL</label><input id="webhook-url" type="url" placeholder="https://uygulaman.com/webhooks/orders" value="' + escapeHtml(state.webhook) + '" required><label>Olaylar</label><div class="endpoint"><b>POST</b><code>order.created</code></div><div class="endpoint"><b>POST</b><code>order.status_changed</code></div><div class="modal-actions"><button class="btn primary">Demo hedefini kaydet</button></div></form><button class="link-btn" data-action="webhook-test">Örnek olay teslimini göster ↗</button><p class="hint">Bu önizleme dış adrese HTTP isteği göndermez.</p></section><section class="card padded"><h3>Teslimat geçmişi</h3>' +
    (state.attempts.length ? state.attempts.map((a, i) => '<div class="key-row"><div><strong class="mono" style="font-size:11px">' + escapeHtml(a.type) + '</strong><div class="cell-sub">Demo olayı #' + (i + 1) + ' · ' + escapeHtml(a.time) + '</div></div><span class="pill green">Simülasyon · 200</span></div>').join('') : '<div class="empty">Örnek bir olay oluşturduğunda burada görünür.</div>') +
    '<p class="hint">Gerçek demo API, imzalı olayları kalıcı kuyruktan gönderir ve başarısız teslimatları yeniden dener.</p></section></div>';
}
function usage() {
  return heading('Kullanım', 'Demo trafik dağılımı ve plan kapasitesi.') + '<div class="demo-banner">Örnek metrikler · Bu ekran sunucu telemetrisiyle henüz bağlantılı değildir.</div>' +
    statCards([['Aylık API isteği', '24.860', '100.000 örnek istek kotası', '⌘'], ['Ortalama yanıt', '148 ms', 'Örnek ölçüm', '↗'], ['Webhook teslimi', '3.842', 'Örnek aylık toplam', '⇄'], ['Kullanılan kota', '%24,9', state.plan + ' demo paketi', '▥']]) +
    '<div class="overview-grid">' + chart() + '<section class="card padded"><h3>Örnek paket kullanımı</h3><div class="key-row"><span>API istekleri</span><strong>24.860 / 100.000</strong></div><div class="usage-meter" style="--usage:25%"><span></span></div><div class="key-row"><span>Restoran bağlantıları</span><strong>2 / 10</strong></div><div class="usage-meter" style="--usage:20%"><span></span></div><div class="modal-actions"><a class="btn" href="#plans">Paketi incele ↗</a></div></section></div>';
}
function plans() {
  const items = [
    ['Geliştirici', '₺0', 'Entegrasyonu denemek ve geliştirmeye başlamak için.', ['Kendi sunucunda kurulum', 'Demo sipariş akışı', 'Açık kaynak kod', 'Topluluk katkıları']],
    ['Büyüme', '₺1.490', 'Birden fazla restoranı yöneten uygulamalar için.', ['10 restoran bağlantısı', '100.000 aylık API isteği', 'Webhook ve kullanım paneli', 'Planlanan barındırma hizmeti']],
    ['İş Ortağı', 'Teklif al', 'Yüksek hacimli POS ve SaaS ekipleri için.', ['Özel kapasite planlaması', 'Çok şubeli kurulum', 'Entegrasyon desteği', 'Planlanan hizmet seviyesi']],
  ];
  return heading('Ürününe uygun bağlantı.', 'Kendi sunucunda çalıştır veya yönetilen hizmet modelini keşfet.') +
    '<div class="demo-banner">Fiyatlar ve yönetilen hizmet paketleri taslak örnektir. Demo seçimi ödeme veya abonelik oluşturmaz.</div><div class="price-grid" style="margin-top:24px">' +
    items.map(([name, price, description, features], index) => '<section class="card price-card ' + (index === 1 ? 'featured' : '') + '"><div class="row between"><h3>' + name + '</h3>' + (state.plan === name ? '<span class="pill green">Demo seçimi</span>' : '') + '</div><p>' + description + '</p><div class="price">' + price + (price.startsWith('₺') ? '<small> / ay</small>' : '') + '</div><button class="btn ' + (index === 1 ? 'primary' : '') + '" data-plan="' + name + '">' + (index === 2 ? 'Talep önizlemesi' : 'Demo paketi seç') + ' ↗</button><ul>' + features.map(f => '<li>' + f + '</li>').join('') + '</ul></section>').join('') + '</div>';
}
function docs() {
  return heading('İlk siparişine birkaç istek uzaktasın.', 'REST API · Bearer kimlik doğrulama · JSON yanıtları') + banner() +
    '<div class="doc-layout" style="margin-top:22px"><section class="card padded"><h3>API konsolu</h3><p>Demo modunda örnek yanıtı, bağlı modda sunucunun gerçek yanıtını incele.</p><form id="console-form"><label for="endpoint">Uç nokta</label><select id="endpoint"><option value="/v1/providers">GET /v1/providers</option><option value="/v1/orders/demo">GET /v1/orders/demo</option><option value="/v1/orders/tgo">GET /v1/orders/tgo</option><option value="/v1/orders/yemeksepeti">GET /v1/orders/yemeksepeti</option><option value="/v1/orders/getir">GET /v1/orders/getir</option><option value="/v1/orders/migros">GET /v1/orders/migros</option><option value="/health">GET /health</option></select><div class="modal-actions"><button class="btn primary">İsteği çalıştır ↗</button></div></form><div id="console-response">' + code({ channel: 'tgo', source_app: 'Galaxy', source_channel: 'getir_yemek', source_label: 'GetirYemek by Uber Eats', status: 'ready', total_minor: 48500, currency: 'TRY' }) + '</div></section>' +
    '<section class="card padded"><h3>Hızlı başlangıç</h3>' + code('git clone https://github.com/ahmetcotur/Yemek-Pazaryeri-Entegrasyon.git\ncd Yemek-Pazaryeri-Entegrasyon\ncp .env.example .env\n# FOOD_API_TOKEN değerini ayarla\nnode --env-file=.env src/index.js') + '<div class="endpoint"><b>GET</b><code>/v1/orders/{provider}</code></div><div class="endpoint"><b>GET</b><code>/v1/orders/{provider}/{id}</code></div><div class="endpoint"><b>POST</b><code>/v1/demo/orders</code></div><p class="hint">TGO şu anda Stage üzerinde sipariş okur. Sipariş durum işlemleri demo kanalında kullanılabilir.</p><div class="modal-actions"><a class="btn" href="https://github.com/ahmetcotur/Yemek-Pazaryeri-Entegrasyon/blob/main/openapi.yaml" target="_blank" rel="noopener">OpenAPI sözleşmesi ↗</a></div></section></div>';
}

async function api(path, method = 'GET') {
  const response = await fetch(path, {
    method, headers: { authorization: 'Bearer ' + state.token }, cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'İstek tamamlanamadı');
  return result;
}
async function refreshOrders() {
  const result = await api('/v1/orders/' + state.activeChannel + '?size=50');
  state.orders = result.data;
}
async function createOrder(button) {
  button.disabled = true;
  try {
    if (state.connected) {
      await api('/v1/demo/orders', 'POST');
      state.activeChannel = 'demo';
      await refreshOrders();
    } else {
      state.orders.unshift({
        id: crypto.randomUUID(), channel: 'demo', source: 'tgo', status: 'new', total_minor: 48500,
        description: '2 ürün', time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        items: [{ name: 'Demo pide menü', quantity: 1, unit_price_minor: 48500 }], store_id: 'demo-store',
      });
    }
    render();
    toast('Yeni demo siparişi oluşturuldu.');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}
function showOrder(id) {
  const order = state.orders.find(o => o.id === id);
  if (!order) return;
  const step = steps[order.status];
  const canAct = !['delivered', 'cancelled'].includes(order.status);
  showModal('Sipariş #' + (order.order_number ?? order.id.slice(0, 8)),
    '<div class="row between" style="margin-bottom:18px"><span class="muted" style="font-size:12px">' + escapeHtml(orderPlatform(order)) + '</span>' + badge(order.status) + '</div>' +
    (order.items ?? []).map(item => '<div class="modal-summary"><span>' + escapeHtml(item.quantity ?? '—') + ' × ' + escapeHtml(item.name ?? 'Ürün adı paylaşılmadı') + '</span><strong>' + escapeHtml(item.unit_price_minor == null ? '—' : formatMoney(item.unit_price_minor)) + '</strong></div>').join('') +
    '<div class="modal-summary"><span>Toplam</span><strong class="order-total">' + escapeHtml(order.total_minor == null ? '—' : formatMoney(order.total_minor)) + '</strong></div><p class="hint">' + (state.connected ? 'API kanalı: ' + escapeHtml(order.channel) : 'Örnek sipariş · Değişiklikler bu sekmede tutulur.') + '</p><div class="modal-actions">' +
    (canAct && !['delivered', 'cancelled', 'out_for_delivery'].includes(order.status) ? '<button class="btn danger" data-step="cancel" data-id="' + escapeHtml(order.id) + '">İptal et</button>' : '') +
    (step && canAct ? '<button class="btn primary" data-step="' + step[0] + '" data-id="' + escapeHtml(order.id) + '">' + step[1] + '</button>' : '<button class="btn" data-action="close">Kapat</button>') + '</div>');
}
async function advanceOrder(button) {
  const id = button.dataset.id;
  const action = button.dataset.step;
  button.disabled = true;
  const transitions = { accept: 'accepted', ready: 'ready', dispatch: 'out_for_delivery', deliver: 'delivered', cancel: 'cancelled' };
  try {
    const order = state.orders.find(o => o.id === id);
    if (state.connected) {
      const channel = order?.channel || state.activeChannel || 'demo';
      await api('/v1/orders/' + encodeURIComponent(channel) + '/' + encodeURIComponent(id) + '/actions/' + action, 'POST');
      await refreshOrders();
    } else {
      if (order) order.status = transitions[action];
    }
    render();
    showOrder(id);
    toast('Sipariş durumu güncellendi.');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}
function showIntegration(key) {
  const p = platforms[key];
  if (key === 'ys') {
    showModal(p.name, '<p class="section-copy">Yemeksepeti (Delivery Hero Partner API) adaptörü aktif. OAuth 2.0 (client credentials) ile <code>YS_CLIENT_ID</code>, <code>YS_CLIENT_SECRET</code>, <code>YS_CHAIN_ID</code> ve <code>YS_VENDOR_ID</code> değişkenleriyle bağlanır.</p>' + code({ channel: 'yemeksepeti', source_channel: 'yemeksepeti', auth: 'OAuth2 Bearer' }) + '<div class="modal-actions"><a href="#docs" class="btn primary" data-action="close">API Dokümanını İncele ↗</a></div>');
    return;
  }
  if (key === 'migros') {
    showModal(p.name, '<p class="section-copy">Migros Yemek (Migros One Restoran API) adaptörü aktif. <code>MIGROS_API_KEY</code> ve <code>MIGROS_STORE_ID</code> ile UpdateOrderStatus ve GetOrders servislerini yönetir.</p>' + code({ channel: 'migros', source_channel: 'migros_yemek', header: 'XApiKey' }) + '<div class="modal-actions"><a href="#docs" class="btn primary" data-action="close">API Dokümanını İncele ↗</a></div>');
    return;
  }
  if (key === 'getir') {
    showModal(p.name, '<p class="section-copy">GetirYemek adaptörü doğrudan GetirFood API (<code>x-api-key</code> + <code>token</code>) ve TGO Galaxy kanalı üzerinden iki yönlü sipariş yönetimini destekler.</p>' + code({ channel: 'getir', source_channel: 'getir_yemek', actions: ['verify', 'prepare', 'handover', 'deliver', 'cancel'] }) + '<div class="modal-actions"><a href="#docs" class="btn primary" data-action="close">API Dokümanını İncele ↗</a></div>');
    return;
  }
  showModal('Uber Eats Trendyol Go (TGO) Bağlantısı',
    '<p class="section-copy">Trendyol Go Meal API (Stage & Prod) tam sipariş yaşam döngüsüyle (kabul/picked, hazır/invoiced, kurye/manual-shipped, iptal/unsupplied) entegre edilmiştir.</p>' +
    '<form id="integration-form"><label for="store-name">Demo şube adı</label><input id="store-name" placeholder="Örnek restoran · Merkez" required maxlength="80"><label for="store-id">Demo şube kimliği</label><input id="store-id" placeholder="12345" inputmode="numeric" pattern="[0-9]+" required><div class="modal-actions"><button type="button" class="btn" data-action="close">Vazgeç</button><button type="submit" class="btn primary">Demo eşlemesini kaydet</button></div></form>');
}
function render() {
  const page = route();
  if (page === 'home' || page === 'features') {
    landing();
    if (page === 'features') document.querySelector('.landing-section').scrollIntoView({ behavior: 'smooth' });
  } else shell(names[page] ? page : 'overview');
}
document.addEventListener('click', async event => {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.dataset.order) return showOrder(target.dataset.order);
  if (target.dataset.step) return advanceOrder(target);
  if (target.dataset.integration) return showIntegration(target.dataset.integration);
  if (target.dataset.filter) {
    state.filter = target.dataset.filter;
    render();
    return;
  }
  if (target.dataset.plan) {
    state.plan = target.dataset.plan;
    render();
    toast(state.plan + ' demo paketi seçildi. Abonelik oluşturulmadı.');
    return;
  }
  const action = target.dataset.action;
  if (action === 'close') modal.close();
  if (action === 'menu') document.querySelector('#sidebar').classList.toggle('open');
  if (action === 'create') await createOrder(target);
  if (action === 'generate-key') {
    state.demoKey = 'pk_demo_' + crypto.randomUUID().replaceAll('-', '');
    render();
    toast('Örnek anahtar oluşturuldu. Bu anahtar API erişimi sağlamaz.');
  }
  if (action === 'copy-key') {
    if (!state.demoKey) return toast('Önce bir demo anahtarı oluştur.');
    try { await navigator.clipboard.writeText(state.demoKey); toast('Demo anahtarı kopyalandı.'); }
    catch { toast('Otomatik kopyalama kullanılamıyor. Anahtarı seçip kopyalayabilirsin.'); }
  }
  if (action === 'disconnect') {
    state.token = ''; state.connected = false; state.orders = seedOrders(); state.activeChannel = 'demo';
    render(); toast('Panel demo moduna döndü.');
  }
  if (action === 'refresh') {
    target.disabled = true;
    try { await refreshOrders(); render(); toast('Siparişler yenilendi.'); }
    catch (error) { toast(error.message); } finally { target.disabled = false; }
  }
  if (action === 'webhook-test') {
    if (!state.webhook) return toast('Önce örnek hedef URL’yi kaydet.');
    state.attempts.unshift({ type: 'order.created', time: new Date().toLocaleTimeString('tr-TR') });
    render(); toast('Örnek teslimat geçmişe eklendi.');
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'period') { state.period = event.target.value; render(); }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'search') return;
  state.search = event.target.value;
  const cursor = event.target.selectionStart;
  render();
  const search = document.querySelector('#search');
  search.focus(); search.setSelectionRange(cursor, cursor);
});
document.addEventListener('submit', async event => {
  const form = event.target;
  event.preventDefault();
  if (form.id === 'integration-form') {
    state.sampleConnections.add('tgo');
    modal.close(); render(); toast('Demo şube eşlemesi kaydedildi.');
  }
  if (form.id === 'webhook-form') {
    state.webhook = document.querySelector('#webhook-url').value;
    render(); toast('Örnek hedef bu sekme için kaydedildi.');
  }
  if (form.id === 'connect-form') {
    const candidate = document.querySelector('#api-token').value;
    const selected = document.querySelector('#api-channel').value;
    const submit = form.querySelector('[type=submit]');
    const oldToken = state.token;
    const oldChannel = state.activeChannel;
    submit.disabled = true;
    state.token = candidate;
    try {
      const providers = await api('/v1/providers');
      const result = await api('/v1/orders/' + selected + '?size=50');
      state.connected = true; state.activeChannel = selected; state.providers = providers.data; state.orders = result.data;
      modal.close(); location.hash = 'overview'; render(); toast('API bağlantısı doğrulandı.');
    } catch (error) {
      state.token = oldToken; state.activeChannel = oldChannel;
      document.querySelector('#connection-result').textContent = 'Bağlantı kurulamadı: ' + error.message;
    } finally { submit.disabled = false; }
  }
  if (form.id === 'console-form') {
    const path = document.querySelector('#endpoint').value;
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      let result;
      if (state.connected || path === '/health') result = await api(path);
      else if (path === '/v1/providers') result = { mode: 'demo_preview', data: [{ id: 'demo', enabled: true }, { id: 'tgo', enabled: false, environment: 'stage' }] };
      else if (path.endsWith('/tgo')) result = { mode: 'demo_preview', data: [{ channel: 'tgo', source_app: 'Galaxy', source_label: 'GetirYemek by Uber Eats', status: 'ready' }] };
      else result = { mode: 'demo_preview', data: state.orders.slice(0, 2) };
      document.querySelector('#console-response').innerHTML = code(result);
      toast(state.connected || path === '/health' ? 'Sunucudan yanıt alındı.' : 'Örnek API yanıtı gösteriliyor.');
    } catch (error) { document.querySelector('#console-response').innerHTML = code({ error: error.message }); }
    finally { submit.disabled = false; }
  }
});
window.addEventListener('hashchange', () => { modal.close(); window.scrollTo(0, 0); render(); });
render();

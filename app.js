// app.js — main frontend logic for homepage + health + DeepSeek smart recommendations

(() => {
  const state = {
    wearable: {},
    partners: [],
    catalog: [],
    page: 0,
    pageSize: 6
  };

  function esc(s){ return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]); )}

  // -------- Load wearable health metrics ----------
  async function loadWearable() {
    try {
      const res = await fetch('wearable_stream.json');
      const w = await res.json();
      state.wearable = w;
      document.getElementById('m-hr').textContent = w.heartRate || '--';
      document.getElementById('m-steps').textContent = w.steps || '--';
      document.getElementById('m-cals').textContent = w.calories || '--';
      document.getElementById('d-burned').textContent = w.burned || '--';
      document.getElementById('d-bp').textContent = w.bp || '--';
      document.getElementById('d-activity').textContent = w.activityLevel || '--';
      document.getElementById('d-time').textContent = w.lastSync || '--';
    } catch (e) {
      console.error('Wearable load failed', e);
    }
  }

  // -------- Load partner menus ----------
  async function loadPartners() {
    try {
      const r = await fetch('partners.json');
      state.partners = await r.json();
    } catch (e) {
      console.error('Partners load failed', e);
      state.partners = [];
    }
  }

  // -------- Smart DeepSeek recommendation ----------
  async function loadSmartRecommendations() {
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    const wearable = state.wearable || {};
    const partners = state.partners || [];

    try {
      const resp = await fetch('/.netlify/functions/recommend_similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wearable, prefs, partners, topN: 6 })
      });
      const j = await resp.json();
      state.catalog = Array.isArray(j.picks) ? j.picks : [];
    } catch (e) {
      console.error('Smart recommendations failed', e);
      state.catalog = [];
    }
  }

  // -------- UI render ----------
  function buildCard(it) {
    const city = esc(it.city || 'Pune');
    const orderHref = `order.html?dish=${encodeURIComponent(it.title)}&city=${encodeURIComponent(city)}`;
    return `
      <li class="card">
        <div class="tile">${esc(it.partner || '')}</div>
        <div class="pad">
          <div class="title">${esc(it.title)}</div>
          <div class="meta">${esc(it.description || '')}</div>
          ${it.reason ? `<div class="whybox">${esc(it.reason)}</div>` : ''}
          <a href="${orderHref}" target="_blank" class="pill">🛒 Order Now</a>
        </div>
      </li>`;
  }

  function renderCatalog() {
    const root = document.getElementById('cards');
    root.innerHTML = '';
    if (!state.catalog.length) {
      root.innerHTML = `<li class="card"><div class="pad">No recommendations yet. Click "✨ Get Picks".</div></li>`;
      return;
    }
    for (const item of state.catalog) {
      root.insertAdjacentHTML('beforeend', buildCard(item));
    }
  }

  // -------- Buttons ----------
  document.getElementById('getPicks')?.addEventListener('click', async () => {
    await loadPartners();
    await loadWearable();
    await loadSmartRecommendations();
    renderCatalog();
  });

  document.getElementById('toggleDetails')?.addEventListener('click', () => {
    const d = document.getElementById('healthDetails');
    d.hidden = !d.hidden;
  });

  // -------- Boot --------
  window.APP_BOOT = async () => {
    await loadWearable();
    await loadPartners();
  };
})();

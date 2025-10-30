// acl022/app.js
// Defensive full app.js — ensures health metrics display; falls back to demo if wearable fetch fails.

(() => {
  const DEBUG = true; // set to false in production

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function fmt(n) { return typeof n === 'number' ? String(Math.round(n)) : (n || '--'); }

  const state = {
    wearable: {},
    partners: [],
    catalog: [],
    page: 0,
    pageSize: 6
  };

  async function fetchJson(url, opts = {}) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return await r.json();
    } catch (e) {
      if (DEBUG) console.warn('fetchJson error', url, e);
      throw e;
    }
  }

  // Demo fallback wearable (used if real file missing)
  const DEMO_WEARABLE = {
    heartRate: 78,
    steps: 4200,
    calories: 350,
    burned: 120,
    bp: "120/78",
    activityLevel: "Moderate",
    lastSync: new Date().toLocaleString()
  };

  async function loadWearable() {
    try {
      let w = null;
      try {
        w = await fetchJson('wearable_stream.json');
        if (!w || typeof w !== 'object') throw new Error('invalid wearable JSON');
      } catch (e) {
        if (DEBUG) console.warn('Could not load wearable_stream.json — using demo data', e);
        w = DEMO_WEARABLE;
      }
      state.wearable = w;
      // Update elements (guarded)
      const s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      s('m-hr', fmt(w.heartRate));
      s('m-steps', fmt(w.steps));
      s('m-cals', fmt(w.calories));
      s('d-burned', fmt(w.burned));
      s('d-bp', w.bp || '--');
      s('d-activity', w.activityLevel || '--');
      s('d-time', w.lastSync || '--');

      // risk banner
      const banner = document.getElementById('riskBanner');
      if (banner) {
        if ((w.heartRate || 0) > 120 || (w.bp && String(w.bp).includes('160'))) banner.hidden = false;
        else banner.hidden = true;
      }
    } catch (e) {
      console.error('loadWearable final error', e);
    }
  }

  async function loadPartners() {
    try {
      let partners = [];
      try {
        partners = await fetchJson('partners.json');
      } catch (e) {
        if (DEBUG) console.warn('partners.json not found, trying pune_menus.json', e);
        try {
          partners = await fetchJson('pune_menus.json');
        } catch (err) {
          if (DEBUG) console.warn('pune_menus.json not found', err);
          partners = [];
        }
      }
      if (!Array.isArray(partners)) partners = [];
      state.partners = partners;
      if (DEBUG) console.log('Loaded partners count=', partners.length);
    } catch (e) {
      console.error('loadPartners failed', e);
      state.partners = [];
    }
  }

  // Call serverless recommend_partners (DeepSeek) — but fallback to a simple partner-flatten if it fails
  async function loadRecommendations() {
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    try {
      const body = { wearable: state.wearable || {}, prefs: prefs || {}, partners: state.partners || [] };
      const resp = await fetch('/.netlify/functions/recommend_partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error('recommend_partners error ' + resp.status);
      const j = await resp.json();
      if (j && Array.isArray(j.picks)) {
        state.catalog = j.picks;
        if (DEBUG) console.log('Received picks', j.picks.length);
        return;
      } else {
        if (DEBUG) console.warn('recommend_partners returned no picks, falling back');
      }
    } catch (e) {
      if (DEBUG) console.warn('recommend_partners call failed, using local fallback', e);
    }

    // Fallback: flatten partner dishes (first N)
    const picks = [];
    for (const p of (state.partners || [])) {
      for (const d of (p.dishes || [])) {
        picks.push({
          title: d.title || 'Dish',
          partner: p.name || 'Partner',
          city: p.city || prefs && prefs.city || 'Pune',
          price: d.price || '--',
          reason: 'Fallback: dish from partner list'
        });
        if (picks.length >= 12) break;
      }
      if (picks.length >= 12) break;
    }
    state.catalog = picks;
  }

  function buildCardHtml(item, visibleIndex) {
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    const city = (item.city || prefs.city || 'Pune');
    const orderHref = `order.html?dish=${encodeURIComponent(item.title)}&city=${encodeURIComponent(city)}`;
    const reasonHtml = item.reason ? `<div class="whybox">${escapeHtml(item.reason)}</div>` : '';
    return `
      <li class="card" data-visible-index="${visibleIndex}">
        <div class="tile">${escapeHtml(item.partner || 'Partner')}</div>
        <div class="pad">
          <div class="title">${escapeHtml(item.title)}</div>
          <div class="meta">₹${escapeHtml(String(item.price || '--'))}</div>
          ${reasonHtml}
          <div class="row gap8 mt6">
            <a class="pill" href="${orderHref}" target="_blank" rel="noopener">🛒 Order Now</a>
          </div>
        </div>
      </li>
    `;
  }

  function renderCatalog() {
    const root = document.getElementById('cards');
    if (!root) return;
    root.innerHTML = '';

    const start = state.page * state.pageSize;
    const subset = state.catalog.slice(start, start + state.pageSize);

    if (!subset || subset.length === 0) {
      root.innerHTML = `<li class="card"><div class="pad">No recommended dishes available from partners. Click "Get Picks".</div></li>`;
      return;
    }

    subset.forEach((item, idx) => {
      root.insertAdjacentHTML('beforeend', buildCardHtml(item, idx));
    });
  }

  // UI bindings
  document.getElementById('getPicks').onclick = async () => {
    await loadPartners();
    await loadRecommendations();
    renderCatalog();
  };
  document.getElementById('prevBtn').onclick = () => { if (state.page > 0) { state.page--; renderCatalog(); } };
  document.getElementById('nextBtn').onclick = () => { if ((state.page + 1) * state.pageSize < state.catalog.length) { state.page++; renderCatalog(); } };
  document.getElementById('toggleDetails').onclick = () => { const d = document.getElementById('healthDetails'); if (d) d.hidden = !d.hidden; };

  // Boot
  window.APP_BOOT = async () => {
    try {
      await loadWearable();
      await loadPartners();
      await loadRecommendations();
      renderCatalog();
    } catch (e) {
      console.error('APP_BOOT error', e);
    }
  };

  // helper for escaping in this file scope
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

})();

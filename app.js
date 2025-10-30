// app.js — fixed DeepSeek + wearable + UI

(() => {
  const state = {
    wearable: {},
    partners: [],
    catalog: [],
  };

  const esc = s => String(s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  // ---- Wearable ----
  async function loadWearable() {
    try {
      const res = await fetch('./wearable_stream.json');
      const w = await res.json();
      state.wearable = w;
      document.getElementById('m-hr').textContent = w.heartRate || '--';
      document.getElementById('m-steps').textContent = w.steps || '--';
      document.getElementById('m-cals').textContent = w.calories || '--';
      document.getElementById('d-burned').textContent = w.burned || '--';
      document.getElementById('d-bp').textContent = w.bp || '--';
      document.getElementById('d-activity').textContent = w.activityLevel || '--';
      document.getElementById('d-time').textContent = w.lastSync || '--';
    } catch (err) {
      console.error('Wearable load error', err);
    }
  }

  // ---- Partners ----
  async function loadPartners() {
    try {
      const r = await fetch('./partners.json');
      state.partners = await r.json();
    } catch (err) {
      console.error('Partners load error', err);
      state.partners = [];
    }
  }

  // ---- DeepSeek Smart Picks ----
  async function loadSmartRecommendations() {
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    const wearable = state.wearable;
    const partners = state.partners;

    try {
      const resp = await fetch('/.netlify/functions/recommend_similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wearable, prefs, partners, topN: 6 })
      });
      const data = await resp.json();
      state.catalog = data.picks || [];
    } catch (err) {
      console.error('DeepSeek recommend failed', err);
      state.catalog = [];
    }
  }

  // ---- Render cards ----
  function renderCards() {
    const root = document.getElementById('cards');
    root.innerHTML = '';
    if (!state.catalog.length) {
      root.innerHTML = `<li class="card"><div class="pad">No dishes yet. Click "✨ Get Picks".</div></li>`;
      return;
    }
    for (const item of state.catalog) {
      root.insertAdjacentHTML('beforeend', `
        <li class="card">
          <div class="tile">${esc(item.partner)}</div>
          <div class="pad">
            <div class="title">${esc(item.title)}</div>
            <div class="meta">${esc(item.description || '')}</div>
            <div class="whybox">${esc(item.reason || '')}</div>
            <a class="pill" href="order.html?dish=${encodeURIComponent(item.title)}" target="_blank">🛒 Order Now</a>
          </div>
        </li>
      `);
    }
  }

  // ---- Events ----
  document.getElementById('toggleDetails')?.addEventListener('click', () => {
    const d = document.getElementById('healthDetails');
    d.hidden = !d.hidden;
  });

  document.getElementById('getPicks')?.addEventListener('click', async () => {
    await loadPartners();
    await loadWearable();
    await loadSmartRecommendations();
    renderCards();
  });

  // ---- Boot ----
  window.APP_BOOT = async () => {
    await loadWearable();
    await loadPartners();
  };
})();

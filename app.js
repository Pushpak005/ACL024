// app.js — final corrected version
(() => {
  const state = {
    wearable: {},
    partners: [],
    catalog: [],
    picks: [],
  };

  const esc = s => String(s || '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
  );

  async function safeJson(url, fb = null) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw 0;
      return await r.json();
    } catch { return fb; }
  }

  async function loadWearable() {
    const w = await safeJson('./wearable_stream.json', {});
    state.wearable = w || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('m-hr', w.heartRate ?? '--');
    set('m-steps', w.steps ?? '--');
    set('m-cals', w.calories ?? '--');
    set('d-burned', w.burned ?? '--');
    set('d-bp', w.bp ?? '--');
    set('d-activity', w.activityLevel ?? '--');
    set('d-time', w.lastSync ?? '--');
  }

  async function loadPartners() {
    let p = await safeJson('./partners.json', null);
    if (!p) p = await safeJson('./pune_menus.json', []);
    state.partners = Array.isArray(p) ? p : [];
  }

  async function getSmartPicks() {
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    try {
      const resp = await fetch('/.netlify/functions/recommend_similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wearable: state.wearable, prefs, partners: state.partners, topN: 6 })
      });
      if (!resp.ok) throw new Error('API failed');
      const j = await resp.json();
      return Array.isArray(j.picks) ? j.picks : [];
    } catch (e) {
      console.error('DeepSeek error', e);
      return [];
    }
  }

  function renderCards() {
    const root = document.getElementById('cards');
    root.innerHTML = '';
    const picks = state.picks || [];
    if (!picks.length) {
      root.innerHTML = `<li class="card"><div class="pad">No recommended dishes yet. Click "✨ Get Picks".</div></li>`;
      return;
    }
    for (const it of picks) {
      const id = esc(it.title);
      root.insertAdjacentHTML('beforeend', `
      <li class="card">
        <div class="tile">${esc(it.partner || '')}</div>
        <div class="pad">
          <div class="title">${esc(it.title)}</div>
          <div class="meta">${esc(it.city || '')}</div>
          ${it.reason ? `<div class="whybox">${esc(it.reason)}</div>` : ''}
          <button class="pill" onclick="openPartnerModal('${id}')">🛒 Order Now</button>
        </div>
      </li>`);
    }
  }

  document.getElementById('getPicks')?.addEventListener('click', async () => {
    await loadWearable();
    await loadPartners();
    const picks = await getSmartPicks();
    if (!picks.length) {
      // fallback from partner menus
      const dishes = [];
      for (const p of state.partners) {
        for (const d of (p.dishes || p.menu || p.items || [])) {
          dishes.push({
            title: d.title || d.name,
            partner: p.name,
            city: p.city,
            reason: 'Fallback: partner dish'
          });
        }
      }
      state.picks = dishes.slice(0, 6);
    } else state.picks = picks;
    renderCards();
  });

  document.getElementById('toggleDetails')?.addEventListener('click', () => {
    const d = document.getElementById('healthDetails');
    d.hidden = !d.hidden;
  });

  window.openPartnerModal = async function(dishTitle) {
    const modal = document.getElementById('partnerModal');
    const list = document.getElementById('partnerList');
    modal.style.display = 'flex';
    list.innerHTML = '<div class="muted">Loading partners…</div>';
    try {
      const lower = dishTitle.toLowerCase();
      const matches = [];
      for (const p of state.partners) {
        for (const d of (p.dishes || p.menu || p.items || [])) {
          if ((d.title || d.name || '').toLowerCase().includes(lower)) {
            matches.push({ partner: p.name, city: p.city, price: d.price || d.cost || '', desc: d.description || d.desc || '', link: p.order_url || '#' });
            break;
          }
        }
      }
      const html = matches.map(m => `
        <div class='partnerCard' style='padding:10px;border-bottom:1px solid #eee'>
          <b>${esc(m.partner)}</b><br/>
          <small>${esc(m.city)} • ₹${esc(m.price)}</small><br/>
          <small>${esc(m.desc)}</small><br/>
          <a class='pill small' target='_blank' href='${esc(m.link)}'>Open</a>
        </div>`).join('');
      list.innerHTML = html || '<div class="muted">No partners found.</div>';
    } catch (e) {
      console.error(e);
      list.innerHTML = '<div class="muted">Error loading partners.</div>';
    }
  };

  window.closePartnerModal = () => {
    document.getElementById('partnerModal').style.display = 'none';
  };

  window.APP_BOOT = async function() {
    await loadWearable();
    await loadPartners();
  };
})();

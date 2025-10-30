// acl022/app.js
// Full app — preserves original advanced logic, updated to use DeepSeek-backed partner recommendations
// and to ensure internal ordering flow. Ready to paste into acl022/app.js

(() => {
  const DEBUG = false;

  // -------------------------
  // Helpers
  // -------------------------
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function fmt(n) { return typeof n === 'number' ? String(Math.round(n)) : (n || '--'); }

  // -------------------------
  // App state
  // -------------------------
  const state = {
    wearable: null,
    catalog: [],     // items currently shown (after LLM picks)
    scores: {},      // optional LLM scores per recipe (if used)
    partners: null,  // partner menu objects
    page: 0,
    pageSize: 6,
    availableSet: null
  };

  // -------------------------
  // fetch JSON helper w/ timeout
  // -------------------------
  async function fetchJson(url, opts = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(url, Object.assign({ signal: controller.signal }, opts));
      clearTimeout(id);
      if (!r.ok) throw new Error('fetch failed: ' + r.status);
      return await r.json();
    } catch (e) {
      clearTimeout(id);
      if (DEBUG) console.warn('fetchJson fail', url, e);
      throw e;
    }
  }

  // -------------------------
  // load wearable stream (demo file)
  // -------------------------
  async function loadWearableStream() {
    try {
      const w = await fetchJson('wearable_stream.json');
      state.wearable = w;

      // UI updates
      const setIf = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setIf('m-hr', fmt(w.heartRate));
      setIf('m-steps', fmt(w.steps));
      setIf('m-cals', fmt(w.calories));
      setIf('d-burned', fmt(w.burned));
      setIf('d-bp', w.bp || '--');
      setIf('d-activity', w.activityLevel || '--');
      setIf('d-time', w.lastSync || '--');

      const banner = document.getElementById('riskBanner');
      if (banner) {
        if ((w.heartRate || 0) > 120 || (w.bp && w.bp.includes('160'))) banner.hidden = false;
        else banner.hidden = true;
      }
    } catch (e) {
      if (DEBUG) console.warn('No wearable stream', e);
    }
  }

  // -------------------------
  // load partners (partners.json fallback to pune_menus.json)
  // -------------------------
  async function loadPartners() {
    try {
      let partners = null;
      try {
        partners = await fetchJson('partners.json');
        if (!Array.isArray(partners)) throw new Error('partners.json not array');
      } catch (e) {
        if (DEBUG) console.warn('partners.json missing or invalid, trying pune_menus.json', e);
        try {
          partners = await fetchJson('pune_menus.json');
          if (!Array.isArray(partners)) throw new Error('pune_menus.json not array');
        } catch (err) {
          if (DEBUG) console.warn('pune_menus.json missing', err);
          partners = [];
        }
      }
      state.partners = partners || [];
      if (DEBUG) console.log('Loaded partners:', state.partners.length);
    } catch (e) {
      if (DEBUG) console.warn('loadPartners failed', e);
      state.partners = [];
    }
  }

  // -------------------------
  // Build set of available dish titles for a city (lowercased)
  // -------------------------
  function buildAvailableDishSet(city) {
    const set = new Set();
    if (!state.partners || !Array.isArray(state.partners)) return set;
    const c = (city || '').toLowerCase();
    for (const p of state.partners) {
      if (!p) continue;
      const pcity = (p.city || '').toLowerCase();
      if (!pcity || pcity === c) {
        const dishes = p.dishes || [];
        for (const d of dishes) {
          if (d && d.title) set.add(String(d.title).trim().toLowerCase());
        }
      }
    }
    return set;
  }

  // -------------------------
  // fetch LLM scores (optional function kept for compatibility)
  // -------------------------
  async function fetchLlmScores(recs) {
    // This function can still call existing /api/score for each item if desired.
    // We'll keep the implementation minimal and non-blocking; if you have an LLM
    // score function you can re-enable it here.
    try {
      for (const item of recs) {
        // Example: post to /api/score (if you use it)
        // const resp = await fetch('/api/score', { method: 'POST', body: JSON.stringify({ item, wearable: state.wearable }) });
        // if (resp.ok) { const j = await resp.json(); if(j.score) state.scores[item.title] = j.score; }
      }
    } catch (e) {
      if (DEBUG) console.warn('fetchLlmScores failed', e);
    }
  }

  // -------------------------
  // The new main: call recommend_partners serverless function (DeepSeek) which returns picks only from partners
  // -------------------------
  async function loadRecommendationsFromDeepseek() {
    try {
      const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
      // Prepare request body: wearable, prefs, and partners (we already loaded partners)
      const body = {
        wearable: state.wearable || {},
        prefs: prefs || {},
        partners: state.partners || []
      };

      const resp = await fetch('/.netlify/functions/recommend_partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        // attempt fallback to serverless direct function path (if proxying configured differently)
        // but still try to parse the body if possible
        try {
          const t = await resp.text();
          if (t) {
            // attempt parse
            try { const j = JSON.parse(t); if (Array.isArray(j.picks)) { state.catalog = j.picks; return; } } catch (_) {}
          }
        } catch (_) {}
        throw new Error('recommend_partners call failed: ' + resp.status);
      }

      const j = await resp.json();
      if (j && Array.isArray(j.picks)) {
        // Each pick should be an object: { title, reason, partner, city, price }
        state.catalog = j.picks;
        // optional: compute availableSet for prefs.city
        try {
          const city = (prefs && prefs.city) ? prefs.city : 'Pune';
          state.availableSet = buildAvailableDishSet(city);
        } catch (_) {
          state.availableSet = null;
        }

        // Non-blocking scoring (if used)
        fetchLlmScores(state.catalog).catch(() => {});
        return;
      }

      // If no picks returned, fallback to heuristic merge: flatten partner dishes and show first few
      const fallback = [];
      for (const p of (state.partners || [])) {
        for (const d of (p.dishes || [])) {
          fallback.push({
            title: d.title,
            description: d.description,
            partner: p.name,
            city: p.city,
            price: d.price,
            reason: 'Fallback partner suggestion'
          });
          if (fallback.length >= 8) break;
        }
        if (fallback.length >= 8) break;
      }
      state.catalog = fallback;
    } catch (e) {
      if (DEBUG) console.warn('loadRecommendationsFromDeepseek failed', e);
      // as last resort, show nothing (or minimal fallback)
      state.catalog = [];
    }
  }

  // -------------------------
  // BUILD CARD HTML - uses internal orderHref; keeps fallback searchUrl
  // -------------------------
  function buildCardHtml(item, visibleIndex) {
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    let searchUrl;
    let orderHref;
    if (item.link) {
      searchUrl = item.link;
      orderHref = item.link;
    } else {
      const city = (prefs && prefs.city) ? prefs.city : 'Pune';
      orderHref = `order.html?dish=${encodeURIComponent(item.title)}&city=${encodeURIComponent(city)}`;
      const q = `${item.title} healthy ${city}`;
      searchUrl = `https://www.swiggy.com/search?q=${encodeURIComponent(q)}`;
    }

    const tags = (item.tags || []).slice(0, 3).map(t => escapeHtml(t)).join(' • ');
    const idSafe = escapeHtml(String(visibleIndex));

    // Use item.reason for LLM explanation if present; otherwise empty
    const whyHtml = item.reason ? `<div class="whybox">${escapeHtml(item.reason)}</div>` : '';

    return `
      <li class="card" data-visible-index="${idSafe}">
        <div class="tile">${escapeHtml(item.partner || item.hero || item.title || 'Dish')}</div>
        <div class="pad">
          <div class="title">${escapeHtml(item.title)}</div>
          <div class="meta">${tags}</div>
          <div class="row gap8 mt6">
            <button class="chip" id="like-${idSafe}" title="Like">♥</button>
            <button class="chip" id="skip-${idSafe}" title="Skip">⨯</button>
          </div>
          <div class="row gap8 mt6">
            <button class="pill ghost why-btn" id="why-${idSafe}" data-visible-index="${idSafe}">ℹ Why?</button>
            <button class="pill ghost" id="review-${idSafe}" title="Human review">👩‍⚕️ Review</button>
            <a class="pill" href="${orderHref}" target="_blank" rel="noopener">🛒 Order Now</a>
          </div>
          ${whyHtml}
        </div>
      </li>`;
  }

  // -------------------------
  // build heuristic why explanation (used if LLM didn't return reasons)
  // -------------------------
  function buildWhyHtml(item) {
    const w = state.wearable || {};
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}') || {};
    const lines = [];
    try {
      if (w.heartRate && w.heartRate > 110) {
        lines.push("Your current heart rate is high — prefer light meals with lower sodium and fat.");
      } else if (w.heartRate && w.heartRate

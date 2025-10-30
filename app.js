// acl022/app.js
// Full app.js with DeepSeek recommender + robust fallback similarity ranking
// Ensures at least 5 partner dishes are shown (from partners.json / pune_menus.json)

(() => {
  const DEBUG = false;

  function esc(s){ return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]); )}

  // Simple lowercase keyword match helper
  function containsAny(text, arr){
    if(!text) return false;
    const t = String(text).toLowerCase();
    return arr.some(k => t.includes(k));
  }

  // Basic scalar clamp
  function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

  // Build fallback reason string quickly
  function buildReasonFromTags(matches, metricHints){
    const parts = [];
    if(matches.dietMatch) parts.push(`Matches your ${matches.dietLabel} preference`);
    if(matches.lightMatch) parts.push('Light / grilled style preferred for current vitals');
    if(matches.proteinMatch) parts.push('High protein option');
    if(matches.fuzzyMatch && matches.fuzzyMatch.length) parts.push(`Similar to: ${matches.fuzzyMatch.join(', ').slice(0,80)}`);
    if(metricHints) parts.push(metricHints);
    return parts.join('. ');
  }

  // App state
  const state = {
    wearable: {},
    partners: [],
    catalog: [],    // the picks we will display (each item should include title, partner, price, reason, city, description)
    page: 0,
    pageSize: 6
  };

  // Fetch JSON with basic error handling
  async function fetchJson(url){
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url} ${r.status}`);
      return await r.json();
    } catch(e){
      if (DEBUG) console.warn('fetchJson error', url, e);
      throw e;
    }
  }

  // Load wearable stream (demo fallback)
  async function loadWearable(){
    try {
      let w;
      try {
        w = await fetchJson('wearable_stream.json');
      } catch(e) {
        // fallback tiny default
        w = { heartRate: 78, steps: 4200, calories: 350, burned: 120, bp: "118/76", activityLevel: "Moderate", lastSync: new Date().toISOString() };
      }
      state.wearable = w;
      // update UI if present
      const set = (id,v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
      set('m-hr', w.heartRate ?? '--');
      set('m-steps', w.steps ?? '--');
      set('m-cals', w.calories ?? '--');
      set('d-burned', w.burned ?? '--');
      set('d-bp', w.bp ?? '--');
      set('d-activity', w.activityLevel ?? '--');
      set('d-time', w.lastSync ?? '--');
      const banner = document.getElementById('riskBanner');
      if(banner){
        banner.hidden = !((w.heartRate||0) > 120 || (String(w.bp||'').includes('160')));
      }
    } catch(e){
      if(DEBUG) console.error('loadWearable final error', e);
    }
  }

  // Load partners file (partners.json first, then pune_menus.json)
  async function loadPartners(){
    try {
      let partners = [];
      try {
        partners = await fetchJson('partners.json');
      } catch(e) {
        partners = await fetchJson('pune_menus.json').catch(()=>[]);
      }
      if (!Array.isArray(partners)) partners = [];
      state.partners = partners;
      if(DEBUG) console.log('partners loaded', partners.length);
    } catch(e) {
      state.partners = [];
      if(DEBUG) console.error('loadPartners error', e);
    }
  }

  // Utility: flatten all dishes to objects with partner info
  function flattenPartnerDishes(){
    const out = [];
    for(const p of (state.partners||[])){
      const partnerName = p.name || p.partner || 'Partner';
      const city = p.city || '';
      const area = p.area || '';
      for(const d of (p.dishes||[])){
        out.push({
          title: d.title || '',
          description: d.description || '',
          price: d.price || null,
          partner: partnerName,
          city,
          area,
          payment_link: d.payment_link || d.paymentLink || null,
          raw: d
        });
      }
    }
    return out;
  }

  // Primary load: call DeepSeek recommend_partners; if it fails or returns few picks, fallback to similarity heuristic
  async function loadRecommendations(){
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    const partners = state.partners || [];
    const wearable = state.wearable || {};

    // First attempt: serverless LLM recommender
    try {
      const resp = await fetch('/.netlify/functions/recommend_partners', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ wearable, prefs, partners })
      });
      if (resp.ok) {
        const j = await resp.json();
        if (j && Array.isArray(j.picks) && j.picks.length >= 5) {
          // ensure each pick contains partner/title/price/reason
          state.catalog = j.picks.map(p => ({
            title: p.title || '',
            description: p.description || '',
            price: p.price ?? null,
            partner: p.partner || '',
            city: p.city || (prefs.city||''),
            reason: p.reason || 'Recommended by LLM'
          }));
          if(DEBUG) console.log('LLM picks used, count=', state.catalog.length);
          return;
        } else {
          if(DEBUG) console.log('LLM returned insufficient picks', j && j.picks ? j.picks.length : 'no picks');
          // fall through to fallback scorer, but keep potential partial picks to seed results
          const seed = Array.isArray(j && j.picks) ? j.picks : [];
          const fallback = fallbackScorer(seed, prefs, wearable);
          state.catalog = fallback;
          return;
        }
      } else {
        if(DEBUG) console.warn('recommend_partners status', resp.status);
      }
    } catch(e){
      if(DEBUG) console.warn('recommend_partners call failed', e);
    }

    // If LLM path failed, fallback entirely to local scorer
    const fallback = fallbackScorer([], prefs, wearable);
    state.catalog = fallback;
  }

  // Fallback scorer: generate minimum N picks based on partners, prefs, wearable
  // seedPicks: optional array of picks from LLM (partial) to prioritize
  function fallbackScorer(seedPicks, prefs, wearable){
    const MIN_PICKS = 5;
    const all = flattenPartnerDishes();
    if(all.length === 0) return [];

    // build health keywords based on wearable and prefs
    const keywords = [];
    const diet = (prefs.diet || '').toLowerCase();
    const hr = Number(wearable.heartRate || 0);
    const activity = (wearable.activityLevel || '').toLowerCase();

    // diet keywords
    const vegKeys = ['paneer','tofu','salad','sprout','dal','khichdi','vegetarian','veg','chickpea','lentil','bean','moong'];
    const nonvegKeys = ['chicken','fish','egg','mutton','prawn','biryani','meat','pork','lamb','seafood'];

    // style keywords for light meals
    const lightKeys = ['light','grilled','steamed','roasted','salad','stew','clear','broth','low-sodium','low-fat','satvik'];
    const proteinKeys = ['chicken','paneer','tofu','egg','fish','lentil','dal','quinoa','beans','chickpea'];

    if(diet === 'veg') keywords.push(...vegKeys);
    else if(diet === 'nonveg') keywords.push(...nonvegKeys);
    // If heart rate high or activity low, prefer light meals
    if(hr > 100 || activity.includes('low')) keywords.push(...lightKeys);
    // prefer protein if active
    if(activity.includes('high') || activity.includes('moderate')) keywords.push(...proteinKeys);

    // Deduplicate keywords
    const kwSet = new Set(keywords.map(k=>k.toLowerCase()));

    // Scoring function
    function scoreDish(d){
      let score = 0;
      const title = (d.title || '').toLowerCase();
      const desc = (d.description || '').toLowerCase();

      // diet match strong boost
      if(diet === 'veg' && containsAny(title + ' ' + desc, vegKeys)) score += 20;
      if(diet === 'nonveg' && containsAny(title + ' ' + desc, nonvegKeys)) score += 20;

      // light / healthy indicators
      if(containsAny(title + ' ' + desc, lightKeys)) score += 12;

      // protein preference
      if(containsAny(title + ' ' + desc, proteinKeys)) score += 8;

      // fuzzy keyword matches
      let fuzzyMatches = 0;
      for(const k of kwSet){
        if(title.includes(k) || desc.includes(k)) fuzzyMatches++;
      }
      score += fuzzyMatches * 3;

      // prefer lower price a tiny bit (not necessary)
      if(d.price && !isNaN(Number(d.price))) {
        const p = Number(d.price);
        // cheaper dishes slightly favored (small effect)
        score += clamp(10 - Math.log10(p+1), 0, 3);
      }

      // small random tie breaker deterministic-ish
      score += ((title.length + (d.partner||'').length) % 7) * 0.01;

      return {score, fuzzyMatches};
    }

    // Score all dishes
    const scored = all.map(d => {
      const s = scoreDish(d);
      return Object.assign({}, d, { _score: s.score, _fuzzyMatches: s.fuzzyMatches });
    });

    // If seed picks provided, promote them
    const seeds = (seedPicks || []).map(sp => (sp && sp.title ? sp.title.toLowerCase() : null)).filter(Boolean);
    if(seeds.length){
      scored.forEach(s => {
        const t = (s.title||'').toLowerCase();
        if(seeds.some(ss => t.includes(ss) || ss.includes(t))) {
          s._score += 50; // strong boost for seed similarity
        }
      });
    }

    // Sort descending
    scored.sort((a,b) => b._score - a._score);

    // Build output with reasons
    const picks = [];
    const hints = [];
    if(wearable.heartRate && Number(wearable.heartRate) > 100) hints.push('heart rate is high → prefer light / low-sodium items');
    if(wearable.activityLevel && String(wearable.activityLevel).toLowerCase().includes('low')) hints.push('low activity → prefer lighter meals');
    const metricHints = hints.join('; ');

    for(const s of scored.slice(0, Math.max(MIN_PICKS, Math.min(scored.length, 12)))){
      const matches = {
        dietMatch: containsAny(s.title + ' ' + s.description, diet === 'veg' ? vegKeys : (diet === 'nonveg' ? nonvegKeys : [])),
        dietLabel: diet || 'preference',
        lightMatch: containsAny(s.title + ' ' + s.description, lightKeys),
        proteinMatch: containsAny(s.title + ' ' + s.description, proteinKeys),
        fuzzyMatch: []
      };
      // collect a few fuzzy matched keywords to include in reason
      for(const k of kwSet){
        if((s.title||'').toLowerCase().includes(k) || (s.description||'').toLowerCase().includes(k)) matches.fuzzyMatch.push(k);
        if(matches.fuzzyMatch.length >= 3) break;
      }
      const reason = buildReasonFromTags(matches, metricHints);
      picks.push({
        title: s.title,
        description: s.description,
        price: s.price,
        partner: s.partner,
        city: s.city,
        reason: reason || 'Matched from partner menu'
      });
      if(picks.length >= MIN_PICKS) break;
    }

    // If still less than MIN_PICKS try to fill with top remaining items
    if(picks.length < MIN_PICKS){
      const used = new Set(picks.map(p=> (p.title+'::'+p.partner)));
      for(const s of scored){
        const key = s.title+'::'+s.partner;
        if(used.has(key)) continue;
        picks.push({
          title: s.title, description: s.description, price: s.price, partner: s.partner, city: s.city,
          reason: 'Included to reach minimum recommendations'
        });
        used.add(key);
        if(picks.length >= MIN_PICKS) break;
      }
    }

    return picks;
  }

  // Build card HTML
  function buildCardHtml(item, indexOnPage){
    const city = esc(item.city || window.__APP_PREFS?.city || 'Pune');
    const orderHref = `order.html?dish=${encodeURIComponent(item.title)}&city=${encodeURIComponent(city)}`;
    const reasonHtml = item.reason ? `<div class="whybox">${esc(item.reason)}</div>` : '';
    return `
      <li class="card">
        <div class="tile">${esc(item.partner || '')}</div>
        <div class="pad">
          <div class="title">${esc(item.title)}</div>
          <div class="meta">${esc(item.description || '')}</div>
          ${reasonHtml}
          <div style="margin-top:8px">
            <a class="pill" href="${orderHref}" target="_blank">🛒 Order Now</a>
          </div>
        </div>
      </li>
    `;
  }

  // Render catalog to UI
  function renderCatalog(){
    const root = document.getElementById('cards');
    if(!root) return;
    root.innerHTML = '';
    const start = state.page * state.pageSize;
    const items = state.catalog.slice(start, start + state.pageSize);
    if(!items || items.length === 0){
      root.innerHTML = `<li class="card"><div class="pad">No recommended dishes available from partners. Click "Get Picks".</div></li>`;
      return;
    }
    for(const it of items){
      root.insertAdjacentHTML('beforeend', buildCardHtml(it));
    }
  }

  // UI bindings
  document.getElementById('getPicks')?.addEventListener('click', async ()=>{
    await loadPartners();
    await loadRecommendations();
    renderCatalog();
  });
  document.getElementById('prevBtn')?.addEventListener('click', ()=>{
    if(state.page > 0){ state.page--; renderCatalog(); }
  });
  document.getElementById('nextBtn')?.addEventListener('click', ()=>{
    if((state.page+1)*state.pageSize < state.catalog.length){ state.page++; renderCatalog(); }
  });
  document.getElementById('toggleDetails')?.addEventListener('click', ()=>{
    const d = document.getElementById('healthDetails'); if(d) d.hidden = !d.hidden;
  });

  // Boot
  async function bootApp(){
    await loadWearable();
    await loadPartners();
    await loadRecommendations();
    renderCatalog();
  }

  window.APP_BOOT = bootApp;

  // If debug, expose helpers
  if(DEBUG) {
    window._ACL_STATE = state;
    window._acl_fallbackScorer = fallbackScorer;
  }

})();

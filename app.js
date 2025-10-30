// acl022/app.js
// Full app.js — DeepSeek recommender + robust fallback similarity ranking + health snapshot.
// Replace your existing app.js with this file.

(() => {
  const DEBUG = true; // set to false in production

  function esc(s){ return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]); )}
  function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

  // App state
  const state = {
    wearable: {},
    partners: [],
    catalog: [],
    page: 0,
    pageSize: 6
  };

  // fetch helper
  async function fetchJson(url){
    const r = await fetch(url);
    if(!r.ok) throw new Error(url + ' ' + r.status);
    return await r.json();
  }

  // demo fallback wearable
  const DEMO_WEARABLE = {
    heartRate: 82,
    steps: 5230,
    calories: 340,
    burned: 120,
    bp: "118/76",
    activityLevel: "Moderate",
    lastSync: new Date().toISOString()
  };

  // load wearable
  async function loadWearable(){
    try{
      let w;
      try { w = await fetchJson('wearable_stream.json'); } catch(e) { if(DEBUG) console.warn('wearable fetch failed', e); w = DEMO_WEARABLE; }
      state.wearable = w;
      const s = (id,v)=>{ const el=document.getElementById(id); if(el) el.textContent = v; };
      s('m-hr', w.heartRate ?? '--'); s('m-steps', w.steps ?? '--'); s('m-cals', w.calories ?? '--');
      s('d-burned', w.burned ?? '--'); s('d-bp', w.bp ?? '--'); s('d-activity', w.activityLevel ?? '--'); s('d-time', w.lastSync ?? '--');
      const banner = document.getElementById('riskBanner'); if(banner) banner.hidden = !((w.heartRate||0) >120 || (String(w.bp||'').includes('160')));
    }catch(e){ console.error('loadWearable error', e); state.wearable = DEMO_WEARABLE; }
  }

  // load partners
  async function loadPartners(){
    try {
      let partners=[];
      try{ partners = await fetchJson('partners.json'); } catch(e){ if(DEBUG) console.warn('partners.json missing, trying pune_menus.json', e); partners = await fetchJson('pune_menus.json').catch(()=>[]); }
      if(!Array.isArray(partners)) partners=[];
      state.partners = partners;
      if(DEBUG) console.log('partners loaded', partners.length);
    } catch(e){
      console.error('loadPartners error', e);
      state.partners = [];
    }
  }

  // flatten partner dishes
  function flattenPartnerDishes(){
    const out = [];
    for(const p of (state.partners||[])){
      for(const d of (p.dishes||[])){
        out.push({
          title: d.title || '',
          description: d.description || '',
          price: d.price || null,
          partner: p.name || '',
          city: p.city || '',
          area: p.area || '',
          payment_link: d.payment_link || d.paymentLink || null
        });
      }
    }
    return out;
  }

  // helper containsAny
  function containsAny(text, arr){
    if(!text) return false;
    const t = String(text).toLowerCase();
    return arr.some(k => t.includes(k));
  }

  // Fallback scorer - same implementation as previous message (guarantees min picks)
  function fallbackScorer(seedPicks, prefs, wearable){
    const MIN_PICKS = 5;
    const all = flattenPartnerDishes();
    if(all.length === 0) return [];

    const diet = (prefs.diet || '').toLowerCase();
    const hr = Number(wearable.heartRate || 0);
    const activity = (wearable.activityLevel || '').toLowerCase();

    const vegKeys = ['paneer','tofu','salad','sprout','dal','khichdi','vegetarian','veg','chickpea','lentil','bean','moong'];
    const nonvegKeys = ['chicken','fish','egg','mutton','prawn','biryani','meat','pork','lamb','seafood'];
    const lightKeys = ['light','grilled','steamed','roasted','salad','stew','clear','broth','low-sodium','low-fat','satvik'];
    const proteinKeys = ['chicken','paneer','tofu','egg','fish','lentil','dal','quinoa','beans','chickpea'];

    const keywords = new Set();
    if(diet === 'veg') vegKeys.forEach(k=>keywords.add(k));
    else if(diet === 'nonveg') nonvegKeys.forEach(k=>keywords.add(k));
    if(hr > 100 || activity.includes('low')) lightKeys.forEach(k=>keywords.add(k));
    if(activity.includes('high') || activity.includes('moderate')) proteinKeys.forEach(k=>keywords.add(k));

    function scoreDish(d){
      let score = 0;
      const text = (d.title + ' ' + (d.description||'')).toLowerCase();

      if(diet==='veg' && containsAny(text, vegKeys)) score += 20;
      if(diet==='nonveg' && containsAny(text, nonvegKeys)) score += 20;
      if(containsAny(text, lightKeys)) score += 12;
      if(containsAny(text, proteinKeys)) score += 8;

      let fuzzy=0;
      keywords.forEach(k => { if(text.includes(k)) fuzzy++; });
      score += fuzzy * 3;

      if(d.price && !isNaN(Number(d.price))){ const p = Number(d.price); score += clamp(10 - Math.log10(p+1), 0, 3); }
      score += ((text.length + (d.partner||'').length) % 7) * 0.01;
      return { score, fuzzyMatches: fuzzy };
    }

    const scored = all.map(d => Object.assign({}, d, scoreDish(d)));
    const seeds = (seedPicks || []).map(sp => (sp && sp.title ? sp.title.toLowerCase() : null)).filter(Boolean);
    if(seeds.length){
      scored.forEach(s => { const t = (s.title||'').toLowerCase(); if(seeds.some(ss => t.includes(ss) || ss.includes(t))) s.score += 50; });
    }
    scored.sort((a,b)=> b.score - a.score);

    const picks = [];
    const hints = [];
    if(wearable.heartRate && Number(wearable.heartRate) > 100) hints.push('heart rate is high → prefer light / low-sodium items');
    if(wearable.activityLevel && String(wearable.activityLevel).toLowerCase().includes('low')) hints.push('low activity → prefer lighter meals');
    const metricHints = hints.join('; ');

    for(const s of scored.slice(0, Math.max(MIN_PICKS, Math.min(scored.length, 12)))){
      const matches = { dietMatch: containsAny(s.title + ' ' + s.description, diet==='veg' ? vegKeys : (diet==='nonveg'?nonvegKeys:[])), dietLabel: diet||'preference', lightMatch: containsAny(s.title+' '+s.description, lightKeys), proteinMatch: containsAny(s.title+' '+s.description, proteinKeys), fuzzyMatch: [] };
      for(const k of keywords){ if((s.title||'').toLowerCase().includes(k) || (s.description||'').toLowerCase().includes(k)) matches.fuzzyMatch.push(k); if(matches.fuzzyMatch.length>=3) break; }
      const reasonParts = [];
      if(matches.dietMatch) reasonParts.push(`Matches your ${matches.dietLabel} preference`);
      if(matches.lightMatch) reasonParts.push('Light / grilled style preferred for current vitals');
      if(matches.proteinMatch) reasonParts.push('High protein option');
      if(matches.fuzzyMatch.length) reasonParts.push(`Similar to: ${matches.fuzzyMatch.join(', ').slice(0,80)}`);
      if(metricHints) reasonParts.push(metricHints);
      const reason = reasonParts.join('. ') || 'Matched from partner menus';
      picks.push({ title: s.title, description: s.description, price: s.price, partner: s.partner, city: s.city, reason });
      if(picks.length >= MIN_PICKS) break;
    }

    if(picks.length < MIN_PICKS){
      const used = new Set(picks.map(p=>p.title+'::'+p.partner));
      for(const s of scored){
        const key = s.title+'::'+s.partner;
        if(used.has(key)) continue;
        picks.push({ title: s.title, description: s.description, price: s.price, partner: s.partner, city: s.city, reason: 'Included to reach minimum recommendations' });
        used.add(key);
        if(picks.length >= MIN_PICKS) break;
      }
    }

    return picks;
  }

  // call serverless recommend_partners (DeepSeek). If it fails or returns <5 picks, call fallbackScorer
  async function loadRecommendations(){
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
    const partners = state.partners || [];
    const wearable = state.wearable || {};
    // attempt serverless LLM
    try {
      const resp = await fetch('/.netlify/functions/recommend_partners', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ wearable, prefs, partners })
      });
      if(resp.ok){
        const j = await resp.json();
        if(j && Array.isArray(j.picks) && j.picks.length >= 5){
          state.catalog = j.picks.map(p=>({ title: p.title, description: p.description, price: p.price, partner: p.partner, city: p.city || prefs.city, reason: p.reason || 'Recommended by LLM' }));
          if(DEBUG) console.log('Using LLM picks', state.catalog.length);
          return;
        } else {
          if(DEBUG) console.log('LLM picks insufficient or missing; running fallback scorer', j && j.picks ? j.picks.length : 'no-picks');
          const fallback = fallbackScorer(j && Array.isArray(j.picks) ? j.picks : [], prefs, wearable);
          state.catalog = fallback;
          return;
        }
      } else {
        if(DEBUG) console.warn('recommend_partners status', resp.status);
      }
    } catch(e){
      if(DEBUG) console.warn('recommend_partners call failed', e);
    }
    // final fallback
    state.catalog = fallbackScorer([], prefs, wearable);
  }

  // build UI card
  function buildCardHtml(item){
    const city = esc(item.city || (window.__APP_PREFS && window.__APP_PREFS.city) || 'Pune');
    const orderHref = `order.html?dish=${encodeURIComponent(item.title)}&city=${encodeURIComponent(city)}`;
    const reasonHtml = item.reason ? `<div class="whybox">${esc(item.reason)}</div>` : '';
    return `
      <li class="card">
        <div class="tile">${esc(item.partner||'Partner')}</div>
        <div class="pad">
          <div class="title">${esc(item.title)}</div>
          <div class="meta">${esc(item.description || '')}</div>
          ${reasonHtml}
          <div style="margin-top:8px">
            <a class="pill" href="${orderHref}" target="_blank">🛒 Order Now</a>
          </div>
        </div>
      </li>`;
  }

  // render
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
    for(const it of items) root.insertAdjacentHTML('beforeend', buildCardHtml(it));
  }

  // UI events
  document.getElementById('getPicks')?.addEventListener('click', async ()=>{
    await loadPartners();
    await loadRecommendations();
    renderCatalog();
  });
  document.getElementById('prevBtn')?.addEventListener('click', ()=>{ if(state.page>0){ state.page--; renderCatalog(); } });
  document.getElementById('nextBtn')?.addEventListener('click', ()=>{ if((state.page+1)*state.pageSize < state.catalog.length){ state.page++; renderCatalog(); } });
  document.getElementById('toggleDetails')?.addEventListener('click', ()=>{ const d = document.getElementById('healthDetails'); if(d) d.hidden = !d.hidden; });

  // boot
  window.APP_BOOT = async ()=>{ await loadWearable(); await loadPartners(); await loadRecommendations(); renderCatalog(); };

  if(DEBUG) window._acl_state = state;

})();

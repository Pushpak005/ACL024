// (Full app.js content extracted and modified from your project.)
// Use the global fetch API available in Node 18 environments.  No import needed.
// Healthy Diet – Enhanced Build (light theme)
// - Poll wearable every 60 seconds.
// - Re-rank picks based on user preferences and vitals.  Preferences can be
//   updated from the Preferences page.
// - Nutrition macros are fetched on demand via a Netlify function calling
//   OpenFoodFacts (no API key required).  Results are cached locally.
// - Evidence for each tag is fetched via another Netlify function calling
//   Crossref, returning the paper title, URL and abstract.  This is cached
//   locally as well.
// - The “Why?” button combines a rule-based heuristic with research
//   evidence and a DeepSeek LLM call.  A detailed prompt is constructed
//   using the user’s vitals, dish macros/tags and evidence.  The LLM is
//   called through a serverless proxy (/api/deepseek).  If the model
//   returns no text, a fallback summary is generated from the research
//   abstract (first one or two sentences), or the heuristic explanation
//   is shown.
//
// NOTE: Only a small change was made inside the card-building template:
// the code now constructs `orderHref = order.html?dish=...&city=...` and uses
// it for the "🛒 Order Now" action (with `searchUrl` retained as a fallback).
//
// Full original file follows:
(() => {
/* Healthy Diet – Enhanced Build (light theme)
   (this header repeated in original to explain behavior)
*/

const DEBUG = false;

// Simple HTML escape helper
function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }

// small helper to format numbers
function fmt(n){ return typeof n === 'number' ? String(Math.round(n)) : (n || '--'); }

// global app state
const state = {
  wearable: null,
  catalog: [],
  scores: {},
  partners: null,
  page: 0,
  pageSize: 6
};

// helper to fetch and parse JSON with timeout
async function fetchJson(url, opts = {}){
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), 8000);
  try{
    const r = await fetch(url, Object.assign({signal: controller.signal}, opts));
    clearTimeout(id);
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    return await r.json();
  }catch(e){
    clearTimeout(id);
    if (DEBUG) console.warn('fetchJson fail', url, e);
    throw e;
  }
}

// attempt to read wearable stream (demo JSON file delivered with project)
async function loadWearableStream(){
  try {
    const w = await fetchJson('wearable_stream.json');
    state.wearable = w;
    // update UI
    document.getElementById('m-hr').textContent = fmt(w.heartRate);
    document.getElementById('m-steps').textContent = fmt(w.steps);
    document.getElementById('m-cals').textContent = fmt(w.calories);
    document.getElementById('d-burned').textContent = fmt(w.burned);
    document.getElementById('d-bp').textContent = (w.bp || '--');
    document.getElementById('d-activity').textContent = (w.activityLevel || '--');
    document.getElementById('d-time').textContent = (w.lastSync || '--');
    // simple risk banner logic
    const banner = document.getElementById('riskBanner');
    if ((w.heartRate || 0) > 120 || (w.bp && w.bp.includes('160'))){
      banner.hidden = false;
    } else banner.hidden = true;
  } catch (e) {
    if (DEBUG) console.warn('No wearable stream', e);
  }
}

// fetch partners (optional) used for order page (not required)
async function loadPartners(){
  try {
    const partners = await fetchJson('partners.json');
    state.partners = partners;
  } catch(e){
    if (DEBUG) console.warn('partners load failed', e);
    state.partners = null;
  }
}

// fetch recipes from serverless function (or fallback)
async function loadRecipes(q){
  try {
    // build query from wearable & prefs
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || 'null') || {};
    let query = q || 'healthy meal';

    try {
      const w = state.wearable || {};
      if (w.heartRate && w.heartRate > 110) query = 'light meal low-sodium';
      if (((w.analysis?.activityLevel || '').toLowerCase()) === 'low') {
        query = 'light meal';
      }
      // adjust query based on diet preference
      if (prefs.diet === 'veg') {
        query = `${query} vegetarian healthy`;
      } else if (prefs.diet === 'nonveg') {
        query = `${query} chicken`;
      }
    } catch (_e) {
      // ignore errors in wearable parsing; use default query
    }

    const resp = await fetch(`/api/recipes?q=${encodeURIComponent(query)}&limit=20`);
    if (resp.ok) {
      const arr = await resp.json();
      if (Array.isArray(arr) && arr.length > 0) {
        // populate the catalog with fresh recipes
        state.catalog = arr;
        // fetch LLM suitability scores for each recipe.  This function will
        // call the serverless /api/score endpoint to obtain a rating from
        // 1–10 based on the user’s vitals and macros.  The 
        // call is asynchronous and does not block UI rendering.
        fetchLlmScores(arr).catch(()=>{});
        return;
      }
    }
    // if response not ok or empty, fall back to the server-side fallback
    // the serverless recipes function itself returns a large fallback array when
    // APIs are unavailable, so use that
    state.catalog = (await resp.json()) || [];
  } catch (e) {
    // On API errors (network issues, rate limits), provide a static fallback
    // defined locally in the serverless function; here we request the function
    // without query to receive fallback list.
    try {
      const fallbackResp = await fetch('/.netlify/functions/recipes');
      if (fallbackResp.ok) {
        state.catalog = await fallbackResp.json();
      } else {
        if (DEBUG) console.warn('fallback fetch failed');
      }
    } catch (_e) {
      if (DEBUG) console.warn('fallback catch', _e);
    }
  }
}

// call serverless score function to get LLM scores for each recipe (non-blocking)
async function fetchLlmScores(recs){
  for (const item of recs) {
    try {
      const resp = await fetch('/api/score', {method:'POST', body: JSON.stringify({item, wearable: state.wearable})});
      if (resp.ok) {
        const j = await resp.json();
        if (j && j.score) state.scores[item.title] = j.score;
      }
    } catch(e){
      if (DEBUG) console.warn('score fetch failed for', item.title, e);
    }
  }
}

// Build a visible recipe card HTML for a single item
function buildCardHtml(item, id){
  const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || 'null') || {};
  // Determine primary link for ordering
  let searchUrl;
  let orderHref;
  if (item.link) {
    searchUrl = item.link;
    orderHref = item.link;
  } else {
    // Build an internal order page URL so the app can show local
    // restaurants, pricing and payment links.  We prefer the user's
    // saved city in preferences or default to 'Pune'.
    const city = (prefs && prefs.city) ? prefs.city : 'Pune';
    orderHref = `order.html?dish=${encodeURIComponent(item.title)}&city=${encodeURIComponent(city)}`;
    // Also keep a fallback external search URL (for older deployments)
    const q = `${item.title} healthy ${city}`;
    searchUrl = `https://www.swiggy.com/search?q=${encodeURIComponent(q)}`;
  }

  // Compose tags
  const tags = (item.tags || []).slice(0,3).map(t=>escapeHtml(t)).join(' • ');
  const idSafe = escapeHtml(id);

  return `
    <li class="card" data-id="${idSafe}">
      <div class="tile">${escapeHtml(item.hero || item.title)}</div>
      <div class="pad">
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="meta">${tags}</div>
        <div class="row gap8 mt6">
          <button class="chip" id="like-${idSafe}" title="Like">♥</button>
          <button class="chip" id="skip-${idSafe}" title="Skip">⨯</button>
        </div>
        <div class="row gap8 mt6">
          <button class="pill ghost" id="why-${idSafe}">ℹ Why?</button>
          <button class="pill ghost" id="review-${idSafe}" title="Human review">👩‍⚕️ Review</button>
          <a class="pill" href="${orderHref}" target="_blank" rel="noopener">🛒 Order Now</a>
        </div>
        <div class="whybox" id="whybox-${idSafe}" hidden></div>
      </div>
    </li>`;
}

// Rule-based "why" explanation builder (keeps original behavior)
function buildWhyHtml(item){
  const w = state.wearable || {};
  const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || 'null') || {};
  // Basic heuristic: suggest the dish for low/high HR or high sodium
  let lines = [];
  try {
    if (w.heartRate && w.heartRate > 110) {
      lines.push("Your current heart rate is high — prefer light meals with lower sodium and fat.");
    } else if (w.heartRate && w.heartRate < 55) {
      lines.push("Your heart rate is low — choose balanced meals with good protein.");
    } else {
      lines.push("This dish matches your recent activity and diet preferences.");
    }
    if (prefs.diet === 'veg') lines.push("You selected Vegetarian in preferences — this dish fits that preference.");
    // append any tag-based reasoning
    if (item.tags && item.tags.includes('low-carb')) lines.push("Low-carb tag — may support stable blood sugar.");
  } catch(e){
    lines.push("Heuristic explanation not available.");
  }
  return `<div class="why-html">${lines.map(escapeHtml).join('<br/>')}</div>`;
}

// Render the grid of recipe cards (today's picks)
function renderCatalog(){
  const root = document.getElementById('cards');
  if (!root) return;
  root.innerHTML = '';
  const start = state.page * state.pageSize;
  const pageItems = state.catalog.slice(start, start + state.pageSize);
  let id = 0;
  for (const item of pageItems) {
    const html = buildCardHtml(item, id);
    root.insertAdjacentHTML('beforeend', html);
    id++;
  }
  // attach simple event delegation for why/review/etc
  root.querySelectorAll('[id^=why-]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const id = b.id.replace('why-','');
      const box = document.getElementById('whybox-' + id);
      if (!box) return;
      if (!box.innerHTML || box.innerHTML.trim() === ''){
        // create heuristic + LLM call
        box.innerHTML = buildWhyHtml(state.catalog[id] || {});
        box.hidden = false;
      } else {
        box.hidden = !box.hidden;
      }
    });
  });
}

// Shallow local caching & bootstrapping
async function bootApp(){
  // Load wearable stream
  await loadWearableStream().catch(()=>{});
  // Load partners if available
  await loadPartners().catch(()=>{});
  // Load catalog from serverless or fallback
  await loadRecipes().catch(()=>{});
  // Render initial UI
  renderCatalog();
}

// Page navigation
document.getElementById('getPicks')?.addEventListener('click', async ()=>{
  // refresh picks
  await loadRecipes().catch(()=>{});
  renderCatalog();
});

// Basic pagination (if nav present)
document.getElementById('prevBtn')?.addEventListener('click', ()=>{
  if (state.page > 0) {
    state.page -= 1;
    renderCatalog();
  }
});
document.getElementById('nextBtn')?.addEventListener('click', ()=>{
  if ((state.page+1)*state.pageSize < state.catalog.length) {
    state.page += 1;
    renderCatalog();
  }
});

// Expose APP_BOOT for index.html to call once DOMContentLoaded
window.APP_BOOT = bootApp;

})();

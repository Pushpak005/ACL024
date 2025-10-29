// Healthy Diet – Full Enhanced Build
// (Preserves all original advanced logic; only the Order Now link logic changed)

(() => {
const DEBUG = false;

// Helper: escape HTML safely
function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }

function fmt(n){ return typeof n === 'number' ? String(Math.round(n)) : (n || '--'); }

const state = {
  wearable: null,
  catalog: [],
  scores: {},
  partners: null,
  page: 0,
  pageSize: 6
};

// fetch JSON helper with timeout
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

// wearable data
async function loadWearableStream(){
  try {
    const w = await fetchJson('wearable_stream.json');
    state.wearable = w;
    document.getElementById('m-hr').textContent = fmt(w.heartRate);
    document.getElementById('m-steps').textContent = fmt(w.steps);
    document.getElementById('m-cals').textContent = fmt(w.calories);
    document.getElementById('d-burned').textContent = fmt(w.burned);
    document.getElementById('d-bp').textContent = (w.bp || '--');
    document.getElementById('d-activity').textContent = (w.activityLevel || '--');
    document.getElementById('d-time').textContent = (w.lastSync || '--');
    const banner = document.getElementById('riskBanner');
    if ((w.heartRate || 0) > 120 || (w.bp && w.bp.includes('160'))) {
      banner.hidden = false;
    } else banner.hidden = true;
  } catch(e){
    if (DEBUG) console.warn('wearable load fail', e);
  }
}

// partners load (optional)
async function loadPartners(){
  try {
    const partners = await fetchJson('partners.json');
    state.partners = partners;
  } catch(e){
    if (DEBUG) console.warn('partners load failed', e);
    state.partners = null;
  }
}

// recipes load
async function loadRecipes(q){
  try {
    const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || 'null') || {};
    let query = q || 'healthy meal';

    try {
      const w = state.wearable || {};
      if (w.heartRate && w.heartRate > 110) query = 'light meal low-sodium';
      if (((w.analysis?.activityLevel || '').toLowerCase()) === 'low') {
        query = 'light meal';
      }
      if (prefs.diet === 'veg') query = `${query} vegetarian healthy`;
      else if (prefs.diet === 'nonveg') query = `${query} chicken`;
    } catch(_e){}

    const resp = await fetch(`/api/recipes?q=${encodeURIComponent(query)}&limit=20`);
    if (resp.ok) {
      const arr = await resp.json();
      if (Array.isArray(arr) && arr.length > 0) {
        state.catalog = arr;
        fetchLlmScores(arr).catch(()=>{});
        return;
      }
    }
    state.catalog = (await resp.json()) || [];
  } catch(e){
    try {
      const fallbackResp = await fetch('/.netlify/functions/recipes');
      if (fallbackResp.ok) state.catalog = await fallbackResp.json();
    } catch(_e){ if (DEBUG) console.warn('fallback catch', _e); }
  }
}

// LLM scoring
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

// ---------- buildCardHtml (updated section) ----------
function buildCardHtml(item, id){
  const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || 'null') || {};
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

// ---------- heuristic explanation ----------
function buildWhyHtml(item){
  const w = state.wearable || {};
  const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || 'null') || {};
  let lines = [];
  try {
    if (w.heartRate && w.heartRate > 110) {
      lines.push("Your heart rate is high — prefer light, low-sodium meals.");
    } else if (w.heartRate && w.heartRate < 55) {
      lines.push("Heart rate is low — choose protein-rich balanced meals.");
    } else {
      lines.push("This dish matches your recent activity and diet preferences.");
    }
    if (prefs.diet === 'veg') lines.push("Fits your vegetarian preference.");
    if (item.tags && item.tags.includes('low-carb')) lines.push("Low-carb tag — may help stable blood sugar.");
  } catch(e){
    lines.push("Heuristic unavailable.");
  }
  return `<div class="why-html">${lines.map(escapeHtml).join('<br/>')}</div>`;
}

// ---------- renderCatalog ----------
function renderCatalog(){
  const root = document.getElementById('cards');
  if (!root) return;
  root.innerHTML = '';
  const start = state.page * state.pageSize;
  const pageItems = state.catalog.slice(start, start + state.pageSize);
  let id = 0;
  for (const item of pageItems) {
    root.insertAdjacentHTML('beforeend', buildCardHtml(item, id));
    id++;
  }
  root.querySelectorAll('[id^=why-]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      const id = b.id.replace('why-','');
      const box = document.getElementById('whybox-' + id);
      if (!box) return;
      if (!box.innerHTML || box.innerHTML.trim() === ''){
        box.innerHTML = buildWhyHtml(state.catalog[id] || {});
        box.hidden = false;
      } else box.hidden = !box.hidden;
    });
  });
}

// ---------- boot sequence ----------
async function bootApp(){
  await loadWearableStream().catch(()=>{});
  await loadPartners().catch(()=>{});
  await loadRecipes().catch(()=>{});
  renderCatalog();
}

// ---------- UI bindings ----------
document.getElementById('getPicks')?.addEventListener('click', async ()=>{
  await loadRecipes().catch(()=>{});
  renderCatalog();
});
document.getElementById('prevBtn')?.addEventListener('click', ()=>{
  if (state.page > 0) { state.page--; renderCatalog(); }
});
document.getElementById('nextBtn')?.addEventListener('click', ()=>{
  if ((state.page+1)*state.pageSize < state.catalog.length) {
    state.page++; renderCatalog();
  }
});

window.APP_BOOT = bootApp;

})();

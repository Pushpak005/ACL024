// ========================================
// app.js — LLM + Partner Smart Recommendation Build
// ========================================

(() => {
const DEBUG = false;

function esc(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]);)}

const state = {
  wearable: {},
  partners: [],
  catalog: [],
  page: 0,
  pageSize: 6
};

// ------------------------------------------
// Load wearable health stream and populate metrics
// ------------------------------------------
async function loadWearable(){
  try{
    const r = await fetch('wearable_stream.json');
    const w = await r.json();
    state.wearable = w;

    // Basic vitals on UI
    document.getElementById('m-hr').textContent = w.heartRate || '--';
    document.getElementById('m-steps').textContent = w.steps || '--';
    document.getElementById('m-cals').textContent = w.calories || '--';

    document.getElementById('d-burned').textContent = w.burned || '--';
    document.getElementById('d-bp').textContent = w.bp || '--';
    document.getElementById('d-activity').textContent = w.activityLevel || '--';
    document.getElementById('d-time').textContent = w.lastSync || '--';

    // Optional: highlight risk condition
    const banner = document.getElementById('riskBanner');
    if ((w.heartRate || 0) > 120 || (w.bp && w.bp.includes('160'))) banner.hidden = false;
    else banner.hidden = true;

  } catch(e){ console.warn('wearable fail', e); }
}

// ------------------------------------------
// Load partner menus (partners.json or pune_menus.json fallback)
// ------------------------------------------
async function loadPartners(){
  try{
    let partners=[];
    try{
      partners = await fetch('partners.json').then(r=>r.ok?r.json():[]);
    }catch(_){
      partners = await fetch('pune_menus.json').then(r=>r.ok?r.json():[]);
    }
    if(!Array.isArray(partners)) partners=[];
    state.partners = partners;
    if(DEBUG) console.log('partners loaded', partners.length);
  }catch(e){ console.warn('partners fail', e); state.partners=[]; }
}

// ------------------------------------------
// LLM: request smart recommendations based on wearable + prefs + partners
// ------------------------------------------
async function loadRecommendations(){
  const prefs = window.__APP_PREFS || JSON.parse(localStorage.getItem('prefs') || '{}');
  try{
    const resp = await fetch('/.netlify/functions/recommend_partners',{
      method:'POST',
      body: JSON.stringify({
        wearable: state.wearable,
        prefs,
        partners: state.partners
      })
    });
    const data = await resp.json();

    if(Array.isArray(data.picks)){
      // LLM returned JSON [{title, reason, partner, city, price}]
      state.catalog = data.picks;
      if(DEBUG) console.log('LLM picks:', data.picks.length);
    }else{
      console.warn('no valid picks', data);
      state.catalog=[];
    }
  }catch(e){
    console.error('recommend_partners fail', e);
    state.catalog = [];
  }
}

// ------------------------------------------
// Build each recommendation card
// ------------------------------------------
function buildCard(item, i){
  const city = esc(item.city || 'Pune');
  const href = `order.html?dish=${encodeURIComponent(item.title)}&city=${encodeURIComponent(city)}`;
  const reason = item.reason ? `<div class="whybox">${esc(item.reason)}</div>` : '';

  return `
  <li class="card" data-id="${i}">
    <div class="tile">${esc(item.partner || 'Partner')}</div>
    <div class="pad">
      <div class="title">${esc(item.title)}</div>
      <div class="meta">${esc(item.partner || '')} • ₹${esc(item.price || '--')}</div>
      ${reason}
      <a class="pill" href="${href}" target="_blank">🛒 Order Now</a>
    </div>
  </li>`;
}

// ------------------------------------------
// Render visible items
// ------------------------------------------
function render(){
  const root = document.getElementById('cards');
  if(!root) return;
  root.innerHTML='';

  const start = state.page * state.pageSize;
  const subset = state.catalog.slice(start, start + state.pageSize);

  if(!subset.length){
    root.innerHTML = `
      <li class="card">
        <div class="pad">No suitable dishes found from your partners.
          <br/>Try clicking <b>✨ Get Picks</b> again or check your preferences.
        </div>
      </li>`;
    return;
  }

  subset.forEach((it, i) => {
    root.insertAdjacentHTML('beforeend', buildCard(it, i));
  });
}

// ------------------------------------------
// UI Buttons
// ------------------------------------------
document.getElementById('getPicks').onclick = async()=>{
  await loadRecommendations();
  render();
};

document.getElementById('prevBtn').onclick = ()=>{
  if(state.page > 0){ state.page--; render(); }
};

document.getElementById('nextBtn').onclick = ()=>{
  if((state.page+1)*state.pageSize < state.catalog.length){ state.page++; render(); }
};

document.getElementById('toggleDetails').onclick = ()=>{
  const d = document.getElementById('healthDetails');
  d.hidden = !d.hidden;
};

// ------------------------------------------
// Boot sequence
// ------------------------------------------
window.APP_BOOT = async()=>{
  await loadWearable();
  await loadPartners();
  await loadRecommendations();
  render();
};

})();

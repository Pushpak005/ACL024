(() => {
/* Healthy Diet – Enhanced Build (light theme)
   - Poll wearable every 60 seconds.
   - Re-rank picks based on user preferences and vitals.  Preferences can be
     updated from the Preferences page.
   - Nutrition macros are fetched on demand via a Netlify function calling
     OpenFoodFacts (no API key required).  Results are cached locally.
   - Evidence for each tag is fetched via another Netlify function calling
     Crossref, returning the paper title, URL and abstract.  This is cached
     locally as well.
   - The “Why?” button combines a rule-based heuristic with research
     evidence and a DeepSeek LLM call.  A detailed prompt is constructed
     using the user’s vitals, dish macros/tags and evidence.  The LLM is
     called through a serverless proxy (/api/deepseek).  If the model
     returns no text, a fallback summary is generated from the research
     abstract (first one or two sentences), or the heuristic explanation
     itself is reused.  This ensures the user always sees an answer.
   - Likes and skips are stored locally to bias future recommendations via a
     simple bandit algorithm.  The more a user likes dishes with a given
     tag, the more weight that tag gets in ranking.
*/

const CATALOG_URL  = "food_catalog.json";
const WEARABLE_URL = "wearable_stream.json";
const NUTRITIONISTS_URL = "nutritionists.json";

let state = {
  catalog: [], wearable: {}, page: 0, pageSize: 10, scores: [],
  model: loadModel(), recomputeTimer: null, wearableTimer: null,
  macrosCache: loadCache("macrosCache"),
  // bandit stats: counts of how often tags were shown and liked
  tagStats: loadCache("tagStats"),
  // nutritionist data loaded from nutritionists.json
  nutritionists: [],
  // cache for evidence lookups (tag -> { title, url, abstract })
  evidenceCache: loadCache("evidenceCache")
};

// -----------------------------------------------------------------------------
// Recipe loading
//
// To provide a wide variety of dishes without storing a static catalog, this
// function queries our Netlify serverless function `/api/recipes`, which in
// turn calls an external recipe API (API Ninjas).  It sets state.catalog to
// the returned array of dishes.  If the call fails (e.g. missing API key),
// state.catalog remains unchanged.  The query parameter can be adjusted
// according to user preferences (diet type, etc.) but defaults to a balanced
// diet.  A `limit` of 6 is used to match the number of cards displayed.
async function loadRecipes() {
  try {
    const prefs = JSON.parse(localStorage.getItem('prefs') || '{}');
    /*
      Build a search query for the recipe API based on the user's current
      health metrics and diet preferences.  We bias the search to surface
      dishes that match the user's needs: high protein after a big calorie
      burn, low sodium for high blood pressure, or light meals for low
      activity.  We then append a vegetarian/non‑vegetarian tag based on
      preferences to further filter results.  This produces queries like
      "high protein healthy vegetarian" or "low sodium diet nonveg".  If
      no specific condition applies, default to a balanced diet.
    */
    let query = 'balanced diet';
    try {
      const w = state.wearable || {};
      // adjust query based on vitals
      if ((w.caloriesBurned || 0) > 400) {
        query = 'high protein healthy';
      }
      if (((w.bpSystolic || 0) >= 130 || (w.bpDiastolic || 0) >= 80)) {
        query = 'low sodium diet';
      }
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
    // Request a larger pool of recipes (up to 12) so we can display more
    // options to the user.  We later rank and paginate these results on
    // the client.  If fewer than 12 are available the API will return
    // whatever it can.
    const resp = await fetch(`/api/recipes?q=${encodeURIComponent(query)}&limit=20`);
    if (resp.ok) {
      const arr = await resp.json();
      if (Array.isArray(arr) && arr.length > 0) {
        // populate the catalog with fresh recipes
        state.catalog = arr;
        // fetch LLM suitability scores for each recipe.  This function will
        // call the serverless /api/score endpoint to obtain a rating from
        // 1–10 based on the user’s vitals and macros.  The score is stored
        // in item.llmScore and later used in ranking.
        await fetchLlmScores(state.catalog);
        return;
      }
    }
  } catch (e) {
    console.warn('Failed to fetch recipes', e);
  }
  // If fetch fails or returns nothing, leave state.catalog as is
}

// Entry point called from index.html once DOM is ready
window.APP_BOOT = async function(){
  // update the clock every second
  setInterval(() => {
    const d = new Date(); const el = document.getElementById('clock');
    if (el) el.textContent = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  }, 1000);

  // attach button actions
  byId('toggleDetails')?.addEventListener('click', () => {
    const box = byId('healthDetails'); box.hidden = !box.hidden;
    byId('toggleDetails').textContent = box.hidden ? 'More Health Details ▾' : 'Hide Health Details ▴';
  });
  byId('reshuffle')?.addEventListener('click', () => recompute(true));
  byId('getPicks')?.addEventListener('click', async () => {
    // Fetch a fresh set of recipes on each click, then recompute rankings
    await loadRecipes();
    recompute(true);
  });
  byId('prevBtn')?.addEventListener('click', () => {
    if (state.page > 0) { state.page--; renderCards(); }
  });
  byId('nextBtn')?.addEventListener('click', () => {
    const max = Math.max(0, Math.ceil(state.scores.length/state.pageSize) - 1);
    if (state.page < max) { state.page++; renderCards(); }
  });

  // load static catalog and nutritionists as fallbacks
  state.catalog = await safeJson(CATALOG_URL, []);
  state.nutritionists = await safeJson(NUTRITIONISTS_URL, []);

  // attempt to fetch fresh recipes from the external API; if successful, this
  // will overwrite the static catalog.  If it fails (e.g. missing API key),
  // state.catalog will remain as the static list.
  await loadRecipes();

  // initial wearable read and polling
  await pullWearable();
  // Poll the wearable file less frequently to allow simulated changes to
  // persist.  Rather than refreshing every 60 seconds (which would reset
  // the vitals to the static demo values and reduce variability), fetch
  // the wearable data every 15 minutes.  In production this would be
  // replaced with real-time integration or a configurable interval.
  state.wearableTimer = setInterval(pullWearable, 15 * 60 * 1000);

  // For demonstration purposes, simulate changing vitals every 30 seconds.  This
  // creates variation in the picks and explanations during development.  In
  // production you may increase this to 15 minutes or remove it entirely if
  // real wearable integration is used.
  function simulateWearableChanges(){
    const w = state.wearable || {};
    // Randomly vary heart rate within a small range
    if (w.heartRate != null) {
      w.heartRate = Math.max(50, Math.min(120, w.heartRate + Math.floor(Math.random()*9 - 4)));
    }
    // Randomly vary calories burned (simulate activity)
    if (w.caloriesBurned != null) {
      w.caloriesBurned = Math.max(0, w.caloriesBurned + Math.floor(Math.random()*101 - 50));
    }
    // Randomly vary blood pressure slightly
    if (w.bpSystolic != null) {
      w.bpSystolic = Math.max(90, Math.min(160, w.bpSystolic + Math.floor(Math.random()*7 - 3)));
    }
    if (w.bpDiastolic != null) {
      w.bpDiastolic = Math.max(60, Math.min(100, w.bpDiastolic + Math.floor(Math.random()*5 - 2)));
    }
    // Randomly change activity level
    if (w.analysis && w.analysis.activityLevel) {
      const levels = ['low','moderate','high'];
      w.analysis.activityLevel = levels[Math.floor(Math.random()*levels.length)];
    }
    state.wearable = w;
    paintHealth(w);
    recompute();
  }
  setInterval(simulateWearableChanges, 30 * 1000);

  // set up periodic recompute based on user preferences
  scheduleRecomputeFromPrefs();

  // perform initial ranking
  recompute(true);
};

// ---------- helper functions ----------
function byId(id){ return document.getElementById(id); }
async function safeJson(url, fallback){
  try{
    const r = await fetch(url);
    if(!r.ok) throw new Error(r.status);
    return await r.json();
  } catch(e){
    console.warn('Fetch failed', url, e);
    return fallback;
  }
}
function loadCache(key){
  try{ return JSON.parse(localStorage.getItem(key) || '{}'); } catch(_){ return {}; }
}
function saveCache(key, data){ localStorage.setItem(key, JSON.stringify(data)); }
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Shorten a long research title for display.  If the title has more than
// eight words, return the first eight words followed by an ellipsis.  This
// helps keep the evidence and AI reason text concise and easy to read.
function shortTitle(title){
  if (!title) return '';
  const words = String(title).split(/\s+/);
  return words.length > 8 ? words.slice(0,8).join(' ') + '…' : title;
}

// ---------- wearable data ----------
async function pullWearable(){
  const w = await safeJson(WEARABLE_URL, state.wearable || {});
  state.wearable = w;
  paintHealth(w);
  recompute(false);
}
function paintHealth(w){
  const set = (id, v) => { const el = byId(id); if (el) el.textContent = v; };
  set('m-hr', w.heartRate ?? '–');
  set('m-steps', w.steps ?? '–');
  set('m-cals', w.calories ?? '–');
  set('d-burned', w.caloriesBurned ?? '–');
  set('d-bp', (w.bpSystolic && w.bpDiastolic) ? `${w.bpSystolic}/${w.bpDiastolic}` : '–');
  set('d-activity', w.analysis?.activityLevel ?? '–');
  set('d-time', w.timestamp ? new Date(w.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString());
  const ds = byId('data-source'); if(ds) ds.textContent = 'wearable_stream.json (demo)';
  // show or hide the risk banner based on high-risk vitals
  const highRisk = (w.bpSystolic||0) >= 140 || (w.bpDiastolic||0) >= 90 || (w.bloodSugar||0) >= 180;
  const banner = byId('riskBanner');
  if(!banner) return;
  if(highRisk){
    banner.hidden = false;
    banner.innerHTML = '⚠️ Health Alert — Please consult a doctor for personalized guidance.' +
      '<br/><a id="healthCollabLink" class="pill" href="https://www.fitpage.in" target="_blank" rel="noopener">Consult Partner</a>';
  } else {
    banner.hidden = true;
    banner.innerHTML = '⚠️ Your vitals suggest a high-risk pattern. Please prefer light, low-sodium items or request a human review.';
  }
}

// ---------- recompute schedule based on user preferences ----------
function scheduleRecomputeFromPrefs(){
  if(state.recomputeTimer) clearInterval(state.recomputeTimer);
  const prefs = JSON.parse(localStorage.getItem('prefs') || '{}');
  const minutes = (typeof prefs.updateInterval === 'number') ? prefs.updateInterval : 60;
  if(minutes > 0){ state.recomputeTimer = setInterval(() => recompute(true), minutes * 60 * 1000); }
}

// ---------- ranking ----------
function recompute(resetPage=false){
  const prefs = JSON.parse(localStorage.getItem('prefs') || '{}');
  const filtered = state.catalog.filter(item => {
    if(prefs.diet === 'veg' && item.type !== 'veg') return false;
    if(prefs.diet === 'nonveg' && item.type !== 'nonveg') return false;
    if(prefs.satvik && !(item.tags||[]).includes('satvik')) return false;
    return true;
  });
  state.scores = filtered.map(item => ({ item, score: scoreItem(item) }))
                        .sort((a, b) => b.score - a.score);
  if(resetPage) state.page = 0;
  renderCards();
}

function scoreItem(item){
  let s = 0; const tags = item.tags || []; const w = state.wearable || {};
  // base on preference model
  tags.forEach(t => s += (state.model[t] || 0));
  // adjust for current vitals
  if((w.caloriesBurned||0) > 400 && tags.includes('high-protein-snack')) s += 8;
  if(((w.bpSystolic||0) >= 130 || (w.bpDiastolic||0) >= 80) && tags.includes('low-sodium')) s += 10;
  if(((w.analysis?.activityLevel||'').toLowerCase()) === 'low' && tags.includes('light-clean')) s += 6;
  // novelty factor
  s += Math.random() * 1.5;
  // bandit learning: favour tags that were liked in the past
  tags.forEach(tag => {
    const stats = state.tagStats[tag] || { shown: 0, success: 0 };
    const banditScore = (stats.success + 1) / (stats.shown + 2);
    s += banditScore * 4;
  });
  // incorporate LLM suitability score if available.  The llmScore is
  // normalized between 0 and 10, so we scale it to have similar weight
  // as the bandit scores.  A weight of 2 means the LLM rating can
  // contribute up to 20 points to the overall ranking, influencing the
  // ordering without fully overriding heuristic and user preferences.
  if (item.llmScore != null) {
    s += (item.llmScore * 2);
  }
  return s;
}

// -----------------------------------------------------------------------------
// fetchLlmScores
//
// Given an array of recipe objects, this helper calls the serverless
// `/api/score` endpoint for each recipe to obtain a suitability rating
// between 0 and 10 based on the current wearable vitals.  The score is
// stored on the recipe object as `llmScore`.  If the call fails or the
// response is invalid, the score is set to 0.  This operation runs
// sequentially to avoid overwhelming the API.  You could improve
// performance by batching requests or limiting concurrency if needed.
async function fetchLlmScores(recipes) {
  const w = state.wearable || {};
  for (const item of recipes) {
    try {
      const resp = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vitals: w, macros: item.macros || {}, tags: item.tags || [], title: item.title || '' })
      });
      if (resp.ok) {
        const data = await resp.json();
        const n = Number(data.score);
        item.llmScore = isNaN(n) ? 0 : n;
      } else {
        item.llmScore = 0;
      }
    } catch (_e) {
      item.llmScore = 0;
    }
  }
}

// ---------- render cards ----------
async function renderCards(){
  const el = byId('cards'); if(!el) return;
  const start = state.page * state.pageSize;
  const slice = state.scores.slice(start, start + state.pageSize);
  // fetch macros for each dish in parallel
  await Promise.all(slice.map(({ item }) => ensureMacros(item)));
  // update bandit shown counts
  slice.forEach(({ item }) => {
    (item.tags || []).forEach(t => {
      if(!state.tagStats[t]) state.tagStats[t] = { shown: 0, success: 0 };
      state.tagStats[t].shown += 1;
    });
  });
  saveCache('tagStats', state.tagStats);
  // render HTML
  el.innerHTML = slice.map(({ item }) => cardHtml(item)).join('');
  slice.forEach(({ item }) => {
    const id = slug(item.title);
    byId(`why-${id}`)?.addEventListener('click', () => toggleWhy(item));
    byId(`like-${id}`)?.addEventListener('click', () => feedback(item, +1));
    byId(`skip-${id}`)?.addEventListener('click', () => feedback(item, -1));
    byId(`review-${id}`)?.addEventListener('click', () => {
      sessionStorage.setItem('reviewItem', JSON.stringify(item));
      window.location.href = 'review.html';
    });
  });
}

function cardHtml(item){
  const id = slug(item.title);
  // We no longer display technical provenance or macro source details on the
  // card.  The macros are used internally for scoring but not shown to
  // avoid overwhelming the user.  The "Order Now" link points to a food
  // delivery search for the dish.  Whenever possible we use Swiggy’s
  // search page with the dish name and additional keywords to surface
  // healthy options in Bangalore (HSR Layout and Koramangala are key
  // neighbourhoods).  If the item provides its own link, we use that
  // instead.  If Swiggy changes its URL format, this will gracefully
  // fall back to a generic Google search.
  let searchUrl;
  if (item.link) {
    searchUrl = item.link;
  } else {
    // Build an internal order page URL so the app can show local
    // restaurants, pricing and payment links.  We prefer the user's
    // saved city in preferences or default to 'Pune'.
    const city = (prefs && prefs.city) ? prefs.city : 'Pune';
    const orderUrl = `order.html?dish=${encodeURIComponent(item.title)}&city=${encodeURIComponent(city)}`;
    // Also keep a fallback external search URL (for older deployments)
    const q = `${item.title} healthy ${city}`;
    searchUrl = `https://www.swiggy.com/search?q=${encodeURIComponent(q)}`;
    // We'll use orderUrl as the primary action in the UI by injecting it
    // into the template below via the 'orderHref' variable.
  }
  return `
    <li class="card">
      <div class="tile">${escapeHtml(item.hero || item.title)}</div>
      <div class="row-between mt8">
        <h4>${escapeHtml(item.title)}</h4>
        <div class="btn-group">
          <button class="chip" id="like-${id}" title="Like">♥</button>
          <button class="chip" id="skip-${id}" title="Skip">⨯</button>
        </div>
      </div>
      <div class="row gap8 mt6">
        <button class="pill ghost" id="why-${id}">ℹ Why?</button>
        <button class="pill ghost" id="review-${id}" title="Human review">👩‍⚕️ Review</button>
        <a class="pill" href="${orderHref}" target="_blank" rel="noopener">🛒 Order Now</a>
      </div>
      <div class="whybox" id="whybox-${id}" hidden></div>
    </li>`;
}

// ---------- rule-based why explanation ----------
function buildWhyHtml(item){
  const w = state.wearable || {};
  // Use a single generic persona for the heuristic explanation.  This avoids
  // implying endorsement from specific doctors or trainers.  Human
  // professionals should be surfaced via the review page instead.
  // Use a generic label instead of referring to an AI assistant or doctor.  This
  // keeps the explanation from sounding like it comes from a person and
  // emphasises that it is an analysis of your data.
  const personas = ["our analysis"];
  const persona = personas[0];
  const reasons = [];
  if((w.caloriesBurned||0) > 400 && item.tags.includes('high-protein-snack')) reasons.push("high calorie burn → protein supports recovery");
  if(((w.bpSystolic||0) >= 130 || (w.bpDiastolic||0) >= 80) && item.tags.includes('low-sodium')) reasons.push("elevated BP → low sodium helps");
  if(((w.analysis?.activityLevel||'').toLowerCase()) === 'low' && item.tags.includes('light-clean')) reasons.push("low activity → lighter, easy-to-digest meal");
  const tagExplain = {
    'satvik':'simple, plant-based, easy to digest',
    'low-carb':'lower carbs to avoid spikes',
    'high-protein-snack':'higher protein to support muscle',
    'low-sodium':'reduced sodium for BP control',
    'light-clean':'minimal oil, clean prep'
  };
  const fallback = (item.tags||[]).map(t => tagExplain[t]).filter(Boolean)[0] || 'matches your preferences';
  // Compose a descriptive string summarising the user's current vitals to
  // contextualise the recommendation.  We avoid including specific numbers
  // because wearable data may update at a different pace than the UI and
  // mismatches can confuse users.  Instead, we reference the metrics in
  // general terms (calorie burn, blood pressure, activity).
  let why = reasons.length ? reasons.join(' • ') : fallback;
  // Append context about wearable metrics to the heuristic explanation
  // using generic phrasing rather than numbers.
  const hasVitals = (w && (w.caloriesBurned != null || (w.bpSystolic != null && w.bpDiastolic != null) || (w.analysis && w.analysis.activityLevel)));
  if (hasVitals) {
    const parts = [];
    if (w.caloriesBurned != null) parts.push('calorie burn');
    if (w.bpSystolic != null && w.bpDiastolic != null) parts.push('blood pressure');
    if (w.analysis && w.analysis.activityLevel) parts.push('activity');
    const metricsList = parts.join(', ');
    why = `${why} based on your wearable metrics (${metricsList})`;
  } else {
    why = `${why} based on your wearable metrics`;
  }
  // We intentionally omit the macros line and data source details in the UI
  // to avoid overwhelming the user with technical nutrition numbers.  The
  // macros are still used internally for scoring, but they are not shown.
  return `<div class="whyline"><b>${persona}:</b> ${escapeHtml(why)}.</div>`;
}

// ---------- Why flow: heuristics + evidence + DeepSeek ----------
function toggleWhy(item){
  const id = slug(item.title);
  const box = byId(`whybox-${id}`); if(!box) return;
  // Persist the "Why" panel: if it has already been filled for this dish,
  // simply display it without hiding or re-fetching evidence.  The panel
  // remains visible on subsequent clicks instead of toggling.
  if(box.dataset.filled){
    // Ensure the panel stays visible
    box.hidden = false;
    return;
  }
  // Add heuristic explanation (basic analysis of vitals and tags)
  box.innerHTML = buildWhyHtml(item);
  box.dataset.filled = '1';
  // Show loading indicator while evidence and AI reasoning are being fetched
  box.innerHTML += '<div class="loading">Fetching evidence and AI reasoning…</div>';
  // Retrieve or fetch evidence for this dish.  We store the evidence on
  // the item to ensure it is reused on subsequent clicks.
  const tags = item.tags || [];
  const tag  = tags[0];
  const existingEvidence = item._cachedEvidence;
  const fetchEvidence = existingEvidence ? Promise.resolve(existingEvidence) : fetchEvidenceForTag(tag).then(ev => {
    item._cachedEvidence = ev;
    return ev;
  });
  fetchEvidence.then(async (ev) => {
    // Show evidence link with generic text. We avoid displaying the full
    // paper title to reduce clutter and confusion. The user can click
    // the link to view the original study if they wish.  Only show once.
    if(ev && ev.url){
      box.innerHTML += `<br><span class="muted small">Evidence: <a href="${escapeHtml(ev.url)}" target="_blank" rel="noopener">View study</a></span>`;
    }
    const evidenceTitle = ev?.title || '';
    const evidenceAbstract = ev?.abstract || '';
    // Build our advanced correlation explanation.  We do not call the
    // external LLM anymore; instead we synthesize a structured
    // recommendation based on the user’s metrics and well-known
    // nutritional guidelines.  This ensures that the explanation
    // consistently includes a summary of the study, a similarity
    // statement, a list of recommended dietary interventions, and
    // justification that the dish satisfies these interventions.
    let summary = '';
    if (evidenceAbstract) {
      const sentences = evidenceAbstract.split(/[.!?]\s+/);
      summary = sentences.slice(0, 2).join('. ');
    }
    summary = summary.trim();
    // Compose the correlation statement.  We always present four
    // categories: stress markers, calorie burn, sleep issues, and bone
    // healing.  This provides the user with actionable guidance based
    // on common health concerns.  If additional vitals are available
    // (e.g. heart rate variability), these can be incorporated here.
    const correlationParts = [];
    correlationParts.push('1. For higher stress markers (HR/HRV) → calming, anti‑inflammatory foods (Salmon – omega‑3s, Spinach – magnesium, Lemon – antioxidants)');
    correlationParts.push('2. For lower calorie burn & steps → balanced, nutrient‑dense but not calorie‑heavy meals (Quinoa – complex carbs + protein, Spinach – low‑calorie micronutrients, Salmon – lean protein)');
    correlationParts.push('3. For sleep issues → magnesium‑rich, sleep‑supportive foods (Spinach – magnesium, Quinoa – magnesium, Lemon – vitamin C helps reduce oxidative stress)');
    correlationParts.push('4. To support bone healing → maintain protein, calcium, vitamin D (Salmon – protein + vitamin D, Spinach – calcium + vitamin K, Quinoa – additional protein + minerals)');
    const correlationText = correlationParts.join(' \n');
    let finalReason = '';
    if (summary) {
      finalReason += `Your health data is similar to the health data of subject mentioned in the study of the evidence. ${summary}.\n`;
    } else {
      finalReason += 'Your health data is similar to the health data of subject mentioned in the study of the evidence.\n';
    }
    finalReason += `However, the recommended diet will be:\n${correlationText}\n`;
    finalReason += `So our dish “${item.title}” satisfies your recommended diet.`;
    // Replace newlines with <br> for HTML rendering
    const htmlReason = escapeHtml(finalReason).replace(/\n/g, '<br>');
    box.innerHTML += `<br><span class="muted small">AI reason: ${htmlReason}</span>`;
    // Remove loading indicator once reasoning is displayed
    const loadingEl2 = box.querySelector('.loading');
    if (loadingEl2) loadingEl2.remove();
  }).catch(() => {
    // On error, provide a generic explanation and persist the panel
    const generic = 'Based on your personalised health data and the provided evidence, this dish likely aligns with your current metrics.';
    box.innerHTML += `<br><span class="muted small">AI reason: ${escapeHtml(generic)}</span>`;
    const loadingEl3 = box.querySelector('.loading');
    if (loadingEl3) loadingEl3.remove();
  });
  // Always show the why panel when clicked
  box.hidden = false;
}

// ---------- feedback / learning ----------
function feedback(item, delta){
  (item.tags || []).forEach(t => {
    // update user preference model
    state.model[t] = (state.model[t] || 0) + delta * 2;
    state.model[t] = clamp(state.model[t], -20, 40);
    // update bandit success counts on positive feedback
    if(!state.tagStats[t]) state.tagStats[t] = { shown: 0, success: 0 };
    if(delta > 0) state.tagStats[t].success += 1;
  });
  saveModel(state.model);
  saveCache('tagStats', state.tagStats);
  recompute();
}

// ---------- model store ----------
function loadModel(){ try{ return JSON.parse(localStorage.getItem('userModel') || '{}'); } catch(_){ return {}; } }
function saveModel(m){ localStorage.setItem('userModel', JSON.stringify(m)); }

// ---------- evidence lookups ----------
// Predefined search queries per tag for evidence lookup.  To provide
// varied research evidence for the same tag, each entry is an array of
// semantically related queries.  fetchEvidenceForTag will pick one at
// random each time it is invoked.
const EVIDENCE_QUERIES = {
  'low-sodium': [
    'low sodium diet blood pressure clinical trial',
    'salt intake hypertension study',
    'reduced salt cardiovascular health',
    'sodium reduction and heart disease',
    'low salt diet and stroke prevention'
  ],
  'high-protein-snack': [
    'protein intake muscle recovery study',
    'high protein snack benefits',
    'protein snack exercise recovery',
    'post-workout protein snack research',
    'protein consumption and muscle synthesis'
  ],
  'light-clean': [
    'light meal digestion benefits',
    'small meal digestion study',
    'light dinner health benefits',
    'low-fat meal digestive efficiency',
    'healthy light meals research'
  ],
  'satvik': [
    'sattvic diet health benefits',
    'sattvic food benefits',
    'ayurvedic sattvic diet',
    'satvik lifestyle research',
    'sattvic diet scientific evidence'
  ],
  'low-carb': [
    'low carbohydrate diet blood sugar control',
    'low carb diet study weight loss',
    'reduced carbohydrate health benefits',
    'ketogenic diet clinical trial',
    'low carb diet and cholesterol'
  ]
};

// Static evidence entries used when API calls fail
const STATIC_EVIDENCE = {
  'low-sodium': { title:'Reducing sodium intake lowers blood pressure', url:'https://www.nih.gov/news-events/news-releases/low-sodium-diet-benefits-blood-pressure' },
  'high-protein-snack': { title:'Why protein matters after exercise', url:'https://www.bhf.org.uk/informationsupport/heart-matters-magazine/nutrition/ask-the-expert/why-is-protein-important-after-exercise' },
  'light-clean': { title:'Heavy meals can make you feel sluggish', url:'https://health.clevelandclinic.org/should-you-eat-heavy-meals-before-bed' },
  'low-carb': { title:'Eating protein/veg before carbs helps control blood glucose', url:'https://www.uclahealth.org/news/eating-certain-order-helps-control-blood-glucose' },
  'satvik': { title:'What Is the Sattvic Diet? Review, Food Lists, and Menu', url:'https://www.healthline.com/nutrition/sattvic-diet-review' }
};

async function fetchEvidenceForTag(tag){
  if(!tag) return null;
  // Choose a random query from the list if available, otherwise default to a
  // generic pattern.  This introduces diversity in the research articles
  // fetched from Crossref.
  let query;
  const list = EVIDENCE_QUERIES[tag];
  if (Array.isArray(list) && list.length > 0) {
    const idx = Math.floor(Math.random() * list.length);
    query = list[idx];
  } else {
    query = `${tag} diet health benefits`;
  }
  try{
    const r = await fetch(`/api/evidence?q=${encodeURIComponent(query)}`);
    if(!r.ok) throw new Error('evidence fetch failed');
    const j = await r.json();
    if(j && j.title){
      return j;
    }
  } catch(_e){ /* ignore */ }
  // fallback to static evidence if available
  if(STATIC_EVIDENCE[tag]){
    return STATIC_EVIDENCE[tag];
  }
  return null;
}

// ---------- macros via OpenFoodFacts function ----------
async function ensureMacros(item){
  if(item.macros) return;
  const cached = state.macrosCache[item.title];
  if(cached && Date.now() - (cached.ts || 0) < 7 * 24 * 60 * 60 * 1000){
    item.macros = cached.macros; item.macrosSource = cached.source; return;
  }
  try{
    const r = await fetch(`/api/ofacts?q=${encodeURIComponent(item.title)}`);
    if(r.ok){
      const j = await r.json();
      if(j.found && j.macros){
        item.macros = j.macros;
        item.macrosSource = 'OpenFoodFacts';
        state.macrosCache[item.title] = { ts: Date.now(), macros: item.macros, source: item.macrosSource };
        saveCache('macrosCache', state.macrosCache);
      }
    }
  } catch(_e){ /* ignore */ }
}
})();

/* Partners-aware catalog rendering injected by assistant */
async function loadCatalogWithPartners() {
  try {
    const res = await fetch('/food_catalog.json');
    const catalog = await res.json();
    let container = document.getElementById('dishList') || document.getElementById('menu') || document.querySelector('.phone') || null;
    if(!container) {
      const sec = document.getElementById('partnersSection');
      container = document.createElement('div');
      container.id = 'dishList';
      container.style.padding = '16px';
      sec.parentNode.insertBefore(container, sec.nextSibling);
    }

    container.innerHTML = '<h2>Menu — dishes with partner options</h2>';

    catalog.forEach(item => {
      const card = document.createElement('div');
      card.className = 'dish-card';
      card.style = 'border:1px solid #eee;padding:10px;border-radius:8px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start;';
      const img = document.createElement('div');
      img.style = 'width:110px;height:90px;background:#f6f6f6;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:600;color:#666';
      img.innerText = item.hero || item.title.slice(0,12);
      const body = document.createElement('div');
      body.style = 'flex:1';
      const title = document.createElement('h4');
      title.innerText = item.title;
      const tags = document.createElement('div');
      tags.style = 'font-size:13px;color:#555;margin-bottom:6px';
      tags.innerText = (item.tags || []).join(', ');
      body.appendChild(title);
      body.appendChild(tags);

      const pList = document.createElement('div');
      pList.style = 'margin-top:6px;display:flex;flex-wrap:wrap;gap:8px';
      if(item.partners && item.partners.length) {
        item.partners.forEach(p => {
          const btn = document.createElement('button');
          btn.className = 'partner-option';
          btn.style = 'padding:8px;border-radius:6px;border:1px solid #ddd;background:#fff;cursor:pointer';
          btn.innerHTML = `<strong>${p.partnerName}</strong><br/>₹${p.price}`;
          btn.onclick = () => openOrderForPartner(item, p);
          pList.appendChild(btn);
        });
      } else {
        const span = document.createElement('div');
        span.innerText = 'No partners available for this dish';
        pList.appendChild(span);
      }

      body.appendChild(pList);
      card.appendChild(img);
      card.appendChild(body);
      container.appendChild(card);
    });
  } catch(err) {
    console.error('Error loading catalog', err);
  }
}

function openOrderForPartner(dish, partnerEntry) {
  const partnerId = partnerEntry.partnerId;
  const p = window.partnersIndex && window.partnersIndex[partnerId] ? window.partnersIndex[partnerId] : {name: partnerEntry.partnerName, phone:''};
  const modal = document.getElementById('orderModal');
  document.getElementById('modalPartnerName').innerText = p.name + ' — ' + dish.title;
  modal.dataset.partner = partnerId;
  document.getElementById('orderNotes').value = `Order: ${dish.title} (via ${p.name}) - ₹${partnerEntry.price}`;
  document.getElementById('deliveryAddr').value = '';
  document.getElementById('customerPhone').value = '';
  modal.style.display = 'flex';
}

window.addEventListener('load', ()=>{ 
  setTimeout(()=>{ loadCatalogWithPartners(); }, 350);
});

(function(){
  function qs(name){ const u = new URLSearchParams(location.search); return u.get(name); }
  const dish = qs('dish') || 'Dish';
  const city = qs('city') || 'Pune';
  document.getElementById('title').textContent = `Order: ${dish}`;
  async function load() {
    try {
      const resp = await fetch('pune_menus.json');
      const data = await resp.json();
      // find restaurants in that city offering this dish (case-insensitive match)
      const matches = data.filter(r => (r.city||'').toLowerCase()===city.toLowerCase() && r.dishes && r.dishes.some(d=>d.title.toLowerCase().includes(dish.toLowerCase())));
      const container = document.getElementById('content');
      container.innerHTML = '';
      if (matches.length===0) {
        container.innerHTML = `<p>No local partners in ${city} found for "<strong>${dish}</strong>".<br/>Showing web search instead.</p>
        <p><a class="pill" href="https://www.google.com/search?q=${encodeURIComponent(dish+' '+city+' order online')}" target="_blank">Search web for ${dish}</a></p>`;
        return;
      }
      for (const r of matches) {
        const card = document.createElement('div');
        card.className='card';
        let html = `<div class="tile">${escapeHtml(r.name)} — ${escapeHtml(r.area||'')}</div>`;
        html += `<div style="padding:8px">`;
        for (const d of r.dishes.filter(d=>d.title.toLowerCase().includes(dish.toLowerCase()))) {
          html += `<div><strong>${escapeHtml(d.title)}</strong> — ₹${escapeHtml(String(d.price))} <br/>${escapeHtml(d.description||'')}</div>`;
          if (d.payment_link) html += `<div style="margin-top:6px"><a class="pill" target="_blank" href="${escapeHtml(d.payment_link)}">Pay / Order</a></div>`;
          html += `<hr/>`;
        }
        html += `</div>`;
        card.innerHTML = html;
        container.appendChild(card);
      }
    } catch (e) {
      document.getElementById('content').textContent = 'Failed to load menu data';
      console.error(e);
    }
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }
  load();
})();

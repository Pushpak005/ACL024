(function(){
  function qs(n){ return new URLSearchParams(location.search).get(n); }
  const dish = qs('dish') || '';
  const city = qs('city') || 'Pune';
  document.getElementById('title').textContent = `Order: ${dish || 'Dish'}`;

  async function load(){
    try {
      let data = [];
      try { data = await fetch('partners.json').then(r=>r.ok? r.json(): []); } catch(e){ try{ data = await fetch('pune_menus.json').then(r=>r.ok? r.json(): []); } catch(_){ data = []; } }

      const c = document.getElementById('content');
      c.innerHTML = '';

      const matches = data
        .filter(p => !p.city || p.city.toLowerCase() === city.toLowerCase())
        .map(p => {
          const found = (p.dishes||[]).filter(d => d.title && d.title.toLowerCase().includes((dish||'').toLowerCase()));
          return found.length ? { partner: p, dishes: found } : null;
        }).filter(Boolean);

      if(matches.length === 0){
        c.innerHTML = `<p>No partner serves <b>${escapeHtml(dish)}</b> in ${escapeHtml(city)}.</p>
          <p><a class="pill" href="https://www.google.com/search?q=${encodeURIComponent(dish+' '+city+' order online')}" target="_blank">Search web</a></p>`;
        return;
      }

      for(const m of matches){
        const div = document.createElement('div');
        div.className = 'card';
        let html = `<div class="tile">${escapeHtml(m.partner.name)} — ${escapeHtml(m.partner.area||'')}</div>`;
        html += '<div style="padding:8px">';
        for(const d of m.dishes){
          html += `<div><strong>${escapeHtml(d.title)}</strong> — ₹${escapeHtml(String(d.price || 'N/A'))}<br/>${escapeHtml(d.description||'')}</div>`;
          if(d.payment_link) html += `<div style="margin-top:6px"><a class="pill" target="_blank" href="${escapeHtml(d.payment_link)}">Pay / Order</a></div>`;
          html += '<hr/>';
        }
        html += '</div>';
        div.innerHTML = html;
        c.appendChild(div);
      }
    } catch(e){
      document.getElementById('content').textContent = 'Failed to load menu data';
      console.error(e);
    }
  }

  function escapeHtml(s){ return String(s || '').replace(/[&<>"']/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }

  load();
})();

// netlify/functions/recommend_partners.js
import fetch from "node-fetch";

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const wearable = body.wearable || {};
    const prefs = body.prefs || {};
    const partners = body.partners || [];

    // Flatten partner dishes
    const all = [];
    for (const p of partners) {
      if (!p || !p.dishes) continue;
      for (const d of p.dishes) {
        all.push({
          title: d.title,
          description: d.description || "",
          price: d.price || "",
          partner: p.name,
          city: p.city || "",
        });
      }
    }

    // Compose DeepSeek prompt
    const prompt = `
User details:
- Diet: ${prefs.diet || "unknown"}
- City: ${prefs.city || "unknown"}
- Health metrics: HR ${wearable.heartRate || "--"}, BP ${wearable.bp || "--"}, Calories ${wearable.calories || "--"}

Partner dishes:
${all.map(a => `• ${a.title} (${a.partner}, ${a.city}) – ${a.description}`).join("\n")}

Please select 5–10 dishes that are most suitable for the user's current health and preferences.
Return JSON array: [{title, reason, partner, city, price}]
`;

    const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4
      })
    });

    const data = await resp.json();
    let text = data.choices?.[0]?.message?.content || "";
    let picks = [];
    try { picks = JSON.parse(text); } catch(_) {}

    if(!Array.isArray(picks) || !picks.length){
      // fallback: pick first few partner dishes
      picks = all.slice(0,6).map(x=>({...x, reason:"Heuristic suggestion (DeepSeek offline)."}));
    }

    return { statusCode: 200, body: JSON.stringify({ picks }) };

  } catch (e) {
    console.error("recommend_partners (DeepSeek) fail", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

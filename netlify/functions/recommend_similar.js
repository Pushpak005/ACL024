// netlify/functions/recommend_similar.js
// Smart simple recommender using DeepSeek chat
// Picks the most similar dishes from partner menus (e.g., if Tofu missing -> Paneer)

import fetch from "node-fetch";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const MODEL = "deepseek-chat"; // change if your model name differs

async function deepseekChat(prompt) {
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 800
    })
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { wearable = {}, prefs = {}, partners = [], seedDish = "", topN = 6 } = body;

    // Flatten partner dishes
    const dishes = [];
    for (const p of partners || []) {
      for (const d of p.dishes || []) {
        dishes.push({
          title: d.title || "",
          description: d.description || "",
          price: d.price || "",
          partner: p.name || "",
          city: p.city || "",
        });
      }
    }

    if (!dishes.length)
      return { statusCode: 200, body: JSON.stringify({ picks: [] }) };

    // Build smart DeepSeek prompt
    const prompt = `
User preferences:
- Diet: ${prefs.diet || "unknown"}
- City: ${prefs.city || "unknown"}
- Health: HR=${wearable.heartRate || "--"}, BP=${wearable.bp || "--"}, Activity=${wearable.activityLevel || "--"}

Goal:
Recommend up to ${topN} dishes ONLY from the list below that are healthy and suitable for the user's context.
If tofu is not available, recommend paneer or other similar protein-rich items.
If chicken missing, suggest egg/fish alternatives.
Return strictly JSON array: [{"title":"","partner":"","city":"","price":"","reason":""}]
---

Available dishes:
${dishes.map((d,i)=>`${i+1}. ${d.title} - ${d.partner} - ${d.city} - ${d.description || ""}`).join("\n")}
`;

    const text = await deepseekChat(prompt);

    let picks = [];
    try {
      picks = JSON.parse(text);
    } catch {
      const match = text.match(/\[([\s\S]*)\]/);
      if (match) {
        try { picks = JSON.parse(match[0]); } catch { picks = []; }
      }
    }

    if (!Array.isArray(picks) || !picks.length) {
      picks = dishes.slice(0, topN).map(d => ({
        title: d.title,
        partner: d.partner,
        city: d.city,
        price: d.price,
        reason: "Fallback: top partner dish."
      }));
    }

    return { statusCode: 200, body: JSON.stringify({ picks }) };

  } catch (err) {
    console.error("recommend_similar error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

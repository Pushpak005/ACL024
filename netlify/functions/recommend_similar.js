// netlify/functions/recommend_similar.js
// Simple smart recommender using DeepSeek chat.
// Finds most similar dishes from your partner menus based on a "seed" dish or user health context.

import fetch from "node-fetch";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const MODEL = "deepseek-chat"; // adjust if your model name differs

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
      temperature: 0.2,
      max_tokens: 700
    })
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { wearable = {}, prefs = {}, partners = [], seedDish = "", topN = 6 } = body;

    // Flatten all partner dishes
    const dishes = [];
    for (const p of partners || []) {
      for (const d of p.dishes || []) {
        dishes.push({
          title: d.title || "",
          description: d.description || "",
          price: d.price || null,
          partner: p.name || "",
          city: p.city || "",
        });
      }
    }

    if (!dishes.length)
      return { statusCode: 200, body: JSON.stringify({ picks: [] }) };

    // Build smart prompt for DeepSeek
    const query = `
User preferences:
- Diet: ${prefs.diet || "unknown"}
- City: ${prefs.city || "unknown"}
- Health: HR=${wearable.heartRate || "--"}, BP=${wearable.bp || "--"}, Activity=${wearable.activityLevel || "--"}
${seedDish ? `\nPrimary recommended dish: ${seedDish}` : ""}
---

Below is the list of dishes available from our restaurant partners.
Select up to ${topN} dishes that are most relevant, healthy, and similar in spirit.
If a tofu dish isn't available, suggest a paneer or other protein-based option.
Prefer dishes that fit the user’s diet type.
Return ONLY a JSON array:
[{"title":"","partner":"","city":"","price":"","reason":""}]
---

Available dishes:
${dishes.map((d,i)=>`${i+1}. ${d.title} - ${d.partner} - ${d.city} - ${d.description || ""}`).join("\n")}
`;

    const text = await deepseekChat(query);

    // Parse JSON
    let picks = [];
    try {
      picks = JSON.parse(text);
    } catch {
      // fallback: simple regex parser if model adds text
      const match = text.match(/\[([\s\S]*)\]/);
      if (match) {
        try { picks = JSON.parse(match[0]); } catch { picks = []; }
      }
    }

    // fallback if LLM gives nothing
    if (!Array.isArray(picks) || picks.length === 0) {
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

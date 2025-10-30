// netlify/functions/recommend_similar.js
// Smart recommender using DeepSeek chat API (native fetch version, no node-fetch)

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const MODEL = "deepseek-chat";

async function deepseekChat(prompt) {
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
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
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { wearable = {}, prefs = {}, partners = [], topN = 6 } = body;

    // Flatten partner dishes
    const dishes = [];
    for (const p of partners || []) {
      const dishList = p.dishes || p.menu || p.items || [];
      for (const d of dishList) {
        dishes.push({
          title: d.title || d.name || "",
          description: d.description || d.desc || "",
          price: d.price || "",
          partner: p.name || "",
          city: p.city || prefs.city || "Pune"
        });
      }
    }

    if (!dishes.length)
      return { statusCode: 200, body: JSON.stringify({ picks: [] }) };

    const prompt = `
User Diet: ${prefs.diet}, City: ${prefs.city}, HR ${wearable.heartRate}, BP ${wearable.bp}, Activity ${wearable.activityLevel}.
From the dishes listed below, recommend up to ${topN} options that best fit the user.
If tofu missing, suggest paneer or similar protein dish.
Return pure JSON array only:
[{"title":"","partner":"","city":"","price":"","reason":""}]

Available dishes:
${dishes.map(d => `${d.title} - ${d.partner} - ${d.city} - ${d.description}`).join("\n")}
`;

    const text = await deepseekChat(prompt);

    // JSON recovery
    let picks = [];
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try { picks = JSON.parse(jsonMatch[0]); } catch {}
    }
    if (!Array.isArray(picks) || !picks.length) {
      picks = dishes.slice(0, topN).map(d => ({
        title: d.title,
        partner: d.partner,
        city: d.city,
        price: d.price,
        reason: "Fallback: partner dish."
      }));
    }

    picks = picks.filter(p => p.title && p.partner).slice(0, topN);
    return { statusCode: 200, body: JSON.stringify({ picks }) };

  } catch (e) {
    console.error("DeepSeek error:", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

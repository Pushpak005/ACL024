// netlify/functions/recommend_similar.js — final fixed
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

    const dishes = [];
    for (const p of partners) {
      const list = p.dishes || p.menu || p.items || [];
      for (const d of list) {
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
User: ${prefs.diet || "unknown"} in ${prefs.city || "unknown"}.
Vitals: HR=${wearable.heartRate || "--"}, BP=${wearable.bp || "--"}, Activity=${wearable.activityLevel || "--"}.
Pick ${topN} dishes ONLY from the list below that best match the user's health needs.
If tofu not available, suggest paneer or similar. Return JSON array:
[{"title":"","partner":"","city":"","price":"","reason":""}]
Available dishes:
${dishes.map(d => `${d.title} - ${d.partner} - ${d.city} - ${d.description}`).join("\n")}
`;

    const text = await deepseekChat(prompt);
    console.log("DeepSeek raw:", text.slice(0, 300));

    let picks = [];
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { picks = JSON.parse(match[0]); } catch {}
    }
    if (!Array.isArray(picks) || !picks.length) {
      picks = dishes.slice(0, topN).map(d => ({
        title: d.title,
        partner: d.partner,
        city: d.city,
        price: d.price,
        reason: "Fallback: partner dish"
      }));
    }

    return { statusCode: 200, body: JSON.stringify({ picks }) };
  } catch (e) {
    console.error("recommend_similar error:", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

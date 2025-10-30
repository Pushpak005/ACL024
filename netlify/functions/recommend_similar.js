// Smart recommender using DeepSeek chat API
// Compatible with Netlify Node 18+ (native fetch, no node-fetch)

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const MODEL = "deepseek-chat";

/** -----------------------------------------------------------
 *  Ask DeepSeek for dish recommendations
 *  --------------------------------------------------------- */
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

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`DeepSeek API error: ${res.status} ${msg}`);
  }

  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}

/** -----------------------------------------------------------
 *  Netlify handler
 *  --------------------------------------------------------- */
export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { wearable = {}, prefs = {}, partners = [], topN = 6 } = body;

    /* ---- 1.  Build flat dish list from partner menus ---- */
    const dishes = [];
    for (const p of partners || []) {
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

    if (!dishes.length) {
      console.warn("⚠️ No partner dishes found");
      return { statusCode: 200, body: JSON.stringify({ picks: [] }) };
    }

    /* ---- 2.  Build DeepSeek prompt ---- */
    const prompt = `
User details:
- Diet: ${prefs.diet || "unknown"}
- City: ${prefs.city || "unknown"}
- HR: ${wearable.heartRate || "--"}
- BP: ${wearable.bp || "--"}
- Activity: ${wearable.activityLevel || "--"}

Task:
Pick up to ${topN} dishes ONLY from the list below that best match diet and health goals.
If tofu missing, choose paneer or other protein-rich alternative.
Return valid JSON array only:
[{"title":"","partner":"","city":"","price":"","reason":""}]

Available dishes:
${dishes.map(d => `${d.title} - ${d.partner} - ${d.city} - ${d.description}`).join("\n")}
`;

    /* ---- 3.  Query DeepSeek ---- */
    const text = await deepseekChat(prompt);
    console.log("🧠 DeepSeek raw:", text.slice(0, 300));

    /* ---- 4.  Robust JSON extraction ---- */
    let picks = [];
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { picks = JSON.parse(match[0]); } catch {}
    }

    /* ---- 5.  Validate and fallback ---- */
    if (!Array.isArray(picks) || !picks.length) {
      console.warn("⚠️ DeepSeek returned no parsable dishes, using fallback.");
      picks = dishes.slice(0, topN).map(d => ({
        title: d.title,
        partner: d.partner,
        city: d.city,
        price: d.price,
        reason: "Fallback: popular partner dish."
      }));
    }

    picks = picks.filter(p => p.title && p.partner).slice(0, topN);
    console.log("✅ PICKS:", JSON.stringify(picks, null, 2));

    return { statusCode: 200, body: JSON.stringify({ picks }) };

  } catch (err) {
    console.error("❌ recommend_similar error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};

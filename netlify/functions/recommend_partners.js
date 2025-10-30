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
          city: p.city || ""
        });
      }
    }

    // Build prompt for DeepSeek (be concise)
    const prompt = `
User preferences:
- Diet: ${prefs.diet || "unknown"}
- City: ${prefs.city || "unknown"}
Health vitals:
- Heart rate: ${wearable.heartRate || "--"}
- Blood pressure: ${wearable.bp || "--"}
- Activity level: ${wearable.activityLevel || "--"}

Available partner dishes:
${all.map(a => `• ${a.title} (${a.partner}, ${a.city}) – ${a.description}`).join("\n")}

Select up to 8 dishes from the available partner dishes that are most suitable for the user given their health vitals and preferences.
Return a valid JSON array with objects: { "title": string, "reason": string, "partner": string, "city": string, "price": number|null }
`;

    // Call DeepSeek
    const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.35
      })
    });

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "";
    let picks = [];
    try { picks = JSON.parse(text); } catch (e) {
      // parse failed — return empty picks so frontend does fallback
      picks = [];
    }

    // Validate picks array shape
    if (!Array.isArray(picks)) picks = [];

    return { statusCode: 200, body: JSON.stringify({ picks }) };
  } catch (err) {
    console.error('recommend_partners error', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

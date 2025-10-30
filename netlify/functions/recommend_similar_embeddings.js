// netlify/functions/recommend_similar_embeddings.js
// Embedding-based recommender using DeepSeek embeddings + optional DeepSeek chat for reasons.
// Requires: process.env.DEEPSEEK_API_KEY
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

// helper: POST JSON
async function postJson(url, body, headers = {}) {
  const resp = await fetch(url, {
    method: "POST",
    headers: Object.assign({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
    }, headers),
    body: JSON.stringify(body)
  });
  return resp;
}

// embed text via DeepSeek (assumed endpoint/model)
async function embedTextDeepseek(text, model = "deepseek-embed") {
  const resp = await postJson(`${DEEPSEEK_BASE}/embeddings`, { model, input: text });
  const data = await resp.json();
  // expected: { data: [{ embedding: [...] }, ...] }
  if (!data || !data.data || !data.data[0]) return null;
  return data.data[0].embedding;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? (dot / denom) : 0;
}

// optional: ask DeepSeek chat to produce 1-line reasons for top picks
async function askDeepseekReasons(titles, query, model = "deepseek-chat") {
  const prompt = `
User context: ${query}

For these dishes:
${titles.map((t,i) => `${i+1}. ${t}`).join("\n")}

Return a JSON array like: [{ "title": "...", "reason": "one short sentence why this is suitable" }, ...]
Only return JSON.
`;
  const resp = await postJson(`${DEEPSEEK_BASE}/chat/completions`, {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.25,
    max_tokens: 500
  });
  const j = await resp.json();
  const text = j.choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    // fallback: return empty, we'll make simple reasons
  }
  return [];
}

// If you want server to read cached embeddings file (recommended), look for partners_embeddings.json
function loadCachedEmbeddings() {
  try {
    const p = path.join(process.cwd(), "partners_embeddings.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    // ignore
  }
  return null;
}

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { wearable = {}, prefs = {}, partners = [], topN = 6, useCached = true } = body;

    // Flatten partner dishes
    const all = [];
    for (const p of partners || []) {
      if (!p || !p.dishes) continue;
      for (const d of p.dishes) {
        all.push({
          title: d.title || "",
          description: d.description || "",
          partner: p.name || "",
          city: p.city || "",
          price: d.price || null
        });
      }
    }

    if (!all.length) return { statusCode: 200, body: JSON.stringify({ picks: [] }) };

    // Build query text from prefs + wearable
    const queryText = [
      `Diet: ${prefs.diet || "unknown"}`,
      `City: ${prefs.city || "unknown"}`,
      `HeartRate: ${wearable.heartRate || "--"}`,
      `BP: ${wearable.bp || "--"}`,
      `Activity: ${wearable.activityLevel || "--"}`,
      `Note: recommend healthy dishes from partner menus`
    ].join(" • ");

    // 1) Try load cached embeddings if present
    const cached = useCached ? loadCachedEmbeddings() : null;
    const dishVecs = []; // { dish, vec }

    if (cached && Array.isArray(cached) && cached.length > 0) {
      // cached expected format: [{ title, partner, city, description, price, embedding }]
      for (const c of cached) {
        // only include if exists in current partners (match by title+partner)
        const found = all.find(a => (a.title||"").toLowerCase() === (c.title||"").toLowerCase() &&
                                   (a.partner||"").toLowerCase() === (c.partner||"").toLowerCase());
        if (found && Array.isArray(c.embedding)) {
          dishVecs.push({ dish: found, vec: c.embedding });
        }
      }
    }

    // 2) For any dishes not in cached set, compute embeddings on the fly
    for (const d of all) {
      const already = dishVecs.find(x => x.dish.title.toLowerCase() === d.title.toLowerCase() && x.dish.partner.toLowerCase() === d.partner.toLowerCase());
      if (already) continue;
      const text = `${d.title}. ${d.description || ""}. ${d.partner} ${d.city}`;
      const vec = await embedTextDeepseek(text);
      if (vec && vec.length) dishVecs.push({ dish: d, vec });
    }

    // 3) compute query vector
    const qvec = await embedTextDeepseek(queryText);
    if (!qvec || !qvec.length) throw new Error("Failed to compute query embedding");

    // 4) compute cosine similarity and sort
    const scored = dishVecs.map(({ dish, vec }) => ({ dish, score: cosine(qvec, vec) }));
    scored.sort((a,b) => b.score - a.score);
    const top = scored.slice(0, topN);

    // 5) optionally ask DeepSeek chat to give short reasons for top titles
    const titles = top.map(t => t.dish.title);
    let reasonsMap = {};
    try {
      const reasons = await askDeepseekReasons(titles, queryText);
      if (Array.isArray(reasons)) {
        for (const r of reasons) reasonsMap[(r.title||"").toLowerCase()] = r.reason || "";
      }
    } catch (e) {
      // ignore LLM reason failure
    }

    // 6) Build picks
    const picks = top.map(t => ({
      title: t.dish.title,
      description: t.dish.description,
      partner: t.dish.partner,
      city: t.dish.city,
      price: t.dish.price,
      score: t.score,
      reason: reasonsMap[(t.dish.title||"").toLowerCase()] || "Recommended by semantic similarity to your context."
    }));

    return { statusCode: 200, body: JSON.stringify({ picks }) };

  } catch (err) {
    console.error("recommend_similar_embeddings error", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

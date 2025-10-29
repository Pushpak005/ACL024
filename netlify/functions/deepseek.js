/* netlify/functions/deepseek.js
 * DeepSeek proxy with POST (messages) + fallback summariser.
 */

exports.handler = async function (event) {
  const apiKey = process.env.ACL_API;
  if (!apiKey) return { statusCode: 500, body: 'Missing ACL_API environment variable' };

  // Helper: safe JSON parse
  const json = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

  // --- Handle GET ?q= for quick smoke-tests ---
  if (event.httpMethod === 'GET') {
    const q = (event.queryStringParameters || {}).q || '';
    if (!q) return { statusCode: 400, body: 'Missing q parameter' };
    try {
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: q }], temperature: 0.3 })
      });
      const data = await resp.json();
      const answer = data?.choices?.[0]?.message?.content?.trim() || '(no answer)';
      return { statusCode: 200, body: JSON.stringify({ answer, raw: data }) };
    } catch (e) {
      return { statusCode: 500, body: 'DeepSeek error: ' + e.message };
    }
  }

  // --- Handle POST with structured messages ---
  if (event.httpMethod === 'POST') {
    const body = json(event.body);
    const messages = Array.isArray(body.messages) ? body.messages : null;
    const temperature = typeof body.temperature === 'number' ? body.temperature : 0.3;
    const context = body.context || {}; // { evidenceTitle, evidenceAbstract, vitals, macros, dish }

    if (!messages) return { statusCode: 400, body: 'Missing messages[] in JSON body' };

    try {
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages, temperature })
      });
      const data = await resp.json();
      let answer = data?.choices?.[0]?.message?.content?.trim();

      // Server-side fallback if model is empty
      if (!answer) {
        const title = (context.evidenceTitle || '').trim();
        const abstract = (context.evidenceAbstract || '').trim();
        const vitals = context.vitals || {};
        const macros = context.macros || {};
        const dish = context.dish || {};

        const parts = [];
        if (title) parts.push(`According to “${title}”`);
        if (abstract) {
          // take up to the first two sentences of the abstract for a richer summary
          const sentences = abstract.split(/[.!?]\s+/);
          const short = sentences.slice(0, 2).join('. ').trim();
          if (short) parts.push(short + (short.endsWith('.') ? '' : '.'));
        }
        // macros summary
        const macrosLine = [];
        if (macros.protein_g != null) macrosLine.push(`${macros.protein_g}g protein`);
        if (macros.sodium_mg != null) macrosLine.push(`${macros.sodium_mg} mg sodium/100g`);
        // vitals summary
        const vitalLine = [];
        if (vitals.caloriesBurned != null) vitalLine.push(`today’s burn ${vitals.caloriesBurned} kcal`);
        if (vitals.bpSystolic && vitals.bpDiastolic) vitalLine.push(`BP ${vitals.bpSystolic}/${vitals.bpDiastolic}`);
        // final sentence connecting macros and vitals to the dish
        parts.push(
          `For ${dish.title || 'this dish'}${macrosLine.length ? ` (${macrosLine.join(', ')})` : ''}, ` +
          (vitalLine.length ? `your metrics (${vitalLine.join(', ')}) suggest this can be a suitable choice.` : `it aligns with your current metrics.`)
        );
        answer = parts.filter(Boolean).join(' ');
      }

      return { statusCode: 200, body: JSON.stringify({ answer, raw: data }) };
    } catch (e) {
      return { statusCode: 500, body: 'DeepSeek error: ' + e.message };
    }
  }

  return { statusCode: 405, body: 'Method not allowed' };
}

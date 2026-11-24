// Vercel serverless function: Gemini proxy. The API key never reaches the browser.
// Env: GEMINI_API_KEY (required), GEMINI_MODEL (optional, default gemini-2.5-flash)

const SCHEMA_VARS = ['flow_rate', 'pump_flow', 'pressure', 'tank_level', 'water_level', 'reservoir_fill_pct', 'reservoir_volume',
  'reservoir_usable_volume', 'production_volume', 'system_input_volume', 'physical_loss', 'apparent_loss', 'water_loss',
  'non_revenue_water', 'revenue_water', 'energy', 'turbidity', 'chlorine', 'ph', 'conductivity', 'temperature', 'UNMAPPED'];

const PROMPTS = {
  map: `Sen BURBLE su verisi güvenilirlik katmanının şema eşleme modülüsün.
Görev: verilen her kolon için hedef şemadan TEK bir değişken seç. İzinli değişkenler: ${SCHEMA_VARS.join(', ')}.
Emin değilsen "UNMAPPED" yaz. Şema dışında değişken UYDURMA. Sayısal dönüşüm hesaplama, sadece birimi belirt.
Kanıt olarak yalnızca kolon adını, komşu kolonları ve örnek değerleri kullan.
Yanıt JSON: {"suggestions":[{"column":str,"variable":str,"unit":str,"confidence":0..1,"evidence":"Türkçe kısa gerekçe"}]}`,
  explain: `Sen BURBLE su verisi güvenilirlik katmanının rapor yorumlayıcısısın. Türkçe yaz.
Sana kalite bulguları ve Pareto sıralaması verilecek. Yeni sayı üretme; yalnızca verilen sayıları kullan.
Karar kuralı: auto=otomatik uygula, suggest=öner ve onaylat, flag=yalnızca işaretle. Belirsiz durumda flag öner.
Yanıt JSON: {"summary":"3-4 cümle","actions":[{"action":str,"reason":str,"tier":"auto|suggest|flag"}]} en fazla 5 aksiyon, Pareto önceliğiyle.`,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Yalnızca POST' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY tanımlı değil' });
  const { task, payload } = req.body || {};
  if (!PROMPTS[task]) return res.status(400).json({ error: 'Geçersiz görev' });
  const input = JSON.stringify(payload ?? {}).slice(0, 24000);
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPTS[task] }] },
        contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'Gemini hatası' });
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '{}';
    let out; try { out = JSON.parse(text); } catch { return res.status(502).json({ error: 'Gemini geçerli JSON döndürmedi' }); }

    if (task === 'map') { // zero-hallucination guard: drop anything outside the schema
      const ok = [], rejected = [];
      for (const s of out.suggestions || []) (SCHEMA_VARS.includes(s.variable) ? ok : rejected).push(s);
      return res.status(200).json({ suggestions: ok, rejected: rejected.map(s => `${s.column}→${s.variable}`) });
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

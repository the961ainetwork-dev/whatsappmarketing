import { authUser, readBody, cors, getSettings, logEvent } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    const { goal, language } = readBody(req);
    if (!goal || String(goal).length < 10) return res.status(400).json({ error: 'Describe your offer/goal first (a sentence or two)' });
    const aKey = process.env.ANTHROPIC_API_KEY;
    if (!aKey) return res.status(500).json({ error: 'AI not configured' });
    const s = await getSettings(user.id);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': aKey },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `Write a WhatsApp marketing template message for Meta approval.

BUSINESS: ${s?.business_name || 'a business'}${s?.ai_prompt ? '\nCONTEXT: ' + String(s.ai_prompt).slice(0, 800) : ''}
CAMPAIGN GOAL: ${String(goal).slice(0, 600)}
LANGUAGE: ${language === 'ar' ? 'Arabic' : language === 'both' ? 'English AND Arabic versions' : 'English'}

META TEMPLATE RULES (strict):
- Use {{1}} exactly once for the customer's name
- Under 550 characters per version
- No spammy words (FREE!!!, urgent, click now), no ALL CAPS, max 2 emojis
- Clear value + one soft call-to-action
- Must read as a helpful update, not an ad blast (Meta rejects ad-speak)

Respond ONLY with JSON:
{"template_name":"lowercase_with_underscores_max_25_chars","body_en":"...or empty if not requested","body_ar":"...or empty if not requested","tip":"one line: how to maximize approval odds for THIS template"}`
        }],
      }),
    });
    if (!r.ok) return res.status(500).json({ error: 'AI error' });
    const d = await r.json();
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let out;
    try {
      const clean = txt.replace(/```json|```/g, '').trim();
      out = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
    } catch { return res.status(500).json({ error: 'Could not parse AI output — try again' }); }
    logEvent(user.id, user.email, 'ai_writer', String(goal).slice(0, 80));
    return res.status(200).json({ ok: true, ...out });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

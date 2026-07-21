import { sb, authUser, cors, getSettings } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    const aKey = process.env.ANTHROPIC_API_KEY;
    if (!aKey) return res.status(500).json({ error: 'AI not configured' });
    const s = await getSettings(user.id);

    // Gather signals
    const now = Date.now();
    const d7 = new Date(now - 7 * 86400000).toISOString();
    const d30 = new Date(now - 30 * 86400000).toISOString();
    const [allC, hotC, quietC, recentC, campaigns] = await Promise.all([
      sb(`wm_contacts?user_id=eq.${user.id}&select=id`),
      sb(`wm_contacts?user_id=eq.${user.id}&intent=eq.hot&select=id,name,interest,order_note`),
      sb(`wm_contacts?user_id=eq.${user.id}&last_inbound=lt.${d30}&opt_in=eq.true&select=id`),
      sb(`wm_contacts?user_id=eq.${user.id}&created_at=gte.${d7}&select=id`),
      sb(`wm_campaigns?user_id=eq.${user.id}&select=name,category,sent,status&order=id.desc&limit=5`),
    ]);
    const total = allC.ok ? (await allC.json()).length : 0;
    const hot = hotC.ok ? await hotC.json() : [];
    const quiet = quietC.ok ? (await quietC.json()).length : 0;
    const newThisWeek = recentC.ok ? (await recentC.json()).length : 0;
    const camps = campaigns.ok ? await campaigns.json() : [];

    const signals = `BUSINESS: ${s?.business_name || s?.ai_prompt || 'a business'}
Total contacts: ${total}
Hot leads right now: ${hot.length}${hot.length ? ' (' + hot.slice(0,5).map(c => c.name || c.interest || 'lead').join(', ') + ')' : ''}
Contacts gone quiet (30+ days, still opted-in): ${quiet}
New contacts this week: ${newThisWeek}
Recent campaigns: ${camps.map(c => `${c.name} (${c.category}, ${c.sent} sent)`).join('; ') || 'none yet'}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': aKey },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 900,
        messages: [{ role: 'user', content: `You are a WhatsApp marketing strategist for a small business. Based on these live signals, recommend THIS WEEK's best campaign move. Be specific and actionable, not generic.

${signals}

Respond ONLY with JSON:
{"headline":"one punchy line naming the #1 opportunity this week","why":"1-2 sentences on the data reason","segment":"which audience to target (e.g. 'gone quiet 30+ days', 'hot leads', 'new this week')","message_idea":"a ready draft WhatsApp message (with {{1}} for name), under 400 chars","timing":"best day/time to send","expected":"what result to expect"}` }],
      }),
    });
    if (!r.ok) return res.status(500).json({ error: 'AI error' });
    const d = await r.json();
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let out;
    try { const c = txt.replace(/```json|```/g, '').trim(); out = JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)); }
    catch { return res.status(500).json({ error: 'Could not parse — try again' }); }
    return res.status(200).json({ ok: true, ...out, stats: { total, hot: hot.length, quiet, newThisWeek } });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

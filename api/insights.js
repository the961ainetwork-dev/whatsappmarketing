import { sb, authUser, cors, getSettings } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    const aKey = process.env.ANTHROPIC_API_KEY;
    if (!aKey) return res.status(500).json({ error: 'AI is not configured' });
    const s = await getSettings(user.id);
    const since = new Date(Date.now() - 30 * 86400000).toISOString();

    const [mr, tr, cr] = await Promise.all([
      sb(`wm_messages?user_id=eq.${user.id}&direction=eq.in&created_at=gte.${since}&select=body,created_at&order=id.desc&limit=400`),
      sb(`wm_tickets?user_id=eq.${user.id}&select=category,priority&limit=300`),
      sb(`wm_contacts?user_id=eq.${user.id}&select=intent,country&limit=500`),
    ]);
    const msgs = mr.ok ? await mr.json() : [];
    if (msgs.length < 5) return res.status(200).json({ ok: true, thin: true, headline: 'Not enough conversations yet', why: 'Once around 20 customer messages have come in, the insights here get genuinely useful.', findings: [], actions: [] });

    // busiest hour
    const hours = {};
    msgs.forEach(m => { const hh = new Date(m.created_at).getHours(); hours[hh] = (hours[hh] || 0) + 1; });
    const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
    const nightShare = Math.round((msgs.filter(m => { const hh = new Date(m.created_at).getHours(); return hh >= 22 || hh < 7; }).length / msgs.length) * 100);

    const tickets = tr.ok ? await tr.json() : [];
    const catCount = {};
    tickets.forEach(t => { catCount[t.category] = (catCount[t.category] || 0) + 1; });
    const contacts = cr.ok ? await cr.json() : [];
    const countries = {};
    contacts.forEach(c => { if (c.country) countries[c.country] = (countries[c.country] || 0) + 1; });

    const sample = msgs.slice(0, 120).map(m => (m.body || '').slice(0, 140)).join('\n---\n');
    const facts = `BUSINESS: ${s?.business_name || s?.ai_prompt?.slice(0, 200) || 'a business'}
Customer messages in the last 30 days: ${msgs.length}
Busiest hour: ${peak ? peak[0] + ':00 (' + peak[1] + ' messages)' : 'n/a'}
Share arriving between 22:00 and 07:00: ${nightShare}%
Ticket categories: ${Object.entries(catCount).map(([k, v]) => k + ' ' + v).join(', ') || 'none yet'}
Countries: ${Object.entries(countries).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k, v]) => k + ' ' + v).join(', ') || 'unknown'}
Lead temperature: ${contacts.filter(c=>c.intent==='hot').length} hot, ${contacts.filter(c=>c.intent==='warm').length} warm`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': aKey },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 1100,
        messages: [{ role: 'user', content: `You are an operations analyst for a small business selling on WhatsApp. Below are hard numbers plus a sample of real customer messages. Find what the owner does NOT already know. Be concrete and specific to this data — never generic advice.

${facts}

SAMPLE OF CUSTOMER MESSAGES:
${sample}

Respond ONLY with JSON:
{"headline":"the single most useful thing in this data, one line","why":"1-2 sentences of evidence from the numbers","findings":[{"label":"short label","detail":"what the data shows, with the number"}],"actions":[{"do":"a specific action","because":"the reason from the data"}]}
Give 3-5 findings and 2-4 actions.` }],
      }),
    });
    if (!r.ok) return res.status(500).json({ error: 'The analysis could not be generated. Try again.' });
    const d = await r.json();
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let out;
    try { const c = txt.replace(/```json|```/g, '').trim(); out = JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)); }
    catch { return res.status(500).json({ error: 'The analysis came back unreadable. Try again.' }); }
    return res.status(200).json({ ok: true, ...out, stats: { messages: msgs.length, peak_hour: peak ? Number(peak[0]) : null, night_share: nightShare } });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

import { sb, cors, waSend, waText, getSettings, logMsg } from './_lib.js';

export default async function handler(req, res) {
  cors(res);

  if (req.method === 'GET') {
    const mode = req.query?.['hub.mode'];
    const token = req.query?.['hub.verify_token'];
    if (mode === 'subscribe' && token === (process.env.WM_VERIFY_TOKEN || 'wamark-verify'))
      return res.status(200).send(req.query?.['hub.challenge']);
    return res.status(403).send('Verification failed');
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const value = body?.entry?.[0]?.changes?.[0]?.value;

    // ── Delivery/read status updates (analytics feed) ──
    const statuses = value?.statuses || [];
    for (const st of statuses) {
      if (st.id && st.status) {
        const s = ['sent', 'delivered', 'read', 'failed'].includes(st.status) ? st.status : null;
        if (s) await sb(`wm_messages?wa_id=eq.${encodeURIComponent(st.id)}`, { method: 'PATCH', body: JSON.stringify({ status: s }) });
      }
    }

    const msg = value?.messages?.[0];
    if (!msg || msg.type !== 'text') return res.status(200).json({ ok: true });

    const phoneNumberId = value?.metadata?.phone_number_id;
    const from = msg.from;
    const text = msg.text?.body || '';
    if (!phoneNumberId || !from) return res.status(200).json({ ok: true });

    const sr = await sb(`wm_settings?phone_number_id=eq.${encodeURIComponent(phoneNumberId)}&select=*`);
    const settings = (sr.ok ? await sr.json() : [])[0];
    if (!settings) return res.status(200).json({ ok: true });
    const userId = settings.user_id;

    await logMsg(userId, from, 'in', text, 'text', msg.id);

    // upsert contact + behavioral tracking
    await sb('wm_contacts?on_conflict=user_id,phone', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{ user_id: userId, phone: from, source: 'inbound', category: 'inbound' }]),
    });
    await sb(`wm_contacts?user_id=eq.${userId}&phone=eq.${from}`, { method: 'PATCH', body: JSON.stringify({ last_inbound: new Date().toISOString() }) });

    if (!settings.ai_enabled) return res.status(200).json({ ok: true });
    const aKey = process.env.ANTHROPIC_API_KEY;
    if (!aKey) return res.status(200).json({ ok: true });

    const hr = await sb(`wm_messages?user_id=eq.${userId}&phone=eq.${from}&select=direction,body&order=id.desc&limit=12`);
    const hist = (hr.ok ? await hr.json() : []).reverse();
    const convo = hist.map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body || '' }));

    const system = `You are the WhatsApp SALES assistant for this business:
${settings.ai_prompt || settings.business_name || 'A business.'}

YOUR JOB IS TO SELL, not just answer:
- Reply in the customer's language (mirror Arabic/English/dialect). Warm, human, SHORT (under 90 words).
- Answer questions from the business info only — never invent prices or stock.
- Detect buying intent. When interest appears, move toward the order: confirm product, quantity, delivery area, and name. One question at a time.
- When you have product + quantity (+ area if delivery), CONFIRM the order back to them clearly and say the owner will confirm shortly.
- Never pressure; always helpful.

After your reply, on a NEW line output exactly:
###LEAD###{"name":"...or empty","interest":"...or empty","intent":"cold|warm|hot","order":"product + qty + delivery area, or empty if no confirmed order"}
intent=hot means: asked price/availability to buy now, gave order details, or asked how to pay/order.`;

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': aKey },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, system, messages: convo.length ? convo : [{ role: 'user', content: text }] }),
    });
    if (!ar.ok) return res.status(200).json({ ok: true });
    const ad = await ar.json();
    let reply = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

    let lead = null;
    const li = reply.indexOf('###LEAD###');
    if (li > -1) {
      try { lead = JSON.parse(reply.slice(li + 10).trim()); } catch { lead = null; }
      reply = reply.slice(0, li).trim();
    }
    if (reply) {
      // Growth loop: free/demo accounts carry a branded footer (removed on paid plans)
      try {
        const pr = await sb(`wm_users?id=eq.${userId}&select=plan`);
        const [pu] = pr.ok ? await pr.json() : [];
        if (pu && ['demo', 'free'].includes(pu.plan)) {
          reply += `\n\n⚡ ${process.env.WM_BRAND_FOOTER || 'AI by WA-Marketer'}`;
        }
      } catch { /* ignore */ }
      const out = await waSend(settings, from, waText(reply));
      await logMsg(userId, from, 'out', reply, 'ai', out.id);
    }

    if (lead) {
      const patch = { intent_at: new Date().toISOString() };
      if (lead.name) patch.name = String(lead.name).slice(0, 120);
      if (lead.interest) patch.interest = String(lead.interest).slice(0, 200);
      if (['cold', 'warm', 'hot'].includes(lead.intent)) patch.intent = lead.intent;
      if (lead.order) patch.order_note = String(lead.order).slice(0, 300);
      await sb(`wm_contacts?user_id=eq.${userId}&phone=eq.${from}`, { method: 'PATCH', body: JSON.stringify(patch) });

      // ── 🔥 Instant owner alert on hot lead / order ──
      if ((lead.intent === 'hot' || lead.order) && settings.owner_phone) {
        const who = lead.name ? `${lead.name} (${from})` : from;
        const what = lead.order || lead.interest || 'ready to buy';
        const alert = `🔥 Hot lead on ${settings.business_name || 'your business'}!\n\n👤 ${who}\n🛒 ${what}\n\nReply now: https://wa.me/${from}`;
        const o = await waSend(settings, settings.owner_phone.replace(/\D/g, ''), waText(alert));
        if (o.ok) await logMsg(userId, settings.owner_phone, 'out', alert, 'alert', o.id);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(200).json({ ok: true }); }
}

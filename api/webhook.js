import { sb, cors, waSend, waText, getSettings, logMsg, regionFromPhone } from './_lib.js';

// Shared inbound processor (used by both Meta and Twilio paths)
async function handleInbound(settings, from, text, waMsgId) {
  const userId = settings.user_id;
  const aKey = process.env.ANTHROPIC_API_KEY;
  await logMsg(userId, from, 'in', text, 'text', waMsgId);
  await sb('wm_contacts?on_conflict=user_id,phone', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ user_id: userId, phone: from, source: 'inbound', category: 'inbound' }]),
  });
  await sb(`wm_contacts?user_id=eq.${userId}&phone=eq.${from}`, { method: 'PATCH', body: JSON.stringify({ last_inbound: new Date().toISOString() }) });

  if (settings.ai_enabled && aKey) {
    const hr = await sb(`wm_messages?user_id=eq.${userId}&phone=eq.${from}&select=direction,body&order=id.desc&limit=12`);
    const hist = (hr.ok ? await hr.json() : []).reverse();
    const convo = hist.map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body || '' }));
    const system = `You are the WhatsApp SALES assistant for this business:
${settings.ai_prompt || settings.business_name || 'A business.'}

YOUR JOB IS TO SELL, not just answer:
- Reply in the customer's language (mirror Arabic/English/dialect). Warm, human, SHORT (under 90 words).
- Answer from the business info only — never invent prices or stock.
- Detect buying intent. When interest appears, move toward the order: product, quantity, delivery area, name. One question at a time.
- When you have product + quantity (+area if delivery), CONFIRM the order and say the owner will confirm shortly.

After your reply, on a NEW line output exactly:
###LEAD###{"name":"...or empty","interest":"...or empty","intent":"cold|warm|hot","order":"product+qty+area or empty"}`;
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': aKey },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, system, messages: convo.length ? convo : [{ role: 'user', content: text }] }),
    });
    if (ar.ok) {
      const ad = await ar.json();
      let reply = (ad.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      let lead = null;
      const li = reply.indexOf('###LEAD###');
      if (li > -1) { try { lead = JSON.parse(reply.slice(li + 10).trim()); } catch {} reply = reply.slice(0, li).trim(); }
      if (reply) {
        try {
          const pr = await sb(`wm_users?id=eq.${userId}&select=plan`);
          const [pu] = pr.ok ? await pr.json() : [];
          if (pu && ['demo', 'free'].includes(pu.plan)) reply += `\n\n⚡ ${process.env.WM_BRAND_FOOTER || 'AI by Z24SEVEN.tel'}`;
        } catch {}
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
        if ((lead.intent === 'hot' || lead.order) && settings.owner_phone) {
          const who = lead.name ? `${lead.name} (${from})` : from;
          const what = lead.order || lead.interest || 'ready to buy';
          const alert = `🔥 Hot lead on ${settings.business_name || 'your business'}!\n\n👤 ${who}\n🛒 ${what}\n\nReply: https://wa.me/${from}`;
          const o = await waSend(settings, settings.owner_phone.replace(/\D/g, ''), waText(alert));
          if (o.ok) await logMsg(userId, settings.owner_phone, 'out', alert, 'alert', o.id);
        }
      }
    }
  }

  // Call-Center classification
  if (settings.callcenter && aKey) {
    try {
      const region = regionFromPhone(from);
      const cr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': aKey },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 350, messages: [{ role: 'user', content: `Classify this customer WhatsApp for a call-center CRM. Business: ${settings.business_name || settings.ai_prompt || 'a company'}.\n\nMESSAGE: "${text}"\n\nRespond ONLY JSON:\n{"category":"inquiry|order|complaint|support|billing|followup|other","priority":"urgent|normal|low","status":"new","needs_followup":true|false,"summary":"one line","suggested_reply":"ready reply in customer's language"}` }] }),
      });
      if (cr.ok) {
        const cd = await cr.json();
        const ct = (cd.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        let cls = null;
        try { const cl = ct.replace(/```json|```/g, '').trim(); cls = JSON.parse(cl.slice(cl.indexOf('{'), cl.lastIndexOf('}') + 1)); } catch {}
        if (cls) {
          const nr = await sb(`wm_contacts?user_id=eq.${userId}&phone=eq.${from}&select=name`);
          const nm = (nr.ok ? (await nr.json())[0]?.name : '') || '';
          const er = await sb(`wm_tickets?user_id=eq.${userId}&phone=eq.${from}&status=neq.resolved&select=id&order=id.desc&limit=1`);
          const existing = (er.ok ? await er.json() : [])[0];
          const row = {
            user_id: userId, phone: from, contact_name: nm,
            category: ['inquiry','order','complaint','support','billing','followup','other'].includes(cls.category) ? cls.category : 'other',
            priority: ['urgent','normal','low'].includes(cls.priority) ? cls.priority : 'normal',
            needs_followup: !!cls.needs_followup, summary: String(cls.summary || '').slice(0, 300),
            last_message: text.slice(0, 500), suggested_reply: String(cls.suggested_reply || '').slice(0, 800),
            country: region.country, language: region.language, local_time: region.local_time, updated_at: new Date().toISOString(),
          };
          if (existing) await sb(`wm_tickets?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify(row) });
          else await sb('wm_tickets', { method: 'POST', body: JSON.stringify([{ ...row, status: 'new' }]) });
          if ((cls.priority === 'urgent' || cls.category === 'complaint') && settings.owner_phone) {
            const al = `📞 New ${cls.category.toUpperCase()} (${cls.priority})\n\n👤 ${nm || from} · ${region.country} · ${region.local_time} local\n📝 ${cls.summary || text.slice(0,80)}\n\nOpen: https://wa.me/${from}`;
            const oa = await waSend(settings, settings.owner_phone.replace(/\D/g, ''), waText(al));
            if (oa.ok) await logMsg(userId, settings.owner_phone, 'out', al, 'alert', oa.id);
          }
        }
      }
    } catch {}
  }
}

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
    // ── Twilio inbound (form-encoded: From, To, Body) ──
    const ct = req.headers?.['content-type'] || '';
    if (ct.includes('application/x-www-form-urlencoded') || (req.body && req.body.From && req.body.Body !== undefined)) {
      let b = req.body;
      if (typeof b === 'string') { const p = new URLSearchParams(b); b = Object.fromEntries(p); }
      const fromTw = String(b.From || '').replace('whatsapp:', '').replace('+', '');
      const toTw = String(b.To || '').replace('whatsapp:', '');
      const textTw = b.Body || '';
      if (!fromTw || !textTw) { res.setHeader('Content-Type', 'text/xml'); return res.status(200).send('<Response></Response>'); }
      // route tenant by twilio_from matching this To
      const sr = await sb(`wm_settings?provider=eq.twilio&twilio_from=eq.${encodeURIComponent('whatsapp:' + toTw)}&select=*`);
      let settings = (sr.ok ? await sr.json() : [])[0];
      if (!settings) { // try without whatsapp: prefix variance
        const sr2 = await sb(`wm_settings?provider=eq.twilio&select=*`);
        const rows2 = sr2.ok ? await sr2.json() : [];
        settings = rows2.find(s => (s.twilio_from || '').replace('whatsapp:', '').replace('+', '') === toTw.replace('+', ''));
      }
      if (settings) {
        await handleInbound(settings, fromTw, textTw, null);
      }
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

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

    await handleInbound(settings, from, text, msg.id);
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(200).json({ ok: true }); }
}

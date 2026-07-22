import { sb, cors, waSend, waText, getSettings, logMsg, regionFromPhone, catalogContext, bookingContext } from './_lib.js';

// Voice-Note Agent: download WhatsApp audio (Meta) and transcribe via Whisper
// Voice-Note Agent (Twilio): download media with Twilio auth, transcribe via Whisper
async function transcribeTwilioAudio(mediaUrl, mimeType, settings) {
  const wKey = process.env.OPENAI_API_KEY;
  if (!mediaUrl || !wKey) return '';
  try {
    const auth = 'Basic ' + Buffer.from(`${settings.twilio_sid}:${settings.twilio_token}`).toString('base64');
    const ar = await fetch(mediaUrl, { headers: { Authorization: auth } });
    if (!ar.ok) return '';
    const buf = Buffer.from(await ar.arrayBuffer());
    const form = new FormData();
    const ext = (mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('amr') ? 'amr' : 'ogg');
    form.append('file', new Blob([buf], { type: mimeType || 'audio/ogg' }), 'voice.' + ext);
    form.append('model', 'whisper-1');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${wKey}` }, body: form,
    });
    if (!tr.ok) return '';
    const td = await tr.json();
    return td.text || '';
  } catch { return ''; }
}

async function transcribeWhatsAppAudio(mediaId, settings) {
  const wKey = process.env.OPENAI_API_KEY;
  if (!mediaId || !wKey) return '';
  try {
    // 1. get media URL from Meta
    const mr = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { Authorization: `Bearer ${settings.access_token}` } });
    if (!mr.ok) return '';
    const md = await mr.json();
    // 2. download the audio bytes
    const ar = await fetch(md.url, { headers: { Authorization: `Bearer ${settings.access_token}` } });
    if (!ar.ok) return '';
    const buf = Buffer.from(await ar.arrayBuffer());
    // 3. send to Whisper
    const form = new FormData();
    form.append('file', new Blob([buf], { type: md.mime_type || 'audio/ogg' }), 'voice.ogg');
    form.append('model', 'whisper-1');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${wKey}` }, body: form,
    });
    if (!tr.ok) return '';
    const td = await tr.json();
    return td.text || '';
  } catch { return ''; }
}


// Shared inbound processor (used by both Meta and Twilio paths)
async function handleInbound(settings, from, text, waMsgId) {
  const userId = settings.user_id;
  const aKey = process.env.ANTHROPIC_API_KEY;
  await logMsg(userId, from, 'in', text, 'text', waMsgId);

  // ── Review Agent: is this a reply to a rating request? ──
  if (settings.review_enabled) {
    try {
      const pend = await sb(`wm_reviews?user_id=eq.${userId}&phone=eq.${from}&status=eq.requested&select=id,contact_name&order=id.desc&limit=1`);
      const [rev] = pend.ok ? await pend.json() : [];
      const m = String(text).trim().match(/^([1-5])(\s|$|\/|\.)/);
      if (rev && m) {
        const rating = Number(m[1]);
        let cfg = {}; try { cfg = settings.review_config ? JSON.parse(settings.review_config) : {}; } catch {}
        await sb(`wm_reviews?id=eq.${rev.id}`, { method: 'PATCH', body: JSON.stringify({ rating, comment: text.slice(0, 400), status: 'answered', answered_at: new Date().toISOString() }) });
        let reply;
        if (rating >= 4) {
          reply = cfg.google_url
            ? `Thank you! That means a lot. If you have a moment, a public review helps us more than anything: ${cfg.google_url}`
            : 'Thank you! That means a lot to us.';
        } else {
          reply = 'Thank you for being honest — that helps us fix it. Someone from the team will reach out shortly.';
          if (settings.owner_phone) {
            const al = `\u26A0\uFE0F Low rating: ${rating}/5\n\uD83D\uDC64 ${rev.contact_name || from}\n\uD83D\uDCAC "${text.slice(0, 120)}"\n\nReply: https://wa.me/${from}`;
            const oa = await waSend(settings, settings.owner_phone.replace(/\D/g, ''), waText(al));
            if (oa.ok) await logMsg(userId, settings.owner_phone, 'out', al, 'alert', oa.id);
          }
          await sb(`wm_reviews?id=eq.${rev.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'routed' }) });
        }
        const out = await waSend(settings, from, waText(reply));
        await logMsg(userId, from, 'out', reply, 'review', out.id);
        return;
      }
    } catch {}
  }
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
    let extraCtx = '';
    if (settings.catalog_enabled) { try { extraCtx += await catalogContext(userId); } catch {} }
    if (settings.booking_enabled) { try { extraCtx += await bookingContext(userId, settings); } catch {} }
    // Multi-language Agent
    if (settings.languages) {
      extraCtx += `\n\nLANGUAGES: you are fluent in ${settings.languages}. Always answer in the language and dialect the customer wrote in. If they switch language mid-conversation, switch with them.`;
    }
    // Payment Agent
    if (settings.payment_enabled) {
      let pc = {}; try { pc = settings.payment_config ? JSON.parse(settings.payment_config) : {}; } catch {}
      extraCtx += `\n\nTAKING PAYMENT: once an order is agreed (product and quantity confirmed), give the payment details below so they can pay immediately. Never send them before the order is agreed.\nMethod: ${pc.method || 'as arranged'}${pc.link ? '\nPayment link: ' + pc.link : ''}${pc.instructions ? '\nInstructions: ' + pc.instructions : ''}`;
    }
    const system = `You are the WhatsApp SALES assistant for this business:
${settings.ai_prompt || settings.business_name || 'A business.'}${extraCtx}

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
        if (!out.ok) await logMsg(userId, from, 'out', `[AI reply FAILED to send: ${out.error || 'unknown'}]`, 'error', null);
      }
      if (lead) {
        // Appointment Agent: if the AI captured a chosen slot, book it
        if (lead.book_slot && settings.booking_enabled) {
          try {
            const when = new Date(lead.book_slot);
            if (!isNaN(when)) {
              let cfg = {}; try { cfg = settings.booking_config ? JSON.parse(settings.booking_config) : {}; } catch {}
              await sb('wm_appointments', { method: 'POST', body: JSON.stringify([{ user_id: userId, phone: from, customer_name: lead.name || '', slot_at: when.toISOString(), service: cfg.service || 'Appointment', status: 'booked' }]) });
              if (settings.owner_phone) {
                const ab = `\uD83D\uDCC5 New booking!\n\uD83D\uDC64 ${lead.name || from}\n\uD83D\uDD52 ${when.toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}\n${cfg.service || 'Appointment'}`;
                const ob = await waSend(settings, settings.owner_phone.replace(/\D/g,''), waText(ab));
                if (ob.ok) await logMsg(userId, settings.owner_phone, 'out', ab, 'alert', ob.id);
              }
            }
          } catch {}
        }
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
          // ── Team-Handoff Agent: route to the right person ──
          if (settings.handoff_enabled) {
            try {
              const tm = await sb(`wm_team?user_id=eq.${userId}&active=eq.true&select=*`);
              const team = tm.ok ? await tm.json() : [];
              const low = text.toLowerCase();
              const byDept = { complaint: 'support', support: 'support', billing: 'billing', order: 'sales', inquiry: 'sales' };
              let pick = team.find(t => (t.keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean).some(k => low.includes(k)));
              if (!pick) pick = team.find(t => t.department === byDept[row.category]);
              if (!pick && cls.priority === 'urgent') pick = team.find(t => t.department === 'manager');
              if (pick) {
                const hb = `\uD83D\uDCE8 Handed to you \u2014 ${row.category} (${row.priority})\n\uD83D\uDC64 ${nm || from} \u00B7 ${region.country} \u00B7 ${region.local_time} local\n\uD83D\uDCDD ${cls.summary || text.slice(0, 90)}\n\nReply: https://wa.me/${from}`;
                const ho = await waSend(settings, pick.phone.replace(/\D/g, ''), waText(hb));
                if (ho.ok) await logMsg(userId, pick.phone, 'out', hb, 'handoff', ho.id);
              }
            } catch {}
          }
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
      let textTw = b.Body || '';
      const numMedia = parseInt(b.NumMedia || '0', 10) || 0;
      const mediaUrl = b.MediaUrl0 || '';
      const mediaType = b.MediaContentType0 || '';
      if (!fromTw || (!textTw && !numMedia)) { res.setHeader('Content-Type', 'text/xml'); return res.status(200).send('<Response></Response>'); }
      // route tenant by twilio_from matching this To
      const sr = await sb(`wm_settings?provider=eq.twilio&twilio_from=eq.${encodeURIComponent('whatsapp:' + toTw)}&select=*`);
      let settings = (sr.ok ? await sr.json() : [])[0];
      if (!settings) { // try without whatsapp: prefix variance
        const sr2 = await sb(`wm_settings?provider=eq.twilio&select=*`);
        const rows2 = sr2.ok ? await sr2.json() : [];
        settings = rows2.find(s => (s.twilio_from || '').replace('whatsapp:', '').replace('+', '') === toTw.replace('+', ''));
      }
      if (settings) {
        // Voice-Note Agent (Twilio): transcribe audio media via Whisper
        if (numMedia && mediaUrl && mediaType.startsWith('audio') && settings.voice_enabled) {
          try { textTw = await transcribeTwilioAudio(mediaUrl, mediaType, settings) || textTw; } catch {}
        }
        if (textTw) await handleInbound(settings, fromTw, textTw, null);
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
    if (!msg) return res.status(200).json({ ok: true });
    const isText = msg.type === 'text';
    const isAudio = msg.type === 'audio' || msg.type === 'voice';
    if (!isText && !isAudio) return res.status(200).json({ ok: true });

    const phoneNumberId = value?.metadata?.phone_number_id;
    const from = msg.from;
    let text = msg.text?.body || '';
    if (!phoneNumberId || !from) return res.status(200).json({ ok: true });

    const sr = await sb(`wm_settings?phone_number_id=eq.${encodeURIComponent(phoneNumberId)}&select=*`);
    const settings = (sr.ok ? await sr.json() : [])[0];
    if (!settings) return res.status(200).json({ ok: true });
    const userId = settings.user_id;

    if (isAudio && settings.voice_enabled) {
      try {
        const mediaId = (msg.audio || msg.voice)?.id;
        text = await transcribeWhatsAppAudio(mediaId, settings) || text;
      } catch {}
    }
    if (!text) return res.status(200).json({ ok: true });
    await handleInbound(settings, from, text, msg.id);
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(200).json({ ok: true }); }
}

// Cron 04:00 UTC (= 7 AM Beirut): WhatsApp a daily report to each owner
import { sb, waSend, waText, waTemplate, logMsg } from './_lib.js';

export default async function handler(req, res) {
  const report = { sent: 0, failed: 0 };
  try {
    const sr = await sb(`wm_settings?daily_summary=eq.true&select=*`);
    const all = sr.ok ? await sr.json() : [];
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    for (const s of all) {
      if (!s.owner_phone || !s.access_token || !s.phone_number_id) continue;
      try {
        const uid = s.user_id;
        const [mr, cr, ir] = await Promise.all([
          sb(`wm_messages?user_id=eq.${uid}&created_at=gte.${since}&select=direction,phone,kind`),
          sb(`wm_contacts?user_id=eq.${uid}&created_at=gte.${since}&select=name,phone,interest,source`),
          sb(`wm_contacts?user_id=eq.${uid}&intent_at=gte.${since}&select=name,phone,interest,intent,order_note`),
        ]);
        const msgs = mr.ok ? await mr.json() : [];
        const newContacts = cr.ok ? await cr.json() : [];
        const intents = ir.ok ? await ir.json() : [];
        const hotToday = intents.filter(c => c.intent === 'hot');
        const orders = intents.filter(c => c.order_note);
        const inbound = msgs.filter(m => m.direction === 'in');
        const outbound = msgs.filter(m => m.direction === 'out');
        const convos = new Set(inbound.map(m => m.phone)).size;
        const hot = hotToday.length ? hotToday : newContacts.filter(c => c.interest);
        const hotLine = hot.slice(0, 3).map(c => `${c.name || c.phone} (${c.order_note || c.interest || 'interested'})`).join(', ');

        const line = `${convos} convos, ${newContacts.length} new leads, ${hotToday.length} hot, ${orders.length} orders` + (hot.length ? `. CALL: ${hotLine}` : '');
        const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

        const body = `📊 ${s.business_name || 'Your business'} — daily report ${dateStr}\n\n💬 Conversations: ${convos}\n⬅️ Inbound messages: ${inbound.length}\n➡️ Sent: ${outbound.length}\n🆕 New leads: ${newContacts.length}\n🔥 Hot leads: ${hotToday.length}\n🛒 Orders collected: ${orders.length}${hot.length ? `\n\n📞 Call today: ${hotLine}` : ''}\n\n— Z24SEVEN.tel`;

        // try free text (works if owner messaged the bot in last 24h), fall back to template
        let out = await waSend(s, s.owner_phone.replace(/\D/g, ''), waText(body));
        if (!out.ok) {
          out = await waSend(s, s.owner_phone.replace(/\D/g, ''), waTemplate('daily_summary', 'en', [dateStr, line]));
        }
        if (out.ok) { report.sent++; await logMsg(uid, s.owner_phone, 'out', body, 'report', out.id); }
        else report.failed++;
        await new Promise(r2 => setTimeout(r2, 300));
      } catch { report.failed++; }
    }
    return res.status(200).json({ ok: true, ...report });
  } catch (e) { return res.status(200).json({ ok: false, error: e.message, ...report }); }
}

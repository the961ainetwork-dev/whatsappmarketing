import { sb, waSend, waText, logMsg, cors } from './_lib.js';
import { dueForFollowup } from './followup.js';

const aKey = () => process.env.ANTHROPIC_API_KEY;

async function aiLine(prompt, max = 300) {
  const k = aKey();
  if (!k) return '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': k },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: max, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch { return ''; }
}

// ── 1. Follow-up / re-engagement ──
async function runFollowups(s) {
  let cfg = {}; try { cfg = s.followup_config ? JSON.parse(s.followup_config) : {}; } catch {}
  const due = (await dueForFollowup(s.user_id, cfg)).slice(0, 12);
  let sent = 0;
  for (const c of due) {
    const days = Math.max(1, Math.round((Date.now() - new Date(c.last_inbound)) / 86400000));
    const msg = await aiLine(`Write ONE short WhatsApp follow-up to a customer who went quiet. Reply with the message only — no quotes, no preamble.

Business: ${s.ai_prompt || s.business_name || 'a business'}
Customer name: ${c.name || 'unknown'}
What they were interested in: ${c.order_note || c.interest || 'not specified'}
They last wrote ${days} days ago and never replied again.
Language: mirror the language and dialect of their interest note; if unclear, write in both a short Arabic line and a short English line.

Rules: warm and low-pressure, under 30 words, no discount unless the business info mentions one, one clear easy question at the end. Never guilt them for not replying.`);
    if (!msg) continue;
    const out = await waSend(s, c.phone, waText(msg));
    if (out.ok) {
      await logMsg(s.user_id, c.phone, 'out', msg, 'followup', out.id);
      await sb(`wm_contacts?user_id=eq.${s.user_id}&phone=eq.${c.phone}`, {
        method: 'PATCH',
        body: JSON.stringify({ followup_count: (c.followup_count || 0) + 1, last_followup_at: new Date().toISOString() }),
      });
      sent++;
    }
  }
  return sent;
}

// ── 2. Review requests after a resolved conversation ──
async function runReviews(s) {
  let cfg = {}; try { cfg = s.review_config ? JSON.parse(s.review_config) : {}; } catch {}
  const delay = Number(cfg.delay_days ?? 2);
  const cutoff = new Date(Date.now() - delay * 86400000).toISOString();
  const tr = await sb(`wm_tickets?user_id=eq.${s.user_id}&status=eq.resolved&updated_at=lt.${cutoff}&select=phone,contact_name&limit=20`);
  if (!tr.ok) return 0;
  const tickets = await tr.json();
  let sent = 0;
  for (const t of tickets.slice(0, 10)) {
    const ex = await sb(`wm_reviews?user_id=eq.${s.user_id}&phone=eq.${t.phone}&select=id&limit=1`);
    if (ex.ok && (await ex.json()).length) continue;   // already asked
    const msg = await aiLine(`Write ONE very short WhatsApp message asking a customer to rate their experience from 1 to 5. Reply with the message only.

Business: ${s.business_name || 'the business'}
Customer name: ${t.contact_name || 'unknown'}
Rules: friendly, under 25 words, ask them to reply with a number from 1 to 5. If the business name suggests Arabic-speaking customers, write one short Arabic line and one short English line.`);
    if (!msg) continue;
    const out = await waSend(s, t.phone, waText(msg));
    if (out.ok) {
      await sb('wm_reviews', { method: 'POST', body: JSON.stringify([{ user_id: s.user_id, phone: t.phone, contact_name: t.contact_name || '', status: 'requested' }]) });
      await logMsg(s.user_id, t.phone, 'out', msg, 'review', out.id);
      sent++;
    }
  }
  return sent;
}

// ── 3. Invoice reminders ──
async function runInvoices(s) {
  let cfg = {}; try { cfg = s.invoice_config ? JSON.parse(s.invoice_config) : {}; } catch {}
  const before = Number(cfg.before ?? 3);
  const after = Array.isArray(cfg.after) ? cfg.after.map(Number) : [1, 7, 14];
  const ir = await sb(`wm_invoices?user_id=eq.${s.user_id}&status=eq.unpaid&select=*&limit=100`);
  if (!ir.ok) return 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let sent = 0;
  for (const inv of await ir.json()) {
    if (!inv.due_at) continue;
    const due = new Date(inv.due_at); due.setHours(0, 0, 0, 0);
    const diff = Math.round((due - today) / 86400000);      // + = future, - = overdue
    const isDue = (diff === before) || (diff === 0) || after.includes(-diff);
    if (!isDue) continue;
    // never remind twice in one day
    if (inv.last_reminded_at && (Date.now() - new Date(inv.last_reminded_at)) < 20 * 3600000) continue;
    const state = diff > 0 ? `due in ${diff} day(s)` : diff === 0 ? 'due today' : `${-diff} day(s) overdue`;
    const msg = await aiLine(`Write ONE polite WhatsApp payment reminder. Reply with the message only.

Business: ${s.business_name || 'the business'}
Customer: ${inv.customer_name || 'the customer'}
Invoice: ${inv.reference || 'invoice'} for ${inv.amount} ${inv.currency}
Status: ${state}
Rules: courteous and professional, never accusatory, under 40 words. State the amount and the reference. If overdue, stay warm and simply ask when they expect to settle. Offer to send payment details.`);
    if (!msg) continue;
    const out = await waSend(s, inv.phone, waText(msg));
    if (out.ok) {
      await sb(`wm_invoices?id=eq.${inv.id}`, { method: 'PATCH', body: JSON.stringify({ last_reminded_at: new Date().toISOString(), reminder_count: (inv.reminder_count || 0) + 1 }) });
      await logMsg(s.user_id, inv.phone, 'out', msg, 'invoice', out.id);
      sent++;
    }
  }
  return sent;
}

export default async function handler(req, res) {
  cors(res);
  try {
    const r = await sb('wm_settings?or=(followup_enabled.eq.true,review_enabled.eq.true,invoice_enabled.eq.true)&select=*&limit=200');
    if (!r.ok) return res.status(200).json({ ok: true, accounts: 0 });
    const rows = await r.json();
    const totals = { followups: 0, reviews: 0, invoices: 0 };
    for (const s of rows) {
      try {
        if (s.followup_enabled) totals.followups += await runFollowups(s);
        if (s.review_enabled)   totals.reviews   += await runReviews(s);
        if (s.invoice_enabled)  totals.invoices  += await runInvoices(s);
      } catch {}
    }
    return res.status(200).json({ ok: true, accounts: rows.length, ...totals });
  } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
}

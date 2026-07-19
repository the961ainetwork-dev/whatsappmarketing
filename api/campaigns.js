import { sb, authUser, readBody, cors, waSend, waText, waTemplate, getSettings, logMsg, logEvent, warmupCap, sentToday } from './_lib.js';

const BATCH = 30; // per invocation (Vercel time limit safe)

export function segmentFilter(category) {
  // smart segments: seg:hot | seg:warm | seg:replied7d | seg:never | seg:new7d
  if (!category?.startsWith('seg:')) return null;
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  switch (category.slice(4)) {
    case 'hot': return '&intent=eq.hot';
    case 'warm': return '&intent=eq.warm';
    case 'replied7d': return `&last_inbound=gte.${d7}`;
    case 'never': return '&last_inbound=is.null';
    case 'new7d': return `&created_at=gte.${d7}`;
    default: return '';
  }
}

export async function processCampaign(c, settings) {
  // ── Anti-ban warm-up: respect daily cap ──
  if (!settings.first_send_at) {
    settings.first_send_at = new Date().toISOString();
    await sb(`wm_settings?user_id=eq.${c.user_id}`, { method: 'PATCH', body: JSON.stringify({ first_send_at: settings.first_send_at }) });
  }
  if (settings.warmup !== false) {
    const cap = warmupCap(settings.first_send_at);
    const used = await sentToday(c.user_id);
    if (used >= cap) {
      return { sent: 0, failed: 0, done: false, capped: true, cap, note: `Daily warm-up cap reached (${cap}/day) — resumes tomorrow automatically. This protects your number from Meta bans.` };
    }
  }

  const seg = segmentFilter(c.category);
  const catQ = seg !== null ? seg : (c.category && c.category !== 'all' ? `&category=eq.${encodeURIComponent(c.category)}` : '');
  const r = await sb(`wm_contacts?user_id=eq.${c.user_id}${catQ}&opt_in=eq.true&id=gt.${c.cursor}&select=*&order=id.asc&limit=${BATCH}`);
  const batch = r.ok ? await r.json() : [];
  let sent = 0, failed = 0, last = c.cursor;

  for (const ct of batch) {
    const varVal = c.var1_field === 'name' ? (ct.name || 'there') : (ct[c.var1_field] || '');
    const payload = c.mode === 'template'
      ? waTemplate(c.template_name, c.lang, c.body?.includes('{{1}}') || true ? [varVal] : [])
      : waText((c.body || '').replaceAll('{{1}}', varVal));
    const out = await waSend(settings, ct.phone, payload);
    if (out.ok) { sent++; await logMsg(c.user_id, ct.phone, 'out', c.mode === 'template' ? `[template:${c.template_name}]` : c.body, c.mode, out.id, c.id); }
    else failed++;
    last = ct.id;
    await new Promise(s => setTimeout(s, 250)); // gentle rate
  }

  const doneNow = batch.length < BATCH;
  await sb(`wm_campaigns?id=eq.${c.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ cursor: last, sent: c.sent + sent, failed: c.failed + failed, status: doneNow ? 'done' : 'sending' }),
  });
  return { sent, failed, done: doneNow };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const r = await sb(`wm_campaigns?user_id=eq.${user.id}&select=*&order=id.desc&limit=100`);
      return res.status(200).json({ items: r.ok ? await r.json() : [] });
    }

    if (req.method === 'POST') {
      const b = readBody(req);

      if (b.action === 'send' || b.action === 'schedule') {
        const row = {
          user_id: user.id, name: String(b.name || 'Campaign').slice(0, 120),
          mode: b.mode === 'text' ? 'text' : 'template',
          template_name: String(b.template_name || '').slice(0, 120),
          lang: String(b.lang || 'en').slice(0, 10),
          body: String(b.body || '').slice(0, 2000),
          var1_field: ['name', 'interest', 'phone'].includes(b.var1_field) ? b.var1_field : 'name',
          category: String(b.category || 'all').slice(0, 60),
          status: b.action === 'schedule' ? 'scheduled' : 'sending',
          scheduled_at: b.action === 'schedule' ? b.scheduled_at : null,
        };
        if (row.mode === 'template' && !row.template_name) return res.status(400).json({ error: 'Template name required (create it in Meta Business Manager first)' });
        if (row.mode === 'text' && !row.body) return res.status(400).json({ error: 'Message body required' });
        const cr = await sb('wm_campaigns', { method: 'POST', body: JSON.stringify([row]) });
        if (!cr.ok) return res.status(500).json({ error: 'Create failed' });
        const [c] = await cr.json();

        logEvent(user.id, user.email, b.action === 'send' ? 'campaign_send' : 'campaign_schedule', row.name);
        if (b.action === 'send') {
          const settings = await getSettings(user.id);
          if (!settings?.access_token) return res.status(400).json({ error: 'Connect WhatsApp in Settings first' });
          const out = await processCampaign(c, settings);
          return res.status(200).json({ ok: true, id: c.id, ...out, note: out.done ? 'Complete' : 'First batch sent — cron continues the rest automatically' });
        }
        return res.status(200).json({ ok: true, id: c.id, scheduled: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      await sb(`wm_campaigns?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

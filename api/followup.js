import { sb, authUser, readBody, cors } from './_lib.js';

// Contacts who showed interest then went silent
export async function dueForFollowup(userId, cfg) {
  const days = Number(cfg.days ?? 3);
  const max = Number(cfg.max ?? 2);
  const window = Number(cfg.window ?? 30);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const floor = new Date(Date.now() - window * 86400000).toISOString();
  const q = `wm_contacts?user_id=eq.${userId}`
    + `&intent=in.(warm,hot)`
    + `&opt_in=eq.true`
    + `&followup_stop=eq.false`
    + `&last_inbound=lt.${cutoff}`
    + `&last_inbound=gte.${floor}`
    + `&followup_count=lt.${max}`
    + `&select=id,phone,name,interest,order_note,intent,last_inbound,followup_count,last_followup_at`
    + `&order=last_inbound.desc&limit=60`;
  const r = await sb(q);
  if (!r.ok) return [];
  const rows = await r.json();
  // don't nudge twice within the same gap
  return rows.filter(c => !c.last_followup_at || new Date(c.last_followup_at) < new Date(cutoff));
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const sr = await sb(`wm_settings?user_id=eq.${user.id}&select=followup_enabled,followup_config`);
      const s = (sr.ok ? await sr.json() : [])[0] || {};
      let cfg = {}; try { cfg = s.followup_config ? JSON.parse(s.followup_config) : {}; } catch {}
      const due = await dueForFollowup(user.id, cfg);
      const sent = await sb(`wm_contacts?user_id=eq.${user.id}&followup_count=gt.0&select=id,name,phone,followup_count,last_followup_at,intent&order=last_followup_at.desc&limit=50`);
      return res.status(200).json({
        enabled: !!s.followup_enabled,
        config: { days: cfg.days ?? 3, max: cfg.max ?? 2, window: cfg.window ?? 30 },
        due: due.map(c => ({ name: c.name, phone: c.phone, interest: c.interest || c.order_note || '', intent: c.intent, silent_since: c.last_inbound })),
        recent: sent.ok ? await sent.json() : [],
      });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      const cfg = { days: Number(b.days ?? 3), max: Number(b.max ?? 2), window: Number(b.window ?? 30) };
      const patch = { followup_config: JSON.stringify(cfg) };
      if ('enabled' in b) patch.followup_enabled = !!b.enabled;
      const r = await sb(`wm_settings?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not save settings' });
    }

    // stop chasing one contact
    if (req.method === 'POST') {
      const b = readBody(req);
      if (b.action === 'stop' && b.phone) {
        await sb(`wm_contacts?user_id=eq.${user.id}&phone=eq.${String(b.phone).replace(/\D/g, '')}`,
          { method: 'PATCH', body: JSON.stringify({ followup_stop: true }) });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

import { sb, authUser, readBody, cors, getSettings, waSend, waText, logMsg } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const st = req.query?.status, cat = req.query?.category, fu = req.query?.followup;
      let q = `wm_tickets?user_id=eq.${user.id}`;
      if (st && st !== 'all') q += `&status=eq.${st}`;
      if (cat && cat !== 'all') q += `&category=eq.${cat}`;
      if (fu === '1') q += `&needs_followup=eq.true&status=neq.resolved`;
      q += `&select=*&order=updated_at.desc&limit=200`;
      const r = await sb(q);
      const items = r.ok ? await r.json() : [];
      // counts for the board
      const cr = await sb(`wm_tickets?user_id=eq.${user.id}&select=status,needs_followup,priority`);
      const all = cr.ok ? await cr.json() : [];
      const counts = {
        new: all.filter(t => t.status === 'new').length,
        in_progress: all.filter(t => t.status === 'in_progress').length,
        resolved: all.filter(t => t.status === 'resolved').length,
        followup: all.filter(t => t.needs_followup && t.status !== 'resolved').length,
        urgent: all.filter(t => t.priority === 'urgent' && t.status !== 'resolved').length,
      };
      return res.status(200).json({ items, counts });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      const patch = { updated_at: new Date().toISOString() };
      if (['new','in_progress','resolved'].includes(b.status)) patch.status = b.status;
      if (['inquiry','order','complaint','support','billing','followup','other'].includes(b.category)) patch.category = b.category;
      if (['urgent','normal','low'].includes(b.priority)) patch.priority = b.priority;
      if (typeof b.needs_followup === 'boolean') patch.needs_followup = b.needs_followup;
      const r = await sb(`wm_tickets?id=eq.${Number(b.id)}&user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Update failed' });
    }

    if (req.method === 'POST') {
      // send a reply straight from the ticket
      const b = readBody(req);
      const tr = await sb(`wm_tickets?id=eq.${Number(b.id)}&user_id=eq.${user.id}&select=phone`);
      const [tk] = tr.ok ? await tr.json() : [];
      if (!tk) return res.status(404).json({ error: 'Ticket not found' });
      const s = await getSettings(user.id);
      if (!s?.access_token) return res.status(400).json({ error: 'Connect WhatsApp first' });
      const out = await waSend(s, tk.phone, waText(String(b.text || '').slice(0, 3000)));
      if (!out.ok) return res.status(400).json({ error: out.error || 'Send failed (24h window / template rules)' });
      await logMsg(user.id, tk.phone, 'out', b.text, 'ticket', out.id);
      await sb(`wm_tickets?id=eq.${Number(b.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress', updated_at: new Date().toISOString() }) });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      await sb(`wm_tickets?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

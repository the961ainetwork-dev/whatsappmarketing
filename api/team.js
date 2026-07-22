import { sb, authUser, readBody, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const [tr, sr] = await Promise.all([
        sb(`wm_team?user_id=eq.${user.id}&select=*&order=id.asc&limit=50`),
        sb(`wm_settings?user_id=eq.${user.id}&select=handoff_enabled`),
      ]);
      const s = (sr.ok ? await sr.json() : [])[0] || {};
      return res.status(200).json({ team: tr.ok ? await tr.json() : [], enabled: !!s.handoff_enabled });
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      if (!b.name || !b.phone) return res.status(400).json({ error: 'Name and WhatsApp number are required' });
      const row = {
        user_id: user.id,
        name: String(b.name).slice(0, 120),
        phone: String(b.phone).replace(/\D/g, ''),
        department: ['sales', 'support', 'billing', 'manager'].includes(b.department) ? b.department : 'sales',
        keywords: String(b.keywords || '').slice(0, 300),
      };
      const r = await sb('wm_team', { method: 'POST', body: JSON.stringify([row]) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not add the teammate' });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      if (b.action === 'toggle') {
        const r = await sb(`wm_settings?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ handoff_enabled: !!b.enabled }) });
        return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not save' });
      }
      const patch = {};
      if ('active' in b) patch.active = !!b.active;
      if ('keywords' in b) patch.keywords = String(b.keywords || '').slice(0, 300);
      const r = await sb(`wm_team?id=eq.${Number(b.id)}&user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not update' });
    }

    if (req.method === 'DELETE') {
      await sb(`wm_team?id=eq.${Number(req.query?.id)}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

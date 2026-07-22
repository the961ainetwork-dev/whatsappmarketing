import { sb, authUser, readBody, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const [rr, sr] = await Promise.all([
        sb(`wm_reviews?user_id=eq.${user.id}&select=*&order=id.desc&limit=200`),
        sb(`wm_settings?user_id=eq.${user.id}&select=review_enabled,review_config`),
      ]);
      const s = (sr.ok ? await sr.json() : [])[0] || {};
      let cfg = {}; try { cfg = s.review_config ? JSON.parse(s.review_config) : {}; } catch {}
      const rows = rr.ok ? await rr.json() : [];
      const rated = rows.filter(r => r.rating);
      const avg = rated.length ? (rated.reduce((a, r) => a + r.rating, 0) / rated.length).toFixed(1) : null;
      return res.status(200).json({ reviews: rows, enabled: !!s.review_enabled, config: cfg, average: avg, count: rated.length });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      const cfg = { delay_days: Number(b.delay_days ?? 2), google_url: String(b.google_url || '').slice(0, 400) };
      const patch = { review_config: JSON.stringify(cfg) };
      if ('enabled' in b) patch.review_enabled = !!b.enabled;
      const r = await sb(`wm_settings?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not save settings' });
    }

    if (req.method === 'DELETE') {
      await sb(`wm_reviews?id=eq.${Number(req.query?.id)}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

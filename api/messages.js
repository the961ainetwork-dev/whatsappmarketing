import { sb, authUser, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const phone = req.query?.phone ? `&phone=eq.${encodeURIComponent(req.query.phone)}` : '';
    const r = await sb(`wm_messages?user_id=eq.${user.id}${phone}&select=*&order=id.desc&limit=100`);
    const items = r.ok ? await r.json() : [];
    return res.status(200).json({ items, count: items.length });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

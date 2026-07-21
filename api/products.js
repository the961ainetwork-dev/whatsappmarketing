import { sb, authUser, readBody, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const r = await sb(`wm_products?user_id=eq.${user.id}&select=*&order=id.desc&limit=500`);
      return res.status(200).json({ items: r.ok ? await r.json() : [] });
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      if (b.action === 'import') {
        // rows: [{name,price,category,description}]
        const rows = (b.rows || []).slice(0, 500)
          .map(r => ({
            user_id: user.id,
            name: String(r.name || '').slice(0, 200),
            price: r.price !== undefined && r.price !== '' ? Number(String(r.price).replace(/[^0-9.]/g, '')) : null,
            currency: String(r.currency || 'USD').slice(0, 8),
            category: String(r.category || '').slice(0, 80),
            description: String(r.description || '').slice(0, 500),
            in_stock: true,
          }))
          .filter(r => r.name);
        if (!rows.length) return res.status(400).json({ error: 'No valid rows (need at least a name)' });
        const r = await sb('wm_products', { method: 'POST', body: JSON.stringify(rows) });
        if (!r.ok) return res.status(500).json({ error: 'Import failed' });
        return res.status(200).json({ ok: true, imported: rows.length });
      }
      // single add
      if (!b.name) return res.status(400).json({ error: 'Product name required' });
      const row = {
        user_id: user.id, name: String(b.name).slice(0, 200),
        price: b.price !== undefined && b.price !== '' ? Number(String(b.price).replace(/[^0-9.]/g, '')) : null,
        currency: String(b.currency || 'USD').slice(0, 8),
        category: String(b.category || '').slice(0, 80),
        description: String(b.description || '').slice(0, 500),
        in_stock: b.in_stock !== false,
      };
      const r = await sb('wm_products', { method: 'POST', body: JSON.stringify([row]) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Add failed' });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      const patch = {};
      for (const k of ['name', 'category', 'description', 'currency']) if (k in b) patch[k] = String(b[k] || '').slice(0, 500);
      if ('price' in b) patch.price = b.price === '' ? null : Number(String(b.price).replace(/[^0-9.]/g, ''));
      if ('in_stock' in b) patch.in_stock = !!b.in_stock;
      const r = await sb(`wm_products?id=eq.${Number(b.id)}&user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Update failed' });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      await sb(`wm_products?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

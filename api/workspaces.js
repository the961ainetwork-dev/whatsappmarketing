import { sb, authUser, readBody, cors, hashPass, newSalt, newToken, logEvent } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  if (user.plan !== 'agency') return res.status(402).json({ error: 'upgrade', message: 'Workspaces are an Agency feature — manage multiple businesses/numbers under one login.' });

  try {
    if (req.method === 'GET') {
      const r = await sb(`wm_users?parent_id=eq.${user.id}&select=id,email,plan,status,created_at,last_seen`);
      const kids = r.ok ? await r.json() : [];
      // light stats
      const out = [];
      for (const k of kids) {
        const [cr, sr] = await Promise.all([
          sb(`wm_contacts?user_id=eq.${k.id}&select=id`),
          sb(`wm_settings?user_id=eq.${k.id}&select=business_name,phone_number_id`),
        ]);
        const contacts = cr.ok ? (await cr.json()).length : 0;
        const st = (sr.ok ? await sr.json() : [])[0] || {};
        out.push({ ...k, contacts, business_name: st.business_name, connected: !!st.phone_number_id });
      }
      return res.status(200).json({ workspaces: out });
    }

    if (req.method === 'POST') {
      const b = readBody(req);

      if (b.action === 'create') {
        const label = String(b.label || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'workspace';
        const salt = newSalt(), token = newToken();
        const email = `${label}-${token.slice(0, 6)}@ws.wamark`;
        const r = await sb('wm_users', {
          method: 'POST',
          body: JSON.stringify([{ email, salt, pass_hash: hashPass(token, salt), token, plan: 'pro', status: 'active', parent_id: user.id }]),
        });
        if (!r.ok) return res.status(500).json({ error: 'Create failed' });
        const [k] = await r.json();
        await sb('wm_settings', { method: 'POST', body: JSON.stringify([{ user_id: k.id, business_name: b.label || label }]) });
        logEvent(user.id, user.email, 'workspace_create', label);
        return res.status(200).json({ ok: true, id: k.id, email });
      }

      if (b.action === 'switch') {
        const r = await sb(`wm_users?id=eq.${Number(b.childId)}&parent_id=eq.${user.id}&select=token,email,plan,status`);
        const [k] = r.ok ? await r.json() : [];
        if (!k) return res.status(404).json({ error: 'Workspace not found' });
        return res.status(200).json({ ok: true, token: k.token, email: k.email, plan: k.plan, status: k.status });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.childId);
      const r = await sb(`wm_users?id=eq.${id}&parent_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Delete failed' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

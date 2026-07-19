import { sb, hashPass, newSalt, newToken, readBody, cors, logEvent } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { action, email, password } = readBody(req);

  try {
    const em = String(email || '').trim().toLowerCase();
    if (!em.includes('@') || String(password || '').length < 6)
      return res.status(400).json({ error: 'Valid email + password (6+ chars) required' });

    if (action === 'signup') {
      const salt = newSalt(), token = newToken();
      const r = await sb('wm_users', {
        method: 'POST',
        body: JSON.stringify([{ email: em, salt, pass_hash: hashPass(password, salt), token, status: 'pending' }]),
      });
      if (!r.ok) {
        const t = await r.text();
        if (t.includes('duplicate')) return res.status(400).json({ error: 'Account already exists — sign in instead' });
        return res.status(500).json({ error: 'Signup failed' });
      }
      const [u] = await r.json();
      await sb('wm_settings', { method: 'POST', body: JSON.stringify([{ user_id: u.id }]) });
      logEvent(u.id, em, 'signup');
      return res.status(200).json({ token, email: em, status: 'pending', plan: 'free' });
    }

    if (action === 'login') {
      const r = await sb(`wm_users?email=eq.${encodeURIComponent(em)}&select=*`);
      const [u] = r.ok ? await r.json() : [];
      if (!u || hashPass(password, u.salt) !== u.pass_hash)
        return res.status(401).json({ error: 'Wrong email or password' });
      if (u.status === 'rejected') return res.status(403).json({ error: 'This account was not approved. Contact support.' });
      if (u.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });
      logEvent(u.id, em, 'login');
      return res.status(200).json({ token: u.token, email: u.email, status: u.status, plan: u.plan });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

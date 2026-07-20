import { sb, authUser, readBody, cors, waSend, waText, getSettings, logEvent } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const s = await getSettings(user.id);
      if (s) { s.access_token = s.access_token ? '••••' + String(s.access_token).slice(-6) : ''; s.twilio_token = s.twilio_token ? '••••' + String(s.twilio_token).slice(-4) : ''; }
      return res.status(200).json({ settings: s || {} });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      const patch = { updated_at: new Date().toISOString() };
      for (const k of ['phone_number_id', 'waba_id', 'business_name', 'ai_prompt', 'owner_phone', 'twilio_sid', 'twilio_from']) if (k in b) patch[k] = String(b[k] || '').slice(0, 4000);
      if (b.provider && ['meta', 'twilio'].includes(b.provider)) patch.provider = b.provider;
      if (b.twilio_token && !String(b.twilio_token).startsWith('••••')) patch.twilio_token = String(b.twilio_token);
      if ('daily_summary' in b) patch.daily_summary = !!b.daily_summary;
      if ('warmup' in b) patch.warmup = !!b.warmup;
      if ('callcenter' in b) patch.callcenter = !!b.callcenter;
      if ('ai_enabled' in b) patch.ai_enabled = !!b.ai_enabled;
      if (b.access_token && !String(b.access_token).startsWith('••••')) patch.access_token = String(b.access_token);
      const r = await sb(`wm_settings?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!r.ok) return res.status(500).json({ error: 'Save failed' });
      logEvent(user.id, user.email, 'settings_save', patch.phone_number_id ? 'wa_creds' : ('ai_enabled' in patch ? 'ai_' + patch.ai_enabled : 'profile'));
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST') {
      // test send
      const { to } = readBody(req);
      const s = await getSettings(user.id);
      const ready = s?.provider === 'twilio' ? (s?.twilio_sid && s?.twilio_token && s?.twilio_from) : (s?.phone_number_id && s?.access_token);
      if (!ready) return res.status(400).json({ error: 'Add your WhatsApp credentials first' });
      const out = await waSend(s, String(to || '').replace(/\D/g, ''), waText('✅ WA-Marketer connected! Your WhatsApp integration works.'));
      return res.status(out.ok ? 200 : 400).json(out.ok ? { ok: true } : { error: out.error || 'Send failed — check credentials. Note: outside a 24h window, only template messages deliver.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

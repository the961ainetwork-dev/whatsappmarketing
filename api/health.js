import { sb, authUser, cors, warmupCap, sentToday, getSettings } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const s = await getSettings(user.id);
    const cap = s?.warmup === false ? 1000 : warmupCap(s?.first_send_at);
    const used = await sentToday(user.id);
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const mr = await sb(`wm_messages?user_id=eq.${user.id}&created_at=gte.${since}&select=direction,status`);
    const msgs = mr.ok ? await mr.json() : [];
    const out = msgs.filter(m => m.direction === 'out');
    const inb = msgs.filter(m => m.direction === 'in');
    const failed = out.filter(m => m.status === 'failed').length;
    const read = out.filter(m => m.status === 'read').length;
    const failRate = out.length ? failed / out.length : 0;
    const replyRate = out.length ? Math.min(1, inb.length / out.length) : 0;
    const score = Math.max(0, Math.min(100, Math.round(100 - failRate * 120 + replyRate * 15 - (used > cap ? 10 : 0))));
    const days = s?.first_send_at ? Math.floor((Date.now() - new Date(s.first_send_at)) / 86400000) + 1 : 0;
    return res.status(200).json({
      score, sent_today: used, cap, warmup: s?.warmup !== false, warmup_day: days,
      week: { sent: out.length, inbound: inb.length, failed, read, fail_rate: Math.round(failRate * 100), reply_rate: Math.round(replyRate * 100) },
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

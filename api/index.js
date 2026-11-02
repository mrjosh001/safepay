import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { provider } from '../lib/providers.js';

const { DATABASE_URL } = process.env;
const MIN_CENTS = 100n, MAX_CENTS = 50000n, EXPIRY_SECS = 3600;
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
const ready = pool.query(`CREATE TABLE IF NOT EXISTS orders(
  ref TEXT PRIMARY KEY, usd_cents INTEGER NOT NULL, sats INTEGER NOT NULL, rate TEXT NOT NULL,
  rate_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', provider TEXT NOT NULL,
  provider_id TEXT UNIQUE NOT NULL, bolt11 TEXT NOT NULL, expires_at INTEGER NOT NULL,
  paid_at INTEGER, late BOOLEAN NOT NULL DEFAULT false, created_at INTEGER NOT NULL)`);
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const now = () => Math.floor(Date.now() / 1000);

// best-effort per-instance limiter (serverless instances don't share memory; add edge limits for real protection)
const hits = new Map();
const limit = (name, max) => (req, res, next) => {
  const k = `${name}:${req.ip}`, t = now(), h = (hits.get(k) || []).filter(x => x > t - 60);
  if (h.length >= max) return res.status(429).json({ error: 'Too many requests, try again shortly.' });
  h.push(t); hits.set(k, h); next();
};

async function getRate() {
  const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('rate');
  const d = (await r.json()).data;
  if (d?.base !== 'BTC' || d?.currency !== 'USD' || !/^\d{1,7}(\.\d{1,8})?$/.test(d.amount)) throw new Error('rate');
  const [i, f = ''] = d.amount.split('.');
  const rateCents = BigInt(i + (f + '00').slice(0, 2));
  if (rateCents <= 0n) throw new Error('rate');
  return { rateCents, text: d.amount };
}
const toSats = (usd, rate) => (usd * 100000000n + rate - 1n) / rate; // integer math, rounds up

async function refresh(o) {
  if (o.status === 'paid') return o;
  const paid = await provider().isPaid(o.provider_id).catch(() => false);
  if (paid) {
    const late = o.status === 'expired' || now() > o.expires_at;
    const r = await q(`UPDATE orders SET status='paid', paid_at=$1, late=$2 WHERE ref=$3 AND status IN ('pending','expired') RETURNING ref`, [now(), late, o.ref]);
    if (r.length === 1) console.log(JSON.stringify({ evt: 'order_paid', ref: o.ref, late })); // fulfillment hook: runs once
  } else if (o.status === 'pending' && now() > o.expires_at) {
    await q(`UPDATE orders SET status='expired' WHERE ref=$1 AND status='pending'`, [o.ref]);
  }
  return (await q('SELECT * FROM orders WHERE ref=$1', [o.ref]))[0];
}
const cashApp = b => /^lnbc[0-9a-z]{50,2000}$/i.test(b) ? `https://cash.app/launch/lightning/${b}` : null;
const pub = o => ({ ref: o.ref, usd: (o.usd_cents / 100).toFixed(2), sats: o.sats, btc: (o.sats / 1e8).toFixed(8),
  rate: o.rate, rateAt: o.rate_at, status: o.status, late: o.late, expiresAt: o.expires_at, paidAt: o.paid_at, serverNow: now(),
  bolt11: o.status === 'pending' ? o.bolt11 : undefined, cashAppLink: o.status === 'pending' ? cashApp(o.bolt11) : undefined });

const app = express();
app.set('trust proxy', 1);

// Webhook needs the raw body for signature checks; the signature is verified, then status is re-checked with the provider.
app.post('/api/webhook', express.raw({ type: '*/*', limit: '10kb' }), async (req, res) => {
  try {
    const id = provider().webhookPaymentId(req.body, req.headers);
    await ready;
    const o = id && (await q('SELECT * FROM orders WHERE provider_id=$1', [id]))[0];
    if (o) await refresh(o);
    res.sendStatus(200);
  } catch (e) { res.sendStatus(e.message === 'bad signature' ? 401 : 500); }
});

app.use(express.json({ limit: '2kb' }));

app.post('/api/checkout', limit('checkout', 10), async (req, res) => {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(String(req.body?.usd ?? ''));
  if (!m) return res.status(400).json({ error: 'Enter a valid USD amount, like 25 or 25.50.' });
  const usd = BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0') || '0');
  if (usd < MIN_CENTS || usd > MAX_CENTS) return res.status(400).json({ error: 'Amount must be between $1.00 and $500.00.' });
  try {
    await ready;
    const { rateCents, text } = await getRate();
    const sats = toSats(usd, rateCents), ref = crypto.randomBytes(12).toString('base64url'), p = provider();
    const inv = await p.createInvoice(Number(sats), `Safepay ${ref}`, ref);
    if (!inv.id || !inv.bolt11) throw new Error('bad invoice');
    await q(`INSERT INTO orders(ref,usd_cents,sats,rate,rate_at,provider,provider_id,bolt11,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ref, Number(usd), Number(sats), text, now(), p.name, inv.id, inv.bolt11, now() + EXPIRY_SECS, now()]);
    console.log(JSON.stringify({ evt: 'checkout_created', ref, sats: Number(sats) }));
    res.json({ ref });
  } catch (e) {
    console.error(JSON.stringify({ evt: 'checkout_failed', msg: e.message }));
    res.status(502).json({ error: 'Could not create an invoice right now. Please try again.' });
  }
});

app.get('/api/order/:ref', limit('status', 60), async (req, res) => {
  await ready;
  const o = (await q('SELECT * FROM orders WHERE ref=$1', [req.params.ref]))[0];
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  res.json(pub(await refresh(o)));
});

app.get('/api/health', (_, res) => res.json({ ok: true }));
export default app;

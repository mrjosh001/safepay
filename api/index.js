import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { decode } from 'light-bolt11-decoder';
import { provider, providerFor, lnurl } from '../lib/providers.js';

const { DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET, APP_URL = '' } = process.env;
const MIN_CENTS = 100n, MAX_CENTS = 50000n, EXPIRY_SECS = 3600;
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
const ready = (async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS orders(
    ref TEXT PRIMARY KEY, usd_cents INTEGER NOT NULL, sats INTEGER NOT NULL, rate TEXT NOT NULL,
    rate_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', provider TEXT NOT NULL,
    provider_id TEXT UNIQUE NOT NULL, bolt11 TEXT NOT NULL, expires_at INTEGER NOT NULL,
    paid_at INTEGER, late BOOLEAN NOT NULL DEFAULT false, note TEXT, created_at INTEGER NOT NULL)`);
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS verify_url TEXT');
  await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS dest TEXT');
  await pool.query('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS address_log(id SERIAL PRIMARY KEY, address TEXT NOT NULL, changed_at INTEGER NOT NULL)');
})();
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const now = () => Math.floor(Date.now() / 1000);
const getAddress = async () => (await q(`SELECT value FROM settings WHERE key='ln_address'`))[0]?.value || process.env.LN_ADDRESS || '';

// best-effort per-instance limiter (serverless instances don't share memory; add edge limits for real protection)
const hits = new Map();
const limit = (name, max) => (req, res, next) => {
  const k = `${name}:${req.ip}`, t = now(), h = (hits.get(k) || []).filter(x => x > t - 60);
  if (h.length >= max) return res.status(429).json({ error: 'Too many requests, try again shortly.' });
  h.push(t); hits.set(k, h); next();
};
const parseUsd = v => {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(String(v ?? ''));
  return m ? BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0') || '0') : null;
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
  const paid = await providerFor(o.provider).isPaid(o.provider_id, o).catch(() => false); // manual or unverifiable: always false
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

app.post('/api/webhook', express.raw({ type: '*/*', limit: '10kb' }), async (req, res) => {
  if (['manual', 'lnurl'].includes(provider().name)) return res.sendStatus(404);
  try {
    const id = provider().webhookPaymentId(req.body, req.headers);
    await ready;
    const o = id && (await q('SELECT * FROM orders WHERE provider_id=$1', [id]))[0];
    if (o) await refresh(o);
    res.sendStatus(200);
  } catch (e) { res.sendStatus(e.message === 'bad signature' ? 401 : 500); }
});

app.use(express.json({ limit: '4kb' }));

app.post('/api/checkout', limit('checkout', 10), async (req, res) => {
  if (provider().name === 'manual') return res.status(404).json({ error: 'Payments are by link only. Please use the payment link you were sent.' });
  const usd = parseUsd(req.body?.usd);
  if (usd === null) return res.status(400).json({ error: 'Enter a valid USD amount, like 25 or 25.50.' });
  if (usd < MIN_CENTS || usd > MAX_CENTS) return res.status(400).json({ error: 'Amount must be between $1.00 and $500.00.' });
  try {
    await ready;
    const p = provider().name === 'lnurl' ? lnurl(await getAddress()) : provider(); // uses the address the admin set most recently
    const { rateCents, text } = await getRate();
    const sats = toSats(usd, rateCents), ref = crypto.randomBytes(12).toString('base64url');
    const inv = await p.createInvoice(Number(sats), `Safepay ${ref}`, ref);
    if (!inv.id || !inv.bolt11) throw new Error('bad invoice');
    await q(`INSERT INTO orders(ref,usd_cents,sats,rate,rate_at,provider,provider_id,bolt11,expires_at,verify_url,dest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ref, Number(usd), Number(sats), text, now(), p.name, inv.id, inv.bolt11, inv.expires || now() + EXPIRY_SECS, inv.verify || null, p.addr || null, now()]);
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

// ---------- Admin ----------
const sign = v => crypto.createHmac('sha256', SESSION_SECRET || '').update(v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const isAdmin = req => {
  const c = /(?:^|;\s*)sp_admin=([^;]+)/.exec(req.headers.cookie || '')?.[1]; if (!c || !SESSION_SECRET) return false;
  const [exp, sig] = c.split('.');
  return Number(exp) > now() && safeEq(sig || '', sign(exp));
};
const auth = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Please sign in.' }));

app.post('/api/admin/login', limit('login', 5), (req, res) => {
  if (!ADMIN_PASSWORD || !SESSION_SECRET || !safeEq(sha(req.body?.password), sha(ADMIN_PASSWORD))) return res.status(401).json({ error: 'Wrong password.' });
  const exp = String(now() + 8 * 3600);
  res.set('Set-Cookie', `sp_admin=${exp}.${sign(exp)}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=28800`);
  res.json({ ok: true });
});

// The receiving Lightning address that new checkouts pay to. Updating it affects every payment created after this moment.
app.get('/api/admin/address', auth, async (_, res) => {
  await ready;
  res.json({ address: await getAddress(), history: await q('SELECT address, changed_at FROM address_log ORDER BY id DESC LIMIT 10') });
});
app.post('/api/admin/address', auth, async (req, res) => {
  const addr = String(req.body?.address || '').trim().toLowerCase();
  try { await lnurl(addr).params(); }
  catch { return res.status(400).json({ error: 'That is not a working Lightning address. Check the spelling and that the wallet supports receiving.' }); }
  await ready;
  await q(`INSERT INTO settings(key,value,updated_at) VALUES('ln_address',$1,$2) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=$2`, [addr, now()]);
  await q('INSERT INTO address_log(address, changed_at) VALUES($1,$2)', [addr, now()]);
  console.log(JSON.stringify({ evt: 'address_changed' }));
  res.json({ ok: true, address: addr });
});

app.post('/api/admin/links', auth, async (req, res) => {
  try {
    const inv = String(req.body?.bolt11 || '').trim().replace(/^lightning:/i, '');
    if (!/^lnbc[0-9a-z]{50,2000}$/i.test(inv)) return res.status(400).json({ error: 'Paste a mainnet Lightning invoice (starts with lnbc).' });
    const sec = n => decode(inv).sections.find(s => s.name === n)?.value;
    const msat = sec('amount'), hash = sec('payment_hash');
    if (!msat || !hash) return res.status(400).json({ error: 'The invoice must have a fixed amount. Create it with the exact sats.' });
    if (BigInt(msat) % 1000n !== 0n) return res.status(400).json({ error: 'Invoice amount must be whole sats.' });
    const sats = Number(BigInt(msat) / 1000n), expires = Number(sec('timestamp')) + Number(sec('expiry') || 3600);
    if (expires <= now() + 60) return res.status(400).json({ error: 'That invoice has expired or is about to. Create a fresh one.' });
    const usd = parseUsd(req.body?.usd);
    if (usd === null || usd < MIN_CENTS || usd > MAX_CENTS) return res.status(400).json({ error: 'Enter the USD price you quoted ($1 to $500).' });
    const implied = (usd * 100000000n * 100n / BigInt(sats) / 100n); // USD cents per BTC, implied by this invoice
    const rate = `${implied / 100n}.${String(implied % 100n).padStart(2, '0')}`;
    const ref = crypto.randomBytes(12).toString('base64url'), note = String(req.body?.note || '').slice(0, 120);
    await ready;
    await q(`INSERT INTO orders(ref,usd_cents,sats,rate,rate_at,provider,provider_id,bolt11,expires_at,note,created_at) VALUES($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9,$10)`,
      [ref, Number(usd), sats, rate, now(), hash, inv, expires, note, now()]);
    console.log(JSON.stringify({ evt: 'link_created', ref, sats }));
    res.json({ ref, link: `${APP_URL.replace(/\/$/, '')}/#${ref}`, sats, expiresAt: expires });
  } catch (e) {
    res.status(e.code === '23505' ? 409 : 400).json({ error: e.code === '23505' ? 'That invoice already has a link.' : 'Could not read that invoice.' });
  }
});

app.get('/api/admin/links', auth, async (_, res) => {
  await ready;
  res.json(await q(`SELECT ref,usd_cents,sats,status,expires_at,paid_at,late,note,provider,dest,created_at FROM orders ORDER BY created_at DESC LIMIT 100`));
});

// Seller confirms they saw the money arrive in their wallet. Logged for audit.
app.post('/api/admin/links/:ref/paid', auth, async (req, res) => {
  await ready;
  const r = await q(`UPDATE orders SET status='paid', paid_at=$1, late=(expires_at < $1) WHERE ref=$2 AND status IN ('pending','expired') RETURNING ref`, [now(), req.params.ref]);
  if (r.length) console.log(JSON.stringify({ evt: 'manually_confirmed_paid', ref: req.params.ref }));
  res.json({ ok: r.length === 1 });
});

app.get('/api/health', (_, res) => res.json({ ok: true }));
export default app;

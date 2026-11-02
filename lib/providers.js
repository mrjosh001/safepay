import crypto from 'node:crypto';
import { decode } from 'light-bolt11-decoder';

// Provider interface: createInvoice(sats, memo, externalId) -> {id, bolt11, expires?, verify?};
// isPaid(id, order) -> bool; webhookPaymentId(rawBody, headers) -> id or null (throws if signature is invalid).

// Manual: invoices are made by hand in a wallet app and pasted into /admin.html.
const manual = { name: 'manual', createInvoice() { throw new Error('manual'); }, isPaid: async () => false, webhookPaymentId() { throw new Error('manual'); } };

// LNURL-pay: asks a Lightning address (name@domain) for a fresh fixed-amount invoice. No API key needed.
// Payment is only auto-verified if that wallet returns a LUD-21 "verify" URL; otherwise the seller confirms in /admin.html.
function lnurl() {
  const addr = process.env.LN_ADDRESS || '';
  const m = /^([a-z0-9._+-]{1,64})@([a-z0-9.-]{3,253})$/i.exec(addr);
  const httpsPublic = u => { const x = new URL(u); if (x.protocol !== 'https:' || /^(localhost|\d+\.\d+\.\d+\.\d+|\[)/i.test(x.hostname)) throw new Error('unsafe url'); return x; };
  const get = async u => { const r = await fetch(u, { signal: AbortSignal.timeout(10000), redirect: 'error' }); if (!r.ok) throw new Error('lnurl ' + r.status); return r.json(); };
  return {
    name: 'lnurl',
    async createInvoice(sats) {
      if (!m) throw new Error('LN_ADDRESS not set');
      const msat = BigInt(sats) * 1000n;
      const p = await get(`https://${m[2]}/.well-known/lnurlp/${encodeURIComponent(m[1])}`);
      if (p.tag !== 'payRequest' || msat < BigInt(p.minSendable) || msat > BigInt(p.maxSendable)) throw new Error('amount outside wallet limits');
      const cb = httpsPublic(p.callback); cb.searchParams.set('amount', msat.toString());
      const j = await get(cb.toString());
      const pr = String(j.pr || '');
      if (!/^lnbc[0-9a-z]{50,2000}$/i.test(pr)) throw new Error('bad invoice');
      const secs = decode(pr).sections, sec = n => secs.find(s => s.name === n)?.value;
      if (BigInt(sec('amount')) !== msat) throw new Error('invoice amount mismatch'); // never trust a wallet to return the right amount
      const expires = Number(sec('timestamp')) + Number(sec('expiry') || 3600);
      return { id: sec('payment_hash'), bolt11: pr, expires, verify: j.verify ? httpsPublic(j.verify).toString() : null };
    },
    async isPaid(_id, o) {
      if (!o?.verify_url) return false;
      const j = await get(httpsPublic(o.verify_url).toString());
      return j.settled === true;
    },
    webhookPaymentId() { throw new Error('no webhooks'); },
  };
}

function phoenixd() {
  const { PHOENIXD_URL, PHOENIXD_PASSWORD, PHOENIXD_WEBHOOK_SECRET } = process.env;
  const base = (PHOENIXD_URL || '').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(':' + (PHOENIXD_PASSWORD || '')).toString('base64');
  const call = (path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: auth, ...(opts.headers || {}) }, signal: AbortSignal.timeout(10000) });
  return {
    name: 'phoenixd',
    async createInvoice(sats, memo, externalId) {
      const r = await call('/createinvoice', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ amountSat: String(sats), description: memo, externalId }) });
      if (!r.ok) throw new Error('phoenixd ' + r.status);
      const j = await r.json();
      return { id: j.paymentHash, bolt11: j.serialized };
    },
    async isPaid(id) {
      const r = await call('/payments/incoming/' + encodeURIComponent(id));
      if (r.status === 404) return false;
      if (!r.ok) throw new Error('phoenixd ' + r.status);
      return (await r.json()).isPaid === true;
    },
    webhookPaymentId(raw, headers) {
      const sig = String(headers['x-phoenix-signature'] || '');
      const exp = crypto.createHmac('sha256', PHOENIXD_WEBHOOK_SECRET || '').update(raw).digest('hex');
      if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) throw new Error('bad signature');
      return JSON.parse(raw.toString()).paymentHash || null;
    },
  };
}

// Speed: NOT implemented yet (REST paths/auth must be confirmed in Speed's API docs first).
function speed() {
  const todo = () => { throw new Error('Speed adapter not implemented yet'); };
  return { name: 'speed', createInvoice: todo, isPaid: todo, webhookPaymentId: todo };
}

export const providerFor = name => (name === 'manual' ? manual : name === 'lnurl' ? lnurl() : name === 'speed' ? speed() : phoenixd());
export const provider = () => providerFor(process.env.PROVIDER || 'manual');

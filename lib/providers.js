import crypto from 'node:crypto';

// Provider interface: createInvoice(sats, memo, externalId) -> {id, bolt11}; isPaid(id) -> bool;
// webhookPaymentId(rawBody, headers) -> id or null (throws if the signature is invalid).

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

// Speed: NOT implemented yet. Its docs describe a merchant API with HMAC-signed webhooks,
// but the exact REST paths/auth must be confirmed in Speed's API docs before coding this.
function speed() {
  const todo = () => { throw new Error('Speed adapter not implemented yet'); };
  return { name: 'speed', createInvoice: todo, isPaid: todo, webhookPaymentId: todo };
}

export const provider = () => (process.env.PROVIDER === 'speed' ? speed() : phoenixd());

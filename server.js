require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const CSL = require('@emurgo/cardano-serialization-lib-nodejs');

const { bfClient } = require('./blockfrost');
const { createTxRecord, getTxRecord, addWitness, status, clearTx } = require('./txStore');
const { buildUnsignedTx, assembleAndSerializeTx } = require('./multisig');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));
app.use('/', express.static('./public'));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

const NETWORK = process.env.NETWORK || 'mainnet';
const PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
if (!PROJECT_ID) { console.error('Missing BLOCKFROST_PROJECT_ID'); process.exit(1); }
const bf = bfClient(PROJECT_ID, NETWORK);

// Hardcoded allowed signer key hashes (lowercase hex; DO NOT RELY ON env)
const ALLOWED_PAYMENT_KEY_HASHES = [
  'f95cb3bc90e3fdb3db4a98ed64a77762daa891c7af7138d45e38adb7',
  '22c601535ab5159654c1d0d56fae298e56b84af96325a4b2772ab014',
  '20ce5b4341421c7c3f9aa03ea0413c10d2b975a8bd4fde6b43a0444a'
].map(h => h.toLowerCase());

function derivePaymentKeyHashHexFromAddr(addrBech32) {
  try {
    const addr = CSL.Address.from_bech32(addrBech32);
    const base = CSL.BaseAddress.from_address(addr);
    if (base) {
      const kh = base.payment_cred().to_keyhash();
      if (kh) return Buffer.from(kh.to_bytes()).toString('hex');
    }
    const ent = CSL.EnterpriseAddress.from_address(addr);
    if (ent) {
      const kh = ent.payment_cred().to_keyhash();
      if (kh) return Buffer.from(kh.to_bytes()).toString('hex');
    }
  } catch (_) {}
  return null;
}

// Note: signer key hashes are specified directly above

const FORCED_M_REQUIRED = 3;

// Defaults from env (override per request if needed)
const DEF_MSIG_ADDR = process.env.MULTISIG_ADDRESS || '';
const DEF_PAY_SCRIPT = process.env.PAYMENT_SCRIPT_CBOR || '';
const DEF_M = parseInt(process.env.M_REQUIRED || '3', 10);
const DEF_DEST = process.env.DEST_ADDRESS || '';
const ENV_KEYHASHES = (process.env.REQUIRED_KEY_HASHES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Simple in-memory event stream for broadcasting tx lifecycle
const sseClients = new Set();
let latestSession = null; // { txId, preview }

function sseBroadcast(event, payload) {
  const data = `event: ${event}\n` + `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (e) { /* ignore */ }
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  sseClients.add(res);
  // send current session if exists
  if (latestSession) {
    res.write(`event: tx_created\n` + `data: ${JSON.stringify(latestSession)}\n\n`);
  }
  req.on('close', () => { sseClients.delete(res); });
});

// Balance for a specific asset unit at the configured multisig address
app.get('/api/balance/:unit', async (req, res) => {
  try {
    const unit = String(req.params.unit || '').toLowerCase();
    if (!unit || unit.length < 56) return res.status(400).json({ error: 'invalid_unit' });
    if (!DEF_MSIG_ADDR) return res.status(400).json({ error: 'multisig_not_configured' });

    const utxos = await bf.utxosByAddress(DEF_MSIG_ADDR);
    let sum = 0n;
    for (const u of utxos) {
      for (const a of u.amount) {
        if (a.unit === unit) sum += BigInt(a.quantity);
      }
    }
    return res.json({ address: DEF_MSIG_ADDR, unit, quantity: sum.toString() });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
  }
});

// Create session + unsigned tx
app.post('/api/create', async (req, res) => {
  try {
    const {
      multisigAddress = DEF_MSIG_ADDR,
      paymentScriptHex = DEF_PAY_SCRIPT,
      mode = 'sendAll',       // default sweep
      destAddress = DEF_DEST, // from ENV
      outputs                 // for explicit mode
    } = req.body || {};

    if (!multisigAddress || !paymentScriptHex)
      return res.status(400).json({ error: 'missing_params' });

    // Force 3-of-3 from the hardcoded allowlist
    const normalizedRequired = ALLOWED_PAYMENT_KEY_HASHES;
    const mReq = FORCED_M_REQUIRED;

    const build = await buildUnsignedTx({
      bf, network: NETWORK,
      multisigAddress, paymentScriptHex,
      requiredKeyHashes: normalizedRequired, mRequired: mReq,
      mode, destAddress, outputs
    });

    createTxRecord(build.txId, {
      txHex: build.txHex,
      txBodyHex: build.txBodyHex,
      scriptHex: paymentScriptHex,
      m: mReq,
      signersKeyHashes: normalizedRequired,
      preview: build.preview
    });

    latestSession = { txId: build.txId, preview: build.preview };
    sseBroadcast('tx_created', latestSession);

    return res.json({
      txId: build.txId,
      preview: build.preview,
      mRequired: mReq,
      requiredKeyHashes: normalizedRequired
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
  }
});

// Status
app.get('/api/status/:txId', (req, res) => {
  const s = status(req.params.txId);
  if (!s) return res.status(404).json({ error: 'not_found' });
  return res.json(s);
});

// List collected witnesses (includes raw witness CBOR hex per signer)
app.get('/api/witnesses/:txId', (req, res) => {
  const rec = getTxRecord(req.params.txId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  const items = Array.from(rec.witnesses.entries()).map(([signer, witnessHex]) => ({ signer, witnessHex }));
  return res.json({ witnesses: items, m: rec.m, required: rec.signersKeyHashes });
});

// Tx body for signing
app.get('/api/txbody/:txId', (req, res) => {
  const rec = getTxRecord(req.params.txId);
  if (!rec) return res.status(404).json({ error: 'not_found' });
  return res.json({ txHex: rec.txHex, txBodyHex: rec.txBodyHex });
});

// Upload witness; do NOT auto-submit — submission happens via POST /api/submit
app.post('/api/witness', async (req, res) => {
  try {
    const { txId, signerKeyHashHex, witnessHex } = req.body || {};
    if (!txId || !witnessHex) return res.status(400).json({ error: 'missing_params' });

    const rec = getTxRecord(txId);
    if (!rec) return res.status(404).json({ error: 'not_found' });

    // If signer hash not provided, derive from witness.
    // Accept either a TransactionWitnessSet CBOR or a full signed Transaction CBOR.
    let signer = signerKeyHashHex;
    try {
      let vkeys = null;
      try {
        const ws = CSL.TransactionWitnessSet.from_bytes(Buffer.from(witnessHex, 'hex'));
        vkeys = ws.vkeys();
      } catch (_) {
        const tx = CSL.Transaction.from_bytes(Buffer.from(witnessHex, 'hex'));
        const ws2 = tx.witness_set();
        vkeys = ws2?.vkeys();
      }
      if (!signer) {
        if (!vkeys || vkeys.len() === 0) return res.status(400).json({ error: 'empty_vkeys' });
        const vk = vkeys.get(0).vkey().public_key();
        signer = Buffer.from(vk.hash().to_bytes()).toString('hex');
      }
    } catch (e) {
      return res.status(400).json({ error: 'invalid_witness_cbor' });
    }

    // Allowlist
    const normalizedSigner = String(signer).toLowerCase();
    if (!rec.signersKeyHashes.includes(normalizedSigner))
      return res.status(400).json({ error: 'signer_not_in_required_set' });

    const r = addWitness(txId, normalizedSigner, witnessHex);
    if (!r.ok) return res.status(500).json({ error: r.error });
    try { sseBroadcast('witness', { txId, collected: r.count, required: r.m }); } catch {}
    return res.json({ ok: true, submitted: false, collected: r.count, required: r.m });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
  }
});

// Reset current session and optionally clear a transaction record
app.post('/api/reset', (req, res) => {
  try {
    const { txId } = req.body || {};
    if (txId) {
      try { clearTx(txId); } catch (_) {}
    }
    latestSession = null;
    try { sseBroadcast('reset', { txId: txId || null }); } catch {}
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
  }
});

// Manually submit once enough witnesses are collected
app.post('/api/submit', async (req, res) => {
  try {
    const { txId } = req.body || {};
    if (!txId) return res.status(400).json({ error: 'missing_params' });
    const rec = getTxRecord(txId);
    if (!rec) return res.status(404).json({ error: 'not_found' });

    const collected = rec.witnesses.size;
    if (collected < rec.m) {
      return res.status(400).json({ error: 'not_enough_witnesses', collected, required: rec.m });
    }

    try {
      const witnessHexes = Array.from(rec.witnesses.values());
      const txBytes = assembleAndSerializeTx({
        txBodyHex: rec.txBodyHex,
        scriptHex: rec.scriptHex,
        witnessHexes
      });
      const txHash = await bf.submitTx(txBytes);
      clearTx(txId);
      try { sseBroadcast('submitted', { txId, txHash }); } catch {}
      return res.json({ ok: true, submitted: true, txHash });
    } catch (e) {
      console.error('submit_failed', e?.response?.data || e);
      return res.status(500).json({ error: 'submit_failed', detail: e?.response?.data || String(e) });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server on :${port}`));



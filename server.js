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

const PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
if (!PROJECT_ID) { console.error('Missing BLOCKFROST_PROJECT_ID'); process.exit(1); }
// Hardcoded network for this deployment (as requested)
const NETWORK = 'mainnet';
const bf = bfClient(PROJECT_ID, NETWORK);

/* ----------------------- Hardcoded multisig configuration ----------------------- */
// The payment native script (CBOR hex) you provided (2-of-2)
const PAYMENT_SCRIPT_CBOR_HEX =
  '820181830302828200581c2628bd7a9a004b20c91f2b7b241183813c62e049917810e364e275318200581c9cc6f61972a60b643acbc266db2514e450ac96e3592e2588a2d6b4a8';
// Optional stake native script for deriving the base script address (not required for spending)
const STAKE_SCRIPT_CBOR_HEX = PAYMENT_SCRIPT_CBOR_HEX;

// The two wallets that must participate (stable identity = stake key hash)
const ALLOWED_SIGNERS = [
  {
    label: 'Signer 1',
    address:
      'addr1qynz30t6ngqykgxfru4hkfq3swqncchqfxghsy8rvn382v0spvdrn65j9j978wn52pm5erayt3v90ymmte0pcc8ym95qlv6jgh',
    stakeKeyHash: 'f00b1a39ea922c8be3ba7450774c8fa45c5857937b5e5e1c60e4d968'
  },
  {
    label: 'Signer 2',
    address:
      'addr1qxwvdasew2nqkep6e0pxdke9znj9ptykudvjufvg5tttf2zr84s2m7kffnhm6r8chausn9tuzssnj4wxjxup0pxqe7ksccr5p0',
    stakeKeyHash: '433d60adfac94cefbd0cf8bf7909957c14213955c691b81784c0cfad'
  }
].map((s) => ({ ...s, stakeKeyHash: s.stakeKeyHash.toLowerCase() }));

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

function hexToBytes(h) {
  return Buffer.from(h, 'hex');
}
function bytesToHex(b) {
  return Buffer.from(b).toString('hex');
}

const K = {
  SCRIPT_PUBKEY: 0,
  SCRIPT_ALL: 1,
  SCRIPT_ANY: 2,
  SCRIPT_N_OF_K: 3,
  SCRIPT_INVALID_BEFORE: 4,
  SCRIPT_INVALID_HEREAFTER: 5
};

function getChildScripts(container) {
  if (typeof container.scripts === 'function') return container.scripts();
  if (typeof container.native_scripts === 'function') return container.native_scripts();
  return null;
}

function collectScriptInfo(nativeScript, acc, path = []) {
  const kind = nativeScript.kind();
  switch (kind) {
    case K.SCRIPT_PUBKEY: {
      const kh = nativeScript.as_script_pubkey().addr_keyhash();
      const hex = bytesToHex(kh.to_bytes());
      acc.keys.add(hex.toLowerCase());
      acc.tree.push({ type: 'pubkey', keyHash: hex.toLowerCase(), path: [...path] });
      break;
    }
    case K.SCRIPT_ALL: {
      const scripts = getChildScripts(nativeScript.as_script_all());
      acc.tree.push({ type: 'all', path: [...path] });
      if (scripts) {
        for (let i = 0; i < scripts.len(); i++) {
          collectScriptInfo(scripts.get(i), acc, [...path, `all[${i}]`]);
        }
      }
      break;
    }
    case K.SCRIPT_ANY: {
      const scripts = getChildScripts(nativeScript.as_script_any());
      acc.tree.push({ type: 'any', path: [...path] });
      if (scripts) {
        for (let i = 0; i < scripts.len(); i++) {
          collectScriptInfo(scripts.get(i), acc, [...path, `any[${i}]`]);
        }
      }
      break;
    }
    case K.SCRIPT_N_OF_K: {
      const sok = nativeScript.as_script_n_of_k();
      const n = sok.n();
      acc.thresholds.push(n);
      const scripts = getChildScripts(sok);
      acc.tree.push({ type: 'atLeast', n, k: scripts ? scripts.len() : 0, path: [...path] });
      if (scripts) {
        for (let i = 0; i < scripts.len(); i++) {
          collectScriptInfo(scripts.get(i), acc, [...path, `atLeast(n=${n})[${i}]`]);
        }
      }
      break;
    }
    case K.SCRIPT_INVALID_BEFORE: {
      const slot = nativeScript.as_timelock_start().slot();
      acc.invalidBefore = Math.max(acc.invalidBefore ?? 0, Number(slot.to_str()));
      acc.tree.push({ type: 'invalid_before', slot: Number(slot.to_str()), path: [...path] });
      break;
    }
    case K.SCRIPT_INVALID_HEREAFTER: {
      const slot = nativeScript.as_timelock_expiry().slot();
      acc.invalidHereafter = Math.min(
        acc.invalidHereafter ?? Number.MAX_SAFE_INTEGER,
        Number(slot.to_str())
      );
      acc.tree.push({ type: 'invalid_hereafter', slot: Number(slot.to_str()), path: [...path] });
      break;
    }
    default:
      acc.tree.push({ type: 'unknown', kind, path: [...path] });
  }
}

function deriveSummary(scriptHex) {
  const ns = CSL.NativeScript.from_bytes(hexToBytes(scriptHex));
  const info = {
    keys: new Set(),
    thresholds: [],
    invalidBefore: null,
    invalidHereafter: null,
    tree: []
  };
  collectScriptInfo(ns, info);

  const requiredKeyHashes = Array.from(info.keys);
  // If there is any explicit N-of-K, take the maximum N encountered as the effective threshold.
  let mRequired;
  if (info.thresholds.length > 0) {
    mRequired = Math.max(...info.thresholds);
  } else {
    const hasAny = info.tree.some((n) => n.type === 'any');
    mRequired = hasAny ? 1 : requiredKeyHashes.length;
  }

  const scriptHashHex = bytesToHex(ns.hash(CSL.ScriptHashNamespace.NativeScript).to_bytes());
  const hasTimeConstraints = info.invalidBefore !== null || info.invalidHereafter !== null;

  return {
    mRequired,
    totalKeys: requiredKeyHashes.length,
    requiredKeyHashes,
    hasTimeConstraints,
    invalidBefore: info.invalidBefore,
    invalidHereafter: info.invalidHereafter === Number.MAX_SAFE_INTEGER ? null : info.invalidHereafter,
    scriptHash: scriptHashHex,
    structure: info.tree
  };
}

function bech32AddressesFrom(paymentScriptHex, stakeScriptHex, network) {
  const netId = network === 'mainnet' ? 1 : 0;
  const payNS = CSL.NativeScript.from_bytes(hexToBytes(paymentScriptHex));
  const payCred = CSL.StakeCredential.from_scripthash(
    payNS.hash(CSL.ScriptHashNamespace.NativeScript)
  );
  if (stakeScriptHex) {
    const stakeNS = CSL.NativeScript.from_bytes(hexToBytes(stakeScriptHex));
    const stakeCred = CSL.StakeCredential.from_scripthash(
      stakeNS.hash(CSL.ScriptHashNamespace.NativeScript)
    );
    const base = CSL.BaseAddress.new(netId, payCred, stakeCred).to_address().to_bech32();
    return {
      baseAddress: base,
      enterpriseAddress: CSL.EnterpriseAddress.new(netId, payCred).to_address().to_bech32()
    };
  }
  return {
    baseAddress: null,
    enterpriseAddress: CSL.EnterpriseAddress.new(netId, payCred).to_address().to_bech32()
  };
}

// Derived, canonical script requirements
const PAYMENT_SUMMARY = deriveSummary(PAYMENT_SCRIPT_CBOR_HEX);
const REQUIRED_KEY_HASHES = PAYMENT_SUMMARY.requiredKeyHashes.map((h) => h.toLowerCase());
const M_REQUIRED = PAYMENT_SUMMARY.mRequired;
if (M_REQUIRED !== 2 || REQUIRED_KEY_HASHES.length !== 2) {
  console.error(
    `Expected a 2-of-2 script. Got m=${M_REQUIRED} with keys=${REQUIRED_KEY_HASHES.length}. Refusing to start.`
  );
  process.exit(1);
}

const DERIVED_ADDRS = bech32AddressesFrom(PAYMENT_SCRIPT_CBOR_HEX, STAKE_SCRIPT_CBOR_HEX, NETWORK);
const MULTISIG_ADDRESS = DERIVED_ADDRS.baseAddress || DERIVED_ADDRS.enterpriseAddress;
const MULTISIG_ENTERPRISE_ADDRESS = DERIVED_ADDRS.enterpriseAddress;

// Best-effort: map provided signer addresses -> payment key hashes (for debugging / UI only)
const SIGNER_PAYMENT_KEY_HASHES_FROM_ADDRS = ALLOWED_SIGNERS.map((s) => ({
  label: s.label,
  address: s.address,
  stakeKeyHash: s.stakeKeyHash,
  paymentKeyHash: derivePaymentKeyHashHexFromAddr(s.address)
}));

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

    const utxos = await bf.utxosByAddress(MULTISIG_ADDRESS);
    let sum = 0n;
    for (const u of utxos) {
      for (const a of u.amount) {
        if (a.unit === unit) sum += BigInt(a.quantity);
      }
    }
    return res.json({ address: MULTISIG_ADDRESS, unit, quantity: sum.toString() });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error', detail: String(e?.message || e) });
  }
});

// Expose the fixed multisig configuration to the frontend (no secrets here)
app.get('/api/config', (_req, res) => {
  return res.json({
    network: NETWORK,
    multisig: {
      address: MULTISIG_ADDRESS,
      enterpriseAddress: MULTISIG_ENTERPRISE_ADDRESS,
      scriptHash: PAYMENT_SUMMARY.scriptHash,
      mRequired: M_REQUIRED,
      requiredKeyHashes: REQUIRED_KEY_HASHES
    },
    allowedSigners: ALLOWED_SIGNERS,
    signerPaymentKeyHashesFromProvidedAddresses: SIGNER_PAYMENT_KEY_HASHES_FROM_ADDRS
  });
});

// Create session + unsigned tx
app.post('/api/create', async (req, res) => {
  try {
    const {
      mode = 'sendAll',       // default sweep
      destAddress = null,     // client can supply for sendAll
      outputs                 // for explicit mode
    } = req.body || {};

    const multisigAddress = MULTISIG_ADDRESS;
    const paymentScriptHex = PAYMENT_SCRIPT_CBOR_HEX;
    const normalizedRequired = REQUIRED_KEY_HASHES;
    const mReq = M_REQUIRED;

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
      requiredKeyHashes: normalizedRequired,
      multisigAddress
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

    // Accept either a TransactionWitnessSet CBOR or a full signed Transaction CBOR.
    // Extract *all* vkey witnesses and store only those that match the required key hashes.
    const requiredSet = new Set(rec.signersKeyHashes.map((h) => String(h).toLowerCase()));
    let vkeys = null;
    try {
      try {
        const ws = CSL.TransactionWitnessSet.from_bytes(Buffer.from(witnessHex, 'hex'));
        vkeys = ws.vkeys();
      } catch (_) {
        const tx = CSL.Transaction.from_bytes(Buffer.from(witnessHex, 'hex'));
        const ws2 = tx.witness_set();
        vkeys = ws2?.vkeys();
      }
    } catch (e) {
      return res.status(400).json({ error: 'invalid_witness_cbor' });
    }

    if (!vkeys || vkeys.len() === 0) return res.status(400).json({ error: 'empty_vkeys' });

    const accepted = [];
    const ignored = [];
    for (let i = 0; i < vkeys.len(); i++) {
      const vw = vkeys.get(i);
      const vk = vw.vkey().public_key();
      const khHex = Buffer.from(vk.hash().to_bytes()).toString('hex').toLowerCase();
      if (!requiredSet.has(khHex)) {
        ignored.push(khHex);
        continue;
      }
      // Store this witness as a minimal witness set (only this vkeywitness)
      const wsSingle = CSL.TransactionWitnessSet.new();
      const vws = CSL.Vkeywitnesses.new();
      vws.add(vw);
      wsSingle.set_vkeys(vws);
      const singleHex = Buffer.from(wsSingle.to_bytes()).toString('hex');
      const r = addWitness(txId, khHex, singleHex);
      if (!r.ok) return res.status(500).json({ error: r.error });
      accepted.push(khHex);
    }

    if (accepted.length === 0) {
      return res.status(403).json({
        error: 'signer_not_allowed',
        foundKeyHashes: ignored,
        required: Array.from(requiredSet)
      });
    }

    const r2 = status(txId);
    try {
      sseBroadcast('witness', { txId, collected: r2.collected.length, required: r2.m, accepted });
    } catch {}
    return res.json({
      ok: true,
      submitted: false,
      accepted,
      ignored,
      collected: r2.collected.length,
      required: r2.m
    });
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



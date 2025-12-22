// multisig.js
const CSL = require('@emurgo/cardano-serialization-lib-nodejs');

const MIN_ADA = String(process.env.MIN_ADA_LOVELACE || 2_000_000); // ADA floor for any token-carrying output
const FIXED_FEE = String(process.env.FIXED_FEE_LOVELACE || 1_000_000); // ==> 1 ADA as you requested

const hexToBytes = (h) => Buffer.from(h, 'hex');
const bytesToHex = (b) => Buffer.from(b).toString('hex');

/* --------------------- helpers: multi-asset math (JS side) --------------------- */

function bigAdd(a, b) { return (BigInt(a) + BigInt(b)).toString(); }
function bigSub(a, b) { return (BigInt(a) - BigInt(b)).toString(); }
function bigGtEq(a, b) { return BigInt(a) >= BigInt(b); }

function addAssetsToValue(value, assets) {
  if (!assets?.length) return value;
  const ma = value.multiasset() ?? CSL.MultiAsset.new();
  for (const a of assets) {
    const unit = a.unit.toLowerCase();            // policy(56 hex) + assetNameHex
    const policy = unit.slice(0, 56);
    const nameHex = unit.slice(56);

    const pid = CSL.ScriptHash.from_bytes(Buffer.from(policy, 'hex'));
    const aname = CSL.AssetName.new(Buffer.from(nameHex, 'hex'));
    const qty = CSL.BigNum.from_str(a.quantity);

    let inner = ma.get(pid);
    if (!inner) inner = CSL.Assets.new();
    const prev = inner.get(aname);
    inner.insert(aname, prev ? prev.checked_add(qty) : qty);
    ma.insert(pid, inner);
  }
  value.set_multiasset(ma);
  return value;
}

function valueToJs(value) {
  const out = { coin: value.coin().to_str(), assets: new Map() }; // Map<policy, Map<name, qty>>
  const ma = value.multiasset();
  if (!ma) return out;
  const policies = ma.keys();
  for (let p = 0; p < policies.len(); p++) {
    const pid = policies.get(p);
    const pidHex = Buffer.from(pid.to_bytes()).toString('hex');
    const assets = ma.get(pid);
    const names = assets.keys();
    let m = out.assets.get(pidHex);
    if (!m) { m = new Map(); out.assets.set(pidHex, m); }
    for (let n = 0; n < names.len(); n++) {
      const nm = names.get(n);
      const nmHex = Buffer.from(nm.name()).toString('hex');
      const qty = assets.get(nm).to_str();
      m.set(nmHex, (m.get(nmHex) ? bigAdd(m.get(nmHex), qty) : qty));
    }
  }
  return out;
}

function jsAssetsAdd(dst, add) { // Map<policy, Map<name, qty>>
  for (const [pid, inner] of add.entries()) {
    let d = dst.get(pid);
    if (!d) { d = new Map(); dst.set(pid, d); }
    for (const [nm, q] of inner.entries()) {
      d.set(nm, d.get(nm) ? bigAdd(d.get(nm), q) : q);
    }
  }
}

function jsAssetsFromOutputSpec(specAssets) {
  const m = new Map();
  for (const a of (specAssets || [])) {
    const unit = a.unit.toLowerCase();
    const pid = unit.slice(0,56);
    const nm  = unit.slice(56);
    let d = m.get(pid); if (!d) { d = new Map(); m.set(pid, d); }
    d.set(nm, (d.get(nm) ? bigAdd(d.get(nm), a.quantity) : a.quantity));
  }
  return m;
}

function jsAssetsSub(a, b) { // returns a - b, throws if negative
  const out = new Map();
  for (const [pid, innerA] of a.entries()) {
    const innerB = b.get(pid) || new Map();
    let resInner = null;
    for (const [nm, qa] of innerA.entries()) {
      const qb = innerB.get(nm) || '0';
      const diff = (BigInt(qa) - BigInt(qb));
      if (diff < 0n) throw new Error('insufficient tokens for requested outputs');
      if (diff > 0n) {
        if (!resInner) resInner = new Map();
        resInner.set(nm, diff.toString());
      }
    }
    if (resInner) out.set(pid, resInner);
  }
  return out;
}

function jsAssetsIsEmpty(m) {
  for (const [_pid, inner] of m.entries()) {
    if (inner.size) return false;
  }
  return true;
}

function jsAssetsToValue(value, assetsMap) {
  const ma = CSL.MultiAsset.new();
  for (const [pidHex, inner] of assetsMap.entries()) {
    const pid = CSL.ScriptHash.from_bytes(Buffer.from(pidHex, 'hex'));
    const assets = CSL.Assets.new();
    for (const [nmHex, qtyStr] of inner.entries()) {
      const nm = CSL.AssetName.new(Buffer.from(nmHex, 'hex'));
      assets.insert(nm, CSL.BigNum.from_str(qtyStr));
    }
    ma.insert(pid, assets);
  }
  value.set_multiasset(ma);
  return value;
}

function bumpAdaIfTokens(value) {
  if (!value.multiasset()) return value;
  const floor = CSL.BigNum.from_str(MIN_ADA);
  if (value.coin().compare(floor) < 0) value.set_coin(floor);
  return value;
}

/* --------------------- builder --------------------- */

async function buildUnsignedTx({
  bf, network, multisigAddress, paymentScriptHex,
  requiredKeyHashes, mRequired,           // mRequired unused (native script enforces it)
  mode,               // "sendAll" | "explicit"
  destAddress,        // used in sendAll (change also to dest)
  outputs             // explicit: [{address, lovelace, assets:[{unit,quantity}]}]
}) {
  const protocol = await bf.protocolParams();
  const msAddr = CSL.Address.from_bech32(multisigAddress);

  // 1) Collect inputs & compute TOTAL (coins + tokens)
  const utxos = await bf.utxosByAddress(multisigAddress);
  let totalValue = CSL.Value.new(CSL.BigNum.from_str('0'));
  for (const u of utxos) {
    const txHash = CSL.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex'));
    const input  = CSL.TransactionInput.new(txHash, Number(u.output_index));
    const v = CSL.Value.new(CSL.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace').quantity));
    const assets = u.amount.filter(a => a.unit !== 'lovelace').map(a => ({ unit: a.unit, quantity: a.quantity }));
    addAssetsToValue(v, assets);
    totalValue = mergeValue(totalValue, v);
  }

  const totalJS = valueToJs(totalValue);            // { coin, assets(Map) }

  // 2) Build outputs list & JS aggregates for explicit accounting
  const outSpecs = [];
  let outCoin = '0';
  const outAssets = new Map();

  if (mode === 'sendAll') {
    if (!destAddress) throw new Error('DEST address missing');
    // Output 0: ALL tokens + min ADA to DEST
    outCoin = bigAdd(outCoin, MIN_ADA);
    jsAssetsAdd(outAssets, totalJS.assets);         // send ALL tokens
    outSpecs.push({
      address: destAddress,
      coin: MIN_ADA,
      assetsMap: totalJS.assets
    });
  } else if (mode === 'explicit') {
    for (const o of (outputs || [])) {
      const coin = String(o.lovelace || '0');
      const aMap = jsAssetsFromOutputSpec(o.assets || []);
      // token outputs must have ADA floor
      const effectiveCoin = jsAssetsIsEmpty(aMap) ? coin : (bigGtEq(coin, MIN_ADA) ? coin : MIN_ADA);
      outCoin = bigAdd(outCoin, effectiveCoin);
      jsAssetsAdd(outAssets, aMap);
      outSpecs.push({ address: o.address, coin: effectiveCoin, assetsMap: aMap });
    }
  } else {
    throw new Error('invalid mode');
  }

  // 3) Compute change = TOTAL - OUTS - FIXED_FEE
  const fee = FIXED_FEE;
  if (!bigGtEq(totalJS.coin, bigAdd(outCoin, fee))) {
    throw new Error('insufficient ADA for outputs + 1 ADA fee');
  }

  // change assets = total.assets - out.assets
  const changeAssets = jsAssetsSub(totalJS.assets, outAssets);
  let changeCoin = bigSub(bigSub(totalJS.coin, outCoin), fee);

  // if change carries tokens, ensure ADA floor
  if (!jsAssetsIsEmpty(changeAssets) && !bigGtEq(changeCoin, MIN_ADA)) {
    throw new Error('insufficient ADA for change that carries tokens (needs at least MIN_ADA)');
  }

  // 4) Build transaction using explicit outputs + explicit change + explicit fee
  const cfg = CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(CSL.LinearFee.new(
      CSL.BigNum.from_str(protocol.min_fee_a.toString()),
      CSL.BigNum.from_str(protocol.min_fee_b.toString())
    ))
    .pool_deposit(CSL.BigNum.from_str(protocol.pool_deposit.toString()))
    .key_deposit(CSL.BigNum.from_str(protocol.key_deposit.toString()))
    .max_value_size(protocol.max_val_size ?? 5000)
    .max_tx_size(protocol.max_tx_size ?? 16384)
    .coins_per_utxo_byte(
      CSL.BigNum.from_str((protocol.coins_per_utxo_size ?? protocol.coins_per_utxo_byte ?? 4310).toString())
    )
    .build();

  const tb = CSL.TransactionBuilder.new(cfg);

  // add inputs (all)
  for (const u of utxos) {
    const txHash = CSL.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex'));
    const input  = CSL.TransactionInput.new(txHash, Number(u.output_index));
    const v = CSL.Value.new(CSL.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace').quantity));
    const assets = u.amount.filter(a => a.unit !== 'lovelace').map(a => ({ unit: a.unit, quantity: a.quantity }));
    addAssetsToValue(v, assets);
    tb.add_input(msAddr, input, v);
  }

  // add outputs from specs
  for (const spec of outSpecs) {
    const v = CSL.Value.new(CSL.BigNum.from_str(spec.coin));
    if (!jsAssetsIsEmpty(spec.assetsMap)) jsAssetsToValue(v, spec.assetsMap);
    // bump for visual parity; already enforced in coin above
    if (v.multiasset()) bumpAdaIfTokens(v);
    tb.add_output(CSL.TransactionOutput.new(CSL.Address.from_bech32(spec.address), v));
  }

  // add change if any
  if (BigInt(changeCoin) > 0n || !jsAssetsIsEmpty(changeAssets)) {
    const changeVal = CSL.Value.new(CSL.BigNum.from_str(changeCoin < 0 ? '0' : changeCoin));
    if (!jsAssetsIsEmpty(changeAssets)) jsAssetsToValue(changeVal, changeAssets);
    if (changeVal.multiasset()) bumpAdaIfTokens(changeVal);

    // send change:
    const changeAddr =
      mode === 'sendAll'
        ? CSL.Address.from_bech32(destAddress)   // sweep: change to DEST
        : msAddr;                                 // explicit: change back to multisig

    tb.add_output(CSL.TransactionOutput.new(changeAddr, changeVal));
  }

  // set fixed fee (no add_change_if_needed!)
  tb.set_fee(CSL.BigNum.from_str(fee));

  // Add required signers explicitly so wallets know which keys must witness this tx.
  // (Native script will also enforce this on-chain.)
  if (Array.isArray(requiredKeyHashes) && requiredKeyHashes.length) {
    for (const khHex of requiredKeyHashes) {
      try {
        tb.add_required_signer(
          CSL.Ed25519KeyHash.from_bytes(Buffer.from(String(khHex).toLowerCase(), 'hex'))
        );
      } catch (_) {
        // ignore malformed hashes
      }
    }
  }

  const body = tb.build();
  const hash = CSL.hash_transaction(body);

  // attach native script in witness set
  const ws = CSL.TransactionWitnessSet.new();
  const ns = CSL.NativeScripts.new();
  ns.add(CSL.NativeScript.from_bytes(Buffer.from(paymentScriptHex, 'hex')));
  ws.set_native_scripts(ns);

  const unsignedTx = CSL.Transaction.new(body, ws);

  // preview
  const preview = { mode, selectedInputs: utxos, computedOutputs: [], fee, changeCoin, changeHasTokens: !jsAssetsIsEmpty(changeAssets) };
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    const row = { address: o.address().to_bech32(), lovelace: o.amount().coin().to_str(), assets: [] };
    const ma = o.amount().multiasset();
    if (ma) {
      const policies = ma.keys();
      for (let p = 0; p < policies.len(); p++) {
        const pid = policies.get(p);
        const assets = ma.get(pid);
        const names = assets.keys();
        for (let n = 0; n < names.len(); n++) {
          const nm = names.get(n);
          const qty = assets.get(nm).to_str();
          const unit = Buffer.from(pid.to_bytes()).toString('hex') + Buffer.from(nm.name()).toString('hex');
          row.assets.push({ unit, quantity: qty });
        }
      }
    }
    preview.computedOutputs.push(row);
  }

  return {
    txId: bytesToHex(hash.to_bytes()),
    txBodyHex: bytesToHex(body.to_bytes()),
    txHex: bytesToHex(unsignedTx.to_bytes()),
    initialWitnessSetHex: bytesToHex(ws.to_bytes()),
    preview
  };
}

/* merge two Values (coins + ma) */
function mergeValue(a, b) {
  const out = CSL.Value.new(a.coin());
  out.set_coin(a.coin()); // clone coins
  // add coins
  out.set_coin(out.coin().checked_add(b.coin()));
  // merge assets
  const ma = a.multiasset();
  if (ma) out.set_multiasset(ma);
  const mb = b.multiasset();
  if (mb) {
    const merged = out.multiasset() ?? CSL.MultiAsset.new();
    const policies = mb.keys();
    for (let p = 0; p < policies.len(); p++) {
      const pid = policies.get(p);
      const bAssets = mb.get(pid);
      const names = bAssets.keys();
      let dAssets = merged.get(pid);
      if (!dAssets) dAssets = CSL.Assets.new();
      for (let n = 0; n < names.len(); n++) {
        const nm = names.get(n);
        const addQty = bAssets.get(nm);
        const cur = dAssets.get(nm);
        dAssets.insert(nm, cur ? cur.checked_add(addQty) : addQty);
      }
      merged.insert(pid, dAssets);
    }
    out.set_multiasset(merged);
  }
  return out;
}

function assembleAndSerializeTx({ txBodyHex, scriptHex, witnessHexes }) {
  const body = CSL.TransactionBody.from_bytes(hexToBytes(txBodyHex));
  const wsAll = CSL.TransactionWitnessSet.new();
  const ns = CSL.NativeScripts.new();
  ns.add(CSL.NativeScript.from_bytes(hexToBytes(scriptHex)));
  wsAll.set_native_scripts(ns);

  const agg = CSL.Vkeywitnesses.new();
  for (const w of witnessHexes) {
    const ws = CSL.TransactionWitnessSet.from_bytes(hexToBytes(w));
    const vkeys = ws.vkeys();
    if (vkeys) for (let i = 0; i < vkeys.len(); i++) agg.add(vkeys.get(i));
  }
  if (agg.len() > 0) wsAll.set_vkeys(agg);

  const signedTx = CSL.Transaction.new(body, wsAll);
  return Buffer.from(signedTx.to_bytes());
}

module.exports = { buildUnsignedTx, assembleAndSerializeTx };

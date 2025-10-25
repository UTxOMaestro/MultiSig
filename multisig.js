const CSL = require('@emurgo/cardano-serialization-lib-nodejs');
const MIN_ADA = String(process.env.MIN_ADA_LOVELACE || 2_000_000);

const hexToBytes = (h) => Buffer.from(h, 'hex');
const bytesToHex = (b) => Buffer.from(b).toString('hex');

function addAssetsToValue(value, assets) {
  if (!assets?.length) return value;
  const ma = value.multiasset() ?? CSL.MultiAsset.new();
  for (const a of assets) {
    const unit = a.unit.toLowerCase();      // <policy56hex><assetNameHex>
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

function mergeValueInto(dst, src) {
  dst.set_coin(dst.coin().checked_add(src.coin()));
  const srcMA = src.multiasset();
  if (srcMA) {
    let dstMA = dst.multiasset();
    if (!dstMA) dstMA = CSL.MultiAsset.new();
    const policies = srcMA.keys();
    for (let p = 0; p < policies.len(); p++) {
      const pid = policies.get(p);
      const srcAssets = srcMA.get(pid);
      const names = srcAssets.keys();
      let dstAssets = dstMA.get(pid);
      if (!dstAssets) dstAssets = CSL.Assets.new();
      for (let n = 0; n < names.len(); n++) {
        const nm = names.get(n);
        const addQty = srcAssets.get(nm);
        const cur = dstAssets.get(nm);
        dstAssets.insert(nm, cur ? cur.checked_add(addQty) : addQty);
      }
      dstMA.insert(pid, dstAssets);
    }
    dst.set_multiasset(dstMA);
  }
  return dst;
}

function bumpAdaIfTokens(value) {
  if (!value.multiasset()) return value;
  const floor = CSL.BigNum.from_str(MIN_ADA);
  if (value.coin().compare(floor) < 0) value.set_coin(floor);
  return value;
}

async function buildUnsignedTx({
  bf, network, multisigAddress, paymentScriptHex,
  requiredKeyHashes, mRequired,
  mode,               // "sendAll" | "explicit"
  destAddress,        // env DEST_ADDRESS if sendAll
  outputs             // explicit: [{address, lovelace, assets:[{unit,quantity}]}]
}) {
  const protocol = await bf.protocolParams();
  const msAddr = CSL.Address.from_bech32(multisigAddress);
  const utxos = await bf.utxosByAddress(multisigAddress);

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
      CSL.BigNum.from_str(
        (protocol.coins_per_utxo_size ?? protocol.coins_per_utxo_byte ?? 4310).toString()
      )
    )
    .build();

  const tb = CSL.TransactionBuilder.new(cfg);

  // Collect all inputs (simple + safe for exits)
  let totalValue = CSL.Value.new(CSL.BigNum.from_str('0'));
  for (const u of utxos) {
    const txHash = CSL.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex'));
    const input = CSL.TransactionInput.new(txHash, Number(u.output_index));
    const v = CSL.Value.new(CSL.BigNum.from_str(u.amount.find(a=>a.unit==='lovelace').quantity));
    const assets = u.amount.filter(a=>a.unit!=='lovelace').map(a=>({unit:a.unit, quantity:a.quantity}));
    addAssetsToValue(v, assets);
    tb.add_input(msAddr, input, v);
    totalValue = mergeValueInto(totalValue, v);
  }

  const preview = { mode, selectedInputs: utxos, computedOutputs: [], change: [], fee: "0" };

  if (mode === 'sendAll') {
    if (!destAddress) throw new Error('DEST address missing');
    const dest = CSL.Address.from_bech32(destAddress);
    const outVal = CSL.Value.new(CSL.BigNum.from_str(MIN_ADA));
    const totalMA = totalValue.multiasset();
    if (totalMA) outVal.set_multiasset(totalMA);
    tb.add_output(CSL.TransactionOutput.new(dest, outVal));
    // Defer change calculation until after we set a buffered fee
  } else if (mode === 'explicit') {
    for (const o of outputs || []) {
      const v = CSL.Value.new(CSL.BigNum.from_str(o.lovelace || '0'));
      addAssetsToValue(v, o.assets);
      bumpAdaIfTokens(v);
      tb.add_output(CSL.TransactionOutput.new(CSL.Address.from_bech32(o.address), v));
    }
    // Defer change calculation until after we set a buffered fee
  } else {
    throw new Error('invalid mode');
  }

  // Fee buffer to account for m vkey witnesses being added later
  // Without this, final tx size grows and the node rejects with FeeTooSmall
  const feeCoefA = Number(protocol.min_fee_a || 44);
  const estVkeyWitnessBytes = 300; // conservative per-witness byte estimate for multi-sig
  const witnessCount = Math.max(Number(mRequired || 1), 1);
  const feeBuffer = String(feeCoefA * estVkeyWitnessBytes * witnessCount);

  const changeAddr = (mode === 'sendAll') ? CSL.Address.from_bech32(destAddress) : msAddr;
  // First pass: base min fee + buffer
  const baseMinFee = tb.min_fee();
  const feeWithBuffer = baseMinFee.checked_add(CSL.BigNum.from_str(feeBuffer));
  tb.set_fee(feeWithBuffer);
  tb.add_change_if_needed(changeAddr);
  // Second pass: change output increases size slightly; recompute
  const minFeeAfterChange = tb.min_fee();
  const finalFee = minFeeAfterChange.checked_add(CSL.BigNum.from_str(feeBuffer));
  tb.set_fee(finalFee);
  tb.add_change_if_needed(changeAddr);

  const body = tb.build();
  const hash = CSL.hash_transaction(body);

  // Attach native script in witness set now (vkeys come later)
  const ws = CSL.TransactionWitnessSet.new();
  const ns = CSL.NativeScripts.new();
  ns.add(CSL.NativeScript.from_bytes(Buffer.from(paymentScriptHex, 'hex')));
  ws.set_native_scripts(ns);

  // Build the full unsigned Transaction for CIP-30 signTx
  const unsignedTx = CSL.Transaction.new(body, ws);

  // Preview outputs + fee
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
  preview.fee = body.fee().to_str();

  return {
    txId: bytesToHex(hash.to_bytes()),
    txBodyHex: bytesToHex(body.to_bytes()),
    txHex: bytesToHex(unsignedTx.to_bytes()),
    initialWitnessSetHex: bytesToHex(ws.to_bytes()),
    preview
  };
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



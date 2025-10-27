#!/usr/bin/env node
/**
 * Inspect a Cardano Native Script (CBOR hex) and print its properties.
 *
 * Usage:
 *   node inspect_native_script.js \
 *     --payment 8201... (CBOR hex) \
 *     [--stake 8201... (CBOR hex)] \
 *     [--network mainnet|preprod]
 *
 * Example (your values):
 *   node inspect_native_script.js \
 *     --payment 820181830303858200581c3a2c4d9c3cb270daa4fdbde236b39d83a107e2351cd4b0a46b38a3c78200581cf467ef78b5d6ade07772ba32544b71009775e33a34ed4e93fbd7d2358200581ccf0e639d53f433e4738ac6b52bb45d30527d071a0f4db5bb77ae8e738200581ceb6e12a9dd039604bb4fdc82aaa6309cfcb21597f79663a330b752df8200581c30984e27f30a07807fcf694b5420f83edde7f8ad4ffd7ee2886c7925 \
 *     --stake   820181830303858200581c3a2c4d9c3cb270daa4fdbde236b39d83a107e2351cd4b0a46b38a3c78200581cf467ef78b5d6ade07772ba32544b71009775e33a34ed4e93fbd7d2358200581ccf0e639d53f433e4738ac6b52bb45d30527d071a0f4db5bb77ae8e738200581ceb6e12a9dd039604bb4fdc82aaa6309cfcb21597f79663a330b752df8200581c30984e27f30a07807fcf694b5420f83edde7f8ad4ffd7ee2886c7925 \
 *     --network mainnet
 */

const CSL = require('@emurgo/cardano-serialization-lib-nodejs');

function hexToBytes(h) { return Buffer.from(h, 'hex'); }
function bytesToHex(b) { return Buffer.from(b).toString('hex'); }

const K = {
  SCRIPT_PUBKEY: 0,
  SCRIPT_ALL: 1,
  SCRIPT_ANY: 2,
  SCRIPT_N_OF_K: 3,
  SCRIPT_INVALID_BEFORE: 4,
  SCRIPT_INVALID_HEREAFTER: 5
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { network: 'mainnet' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--payment') out.payment = argv[++i];
    else if (k === '--stake') out.stake = argv[++i];
    else if (k === '--network') out.network = argv[++i];
  }
  if (!out.payment) {
    console.error('Missing --payment <CBOR hex>');
    process.exit(1);
  }
  if (!['mainnet','preprod'].includes(out.network)) {
    console.error('--network must be "mainnet" or "preprod"');
    process.exit(1);
  }
  return out;
}

function getChildScripts(container) {
  if (typeof container.scripts === 'function') return container.scripts();
  if (typeof container.native_scripts === 'function') return container.native_scripts();
  return null;
}

function collectScriptInfo(nativeScript, acc, path=[]) {
  const kind = nativeScript.kind();
  switch (kind) {
    case K.SCRIPT_PUBKEY: {
      const kh = nativeScript.as_script_pubkey().addr_keyhash();
      const hex = bytesToHex(kh.to_bytes());
      acc.keys.add(hex);
      acc.tree.push({ type: 'pubkey', keyHash: hex, path: [...path] });
      break;
    }

    case K.SCRIPT_ALL: {
      const scripts = getChildScripts(nativeScript.as_script_all());
      const node = { type: 'all', children: [], path: [...path] };
      acc.tree.push(node);
      if (scripts) {
        for (let i = 0; i < scripts.len(); i++) {
          collectScriptInfo(scripts.get(i), acc, [...path, `all[${i}]`]);
        }
      }
      break;
    }

    case K.SCRIPT_ANY: {
      const scripts = getChildScripts(nativeScript.as_script_any());
      const node = { type: 'any', children: [], path: [...path] };
      acc.tree.push(node);
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
      const node = { type: 'atLeast', n, k: scripts ? scripts.len() : 0, children: [], path: [...path] };
      acc.tree.push(node);
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
      acc.invalidHereafter = Math.min(acc.invalidHereafter ?? Number.MAX_SAFE_INTEGER, Number(slot.to_str()));
      acc.tree.push({ type: 'invalid_hereafter', slot: Number(slot.to_str()), path: [...path] });
      break;
    }

    default:
      acc.tree.push({ type: 'unknown', kind, path: [...path] });
  }
}

function deriveSummary(scriptHex) {
  const ns = CSL.NativeScript.from_bytes(hexToBytes(scriptHex));
  const info = { keys: new Set(), thresholds: [], invalidBefore: null, invalidHereafter: null, tree: [] };
  collectScriptInfo(ns, info);

  const requiredKeyHashes = Array.from(info.keys);
  // If there is any explicit N-of-K, take the maximum N encountered as the effective threshold.
  let mRequired;
  if (info.thresholds.length > 0) {
    mRequired = Math.max(...info.thresholds);
  } else {
    const hasAny = info.tree.some(n => n.type === 'any');
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
    const base = CSL.BaseAddress.new(
      netId,
      payCred,
      stakeCred
    ).to_address().to_bech32();
    return {
      baseAddress: base,
      enterpriseAddress: CSL.EnterpriseAddress.new(netId, payCred).to_address().to_bech32()
    };
  } else {
    return {
      baseAddress: null,
      enterpriseAddress: CSL.EnterpriseAddress.new(netId, payCred).to_address().to_bech32()
    };
  }
}

(async function main(){
  try {
    // Hardcoded inputs for Sharl Treasury
    const payment = '820181830303858200581cd30790a7da1ab23a1eba940bb31afe04bbaf61bf4f59b6319c10609d8200581c34731b1995e5520642727736c859d2a590363ea41da368bebd49ace68200581c5cb3819463fea4cdf2c90540351b9387c09fc1951630b15d3f06fad48200581cc8c8ebf1e4964084ff85305d37746bdde4563a07c2b3b259d32e77ed8200581c4e54a64c2ab276ac88c465a9aba99c01ce16a6bd63098f5c9fddb998';
    const stake = null; // No stake script provided for Sharl Treasury
    const network = 'mainnet';

    const paymentSummary = deriveSummary(payment);
    const out = {
      network,
      payment: paymentSummary
    };

    if (stake) {
      const stakeSummary = deriveSummary(stake);
      out.stake = stakeSummary;

      const addrs = bech32AddressesFrom(payment, stake, network);
      out.derivedAddresses = addrs;
    } else {
      const addrs = bech32AddressesFrom(payment, null, network);
      out.derivedAddresses = addrs;
    }

    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('Error:', e?.message || e);
    process.exit(1);
  }
})();



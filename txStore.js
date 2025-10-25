const txs = new Map(); // txId -> { txHex, txBodyHex, scriptHex, m, signersKeyHashes, witnesses: Map<keyhash, hex>, preview }

function createTxRecord(txId, { txHex, txBodyHex, scriptHex, m, signersKeyHashes, preview }) {
  txs.set(txId, { txHex, txBodyHex, scriptHex, m, signersKeyHashes, witnesses: new Map(), preview });
}
function getTxRecord(txId) { return txs.get(txId); }
function addWitness(txId, keyHashHex, witnessHex) {
  const rec = txs.get(txId);
  if (!rec) return { ok: false, error: 'not_found' };
  rec.witnesses.set(keyHashHex, witnessHex);
  return { ok: true, count: rec.witnesses.size, m: rec.m };
}
function status(txId) {
  const r = txs.get(txId);
  if (!r) return null;
  return {
    m: r.m,
    required: r.signersKeyHashes,
    collected: Array.from(r.witnesses.keys()),
    preview: r.preview
  };
}
function clearTx(txId) { txs.delete(txId); }

module.exports = { createTxRecord, getTxRecord, addWitness, status, clearTx };



const axios = require('axios');

const base = (net) =>
  net === 'mainnet'
    ? 'https://cardano-mainnet.blockfrost.io/api/v0'
    : 'https://cardano-preprod.blockfrost.io/api/v0';

function bfClient(projectId, network) {
  const api = axios.create({
    baseURL: base(network),
    headers: { project_id: projectId }
  });

  return {
    utxosByAddress: async (addr) => (await api.get(`/addresses/${addr}/utxos?order=desc`)).data,
    protocolParams: async () => (await api.get(`/epochs/latest/parameters`)).data,
    submitTx: async (txBytes) =>
      (await api.post(`/tx/submit`, Buffer.from(txBytes), { headers: { 'Content-Type': 'application/cbor' } })).data
  };
}

module.exports = { bfClient };



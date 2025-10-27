const axios = require('axios');
const CardanoWasm = require('@emurgo/cardano-serialization-lib-nodejs');

// Input stake key hash
const STAKE_KEY_HASH = 'f95cb3bc90e3fdb3db4a98ed64a77762daa891c7af7138d45e38adb7';

async function findAddressFromStakeKey() {
  try {
    // Blockfrost configuration
    const projectId = 'mainnetWDj2JlOZWcWPPKHctTOopdbDdCwWkO3v';
    const network = 'mainnet';

    // Create axios instance for direct Blockfrost API calls
    const api = axios.create({
      baseURL: network === 'mainnet' 
        ? 'https://cardano-mainnet.blockfrost.io/api/v0'
        : 'https://cardano-preprod.blockfrost.io/api/v0',
      headers: { project_id: projectId }
    });

    // Convert stake key hash to proper stake address
    const stakeKeyHash = CardanoWasm.Ed25519KeyHash.from_hex(STAKE_KEY_HASH);
    const stakeCredential = CardanoWasm.StakeCredential.from_keyhash(stakeKeyHash);
    const networkId = network === 'mainnet' ? CardanoWasm.NetworkInfo.mainnet().network_id() : CardanoWasm.NetworkInfo.testnet().network_id();
    const rewardAddress = CardanoWasm.RewardAddress.new(networkId, stakeCredential);
    const stakeAddress = rewardAddress.to_address().to_bech32();
    
    console.log(`Looking up stake address: ${stakeAddress}`);
    
    try {
      // Get account information
      const accountResponse = await api.get(`/accounts/${stakeAddress}`);
      console.log('Account found:', accountResponse.data);
      
      // Get addresses associated with this stake account
      const addressesResponse = await api.get(`/accounts/${stakeAddress}/addresses`);
      const addresses = addressesResponse.data;
      
      console.log(`\nFound ${addresses.length} addresses associated with stake key:`);
      addresses.forEach((addr, index) => {
        console.log(`${index + 1}. ${addr.address}`);
      });
      
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log('Stake address not found on-chain (no transactions yet).');
      } else {
        throw error;
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the resolver
findAddressFromStakeKey();

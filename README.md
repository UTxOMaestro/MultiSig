# Summon Exit — Minimal Multisig Sign & Sweep

All-in-one Express app you can deploy on Railway. It:

- builds an unsigned tx on the server (Blockfrost + cardano-serialization-lib),
- lets signers connect wallet + partial-sign in the browser (CIP-30),
- collects witnesses server-side,
- auto-submits once M signatures are in,
- uses an ENV var for the destination address of all funds/tokens.

## Project tree

```
summon-exit/
├─ .env.example
├─ package.json
├─ server.js
├─ blockfrost.js
├─ txStore.js
├─ multisig.js
├─ public/
│  └─ index.html
└─ README.md
```

## Setup

```bash
pnpm i || npm i
cp .env.example .env   # fill values
npm start
```

Fill `.env` using `.env.example`. Important:

- `BLOCKFROST_PROJECT_ID` — your Blockfrost key for the selected `NETWORK`.
- `MULTISIG_ADDRESS`, `PAYMENT_SCRIPT_CBOR`, `M_REQUIRED`, `REQUIRED_KEY_HASHES`.
- `DEST_ADDRESS` — sweep destination for sendAll mode.

## API

### Create a signing session (sweep ALL to ENV DEST_ADDRESS)

```bash
curl -X POST http://localhost:3000/api/create \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "sendAll"
  }'
```

Response:

```json
{
  "txId":"<hex>",
  "preview": { "computedOutputs":[{"address":"<DEST_ADDRESS>","lovelace":"...","assets":[...]}], "fee":"...", "selectedInputs": [ ... ] },
  "mRequired":3,
  "requiredKeyHashes":["...","...","...","...","..."]
}
```

Verify `preview` shows all ADA + tokens going to `DEST_ADDRESS`.

### Optional explicit outputs

```bash
curl -X POST http://localhost:3000/api/create \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "explicit",
    "outputs": [
      {
        "address": "addr1qDEST...",
        "lovelace": "1500000",
        "assets": [
          {"unit": "279c909f...534e454b", "quantity": "1000000"}
        ]
      }
    ]
  }'
```

## Signing flow

- Share `txId` with signers.
- Each signer opens the site, pastes `txId`, clicks Sign & Upload.
- When M witnesses are collected, the server auto-submits and returns `txHash`.

## Notes

- No secrets in the browser; Blockfrost key stays server-side.
- In-memory store is for speed; swap `txStore.js` to Redis/DB for durability.
- The payment script CBOR must be exact (from Summon). Stake script is unnecessary for simple spends.
- Multi-asset is preserved/swept in sendAll mode.

## Inspect a Native Script (CBOR)

You can inspect your payment/stake native scripts to list thresholds, required key hashes, script hashes, time locks, and derive addresses.

Run:

```bash
npm run inspect:script -- \
  --payment 8201...CBORHEX... \
  [--stake 8201...CBORHEX...] \
  [--network mainnet|preprod]
```

This prints a JSON summary with `mRequired`, `requiredKeyHashes`, `scriptHash`, any timelocks, and derived base/enterprise addresses.



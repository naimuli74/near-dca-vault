#!/usr/bin/env bash
# Unauthenticated dry quote: 10 USDC on Ethereum to native BTC.
# No API key. No funds move. Confirms 1Click dry-run works.
set -euo pipefail
DEADLINE=$(python3 -c "from datetime import datetime, timezone, timedelta; print((datetime.now(timezone.utc)+timedelta(minutes=10)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
curl -sS -X POST "https://1click.chaindefuser.com/v0/quote" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{
    \"dry\": true,
    \"swapType\": \"EXACT_INPUT\",
    \"slippageTolerance\": 100,
    \"originAsset\": \"nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near\",
    \"depositType\": \"ORIGIN_CHAIN\",
    \"destinationAsset\": \"nep141:btc.omft.near\",
    \"amount\": \"10000000\",
    \"recipient\": \"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4\",
    \"recipientType\": \"DESTINATION_CHAIN\",
    \"refundTo\": \"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\",
    \"refundType\": \"ORIGIN_CHAIN\",
    \"deadline\": \"$DEADLINE\"
  }"
echo

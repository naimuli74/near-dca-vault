# DCA Vault

A non-custodial cross-chain dollar-cost-average tool, built at **NEAR HACKATHON** (Unstoppable DeFi track, `defi`).

- **Live site:** https://dca.darkhouse.online (mirror: https://near-dca-vault.tasnovanaime.workers.dev)
- **This is a second, independent hackathon project.** The other one is the Investment Thesis dashboard: https://github.com/naimuli74/near-payments-rail-thesis (rule Q-015).

A user picks USDC on any chain [NEAR Intents](https://docs.near-intents.org/) supports, a target asset (BTC, ETH or wNEAR), a destination address, a size, a slippage limit and a schedule. Each interval requests a quote from the [1Click API](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request). If the quoted price is worse than the user's limit after known fees, the buy is skipped. Otherwise, in live mode, the user sends that interval's USDC to a fresh 1Click deposit address and the asset lands in their own address on the destination chain.

Dry-run is the default and the path for judges: it uses real unauthenticated 1Click quotes with `dry: true`, writes them to history, and never issues a deposit address.

## Try it (do X, see Y)

1. Open https://dca.darkhouse.online. You see a hero route (USDC → NEAR Intents → your address), a live 1Click dry-quote ticker, the supported USDC chains, a dry-run plan form, and a dark/light toggle.
2. Leave **Dry-run** selected. Pick USDC on Ethereum, BTC, 50 USDC, a daily (or 5-minute) interval, a Bitcoin destination address and an Ethereum refund address. You can use the BIP-173 example `bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4` and any well-formed 0x refund address; nothing will be sent.
3. Press **Preview quote**. You see a real 1Click dry quote: amounts, withdraw and refund fees, the 1Click fee, and whether the quote passes your slippage limit.
4. Press **Create plan**, then **Run next buy (dry)**. You see a history row with status `DRY QUOTED` (or `SKIPPED SLIPPAGE`) and a "Where are your funds" panel that says nothing moved.
5. Optional: set the interval to every 5 minutes and wait. A Cloudflare cron trigger runs due dry plans and appends another history row.

To reproduce a dry quote from the command line, with no API key:

```sh
bash scripts/dry_quote.sh
```

You should get an HTTP 201 JSON body with `quoteRequest.dry: true`, an `amountOut`, and no `depositAddress`.

Live mode is opt-in and mainnet-only (there is no Intents testnet; see HACKATHON.md Q-007). It issues a real deposit address that expires in about 10 minutes. You send the funds yourself. This repository never holds keys or signs a transaction.

## Architecture

```
Browser  →  Cloudflare Worker (dca.darkhouse.online)
                ├─ GET  /api/tokens          cached 1Click token list
                ├─ GET  /api/ticker          cached 1Click dry quotes (50 USDC → BTC/ETH/NEAR)
                ├─ GET  /api/simulate        CoinGecko weekly DCA backtest
                ├─ POST /api/quote           always dry
                ├─ POST /api/plans           create a plan (KV)
                ├─ GET  /api/plans/:id       plan + history + funds panel
                ├─ POST /api/plans/:id/buy   dry by default; wet only if the plan is live
                ├─ GET  /api/status          1Click status + explorer links
                └─ cron */5 * * * *         dry ticks + poll live statuses
```

Plans and history are stored in Workers KV. 1Click is called from the Worker, unauthenticated. A JWT is not required; unauthenticated quotes pay an extra 0.25% platform fee ([fees](https://docs.near-intents.org/resources/fees)). Register at https://partners.near-intents.org if you want the authenticated schedule. Do not put a key in this repo.

1Click already handles quotes, unique deposit addresses, `slippageTolerance`, destination delivery, refunds, and the status lifecycle (`PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED`). This app adds the scheduler, the UI, the funds-location panel, explorer links, fee display, and an extra slippage gate on the quoted price after known fees.

Deposit addresses are one-off and last about 10 minutes, so a recurring "vault" cannot sit on a single 1Click address. Dry-run and live-per-interval deposits are honest about that. The app does not take custody.

## How 1Click is used

| Step | Endpoint | Docs |
| --- | --- | --- |
| Supported assets | `GET https://1click.chaindefuser.com/v0/tokens` | [Making a Request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request) |
| Dry or wet quote | `POST https://1click.chaindefuser.com/v0/quote` | [Request a swap quote](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote) |
| Status | `GET https://1click.chaindefuser.com/v0/status?depositAddress=` | [Check swap status](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status) |
| Optional tx notify | `POST https://1click.chaindefuser.com/v0/deposit/submit` | same quickstart |
| OpenAPI | https://1click.chaindefuser.com/docs/v0/openapi.yaml | |
| Agent skill | [near-intents](https://github.com/near/agent-skills/tree/main/skills/near-intents) | [Skill docs](https://docs.near-intents.org/integration/devkit/skills) |

The official skill and docs: `dry: true` is preview only and does not return a deposit address; `dry: false` returns one, valid for about 10 minutes. There is no testnet ([HACKATHON.md Q-007](https://nearhackathon.com/HACKATHON.md)).

## Limits and future work

- Small buys can look expensive because 1Click withdraw fees are fixed. The UI shows them. Prefer a larger size if you try a live swap.
- BNB Chain quotes have a $1,000 minimum and Tron origins have a $100 minimum ([swap limits](https://docs.near-intents.org/resources/swap-limits)). Other USDC origins, including Ethereum, have no USD floor.
- The NEAR target is **wNEAR** (`nep141:wrap.near`), which is how 1Click lists it.
- Status `FAILED` and `REFUNDED` are shown in the UI. The app cannot move funds; if a live swap fails, check the refund address and the [NEAR Intents explorer](https://explorer.near-intents.org).
- **Not in this build (stretch):** a NEAR contract that owns the vault and uses [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures) to control a derived BTC (or origin-chain) address and pay each interval automatically. That is the path to a true non-custodial vault. It needs a mainnet contract, keys and more time than this deadline allowed.

## Repo layout

```
src/worker.js          Worker routes and cron
src/oneclick.js        1Click client, fee display, slippage gate
src/plans.js           Plan validation and funds-location copy
src/store.js           KV helpers
src/market.js          1Click ticker and CoinGecko simulator
public/                Static UI (dark and light)
scripts/build.mjs      Bundles the Worker
scripts/dry_quote.sh   Unauthenticated dry quote
```

```sh
npm run build          # writes dist/worker.js
bash scripts/dry_quote.sh
```

The Worker is deployed to account `924b192f1ecca16e26617be53011939d` as `near-dca-vault`, with KV and a cron trigger, on `dca.darkhouse.online`.


## Site additions

The plan form, dry-run default, live opt-in, funds panel and history are unchanged. The home page also has:

- A live **ticker** of unauthenticated 1Click dry quotes for 50 USDC on Ethereum into BTC, ETH and NEAR. Quotes are cached for about 90 seconds and use public example addresses. Nothing is deposited.
- A **supported-chains** strip from `GET /v0/tokens` (the same list as the origin menu).
- A **fee explainer** that cites the official 0.25% unauthenticated 1Click platform fee, withdraw/refund fees, and the slippage gate.
- A **historical DCA simulator**: “if you had bought $X of BTC, ETH or NEAR every week for N weeks.” Prices come from [CoinGecko](https://www.coingecko.com) daily USD charts, sampled weekly, and are cached for about six hours. If CoinGecko rate-limits the Worker, the simulator falls back to Coinbase Exchange public daily closes and names that source in the result. The result is labelled as a price-path simulation, not a 1Click quote, and it does not include swap fees.
- An **FAQ**, including whether the app is custodial and what happens if a swap fails.
- Footer links to the [GitHub repo](https://github.com/naimuli74/near-dca-vault), the [demo post](https://x.com/naimulislam/status/2121695044352839829), and the sister project at https://near.darkhouse.online.

## Rollback

The last pre-polish production tree is git commit `5bc7d49`. To roll the Worker and site back to that version, check out that commit, run `KV_NAMESPACE_ID=6dc2c69028764710a20fb03bdf90e7c7 npm run build`, and redeploy `dist/deploy.js` the same way as a normal release.

## License

MIT. Self-hosted Inter and Instrument Serif fonts are under the SIL Open Font License (see `public/fonts/`).

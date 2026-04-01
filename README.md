# VeilBid

**Confidential auction infrastructure for on-chain finance.**

**[Live Demo](https://veilbid-app.vercel.app)** | **[Sepolia Contract](https://sepolia.etherscan.io/address/0x0F4DAe0DfCCF5Ed79b63Dd662Aa25F3150f5cb75)**

---

March 2020. MakerDAO's liquidation auctions are visible on-chain. Liquidation bots see each other's bids, coordinate, and bid $0. They walk away with **$8.3 million** in collateral for free. Nobody cheated. The system worked exactly as designed. The design was the problem.

Every on-chain auction publishes bids in plaintext calldata. Competitors see your price. MEV bots front-run your transaction. Rational participants shade below their true valuation because overpaying hurts more than losing. Sellers get worse prices. Bidders get worse outcomes. Institutions don't show up at all.

VeilBid fixes this. Bid prices are encrypted client-side using Fully Homomorphic Encryption and submitted as ciphertext. The smart contract finds the winner and settlement price by computing directly on encrypted data, without ever decrypting individual bids. The winner pays the second-highest price (Vickrey mechanism), making honest bidding the dominant strategy. Regulators get selective decryption access on demand.

**27 passing tests. Deployed on Ethereum Sepolia with real client-side FHE encryption. 14 fhEVM primitives in a single contract.**

Built on [Zama's fhEVM](https://docs.zama.ai/fhevm).

## About

Built by **faruukku**. I watched the MakerDAO Black Thursday postmortem and couldn't shake the fact that $8.3 million vanished not because of an exploit, but because the auction was transparent by default. That's a design failure, not a security failure — and it means every on-chain auction running today has the same vulnerability baked in. I built VeilBid because I believe privacy isn't a feature you bolt on after the fact; it's infrastructure. FHE lets us keep the verifiability of public blockchains while giving bidders the confidentiality they need to bid honestly. If DeFi wants institutional capital, it needs to stop broadcasting everyone's strategy to the world.

## What We Built

VeilBid is a complete sealed-bid Vickrey auction running entirely on-chain with FHE. This is not a toy demo — it handles the full auction lifecycle:

- **Client-side encryption** — TFHE WebAssembly encrypts bids in the browser. The plaintext price never touches the network.
- **Two-pass FHE resolution** — A tournament bracket finds the winner and second price using 14 homomorphic operations. Zero values decrypted.
- **Vickrey settlement** — Winner pays the second-highest price. Their actual bid stays encrypted forever.
- **Graduated disclosure** — Two-tier compliance model. The market sees the settlement price. Regulators get selective access to winning bids.
- **Production frontend** — React app with MetaMask integration, real-time auction lifecycle, and live Sepolia deployment.

## The Problem Is Proven

These aren't hypothetical risks. They've happened, they're documented, and they cost real money.

### Liquidation Auctions

When lending protocols liquidate undercollateralized positions, visible bids enable collusion. On MakerDAO's Black Thursday, liquidation bots saw each other's bids and coordinated to bid $0, taking $8.3M in collateral for free. Aave, Compound, and every lending protocol with on-chain liquidation faces the same vulnerability. Confidential liquidation auctions make coordination impossible — you can't match a bid you can't see.

### OTC Block Trades

A fund holds $50M in tokens. On a DEX, slippage makes execution impossible. On an OTC desk, information leaks. Cumberland, Genesis, and Jump have all faced information leakage scandals where desk traders front-ran client orders. VeilBid replaces the trusted intermediary: seller locks tokens, bidders submit encrypted offers, best price wins. No intermediary sees the bids. No information leaks.

### Token Launch Price Discovery

In standard IDOs, whales see retail bids in the mempool and manipulate. Early bidders reveal price information to later participants. The result is always the same: insiders extract value, retail gets worse fills. VeilBid creates a level playing field — every participant bids blindly, the clearing price reflects genuine demand.

```solidity
// Any protocol can create a confidential auction in one call
auction.createAuction(
    sellToken,    // what's being sold
    bidToken,     // payment currency
    quantity,     // how much
    maxPrice,     // ceiling per unit
    reservePrice, // floor per unit
    duration,     // bidding window
    minBidders    // minimum participation
);
```

## How It Works

```
 Create        Bid           Close         Resolve         Settle        Compliance
 Auction   ->  (encrypted)  ->  (deadline)  ->  (FHE ops)   ->  (2nd price) ->  (selective)
 Seller        Bidders        Anyone         Anyone          Seller         Winner/Seller
```

**1. Create**: Seller locks tokens and sets parameters (max price, reserve, duration, min bidders).

**2. Bid**: Each bidder encrypts their price client-side using TFHE WASM in the browser, then submits a single transaction containing only ciphertext and a ZK proof. The plaintext price never touches the network. On-chain, `FHE.le` validates the encrypted bid is within the max price range.

**3. Close**: Permissionless after deadline. Below minimum bidders, the auction cancels and deposits refund automatically.

**4. Resolve Pass 1**: FHE tournament bracket. N-1 `FHE.gt` comparisons find the highest encrypted bid. No values are revealed.

**5. Resolve Pass 2**: Three operations on encrypted data:
   - **Exclusion**: Zero out only the first bid matching the max (correct tie handling via `FHE.and`/`FHE.not`/`FHE.or`)
   - **Second tournament**: N-1 comparisons on adjusted bids find the second-highest price
   - **Winner ID**: `FHE.eq` pass marks the winner, made publicly decryptable

**6. Settle**: Winner flags (`isWinner` per bid) are stored on-chain and publicly decryptable. Off-chain reads the flags to identify the winner index, then reads the decryptable settlement price. Contract verifies both via `FHE.eq`. Winner receives tokens and pays `secondPrice * quantity`. All losers get full deposits back instantly.

## Why Vickrey + FHE

In 1961, William Vickrey proved that in a sealed-bid auction where the highest bidder wins but pays the second-highest price, every bidder's optimal strategy is to bid their true value. No shading, no gaming. Better price discovery for sellers. Incentive compatibility for bidders.

**The problem**: Vickrey auctions require sealed bids, which transparent blockchains can't provide.

**Alternatives and why they fall short**:

| Approach | Limitation |
|---|---|
| **Commit-reveal** | Two-phase. Bidders can grief by refusing to reveal. Requires liveness assumptions and bond/slash mechanics. |
| **ZK proofs** | Needs a trusted coordinator to aggregate proofs. The coordinator sees the bids. |
| **Centralized server** | Single point of trust. No verifiability. Defeats the purpose of on-chain settlement. |
| **FHE (VeilBid)** | One transaction per bidder. No reveal phase, no coordinator, no liveness assumption. Contract computes on encrypted data directly. |

**The winner's actual bid stays encrypted forever.** In first-price auctions, the winning price is always public (it's the payment). In Vickrey, the payment is the second price. The winner's true valuation is never revealed on-chain. This is a strictly stronger privacy guarantee than any first-price design.

## Compliance: Two-Tier Disclosure

Most privacy projects are all-or-nothing: either everything is hidden or everything is visible. This makes them unusable for regulated finance.

VeilBid has **graduated disclosure** built into the protocol:

```
                ┌─────────────────────────────────┐
                │         PUBLIC TIER              │
                │                                  │
                │  Settlement price (2nd highest)  │
                │  Winner address                  │
                │  Auction parameters              │
                │                                  │
                │  Visible to everyone after       │
                │  settlement. This is by design.  │
                ├─────────────────────────────────┤
                │       RESTRICTED TIER            │
                │                                  │
                │  Actual winning bid              │
                │  Individual bid prices           │
                │                                  │
                │  Only visible to addresses       │
                │  granted access by the winner    │
                │  or seller.                      │
                └─────────────────────────────────┘
```

The winner or seller grants access with a single call:

```solidity
auction.revealForCompliance(auctionId, regulatorAddress);
// Regulator can now decrypt the winning bid via FHE.allow
```

**The data owner controls who sees what.** A regulator can audit the actual winning bid without exposing it to the public. The market sees the settlement price (which is the payment amount and is public by design). Individual losing bids are never revealed to anyone.

This maps directly to real-world regulatory requirements: institutions need audit trails, regulators need oversight, but neither requires broadcasting every participant's strategy to the world.

## What Makes This Hard

Most fhEVM projects use 2-3 FHE operations. VeilBid uses **14 distinct primitives** in a single contract:

| Primitive | Purpose |
|---|---|
| `FHE.fromExternal` | Convert client-encrypted input to on-chain ciphertext |
| `FHE.asEuint64`, `FHE.asEbool` | Create encrypted constants for comparison |
| `FHE.le` | Validate encrypted bid within max price |
| `FHE.gt` | Tournament bracket (both passes) |
| `FHE.eq` | Exclusion matching, winner identification, settlement verification |
| `FHE.select` | Conditional logic on encrypted data without branching |
| `FHE.and`, `FHE.or`, `FHE.not` | First-match exclusion for correct tie handling |
| `FHE.allow`, `FHE.allowThis` | ACL permissions on encrypted values |
| `FHE.makePubliclyDecryptable` | Enable off-chain reading of settlement results |

**The tournament bracket design** finds the maximum of N encrypted values using N-1 comparisons, without decrypting any individual value. This is the same algorithm used in sports brackets, adapted for homomorphic operations.

**The first-match exclusion pattern** is novel. When excluding the winner's bid from the second tournament, ties must be handled correctly. If two bidders bid the same maximum price, only one should be excluded (so the other's identical bid becomes the settlement price, which is correct Vickrey behavior). VeilBid uses a running `excluded` boolean flag with `FHE.and(isMatch, FHE.not(excluded))` to ensure deterministic first-match semantics.

**The two-pass split** is a gas optimization. Pass 1 (find max) and Pass 2 (exclude, find second, identify winner) are separate transactions. This doubles the effective gas budget and ensures both fit within block limits regardless of bidder count.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           BROWSER                                   │
│                                                                     │
│  User enters bid price (plaintext, never leaves the browser)        │
│       │                                                             │
│       ▼                                                             │
│  TFHE WASM encrypts price + generates ZK proof                     │
│  (@zama-fhe/relayer-sdk)                                           │
│       │                                                             │
│       ▼                                                             │
│  Relayer verifies ZK proof (relayer.testnet.zama.org)              │
│       │                                                             │
│       ▼                                                             │
│  Transaction sent: encrypted handle + input proof                   │
│  (plaintext price is NOT in calldata)                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      ETHEREUM SEPOLIA                               │
│                                                                     │
│  SealedAuction.sol                                                  │
│    submitBid() ─── FHE.fromExternal() ─── stores encrypted bid     │
│    resolvePass1() ─── FHE.gt tournament ─── finds encrypted max    │
│    resolvePass2() ─── exclusion + 2nd tournament + winner ID       │
│    settle() ─── FHE.eq verification ─── transfers tokens + refunds │
│    revealForCompliance() ─── FHE.allow ─── grants decryption       │
│                                                                     │
│  FHE operations executed by Zama coprocessor                        │
└─────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
contracts/
  SealedAuction.sol    Vickrey auction with two-pass FHE resolution (460 lines)
  MockERC20.sol        Standard ERC-20 for deposits and sell tokens
  DemoHelper.sol       On-chain encryption helper (local development only)

scripts/
  deploy.ts            Deploy to Hardhat or Sepolia (auto-writes frontend addresses)
  submit-bids.ts       CLI: generate wallets, encrypt bids client-side, submit to testnet

frontend/
  src/App.jsx          React UI with MetaMask + client-side FHE encryption
  src/App.css          VeilBid interface (dark theme)

test/
  SealedAuction.ts     27 tests: full lifecycle, ties, cancellation, compliance
```

## Testnet Deployment

Live on Ethereum Sepolia with real client-side FHE encryption:

| Contract | Address |
|---|---|
| SealedAuction | [`0x0F4DAe0DfCCF5Ed79b63Dd662Aa25F3150f5cb75`](https://sepolia.etherscan.io/address/0x0F4DAe0DfCCF5Ed79b63Dd662Aa25F3150f5cb75) |
| BidToken (cUSDC) | [`0x884fd7ea6F8598Df1A87D753Bb291D451AEA6726`](https://sepolia.etherscan.io/address/0x884fd7ea6F8598Df1A87D753Bb291D451AEA6726) |
| SellToken (GOV) | [`0x327044131Ee5668C4975f68E96bA20BF2B14ca57`](https://sepolia.etherscan.io/address/0x327044131Ee5668C4975f68E96bA20BF2B14ca57) |

You can verify on Etherscan that bid transactions contain only encrypted bytes in calldata. No plaintext prices.

**[Try the live frontend](https://veilbid-app.vercel.app)** — connect MetaMask on Sepolia, create an auction, and submit encrypted bids.

## Privacy Model

| Data | Visibility |
|---|---|
| Auction parameters (token, quantity, max/reserve price) | Public |
| Bidder addresses and bid count | Public |
| Deposit amount (fixed, same for all) | Public |
| **Bid prices** | **Encrypted. Never revealed on-chain.** |
| **Winning bid** | **Encrypted. Only via compliance grant.** |
| Settlement price (2nd highest) | Public after settlement |
| Winner identity | Public after settlement |

**Honest about limitations**: With only 2 bidders, the settlement price IS the loser's bid. We enforce `minBidders >= 3` and recommend higher for sensitive auctions. Winner identity leaks at Pass 2 (eq flags are publicly decryptable), not just at settlement.

## Gas Analysis

Measured with Hardhat fhEVM mock (5 bidders):

| Operation | Gas | Notes |
|---|---|---|
| `submitBid` | ~335k | Paid by bidder |
| `resolvePass1` | 297k | N-1 FHE.gt comparisons |
| `resolvePass2` | 1.29M | Exclusion + 2nd tournament + winner ID |
| `settle` | 477k | Verification + transfers + refunds |
| `revealForCompliance` | 155k | ACL grant |

Total resolve cost for 5 bidders: 1.59M gas across two transactions. Estimated practical range: 20-50 bidders on live fhEVM.

## Quick Start

```bash
# Install and run tests (local Hardhat with fhEVM mock)
npm install
npx hardhat compile
npx hardhat test

# Deploy to Sepolia
cp .env.example .env
# Add your DEPLOYER_PRIVATE_KEY to .env
npx hardhat run scripts/deploy.ts --network sepolia

# Submit encrypted bids via CLI
npx hardhat run scripts/submit-bids.ts --network sepolia

# Run the frontend
cd frontend && npm install && npm run dev
```

## Troubleshooting

**"Stack too deep" compilation error**
`viaIR: true` is required in hardhat config. Already configured.

**Relayer connection failures**
Zama's testnet relayer can be intermittent. The CLI script has retry logic (5 attempts with backoff). For the frontend, reconnect your wallet.

**"SealedAuction: deadline not reached"**
The blockchain's block timestamp hasn't crossed the deadline yet. Wait for the countdown.

**Reserve price not met on settle**
The second-highest bid is below the seller's reserve. The auction fails. Bidders call `claimRefund()`, seller calls `claimSellTokens()`.

## Built With

- [Zama fhEVM](https://docs.zama.ai/fhevm) / [@fhevm/solidity v0.11.1](https://www.npmjs.com/package/@fhevm/solidity)
- [@zama-fhe/relayer-sdk v0.4.1](https://www.npmjs.com/package/@zama-fhe/relayer-sdk) (TFHE WASM + ZK proof generation)
- [Hardhat](https://hardhat.org/) + [@fhevm/hardhat-plugin](https://www.npmjs.com/package/@fhevm/hardhat-plugin)
- React 19, Vite 8, ethers 6
- Ethereum Sepolia testnet

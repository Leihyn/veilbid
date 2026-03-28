# SealedAuction Demo Script

## Before Recording

- [ ] Hardhat node running or fhEVM devnet accessible
- [ ] Three terminal windows: **Seller**, **Bidder**, **Regulator**
- [ ] All contracts deployed (run `npx hardhat run scripts/deploy.ts`)
- [ ] Tokens minted and approved
- [ ] Screen recording at 1080p
- [ ] Test suite passes (`npx hardhat test test/SealedAuction.ts`)

---

## The Hook (15 sec)

> "On-chain auctions are broken. Every bid is a public broadcast.
> Competitors see your price. MEV bots front-run your transaction.
> Rational bidders shade below their true value — because overpaying hurts."
>
> "In 1961, William Vickrey proved there's a better way. The highest bidder wins,
> but pays the second-highest price. Everyone's best strategy is to bid their true value.
> No gaming. No shading. Better prices for sellers."
>
> "The catch: it requires sealed bids. On a transparent blockchain, that's impossible.
> Until FHE."

---

## Act 1: Create the Auction (30 sec)

> "A DAO treasury is selling 10,000 governance tokens.
> They set a max price of 10 USDC per token and a reserve of 2."

**[Do: Show the createAuction transaction in the terminal]**

```
createAuction(sellToken, bidToken, 10000, 10, 2, 3600, 3)
```

> "Every bidder will deposit the same 100,000 USDC.
> Same deposit, different encrypted bids. No information leaks from the deposit amount."

---

## Act 2: Submit Encrypted Bids (45 sec)

> "Five bidders submit bids. Watch — each transaction goes on-chain,
> but the price is FHE-encrypted. Nobody can see it."

**[Do: Submit 5 bids from different wallets. Show the encrypted input in the terminal.]**

> "Bidder 1 bids 3. Bidder 2 bids 7. Bidder 3 bids 5. Bidder 4 bids 4. Bidder 5 bids 1.
> But on-chain? All you see is five identical deposit amounts and five ciphertext blobs.
> No way to tell who bid what."

**[Do: Show the contract state — bidCount: 5, no prices visible]**

> "An observer sees five bids exist. That's it. The amounts are encrypted
> using Zama's FHE — computed on but never decrypted."

---

## Act 3: Resolution — The FHE Tournament (30 sec)

> "The auction closes. Now the contract needs to find the highest bid
> and the second-highest price. Without decrypting anything."

**[Do: Call resolvePass1. Show gas used.]**

> "Pass one: a tournament bracket. Four encrypted comparisons — FHE.gt —
> each asking 'is this bid higher than the current best?' The answer is
> an encrypted boolean. The contract never knows which bid is higher.
> It just carries the winner forward."

**[Do: Call resolvePass2. Show gas used.]**

This is the money shot. Make it land.

> "Pass two: exclude the winner's bid — encrypted. Run the tournament again
> on the remaining bids. The result is the second-highest price.
> The contract found both values using 58 FHE operations.
> Not a single bid was decrypted."

---

## Act 4: Settlement (20 sec)

> "The winner is bidder 2. They bid 7 — but they pay 5. The second price.
> That's Vickrey. The optimal strategy was to bid their true value,
> and they're rewarded for it."

**[Do: Call settle(auctionId, 1, 5). Show the transfers.]**

> "Winner gets 10,000 governance tokens. Pays 50,000 USDC. Gets 50,000 back.
> All four losers get their full 100,000 USDC deposit returned.
> Every transfer is a standard ERC-20 — no silent failures, no ambiguity."

**[Do: Show token balances before and after]**

---

## Act 5: Compliance Reveal (20 sec)

> "But here's what makes this different from just 'private auctions.'
> The market knows the settlement price: 5 per token. That's public.
> But the winner's actual bid — 7 — is still encrypted."

**[Do: Call revealForCompliance(auctionId, regulatorAddress)]**

> "The winner grants the regulator — and only the regulator — permission
> to decrypt their actual bid. FHE.allow. Scoped access. One address.
> The regulator sees 7. Nobody else does."

> "Two disclosure levels from the same auction.
> The market gets the minimum: what was paid.
> The regulator gets the full picture: what was bid.
> Privacy by default. Auditable on demand."

---

## The Close (10 sec)

> "SealedAuction. The first on-chain Vickrey auction.
> Bids are never revealed. The winner pays the second price.
> And compliance is one FHE.allow away."
>
> "Built on Zama's fhEVM. 14 FHE primitives. 27 passing tests.
> Losing bids stay encrypted forever."

---

## Total Runtime: ~2 minutes 30 seconds

---

## If Things Go Wrong

**FHE operations fail:**
Run against local Hardhat with fhEVM mocks. All FHE operations work identically in the mock.

**Gas limit exceeded on resolve:**
resolvePass1 and resolvePass2 are separate transactions. Each fits within block gas limits independently. For the demo, use 5 bidders (well within limits).

**Wrong winner index in settle:**
The FHE.eq verification flags are publicly decryptable after resolvePass2. Read them off-chain to determine the correct index before calling settle.

**Reserve price not met:**
settle will revert. For the demo, ensure at least one bid exceeds the reserve price (2 in our setup).

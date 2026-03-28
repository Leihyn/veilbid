# Vickrey, Confidentiality, and Zama: Building Sealed-Bid Auctions on Encrypted Blockchains

The US Treasury sells $2 trillion in bonds every year. Google sells $200 billion in ad placements. Telecom companies bid $100 billion for spectrum licenses. Carbon markets clear $900 billion in emission allowances.

All of them use sealed-bid auctions. All of them depend on one guarantee: nobody sees anyone else's bid.

Now picture running any of these on Ethereum. Every bid sits in plaintext calldata. Your competitors see your price before the auction closes. MEV bots front-run you. Rational participants shade their bids below their true value because overpaying hurts more than losing. The result is worse prices for sellers, worse outcomes for bidders, and a mechanism that excludes institutions entirely.

This is the gap we set out to close with VeilBid.

## The 1961 Paper That Solved Auctions

William Vickrey was an economist who spent his career thinking about incentives. In 1961, he published a paper describing an auction format where the highest bidder wins but pays the second-highest price. It sounded like a paradox. Why would a seller accept less than the winning bid?

**Because the seller gets more.** In a standard first-price auction, every bidder has an incentive to shade their bid. You don't want to pay a dollar more than necessary. So you guess what others might bid and go slightly above. This is a game of incomplete information, and the outcome is always below what bidders are actually willing to pay.

Vickrey's insight: if you decouple the winning bid from the payment, the game disappears. When the winner pays the second price, bidding your true value becomes the dominant strategy. You can't improve your outcome by bidding higher (you'd overpay) or lower (you'd risk losing). Every bidder independently arrives at honesty as their best move.

**The seller benefits because bids are higher.** No shading. True valuations flow into the auction. Price discovery improves. Vickrey won the Nobel Prize for this work in 1996.

## The Catch: Sealed Bids on Transparent Chains

Vickrey auctions only work when bids are sealed. If you can see other bids before the auction closes, the incentive structure collapses. You'd just bid one cent above the current second-highest price.

On a transparent blockchain, sealing bids is hard. Three approaches exist, and each has a fatal flaw.

**Commit-reveal** is the most common attempt. Bidders commit a hash of their bid, then reveal the plaintext in a second phase. The problem is the reveal phase. A bidder who committed a losing bid can simply refuse to reveal and walk away. You need bond-and-slash mechanics to punish this, which adds complexity and capital lockup. Worse, the reveal phase creates a new information asymmetry: the first revealer gives information to everyone who hasn't revealed yet.

**Zero-knowledge proofs** can prove properties of a bid without revealing it. But someone needs to aggregate the proofs and determine the winner. That coordinator sees the bids (or can infer them from the proof construction). You've replaced "everyone sees your bid" with "one party sees your bid." Better, but not sealed.

**Centralized servers** are what most real-world auctions use. A trusted third party collects bids and announces the winner. This works until the server is compromised, coerced, or simply cheats. It also defeats the purpose of on-chain settlement.

## FHE: Computing on Encrypted Data

Fully Homomorphic Encryption changes the equation. With FHE, you can perform computations on encrypted values without decrypting them. Add two encrypted numbers and get an encrypted result that, when decrypted, equals the sum of the plaintexts. Compare two encrypted numbers and get an encrypted boolean that tells you which is larger, without revealing either value.

This is what Zama's fhEVM brings to Solidity. Encrypted integer types (`euint64`, `ebool`) that behave like regular variables in smart contract logic. You write `FHE.gt(a, b)` and get an encrypted boolean. You write `FHE.select(condition, x, y)` and get an encrypted result. The Zama coprocessor handles the heavy cryptographic lifting off-chain and returns verified results on-chain.

The critical property for auctions: **the contract can determine which bid is highest without seeing any bid.**

## Building VeilBid

We built VeilBid to prove that a complete Vickrey auction can run on-chain with FHE. Not a toy demo. A full auction lifecycle with real encrypted bids, correct tie handling, gas-optimized resolution, and compliance-ready selective disclosure.

### Client-Side Encryption

The bid price never leaves the bidder's browser in plaintext. The frontend loads Zama's relayer-sdk, which bundles a TFHE WebAssembly module. When a bidder enters their price, the WASM module encrypts it locally and generates a zero-knowledge proof that the encryption is well-formed. The transaction sent to the chain contains only the encrypted handle and the proof. The plaintext price is not in the calldata, not in the transaction data, not anywhere on the network.

You can verify this on Etherscan. Open any `submitBid` transaction from our Sepolia deployment. The calldata is encrypted bytes. No plaintext price.

### The Tournament Bracket

Finding the maximum of N encrypted values is not trivial when you can't see any of them. We use a tournament bracket: compare bid 1 with bid 2 using `FHE.gt`, keep the winner. Compare the winner with bid 3. Keep the winner. Continue until one remains. This takes N-1 encrypted comparisons.

The result is an encrypted value that represents the highest bid. Nobody knows what it is. The contract doesn't know. The Zama coprocessor doesn't know. It's an encrypted handle that can be used in further computations.

### The Exclusion Problem

Finding the second-highest bid is harder. You can't just remove the winner and re-run the tournament, because "remove" requires knowing which bid won, which requires decryption.

Instead, we use a first-match exclusion pattern. For each bid, we check: does this bid equal the maximum? If yes, AND we haven't already excluded one, zero it out. If we've already excluded one, leave it alone. This handles ties correctly. If two bidders bid the same maximum, only one is excluded. The other's identical bid becomes the second-highest price, which is correct Vickrey behavior (the winner still pays that amount).

The running exclusion flag uses three FHE boolean operations per bid: `FHE.and(isMatch, FHE.not(excluded))` for the exclusion decision, `FHE.or(excluded, shouldExclude)` to update the flag. Entire tournament runs on encrypted data without a single decryption.

### Two-Pass Gas Optimization

FHE operations are expensive. For 5 bidders, Pass 1 (find max) costs 297k gas and Pass 2 (exclusion + second tournament + winner identification) costs 1.29M gas. Combining them in a single transaction would risk hitting block gas limits with more bidders.

Splitting into two transactions doubles the gas budget. Pass 1 stores the encrypted maximum in contract storage. Pass 2 reads it and runs the exclusion, second tournament, and winner identification. Each pass fits within block limits independently. This means the system scales to ~50 bidders even with conservative gas estimates for live FHE coprocessor costs.

### Settlement Verification

After resolution, the seller provides the winner index and second price (read from publicly decryptable values). The contract verifies both claims on-chain using `FHE.eq`: does the provided second price equal the encrypted settlement price? Does the claimed winner's bid equal the encrypted maximum? Both checks produce publicly decryptable booleans that anyone can audit.

This is not trust-the-seller. It's verify-the-seller. The FHE equality checks create an on-chain proof that the settlement is correct.

## The Compliance Question

Privacy in finance always runs into the same wall: regulators need to see things. Most privacy projects ignore this, which makes them unusable for institutional adoption.

VeilBid takes a different approach. The protocol has two disclosure tiers baked into the smart contract logic.

**The public tier** includes the settlement price (what the winner actually pays) and the winner's address. This is visible to everyone after settlement. It has to be, because tokens change hands and the payment amount is observable. This is by design, not a leak.

**The restricted tier** includes the winner's actual bid (which is higher than the settlement price, by definition of Vickrey) and any other bidder's price. These stay encrypted forever unless the data owner grants access.

The winner or seller can call `revealForCompliance(auctionId, regulatorAddress)` to grant a specific Ethereum address decryption access via `FHE.allow`. The regulator can then decrypt the winning bid. Nobody else can. The market doesn't learn anything new.

**This maps to how compliance works in traditional finance.** A regulator can subpoena trading records from a broker. The records don't become public. Other market participants don't see them. The same model, enforced cryptographically instead of legally.

## What 14 FHE Primitives Looks Like

Most fhEVM applications use 2-3 FHE operations. VeilBid uses 14 distinct primitives in a single contract: `fromExternal`, `asEuint64`, `asEbool`, `le`, `gt`, `eq`, `select`, `and`, `or`, `not`, `allow`, `allowThis`, `makePubliclyDecryptable`, plus the implicit ACL management.

This isn't complexity for its own sake. Each operation serves a specific purpose in the auction lifecycle:

- **Input validation** (`le`, `fromExternal`): ensure encrypted bids are within allowed ranges
- **Tournament** (`gt`, `select`): find maximums without decryption
- **Exclusion** (`eq`, `and`, `or`, `not`, `select`): handle ties correctly in encrypted space
- **Disclosure** (`allow`, `makePubliclyDecryptable`): graduated access control
- **Verification** (`eq`): on-chain proof of correct settlement

The depth of FHE usage matters because it demonstrates that fhEVM can support non-trivial application logic, not just encrypted balances or simple transfers.

## Where This Goes

VeilBid is infrastructure. The same sealed-bid mechanism that sells governance tokens can sell government bonds, real estate, carbon credits, spectrum licenses, or liquidated collateral. The contract doesn't care what's being auctioned. It cares that bids are encrypted, the winner is determined correctly, and disclosure is controlled.

The markets that need this are not small. Sovereign debt issuance alone is $2 trillion per year. Carbon credit auctions clear $900 billion. Ad placement auctions (Google, Meta) exceed $400 billion. These markets run on sealed bids because confidentiality is not optional. It's structural.

As these markets tokenize and move on-chain, the auction infrastructure needs to come with them. Transparent blockchains can't provide the sealed-bid guarantee. FHE can. VeilBid is the proof that it works today, end to end, on a live testnet, with real client-side encryption.

The code is open source. The contracts are deployed on Ethereum Sepolia. The tests pass. We built it because we wanted to know if a full Vickrey auction could run on fhEVM without compromises.

It can.

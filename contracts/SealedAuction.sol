// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title SealedAuction — On-chain Vickrey (second-price sealed-bid) auction on fhEVM
///
/// The highest bidder wins but pays the second-highest price. Bid prices are FHE-encrypted
/// and never revealed on-chain. The contract finds the winner and settlement price via two
/// FHE tournament passes without decrypting any individual bid.
///
/// Deposits are plaintext ERC-20 (fixed amount per bidder) to guarantee solvency.
/// The settlement price becomes public after settlement — this is by design.
/// The winning bid stays encrypted unless the winner grants compliance access.
///
/// Game theory mitigations: reserve price (anti-shill), minimum bidder count (anti-collusion),
/// one bid per address (anti-spam), fixed deposits (expensive to create shill accounts).
contract SealedAuction is ZamaEthereumConfig {

    // =========== Types ===========

    enum AuctionState {
        Open,           // Accepting bids
        Closed,         // Deadline passed, pending resolution
        ResolvedPass1,  // First tournament complete (bestPrice found)
        Resolved,       // Both passes complete (settlementPrice found)
        Settled,        // Tokens and funds transferred
        Cancelled       // Below minBidders or seller cancelled
    }

    struct Auction {
        // Configuration (set at creation)
        address seller;
        MockERC20 sellToken;
        MockERC20 bidToken;
        uint64 sellAmount;       // Plaintext — how many tokens for sale
        uint64 maxPrice;         // Plaintext — maximum bid per unit
        uint64 reservePrice;     // Plaintext — minimum acceptable second price per unit
        uint256 fixedDeposit;    // maxPrice * sellAmount — same for all bidders
        uint256 deadline;
        uint256 minBidders;      // Minimum participation for valid auction

        // State
        AuctionState state;
        uint256 bidCount;

        // Resolution results
        euint64 winningBid;      // Highest bid (encrypted — stays private)
        euint64 settlementPrice; // Second-highest bid (encrypted until settlement)
        uint256 winnerIndex;
        address winnerAddress;
        uint64 settledPrice;     // Plaintext second price (public after settlement)
    }

    struct Bid {
        address bidder;
        euint64 price;       // Encrypted bid price per unit
        bool refunded;
    }

    // =========== Storage ===========

    uint256 public nextAuctionId;
    mapping(uint256 => Auction) public auctions;
    mapping(uint256 => Bid[]) internal bids;
    mapping(uint256 => mapping(address => bool)) public hasBid;
    mapping(uint256 => mapping(address => bool)) public complianceAccess;

    // Temporary storage for split resolution
    mapping(uint256 => euint64[]) internal adjustedBids;

    // =========== Events ===========

    event AuctionCreated(uint256 indexed auctionId, address indexed seller, uint64 sellAmount, uint64 maxPrice, uint64 reservePrice, uint256 deadline);
    event BidSubmitted(uint256 indexed auctionId, uint256 bidIndex, address indexed bidder);
    event AuctionClosed(uint256 indexed auctionId, bool cancelled);
    event ResolvedPass1(uint256 indexed auctionId);
    event AuctionResolved(uint256 indexed auctionId);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint64 settlementPrice);
    event AuctionCancelled(uint256 indexed auctionId, string reason);
    event ComplianceAccessGranted(uint256 indexed auctionId, address indexed granter, address indexed regulator);
    event RefundClaimed(uint256 indexed auctionId, address indexed bidder, uint256 amount);

    // =========== Auction Creation ===========

    /// @notice Create a new Vickrey auction
    /// @param sellToken ERC-20 token being sold
    /// @param bidToken ERC-20 token used for deposits (e.g., USDC)
    /// @param sellAmount How many sellTokens are for sale
    /// @param maxPrice Maximum bid price per unit (determines fixed deposit)
    /// @param reservePrice Minimum acceptable second price per unit
    /// @param duration Auction duration in seconds
    /// @param minBidders Minimum number of bidders for the auction to resolve (recommend >= 3)
    function createAuction(
        MockERC20 sellToken,
        MockERC20 bidToken,
        uint64 sellAmount,
        uint64 maxPrice,
        uint64 reservePrice,
        uint256 duration,
        uint256 minBidders
    ) external returns (uint256 auctionId) {
        require(duration > 0, "SealedAuction: zero duration");
        require(sellAmount > 0, "SealedAuction: zero amount");
        require(maxPrice > 0, "SealedAuction: zero max price");
        require(reservePrice <= maxPrice, "SealedAuction: reserve > max");
        require(minBidders >= 2, "SealedAuction: minBidders must be >= 2");

        uint256 fixedDeposit = uint256(maxPrice) * uint256(sellAmount);

        // Lock sell tokens in the contract (reverts on insufficient balance/allowance)
        sellToken.transferFrom(msg.sender, address(this), sellAmount);

        auctionId = nextAuctionId++;
        Auction storage a = auctions[auctionId];
        a.seller = msg.sender;
        a.sellToken = sellToken;
        a.bidToken = bidToken;
        a.sellAmount = sellAmount;
        a.maxPrice = maxPrice;
        a.reservePrice = reservePrice;
        a.fixedDeposit = fixedDeposit;
        a.deadline = block.timestamp + duration;
        a.minBidders = minBidders;
        a.state = AuctionState.Open;

        emit AuctionCreated(auctionId, msg.sender, sellAmount, maxPrice, reservePrice, a.deadline);
    }

    // =========== Bidding ===========

    /// @notice Submit a sealed bid with encrypted price and plaintext deposit
    /// @param auctionId The auction to bid on
    /// @param encPrice Client-encrypted bid price per unit
    /// @param priceProof Encryption proof for the price
    function submitBid(
        uint256 auctionId,
        externalEuint64 encPrice,
        bytes calldata priceProof
    ) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.Open, "SealedAuction: not open");
        require(block.timestamp < a.deadline, "SealedAuction: deadline passed");
        require(msg.sender != a.seller, "SealedAuction: seller cannot bid");
        require(!hasBid[auctionId][msg.sender], "SealedAuction: already bid");

        // Take plaintext deposit — reverts on insufficient balance/allowance
        a.bidToken.transferFrom(msg.sender, address(this), a.fixedDeposit);

        // Process encrypted price
        euint64 price = FHE.fromExternal(encPrice, priceProof);

        // Cap at maxPrice — bids above max are zeroed (can never win)
        ebool withinMax = FHE.le(price, FHE.asEuint64(a.maxPrice));
        euint64 validPrice = FHE.select(withinMax, price, FHE.asEuint64(0));

        // ACL permissions — contract can operate on this, bidder can decrypt their own
        validPrice = FHE.allowThis(validPrice);
        FHE.allow(validPrice, msg.sender);

        // Store bid
        bids[auctionId].push(Bid({
            bidder: msg.sender,
            price: validPrice,
            refunded: false
        }));

        hasBid[auctionId][msg.sender] = true;
        a.bidCount++;

        emit BidSubmitted(auctionId, bids[auctionId].length - 1, msg.sender);
    }

    /// @notice Submit a bid from a helper contract (for demo frontend without client-side FHE)
    ///         In production, this would not exist — users encrypt client-side with fhevmjs.
    function submitBidFromHelper(
        uint256 auctionId,
        euint64 encPrice,
        address bidder
    ) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.Open, "SealedAuction: not open");
        require(block.timestamp < a.deadline, "SealedAuction: deadline passed");
        require(bidder != a.seller, "SealedAuction: seller cannot bid");
        require(!hasBid[auctionId][bidder], "SealedAuction: already bid");

        // Take deposit from the actual bidder (they must have approved this contract)
        a.bidToken.transferFrom(bidder, address(this), a.fixedDeposit);

        // Cap at maxPrice
        ebool withinMax = FHE.le(encPrice, FHE.asEuint64(a.maxPrice));
        euint64 validPrice = FHE.select(withinMax, encPrice, FHE.asEuint64(0));

        validPrice = FHE.allowThis(validPrice);
        FHE.allow(validPrice, bidder);

        bids[auctionId].push(Bid({
            bidder: bidder,
            price: validPrice,
            refunded: false
        }));

        hasBid[auctionId][bidder] = true;
        a.bidCount++;

        emit BidSubmitted(auctionId, bids[auctionId].length - 1, bidder);
    }

    // =========== Auction Close ===========

    /// @notice Close the auction after deadline — permissionless
    ///         If below minBidders, the auction is cancelled and refunds are enabled
    function closeAuction(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.Open, "SealedAuction: not open");
        require(block.timestamp >= a.deadline, "SealedAuction: deadline not reached");

        if (a.bidCount < a.minBidders) {
            a.state = AuctionState.Cancelled;
            emit AuctionCancelled(auctionId, "below minimum bidders");
        } else {
            a.state = AuctionState.Closed;
        }

        emit AuctionClosed(auctionId, a.state == AuctionState.Cancelled);
    }

    /// @notice Cancel an auction before deadline (seller only, only if no bids)
    function cancelAuction(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(msg.sender == a.seller, "SealedAuction: not seller");
        require(a.state == AuctionState.Open, "SealedAuction: not open");
        require(a.bidCount == 0, "SealedAuction: has bids");

        a.state = AuctionState.Cancelled;

        // Return sell tokens to seller
        a.sellToken.transfer(a.seller, a.sellAmount);

        emit AuctionCancelled(auctionId, "seller cancelled");
    }

    // =========== Resolution (Split into Two Passes) ===========

    /// @notice Pass 1: Find the highest encrypted bid via FHE tournament
    ///         Cost: N-1 FHE.gt + N-1 FHE.select operations
    function resolvePass1(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.Closed, "SealedAuction: not closed");

        Bid[] storage auctionBids = bids[auctionId];
        uint256 n = auctionBids.length;

        // Tournament bracket: find the maximum encrypted bid
        euint64 bestPrice = auctionBids[0].price;
        for (uint256 i = 1; i < n; i++) {
            ebool isHigher = FHE.gt(auctionBids[i].price, bestPrice);
            bestPrice = FHE.select(isHigher, auctionBids[i].price, bestPrice);
            bestPrice = FHE.allowThis(bestPrice);
        }

        // Store the winning bid (stays encrypted)
        a.winningBid = bestPrice;
        FHE.allowThis(a.winningBid);

        a.state = AuctionState.ResolvedPass1;
        emit ResolvedPass1(auctionId);
    }

    /// @notice Pass 2: Exclude the winner, find second-highest bid, identify winner
    ///         Cost: N exclusion ops (3 FHE bool each) + N-1 FHE.gt + N FHE.eq
    function resolvePass2(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.ResolvedPass1, "SealedAuction: pass 1 not done");

        Bid[] storage auctionBids = bids[auctionId];
        uint256 n = auctionBids.length;

        // === Exclusion: Zero out only the FIRST bid matching bestPrice ===
        // This handles ties correctly: if two bids are equal to bestPrice,
        // only one is excluded. The second stays for pass 2, so the
        // settlement price equals the tied price (correct Vickrey behavior).
        ebool excluded = FHE.asEbool(false);

        // Build adjusted bids array in storage for the second tournament
        delete adjustedBids[auctionId];
        for (uint256 i = 0; i < n; i++) {
            ebool isMatch = FHE.eq(auctionBids[i].price, a.winningBid);
            ebool shouldExclude = FHE.and(isMatch, FHE.not(excluded));
            excluded = FHE.or(excluded, shouldExclude);

            euint64 adjusted = FHE.select(shouldExclude, FHE.asEuint64(0), auctionBids[i].price);
            adjusted = FHE.allowThis(adjusted);
            adjustedBids[auctionId].push(adjusted);
        }

        // === Second tournament: find max of adjusted bids (= second-highest price) ===
        euint64 secondPrice = adjustedBids[auctionId][0];
        for (uint256 i = 1; i < n; i++) {
            ebool isHigher = FHE.gt(adjustedBids[auctionId][i], secondPrice);
            secondPrice = FHE.select(isHigher, adjustedBids[auctionId][i], secondPrice);
            secondPrice = FHE.allowThis(secondPrice);
        }

        a.settlementPrice = secondPrice;
        FHE.allowThis(a.settlementPrice);
        // Settlement price becomes public after settlement — this is by design
        FHE.makePubliclyDecryptable(a.settlementPrice);

        // === Winner identification: which bid equals bestPrice? ===
        // Uses same first-match pattern for deterministic tie-breaking
        ebool foundWinner = FHE.asEbool(false);
        for (uint256 i = 0; i < n; i++) {
            ebool isMatch = FHE.eq(auctionBids[i].price, a.winningBid);
            ebool isWinner = FHE.and(isMatch, FHE.not(foundWinner));
            foundWinner = FHE.or(foundWinner, isWinner);

            FHE.allowThis(isWinner);
            FHE.makePubliclyDecryptable(isWinner);
        }

        // Clean up temporary storage
        delete adjustedBids[auctionId];

        a.state = AuctionState.Resolved;
        emit AuctionResolved(auctionId);
    }

    // =========== Settlement ===========

    /// @notice Settle the auction — seller only (aligned incentives)
    /// @param auctionId The auction to settle
    /// @param winnerIndex Index of the winning bid (determined off-chain from decrypted eq flags)
    /// @param secondPrice Plaintext second-highest price (determined off-chain from decrypted settlementPrice)
    function settle(
        uint256 auctionId,
        uint256 winnerIndex,
        uint64 secondPrice
    ) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.Resolved, "SealedAuction: not resolved");
        require(msg.sender == a.seller, "SealedAuction: not seller");

        Bid[] storage auctionBids = bids[auctionId];
        require(winnerIndex < auctionBids.length, "SealedAuction: invalid index");

        // === Verify the claimed second price matches the encrypted settlement price ===
        // This check result is publicly decryptable — anyone can audit the settlement
        ebool priceCorrect = FHE.eq(FHE.asEuint64(secondPrice), a.settlementPrice);
        FHE.allowThis(priceCorrect);
        FHE.makePubliclyDecryptable(priceCorrect);

        // === Verify the claimed winner's bid matches the winning bid ===
        ebool winnerCorrect = FHE.eq(auctionBids[winnerIndex].price, a.winningBid);
        FHE.allowThis(winnerCorrect);
        FHE.makePubliclyDecryptable(winnerCorrect);

        // === Reserve price check (plaintext — can revert) ===
        require(secondPrice >= a.reservePrice, "SealedAuction: below reserve price");

        // === Settlement math (all plaintext — guaranteed correct) ===
        uint256 payment = uint256(secondPrice) * uint256(a.sellAmount);
        uint256 winnerRefund = a.fixedDeposit - payment;

        Bid storage winner = auctionBids[winnerIndex];
        a.winnerIndex = winnerIndex;
        a.winnerAddress = winner.bidder;
        a.settledPrice = secondPrice;

        // Transfer sell tokens to winner
        a.sellToken.transfer(winner.bidder, a.sellAmount);

        // Transfer payment to seller
        a.bidToken.transfer(a.seller, payment);

        // Refund winner's excess deposit
        if (winnerRefund > 0) {
            a.bidToken.transfer(winner.bidder, winnerRefund);
        }
        winner.refunded = true;

        // Refund all losers their full deposit
        for (uint256 i = 0; i < auctionBids.length; i++) {
            if (i != winnerIndex && !auctionBids[i].refunded) {
                a.bidToken.transfer(auctionBids[i].bidder, a.fixedDeposit);
                auctionBids[i].refunded = true;
            }
        }

        a.state = AuctionState.Settled;
        emit AuctionSettled(auctionId, winner.bidder, secondPrice);
    }

    // =========== Refunds (for cancelled auctions) ===========

    /// @notice Claim deposit refund from a cancelled auction
    function claimRefund(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.Cancelled, "SealedAuction: not cancelled");
        require(hasBid[auctionId][msg.sender], "SealedAuction: no bid to refund");

        // Find the bidder's bid and refund
        Bid[] storage auctionBids = bids[auctionId];
        for (uint256 i = 0; i < auctionBids.length; i++) {
            if (auctionBids[i].bidder == msg.sender && !auctionBids[i].refunded) {
                auctionBids[i].refunded = true;
                a.bidToken.transfer(msg.sender, a.fixedDeposit);
                emit RefundClaimed(auctionId, msg.sender, a.fixedDeposit);
                return;
            }
        }
        revert("SealedAuction: already refunded");
    }

    /// @notice Seller reclaims sell tokens from a cancelled auction
    function claimSellTokens(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.state == AuctionState.Cancelled, "SealedAuction: not cancelled");
        require(msg.sender == a.seller, "SealedAuction: not seller");

        // Transfer sell tokens back to seller (one-time, checked by balance)
        uint256 balance = a.sellToken.balanceOf(address(this));
        require(balance >= a.sellAmount, "SealedAuction: already claimed");
        a.sellToken.transfer(a.seller, a.sellAmount);
    }

    // =========== Compliance ===========

    /// @notice Grant a regulator permission to decrypt the actual winning bid
    ///         The market only sees the settlement price (second-highest bid).
    ///         Compliance access reveals the winner's actual bid — a stronger disclosure.
    function revealForCompliance(uint256 auctionId, address regulator) external {
        Auction storage a = auctions[auctionId];
        require(
            a.state == AuctionState.Settled || a.state == AuctionState.Resolved,
            "SealedAuction: not resolved/settled"
        );
        require(
            msg.sender == a.winnerAddress || msg.sender == a.seller,
            "SealedAuction: not authorized"
        );

        // Grant decryption access to the winning bid (the actual highest bid, not the payment)
        FHE.allow(a.winningBid, regulator);

        // Also grant access to the winner's specific bid
        FHE.allow(bids[auctionId][a.winnerIndex].price, regulator);

        // Grant access to the settlement price
        FHE.allow(a.settlementPrice, regulator);

        complianceAccess[auctionId][regulator] = true;
        emit ComplianceAccessGranted(auctionId, msg.sender, regulator);
    }

    // =========== View Functions ===========

    function getAuction(uint256 auctionId) external view returns (
        address seller,
        address sellToken,
        address bidToken,
        uint64 sellAmount,
        uint64 maxPrice,
        uint64 reservePrice,
        uint256 fixedDeposit,
        uint256 deadline,
        uint256 minBidders,
        AuctionState state,
        uint256 bidCount,
        address winnerAddress,
        uint64 settledPrice
    ) {
        Auction storage a = auctions[auctionId];
        return (
            a.seller, address(a.sellToken), address(a.bidToken),
            a.sellAmount, a.maxPrice, a.reservePrice,
            a.fixedDeposit, a.deadline, a.minBidders,
            a.state, a.bidCount, a.winnerAddress, a.settledPrice
        );
    }

    function getBidCount(uint256 auctionId) external view returns (uint256) {
        return bids[auctionId].length;
    }

    function getBidder(uint256 auctionId, uint256 bidIndex) external view returns (address) {
        return bids[auctionId][bidIndex].bidder;
    }

    /// @notice Get encrypted bid price (only accessible to bidder or ACL-permitted)
    function getBidPrice(uint256 auctionId, uint256 bidIndex) external view returns (euint64) {
        return bids[auctionId][bidIndex].price;
    }

    /// @notice Get the encrypted winning bid (only accessible via compliance grant)
    function getWinningBid(uint256 auctionId) external view returns (euint64) {
        require(
            auctions[auctionId].state >= AuctionState.ResolvedPass1,
            "SealedAuction: not resolved"
        );
        return auctions[auctionId].winningBid;
    }

    /// @notice Get the encrypted settlement price
    function getSettlementPrice(uint256 auctionId) external view returns (euint64) {
        require(
            auctions[auctionId].state >= AuctionState.Resolved,
            "SealedAuction: not fully resolved"
        );
        return auctions[auctionId].settlementPrice;
    }
}

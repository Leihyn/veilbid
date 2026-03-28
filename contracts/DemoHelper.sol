// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {SealedAuction} from "./SealedAuction.sol";

/// @title DemoHelper — Encrypts plaintext bids on-chain for the demo frontend
/// @notice In production, users encrypt client-side with fhevmjs. This helper exists
///         only because the fhEVM mock's encryption API isn't accessible from browsers.
///         It accepts plaintext prices and encrypts them on-chain before forwarding
///         to SealedAuction. DO NOT use in production — it defeats the privacy model.
contract DemoHelper is ZamaEthereumConfig {
    SealedAuction public auction;

    constructor(address _auction) {
        auction = SealedAuction(_auction);
    }

    /// @notice Submit a bid with a plaintext price (encrypted on-chain for demo)
    function submitBid(uint256 auctionId, uint64 price) external {
        euint64 encPrice = FHE.asEuint64(price);
        FHE.allow(encPrice, address(auction));
        auction.submitBidFromHelper(auctionId, encPrice, msg.sender);
    }
}

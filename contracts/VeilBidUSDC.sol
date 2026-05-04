// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @title VeilBidUSDC — confidential bid token for VeilBid auctions
///
/// Built on OpenZeppelin's audited ERC-7984 reference implementation. Balances
/// and transfers are FHE-encrypted on the Zama Protocol — observers see ciphertext
/// handles, never amounts. A bidder's cumulative auction exposure across many
/// VeilBid auctions stays private, even when the per-auction fixed deposit is
/// publicly known: balances aggregate as ciphertext.
///
/// Public mint exists for testnet/demo distribution. Production deployments
/// would replace it with a regulated minter or wrap an existing ERC-20 via
/// OpenZeppelin's ERC7984ERC20Wrapper extension.
contract VeilBidUSDC is ZamaEthereumConfig, ERC7984 {
    constructor() ERC7984("VeilBid USDC", "vbUSDC", "") {}

    /// @notice Demo/testnet mint — anyone can mint to themselves.
    function mint(address to, uint64 amount) external {
        euint64 encAmount = FHE.asEuint64(amount);
        FHE.allowThis(encAmount);
        _mint(to, encAmount);
    }
}

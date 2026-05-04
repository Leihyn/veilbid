/**
 * VeilBid seed-auction — one-command judge walkthrough.
 *
 * Creates a fresh Vickrey auction, generates 5 ephemeral bidder wallets,
 * funds them with ETH + ERC-7984 vbUSDC, sets each as a bid-token operator,
 * and submits 5 client-side-encrypted bids.
 *
 * Use after deploy.ts. Run a second time and it picks up the existing
 * deployment, finds the most recent open auction (or creates one), and
 * adds bids without re-funding wallets that already have balances.
 *
 * Usage: npx hardhat run scripts/seed-auction.ts --network sepolia
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BID_PRICES = [3n, 7n, 5n, 4n, 1n]; // bidder2 wins (price=7), settlement = 5
const SELL_AMOUNT = 10_000n;
const MAX_PRICE = 10n;
const RESERVE_PRICE = 2n;
const AUCTION_DURATION = 1800; // 30 min
const MIN_BIDDERS = 3;
const GAS_FUNDING = ethers.parseEther("0.003");

function loadAddresses() {
  const file = path.join(__dirname, "..", "frontend", "src", "contracts", "addresses.js");
  if (!fs.existsSync(file)) throw new Error(`addresses file not found: ${file}. Run deploy.ts first.`);
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/ADDRESSES\s*=\s*({[\s\S]*?});/);
  if (!m) throw new Error("could not parse addresses.js");
  return JSON.parse(m[1]);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const A = loadAddresses();

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`vbUSDC (ERC-7984):  ${A.bidToken}`);
  console.log(`SellToken:          ${A.sellToken}`);
  console.log(`SealedAuction:      ${A.auction}\n`);

  const bidToken = await ethers.getContractAt("VeilBidUSDC", A.bidToken);
  const sellToken = await ethers.getContractAt("MockERC20", A.sellToken);
  const auction = await ethers.getContractAt("SealedAuction", A.auction);

  // === Ensure an open auction exists ===
  const nextId = Number(await auction.nextAuctionId());
  let auctionId = -1;
  for (let i = nextId - 1; i >= 0; i--) {
    const info = await auction.getAuction(i);
    const block = await provider.getBlock("latest");
    if (Number(info.state) === 0 && block!.timestamp < Number(info.deadline)) {
      auctionId = i;
      console.log(`Reusing open auction #${i} (${Number(info.deadline) - block!.timestamp}s remaining)`);
      break;
    }
  }

  if (auctionId === -1) {
    console.log("No open auction — creating one...");
    const sellBal = await sellToken.balanceOf(deployer.address);
    if (sellBal < SELL_AMOUNT) {
      await (await sellToken.mint(deployer.address, SELL_AMOUNT)).wait();
    }
    await (await sellToken.approve(A.auction, SELL_AMOUNT)).wait();

    const tx = await auction.createAuction(
      A.sellToken, A.bidToken,
      SELL_AMOUNT, MAX_PRICE, RESERVE_PRICE,
      AUCTION_DURATION, MIN_BIDDERS
    );
    await tx.wait();
    auctionId = Number(await auction.nextAuctionId()) - 1;
    console.log(`Created auction #${auctionId}`);
  }

  const info = await auction.getAuction(auctionId);
  const fixedDeposit = info.fixedDeposit;
  console.log(`Bid count so far: ${await auction.getBidCount(auctionId)}`);
  console.log(`Fixed deposit (per bidder): ${fixedDeposit} vbUSDC\n`);

  // === Generate deterministic bidder wallets ===
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");

  const bidders = BID_PRICES.map((price, i) => {
    const seed = ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [deployerKey, i]));
    return { name: `Bidder${i + 1}`, wallet: new ethers.Wallet(seed, provider), price };
  });

  // === Fund + mint + setOperator ===
  console.log("=== Funding bidders + ERC-7984 setup ===");
  for (const b of bidders) {
    const ethBal = await provider.getBalance(b.wallet.address);
    if (ethBal < GAS_FUNDING / 2n) {
      await (await deployer.sendTransaction({ to: b.wallet.address, value: GAS_FUNDING })).wait();
      console.log(`${b.name}: funded with ${ethers.formatEther(GAS_FUNDING)} ETH`);
    }

    // ERC-7984 mint (idempotent — second mint just adds more)
    if (Number(await bidToken.balanceIndicator?.(b.wallet.address) ?? 0) === 0) {
      await (await bidToken.connect(deployer).mint(b.wallet.address, fixedDeposit)).wait();
      console.log(`${b.name}: minted ${fixedDeposit} vbUSDC (encrypted balance)`);
    }

    // setOperator — replaces ERC-20 approve
    if (!(await bidToken.isOperator(b.wallet.address, A.auction))) {
      await (await bidToken.connect(b.wallet).setOperator(A.auction, 2_000_000_000)).wait();
      console.log(`${b.name}: authorized auction as ERC-7984 operator`);
    }
  }
  console.log("");

  // === Init relayer-sdk for client-side encryption ===
  const { createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/node");
  const rpcUrl = (network.config as any).url || "https://ethereum-sepolia-rpc.publicnode.com";
  const instance = await createInstance({ ...SepoliaConfig, network: rpcUrl });
  console.log("FHE relayer instance ready (public key fetched)\n");

  // === Submit encrypted bids ===
  console.log("=== Submitting encrypted bids ===");
  for (const b of bidders) {
    let encrypted: any;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const enc = instance.createEncryptedInput(A.auction, b.wallet.address);
        enc.add64(b.price);
        encrypted = await enc.encrypt();
        break;
      } catch (e: any) {
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, attempt * 3000));
      }
    }
    const tx = await auction.connect(b.wallet).submitBid(
      auctionId, encrypted.handles[0], encrypted.inputProof,
      { gasLimit: 5_000_000 }
    );
    const r = await tx.wait();
    console.log(`${b.name}: encrypted bid submitted. tx=${r!.hash} gas=${r!.gasUsed}`);
  }

  console.log("\n========================================");
  console.log(`Auction #${auctionId} seeded with ${bidders.length} encrypted bids`);
  console.log("Bid prices encrypted client-side; deposits flowed through ERC-7984 (encrypted).");
  console.log("Expected outcome: Bidder2 wins (bid=7), pays settlement price 5 (Vickrey).");
  console.log("========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

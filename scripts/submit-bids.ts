/**
 * Testnet bid submission script
 *
 * Generates 3 ephemeral bidder wallets, funds them with ETH + MockUSDC from the deployer,
 * then encrypts bid prices client-side via fhEVM relayer-sdk and submits them on-chain.
 *
 * Usage: npx hardhat run scripts/submit-bids.ts --network sepolia
 */

import { ethers, network } from "hardhat";

// Deployed contract addresses (Sepolia)
const ADDRESSES = {
  bidToken: "0xaA14364aDc5A7BCCfd464d608B77b684cb75949C",
  sellToken: "0xe7E2F0688E4C96C03d49F65A97A69a9C954e75B2",
  auction: "0xe811BB16011d730FF663349B6fA81041605755F2",
};

const BID_PRICES = [3n, 7n, 5n]; // bidder1=3, bidder2=7(winner), bidder3=5(second price)
const GAS_FUNDING = ethers.parseEther("0.003"); // ETH per bidder for gas
const AUCTION_DURATION = 1800; // 30 minutes

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(deployer.address)), "ETH");
  console.log("Network:", network.name);
  console.log("");

  // Get contract instances
  const bidToken = await ethers.getContractAt("MockERC20", ADDRESSES.bidToken);
  const sellToken = await ethers.getContractAt("MockERC20", ADDRESSES.sellToken);
  const auction = await ethers.getContractAt("SealedAuction", ADDRESSES.auction);

  // Find or create an open auction with time remaining
  let auctionId: number;
  const nextId = Number(await auction.nextAuctionId());

  // Check existing auctions for one that's still open with time remaining
  let foundOpen = false;
  for (let i = nextId - 1; i >= 0; i--) {
    const info = await auction.getAuction(i);
    const block = await provider.getBlock("latest");
    if (Number(info.state) === 0 && block!.timestamp < Number(info.deadline)) {
      auctionId = i;
      foundOpen = true;
      console.log(`Found open auction #${i} with ${Number(info.deadline) - block!.timestamp}s remaining`);
      break;
    }
  }

  if (!foundOpen) {
    console.log("No open auction with time remaining. Creating a new one...");

    // Ensure deployer has sell tokens
    const sellBal = await sellToken.balanceOf(deployer.address);
    if (sellBal < 10000n) {
      console.log("Minting SELL tokens to deployer...");
      await (await sellToken.mint(deployer.address, 10000)).wait();
    }

    // Approve auction contract
    console.log("Approving auction for SELL tokens...");
    await (await sellToken.approve(ADDRESSES.auction, 10000)).wait();

    // Create auction
    console.log(`Creating auction (duration=${AUCTION_DURATION}s = ${AUCTION_DURATION / 60}min)...`);
    const tx = await auction.createAuction(
      ADDRESSES.sellToken,
      ADDRESSES.bidToken,
      10000,  // sellAmount
      10,     // maxPrice
      2,      // reservePrice
      AUCTION_DURATION,
      3       // minBidders
    );
    await tx.wait();
    auctionId = Number(await auction.nextAuctionId()) - 1;
    console.log(`Auction #${auctionId} created!`);
  }

  const info = await auction.getAuction(auctionId!);
  console.log("\nAuction state:", Number(info.state), "(0=Open)");
  console.log("Max price:", info.maxPrice.toString());
  console.log("Fixed deposit:", info.fixedDeposit.toString(), "USDC");
  console.log("Bid count:", (await auction.getBidCount(auctionId!)).toString());
  const block = await provider.getBlock("latest");
  console.log("Time remaining:", Number(info.deadline) - block!.timestamp, "seconds");
  console.log("");

  const fixedDeposit = info.fixedDeposit;
  const AUCTION_ID = auctionId!;

  // Derive deterministic bidder wallets from deployer key so we don't waste ETH on reruns
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY!;
  const bidders = BID_PRICES.map((price, i) => {
    const seed = ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [deployerKey, i]));
    const wallet = new ethers.Wallet(seed, provider);
    return { name: `Bidder${i + 1}`, wallet, price };
  });

  console.log("=== Generated Bidder Wallets ===");
  for (const b of bidders) {
    console.log(`${b.name}: ${b.wallet.address} (bid price: ${b.price})`);
  }
  console.log("");

  // Fund bidders with ETH for gas (skip if already funded)
  console.log("=== Funding Bidders with ETH ===");
  for (const b of bidders) {
    const bal = await provider.getBalance(b.wallet.address);
    if (bal >= GAS_FUNDING / 2n) {
      console.log(`${b.name} already has ${ethers.formatEther(bal)} ETH — skipping`);
      continue;
    }
    const tx = await deployer.sendTransaction({
      to: b.wallet.address,
      value: GAS_FUNDING,
    });
    await tx.wait();
    console.log(`Sent ${ethers.formatEther(GAS_FUNDING)} ETH to ${b.name}`);
  }
  console.log("");

  // Mint MockUSDC to bidders (skip if already have enough)
  console.log("=== Minting USDC to Bidders ===");
  for (const b of bidders) {
    const usdcBal = await bidToken.balanceOf(b.wallet.address);
    if (usdcBal >= fixedDeposit) {
      console.log(`${b.name} already has ${usdcBal} USDC — skipping`);
      continue;
    }
    const tx = await bidToken.connect(deployer).mint(b.wallet.address, fixedDeposit);
    await tx.wait();
    console.log(`Minted ${fixedDeposit} USDC to ${b.name}`);
  }
  console.log("");

  // Approve auction contract from each bidder (skip if already approved)
  console.log("=== Approving Auction Contract ===");
  for (const b of bidders) {
    const allowance = await bidToken.allowance(b.wallet.address, ADDRESSES.auction);
    if (allowance >= fixedDeposit) {
      console.log(`${b.name} already approved — skipping`);
      continue;
    }
    const tx = await bidToken.connect(b.wallet).approve(ADDRESSES.auction, fixedDeposit);
    await tx.wait();
    console.log(`${b.name} approved auction for ${fixedDeposit} USDC`);
  }
  console.log("");

  // Initialize fhEVM relayer-sdk for client-side encryption
  console.log("=== Initializing FHE Encryption ===");
  const { createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/node");

  const rpcUrl = (network.config as any).url || "https://ethereum-sepolia-rpc.publicnode.com";
  const instance = await createInstance({
    ...SepoliaConfig,
    network: rpcUrl,
  });
  console.log("FHE instance ready (public key fetched from relayer)");
  console.log("");

  // Submit encrypted bids (with retry for flaky relayer connections)
  console.log("=== Submitting Encrypted Bids ===");
  for (const b of bidders) {
    let encrypted: any;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        console.log(`${b.name}: encrypting price=${b.price} client-side (attempt ${attempt})...`);
        const encInput = instance.createEncryptedInput(
          ADDRESSES.auction,
          b.wallet.address
        );
        encInput.add64(b.price);
        encrypted = await encInput.encrypt();
        console.log(`${b.name}: encryption + ZK proof verified by relayer`);
        break;
      } catch (e: any) {
        console.log(`${b.name}: relayer error (attempt ${attempt}/5): ${e.message?.slice(0, 100)}`);
        if (attempt === 5) throw e;
        const delay = attempt * 3000;
        console.log(`Retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    console.log(`${b.name}: submitting encrypted bid to chain...`);
    const tx = await auction.connect(b.wallet).submitBid(
      AUCTION_ID,
      encrypted.handles[0],
      encrypted.inputProof,
      { gasLimit: 5_000_000 }
    );
    const receipt = await tx.wait();
    console.log(`${b.name}: bid submitted! tx=${receipt!.hash} gas=${receipt!.gasUsed}`);
    console.log("");
  }

  const bidCount = await auction.getBidCount(AUCTION_ID);
  console.log("========================================");
  console.log(`All bids submitted. Total bids: ${bidCount}`);
  console.log("Bid prices: [3, 7, 5] — encrypted client-side, never in calldata");
  console.log("Expected winner: Bidder2 (price=7), settlement price: 5 (Bidder3)");
  console.log("========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

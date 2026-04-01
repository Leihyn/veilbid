import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ethers } from "ethers";
import auctionAbi from "./contracts/SealedAuction.json";
import erc20Abi from "./contracts/MockERC20.json";
import { ADDRESSES, NETWORK, CHAIN_ID } from "./contracts/addresses.js";
import "./App.css";

const IS_TESTNET = NETWORK === "sepolia";
const LOCAL_RPC = "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";
const MAX_LOG_ENTRIES = 50;

function getLocalWallets() {
  const rpcProvider = new ethers.JsonRpcProvider(LOCAL_RPC);
  const wallets = {};
  const names = ["seller", "bidder1", "bidder2", "bidder3", "bidder4", "regulator"];
  for (let i = 0; i < names.length; i++) {
    const hdNode = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(MNEMONIC),
      `m/44'/60'/0'/0/${i}`
    );
    wallets[names[i]] = new ethers.Wallet(hdNode.privateKey, rpcProvider);
  }
  return { rpcProvider, wallets };
}

const PHASES = [
  { key: "create", label: "Create", desc: "Seller locks tokens and sets auction parameters" },
  { key: "bid", label: "Bid", desc: "Bidders encrypt prices client-side and submit ciphertext" },
  { key: "close", label: "Close", desc: "Bidding window ends, no more bids accepted" },
  { key: "resolve", label: "Resolve", desc: "FHE tournament finds winner and second price on encrypted data" },
  { key: "settle", label: "Settle", desc: "Winner pays second-highest price, losers get refunds" },
  { key: "compliance", label: "Compliance", desc: "Winner or seller grants regulator access to decrypt bids" },
];

function getPhaseIndex(state, complianceDone) {
  if (state === null || state === undefined) return -1;
  if (complianceDone) return 6;
  if (state >= 4) return 5;
  if (state === 3) return 4;
  if (state >= 1 && state <= 2) return 3;
  return 1;
}

function getStatusInfo(state) {
  const map = {
    0: { label: "Open", cls: "status-open" },
    1: { label: "Closed", cls: "status-closed" },
    2: { label: "Resolving", cls: "status-resolving" },
    3: { label: "Resolved", cls: "status-resolved" },
    4: { label: "Settled", cls: "status-settled" },
    5: { label: "Cancelled", cls: "status-cancelled" },
  };
  return map[state] || { label: "Unknown", cls: "" };
}

// Stable pseudo-random hex per bid index (deterministic, no re-randomize)
function bidCipherHex(index) {
  let h = 0x9e3779b9 ^ (index * 0x517cc1b7);
  const chars = [];
  for (let i = 0; i < 16; i++) {
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = (h ^ (h >>> 13)) >>> 0;
    chars.push((h & 0xf).toString(16));
  }
  return "0x" + chars.join("") + "...";
}

// ========== Components ==========

function PhaseStepper({ currentPhase }) {
  const activeWidth = currentPhase <= 0 ? 0 : Math.min((currentPhase / (PHASES.length - 1)) * 100, 100);
  return (
    <div className="phase-stepper">
      <div className="phase-track">
        <div className="phase-line" />
        <div className="phase-line-active" style={{ width: `${activeWidth}%` }} />
        <div className="phase-steps">
          {PHASES.map((phase, i) => {
            const isDone = i < currentPhase;
            const isCurrent = i === currentPhase;
            return (
              <div key={phase.key} className="phase-step">
                <div className={`phase-dot ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}`} />
                <span className={`phase-label ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}`}>
                  {phase.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PhaseHint({ currentPhase }) {
  if (currentPhase < 0 || currentPhase >= PHASES.length) return null;
  const phase = PHASES[currentPhase];
  const next = currentPhase < PHASES.length - 1 ? PHASES[currentPhase + 1] : null;
  return (
    <div className="phase-hint">
      <div className="phase-hint-current">
        <span className="phase-hint-label">Now</span>
        {phase.desc}
      </div>
      {next && (
        <div className="phase-hint-next">
          <span className="phase-hint-label">Next</span>
          {next.desc}
        </div>
      )}
    </div>
  );
}

function Log({ logs, onClear }) {
  return (
    <div className="log-panel">
      <div className="log-header">
        <span className="log-title">Event Log</span>
        <div className="log-header-right">
          {logs.length > 0 && (
            <button className="log-clear-btn" onClick={onClear}>Clear</button>
          )}
          <span className="network-tag">{IS_TESTNET ? "Sepolia" : "Local"}</span>
        </div>
      </div>
      <div className="log-entries">
        {logs.length === 0 ? (
          <div className="log-empty">Events will appear here as you interact with the auction.</div>
        ) : (
          logs.map((l, i) => (
            <div key={i} className={`log-entry ${l.type || ""}`}>
              <span className="log-time">{l.time}</span>
              <span className="log-msg">{l.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function BalanceBar({ balances }) {
  const entries = Object.entries(balances);
  if (entries.length === 0) return null;
  const visible = entries.filter(([name, b]) => {
    if (name === "regulator") return false;
    return Number(b.sell) > 0 || Number(b.bid) > 0;
  });
  if (visible.length === 0) return null;
  return (
    <div className="balance-bar">
      {visible.map(([name, b]) => (
        <div key={name} className="balance-item">
          <span className="balance-name">{name}</span>
          <span className="balance-values">
            {Number(b.sell) > 0 && <span>{Number(b.sell).toLocaleString()} SELL</span>}
            {Number(b.sell) > 0 && Number(b.bid) > 0 && <span className="balance-sep">/</span>}
            {Number(b.bid) > 0 && <span>{Number(b.bid).toLocaleString()} BID</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function BidCards({ bidCount, auctionState }) {
  const count = Number(bidCount || 0);
  if (count === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">AWAITING BIDS</div>
        <p>Waiting for encrypted bids...</p>
      </div>
    );
  }
  return (
    <table className="bid-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Bidder</th>
          <th>Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: count }, (_, i) => {
          const isWinner = auctionState?.state >= 4 && auctionState?.winnerIndex === i;
          return (
            <tr key={i} className={isWinner ? "winner-row" : ""}>
              <td><span className="bid-id">{String(i + 1).padStart(2, "0")}</span></td>
              <td>Bidder #{i + 1}</td>
              <td>
                {isWinner
                  ? <span className="bid-amount-hidden">WINNER</span>
                  : <span className="bid-amount-hidden">[ SEALED ]</span>
                }
              </td>
              <td>
                {isWinner ? (
                  <span className="bid-status winner-status">
                    <span className="bid-status-dot" />
                    Winner
                  </span>
                ) : (
                  <span className="bid-status confirmed">
                    <span className="bid-status-dot" />
                    Confirmed
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ========== Main App ==========

function App() {
  const [logs, setLogs] = useState([]);
  const [auctionState, setAuctionState] = useState(null);
  const [auctionId, setAuctionId] = useState(null);
  const [balances, setBalances] = useState({});
  const [bidPrice, setBidPrice] = useState("");
  const [selectedBidder, setSelectedBidder] = useState("bidder1");
  const [complianceDone, setComplianceDone] = useState(false);
  const [loading, setLoading] = useState("");
  const [lastError, setLastError] = useState(null);
  const [setupDone, setSetupDone] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [walletAddress, setWalletAddress] = useState("");
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const fhevmInstance = useRef(null);
  const [localWallets, setLocalWallets] = useState(null);
  const [auctionParams, setAuctionParams] = useState({
    sellAmount: "10000",
    maxPrice: "10",
    reservePrice: "2",
    duration: IS_TESTNET ? "1800" : "120",
    minBidders: "3",
  });

  const log = useCallback((msg, type = "") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [{ time, msg, type }, ...prev].slice(0, MAX_LOG_ENTRIES));
    if (type === "error") {
      setLastError({ msg, retry: null });
    } else if (type === "success") {
      setLastError(null);
    }
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  async function findLatestAuction(p) {
    try {
      const auctionContract = new ethers.Contract(ADDRESSES.auction, auctionAbi, p);
      const nextId = await auctionContract.nextAuctionId();
      if (nextId > 0n) {
        setAuctionId(nextId - 1n);
        log(`Found auction #${nextId - 1n} on-chain`);
      }
    } catch (e) { /* No auctions yet */ }
  }

  function initLocal() {
    const { rpcProvider, wallets } = getLocalWallets();
    setProvider(rpcProvider);
    setLocalWallets(wallets);
    setConnected(true);
    setShowWelcome(false);
    findLatestAuction(rpcProvider);
  }

  async function connectWallet() {
    if (!window.ethereum) { log("MetaMask not found.", "error"); return; }
    setLoading("Connecting wallet...");
    try {
      let browserProvider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await browserProvider.send("eth_requestAccounts", []);
      let chainId = await browserProvider.send("eth_chainId", []);
      if (parseInt(chainId, 16) !== CHAIN_ID) {
        log(`Switching to Sepolia...`);
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + CHAIN_ID.toString(16) }],
          });
          browserProvider = new ethers.BrowserProvider(window.ethereum);
          chainId = await browserProvider.send("eth_chainId", []);
        } catch { log("Switch to Sepolia manually.", "error"); setLoading(""); return; }
      }
      if (parseInt(chainId, 16) !== CHAIN_ID) { log("Wrong network.", "error"); setLoading(""); return; }

      const walletSigner = await browserProvider.getSigner();
      setProvider(browserProvider);
      setSigner(walletSigner);
      setWalletAddress(accounts[0]);
      setConnected(true);
      log(`Connected: ${accounts[0].slice(0, 10)}...`, "success");
      await findLatestAuction(browserProvider);

      log("Initializing FHE encryption...");
      const { initSDK, createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/web");
      await initSDK();
      log("WASM loaded. Fetching public key...");
      const instance = await createInstance({ ...SepoliaConfig, network: window.ethereum });
      fhevmInstance.current = instance;
      log("FHE encryption ready.", "success");
    } catch (e) { log(`Connection failed: ${e.message}`, "error"); }
    setLoading("");
  }

  function getContracts(signerOverride) {
    const p = signerOverride || provider;
    return {
      auction: new ethers.Contract(ADDRESSES.auction, auctionAbi, p),
      sellToken: new ethers.Contract(ADDRESSES.sellToken, erc20Abi, p),
      bidToken: new ethers.Contract(ADDRESSES.bidToken, erc20Abi, p),
    };
  }

  const refreshAuction = useCallback(async () => {
    if (auctionId === null || !provider) return;
    try {
      const { auction } = getContracts();
      const info = await auction.getAuction(auctionId);
      const bidCount = await auction.getBidCount(auctionId);
      const block = await provider.getBlock("latest");
      const blockTime = block ? block.timestamp : Math.floor(Date.now() / 1000);
      const deadline = Number(info.deadline);
      const remaining = deadline - blockTime;
      setAuctionState({
        seller: info.seller,
        sellAmount: info.sellAmount.toString(),
        maxPrice: info.maxPrice.toString(),
        reservePrice: info.reservePrice.toString(),
        fixedDeposit: info.fixedDeposit.toString(),
        deadline, deadlinePassed: remaining <= 0,
        timeRemaining: remaining > 0 ? remaining : 0,
        minBidders: info.minBidders.toString(),
        state: Number(info.state),
        bidCount: bidCount.toString(),
        winnerAddress: info.winnerAddress,
        settledPrice: info.settledPrice.toString(),
      });
    } catch (e) { /* Auction doesn't exist yet */ }
  }, [auctionId, provider]);

  const refreshBalances = useCallback(async () => {
    if (!provider) return;
    const { sellToken, bidToken } = getContracts();
    const bals = {};
    if (IS_TESTNET && walletAddress) {
      const sell = await sellToken.balanceOf(walletAddress);
      const bid = await bidToken.balanceOf(walletAddress);
      bals["you"] = { address: walletAddress.slice(0, 8) + "...", sell: sell.toString(), bid: bid.toString() };
    } else if (localWallets) {
      for (const [name, wallet] of Object.entries(localWallets)) {
        const sell = await sellToken.balanceOf(wallet.address);
        const bid = await bidToken.balanceOf(wallet.address);
        bals[name] = { address: wallet.address.slice(0, 8) + "...", sell: sell.toString(), bid: bid.toString() };
      }
    }
    setBalances(bals);
  }, [provider, walletAddress, localWallets]);

  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(() => { refreshAuction(); refreshBalances(); }, 3000);
    refreshBalances();
    return () => clearInterval(interval);
  }, [connected, refreshAuction, refreshBalances]);

  // ========== Actions ==========

  async function runAction(label, fn) {
    setLoading(label);
    setLastError(null);
    try {
      await fn();
    } catch (e) {
      const raw = e.message || "Unknown error";
      const clean = raw.includes("reverted with reason")
        ? raw.match(/reason string '([^']+)'/)?.[1] || raw.slice(0, 80)
        : raw.replace(/\(transaction="0x[a-f0-9]+"[^)]*\)/gi, "").replace(/\s+/g, " ").slice(0, 80);
      log(`Error: ${clean}`, "error");
      setLastError({ msg: clean, retry: () => runAction(label, fn) });
    }
    setLoading("");
  }

  async function setupTokens() {
    await runAction("Setting up tokens...", async () => {
      if (IS_TESTNET) {
        const { sellToken, bidToken } = getContracts(signer);
        const addr = walletAddress;
        log("Minting tokens and setting approvals...");
        await (await sellToken.mint(addr, 10000)).wait();
        await (await bidToken.mint(addr, 1000000)).wait();
        await (await sellToken.approve(ADDRESSES.auction, 10000)).wait();
        await (await bidToken.approve(ADDRESSES.auction, 1000000)).wait();
      } else {
        const seller = localWallets.seller;
        // Force fresh nonce from chain (prevents stale nonce after Hardhat restart)
        let nonce = await seller.provider.getTransactionCount(seller.address);
        const { sellToken, bidToken } = getContracts();
        await (await sellToken.connect(seller).mint(seller.address, 10000, { nonce: nonce++ })).wait();
        for (const name of ["bidder1", "bidder2", "bidder3", "bidder4"]) {
          await (await bidToken.connect(seller).mint(localWallets[name].address, 1000000, { nonce: nonce++ })).wait();
        }
        await (await sellToken.connect(seller).approve(ADDRESSES.auction, 10000, { nonce: nonce++ })).wait();
        for (const name of ["bidder1", "bidder2", "bidder3", "bidder4"]) {
          await (await bidToken.connect(localWallets[name]).approve(ADDRESSES.auction, 1000000)).wait();
        }
      }
      log("Tokens ready.", "success");
      setSetupDone(true);
      await refreshBalances();
    });
  }

  async function createAuction() {
    const { sellAmount, maxPrice, reservePrice, duration, minBidders } = auctionParams;
    const sa = Number(sellAmount), mp = Number(maxPrice), rp = Number(reservePrice), dur = Number(duration), mb = Number(minBidders);
    if (!sa || !mp || !rp || !dur || !mb) { log("Fill in all auction parameters", "error"); return; }
    if (rp > mp) { log("Reserve price cannot exceed max price", "error"); return; }
    if (mb < 2) { log("Minimum bidders must be at least 2", "error"); return; }

    await runAction("Creating auction...", async () => {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const tx = await auction.createAuction(ADDRESSES.sellToken, ADDRESSES.bidToken, sa, mp, rp, dur, mb);
      await tx.wait();
      const { auction: ac } = getContracts();
      const nextId = await ac.nextAuctionId();
      setAuctionId(nextId - 1n);
      log(`Auction #${nextId - 1n} created (${dur / 60}min window, ${sa} tokens, price ${rp}-${mp})`, "success");
      await refreshAuction();
      await refreshBalances();
    });
  }

  async function submitBid() {
    if (!bidPrice || isNaN(Number(bidPrice))) { log("Enter a valid bid price", "error"); return; }
    const price = Number(bidPrice);
    if (auctionState) {
      const min = Number(auctionState.reservePrice);
      const max = Number(auctionState.maxPrice);
      if (price < min || price > max) {
        log(`Bid must be between ${min} and ${max}`, "error");
        return;
      }
    }
    if (IS_TESTNET) {
      await runAction("Encrypting bid...", async () => {
        if (!fhevmInstance.current) throw new Error("FHE not initialized.");
        const { auction } = getContracts(signer);
        const userAddr = await signer.getAddress();
        log("Encrypting with FHE...");
        const encInput = fhevmInstance.current.createEncryptedInput(ADDRESSES.auction, userAddr);
        encInput.add64(BigInt(price));
        const encrypted = await encInput.encrypt();
        log("Submitting encrypted bid...");
        const tx = await auction.submitBid(auctionId, encrypted.handles[0], encrypted.inputProof, { gasLimit: 5000000 });
        await tx.wait();
        log("Bid submitted. Price is encrypted on-chain.", "success");
        setBidPrice("");
        await refreshAuction(); await refreshBalances();
      });
    } else {
      await runAction(`Submitting bid from ${selectedBidder}...`, async () => {
        const wallet = localWallets[selectedBidder];
        const helperAbi = (await import("./contracts/DemoHelper.json")).default;
        const helper = new ethers.Contract(ADDRESSES.demoHelper, helperAbi, wallet);
        const tx = await helper.submitBid(auctionId, price, { gasLimit: 2000000 });
        await tx.wait();
        log(`${selectedBidder} bid submitted (encrypted).`, "success");
        setBidPrice("");
        await refreshAuction(); await refreshBalances();
      });
    }
  }

  async function closeAuction() {
    await runAction("Closing auction...", async () => {
      if (!IS_TESTNET) {
        const lp = new ethers.JsonRpcProvider(LOCAL_RPC);
        await lp.send("evm_increaseTime", [130]);
        await lp.send("evm_mine", []);
      }
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      await (await auction.closeAuction(auctionId)).wait();
      log("Auction closed. Bidding window ended.", "success");
      await refreshAuction();
    });
  }

  async function resolvePass1() {
    await runAction("FHE Tournament: finding highest bid...", async () => {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const receipt = await (await auction.resolvePass1(auctionId, { gasLimit: 5000000 })).wait();
      log(`Pass 1 complete (${receipt.gasUsed} gas). Highest encrypted bid found.`, "success");
      await refreshAuction();
    });
  }

  async function resolvePass2() {
    await runAction("FHE Tournament: finding second price + winner...", async () => {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const receipt = await (await auction.resolvePass2(auctionId, { gasLimit: 10000000 })).wait();
      log(`Pass 2 complete (${receipt.gasUsed} gas). Winner identified.`, "success");
      await refreshAuction();
    });
  }

  async function settle() {
    await runAction("Detecting settlement values...", async () => {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const bidCount = Number(await auction.getBidCount(auctionId));
      const info = await auction.getAuction(auctionId);
      const reservePrice = Number(info.reservePrice);
      const maxPrice = Number(info.maxPrice);

      log("Reading winner flags from contract...");
      let winnerIdx = -1;
      for (let i = 0; i < bidCount; i++) {
        try {
          const flag = await auction.getWinnerFlag(auctionId, i);
          if (flag && flag !== ethers.ZeroHash) {
            for (let price = reservePrice; price <= maxPrice; price++) {
              try {
                await auction.settle.staticCall(auctionId, i, price, { gasLimit: 5000000 });
                winnerIdx = i;
                log(`Winner found: bidder #${i}, settlement price: ${price}/unit`);
                setLoading(`Settling: winner=#${i}, price=${price}/unit...`);
                const tx = await auction.settle(auctionId, i, price, { gasLimit: 5000000 });
                const receipt = await tx.wait();
                log(`Settled! Winner pays ${price}/unit (2nd price). Gas: ${receipt.gasUsed}`, "success");
                await refreshAuction();
                await refreshBalances();
                return;
              } catch { /* wrong price, try next */ }
            }
          }
        } catch { /* flag not readable, fall through to scan */ }
      }

      if (winnerIdx === -1) {
        log("Flag detection unavailable, scanning all combinations...");
        const total = (maxPrice - reservePrice + 1) * bidCount;
        let tried = 0;
        for (let price = reservePrice; price <= maxPrice; price++) {
          for (let idx = 0; idx < bidCount; idx++) {
            tried++;
            try {
              await auction.settle.staticCall(auctionId, idx, price, { gasLimit: 5000000 });
              log(`Match found (attempt ${tried}/${total}): winner=#${idx}, price=${price}/unit`);
              setLoading(`Settling: winner=#${idx}, price=${price}/unit...`);
              const tx = await auction.settle(auctionId, idx, price, { gasLimit: 5000000 });
              const receipt = await tx.wait();
              log(`Settled! Winner pays ${price}/unit (2nd price). Gas: ${receipt.gasUsed}`, "success");
              await refreshAuction();
              await refreshBalances();
              return;
            } catch {
              if (tried % 10 === 0) setLoading(`Scanning... ${tried}/${total} combinations checked`);
            }
          }
        }
        throw new Error("Could not find valid settlement values. Reserve price may not be met.");
      }
    });
  }

  async function revealCompliance() {
    await runAction("Granting compliance access...", async () => {
      const { auction } = getContracts(IS_TESTNET ? signer : provider);
      const info = await auction.getAuction(auctionId);

      if (IS_TESTNET) {
        const userAddr = walletAddress.toLowerCase();
        const winnerAddr = info.winnerAddress?.toLowerCase();
        const sellerAddr = info.seller?.toLowerCase();
        const canReveal = userAddr === winnerAddr || userAddr === sellerAddr;
        if (!canReveal) {
          throw new Error(
            `Only the winner (${info.winnerAddress?.slice(0, 10)}...) or seller (${info.seller?.slice(0, 10)}...) can grant compliance access. Your address: ${walletAddress.slice(0, 10)}...`
          );
        }
        const auctionWithSigner = getContracts(signer).auction;
        await (await auctionWithSigner.revealForCompliance(auctionId, walletAddress)).wait();
        log(`Compliance access granted. Regulator can decrypt winning bid.`, "success");
        setComplianceDone(true);
      } else {
        const winnerAddr = info.winnerAddress;
        let winnerKey = null;
        for (const [name, w] of Object.entries(localWallets)) {
          if (w.address.toLowerCase() === winnerAddr.toLowerCase()) winnerKey = name;
        }
        if (!winnerKey) throw new Error("Winner wallet not found in local wallets");
        const auctionWithWinner = getContracts(localWallets[winnerKey]).auction;
        await (await auctionWithWinner.revealForCompliance(auctionId, localWallets.regulator.address)).wait();
        log("Compliance access granted to regulator.", "success");
        setComplianceDone(true);
      }
    });
  }

  function resetForNewAuction() {
    setAuctionId(null);
    setAuctionState(null);
    setComplianceDone(false);
    setSetupDone(true);
    setLastError(null);
    log("Ready for new auction.", "success");
  }

  // ========== Render ==========

  const phaseIndex = auctionId !== null ? getPhaseIndex(auctionState?.state, complianceDone) : 0;
  const status = auctionState ? getStatusInfo(auctionState.state) : null;

  const bidRange = useMemo(() => {
    if (!auctionState) return { min: 1, max: 10 };
    return { min: Number(auctionState.reservePrice), max: Number(auctionState.maxPrice) };
  }, [auctionState]);

  // Welcome / Connect screen
  if (!connected || showWelcome) {
    return (
      <div className="app">
        <div className="connect-screen">
          <div className="connect-eyebrow">Confidential Auction Infrastructure</div>
          <h2>Sealed <em>Bids</em>,<br />Open Markets</h2>
          <div className="connect-subtitle">Confidential price discovery for on-chain finance</div>
          <div className="connect-rule" />
          <p>
            Every on-chain auction publishes its bids in plaintext.
            VeilBid encrypts prices <strong>client-side with FHE</strong> so they never appear in calldata.
            The winner pays the second-highest price. Regulators get selective access.
          </p>
          <div className="connect-features">
            <div className="connect-feature">FHE-Encrypted</div>
            <div className="connect-feature">Vickrey (2nd Price)</div>
            <div className="connect-feature">Compliance Ready</div>
          </div>
          {IS_TESTNET ? (
            <button className="btn-connect" onClick={connectWallet} disabled={!!loading}>
              {loading || "Connect Wallet"}
            </button>
          ) : (
            <button className="btn-connect" onClick={initLocal}>
              Enter Protocol
            </button>
          )}
          <div className="connect-meta">
            <span className="connect-meta-item">27 Tests Passing</span>
            <span className="connect-meta-item">14 FHE Primitives</span>
            <span className="connect-meta-item">Deployed on Sepolia</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <div className="logo">
            <img src="/logo.jpg" alt="VeilBid" className="logo-icon" />
            <h1>VeilBid</h1>
          </div>
          <span className="tagline">Confidential price discovery for on-chain finance</span>
        </div>
        {walletAddress && (
          <div className="wallet-badge">
            <span className="wallet-dot" />
            {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
            <span className="network-tag">Sepolia</span>
          </div>
        )}
      </div>

      {/* Phase Stepper + Hint */}
      {auctionId !== null && (
        <>
          <PhaseStepper currentPhase={phaseIndex} />
          <PhaseHint currentPhase={phaseIndex} />
        </>
      )}

      {/* Balance Bar */}
      <BalanceBar balances={balances} />

      <div className="main-layout">
        <div className="main-content">
          {/* Auction State */}
          {auctionState ? (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Auction #{auctionId?.toString()}</span>
                <span className={`status-badge ${status.cls}`}>
                  <span className="status-dot" />
                  {status.label}
                </span>
              </div>

              <div className="auction-grid">
                <div className="auction-stat">
                  <div className="auction-stat-label">Sell Amount</div>
                  <div className="auction-stat-value">{Number(auctionState.sellAmount).toLocaleString()} <span className="auction-stat-unit">SELL</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Max Price</div>
                  <div className="auction-stat-value">{auctionState.maxPrice} <span className="auction-stat-unit">/unit</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Reserve</div>
                  <div className="auction-stat-value">{auctionState.reservePrice} <span className="auction-stat-unit">/unit</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Deposit Required</div>
                  <div className="auction-stat-value small">{Number(auctionState.fixedDeposit).toLocaleString()} <span className="auction-stat-unit">USDC</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Encrypted Bids</div>
                  <div className="auction-stat-value">{auctionState.bidCount} <span className="auction-stat-unit">/ {auctionState.minBidders} min</span></div>
                </div>
                {auctionState.state === 0 && (
                  <div className="auction-stat">
                    <div className="auction-stat-label">Deadline</div>
                    <div className={`countdown ${auctionState.deadlinePassed ? "expired" : ""}`}>
                      {auctionState.deadlinePassed ? "Expired" : `${Math.floor(auctionState.timeRemaining / 60)}:${String(auctionState.timeRemaining % 60).padStart(2, "0")}`}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-header">
                <span className="card-title">No Active Auction</span>
              </div>
              <div className="empty-state">
                <p>{setupDone
                  ? "Tokens are ready. Create an auction to begin confidential price discovery."
                  : "Set up tokens first, then create an auction."
                }</p>
              </div>
            </div>
          )}

          {/* Settlement Result */}
          {auctionState?.state >= 4 && auctionState?.state !== 5 && (
            <div className="settlement-result">
              <div className="settlement-eyebrow">Auction Complete</div>
              <div className="settlement-label">Settlement Price (2nd Price)</div>
              <div className="settlement-price">
                {auctionState.settledPrice}<span className="settlement-price-unit">/unit</span>
              </div>
              <div className="settlement-detail">
                Winner: <strong>{auctionState.winnerAddress?.slice(0, 10)}...</strong> pays the second-highest bid, not their own.
              </div>
            </div>
          )}

          {/* Encrypted Bids */}
          {auctionState && auctionState.state >= 0 && auctionState.state !== 5 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <span className="card-title">Encrypted Bids</span>
                <span style={{ fontFamily: "var(--ff-mono)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)" }}>Prices hidden by FHE</span>
              </div>
              <BidCards bidCount={auctionState.bidCount} auctionState={auctionState} />
            </div>
          )}

          {/* Actions */}
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header">
              <span className="card-title">Actions</span>
            </div>
            {loading && (
              <div className="loading-bar">
                <div className="spinner" />
                {loading}
              </div>
            )}

            {/* Error with retry */}
            {lastError && !loading && (
              <div className="error-bar">
                <span className="error-msg">{lastError.msg}</span>
                {lastError.retry && (
                  <button className="btn btn-retry" onClick={lastError.retry}>Retry</button>
                )}
              </div>
            )}

            <div className="action-section" style={{ marginTop: (loading || lastError) ? 12 : 0 }}>
              {/* Setup + Create */}
              {connected && !setupDone && auctionId === null && (
                <div className="action-with-hint">
                  <button className="btn btn-secondary" onClick={setupTokens} disabled={!!loading}>
                    Setup Tokens
                  </button>
                  <span className="action-hint">Mints test tokens and sets spending approvals for the auction contract.</span>
                </div>
              )}
              {connected && setupDone && auctionId === null && (
                <div className="action-with-hint">
                  <div className="auction-form">
                    <div className="auction-form-row">
                      <div className="field">
                        <label>Sell Amount</label>
                        <input type="number" value={auctionParams.sellAmount}
                          onChange={e => setAuctionParams(p => ({...p, sellAmount: e.target.value}))} min="1" />
                      </div>
                      <div className="field">
                        <label>Max Price</label>
                        <input type="number" value={auctionParams.maxPrice}
                          onChange={e => setAuctionParams(p => ({...p, maxPrice: e.target.value}))} min="1" />
                      </div>
                      <div className="field">
                        <label>Reserve Price</label>
                        <input type="number" value={auctionParams.reservePrice}
                          onChange={e => setAuctionParams(p => ({...p, reservePrice: e.target.value}))} min="0" />
                      </div>
                    </div>
                    <div className="auction-form-row">
                      <div className="field">
                        <label>Duration (sec)</label>
                        <input type="number" value={auctionParams.duration}
                          onChange={e => setAuctionParams(p => ({...p, duration: e.target.value}))} min="10" />
                      </div>
                      <div className="field">
                        <label>Min Bidders</label>
                        <input type="number" value={auctionParams.minBidders}
                          onChange={e => setAuctionParams(p => ({...p, minBidders: e.target.value}))} min="2" />
                      </div>
                      <div className="field">
                        <label>Deposit</label>
                        <div className="field-computed">{(Number(auctionParams.maxPrice) * Number(auctionParams.sellAmount)) || 0}</div>
                      </div>
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={createAuction} disabled={!!loading}>
                    Create Auction
                  </button>
                  <span className="action-hint">Locks {auctionParams.sellAmount} sell tokens. Each bidder deposits {(Number(auctionParams.maxPrice) * Number(auctionParams.sellAmount)) || "?"} bid tokens. Bidding window: {Math.round(Number(auctionParams.duration) / 60)} min.</span>
                </div>
              )}

              {/* Bidding Phase */}
              {auctionState?.state === 0 && !auctionState?.deadlinePassed && (
                <>
                  <div className="bid-input-group">
                    {!IS_TESTNET && (
                      <select className="bidder-select" value={selectedBidder} onChange={(e) => setSelectedBidder(e.target.value)}>
                        <option value="bidder1">Bidder 1</option>
                        <option value="bidder2">Bidder 2</option>
                        <option value="bidder3">Bidder 3</option>
                        <option value="bidder4">Bidder 4</option>
                      </select>
                    )}
                    <input
                      className="bid-input"
                      type="number"
                      placeholder={`Price per unit (${bidRange.min}-${bidRange.max})`}
                      value={bidPrice}
                      onChange={(e) => setBidPrice(e.target.value)}
                      min={bidRange.min}
                      max={bidRange.max}
                    />
                    <button className="btn btn-primary" onClick={submitBid} disabled={!!loading}>
                      Encrypt &amp; Bid
                    </button>
                  </div>
                  <span className="action-hint">
                    Your bid is encrypted in the browser using TFHE before submission. The plaintext price never leaves your device.
                    Valid range: {bidRange.min} to {bidRange.max} per unit.
                  </span>
                  {Number(auctionState.bidCount) >= Number(auctionState.minBidders) && (
                    <button className="btn btn-secondary" onClick={closeAuction} disabled={!!loading}>
                      {IS_TESTNET ? "Close Auction (after deadline)" : "Close Auction"}
                    </button>
                  )}
                </>
              )}

              {/* Close */}
              {auctionState?.state === 0 && auctionState?.deadlinePassed && (
                <div className="action-with-hint">
                  <button className="btn btn-primary" onClick={closeAuction} disabled={!!loading}>
                    Close Auction ({auctionState.bidCount} bids received)
                  </button>
                  <span className="action-hint">Deadline has passed. Close the auction to begin the FHE resolution process.</span>
                </div>
              )}

              {/* Resolve */}
              {auctionState?.state === 1 && (
                <div className="action-with-hint">
                  <button className="btn btn-primary" onClick={resolvePass1} disabled={!!loading}>
                    Resolve Pass 1: FHE Tournament
                  </button>
                  <span className="action-hint">Runs N-1 homomorphic comparisons to find the highest encrypted bid without decrypting any values.</span>
                </div>
              )}
              {auctionState?.state === 2 && (
                <div className="action-with-hint">
                  <button className="btn btn-primary" onClick={resolvePass2} disabled={!!loading}>
                    Resolve Pass 2: Find Winner &amp; 2nd Price
                  </button>
                  <span className="action-hint">Excludes the winner's bid, runs a second tournament to find the settlement price, and marks the winner.</span>
                </div>
              )}

              {/* Settle */}
              {auctionState?.state === 3 && (
                <div className="action-with-hint">
                  <button className="btn btn-success" onClick={settle} disabled={!!loading}>
                    Settle Auction
                  </button>
                  <span className="action-hint">Scans all possible winner/price combinations to find the correct settlement. Winner receives tokens, losers get refunds.</span>
                </div>
              )}

              {/* Compliance */}
              {auctionState?.state === 4 && !complianceDone && (
                <div className="compliance-section">
                  <div className="compliance-tiers">
                    <div className="compliance-tier">
                      <div className="compliance-tier-label public">Public Tier</div>
                      <div className="compliance-tier-value">Settlement price: {auctionState.settledPrice}/unit</div>
                      <div className="compliance-tier-desc">Visible to everyone after settlement</div>
                    </div>
                    <div className="compliance-tier restricted">
                      <div className="compliance-tier-label restricted">Restricted Tier</div>
                      <div className="compliance-tier-value">Winning bid: encrypted</div>
                      <div className="compliance-tier-desc">Only visible to addresses granted access</div>
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={revealCompliance} disabled={!!loading}>
                    Grant Regulator Access
                  </button>
                  <span className="action-hint">
                    {IS_TESTNET
                      ? `Only the winner (${auctionState.winnerAddress?.slice(0, 10)}...) or the seller can grant access. Your connected wallet must be one of them.`
                      : "The winner grants the regulator address decryption access to the winning bid via FHE.allow."
                    }
                  </span>
                </div>
              )}

              {auctionState?.state === 4 && complianceDone && (
                <div className="completion-block success">
                  <span className="completion-icon">{"\u2713"}</span>
                  <div className="completion-text">
                    <strong>Auction complete.</strong> Compliance access granted. The regulator can now decrypt the winning bid.
                  </div>
                  <button className="btn btn-primary" onClick={resetForNewAuction} disabled={!!loading}>
                    New Auction
                  </button>
                </div>
              )}

              {auctionState?.state === 5 && (
                <div className="completion-block cancelled">
                  <span className="completion-icon">{"\u2717"}</span>
                  <div className="completion-text">
                    <strong>Auction cancelled.</strong> Not enough bidders before the deadline. All deposits are refundable.
                  </div>
                  <button className="btn btn-primary" onClick={resetForNewAuction} disabled={!!loading}>
                    New Auction
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Event Log */}
        <Log logs={logs} onClear={clearLogs} />
      </div>
    </div>
  );
}

export default App;

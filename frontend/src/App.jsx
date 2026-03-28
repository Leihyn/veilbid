import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import auctionAbi from "./contracts/SealedAuction.json";
import erc20Abi from "./contracts/MockERC20.json";
import { ADDRESSES, NETWORK, CHAIN_ID } from "./contracts/addresses.js";
import "./App.css";

const IS_TESTNET = NETWORK === "sepolia";
const LOCAL_RPC = "http://127.0.0.1:8545";
const MNEMONIC = "test test test test test test test test test test test junk";

function getLocalWallet(index) {
  const hdNode = ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(MNEMONIC),
    `m/44'/60'/0'/0/${index}`
  );
  return new ethers.Wallet(hdNode.privateKey, new ethers.JsonRpcProvider(LOCAL_RPC));
}

const PHASES = [
  { key: "create", label: "Create" },
  { key: "bid", label: "Bid" },
  { key: "close", label: "Close" },
  { key: "resolve", label: "Resolve" },
  { key: "settle", label: "Settle" },
  { key: "compliance", label: "Compliance" },
];

function getPhaseIndex(state, complianceDone) {
  if (state === null || state === undefined) return -1;
  if (complianceDone) return 6;
  if (state >= 4) return 5; // settled -> compliance
  if (state === 3) return 4; // resolved -> settle
  if (state >= 1 && state <= 2) return 3; // closed/pass1 -> resolve
  return 1; // open -> bid phase
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

// ========== Components ==========

function PhaseStepper({ currentPhase }) {
  return (
    <div className="phase-stepper">
      {PHASES.map((phase, i) => (
        <div key={phase.key} style={{ display: "flex", alignItems: "center" }}>
          <div className={`phase-step ${i < currentPhase ? "completed" : ""} ${i === currentPhase ? "active" : ""}`}>
            <div className="phase-number">
              {i < currentPhase ? "\u2713" : i + 1}
            </div>
            <span className="phase-label">{phase.label}</span>
          </div>
          {i < PHASES.length - 1 && (
            <div className={`phase-connector ${i < currentPhase ? "completed" : ""}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function Log({ logs }) {
  return (
    <div className="log-panel">
      <div className="log-header">
        <span className="log-title">Event Log</span>
        <span className="network-tag">{IS_TESTNET ? "Sepolia" : "Local"}</span>
      </div>
      <div className="log-entries">
        {logs.map((l, i) => (
          <div key={i} className={`log-entry ${l.type || ""}`}>
            <span className="log-time">{l.time}</span>
            <span className="log-msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BidCards({ bidCount, auctionState }) {
  const count = Number(bidCount || 0);
  if (count === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">&#x1f512;</div>
        <p>Waiting for encrypted bids...</p>
      </div>
    );
  }
  return (
    <div className="bids-list">
      {Array.from({ length: count }, (_, i) => {
        const isWinner = auctionState?.state >= 4 && auctionState?.winnerIndex === i;
        return (
          <div key={i} className={`bid-card ${isWinner ? "winner" : ""}`}>
            <div className="bid-lock">{isWinner ? "\u2713" : "\u1f512"}</div>
            <div className="bid-info">
              <div className="bid-address">Bidder #{i + 1}</div>
              <div className="bid-encrypted">
                <span>{isWinner ? "Winner" : "FHE-Encrypted"}</span>
                <span className="bid-cipher">0x{Array.from({length: 8}, () => Math.floor(Math.random()*16).toString(16)).join("")}...</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
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
  const [setupDone, setSetupDone] = useState(false);
  const [connected, setConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const fhevmInstance = useRef(null);
  const [localWallets, setLocalWallets] = useState(null);

  const log = useCallback((msg, type = "") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [{ time, msg, type }, ...prev]);
  }, []);

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

  useEffect(() => {
    if (IS_TESTNET) return;
    const rpcProvider = new ethers.JsonRpcProvider(LOCAL_RPC);
    setProvider(rpcProvider);
    const wallets = {
      seller: getLocalWallet(0), bidder1: getLocalWallet(1),
      bidder2: getLocalWallet(2), bidder3: getLocalWallet(3),
      bidder4: getLocalWallet(4), regulator: getLocalWallet(5),
    };
    setLocalWallets(wallets);
    setConnected(true);
    findLatestAuction(rpcProvider);
  }, []);

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

  async function setupTokens() {
    setLoading("Setting up tokens...");
    try {
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
        const { sellToken, bidToken } = getContracts();
        await (await sellToken.connect(seller).mint(seller.address, 10000)).wait();
        for (const name of ["bidder1", "bidder2", "bidder3", "bidder4"]) {
          await (await bidToken.connect(seller).mint(localWallets[name].address, 1000000)).wait();
        }
        await (await sellToken.connect(seller).approve(ADDRESSES.auction, 10000)).wait();
        for (const name of ["bidder1", "bidder2", "bidder3", "bidder4"]) {
          await (await bidToken.connect(localWallets[name]).approve(ADDRESSES.auction, 1000000)).wait();
        }
      }
      log("Tokens ready.", "success");
      setSetupDone(true);
      await refreshBalances();
    } catch (e) { log(`Error: ${e.message}`, "error"); }
    setLoading("");
  }

  async function createAuction() {
    setLoading("Creating auction...");
    try {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const duration = IS_TESTNET ? 1800 : 120;
      const tx = await auction.createAuction(ADDRESSES.sellToken, ADDRESSES.bidToken, 10000, 10, 2, duration, 3);
      await tx.wait();
      const { auction: ac } = getContracts();
      const nextId = await ac.nextAuctionId();
      setAuctionId(nextId - 1n);
      log(`Auction #${nextId - 1n} created (${duration / 60}min window)`, "success");
      await refreshAuction();
      await refreshBalances();
    } catch (e) { log(`Error: ${e.message}`, "error"); }
    setLoading("");
  }

  async function submitBid() {
    if (!bidPrice || isNaN(Number(bidPrice))) { log("Enter a valid bid price", "error"); return; }
    const price = Number(bidPrice);
    if (IS_TESTNET) {
      setLoading("Encrypting bid...");
      try {
        if (!fhevmInstance.current) { log("FHE not initialized.", "error"); setLoading(""); return; }
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
      } catch (e) { log(`Bid failed: ${e.message?.slice(0, 200)}`, "error"); }
    } else {
      setLoading(`Submitting bid from ${selectedBidder}...`);
      try {
        const wallet = localWallets[selectedBidder];
        const helperAbi = (await import("./contracts/DemoHelper.json")).default;
        const helper = new ethers.Contract(ADDRESSES.demoHelper, helperAbi, wallet);
        const tx = await helper.submitBid(auctionId, price, { gasLimit: 2000000 });
        await tx.wait();
        log(`${selectedBidder} bid submitted (encrypted).`, "success");
        setBidPrice("");
        await refreshAuction(); await refreshBalances();
      } catch (e) { log(`Bid failed: ${e.message?.slice(0, 200)}`, "error"); }
    }
    setLoading("");
  }

  async function closeAuction() {
    setLoading("Closing auction...");
    try {
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
    } catch (e) { log(`Error: ${e.message}`, "error"); }
    setLoading("");
  }

  async function resolvePass1() {
    setLoading("FHE Tournament: finding highest bid...");
    try {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const receipt = await (await auction.resolvePass1(auctionId, { gasLimit: 5000000 })).wait();
      log(`Pass 1 complete (${receipt.gasUsed} gas). Highest encrypted bid found.`, "success");
      await refreshAuction();
    } catch (e) { log(`Error: ${e.message}`, "error"); }
    setLoading("");
  }

  async function resolvePass2() {
    setLoading("FHE Tournament: finding second price + winner...");
    try {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const receipt = await (await auction.resolvePass2(auctionId, { gasLimit: 10000000 })).wait();
      log(`Pass 2 complete (${receipt.gasUsed} gas). Winner identified.`, "success");
      await refreshAuction();
    } catch (e) { log(`Error: ${e.message}`, "error"); }
    setLoading("");
  }

  async function settle() {
    setLoading("Auto-detecting settlement values...");
    try {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const bidCount = Number(await auction.getBidCount(auctionId));
      const info = await auction.getAuction(auctionId);
      const reservePrice = Number(info.reservePrice);
      const maxPrice = Number(info.maxPrice);

      log("Detecting winner and settlement price...");

      // Try each possible winner index and price via static call
      let settled = false;
      for (let price = reservePrice; price <= maxPrice && !settled; price++) {
        for (let idx = 0; idx < bidCount && !settled; idx++) {
          try {
            await auction.settle.staticCall(auctionId, idx, price, { gasLimit: 5000000 });
            // Static call succeeded — this is the correct combination
            log(`Found: winner=#${idx}, price=${price}/unit. Settling...`);
            const tx = await auction.settle(auctionId, idx, price, { gasLimit: 5000000 });
            const receipt = await tx.wait();
            log(`Settled! Winner pays ${price}/unit (2nd price). Gas: ${receipt.gasUsed}`, "success");
            settled = true;
          } catch {
            // Wrong combination, try next
          }
        }
      }

      if (!settled) {
        log("Could not auto-detect settlement values. Try manually.", "error");
      }

      await refreshAuction();
      await refreshBalances();
    } catch (e) { log(`Error: ${e.message?.slice(0, 200)}`, "error"); }
    setLoading("");
  }

  async function revealCompliance() {
    setLoading("Granting compliance access...");
    try {
      const { auction } = getContracts(IS_TESTNET ? signer : provider);
      const info = await auction.getAuction(auctionId);

      if (IS_TESTNET) {
        // Use connected wallet address as regulator for demo
        const regulatorAddr = walletAddress;
        const auctionWithSigner = getContracts(signer).auction;
        await (await auctionWithSigner.revealForCompliance(auctionId, regulatorAddr)).wait();
        log(`Compliance access granted. Regulator can decrypt winning bid.`, "success");
        setComplianceDone(true);
      } else {
        const winnerAddr = info.winnerAddress;
        let winnerKey = null;
        for (const [name, w] of Object.entries(localWallets)) {
          if (w.address.toLowerCase() === winnerAddr.toLowerCase()) winnerKey = name;
        }
        if (!winnerKey) { log("Winner not found", "error"); return; }
        const auctionWithWinner = getContracts(localWallets[winnerKey]).auction;
        await (await auctionWithWinner.revealForCompliance(auctionId, localWallets.regulator.address)).wait();
        log("Compliance access granted to regulator.", "success");
        setComplianceDone(true);
      }
    } catch (e) { log(`Error: ${e.message}`, "error"); }
    setLoading("");
  }

  // ========== Render ==========

  const phaseIndex = auctionId !== null ? getPhaseIndex(auctionState?.state, complianceDone) : 0;
  const status = auctionState ? getStatusInfo(auctionState.state) : null;

  // Connect screen
  if (!connected && IS_TESTNET) {
    return (
      <div className="app">
        <div className="connect-screen">
          <div className="logo" style={{ marginBottom: 24 }}>
            <img src="/logo.jpg" alt="VeilBid" className="logo-icon" />
            <h1 style={{ fontSize: 32, background: "none", WebkitTextFillColor: "var(--text)" }}>VeilBid</h1>
          </div>
          <h2>Confidential Price Discovery</h2>
          <p>
            Institutions won't bid in on-chain auctions because every bid is a public signal.
            VeilBid encrypts bids client-side with FHE so prices never appear in calldata.
            The winner pays the second-highest price. Regulators get selective access.
          </p>
          <div className="connect-features">
            <div className="connect-feature">
              <div className="connect-feature-icon" style={{ background: "var(--accent-glow)", color: "var(--accent)" }}>&#x1f512;</div>
              FHE-Encrypted Bids
            </div>
            <div className="connect-feature">
              <div className="connect-feature-icon" style={{ background: "var(--success-bg)", color: "var(--success)" }}>&#x2713;</div>
              Vickrey (2nd Price)
            </div>
            <div className="connect-feature">
              <div className="connect-feature-icon" style={{ background: "var(--warning-bg)", color: "var(--warning)" }}>&#x1f441;</div>
              Compliance Ready
            </div>
          </div>
          <button className="btn-connect" onClick={connectWallet} disabled={!!loading}>
            {loading || "Connect Wallet"}
          </button>
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

      {/* Phase Stepper */}
      {auctionId !== null && <PhaseStepper currentPhase={phaseIndex} />}

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
                  <div className="auction-stat-value">{Number(auctionState.sellAmount).toLocaleString()} <span style={{fontSize:12, color:"var(--muted)"}}>SELL</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Max Price</div>
                  <div className="auction-stat-value">{auctionState.maxPrice} <span style={{fontSize:12, color:"var(--muted)"}}>/unit</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Reserve</div>
                  <div className="auction-stat-value">{auctionState.reservePrice} <span style={{fontSize:12, color:"var(--muted)"}}>/unit</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Deposit Required</div>
                  <div className="auction-stat-value small">{Number(auctionState.fixedDeposit).toLocaleString()} <span style={{fontSize:11, color:"var(--muted)"}}>USDC</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Encrypted Bids</div>
                  <div className="auction-stat-value">{auctionState.bidCount} <span style={{fontSize:12, color:"var(--muted)"}}>/ {auctionState.minBidders} min</span></div>
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
                <p>Create an auction to begin confidential price discovery.</p>
              </div>
            </div>
          )}

          {/* Settlement Result */}
          {auctionState?.state >= 4 && (
            <div className="settlement-result">
              <div className="settlement-label">Settlement Price (2nd Price)</div>
              <div className="settlement-price">{auctionState.settledPrice}/unit</div>
              <div className="settlement-detail">
                Winner: {auctionState.winnerAddress?.slice(0, 10)}... pays the second-highest bid, not their own.
              </div>
            </div>
          )}

          {/* Encrypted Bids */}
          {auctionState && auctionState.state >= 0 && auctionState.state !== 5 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <span className="card-title">Encrypted Bids</span>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Prices hidden by FHE</span>
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

            <div className="action-section" style={{ marginTop: loading ? 12 : 0 }}>
              {/* Setup + Create */}
              {connected && !setupDone && auctionId === null && (
                <button className="btn btn-secondary" onClick={setupTokens} disabled={!!loading}>
                  Setup Tokens
                </button>
              )}
              {connected && setupDone && auctionId === null && (
                <button className="btn btn-primary" onClick={createAuction} disabled={!!loading}>
                  Create Auction
                </button>
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
                    <input className="bid-input" type="number" placeholder="Price per unit (1-10)" value={bidPrice} onChange={(e) => setBidPrice(e.target.value)} min="1" max="10" />
                    <button className="btn btn-primary" onClick={submitBid} disabled={!!loading}>
                      Encrypt &amp; Bid
                    </button>
                  </div>
                  <button className="btn btn-secondary" onClick={closeAuction} disabled={!!loading}>
                    {IS_TESTNET ? "Close Auction (after deadline)" : "Close Auction"}
                  </button>
                </>
              )}

              {/* Close */}
              {auctionState?.state === 0 && auctionState?.deadlinePassed && (
                <button className="btn btn-primary" onClick={closeAuction} disabled={!!loading}>
                  Close Auction ({auctionState.bidCount} bids received)
                </button>
              )}

              {/* Resolve */}
              {auctionState?.state === 1 && (
                <button className="btn btn-primary" onClick={resolvePass1} disabled={!!loading}>
                  Resolve Pass 1: FHE Tournament
                </button>
              )}
              {auctionState?.state === 2 && (
                <button className="btn btn-primary" onClick={resolvePass2} disabled={!!loading}>
                  Resolve Pass 2: Find Winner &amp; 2nd Price
                </button>
              )}

              {/* Settle */}
              {auctionState?.state === 3 && (
                <button className="btn btn-success" onClick={settle} disabled={!!loading}>
                  Settle Auction (Auto-detect)
                </button>
              )}

              {/* Compliance */}
              {auctionState?.state === 4 && !complianceDone && (
                <div className="compliance-section">
                  <div className="compliance-tiers">
                    <div className="compliance-tier">
                      <div className="compliance-tier-label public">Public</div>
                      <div className="compliance-tier-value">Settlement price: {auctionState.settledPrice}/unit</div>
                      <div className="compliance-tier-desc">Visible to everyone after settlement</div>
                    </div>
                    <div className="compliance-tier">
                      <div className="compliance-tier-label restricted">Restricted</div>
                      <div className="compliance-tier-value">Winning bid: encrypted</div>
                      <div className="compliance-tier-desc">Only visible to regulator after grant</div>
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={revealCompliance} disabled={!!loading}>
                    Grant Regulator Access
                  </button>
                </div>
              )}

              {auctionState?.state === 4 && complianceDone && (
                <div className="compliance-done">
                  <span>&#x2713;</span>
                  Auction complete. Compliance access granted.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Event Log */}
        <Log logs={logs} />
      </div>
    </div>
  );
}

export default App;

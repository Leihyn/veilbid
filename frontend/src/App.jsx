import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ethers } from "ethers";
import auctionAbi from "./contracts/SealedAuction.json";
import erc20Abi from "./contracts/MockERC20.json";
import erc7984Abi from "./contracts/VeilBidUSDC.json";

// ERC-7984 operator far-future expiry (~2033)
const OPERATOR_UNTIL = 2_000_000_000;
import { ADDRESSES, NETWORK, CHAIN_ID } from "./contracts/addresses.js";
import "./App.css";

const IS_TESTNET = NETWORK === "sepolia";
const LOCAL_RPC = "http://127.0.0.1:8545";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const MNEMONIC = "test test test test test test test test test test test junk";
const MAX_LOG_ENTRIES = 50;

// === Issuance demo context (frontend display only — contract is asset-agnostic) ===
const FACE_VALUE_CENTS = 10_000;            // $100.00 par per unit
const TENOR_DAYS = 90;
const ISSUER_NAME = "Acme Capital";
const INSTRUMENT = "90-day Commercial Paper";
const SETTLEMENT_TOKEN = "vbUSDC";

const QIB_NAMES = [
  "Pension Fund A",
  "Asset Manager B",
  "Treasury Desk C",
  "Insurance Co D",
  "Family Office E",
];

// Implied annualized yield (360-day basis) from a discount-price bid in cents
function impliedYield(clearingCents, tenorDays = TENOR_DAYS) {
  const cents = Number(clearingCents);
  if (!cents || cents >= FACE_VALUE_CENTS) return 0;
  return ((FACE_VALUE_CENTS - cents) / cents) * (360 / tenorDays) * 100;
}

// Format cents-as-price into "$XX.YY"
function formatPrice(cents) {
  const n = Number(cents);
  if (!n) return "—";
  return `$${(n / 100).toFixed(2)}`;
}

// Format an integer count with thousands separators
function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}

// Notional cleared: lotSize × clearingPrice (in $)
function notionalCleared(lotSize, clearingCents) {
  return (Number(lotSize || 0) * Number(clearingCents || 0)) / 100;
}

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
  { key: "create", label: "Open Round", desc: "Issuer locks the lot and opens the bid window" },
  { key: "bid", label: "Submit Bids", desc: "QIBs encrypt discount-price bids client-side and submit ciphertext" },
  { key: "close", label: "Close Window", desc: "Bid window ends, no more submissions accepted" },
  { key: "resolve", label: "FHE Clear", desc: "Tournament finds the clearing price on encrypted data" },
  { key: "settle", label: "Allocate", desc: "Winner pays clearing price; losers refunded" },
  { key: "compliance", label: "Disclosure", desc: "Issuer or winner grants regulator decryption access" },
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
    1: { label: "Bid Window Closed", cls: "status-closed" },
    2: { label: "Discovering Max", cls: "status-resolving" },
    3: { label: "Cleared", cls: "status-resolved" },
    4: { label: "Allocated", cls: "status-settled" },
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
          <th>QIB</th>
          <th>Bid (encrypted)</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: count }, (_, i) => {
          const isWinner = auctionState?.state >= 4 && auctionState?.winnerIndex === i;
          return (
            <tr key={i} className={isWinner ? "winner-row" : ""}>
              <td><span className="bid-id">{String(i + 1).padStart(2, "0")}</span></td>
              <td>{QIB_NAMES[i] || `QIB #${i + 1}`}</td>
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
  const [readOnlyMode, setReadOnlyMode] = useState(true);
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
      // bidToken is VeilBidUSDC (ERC-7984 confidential token)
      bidToken: new ethers.Contract(ADDRESSES.bidToken, erc7984Abi, p),
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

      // Derive winnerIndex by matching winnerAddress against on-chain bidder roster.
      // getAuction() doesn't return the index directly; we need it for UI highlighting.
      let winnerIndex = -1;
      if (Number(info.state) >= 4 && info.winnerAddress && info.winnerAddress !== ethers.ZeroAddress) {
        try {
          const n = Number(bidCount);
          const winnerLower = info.winnerAddress.toLowerCase();
          for (let i = 0; i < n; i++) {
            const bidder = await auction.getBidder(auctionId, i);
            if (bidder.toLowerCase() === winnerLower) { winnerIndex = i; break; }
          }
        } catch { /* indices unreadable, fall through with -1 */ }
      }

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
        winnerIndex,
        settledPrice: info.settledPrice.toString(),
      });
    } catch (e) { /* Auction doesn't exist yet */ }
  }, [auctionId, provider]);

  const refreshBalances = useCallback(async () => {
    if (!provider) return;
    const { sellToken, bidToken } = getContracts();
    const bals = {};
    // ERC-7984 vbUSDC balances are encrypted (euint64) — we cannot read amounts
    // from chain without a user-decrypt EIP-712 signature. We surface
    // balanceIndicator (a public counter that increments on every transfer)
    // so the UI shows transfer activity without leaking amounts.
    if (IS_TESTNET && walletAddress) {
      const sell = await sellToken.balanceOf(walletAddress);
      const bidActivity = await bidToken.balanceIndicator(walletAddress);
      bals["you"] = {
        address: walletAddress.slice(0, 8) + "...",
        sell: sell.toString(),
        bid: bidActivity > 0n ? "[encrypted]" : "0",
      };
    } else if (localWallets) {
      for (const [name, wallet] of Object.entries(localWallets)) {
        const sell = await sellToken.balanceOf(wallet.address);
        const bidActivity = await bidToken.balanceIndicator(wallet.address);
        bals[name] = {
          address: wallet.address.slice(0, 8) + "...",
          sell: sell.toString(),
          bid: bidActivity > 0n ? "[encrypted]" : "0",
        };
      }
    }
    setBalances(bals);
  }, [provider, walletAddress, localWallets]);

  // Pattern D: initialize a read-only Sepolia provider on mount so the page
  // renders the live auction state before any wallet connects.
  useEffect(() => {
    if (!IS_TESTNET) return;
    if (provider) return;
    const ro = new ethers.JsonRpcProvider(SEPOLIA_RPC);
    setProvider(ro);
    findLatestAuction(ro);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshAuction();
      if (connected) refreshBalances();
    }, 3000);
    if (connected) refreshBalances();
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
        log("Minting tokens, setting approvals + ERC-7984 operator...");
        await (await sellToken.mint(addr, 10000)).wait();
        await (await bidToken.mint(addr, 1000000)).wait();
        await (await sellToken.approve(ADDRESSES.auction, 10000)).wait();
        // ERC-7984: setOperator replaces ERC-20 approve (no allowance leak)
        await (await bidToken.setOperator(ADDRESSES.auction, OPERATOR_UNTIL)).wait();
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
          // ERC-7984 setOperator (per-bidder, replaces approve)
          await (await bidToken.connect(localWallets[name]).setOperator(ADDRESSES.auction, OPERATOR_UNTIL)).wait();
        }
      }
      log("Tokens ready (ERC-7984 operator authorized).", "success");
      setSetupDone(true);
      await refreshBalances();
    });
  }

  async function createAuction() {
    const { sellAmount, maxPrice, reservePrice, duration, minBidders } = auctionParams;
    const sa = Number(sellAmount), mp = Number(maxPrice), rp = Number(reservePrice), dur = Number(duration), mb = Number(minBidders);
    if (!sa || !mp || !rp || !dur || !mb) { log("Fill in all auction parameters", "error"); return; }
    if (rp > mp) { log("Reserve price cannot exceed max price", "error"); return; }
    if (mb < 3) { log("Minimum bidders must be at least 3", "error"); return; }

    await runAction("Creating auction...", async () => {
      const s = IS_TESTNET ? signer : localWallets.seller;
      const { auction } = getContracts(s);
      const tx = await auction.createAuction(ADDRESSES.sellToken, ADDRESSES.bidToken, sa, mp, rp, dur, mb);
      await tx.wait();
      const { auction: ac } = getContracts();
      const nextId = await ac.nextAuctionId();
      setAuctionId(nextId - 1n);
      log(`Issuance Round #${nextId - 1n} opened (${dur / 60}min bid window, lot=${sa} units, price range ${rp}-${mp})`, "success");
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
      log("Bid window closed.", "success");
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
    log("Ready for new issuance round.", "success");
  }

  // ========== Render ==========

  const phaseIndex = auctionId !== null ? getPhaseIndex(auctionState?.state, complianceDone) : 0;
  const status = auctionState ? getStatusInfo(auctionState.state) : null;

  const bidRange = useMemo(() => {
    if (!auctionState) return { min: 1, max: 10 };
    return { min: Number(auctionState.reservePrice), max: Number(auctionState.maxPrice) };
  }, [auctionState]);

  return (
    <div className="app">
      {/* Pattern D: marketing banner — always visible, replaces the connect-gate screen.
          Compact when connected; expanded with body copy when not. */}
      <div className="hero-banner" style={{
        padding: connected ? "16px 24px 14px" : "28px 24px 22px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        marginBottom: 12,
      }}>
        <div className="connect-eyebrow" style={{ fontSize: 10, letterSpacing: "0.16em" }}>Confidential Primary Issuance</div>
        <h2 style={{ margin: connected ? "4px 0 0" : "8px 0 6px", fontSize: connected ? "1.5em" : "2.2em", lineHeight: 1.15 }}>
          Confidential <em>Primary Issuance</em>{connected ? " · " : <br />}for Tokenized Fixed Income
        </h2>
        {!connected && (
          <>
            <div className="connect-subtitle" style={{ marginTop: 6 }}>Sealed-bid Vickrey clearing on Zama fhEVM with ERC-7984 settlement</div>
            <p style={{ maxWidth: 720, margin: "12px 0 14px", opacity: 0.85, fontSize: 13, lineHeight: 1.55 }}>
              Public on-chain auctions leak every bid the moment a transaction hits the mempool. Institutional buyers won't reveal yield reservations into a public book, so they don't show up. VeilBid encrypts bids <strong>client-side with FHE</strong>. The contract clears at the second-highest price (Vickrey). A named regulator can decrypt the winning bid post-trade.
            </p>
          </>
        )}
        <div className="connect-meta" style={{ marginTop: connected ? 4 : 6, fontSize: 10 }}>
          <span className="connect-meta-item">27 Tests Passing</span>
          <span className="connect-meta-item">14 FHE Primitives</span>
          <span className="connect-meta-item">Live on Sepolia · ERC-7984</span>
          <span className="connect-meta-item">{connected ? "Reg D / 144A Disclosure" : "Built on Zama Protocol"}</span>
        </div>
      </div>

      {/* Header */}
      <div className="header">
        <div className="header-left">
          <div className="logo">
            <img src="/logo.jpg" alt="VeilBid" className="logo-icon" />
            <h1>VeilBid</h1>
          </div>
          <span className="tagline">Confidential primary issuance · ERC-7984 settlement</span>
        </div>
        {walletAddress ? (
          <div className="wallet-badge">
            <span className="wallet-dot" />
            {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
            <span className="network-tag">Sepolia</span>
          </div>
        ) : IS_TESTNET ? (
          <button className="btn btn-primary" onClick={connectWallet} disabled={!!loading} style={{ padding: "10px 22px" }}>
            {loading || "Connect Wallet"}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={initLocal} style={{ padding: "10px 22px" }}>
            Enter Protocol
          </button>
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
                <span className="card-title">Issuance Round #{auctionId?.toString()}</span>
                <span className={`status-badge ${status.cls}`}>
                  <span className="status-dot" />
                  {status.label}
                </span>
              </div>

              {/* Issuance Details (Tier 4) — demo context for the institutional pitch */}
              <div className="issuance-details" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: "8px 24px", padding: "12px 16px", marginBottom: 12, fontFamily: "var(--ff-mono)", fontSize: 11, lineHeight: 1.6, border: "1px solid var(--border, rgba(255,255,255,0.08))", borderRadius: 6, background: "rgba(255,255,255,0.02)" }}>
                <div><span style={{ opacity: 0.55 }}>Issuer:</span> <strong>{ISSUER_NAME}</strong> <span style={{ opacity: 0.4 }}>(demo)</span></div>
                <div><span style={{ opacity: 0.55 }}>Instrument:</span> <strong>{INSTRUMENT}</strong></div>
                <div><span style={{ opacity: 0.55 }}>Face Value:</span> <strong>$100 per unit</strong></div>
                <div><span style={{ opacity: 0.55 }}>Settlement:</span> <strong>{SETTLEMENT_TOKEN} (ERC-7984)</strong></div>
                <div><span style={{ opacity: 0.55 }}>Lot Size:</span> <strong>{fmtInt(auctionState.sellAmount)} units</strong> <span style={{ opacity: 0.4 }}>= ${fmtInt(Number(auctionState.sellAmount) * 100)} face</span></div>
                <div><span style={{ opacity: 0.55 }}>Tenor:</span> <strong>{TENOR_DAYS} days</strong></div>
              </div>

              <div className="auction-grid">
                <div className="auction-stat">
                  <div className="auction-stat-label">Lot Size</div>
                  <div className="auction-stat-value">{fmtInt(auctionState.sellAmount)} <span className="auction-stat-unit">units</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Price Ceiling</div>
                  <div className="auction-stat-value">{formatPrice(auctionState.maxPrice)} <span className="auction-stat-unit">per $100 face</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Reserve Floor</div>
                  <div className="auction-stat-value">{formatPrice(auctionState.reservePrice)} <span className="auction-stat-unit">per $100 face</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Deposit per QIB</div>
                  <div className="auction-stat-value small">{fmtInt(auctionState.fixedDeposit)} <span className="auction-stat-unit">{SETTLEMENT_TOKEN}</span></div>
                </div>
                <div className="auction-stat">
                  <div className="auction-stat-label">Confidential Bids</div>
                  <div className="auction-stat-value">{auctionState.bidCount} <span className="auction-stat-unit">/ {auctionState.minBidders} min</span></div>
                </div>
                {auctionState.state === 0 && (
                  <div className="auction-stat">
                    <div className="auction-stat-label">Bid Window Closes</div>
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

          {/* Settlement Result — Tier 2: clearing price + implied yield */}
          {auctionState?.state >= 4 && auctionState?.state !== 5 && (
            <div className="settlement-result">
              <div className="settlement-eyebrow">Allocation Cleared</div>
              <div className="settlement-label">Clearing Price (Vickrey)</div>
              <div className="settlement-price">
                {formatPrice(auctionState.settledPrice)}<span className="settlement-price-unit">per $100 face</span>
              </div>
              <div style={{ marginTop: 8, fontFamily: "var(--ff-mono)", fontSize: 12, opacity: 0.85 }}>
                <strong>Implied Yield: {impliedYield(auctionState.settledPrice).toFixed(2)}%</strong>
                <span style={{ opacity: 0.55 }}> ({TENOR_DAYS}-day basis, 360-day annualization)</span>
              </div>
              <div style={{ marginTop: 6, fontFamily: "var(--ff-mono)", fontSize: 11, opacity: 0.7 }}>
                Notional cleared: ${fmtInt(notionalCleared(auctionState.sellAmount, auctionState.settledPrice))} · {fmtInt(auctionState.sellAmount)} units allocated
              </div>
              <div className="settlement-detail" style={{ marginTop: 10 }}>
                Winner: <strong>{QIB_NAMES[auctionState.winnerIndex] || auctionState.winnerAddress?.slice(0, 10) + "..."}</strong> pays the clearing price, not their own bid. Losing bids stay encrypted forever.
              </div>
            </div>
          )}

          {/* Issuer Dashboard — Tier 3: visible to seller only after clearing */}
          {auctionState?.state >= 3 && auctionState?.state !== 5 && walletAddress && auctionState.seller?.toLowerCase() === walletAddress?.toLowerCase() && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <span className="card-title">Issuer Dashboard</span>
                <span style={{ fontFamily: "var(--ff-mono)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)" }}>Visible to issuer only</span>
              </div>
              <div style={{ padding: "12px 16px", fontFamily: "var(--ff-mono)", fontSize: 12, lineHeight: 1.7 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 16, marginBottom: 16 }}>
                  <div>
                    <div style={{ opacity: 0.55, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Bids Received</div>
                    <div style={{ fontSize: 18, marginTop: 4 }}>{auctionState.bidCount} / {auctionState.minBidders} min</div>
                  </div>
                  <div>
                    <div style={{ opacity: 0.55, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Clearing Yield</div>
                    <div style={{ fontSize: 18, marginTop: 4 }}>
                      {auctionState.state >= 4 ? `${impliedYield(auctionState.settledPrice).toFixed(2)}%` : "—"}
                    </div>
                  </div>
                  <div>
                    <div style={{ opacity: 0.55, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Notional Cleared</div>
                    <div style={{ fontSize: 18, marginTop: 4 }}>
                      {auctionState.state >= 4 ? `$${fmtInt(notionalCleared(auctionState.sellAmount, auctionState.settledPrice))}` : "—"}
                    </div>
                  </div>
                </div>
                <div style={{ opacity: 0.55, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 8 }}>Allocation Roster</div>
                <table className="bid-table" style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>QIB</th>
                      <th>Address</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: Number(auctionState.bidCount) }, (_, i) => {
                      const isWinner = auctionState.state >= 4 && Number(auctionState.winnerIndex) === i;
                      return (
                        <tr key={i} className={isWinner ? "winner-row" : ""}>
                          <td><span className="bid-id">{String(i + 1).padStart(2, "0")}</span></td>
                          <td>{QIB_NAMES[i] || `QIB #${i + 1}`}</td>
                          <td style={{ opacity: 0.6, fontSize: 10 }}>
                            {isWinner ? auctionState.winnerAddress?.slice(0, 12) + "..." : "—"}
                          </td>
                          <td>
                            {auctionState.state < 4 ? (
                              <span style={{ opacity: 0.5 }}>Pending</span>
                            ) : isWinner ? (
                              <span className="bid-status winner-status"><span className="bid-status-dot" />Allocated</span>
                            ) : (
                              <span style={{ opacity: 0.7 }}>Refunded</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: 12, fontSize: 11, opacity: 0.6 }}>
                  Losing bids encrypted forever. Per-trade regulator decryption available via <code>revealForCompliance</code> below.
                </div>
              </div>
            </div>
          )}

          {/* Confidential Bids */}
          {auctionState && auctionState.state >= 0 && auctionState.state !== 5 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-header">
                <span className="card-title">Confidential Bids</span>
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
              {/* Pattern D: Pre-connect CTA — visible whenever an action is available but no wallet connected */}
              {!connected && auctionState && auctionState.state !== 5 && (
                <div className="action-with-hint">
                  <button
                    className="btn btn-primary"
                    onClick={IS_TESTNET ? connectWallet : initLocal}
                    disabled={!!loading}
                    style={{ padding: "12px 28px" }}
                  >
                    {loading || `Connect Wallet to ${
                      auctionState.state === 0 && !auctionState.deadlinePassed
                        ? "Submit a Confidential Bid"
                        : auctionState.state === 0 && auctionState.deadlinePassed
                        ? "Close This Bid Window"
                        : auctionState.state === 1
                        ? "Trigger FHE Clearing (Pass 1)"
                        : auctionState.state === 2
                        ? "Compute Clearing Price (Pass 2)"
                        : auctionState.state === 3
                        ? "Settle This Allocation"
                        : auctionState.state === 4
                        ? "Grant Regulator Disclosure"
                        : "Interact"
                    }`}
                  </button>
                  <span className="action-hint">
                    You're watching this round read-only. Connect to participate. The 5 confidential bids above were submitted by institutional QIBs. Their bid prices stay encrypted on-chain forever.
                  </span>
                </div>
              )}

              {!connected && !auctionState && (
                <div className="action-with-hint">
                  <button
                    className="btn btn-primary"
                    onClick={IS_TESTNET ? connectWallet : initLocal}
                    disabled={!!loading}
                    style={{ padding: "12px 28px" }}
                  >
                    {loading || "Connect Wallet"}
                  </button>
                  <span className="action-hint">
                    Loading live Sepolia state. Connect a wallet to interact with the issuance round.
                  </span>
                </div>
              )}

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
                        <label>Lot Size (units)</label>
                        <input type="number" value={auctionParams.sellAmount}
                          onChange={e => setAuctionParams(p => ({...p, sellAmount: e.target.value}))} min="1" />
                      </div>
                      <div className="field">
                        <label>Price Ceiling (cents per $100 face)</label>
                        <input type="number" value={auctionParams.maxPrice}
                          onChange={e => setAuctionParams(p => ({...p, maxPrice: e.target.value}))} min="1" />
                      </div>
                      <div className="field">
                        <label>Reserve Floor (cents per $100 face)</label>
                        <input type="number" value={auctionParams.reservePrice}
                          onChange={e => setAuctionParams(p => ({...p, reservePrice: e.target.value}))} min="0" />
                      </div>
                    </div>
                    <div className="auction-form-row">
                      <div className="field">
                        <label>Bid Window (sec)</label>
                        <input type="number" value={auctionParams.duration}
                          onChange={e => setAuctionParams(p => ({...p, duration: e.target.value}))} min="10" />
                      </div>
                      <div className="field">
                        <label>Min QIBs</label>
                        <input type="number" value={auctionParams.minBidders}
                          onChange={e => setAuctionParams(p => ({...p, minBidders: e.target.value}))} min="3" />
                      </div>
                      <div className="field">
                        <label>Deposit per QIB</label>
                        <div className="field-computed">{(Number(auctionParams.maxPrice) * Number(auctionParams.sellAmount)) || 0}</div>
                      </div>
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={createAuction} disabled={!!loading}>
                    Open Issuance Round
                  </button>
                  <span className="action-hint">Locks {auctionParams.sellAmount} units in escrow. Each QIB deposits {(Number(auctionParams.maxPrice) * Number(auctionParams.sellAmount)) || "?"} {SETTLEMENT_TOKEN}. Bid window: {Math.round(Number(auctionParams.duration) / 60)} min. Min QIB participation: {auctionParams.minBidders}.</span>
                </div>
              )}

              {/* Bidding Phase */}
              {connected && auctionState?.state === 0 && !auctionState?.deadlinePassed && (
                <>
                  <div className="bid-input-group">
                    {!IS_TESTNET && (
                      <select className="bidder-select" value={selectedBidder} onChange={(e) => setSelectedBidder(e.target.value)}>
                        <option value="bidder1">{QIB_NAMES[0]}</option>
                        <option value="bidder2">{QIB_NAMES[1]}</option>
                        <option value="bidder3">{QIB_NAMES[2]}</option>
                        <option value="bidder4">{QIB_NAMES[3]}</option>
                      </select>
                    )}
                    <input
                      className="bid-input"
                      type="number"
                      placeholder={`Discount-price bid (${bidRange.min}-${bidRange.max} cents per $100 face)`}
                      value={bidPrice}
                      onChange={(e) => setBidPrice(e.target.value)}
                      min={bidRange.min}
                      max={bidRange.max}
                    />
                    <button className="btn btn-primary" onClick={submitBid} disabled={!!loading}>
                      Encrypt &amp; Submit
                    </button>
                  </div>
                  <span className="action-hint">
                    Your bid is encrypted in the browser with TFHE WASM before submission. The plaintext price never leaves your device.
                    Valid range: {formatPrice(bidRange.min)}–{formatPrice(bidRange.max)} per $100 face.
                  </span>
                  {Number(auctionState.bidCount) >= Number(auctionState.minBidders) && (
                    <button className="btn btn-secondary" onClick={closeAuction} disabled={!!loading}>
                      {IS_TESTNET ? "Close Bid Window (after deadline)" : "Close Bid Window"}
                    </button>
                  )}
                </>
              )}

              {/* Close */}
              {connected && auctionState?.state === 0 && auctionState?.deadlinePassed && (
                <div className="action-with-hint">
                  <button className="btn btn-primary" onClick={closeAuction} disabled={!!loading}>
                    Close Bid Window ({auctionState.bidCount} bids received)
                  </button>
                  <span className="action-hint">Bid window deadline has passed. Close the round to begin FHE clearing.</span>
                </div>
              )}

              {/* Resolve */}
              {connected && auctionState?.state === 1 && (
                <div className="action-with-hint">
                  <button className="btn btn-primary" onClick={resolvePass1} disabled={!!loading}>
                    Discover Highest Bid (FHE)
                  </button>
                  <span className="action-hint">N-1 homomorphic comparisons find the maximum encrypted bid. Pass 1 of two. Gas split for block-limit safety.</span>
                </div>
              )}
              {connected && auctionState?.state === 2 && (
                <div className="action-with-hint">
                  <button className="btn btn-primary" onClick={resolvePass2} disabled={!!loading}>
                    Compute Clearing Price (FHE)
                  </button>
                  <span className="action-hint">First-match exclusion of the winner; second tournament finds the clearing price (Vickrey 2nd-highest); winner index marked publicly decryptable.</span>
                </div>
              )}

              {/* Settle */}
              {connected && auctionState?.state === 3 && (
                <div className="action-with-hint">
                  <button className="btn btn-success" onClick={settle} disabled={!!loading}>
                    Settle Allocation
                  </button>
                  <span className="action-hint">On-chain FHE.eq verifies the off-chain-decrypted clearing price. Winner receives the lot; losers get encrypted refunds via ERC-7984.</span>
                </div>
              )}

              {/* Regulator Disclosure */}
              {connected && auctionState?.state === 4 && !complianceDone && (
                <div className="compliance-section">
                  <div className="compliance-tiers">
                    <div className="compliance-tier">
                      <div className="compliance-tier-label public">Public Disclosure</div>
                      <div className="compliance-tier-value">Clearing price: {formatPrice(auctionState.settledPrice)} per $100 face \u00b7 Yield: {impliedYield(auctionState.settledPrice).toFixed(2)}%</div>
                      <div className="compliance-tier-desc">Visible to everyone post-settlement (it's the payment amount)</div>
                    </div>
                    <div className="compliance-tier restricted">
                      <div className="compliance-tier-label restricted">Restricted Disclosure</div>
                      <div className="compliance-tier-value">Winner's actual bid: encrypted</div>
                      <div className="compliance-tier-desc">Selectively decryptable by addresses granted access \u2014 maps onto Reg D / 144A regimes</div>
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={revealCompliance} disabled={!!loading}>
                    Grant Regulator Decryption
                  </button>
                  <span className="action-hint">
                    {IS_TESTNET
                      ? `Only the winner (${auctionState.winnerAddress?.slice(0, 10)}...) or the issuer can grant access. Connected wallet must be one of them.`
                      : "The winner grants the regulator decryption access to the winning bid via FHE.allow."
                    }
                  </span>
                </div>
              )}

              {auctionState?.state === 4 && complianceDone && (
                <div className="completion-block success">
                  <span className="completion-icon">{"\u2713"}</span>
                  <div className="completion-text">
                    <strong>Issuance complete.</strong> Regulator decryption access granted. Losing bids remain encrypted.
                  </div>
                  <button className="btn btn-primary" onClick={resetForNewAuction} disabled={!!loading}>
                    New Issuance
                  </button>
                </div>
              )}

              {auctionState?.state === 5 && (
                <div className="completion-block cancelled">
                  <span className="completion-icon">{"\u2717"}</span>
                  <div className="completion-text">
                    <strong>Issuance cancelled.</strong> Below minimum QIB participation before the deadline. All deposits refundable.
                  </div>
                  <button className="btn btn-primary" onClick={resetForNewAuction} disabled={!!loading}>
                    New Issuance
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

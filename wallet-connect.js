// Clariona frontend — wallet connection
//
// Discovers every installed wallet extension (OKX Wallet, Rabby, MetaMask,
// Coinbase Wallet, etc.) via EIP-6963, the standard wallets use to announce
// themselves to dApps, and shows a picker so the user chooses which one to
// connect — instead of blindly grabbing whichever wallet happens to be
// window.ethereum (which breaks when multiple extensions are installed).
//
// Exposes window.clarionaWallet.provider — other scripts (mint-flow.js)
// should use THIS provider for all calls, not window.ethereum directly.

const NETWORKS = {
  mainnet: {
    chainId: "0xC4", // 196
    chainName: "X Layer",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: ["https://rpc.xlayer.tech"],
    blockExplorerUrls: ["https://www.okx.com/web3/explorer/xlayer"],
    contractAddress: "0xC19105eb061517D663075a3E040925BdD27B46c8",
  },
  testnet: {
    chainId: "0x7A0", // 1952
    chainName: "X Layer testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: ["https://testrpc.xlayer.tech/terigon"],
    blockExplorerUrls: ["https://www.okx.com/web3/explorer/xlayer-test"],
    contractAddress: "0xD1f0C370bDB616B8E5536294CCF6E081887B79A0",
  },
};

// Exposed so other scripts (recommend-console.js, the ledger loader) can
// build a read-only chain connection matching whichever network is
// currently toggled, without needing a wallet connected at all.
window.clarionaNetworks = NETWORKS;

let currentNetwork = "mainnet"; // toggled via the nav's network switch

window.clarionaWallet = {
  address: null,
  connected: false,
  provider: null, // the specific EIP-1193 provider the user picked
  network: "mainnet", // kept in sync with the nav toggle — read by other scripts
};

// --- EIP-6963 discovery ---
// Wallets announce themselves in response to this event; we collect them
// as they arrive. Dispatched once on load, so the list is populated by
// the time the user clicks "Connect Wallet".
const discoveredWallets = new Map(); // uuid -> { info, provider }

window.addEventListener("eip6963:announceProvider", (event) => {
  const { info, provider } = event.detail;
  discoveredWallets.set(info.uuid, { info, provider });
  renderWalletList();
});

function requestWalletAnnouncements() {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function shortenAddress(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function updateWalletButton() {
  const btn = document.getElementById("connect-wallet-btn");
  const disconnectBtn = document.getElementById("disconnect-wallet-btn");
  if (!btn) return;

  if (window.clarionaWallet.connected) {
    btn.textContent = shortenAddress(window.clarionaWallet.address);
    disconnectBtn?.classList.add("visible");
  } else {
    btn.textContent = "Connect Wallet";
    disconnectBtn?.classList.remove("visible");
  }
}

async function ensureXLayer(provider) {
  const target = NETWORKS[currentNetwork];
  const currentChainId = await provider.request({ method: "eth_chainId" });
  if (currentChainId === target.chainId) return true;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target.chainId }],
    });
    return true;
  } catch (switchError) {
    if (switchError.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [target],
      });
      return true;
    }
    throw switchError;
  }
}

async function connectWithProvider(provider, walletName) {
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    await ensureXLayer(provider);

    window.clarionaWallet.address = accounts[0];
    window.clarionaWallet.connected = true;
    window.clarionaWallet.provider = provider;
    updateWalletButton();
    closeWalletPicker();

    window.dispatchEvent(new CustomEvent("clariona:walletConnected", {
      detail: { address: accounts[0], walletName },
    }));

    // Keep the UI in sync if the user switches accounts in this wallet.
    provider.on?.("accountsChanged", (accounts) => {
      if (accounts.length === 0) {
        disconnectWallet();
      } else {
        window.clarionaWallet.address = accounts[0];
        updateWalletButton();
      }
    });
  } catch (err) {
    console.error("Wallet connection failed:", err);
    alert("Couldn't connect wallet — see console for details.");
  }
}

async function disconnectWallet() {
  try {
    await window.clarionaWallet.provider?.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    // Not supported by this wallet — fine, local disconnect still applies.
  }

  window.clarionaWallet.address = null;
  window.clarionaWallet.connected = false;
  window.clarionaWallet.provider = null;
  updateWalletButton();

  window.dispatchEvent(new CustomEvent("clariona:walletDisconnected"));
}

function updateNetworkToggleUI() {
  document.querySelectorAll(".net-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.network === currentNetwork);
  });
}

async function setNetwork(network) {
  if (network === currentNetwork) return;
  currentNetwork = network;
  window.clarionaWallet.network = network;
  updateNetworkToggleUI();

  // If already connected, switch the wallet over right away.
  if (window.clarionaWallet.connected && window.clarionaWallet.provider) {
    try {
      await ensureXLayer(window.clarionaWallet.provider);
    } catch (err) {
      console.error("Network switch failed:", err);
      alert("Couldn't switch networks in your wallet — see console for details.");
    }
  }

  // Always notify — discovery (search, ledger) should refresh even for
  // visitors who haven't connected a wallet at all.
  window.dispatchEvent(new CustomEvent("clariona:networkChanged", { detail: { network } }));
}

// --- Wallet picker modal ---
function renderWalletList() {
  const list = document.getElementById("wallet-picker-list");
  if (!list) return;

  const wallets = Array.from(discoveredWallets.values());

  if (wallets.length === 0) {
    list.innerHTML = `<p class="wallet-picker-empty">No wallet extensions detected. Install <a href="https://www.okx.com/web3" target="_blank" rel="noopener">OKX Wallet</a> or <a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a> to continue.</p>`;
    return;
  }

  list.innerHTML = "";
  wallets.forEach(({ info, provider }) => {
    const btn = document.createElement("button");
    btn.className = "wallet-option";
    btn.innerHTML = `<img src="${info.icon}" alt="${info.name}" /> <span>${info.name}</span>`;
    btn.addEventListener("click", () => connectWithProvider(provider, info.name));
    list.appendChild(btn);
  });
}

function openWalletPicker() {
  requestWalletAnnouncements(); // re-request in case a wallet was just installed
  renderWalletList();
  document.getElementById("wallet-picker-modal")?.classList.add("open");
}

function closeWalletPicker() {
  document.getElementById("wallet-picker-modal")?.classList.remove("open");
}

document.addEventListener("DOMContentLoaded", () => {
  requestWalletAnnouncements();

  document.querySelectorAll(".net-option").forEach((btn) => {
    btn.addEventListener("click", () => setNetwork(btn.dataset.network));
  });

  document.getElementById("connect-wallet-btn")?.addEventListener("click", () => {
    if (window.clarionaWallet.connected) return; // button shows address, not a picker trigger
    openWalletPicker();
  });

  document.getElementById("wallet-picker-close")?.addEventListener("click", closeWalletPicker);
  document.getElementById("disconnect-wallet-btn")?.addEventListener("click", disconnectWallet);

  document.getElementById("ask-clariona-btn")?.addEventListener("click", () => {
    document.getElementById("ask-console-section")?.scrollIntoView({ behavior: "smooth" });
  });

  document.getElementById("view-ledger-btn")?.addEventListener("click", () => {
    document.getElementById("live-ledger-section")?.scrollIntoView({ behavior: "smooth" });
  });

  document.getElementById("launch-app-btn")?.addEventListener("click", () => {
    if (!window.clarionaWallet.connected) {
      openWalletPicker();
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
});

// Clariona frontend — mint flow
//
// Wires the "Analyze an Asset" button to a mint form, calls
// mintVerifiedAsset() on the deployed contract, and lists the connected
// wallet's minted assets by reading the contract directly.
//
// SETUP: requires ethers.js (loaded via CDN below), and wallet-connect.js
// to run first so window.clarionaWallet exists.

const CONTRACT_ADDRESS = "0x433C4d2838EECCd0b8Ec47c0853884e771c03Cb1";

const CONTRACT_ABI = [
  "function mintVerifiedAsset(address to, string name, string assetType, uint16 riskScore, uint16 yieldBps, uint32 maturityDays) external returns (uint256)",
  "function getAsset(uint256 tokenId) view returns (string name, string assetType, uint16 riskScore, uint16 yieldBps, uint32 maturityDays, address owner)",
  "function totalMinted() view returns (uint256)",
];

function getContract(signerOrProvider) {
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signerOrProvider);
}

function openModal() {
  document.getElementById("mint-modal").classList.add("open");
}
function closeModal() {
  document.getElementById("mint-modal").classList.remove("open");
}

function setStatus(message, type) {
  const el = document.getElementById("mint-status");
  el.textContent = message;
  el.className = "modal-status" + (type ? ` ${type}` : "");
}

async function handleMintSubmit(e) {
  e.preventDefault();

  if (!window.clarionaWallet.connected) {
    setStatus("Connect your wallet first.", "error");
    return;
  }

  const name = document.getElementById("mint-name").value.trim();
  const assetType = document.getElementById("mint-type").value;
  const riskScore = Number(document.getElementById("mint-risk").value);
  const yieldPct = Number(document.getElementById("mint-yield").value);
  const maturityDays = Number(document.getElementById("mint-maturity").value);
  const yieldBps = Math.round(yieldPct * 100);

  try {
    setStatus("Confirm the transaction in your wallet...");
    const provider = new ethers.BrowserProvider(window.clarionaWallet.provider);
    const signer = await provider.getSigner();
    const contract = getContract(signer);

    const tx = await contract.mintVerifiedAsset(
      window.clarionaWallet.address,
      name,
      assetType,
      riskScore,
      yieldBps,
      maturityDays
    );

    setStatus("Minting — waiting for confirmation...");
    await tx.wait();

    setStatus("Minted! Refreshing your assets...", "ok");
    await loadMyAssets();
    setTimeout(closeModal, 1200);
  } catch (err) {
    console.error("Mint failed:", err);
    // onlyOwner will revert if the connected wallet isn't the contract owner —
    // in this demo, only the deployer wallet can successfully mint.
    if (String(err.message || "").includes("OwnableUnauthorizedAccount")) {
      setStatus("Only the verifier wallet can mint (demo restriction).", "error");
    } else {
      setStatus("Mint failed — see console for details.", "error");
    }
  }
}

async function loadMyAssets() {
  const grid = document.getElementById("my-assets-grid");

  if (!window.clarionaWallet.connected) {
    grid.innerHTML = `<p style="font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:var(--sage);">Connect your wallet to see your assets.</p>`;
    return;
  }

  grid.innerHTML = `<p style="font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:var(--sage);">Loading...</p>`;

  try {
    const provider = new ethers.BrowserProvider(window.clarionaWallet.provider);
    const contract = getContract(provider);
    const total = Number(await contract.totalMinted());

    const mine = [];
    for (let id = 0; id < total; id++) {
      const asset = await contract.getAsset(id);
      if (asset.owner.toLowerCase() === window.clarionaWallet.address.toLowerCase()) {
        mine.push(asset);
      }
    }

    if (mine.length === 0) {
      grid.innerHTML = `<p style="font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:var(--sage);">No assets minted to this wallet yet.</p>`;
      return;
    }

    grid.innerHTML = "";
    mine.forEach((asset) => {
      const card = document.createElement("div");
      card.className = "my-asset-card";
      card.innerHTML = `
        <h4>${asset.name}</h4>
        <p>${asset.assetType} · Risk ${asset.riskScore}/100 · ${(Number(asset.yieldBps) / 100).toFixed(2)}% yield · ${asset.maturityDays}-day maturity</p>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    console.error("Could not load assets:", err);
    grid.innerHTML = `<p style="font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:var(--rust);">Couldn't load assets — see console.</p>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("analyze-asset-btn")?.addEventListener("click", openModal);
  document.getElementById("mint-modal-close")?.addEventListener("click", closeModal);
  document.getElementById("mint-form")?.addEventListener("submit", handleMintSubmit);

  // Refresh the asset list once a wallet connects.
  window.addEventListener("clariona:walletConnected", loadMyAssets);
  // Reset it back to the empty-state prompt on disconnect.
  window.addEventListener("clariona:walletDisconnected", loadMyAssets);
  // Testnet and mainnet have separate mint histories — refresh on toggle.
  window.addEventListener("clariona:networkChanged", loadMyAssets);
});

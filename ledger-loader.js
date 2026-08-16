// Clariona frontend — Live Ledger loader
//
// Populates the "Live Ledger" table from real minted assets read
// straight from the contract (see chain-discovery.js) — every asset
// anyone has minted shows up here, for every visitor.

function riskPillClass(riskScore) {
  if (riskScore >= 80) return { cls: "risk-low", label: "Low" };
  if (riskScore >= 60) return { cls: "risk-mid", label: "Moderate" };
  return { cls: "risk-high", label: "High" };
}

async function loadLedger() {
  const body = document.getElementById("ledger-body");
  if (!body) return;

  body.innerHTML = `<p style="padding:20px 24px; font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:var(--sage);">Loading on-chain ledger...</p>`;

  let assets;
  try {
    assets = await window.clarionaFetchAllAssets();
  } catch (err) {
    console.error("Could not load ledger:", err);
    body.innerHTML = `<p style="padding:20px 24px; font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:var(--rust);">Couldn't reach the network — see console for details.</p>`;
    return;
  }

  if (assets.length === 0) {
    body.innerHTML = `<p style="padding:20px 24px; font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:var(--sage);">Nothing minted yet — be the first to originate an asset.</p>`;
    return;
  }

  body.innerHTML = "";
  assets.forEach((asset) => {
    const { cls, label } = riskPillClass(asset.risk_score);
    const row = document.createElement("div");
    row.className = "ledger-row";
    row.innerHTML = `
      <span class="asset-name">${asset.name}</span>
      <span>${asset.type}</span>
      <span><span class="risk-pill ${cls}">${label}</span></span>
      <span>${asset.yield_pct}%</span>
      <span class="verified">● Verified</span>
    `;
    body.appendChild(row);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadLedger();
  window.addEventListener("clariona:networkChanged", loadLedger);
  window.addEventListener("clariona:assetMinted", loadLedger);
});

// Clariona frontend — on-chain asset discovery
//
// Reads EVERY minted asset directly from the smart contract — not from
// a static list, and not scoped to any one wallet. This is what makes an
// asset minted by ANY user visible to EVERY visitor, in both the AI
// console and the Live Ledger. Works even for visitors with no wallet
// installed at all, since it uses a plain read-only RPC connection.

const DISCOVERY_CONTRACT_ABI = [
  "function getAsset(uint256 tokenId) view returns (string name, string assetType, uint16 riskScore, uint16 yieldBps, uint32 maturityDays, address owner)",
  "function totalMinted() view returns (uint256)",
];

async function fetchAllOnChainAssets() {
  const network = window.clarionaWallet?.network || "mainnet";
  const config = window.clarionaNetworks[network];
  const provider = new ethers.JsonRpcProvider(config.rpcUrls[0]);
  const contract = new ethers.Contract(config.contractAddress, DISCOVERY_CONTRACT_ABI, provider);

  const total = Number(await contract.totalMinted());
  const assets = [];

  for (let id = 0; id < total; id++) {
    const a = await contract.getAsset(id);
    assets.push({
      id,
      name: a.name,
      type: a.assetType,
      risk_score: Number(a.riskScore),
      yield_pct: Number(a.yieldBps) / 100,
      maturity_days: Number(a.maturityDays),
      owner: a.owner,
    });
  }

  return assets;
}

// Exposed globally so recommend-console.js and the ledger loader can both
// use it without duplicating the contract connection logic.
window.clarionaFetchAllAssets = fetchAllOnChainAssets;

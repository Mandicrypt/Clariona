// Clariona Data Layer — Ondo Finance RWA token fetcher
//
// Pulls on-chain supply/decimals/name directly from the OUSG and USDY
// contracts on Ethereum mainnet, plus live USD price from CoinGecko's
// free token-price endpoint (no API key required).
//
// Usage:
//   1. npm install
//   2. Set RPC_URL below (or via env var) to any Ethereum mainnet RPC.
//      Free options: https://eth.llamarpc.com, https://cloudflare-eth.com,
//      or your own Alchemy/Infura URL.
//   3. npm run fetch
//   4. Output is written to ./ondo-data.json — point your frontend at it,
//      or wire this script into a cron job / serverless function to
//      refresh it on a schedule.

import "dotenv/config";
import { ethers } from "ethers";
import fetch from "node-fetch";
import { writeFileSync } from "fs";

const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";

// Known Ondo RWA token contracts on Ethereum mainnet.
// Add more here as Clariona's supported asset list grows.
const TOKENS = [
  {
    key: "OUSG",
    address: "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92",
    label: "Ondo Short-Term U.S. Government Bond Fund",
  },
  {
    key: "USDY",
    address: "0x96F6eF951840721AdBF46Ac996b59E0235CB985C",
    label: "Ondo U.S. Dollar Yield",
  },
];

// Minimal ERC-20 ABI — just the read-only calls we need.
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

async function fetchOnChainData(provider, token) {
  const contract = new ethers.Contract(token.address, ERC20_ABI, provider);

  const [name, symbol, decimals, totalSupplyRaw] = await Promise.all([
    contract.name(),
    contract.symbol(),
    contract.decimals(),
    contract.totalSupply(),
  ]);

  return {
    ...token,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: ethers.formatUnits(totalSupplyRaw, decimals),
  };
}

async function fetchPrices(tokens) {
  const addresses = tokens.map((t) => t.address.toLowerCase()).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${addresses}&vs_currencies=usd`;

  // CoinGecko's fully keyless public endpoint is heavily rate-limited and
  // often returns 400s. A free "Demo" API key (no payment required) fixes
  // this — sign up at https://www.coingecko.com/en/api/pricing, grab the
  // key from the Developer Dashboard, then set it as COINGECKO_API_KEY.
  const apiKey = process.env.COINGECKO_API_KEY;
  const headers = apiKey ? { "x-cg-demo-api-key": apiKey } : {};

  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.warn(
      `Price fetch failed (${res.status}) — continuing without prices.` +
        (apiKey ? "" : " (Tip: set COINGECKO_API_KEY for a free demo key — see comment above.)")
    );
    return {};
  }
  return res.json();
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  console.log(`Fetching on-chain data for ${TOKENS.length} tokens...`);
  const onChainResults = await Promise.all(
    TOKENS.map((t) => fetchOnChainData(provider, t))
  );

  console.log("Fetching live prices...");
  const prices = await fetchPrices(TOKENS);

  const assets = onChainResults.map((t) => ({
    ...t,
    priceUsd: prices[t.address.toLowerCase()]?.usd ?? null,
  }));

  const output = {
    fetchedAt: new Date().toISOString(),
    source: "Ethereum mainnet (on-chain) + CoinGecko (price)",
    assets,
  };

  // BigInt values (which ethers uses for on-chain numbers) can't be
  // JSON.stringify'd directly — this replacer converts any that slip
  // through to plain strings so the output always writes cleanly.
  const bigIntSafe = (_key, value) =>
    typeof value === "bigint" ? value.toString() : value;

  const json = JSON.stringify(output, bigIntSafe, 2);
  writeFileSync("./ondo-data.json", json);
  console.log("Done. Wrote ondo-data.json");
  console.log(json);
}

main().catch((err) => {
  console.error("Fetch failed:", err);
  process.exit(1);
});

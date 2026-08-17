// Clariona Data Layer — live equities via Finnhub (free tier)
//
// Pulls real-time-ish quotes for a small set of tokenized-stock-relevant
// tickers. Free tier: 60 calls/minute, no credit card required.
//
// Usage:
//   1. npm install
//   2. Get a free key at https://finnhub.io/register
//   3. Set FINNHUB_API_KEY (env var, or in a .env file with dotenv)
//   4. npm run fetch
//   5. Output written to ./stocks-data.json

import "dotenv/config";
import fetch from "node-fetch";
import { writeFileSync } from "fs";

const API_KEY = process.env.FINNHUB_API_KEY;

// Matches the tickers already mentioned in Clariona's roadmap note for
// X Layer's native Chainlink Data Streams equities coverage.
const SYMBOLS = [
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "TSLA", name: "Tesla, Inc." },
  { symbol: "NVDA", name: "NVIDIA Corporation" },
];

async function fetchQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub returned ${res.status} for ${symbol}`);
  return res.json();
}

async function main() {
  if (!API_KEY) {
    console.error("FINNHUB_API_KEY is not set — get a free key at https://finnhub.io/register");
    process.exit(1);
  }

  console.log(`Fetching quotes for ${SYMBOLS.length} tickers...`);

  const assets = [];
  for (const { symbol, name } of SYMBOLS) {
    try {
      const q = await fetchQuote(symbol);
      assets.push({
        symbol,
        name,
        price: q.c,
        change: q.d,
        changePct: q.dp,
        high: q.h,
        low: q.l,
        open: q.o,
        previousClose: q.pc,
      });
    } catch (err) {
      console.warn(`Failed to fetch ${symbol}:`, err.message);
    }
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    source: "Finnhub (free tier)",
    assets,
  };

  writeFileSync("./stocks-data.json", JSON.stringify(output, null, 2));
  console.log("Done. Wrote stocks-data.json");
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("Fetch failed:", err);
  process.exit(1);
});

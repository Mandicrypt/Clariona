// Clariona frontend — recommendation console (client-side)
//
// Runs entirely in the browser. Assets now come from
// window.clarionaFetchAllAssets() (see chain-discovery.js) — i.e. REAL
// minted assets read live from the contract, not a fixed demo list. Any
// asset anyone mints becomes searchable here for every visitor.

let cachedAssets = null;

async function getAssets(forceRefresh = false) {
  if (cachedAssets && !forceRefresh) return cachedAssets;
  cachedAssets = await window.clarionaFetchAllAssets();
  return cachedAssets;
}

function parseQuery(query) {
  const q = query.toLowerCase();
  const filters = {};

  if (/\blow[- ]risk\b/.test(q)) {
    filters.minRiskScore = 80;
  } else if (/\bmoderate[- ]risk\b/.test(q)) {
    filters.minRiskScore = 60;
    filters.maxRiskScore = 84;
  } else if (/\bhigh[- ]risk\b/.test(q)) {
    filters.maxRiskScore = 60;
  }
  const riskAbove = q.match(/risk[^\d]{0,15}(above|over|>|greater than)\s*(\d+)/);
  if (riskAbove) filters.minRiskScore = Number(riskAbove[2]);
  const riskBelow = q.match(/risk[^\d]{0,15}(below|under|<|less than)\s*(\d+)/);
  if (riskBelow) filters.maxRiskScore = Number(riskBelow[2]);

  const maturityUnder = q.match(/(under|within|less than|<)\s*(\d+)[\s-]*day/);
  if (maturityUnder) filters.maxMaturityDays = Number(maturityUnder[2]);
  const maturityOver = q.match(/(over|above|more than|>)\s*(\d+)[\s-]*day/);
  if (maturityOver) filters.minMaturityDays = Number(maturityOver[2]);

  const yieldAbove = q.match(/yield(?:ing)?[^\d]{0,15}(above|over|>|greater than|at least)\s*(\d+(?:\.\d+)?)\s*%/);
  if (yieldAbove) filters.minYieldPct = Number(yieldAbove[2]);
  const yieldBelow = q.match(/yield(?:ing)?[^\d]{0,15}(below|under|<|less than)\s*(\d+(?:\.\d+)?)\s*%/);
  if (yieldBelow) filters.maxYieldPct = Number(yieldBelow[2]);
  if (filters.minYieldPct === undefined) {
    const bareAbove = q.match(/(above|over|>|at least)\s*(\d+(?:\.\d+)?)\s*%/);
    if (bareAbove) filters.minYieldPct = Number(bareAbove[2]);
  }

  if (/real estate|lease|warehouse|property/.test(q)) filters.type = "Real Estate";
  if (/trade finance|invoice|receivable|export/.test(q)) filters.type = "Trade Finance";

  return filters;
}

// Tradeable tokenized stocks are a separate universe from minted RWAs —
// they aren't scored by risk/yield/maturity, so they're matched by
// keyword/ticker/company-name instead and rendered as their own cards.
function parseStockMatches(query) {
  const q = query.toLowerCase();
  const meta = window.clarionaStockMeta || {};
  const nameHints = { AAPL: ["apple", "aapl"], TSLA: ["tesla", "tsla"], NVDA: ["nvidia", "nvda"] };

  const hit = Object.keys(meta).filter((symbol) =>
    (nameHints[symbol] || []).some((hint) => q.includes(hint))
  );
  if (hit.length > 0) return hit;

  if (/\b(stock|stocks|equity|equities|shares?)\b/.test(q)) {
    return Object.keys(meta);
  }
  return [];
}

function renderStockResults(container, symbols) {
  const stocksData = window.clarionaStocksData;
  const meta = window.clarionaStockMeta || {};

  symbols.forEach((symbol) => {
    const asset = stocksData ? stocksData.assets.find((a) => a.symbol === symbol) : null;
    const m = meta[symbol];
    if (!m) return;

    const card = document.createElement("div");
    card.className = "result-card stock-result-card";
    card.setAttribute("data-stock", symbol);
    card.innerHTML = `
      <span class="rc-badge">Tradeable Stock · OKX</span>
      <div class="rc-top"><h4>${m.name}</h4><span class="rc-yield">$${asset ? asset.price.toFixed(2) : "—"}</span></div>
      <p>${m.xTicker} · tokenized equity, price-linked to ${symbol}</p>
      <p class="rc-reason">Not a minted Clariona asset — trades on OKX. Click to buy or sell.</p>
    `;
    container.appendChild(card);
  });
}

function applyFilters(assets, f) {
  return assets.filter((a) => {
    if (f.minRiskScore !== undefined && a.risk_score < f.minRiskScore) return false;
    if (f.maxRiskScore !== undefined && a.risk_score > f.maxRiskScore) return false;
    if (f.minMaturityDays !== undefined && a.maturity_days < f.minMaturityDays) return false;
    if (f.maxMaturityDays !== undefined && a.maturity_days > f.maxMaturityDays) return false;
    if (f.minYieldPct !== undefined && a.yield_pct < f.minYieldPct) return false;
    if (f.maxYieldPct !== undefined && a.yield_pct > f.maxYieldPct) return false;
    if (f.type && a.type !== f.type) return false;
    return true;
  });
}

function explainMatch(asset, filters, results, rank) {
  const reasons = [];

  if (filters.minRiskScore !== undefined) {
    reasons.push(`risk score of ${asset.risk_score} clears your ${filters.minRiskScore}+ safety bar`);
  }
  if (filters.maxRiskScore !== undefined) {
    reasons.push(`risk score of ${asset.risk_score} stays under your ${filters.maxRiskScore} ceiling`);
  }
  if (filters.minYieldPct !== undefined) {
    reasons.push(`yields ${asset.yield_pct}%, above your ${filters.minYieldPct}% minimum`);
  }
  if (filters.maxYieldPct !== undefined) {
    reasons.push(`yields ${asset.yield_pct}%, under your ${filters.maxYieldPct}% cap`);
  }
  if (filters.maxMaturityDays !== undefined) {
    reasons.push(`matures in ${asset.maturity_days} days, inside your ${filters.maxMaturityDays}-day window`);
  }
  if (filters.minMaturityDays !== undefined) {
    reasons.push(`matures in ${asset.maturity_days} days, past your ${filters.minMaturityDays}-day minimum`);
  }
  if (filters.type) {
    reasons.push(`matches your focus on ${filters.type.toLowerCase()}`);
  }

  if (reasons.length === 0) {
    reasons.push(`one of the strongest overall risk/yield profiles among assets minted on Clariona so far`);
  }

  let sentence = reasons.join("; ");
  sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";

  if (results.length > 1) {
    if (rank === 0) {
      sentence += " Highest yield among your matches.";
    } else if (rank === results.length - 1) {
      sentence += " Lowest yield among your matches, but still qualifies.";
    }
  }

  return sentence;
}

async function runRecommendation(query) {
  const status = document.getElementById("recommend-status");
  const container = document.getElementById("recommend-results");

  status.textContent = "Reading on-chain assets...";
  container.innerHTML = "";

  let assets;
  try {
    assets = await getAssets();
  } catch (err) {
    console.error("Could not read assets from chain:", err);
    status.textContent = "Couldn't reach the network — see console for details.";
    return;
  }

  if (assets.length === 0) {
    status.textContent = "No assets have been minted on Clariona yet.";
    container.innerHTML = `<p style="color:var(--sage); font-family:'IBM Plex Mono', monospace; font-size:12.5px;">Be the first — originate an asset to see it here.</p>`;
    return;
  }

  const filters = parseQuery(query);
  const ranked = applyFilters(assets, filters).sort((a, b) => b.yield_pct - a.yield_pct);
  const results = ranked.map((asset, i) => ({
    ...asset,
    reason: explainMatch(asset, filters, ranked, i),
  }));

  const stockMatches = parseStockMatches(query);

  status.textContent = `Parsed with local matcher · ${assets.length} asset${assets.length === 1 ? "" : "s"} on-chain.`;

  if (results.length === 0 && stockMatches.length === 0) {
    container.innerHTML = `<p style="color:var(--sage); font-family:'IBM Plex Mono', monospace; font-size:12.5px;">No matching assets found — try loosening your filters.</p>`;
    return;
  }

  results.forEach((asset) => {
    const card = document.createElement("div");
    card.className = "result-card";
    card.innerHTML = `
      <div class="rc-top"><h4>${asset.name}</h4><span class="rc-yield">${asset.yield_pct}%</span></div>
      <p>${asset.maturity_days}-day maturity · Risk ${asset.risk_score}/100 · ${asset.type}</p>
      <p class="rc-reason">${asset.reason}</p>
    `;
    container.appendChild(card);
  });

  renderStockResults(container, stockMatches);
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("recommend-form");
  const input = document.getElementById("recommend-query");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value.trim()) runRecommendation(input.value.trim());
  });

  // Refresh from chain when the network toggle changes.
  window.addEventListener("clariona:networkChanged", () => {
    cachedAssets = null;
    if (input.value.trim()) runRecommendation(input.value.trim());
  });

  // Refresh immediately when any asset gets minted, so a fresh mint
  // shows up in search results without needing a page reload.
  window.addEventListener("clariona:assetMinted", () => {
    cachedAssets = null;
    if (input.value.trim()) runRecommendation(input.value.trim());
  });

  // Stock prices load async (separate fetch) — re-run once available so
  // tradeable-stock cards pick up a real price instead of showing "—".
  window.addEventListener("clariona:stocksLoaded", () => {
    if (input.value.trim()) runRecommendation(input.value.trim());
  });

  runRecommendation(input.value.trim());
});

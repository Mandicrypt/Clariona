// Clariona frontend — recommendation console (client-side)
//
// This runs the ENTIRE recommendation engine directly in the browser —
// no server needed. It used to call a local Node server at
// localhost:3001, which only worked on your own computer. This version
// works the same way for every visitor once the site is deployed.

const ASSETS = [
  {
    id: "lease-0231",
    name: "Retail Lease #0231 — Singapore",
    type: "Real Estate",
    risk_score: 84,
    risk_label: "Low",
    yield_pct: 7.4,
    maturity_days: 81,
    status: "Verified",
  },
  {
    id: "invoice-coffee-44",
    name: "Export Invoice — Coffee Batch 44, Brazil",
    type: "Trade Finance",
    risk_score: 71,
    risk_label: "Moderate",
    yield_pct: 11.2,
    maturity_days: 45,
    status: "Verified",
  },
  {
    id: "warehouse-rotterdam",
    name: "Warehouse Note — Rotterdam",
    type: "Real Estate",
    risk_score: 88,
    risk_label: "Low",
    yield_pct: 6.1,
    maturity_days: 62,
    status: "Verified",
  },
  {
    id: "receivable-118-dubai",
    name: "Cross-Border Receivable #118 — Dubai",
    type: "Trade Finance",
    risk_score: 68,
    risk_label: "Moderate",
    yield_pct: 9.8,
    maturity_days: 54,
    status: "Verified",
  },
];

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
    reasons.push(`one of the strongest overall risk/yield profiles in the current asset set`);
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

function runRecommendation(query) {
  const status = document.getElementById("recommend-status");
  const container = document.getElementById("recommend-results");

  const filters = parseQuery(query);
  const ranked = applyFilters(ASSETS, filters).sort((a, b) => b.yield_pct - a.yield_pct);
  const results = ranked.map((asset, i) => ({
    ...asset,
    reason: explainMatch(asset, filters, ranked, i),
  }));

  status.textContent = "Parsed with local matcher.";
  container.innerHTML = "";

  if (results.length === 0) {
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
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("recommend-form");
  const input = document.getElementById("recommend-query");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value.trim()) runRecommendation(input.value.trim());
  });

  runRecommendation(input.value.trim());
});

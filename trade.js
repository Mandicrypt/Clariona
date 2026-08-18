// Clariona frontend — trade module
//
// Handles the Buy/Sell modal for tokenized equities. Clariona does not
// execute trades itself: Buy/Sell hands off to OKX's DEX Aggregator,
// where these tokenized stocks (xStocks, e.g. XAAPL/XTSLA/XNVDA) actually
// trade against USDT. This keeps the on-chain minted-RWA side of Clariona
// (contract-verified, originated on X Layer) clearly separate from the
// tokenized-equity side (traded on OKX, not minted by Clariona).

const STOCK_META = {
  AAPL: { name: "Apple Inc.", xTicker: "XAAPL" },
  TSLA: { name: "Tesla, Inc.", xTicker: "XTSLA" },
  NVDA: { name: "NVIDIA Corporation", xTicker: "XNVDA" },
};

// OKX's list of Boost-eligible tokenized stocks — the safe, always-valid
// hand-off destination since we don't hold per-token contract addresses.
const OKX_STOCKS_URL = "https://web3.okx.com/token?ct=boost-stocks";

function getStockPrice(symbol) {
  const data = window.clarionaStocksData;
  if (!data) return null;
  const asset = data.assets.find((a) => a.symbol === symbol);
  return asset ? asset.price : null;
}

function openTradeModal(symbol) {
  const meta = STOCK_META[symbol];
  if (!meta) return;

  const price = getStockPrice(symbol);

  document.getElementById("trade-modal-title").textContent = `${meta.name} (${meta.xTicker})`;
  document.getElementById("trade-modal-sub").textContent =
    `Tokenized equity, price-linked to ${symbol}. Buy or sell ${meta.xTicker} on OKX.`;
  document.getElementById("trade-modal-symbol").textContent = meta.xTicker;
  document.getElementById("trade-modal-price").textContent =
    price != null ? price.toFixed(2) : "—";

  document.getElementById("trade-modal").classList.add("open");
}

function closeTradeModal() {
  document.getElementById("trade-modal").classList.remove("open");
}

document.addEventListener("DOMContentLoaded", () => {
  // Equity cards in Live Market Data
  const stocksGrid = document.getElementById("stocks-grid");
  if (stocksGrid) {
    stocksGrid.addEventListener("click", (e) => {
      const card = e.target.closest("[data-stock]");
      if (card) openTradeModal(card.getAttribute("data-stock"));
    });
  }

  // Stock result cards surfaced by the AI recommendation console
  const recommendResults = document.getElementById("recommend-results");
  if (recommendResults) {
    recommendResults.addEventListener("click", (e) => {
      const card = e.target.closest("[data-stock]");
      if (card) openTradeModal(card.getAttribute("data-stock"));
    });
  }

  document.getElementById("trade-modal-close").addEventListener("click", closeTradeModal);
  document.getElementById("trade-buy-btn").addEventListener("click", () => {
    window.open(OKX_STOCKS_URL, "_blank", "noopener");
  });
  document.getElementById("trade-sell-btn").addEventListener("click", () => {
    window.open(OKX_STOCKS_URL, "_blank", "noopener");
  });

  document.getElementById("trade-modal").addEventListener("click", (e) => {
    if (e.target.id === "trade-modal") closeTradeModal();
  });
});

// Exposed for recommend-console.js
window.clarionaStockMeta = STOCK_META;
window.clarionaOpenTradeModal = openTradeModal;

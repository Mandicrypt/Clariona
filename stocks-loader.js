// Clariona frontend — stocks data loader
//
// Fetches stocks-data.json (produced by stocks-data/fetch-stocks.js) and
// renders it into the equities cards.

async function loadStocksData() {
  try {
    const res = await fetch("/stocks-data.json");
    if (!res.ok) throw new Error(`Failed to load stocks-data.json (${res.status})`);
    const data = await res.json();

    // Expose globally so trade.js (Buy/Sell modal) and the AI recommendation
    // console can read live prices without a second fetch.
    window.clarionaStocksData = data;
    window.dispatchEvent(new CustomEvent("clariona:stocksLoaded"));

    data.assets.forEach((asset) => {
      const card = document.querySelector(`[data-stock="${asset.symbol}"]`);
      if (!card) return;

      card.querySelectorAll("[data-field]").forEach((el) => {
        const field = el.getAttribute("data-field");

        if (field === "price") {
          el.textContent = asset.price != null ? asset.price.toFixed(2) : "—";
        } else if (field === "name") {
          el.textContent = asset.name ?? "—";
        } else if (field === "changePct") {
          if (asset.changePct == null) {
            el.textContent = "—";
            return;
          }
          const sign = asset.changePct >= 0 ? "+" : "";
          el.textContent = `${sign}${asset.changePct.toFixed(2)}% today`;
          el.classList.toggle("up", asset.changePct >= 0);
          el.classList.toggle("down", asset.changePct < 0);
        }
      });
    });

    console.log("Stocks data loaded:", data.fetchedAt);
  } catch (err) {
    console.error("Could not load stocks data:", err);
  }
}

document.addEventListener("DOMContentLoaded", loadStocksData);

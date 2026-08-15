// Clariona frontend — Ondo asset data loader
//
// Fetches ondo-data.json and renders it into elements tagged with
// data-asset attributes.

async function loadOndoData() {
  try {
    const res = await fetch("ondo-data.json");
    if (!res.ok) throw new Error(`Failed to load ondo-data.json (${res.status})`);
    const data = await res.json();

    data.assets.forEach((asset) => {
      const cards = document.querySelectorAll(`[data-asset="${asset.key}"]`);
      cards.forEach((card) => {
        card.querySelectorAll("[data-field]").forEach((el) => {
          const field = el.getAttribute("data-field");
          let value = asset[field];

          if (field === "priceUsd") {
            value = value != null ? Number(value).toFixed(2) : "—";
          } else if (field === "totalSupply") {
            value = value != null
              ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })
              : "—";
          }

          el.textContent = value ?? "—";
        });
      });
    });

    console.log("Ondo data loaded:", data.fetchedAt);
  } catch (err) {
    console.error("Could not load Ondo asset data:", err);
  }
}

document.addEventListener("DOMContentLoaded", loadOndoData);

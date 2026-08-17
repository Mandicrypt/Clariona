// Clariona frontend — theme toggle
//
// Switches between dark (default) and light mode by setting a
// data-theme attribute on <html>, which the CSS variable overrides in
// index.html respond to. Persists the choice in localStorage.

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const saved = localStorage.getItem("clariona-theme");
  if (saved) applyTheme(saved);

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const next = isLight ? "dark" : "light";
    applyTheme(next);
    localStorage.setItem("clariona-theme", next);
  });
});

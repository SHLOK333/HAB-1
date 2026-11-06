// Floating dock: a vanilla port of Aceternity UI's FloatingDock (React + Motion + Tailwind in the
// original). Same layout and colours, the same magnification (40 to 80 px within 150 px of the
// pointer, icons 20 to 40 px), the same spring (mass 0.1, stiffness 150, damping 12) and the same
// tooltip; on small screens, the same collapse button. Icons: Tabler outline icons (MIT), inlined.
const ICON = {
  mission: '<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/>',
  protocol: '<path d="M18.364 19.364a9 9 0 1 0 -12.728 0"/><path d="M15.536 16.536a5 5 0 1 0 -7.072 0"/><path d="M12 13m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>',
  flights: '<path d="M14 8a2 2 0 0 0 -2 -2"/><path d="M6 8a6 6 0 1 1 12 0c0 4.97 -2.686 9 -6 9s-6 -4.03 -6 -9"/><path d="M12 17v1a2 2 0 0 1 -2 2h-3a2 2 0 0 0 -2 2"/>',
  zerog: '<path d="M5 5m0 1a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1z"/><path d="M9 9h6v6h-6z"/><path d="M3 10h2"/><path d="M3 14h2"/><path d="M10 3v2"/><path d="M14 3v2"/><path d="M21 10h-2"/><path d="M21 14h-2"/><path d="M14 21v-2"/><path d="M10 21v-2"/>',
  hedera: '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M14.8 9a2 2 0 0 0 -1.8 -1h-2a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4h-2a2 2 0 0 1 -1.8 -1"/><path d="M12 7v10"/>',
  arkiv: '<path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>',
  github: '<path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5"/>',
  collapse: '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M4 8h16"/><path d="M15 11l-3 3l-3 -3"/>',
}
const ITEMS = [
  ["Mission", "#/mission", "mission"], ["Radio protocol", "#/protocol", "protocol"], ["Flights", "#/flights", "flights"],
  ["0G · AI decisions", "#/zerog", "zerog"], ["Hedera · payments", "#/hedera", "hedera"], ["Arkiv · public data", "#/arkiv", "arkiv"],
  ["GitHub repo", "https://github.com/SHLOK333/HAB-1", "github"],
]
const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches

const dock = document.createElement("div")
dock.className = "fdock"
dock.innerHTML = `
  <nav class="fdock-desktop" aria-label="Quick navigation">${ITEMS.map(([t, h, k]) => `
    <a href="${h}" data-k="${k}"${h.startsWith("http") ? ' target="_blank" rel="noopener"' : ""} aria-label="${t}">
      <div class="fdock-item"><span class="fdock-tip" hidden>${t}</span><div class="fdock-icon">${svg(k)}</div></div>
    </a>`).join("")}
  </nav>
  <div class="fdock-mobile">
    <div class="fdock-mlist" hidden>${ITEMS.map(([t, h, k], i) => `
      <a href="${h}" data-k="${k}" style="--i:${i}"${h.startsWith("http") ? ' target="_blank" rel="noopener"' : ""} aria-label="${t}"><div class="fdock-micon">${svg(k)}</div></a>`).join("")}
    </div>
    <button type="button" class="fdock-toggle" aria-label="Open quick navigation" aria-expanded="false">${svg("collapse")}</button>
  </div>`
document.body.append(dock)

// ---- magnification with a spring per item (semi-implicit Euler, a few substeps per frame)
const items = [...dock.querySelectorAll(".fdock-item")].map(el => ({ el, icon: el.querySelector(".fdock-icon"), s: 40, v: 0, si: 20, vi: 0 }))
let mouseX = Infinity, raf = 0, last = 0
const lerp3 = (d, a, b) => { const x = Math.max(-150, Math.min(150, d)); return x <= 0 ? a + (b - a) * ((x + 150) / 150) : b + (a - b) * (x / 150) }
function frame(t) {
  const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016); last = t
  let moving = false
  for (const it of items) {
    const r = it.el.getBoundingClientRect(), d = mouseX - (r.left + window.scrollX + r.width / 2)
    const target = Number.isFinite(mouseX) ? lerp3(d, 40, 80) : 40, targetI = Number.isFinite(mouseX) ? lerp3(d, 20, 40) : 20
    for (let k = 0; k < 4; k++) {
      const h = dt / 4
      it.v += ((-150 * (it.s - target) - 12 * it.v) / 0.1) * h; it.s += it.v * h
      it.vi += ((-150 * (it.si - targetI) - 12 * it.vi) / 0.1) * h; it.si += it.vi * h
    }
    it.el.style.width = it.el.style.height = `${it.s}px`; it.icon.style.width = it.icon.style.height = `${it.si}px`
    if (Math.abs(it.s - target) > 0.05 || Math.abs(it.v) > 0.05 || Math.abs(it.si - targetI) > 0.05) moving = true
  }
  raf = moving ? requestAnimationFrame(frame) : 0; if (!raf) last = 0
}
const kick = () => { if (!raf && !reduced) raf = requestAnimationFrame(frame) }
const desk = dock.querySelector(".fdock-desktop")
desk.addEventListener("mousemove", e => { mouseX = e.pageX; kick() })
desk.addEventListener("mouseleave", () => { mouseX = Infinity; kick() })

// ---- tooltip
for (const a of desk.querySelectorAll("a")) {
  const tip = a.querySelector(".fdock-tip")
  a.addEventListener("mouseenter", () => { tip.hidden = false; tip.classList.remove("out"); void tip.offsetWidth; tip.classList.add("in") })
  a.addEventListener("mouseleave", () => { tip.classList.remove("in"); tip.classList.add("out"); setTimeout(() => { if (tip.classList.contains("out")) tip.hidden = true }, 160) })
  a.addEventListener("focus", () => { tip.hidden = false; tip.classList.add("in") })
  a.addEventListener("blur", () => { tip.hidden = true; tip.classList.remove("in") })
}

// ---- mobile: the collapse button fans the items out above it
const toggle = dock.querySelector(".fdock-toggle"), mlist = dock.querySelector(".fdock-mlist")
toggle.onclick = () => { const open = mlist.hidden; mlist.hidden = !open; toggle.setAttribute("aria-expanded", open); toggle.setAttribute("aria-label", open ? "Close quick navigation" : "Open quick navigation") }
for (const a of mlist.querySelectorAll("a")) a.addEventListener("click", () => { mlist.hidden = true; toggle.setAttribute("aria-expanded", "false") })

// ---- current page, and placement: over the map on Mission, floating at the bottom elsewhere
function place() {
  const page = (location.hash.match(/^#\/(\w+)/)?.[1]) || "mission"
  for (const a of dock.querySelectorAll("a[data-k]")) a.classList.toggle("cur", a.dataset.k === page)
  const mapwrap = document.querySelector(".mapwrap"), inMap = page === "mission" && mapwrap
  if (inMap && dock.parentElement !== mapwrap) mapwrap.append(dock)
  if (!inMap && dock.parentElement !== document.body) document.body.append(dock)
  dock.classList.toggle("in-map", !!inMap)
}
addEventListener("hashchange", place); place()

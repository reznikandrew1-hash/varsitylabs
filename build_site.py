#!/usr/bin/env python3
"""Build public/ (store) and private/ (owner dashboard) from ../varsity_labs.html.
Re-run after editing the store so the hosted site picks up changes."""
import os, re, shutil, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
# store sources live in ./src in the git repo, or one level up in the original iCloud layout
SRCDIR = os.path.join(HERE, "src") if os.path.isdir(os.path.join(HERE, "src")) else os.path.join(HERE, "..")
SRC = os.path.join(SRCDIR, "varsity_labs.html")
s = open(SRC, encoding="utf-8").read()
def cut(text, start, end, inclusive=True):
    i = text.index(start); j = text.index(end, i) + (len(end) if inclusive else 0)
    return text[i:j], text[:i] + text[j:]
def rep(text, a, b, n=1):
    assert text.count(a) == n, (text.count(a), a[:70]); return text.replace(a, b)

# ---- pull the owner pieces out of the store ----
CSS_START = "  /* ---------- owners dashboard (mock) ---------- */"
CSS_END = "  @media (max-width: 960px) { .ow-kpis { grid-template-columns: repeat(3, 1fr); } .ow-grid { grid-template-columns: 1fr; } .ow-detail { position: static; } .ow-who { grid-template-columns: 1fr; } }"
JS_START = "// ---------- owners dashboard (mock data, seeded so it is stable) ----------"
JS_END = "$(\"#owners\").addEventListener(\"keydown\", e => { if (e.key === \"Enter\" && e.target.id === \"owPin\") { const b = document.querySelector('[data-ow-act=\"login\"]'); if (b) b.click(); } });"
ow_css, pub = cut(s, CSS_START, CSS_END)
ow_js, pub = cut(pub, JS_START, JS_END)
pub = rep(pub, '<section id="owners"></section>\n', "")
pub = re.sub(r'  const ow = h\.match\(.*?\n  document\.body\.classList\.toggle\("owners-mode".*?\n  if \(ow\) \{.*?\n', "", pub, count=1, flags=re.S)
assert "owners-mode" not in pub.split("<script>")[-1], "route cleanup failed"
pub = rep(pub, '<a href="https://shopvarsitylabs.com/login" target="_blank" rel="noopener">Log in</a><a href="https://shopvarsitylabs.com/signup" target="_blank" rel="noopener">Sign up free</a><a href="https://shopvarsitylabs.com/reps" target="_blank" rel="noopener">Become a rep</a>', '<a href="/login">Log in</a><a href="/signup">Sign up free</a><a href="/reps">Become a rep</a>')
pub = rep(pub, '<a href="https://shopvarsitylabs.com/login" style="color:var(--ink-3);font-size:12px" target="_blank" rel="noopener">Log in</a>', '<a href="/login" style="color:var(--ink-3);font-size:12px">Log in</a>')
# checkout posts a real order (no charge)
pub = rep(pub, '  $("#coPay").onclick = () => toast("Payment processor not connected yet. This is the storefront preview.");', open(os.path.join(HERE, "hosted_checkout.js"), encoding="utf-8").read().rstrip("\n"))
pub = pub.replace('window.addEventListener("hashchange", route);', 'window.addEventListener("hashchange", route);\n(() => { try { const r = new URLSearchParams(location.search).get("reorder"); if (!r) return; const items = JSON.parse(r); if (!Array.isArray(items)) return; const ok = []; items.forEach(i => { const p = PRODUCTS.find(x => x[0] === i.name); const sz = p && p[2].find(s => s[0] === i.size); if (sz) ok.push({ name: i.name, size: i.size, price: sz[1], qty: Math.max(1, Math.min(50, +i.qty || 1)) }); else if (/ blend$/.test(i.name || "")) { const st = STACKS.find(x => x[0] + " blend" === i.name); if (st) ok.push({ name: i.name, size: i.size, price: st[2], qty: Math.max(1, Math.min(50, +i.qty || 1)) }); } }); if (ok.length) { state.cart = ok; save(); state.open = true; renderGrid(); renderCart(); history.replaceState(null, "", location.pathname + location.hash); } } catch (e) {} })();\n(async () => { try { const me = await fetch("/api/me").then(r => r.ok ? r.json() : null); if (me && me.role === "customer") { state.memberRate = me.memberRate || 0.15; state.member = me; renderCart(); } } catch (e) {} })();\n(async () => { try { const st = await fetch("/api/stock").then(r => r.json()); state.soldOut = st.soldOut || []; renderGrid(); } catch (e) {} try { const c = await fetch("/api/config").then(r => r.json()); if (c.nmiKey) { const sc = document.createElement("script"); sc.src = "https://secure.nmi.com/token/Collect.js"; sc.dataset.tokenizationKey = c.nmiKey; document.head.appendChild(sc); } } catch (e) {} })();', 1)
pub = pub.replace("https://shopvarsitylabs.com/", "/")
pub = pub.replace('<link rel="canonical" href="/">', '<link rel="canonical" href="https://shopvarsitylabs.com/">')
pub = pub.replace('"url":"/"', '"url":"https://shopvarsitylabs.com/"').replace('"logo":"/img/', '"logo":"https://shopvarsitylabs.com/img/')
pub = rep(pub, 'function applyPromo(raw) {\n  const p = resolvePromo(raw);', 'async function applyPromo(raw, quiet) {\n  let p = null; const codeN = (raw || "").trim().toUpperCase().replace(/\\s+/g, "");\n  if (codeN) { try { const r = await fetch("/api/promo?code=" + encodeURIComponent(codeN)); if (r.ok) p = await r.json(); } catch (e) { p = resolvePromo(raw); } }')
pub = rep(pub, 'else { state.promo = p; state.promoErr = ""; toast(p.rep ? `Rep code ${p.code} applied` : `${p.code} applied`); }', 'else { state.promo = p; state.promoErr = ""; if (!quiet) toast(p.rep ? `Rep code ${p.code} applied` : `${p.code} applied`); }')
pub = rep(pub, 'try { const pc = localStorage.getItem("vl-promo"); if (pc) state.promo = resolvePromo(pc); } catch (e) {}', 'try { const pc = localStorage.getItem("vl-promo"); if (pc) setTimeout(() => applyPromo(pc, true), 0); } catch (e) {}')
m_ = re.search(r'if \(u && resolvePromo\(u\)\) \{ state\.promo = resolvePromo\(u\);.*?\}', pub, re.S); assert m_, "code prefill"
pub = pub[:m_.start()] + 'if (u) { applyPromo(u); }' + pub[m_.end():]
pub = rep(pub, '<div class="pay"><b>Payment</b>Card and bank payment connect here once the processor is live. Nothing is charged in this preview.</div>',
               '<div class="pay"><b>Payment</b>Card payment connects here once the processor is live. Placing the order now sends it to us with nothing charged; we confirm by text before anything ships.</div>')
assert ".ow-" not in pub.split("<style>")[1].split("</style>")[0]

# ---- private dashboard page ----
head_css, _ = cut(s, "<style>\n", "  .wrap { max-width: 1100px; margin: 0 auto; padding: 0 24px; }", inclusive=False)
head_css = head_css[len("<style>\n"):]
toast_css = re.search(r"  \.toast \{[^\n]*\n", s).group(0)
products = re.search(r"const PRODUCTS = \[\n.*?\n\];\n", s, re.S).group(0)
campuses = re.search(r"const CAMPUSES = \[[^\n]*\n", s).group(0)
fonts = re.search(r'<link rel="preconnect"[^\n]*\n<link rel="stylesheet"[^\n]*\n', s).group(0)

js = ow_js
js = rep(js, 'try { OW.who = sessionStorage.getItem("vl-owner") || null; } catch (e) {}\n', "OW.mode = \"demo\"; OW.live = [];\n")
js = rep(js, "const TODAY = new Date(2026, 9, 3);", "let TODAY = new Date(2026, 9, 3);")
js = rep(js, "const RN = mulberry(20260930);", "let RN = mulberry(20260930);")
# wrap the mock generation so it can be rebuilt, and add a live builder
js = rep(js, "const ORDERS = []; let oid = 10240;", "let ORDERS = [], oid = 10240, SPAS = [], HOUSE_CUST = [];")
js = rep(js, "const HOUSE_CUST = [];\nfor (let d = 59; d >= 0; d--) {", "function buildMock() {\n  RN = mulberry(20261003); TODAY = new Date(2026, 9, 3); ORDERS = []; oid = 10240; HOUSE_CUST = []; CODES.forEach(c => c.customers = []);\nfor (let d = 59; d >= 0; d--) {")
js = rep(js, "const SPAS = [[", "SPAS = [[")
js = rep(js, "ORDERS.sort((a, b) => b.t - a.t);\n", '''ORDERS.sort((a, b) => b.t - a.t);
}
function buildLive(raw) {
  TODAY = new Date(); ORDERS = []; HOUSE_CUST = []; CODES.forEach(c => c.customers = []);
  const byEmail = {};
  raw.slice().sort((a, b) => new Date(a.t) - new Date(b.t)).forEach(o => {
    const cc = (o.code || "").toUpperCase(); let code = cc ? CX[cc] : null;
    if (cc && !code) { const m = cc.match(/^([A-Z]{2,4})-([A-Z0-9]{2,12})$/); code = { code: cc, kind: m && m[1] === "VL" ? "creator" : m ? "rep" : "house", campus: m ? m[1] : "", name: m ? m[2][0] + m[2].slice(1).toLowerCase() : cc, tier: m ? "Rep" : "House", rate: m ? .15 : 0, started: 0, w: 1, status: "active", src: "Site", phone: "", customers: [] }; CODES.push(code); CX[cc] = code; }
    const email = ((o.customer && o.customer.email) || "").toLowerCase() || o.id; let cust = byEmail[email];
    if (!cust) { const c = o.customer || {}; cust = { id: email, name: `${c.first || "Guest"} ${(c.last || "")[0] || ""}${c.last ? "." : ""}`, email: email.includes("@") ? email[0] + "***@" + email.split("@")[1] : "", campus: c.city || c.zip || "\\u2014", src: code ? code.src : "Site", orders: 0, spent: 0, first: null, last: null, sub: false }; byEmail[email] = cust; (code ? code.customers : HOUSE_CUST).push(cust); }
    const t = new Date(o.t); const items = o.items || []; const f = items[0] || { name: "Order", size: "", qty: 1 };
    const total = Math.round((o.totals && o.totals.total) || items.reduce((a, i) => a + i.price * i.qty, 0));
    const channel = code ? (code.kind === "rep" ? "Campus" : code.kind === "creator" ? "Influencers" : "Direct") : "Direct";
    ORDERS.push({ id: o.id, t, code: code ? code.code : "", cust, product: (o.test ? "TEST \\u00b7 " : "") + f.name + (items.length > 1 ? ` +${items.length - 1}` : ""), size: f.size, qty: f.qty, sub: !!o.sub, total, channel, recovered: false, newc: cust.orders === 0, status: o.status === "received" ? "Received" : (o.status || "Received"), pay: (Date.now() - t) < 30 * 864e5 && cust.orders === 0 ? "hold" : "clear" });
    cust.orders++; cust.spent += total; cust.first = cust.first || t; cust.last = t; cust.sub = cust.sub || !!o.sub; cust.lastProduct = f.name + " " + f.size;
  });
  ORDERS.sort((a, b) => b.t - a.t);
}
''')
js = rep(js, "const STATS = Object.fromEntries(CODES.map(c => [c.code, codeStats(c)]));", "let STATS = {};\nfunction computeStats() { STATS = Object.fromEntries(CODES.map(c => [c.code, codeStats(c)])); }\nfunction useMode(m) { OW.mode = \"live\"; buildLive(OW.live || []); computeStats(); }")
js = rep(js, '<em class="${delta >= 0 ? "up" : "dn"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta * 100).toFixed(0)}% vs prior 30</em>', '<em class="${k.prev ? (delta >= 0 ? "up" : "dn") : ""}">${k.prev ? (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta * 100).toFixed(0) + "% vs prior 30" : "first 30 days"}</em>')
js = rep(js, 'CX["FSU-LUIS"].status = "strike"; CX["FSU-LUIS"].flag = "Before/after post on Instagram, Sep 26. Code paused until the post is removed.";\nCX["FAMU-JADA"].status = "paused"; CX["FAMU-JADA"].flag = "No orders in 21 days. Auto-paused, manager notified.";\n', "")
js = rep(js, "ORDERS = []; oid = 10240; HOUSE_CUST = []; CODES.forEach(c => c.customers = []);", 'ORDERS = []; oid = 10240; HOUSE_CUST = []; CODES.forEach(c => { c.customers = []; c.status = "active"; c.flag = ""; }); CX["FSU-LUIS"].status = "strike"; CX["FSU-LUIS"].flag = "Before/after post on Instagram, Sep 26. Code paused until the post is removed."; CX["FAMU-JADA"].status = "paused"; CX["FAMU-JADA"].flag = "No orders in 21 days. Auto-paused, manager notified.";')
js = rep(js, "TODAY = new Date(); ORDERS = []; HOUSE_CUST = []; CODES.forEach(c => c.customers = []);", 'TODAY = new Date(); ORDERS = []; HOUSE_CUST = []; CODES.forEach(c => { c.customers = []; c.status = "active"; c.flag = ""; });')
js = rep(js, "function ownerKpis() { const o30", "function ownerKpis() { if (!ORDERS.length) return { rev: 0, prev: 0, orders: 0, aov: 0, subRate: 0, commPct: 0, newc: 0, comm: 0, mgrOv: 0 }; const o30")
# header: logout + live/demo switch instead of the mock switch-owner button
js = rep(js, '<span class="ow-demo">Demo data</span><button class="ow-btn ghost sm" data-ow-act="switch">Switch owner</button><a class="ow-btn ghost sm" href="#shop" style="text-decoration:none">Back to store</a>',
             '<span class="ow-pill ok" style="font-size:12px;padding:6px 10px">Live · ${OW.live.length} orders</span><a class="ow-btn ghost sm" href="/" style="text-decoration:none">Store</a><form method="post" action="/owners/logout" style="display:inline"><button class="ow-btn ghost sm" type="submit">Log out</button></form>')
js = rep(js, 'if (!OW.who) { el.innerHTML = `<div class="ow">${viewLogin()}</div>`; return; }', 'if (!OW.who) { el.innerHTML = `<div class="ow"><p class="ow-note">Loading\\u2026</p></div>`; return; }')
js = rep(js, "<p class=\"ow-note\">Demo dashboard. Every number is generated. When the card processor and Zoho are connected this reads live orders and the promo field at checkout.</p>",
             "<p class=\"ow-note\">${OW.live.length} orders placed on this site. Every number on this page comes from real orders, rep accounts and inventory.</p>")
js = rep(js, '    if (a === "switch") { OW.who = null; OW.pick = null; try { sessionStorage.removeItem("vl-owner"); } catch (x) {} renderOwners(); window.scrollTo(0, 0); return; }\n',
             '    if (a === "mode") { useMode(act.dataset.mode); renderOwners(); return; }\n')
js = re.sub(r'    if \(a === "login"\) \{.*?\n', "", js, count=1)
js = rep(js, "const lg = e.target.closest(\"[data-ow-login]\"); if (lg) { OW.pick = lg.dataset.owLogin; renderOwners(); const pin = $(\"#owPin\"); if (pin) pin.focus(); return; }\n", "")
js = rep(js, "if (OW.tab !== \"codes\") { location.hash = \"#owners/codes\"; } else renderOwners();", "if (OW.tab !== \"codes\") { location.hash = \"#owners/codes\"; } else renderOwners();")
js += '''
function routeOwners() { const m = location.hash.match(/^#owners\\/(overview|codes|orders|payouts)$/); OW.tab = m ? m[1] : "overview"; renderOwners(); window.scrollTo(0, 0); }
window.addEventListener("hashchange", routeOwners);
(async () => {
  try { const me = await fetch("/api/me").then(r => r.ok ? r.json() : null); if (!me) { location.href = "/owners/login"; return; } OW.who = me.user; } catch (e) { location.href = "/owners/login"; return; }
  try { const live = await fetch("/api/orders").then(r => r.ok ? r.json() : []); OW.live = Array.isArray(live) ? live : []; } catch (e) { OW.live = []; }
  useMode(OW.live.length ? "live" : "demo");
  routeOwners();
})();
'''
js = re.sub(r"function viewLogin\(\) \{.*?\n", "", js, count=1)
js = js.replace(JS_END, "")
assert "data-ow-login" not in js and "owPin" not in js

# ---- owners: real rep accounts, Reps tab ----
js = rep(js, "const CODES = [];", "let CODES = [];")
js = rep(js, "const CX = Object.fromEntries(CODES.map(c => [c.code, c]));", "let CX = Object.fromEntries(CODES.map(c => [c.code, c]));\nconst MOCK_CODES = CODES.slice();\nconst repToCode = r => ({ code: r.code, kind: \"rep\", campus: r.campus, name: r.name, tier: r.tier, rate: r.rate, started: 0, w: 1, status: r.status, src: \"Site\", phone: r.phone, email: r.email, real: true, mustChange: r.mustChange, lastLogin: r.lastLogin, created: r.created, flag: r.status === \"paused\" ? \"Paused by an owner. The rep can still log in; the code is off.\" : r.status === \"strike\" ? \"Strike on file. Payout held until an owner clears it.\" : \"\", customers: [] });")
js = rep(js, 'RN = mulberry(20261003); TODAY = new Date(2026, 9, 3); ORDERS = []; oid = 10240; HOUSE_CUST = []; CODES.forEach(', 'RN = mulberry(20261003); TODAY = new Date(2026, 9, 3); ORDERS = []; oid = 10240; HOUSE_CUST = []; CODES = MOCK_CODES.slice(); CX = Object.fromEntries(CODES.map(c => [c.code, c])); CODES.forEach(')
js = rep(js, 'TODAY = new Date(); ORDERS = []; HOUSE_CUST = []; CODES.forEach(c => { c.customers = []; c.status = "active"; c.flag = ""; });', 'TODAY = new Date(); ORDERS = []; HOUSE_CUST = []; CODES = (OW.promos || []).map(p => ({ code: p.code, kind: "house", campus: "", name: p.label || p.code, tier: "House", rate: 0, started: 0, w: 1, status: p.active === false ? "paused" : "active", src: "Site", flag: p.active === false ? "Turned off in Promo codes." : "", customers: [] })).concat((OW.reps || []).map(repToCode)); CX = Object.fromEntries(CODES.map(c => [c.code, c]));')
# overview: real alerts, no owner corners
m_ = re.search(r'  const alerts = \[\[.*?\]\];\n', js, re.S); assert m_, "alerts"
js = js[:m_.start()] + """  const alerts = []; const pend = (OW.apps || []).filter(a => a.status === "pending").length; if (pend) alerts.push(["warn", `${pend} rep application${pend > 1 ? "s" : ""} waiting on the Reps tab.`, "now"]);
  const unpaid = (OW.live || []).filter(o => !o.paid && !["cancelled", "refunded", "delivered"].includes(o.status)).length; if (unpaid) alerts.push(["warn", `${unpaid} order${unpaid > 1 ? "s" : ""} received but not paid yet. Text a payment link or mark paid on the Orders tab.`, "open"]);
  const so = Object.entries(OW.stock || {}).filter(([, q]) => q === 0).map(([k]) => k.replace("|", " ")); if (so.length) alerts.push(["bad", `Sold out on the store: ${so.join(", ")}. Update counts on the Inventory tab.`, "now"]);
  const low = Object.entries(OW.stock || {}).filter(([, q]) => q > 0 && q <= 5).map(([k]) => k.replace("|", " ")); if (low.length) alerts.push(["warn", `Running low: ${low.join(", ")}.`, "now"]);
  const temp = (OW.reps || []).filter(r => r.mustChange).length; if (temp) alerts.push(["ok", `${temp} rep${temp > 1 ? "s" : ""} still on a one-time password; they'll be asked to set their own at next login.`, "info"]);
  const outs = (OW.live || []).filter(o => o.status === "out").length; if (outs) alerts.push(["ok", `${outs} order${outs > 1 ? "s" : ""} out for delivery.`, "today"]);
  if (!alerts.length) alerts.push(["ok", "Nothing needs attention right now.", "now"]);
""" + js[m_.end():]
m_ = re.search(r'  const corner = OW\.who === "andrew" \? `.*?`;\n  return `', js, re.S); assert m_, "corner"
js = js[:m_.start()] + '  const corner = "";\n  return `' + js[m_.end():]
js = rep(js, 'const mgr = Object.entries(REPS).map(([camp, list]) => { const m = list.find(x => x[1] === "Manager"); if (!m) return null; const ov = list.filter(x => x[1] !== "Manager").reduce((a, [n]) => a + STATS[`${camp}-${n}`].rev * .05, 0); return [`${camp}-${m[0]}`, camp, ov]; }).filter(Boolean);',
             'const mgr = CODES.filter(c => c.kind === "rep" && c.tier === "Manager").map(m => [m.code, m.campus, CODES.filter(c => c.kind === "rep" && c.campus === m.campus && c.code !== m.code).reduce((a, c) => a + STATS[c.code].rev * .05, 0)]);')
js = rep(js, '[["overview", "Overview"], ["codes", "Promo codes"], ["orders", "Orders"], ["payouts", "Payouts"]]', '[["overview", "Overview"], ["orders", "Orders"], ["codes", "Promo codes"], ["reps", "Reps"], ["inventory", "Inventory"], ["payouts", "Payouts"], ["setup", "Setup"]]')
js = rep(js, 'OW.tab === "codes" ? viewCodes() : OW.tab === "orders"', 'OW.tab === "codes" ? viewCodes() : OW.tab === "reps" ? viewReps() : OW.tab === "inventory" ? viewInventory() : OW.tab === "setup" ? viewSetup() : OW.tab === "orders"')
js = rep(js, 'location.hash.match(/^#owners\\/(overview|codes|orders|payouts)$/)', 'location.hash.match(/^#owners\\/(overview|codes|reps|orders|payouts|inventory|setup)$/)')
js = rep(js, '  useMode(OW.live.length ? "live" : "demo");\n  routeOwners();', '  try { OW.reps = await fetch("/api/reps").then(r => r.ok ? r.json() : []); } catch (e) { OW.reps = []; }\n  try { OW.apps = await fetch("/api/applications").then(r => r.ok ? r.json() : []); } catch (e) { OW.apps = []; }\n  try { OW.stock = await fetch("/api/stock/all").then(r => r.ok ? r.json() : {}); } catch (e) { OW.stock = {}; }\n  try { OW.setup = await fetch("/api/setup").then(r => r.ok ? r.json() : null); } catch (e) { OW.setup = null; }\n  try { OW.promos = await fetch("/api/promos").then(r => r.ok ? r.json() : []); } catch (e) { OW.promos = []; }\n  useMode("live");\n  routeOwners();')
js = rep(js, '    if (a === "pause" && c) { c.status', '    if (a === "pause" && c && c.real) { repPatch(c.code, { status: c.status === "active" ? "paused" : "active" }); return; }\n    if (a === "strike" && c && c.real) { if (confirm("Add a strike to " + c.code + "? Their payout is held until you clear it.")) repPatch(c.code, { status: "strike" }); return; }\n    if (a === "reset" && c && c.real) { if (confirm("Reset the password for " + c.code + "? Their old one stops working.")) repReset(c.code); return; }\n    if (a === "remove" && c && c.real) { if (confirm("Remove " + c.code + "? They can no longer log in. Orders stay on record.")) repPatch(c.code, { status: "removed" }); return; }\n    if (a === "newrep") { createRep(); return; }\n    if (a === "copytemp") { const t = act.dataset.text; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("Copied"), () => prompt("Copy this:", t)); return; }\n    if (a === "closemodal") { $("#owModal").innerHTML = ""; return; }\n    if (a === "pause" && c) { c.status')
js = rep(js, '    if (a === "text" && c) { toast(`Demo: would open a text to ${c.name.split(" ")[0]}`); return; }', '    if (a === "text" && c) { if (c.real && c.phone) { location.href = "sms:" + c.phone.replace(/[^\\d+]/g, ""); return; } toast(`Demo: would open a text to ${c.name.split(" ")[0]}`); return; }')
js = rep(js, '<td class="r">${fm(o.total)}</td><td>${o.status}</td><td>${o.code && CX[o.code] && CX[o.code].rate', '<td class="r">${fm(o.total)}</td><td>${OW.mode === "live" ? `<select data-ow-status data-id="${o.id}" class="ow-sel">${["received","paid","packed","out","delivered","cancelled","refunded"].map(x => `<option ${String(o.status).toLowerCase() === x ? "selected" : ""}>${x}</option>`).join("")}</select>${o.qbo && o.qbo.invoiceId ? ` <span class="ow-pill ok" title="Invoice in QuickBooks">QB${o.qbo.paymentId ? " paid" : ""}</span>` : o.qbo && o.qbo.error ? ` <button class="ow-btn ghost sm" data-ow-act="qbo-retry" data-id="${o.id}" title="${String(o.qbo.error).replace(/"/g, "&quot;")}">Retry QB</button>` : ""}${o.zoho && o.zoho.dealId ? ` <span class="ow-pill ok" title="Deal in Zoho CRM">Zoho${o.zoho.won ? " won" : ""}</span>` : o.zoho && o.zoho.error ? ` <button class="ow-btn ghost sm" data-ow-act="zoho-retry" data-id="${o.id}" title="${String(o.zoho.error).replace(/"/g, "&quot;")}">Retry Zoho</button>` : ""}` : o.status}</td><td>${o.code && CX[o.code] && CX[o.code].rate')
js = rep(js, 'status: o.status === "received" ? "Received" : (o.status || "Received")', 'status: o.status || "received"')
js = rep(js, '<button class="ow-btn ghost sm" data-ow-act="statement" data-code="${sel.code}">Statement PDF</button></div>', '<button class="ow-btn ghost sm" data-ow-act="statement" data-code="${sel.code}">Statement PDF</button>${sel.real ? `<a class="ow-btn ghost sm" href="/portal?code=${sel.code}" target="_blank" rel="noopener" style="text-decoration:none">Their portal ↗</a><button class="ow-btn ghost sm" data-ow-act="reset" data-code="${sel.code}">Reset password</button>` : ""}</div>')
js += r"""
// ---------- rep accounts (real) ----------
async function repApi(method, path, body) { const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; }
async function reloadReps() { OW.reps = await fetch("/api/reps").then(r => r.ok ? r.json() : []); if (OW.mode === "live") useMode("live"); renderOwners(); }
async function repPatch(code, body) { try { await repApi("PATCH", "/api/reps/" + code, body); toast(code + " updated"); await reloadReps(); } catch (e) { toast(e.message); } }
async function repReset(code) { try { const j = await repApi("POST", "/api/reps/" + code + "/reset"); showTemp(j.rep, j.tempPassword, "Password reset"); await reloadReps(); } catch (e) { toast(e.message); } }
async function createRep() { const f = id => ($("#nr-" + id) || {}).value || ""; const body = { name: f("name"), campus: f("campus"), suffix: f("suffix"), tier: f("tier"), phone: f("phone"), email: f("email") }; if (!body.name || !body.suffix) { toast("Name and code are required"); return; } try { const j = await repApi("POST", "/api/reps", body); showTemp(j.rep, j.tempPassword, "Rep created"); await reloadReps(); } catch (e) { toast(e.message); } }
function showTemp(rep, temp, title) { const site = location.origin; const msg = `Hey ${rep.name.split(" ")[0]}, your Varsity Labs rep code is ${rep.code}. Log in at ${site}/login with code ${rep.code} and password ${temp}, then set your own password. Your link to share: ${site}/?code=${rep.code}`; $("#owModal").innerHTML = `<div class="ow-modal"><div class="ow-mbox"><h3>${title}: ${rep.code}</h3><p class="hint">This one-time password shows once. Text it to ${rep.name}; they'll be asked to set their own.</p><div class="ow-temp mono">${temp}</div><textarea class="ow-ta" readonly>${msg}</textarea><div class="ow-acts"><button class="ow-btn sm" data-ow-act="copytemp" data-text="${msg.replace(/"/g, "&quot;")}">Copy text message</button>${rep.phone ? `<a class="ow-btn ghost sm" href="sms:${rep.phone.replace(/[^\d+]/g, "")}&body=${encodeURIComponent(msg)}" style="text-decoration:none">Open in Messages</a>` : ""}<button class="ow-btn ghost sm" data-ow-act="closemodal">Done</button></div></div></div>`; }
function viewReps() {
  const reps = (OW.reps || []).slice().sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  const live = OW.mode === "live";
  const rows = reps.map(r => { const s = live && STATS[r.code] ? STATS[r.code] : null; return `<tr data-ow-code="${r.code}"><td class="ow-code">${r.code}</td><td>${r.name}<br><span style="color:var(--ink-3);font-size:11px">${r.phone || ""}${r.phone && r.email ? " · " : ""}${r.email || ""}</span></td><td><span class="ow-pill camp">${r.campus} · ${r.tier}</span></td><td>${r.status === "active" ? '<span class="ow-pill ok">active</span>' : r.status === "paused" ? '<span class="ow-pill warn">paused</span>' : '<span class="ow-pill bad">strike</span>'}${r.mustChange ? ' <span class="ow-pill warn" title="Has not set their own password yet">temp pw</span>' : ""}</td><td class="r">${s ? s.uses : "—"}</td><td class="r">${s ? fm(s.rev) : "—"}</td><td>${r.lastLogin ? ago(new Date(r.lastLogin)) : "never"}</td><td style="white-space:nowrap"><button class="ow-btn ghost sm" data-ow-act="pause" data-code="${r.code}">${r.status === "active" ? "Pause" : "Activate"}</button> <button class="ow-btn ghost sm" data-ow-act="reset" data-code="${r.code}">Reset pw</button> <a class="ow-btn ghost sm" href="/portal?code=${r.code}" target="_blank" rel="noopener" style="text-decoration:none">Portal ↗</a> <button class="ow-btn ghost sm" data-ow-act="remove" data-code="${r.code}" title="Remove">✕</button></td></tr>`; }).join("");
  return `<div class="ow-grid" style="grid-template-columns:minmax(0,5fr) minmax(0,7fr)"><div class="ow-card"><h3>Add a rep</h3><p class="hint">Creates their code and a one-time password you text them. Their link is the store with <span class="mono">?code=</span> on the end, so every order through it is theirs.</p>
    <div class="ow-form"><label>Name<input id="nr-name" placeholder="Jake Miller"></label><label>Campus<select id="nr-campus">${CAMPUSES.map(c => `<option>${c}</option>`).join("")}</select></label><label>Code<div class="ow-codein"><span id="nr-prefix">FSU-</span><input id="nr-suffix" placeholder="JAKE" style="text-transform:uppercase"></div></label><label>Tier<select id="nr-tier"><option>Rep</option><option>Senior</option><option>Manager</option></select></label><label>Phone<input id="nr-phone" placeholder="(850) 555-0100" inputmode="tel"></label><label>Email<input id="nr-email" placeholder="jake@fsu.edu" inputmode="email"></label></div>
    <div class="ow-acts"><button class="ow-btn sm" data-ow-act="newrep">Create rep + password</button></div>
    <p class="ow-note">Rates by tier: Rep 15%, Senior 18%, Manager 20% + 5% override. Change a tier later from the row.</p></div>
  <div class="ow-card"><div class="ch"><h3>Rep accounts</h3><span class="hint">${reps.length} real · ${live ? "live numbers" : "switch to Live for numbers"}</span></div><div class="ow-scroll"><table class="ow-table"><thead><tr><th>Code</th><th>Who</th><th>Campus</th><th>Status</th><th class="r">Uses 30d</th><th class="r">Rev 30d</th><th>Last login</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8" style="color:var(--ink-3)">No rep accounts yet. The campus codes in the demo are placeholders; add a real rep on the left.</td></tr>'}</tbody></table></div></div></div>`;
}
$("#owModal").addEventListener("click", e => { const act = e.target.closest("[data-ow-act]"); if (act) { if (act.dataset.owAct === "closemodal") { $("#owModal").innerHTML = ""; return; } if (act.dataset.owAct === "copytemp") { const t = act.dataset.text; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("Copied"), () => prompt("Copy this:", t)); return; } } if (e.target.classList.contains("ow-modal")) $("#owModal").innerHTML = ""; });
$("#owners").addEventListener("change", e => { if (e.target.id === "nr-campus") { const p = $("#nr-prefix"); if (p) p.textContent = e.target.value + "-"; } });
"""
js += open(os.path.join(HERE, "dashboard_extra.js"), encoding="utf-8").read()
js = rep(js, '  return `<div class="ow-grid" style="grid-template-columns:minmax(0,5fr) minmax(0,7fr)"><div class="ow-card"><h3>Add a rep</h3>', '  return viewApplications() + `<div class="ow-grid" style="grid-template-columns:minmax(0,5fr) minmax(0,7fr)"><div class="ow-card"><h3>Add a rep</h3>')
js = rep(js, '  return `<div class="ow-grid" style="grid-template-columns:minmax(0,7fr) minmax(0,5fr)"><div>${table}', '  return viewPromoAdmin() + `<div class="ow-grid" style="grid-template-columns:minmax(0,7fr) minmax(0,5fr)"><div>${table}')
owners_html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Dashboard · Varsity Labs</title>
{fonts}<style>
{head_css}
  .wrap {{ max-width: 1200px; margin: 0 auto; padding: 0 24px; }}
  .top {{ position: sticky; top: 0; z-index: 30; background: var(--surface); border-bottom: 1px solid var(--line); }}
  .top .wrap {{ display: flex; align-items: center; gap: 18px; height: 62px; }}
  .logo {{ display: flex; align-items: center; gap: 10px; text-decoration: none; }}
  .logo .v {{ width: 34px; height: 34px; background: var(--maroon); color: var(--maroon-ink); display: grid; place-items: center; font-family: "Big Shoulders Display", sans-serif; font-weight: 900; font-size: 26px; border-radius: 4px; }}
  .logo .n {{ font-family: "Big Shoulders Display", sans-serif; font-weight: 800; font-size: 24px; text-transform: uppercase; letter-spacing: .04em; }}
  .logo .n small {{ display: block; font-family: "Archivo", sans-serif; font-weight: 600; font-size: 10px; letter-spacing: .18em; color: var(--ink-3); margin-top: -3px; white-space: nowrap; }}
{toast_css}{ow_css}
  #owners {{ display: block; }}
  .ow-modal {{ position: fixed; inset: 0; background: rgba(0,0,0,.55); display: grid; place-items: center; z-index: 50; padding: 20px; }}
  .ow-mbox {{ background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; width: min(560px, 100%); box-shadow: var(--shadow); }}
  .ow-mbox h3 {{ margin: 0 0 4px; }}
  .ow-temp {{ font-size: 28px; font-weight: 600; letter-spacing: .08em; background: var(--gold-soft); color: var(--gold); border-radius: 10px; padding: 10px 14px; text-align: center; margin: 12px 0; }}
  .ow-ta {{ width: 100%; min-height: 110px; font: inherit; font-size: 13px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: var(--ink); resize: vertical; }}
  .ow-form {{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }}
  .ow-form label {{ display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }}
  .ow-form input, .ow-form select {{ font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--ink); text-transform: none; letter-spacing: 0; }}
  .ow-codein {{ display: flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); padding-left: 10px; font-family: "IBM Plex Mono", monospace; font-size: 14px; color: var(--ink-2); }}
  .ow-codein input {{ border: 0; flex: 1; min-width: 0; padding-left: 2px; font-family: "IBM Plex Mono", monospace; }}
  .ow-qty, .ow-sel {{ font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); color: var(--ink); }}
</style></head><body>
<header class="top"><div class="wrap"><a class="logo" href="/"><span class="v">V</span><span class="n">Varsity Labs<small>DASHBOARD</small></span></a></div></header>
<section id="owners"></section>
<div id="owModal"></div>
<div id="toastRoot"></div>
<script>
const $ = s => document.querySelector(s);
let tt; function toast(msg) {{ $("#toastRoot").innerHTML = `<div class="toast">${{msg}}</div>`; clearTimeout(tt); tt = setTimeout(() => $("#toastRoot").innerHTML = "", 2200); }}
{products}{campuses}
{js}
</script></body></html>
'''

# ---- write ----
pubdir, privdir = os.path.join(HERE, "public"), os.path.join(HERE, "private")
os.makedirs(pubdir, exist_ok=True); os.makedirs(privdir, exist_ok=True)

# ---- server-render the product grid and blend cards so crawlers (and no-JS visitors) see them ----
def _jsobj(name):
    m = re.search(r"const %s = (\[|\{)" % re.escape(name), s); assert m, name
    start = m.end() - 1; depth = 0; k = start
    while True:
        ch = s[k]
        if ch in "[{": depth += 1
        elif ch in "]}":
            depth -= 1
            if depth == 0: break
        k += 1
    return json.loads(re.sub(r",(\s*[\]}])", r"\1", s[start:k + 1]))
_PRODUCTS, _STACKS, _TESTED, _SLUG = _jsobj("PRODUCTS"), _jsobj("STACKS"), _jsobj("TESTED"), _jsobj("SLUG")
_CATS = ["All", "GLP Peptides", "Lyophilized Peptides", "Peptide Blends", "Secretagogues", "Regulators", "Supplies"]
def _money(n): return "$" + (f"{n:,.2f}" if n % 1 else f"{int(n):,}")
def _esc(t): return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
_cards = []
for idx, (name, cat, sizes, note, code) in enumerate(sorted(_PRODUCTS, key=lambda p: _CATS.index(p[1]))):
    sz, price = sizes[0]; te = _TESTED.get(name); slug = _SLUG[name]
    if cat == "Supplies": coa = ""
    elif te: coa = f'<a class="coa-link" href="/reports#{te[2]}" target="_blank" rel="noopener" title="Open the lab report for lot {te[1]}">View COA</a>'
    else: coa = '<a class="coa-link na" href="/reports" target="_blank" rel="noopener" title="Reports for every shipped lot">View COA</a>'
    _cards.append(f"""<div class="card" data-name="{_esc(name)}" data-reveal style="--i:{idx}">
      <a class="vial" href="#p/{slug}"><img src="img/t/p-{slug}.jpg?v=5" srcset="img/t/p-{slug}.jpg?v=5 480w, img/p-{slug}.jpg?v=5 1200w" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 260px" width="480" height="480" alt="{_esc(name)} vial" loading="{'eager' if idx < 8 else 'lazy'}" decoding="async"></a>
      <div class="cb">
        <div class="cat">{_esc(cat)}</div>
        <h3><a href="#p/{slug}">{_esc(name)}</a></h3>
        <div class="sizes">{"".join(f'<button aria-pressed="{"true" if i == 0 else "false"}" data-i="{i}">{_esc(sv[0])}</button>' for i, sv in enumerate(sizes))}</div>
        <div class="row"><span class="price">{_money(price)}<small>{_esc(sz)}</small></span>{coa}</div>
        <button class="add">Add to cart</button>
      </div>
    </div>""")
_stacks = []
for k, (n, items, price, was) in enumerate(_STACKS):
    _stacks.append(f"""<div class="card stack" data-reveal style="--i:{k}"><div class="vials"></div>
    <div class="cb"><div class="cat">Blend</div><h3>{_esc(n)}</h3><ul>{"".join(f"<li>{_esc(i)}</li>" for i in items)}</ul>
    <div class="row"><span class="price">{_money(price)}<s>{_money(was)}</s></span><span class="save">Save {_money(was - price)} vs vials</span></div>
    <button class="add" data-stack="{_esc(n)}">Add to cart</button></div></div>""")
pub = rep(pub, '<div class="grid" id="grid"></div>', '<div class="grid" id="grid">' + "\n".join(_cards) + '</div>')
pub = rep(pub, '<div class="stacks" id="stackGrid"></div>', '<div class="stacks" id="stackGrid">' + "\n".join(_stacks) + '</div>')
pub = rep(pub, '<p id="shopCount"></p>', '<p id="shopCount">%d of %d products</p>' % (len(_PRODUCTS), len(_PRODUCTS)))

_i = pub.find('<header class="top"')
assert _i > 0, "body start not found"
pub = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">\n' + pub[:_i] + '</head><body>\n' + pub[_i:] + '\n</body></html>\n'
# Links that stay on our own site open in the same tab (store, lab reports, reps, policies, login).
# External links (supplier, lab verification portal) keep opening a new tab.
pub = re.sub(r'href="https://shopvarsitylabs\.com(/[^"]*)"', r'href="\1"', pub)
pub = re.sub(r'(<a\b[^>]*?href="(?:/|\$\{COA\})[^"]*"[^>]*?)\s+target="_blank"(?:\s+rel="noopener")?', r'\1', pub)
open(os.path.join(pubdir, "index.html"), "w", encoding="utf-8").write(pub)
cat = {}
for m_ in re.finditer(r'^\s+\["([^"]+)", "[^"]+", \[((?:\["[^"]+", \d+\](?:, )?)+)\]', products, re.M):
    for sz, pr in re.findall(r'\["([^"]+)", (\d+)\]', m_.group(2)): cat[f"{m_.group(1)}|{sz}"] = int(pr)
assert len(cat) >= 30, len(cat)
json.dump(cat, open(os.path.join(pubdir, "catalog.json"), "w"), indent=0)
open(os.path.join(privdir, "owners.html"), "w", encoding="utf-8").write(owners_html)
portal = open(os.path.join(HERE, "portal_src.html"), encoding="utf-8").read()
for k, v in {"%%FONTS%%": fonts, "%%HEAD_CSS%%": head_css, "%%TOAST_CSS%%": toast_css, "%%OW_CSS%%": ow_css}.items():
    assert portal.count(k) == 1, k; portal = portal.replace(k, v)
open(os.path.join(privdir, "portal.html"), "w", encoding="utf-8").write(portal)
img_src, img_dst = os.path.join(SRCDIR, "img"), os.path.join(pubdir, "img")
if os.path.isdir(img_dst): shutil.rmtree(img_dst)
shutil.copytree(img_src, img_dst, ignore=shutil.ignore_patterns("*.tsv"))
open(os.path.join(pubdir, "robots.txt"), "w").write("User-agent: *\nDisallow: /owners\nDisallow: /portal\nDisallow: /api/\nDisallow: /login\nSitemap: https://shopvarsitylabs.com/sitemap.xml\n")
open(os.path.join(pubdir, "googlee83887d827b3cfb5.html"), "w").write("google-site-verification: googlee83887d827b3cfb5.html")
import datetime as _dt
_today = _dt.date.today().isoformat()
open(os.path.join(pubdir, "sitemap.xml"), "w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"  <url><loc>https://shopvarsitylabs.com{u}</loc><lastmod>{_today}</lastmod></url>\n" for u in ["/", "/reports", "/reps", "/policies"]) + "</urlset>\n")
STORE_ART = "https://claude.ai/code/artifact/983fcaf3-204b-4842-8353-b48c1440141b"
coa_html = open(os.path.join(SRCDIR, "varsity_coa.html"), encoding="utf-8").read().replace(STORE_ART, "/")
if "<meta charset" not in coa_html: coa_html = '<meta charset="utf-8">\n' + coa_html
if 'name="viewport"' not in coa_html: coa_html = coa_html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">', 1)
open(os.path.join(pubdir, "reports.html"), "w", encoding="utf-8").write(coa_html)
coa_src, coa_dst = os.path.join(SRCDIR, "coa"), os.path.join(pubdir, "coa")
if os.path.isdir(coa_dst): shutil.rmtree(coa_dst)
shutil.copytree(coa_src, coa_dst)
reps_html = open(os.path.join(SRCDIR, "varsity_reps.html"), encoding="utf-8").read().replace(STORE_ART, "/").replace("https://claude.ai/code/artifact/01302c42-f8af-4eb1-acdf-f4d9ccff3845", "/reports")
if "<meta charset" not in reps_html: reps_html = '<meta charset="utf-8">\n' + reps_html
if 'name="viewport"' not in reps_html: reps_html = reps_html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">', 1)
reps_html = re.sub(r'let dbp = null;\ntry \{ dbp = .*?\n', "", reps_html, count=1)
OLD_SAVE = 'try { const db = await dbp; if (db) { await db.collection("reps").add(rec); saved = true; } } catch (ex) { saved = false; }'
assert OLD_SAVE in reps_html
reps_html = reps_html.replace(OLD_SAVE, 'try { const r = await fetch("/api/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) }); saved = r.ok; } catch (ex) { saved = false; }')
assert "window.claude" not in reps_html
open(os.path.join(pubdir, "reps.html"), "w", encoding="utf-8").write(reps_html)
print("built public/index.html", len(pub), "private/owners.html", len(owners_html), "private/portal.html", len(portal), "img files", len(os.listdir(img_dst)))

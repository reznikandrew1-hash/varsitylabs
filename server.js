// Varsity Labs site server. No dependencies: Node built-ins only.
// Public store at /, owner dashboard at /owners behind a signed-cookie login,
// orders API that the store's checkout posts to and the dashboard reads.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const PRIV = path.join(ROOT, "private");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const REPS_FILE = path.join(DATA_DIR, "reps.json");
const STOCK_FILE = path.join(DATA_DIR, "inventory.json");
const APPS_FILE = path.join(DATA_DIR, "applications.json");
const PROMOS_FILE = path.join(DATA_DIR, "promos.json");
const DEFAULT_PROMOS = [
  { code: "VARSITY10", type: "pct", value: 10, label: "10% off your first order", min: 0, active: true },
  { code: "STACKUP", type: "flat", value: 15, label: "$15 off any blend order over $150", min: 150, active: true },
  { code: "FREESHIP", type: "ship", value: 0, label: "Free shipping on this order", min: 0, active: true },
  { code: "TEAMDAY", type: "pct", value: 12, label: "12% off, team and club orders", min: 200, active: true },
];
let CATALOG = {};
try { CATALOG = JSON.parse(fs.readFileSync(path.join(PUB, "catalog.json"), "utf8")); } catch { console.warn("catalog.json missing; item prices will not be verified"); }
const TAX_FILE = path.join(ROOT, "tax.json");
const ENV = {
  nmiPublic: process.env.NMI_PUBLIC_KEY || "", nmiSecret: process.env.NMI_SECURITY_KEY || "",
  crypto: process.env.CRYPTO_CHECKOUT_URL || "",
  resend: process.env.RESEND_API_KEY || "", fromEmail: process.env.FROM_EMAIL || "", notifyEmail: process.env.NOTIFY_EMAIL || "",
  twSid: process.env.TWILIO_SID || "", twToken: process.env.TWILIO_TOKEN || "", twFrom: process.env.TWILIO_FROM || "", ownerPhone: process.env.OWNER_PHONE || "",
  tax: process.env.TAX_ENABLED === "1", site: process.env.SITE_URL || "",
  // Local testing only: TEST_PAYMENTS=1 simulates card payments. Ignored on Railway / in production.
  testPay: process.env.TEST_PAYMENTS === "1" && process.env.NODE_ENV !== "production" && !process.env.RAILWAY_ENVIRONMENT,
};
if (ENV.testPay) console.warn("TEST_PAYMENTS on: card payments are simulated, nothing is charged");
const CAMPUSES = ["FSU", "UM", "KEISER", "UF", "UCF", "USF", "FIU", "FAU", "FAMU", "UNF", "FGCU", "UWF", "NOVA", "LYNN", "PBSC", "UT", "STETSON", "ROLLINS", "TCC", "MDC", "BC", "VALENCIA", "FL", "VL"];
const TIER_RATE = { Rep: 0.15, Senior: 0.18, Manager: 0.20 };
const SESSION_HOURS = 12;
const SECRET = process.env.SESSION_SECRET || (() => { console.warn("SESSION_SECRET not set; sessions reset on every restart"); return crypto.randomBytes(32).toString("hex"); })();
// Owner logins come from Railway variables: every OWNER_<NAME>_PASSWORD makes an owner who signs in as <name>.
// Andrew and Aiden are always listed so the setup checklist can show them as missing.
const OWNERS = { andrew: { name: "Andrew", pass: "" }, aiden: { name: "Aiden", pass: "" } };
for (const [k, v] of Object.entries(process.env)) {
  const m = /^OWNER_([A-Z][A-Z0-9]{0,30})_PASSWORD$/.exec(k); if (!m) continue;
  const key = m[1].toLowerCase(); OWNERS[key] = { name: key[0].toUpperCase() + key.slice(1), pass: v || "" };
}
const SECURE = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]\n");
if (!fs.existsSync(REPS_FILE)) fs.writeFileSync(REPS_FILE, "[]\n");
if (!fs.existsSync(STOCK_FILE)) fs.writeFileSync(STOCK_FILE, "{}\n");
if (!fs.existsSync(APPS_FILE)) fs.writeFileSync(APPS_FILE, "[]\n");
if (!fs.existsSync(PROMOS_FILE)) fs.writeFileSync(PROMOS_FILE, JSON.stringify(DEFAULT_PROMOS, null, 1) + "\n");

// ---------- helpers ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf", ".xml": "application/xml; charset=utf-8" };
const b64u = b => Buffer.from(b).toString("base64url");
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const safeEq = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ip = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN", ...headers });
  res.end(body);
}
const json = (res, code, obj, extra = {}) => send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
const redirect = (res, to, extra = {}) => send(res, 303, "", { Location: to, ...extra });

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function parseCookies(req) { const out = {}; (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return out; }
function parseForm(s) { const out = {}; new URLSearchParams(s).forEach((v, k) => out[k] = v); return out; }

// ---------- reps store ----------
function loadReps() { try { return JSON.parse(fs.readFileSync(REPS_FILE, "utf8")); } catch { return []; } }
let repsWriting = Promise.resolve();
function saveReps(list) { repsWriting = repsWriting.then(() => { const tmp = REPS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, REPS_FILE); }); return repsWriting; }
function hashPw(pw) { const salt = crypto.randomBytes(16).toString("hex"); return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex"); }
function checkPw(pw, stored) { if (!stored) return false; const [salt, h] = stored.split(":"); try { return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(h, "hex")); } catch { return false; } }
function tempPassword() { const a = "abcdefghjkmnpqrstuvwxyz23456789"; let o = ""; for (let i = 0; i < 10; i++) o += a[crypto.randomInt(a.length)]; return o.slice(0, 5) + "-" + o.slice(5); }
const publicRep = r => ({ code: r.code, name: r.name, campus: r.campus, tier: r.tier, rate: TIER_RATE[r.tier] || 0.15, phone: r.phone || "", email: r.email || "", status: r.status || "active", created: r.created, lastLogin: r.lastLogin || null, mustChange: !!r.mustChange });
const maskEmail = e => { e = String(e || ""); const i = e.indexOf("@"); return i > 0 ? e[0] + "***@" + e.slice(i + 1) : ""; };
const repOrders = (all, code) => all.filter(o => o.code === code && !o.test).map(o => ({ id: o.id, t: o.t, code: o.code, customer: { first: o.customer.first, last: (o.customer.last || "")[0] || "", email: maskEmail(o.customer.email), city: o.customer.city, zip: o.customer.zip, key: crypto.createHash("sha256").update(o.customer.email || o.id).digest("hex").slice(0, 12) }, items: o.items, sub: o.sub, totals: o.totals, status: o.status }));

// ---------- inventory ----------
function loadStock() { try { return JSON.parse(fs.readFileSync(STOCK_FILE, "utf8")); } catch { return {}; } }
let stockWriting = Promise.resolve();
function saveStock(m) { stockWriting = stockWriting.then(() => { const tmp = STOCK_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, STOCK_FILE); }); return stockWriting; }
const stockKey = (name, size) => `${name}|${size}`;
const soldOut = m => Object.entries(m).filter(([, q]) => q === 0).map(([k]) => k);

// ---------- rep applications ----------
function loadApps() { try { return JSON.parse(fs.readFileSync(APPS_FILE, "utf8")); } catch { return []; } }
let appsWriting = Promise.resolve();
function saveApps(list) { appsWriting = appsWriting.then(() => { const tmp = APPS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, APPS_FILE); }); return appsWriting; }

// ---------- promo codes (house list + active rep codes) ----------
function loadPromos() { try { return JSON.parse(fs.readFileSync(PROMOS_FILE, "utf8")); } catch { return DEFAULT_PROMOS; } }
let promosWriting = Promise.resolve();
function savePromos(list) { promosWriting = promosWriting.then(() => { const tmp = PROMOS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, PROMOS_FILE); }); return promosWriting; }
const normCode = raw => String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
function resolveCode(raw) {
  const code = normCode(raw); if (!code) return null;
  const h = loadPromos().find(p => p.code === code && p.active !== false);
  if (h) return { code, type: h.type, value: +h.value || 0, label: h.label || code, min: +h.min || 0, rep: false };
  const r = loadReps().find(x => x.code === code && x.status === "active");
  if (r) return { code, type: "pct", value: 10, label: "Rep code, 10% off your first order", min: 0, rep: true, repName: (r.name.split(" ")[0] || r.code).toUpperCase(), campus: r.campus };
  return null;
}
const r2 = n => Math.round(n * 100) / 100;
function priceOrder(items, subscribe, promo, zip, rate = 0.10) {
  const sub = r2(items.reduce((a, i) => a + i.price * i.qty, 0));
  const disc = subscribe ? r2(sub * rate) : 0;
  let pdisc = 0, pship = false;
  if (promo) { const base = sub - disc; if (base >= (promo.min || 0)) { if (promo.type === "pct") pdisc = r2(base * promo.value / 100); else if (promo.type === "flat") pdisc = Math.min(base, r2(promo.value)); else if (promo.type === "ship") pship = true; } }
  const local = /^323\d\d$/.test(String(zip || "")); const freeAt = local ? 100 : 250; const net = r2(sub - disc - pdisc);
  const ship = pship || net >= freeAt || net === 0 ? 0 : (local ? 8 : 12);
  return { sub, disc, pdisc, ship, local };
}

// ---------- sales tax (Florida, by ZIP prefix; rates editable in tax.json) ----------
let TAX = { default: 0.07, zip3: {} };
try { TAX = JSON.parse(fs.readFileSync(TAX_FILE, "utf8")); } catch {}
function taxRate(zip) { if (!ENV.tax) return 0; const z = String(zip || ""); if (!/^3[2-4]\d{3}$/.test(z)) return 0; return TAX.zip3[z.slice(0, 3)] ?? TAX.default; }

// ---------- notifications (email via Resend, SMS via Twilio) when keys exist ----------
async function sendEmail(to, subject, text) {
  if (!ENV.resend || !ENV.fromEmail || !to) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + ENV.resend, "Content-Type": "application/json" }, body: JSON.stringify({ from: ENV.fromEmail, to: [to], subject, text }) }); return r.ok; } catch (e) { console.error("email", e.message); return false; }
}
async function sendSms(to, body) {
  if (!ENV.twSid || !ENV.twToken || !ENV.twFrom || !to) return false;
  const num = String(to).replace(/[^\d+]/g, ""); if (num.length < 10) return false;
  try { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ENV.twSid}/Messages.json`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(ENV.twSid + ":" + ENV.twToken).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: ENV.twFrom, To: num.startsWith("+") ? num : "+1" + num.slice(-10), Body: body }) }); return r.ok; } catch (e) { console.error("sms", e.message); return false; }
}
function notifyOrder(o) {
  const items = o.items.map(i => `${i.qty}x ${i.name} ${i.size}`).join(", ");
  const total = o.totals ? "$" + o.totals.total.toFixed(2) : "";
  const cust = o.customer || {};
  const msg = `${o.test ? "[TEST] " : ""}Varsity Labs order ${o.id} received: ${items}. ${total}. ${o.paid ? "Paid." : "Nothing charged yet; we'll text you to confirm."} For research use only.`;
  sendSms(cust.phone, msg).then(ok => ok && console.log(JSON.stringify({ event: "sms", id: o.id })));
  sendEmail(cust.email, `Order ${o.id} received`, msg + `\n\nShip to: ${cust.first} ${cust.last}, ${cust.street}, ${cust.city} ${cust.zip}\n\nAll products are for laboratory research use only and are not for human or veterinary use.`).then(ok => ok && console.log(JSON.stringify({ event: "email", id: o.id })));
  if (ENV.notifyEmail) sendEmail(ENV.notifyEmail, `New order ${o.id} ${total}`, `${items}\nCode: ${o.code || "none"}\n${cust.first} ${cust.last} ${cust.email} ${cust.phone}\n${cust.street}, ${cust.city} ${cust.zip}\nPaid: ${o.paid}`);
  if (ENV.ownerPhone) sendSms(ENV.ownerPhone, `New order ${o.id} ${total} ${o.code ? "code " + o.code : ""} ${cust.zip}`);
}

// ---------- card payment through NMI (gateway keys from a high-risk merchant account) ----------
async function chargeCard(order, token) {
  if (ENV.testPay || order.test) return token === "test-decline" ? { ok: false, error: "card declined (test)" } : { ok: true, txn: "TEST-" + Date.now(), auth: "TEST" };
  if (!ENV.nmiSecret) return { ok: false, error: "card payments not enabled" };
  const amount = (order.totals && order.totals.total || 0).toFixed(2);
  const body = new URLSearchParams({ security_key: ENV.nmiSecret, type: "sale", amount, payment_token: token, orderid: order.id, first_name: order.customer.first, last_name: order.customer.last, email: order.customer.email, address1: order.customer.street, city: order.customer.city, zip: order.customer.zip, order_description: "Varsity Labs research compounds" });
  try { const r = await fetch("https://secure.nmi.com/api/transact.php", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); const t = await r.text(); const q = Object.fromEntries(new URLSearchParams(t)); return q.response === "1" ? { ok: true, txn: q.transactionid, auth: q.authcode } : { ok: false, error: q.responsetext || "declined" }; } catch (e) { return { ok: false, error: "gateway unreachable" }; }
}


// ---------- QuickBooks Online: one invoice per order, a payment when it's paid ----------
const QBO_FILE = path.join(DATA_DIR, "qbo.json");
const QBO = { id: process.env.QBO_CLIENT_ID || "", secret: process.env.QBO_CLIENT_SECRET || "", env: process.env.QBO_ENV === "sandbox" ? "sandbox" : "production" };
const qboBase = () => QBO.env === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
function loadQbo() { try { return JSON.parse(fs.readFileSync(QBO_FILE, "utf8")); } catch { return null; } }
function saveQbo(d) { if (!d) { try { fs.unlinkSync(QBO_FILE); } catch {} return; } const tmp = QBO_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 1)); fs.renameSync(tmp, QBO_FILE); }
const qboConfigured = () => !!(QBO.id && QBO.secret);
const qboConnected = () => { const d = loadQbo(); return !!(d && d.refresh_token && d.realmId); };
const qboRedirect = req => (ENV.site || ("https://" + req.headers.host)) + "/api/qbo/callback";
async function qboToken(form) {
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(QBO.id + ":" + QBO.secret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error_description || j.error || "token error"); return j;
}
async function qboAccess() {
  const d = loadQbo(); if (!d || !d.refresh_token) throw new Error("QuickBooks not connected");
  if (Date.now() < (d.expires_at || 0) - 60e3) return d;
  const t = await qboToken({ grant_type: "refresh_token", refresh_token: d.refresh_token });
  Object.assign(d, { access_token: t.access_token, refresh_token: t.refresh_token || d.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 }); saveQbo(d); return d;
}
async function qboApi(method, pathq, body) {
  const d = await qboAccess();
  const url = `${qboBase()}/v3/company/${d.realmId}/${pathq}${pathq.includes("?") ? "&" : "?"}minorversion=70`;
  const r = await fetch(url, { method, headers: { Authorization: "Bearer " + d.access_token, Accept: "application/json", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const f = j.Fault && j.Fault.Error && j.Fault.Error[0]; throw new Error(f ? f.Message + (f.Detail ? ": " + f.Detail : "") : "QuickBooks " + r.status); }
  return j;
}
const qboQuery = q => qboApi("GET", "query?query=" + encodeURIComponent(q));
const qstr = s => String(s || "").replace(/'/g, "\\'");
const first = (r, k) => r.QueryResponse && r.QueryResponse[k] && r.QueryResponse[k][0];
async function qboCustomer(c) {
  const email = (c.email || "").toLowerCase();
  if (email) { const hit = first(await qboQuery(`select * from Customer where PrimaryEmailAddr = '${qstr(email)}'`), "Customer"); if (hit) return hit.Id; }
  const name = `${c.first || ""} ${c.last || ""}`.trim() || email || "Web customer";
  const same = first(await qboQuery(`select * from Customer where DisplayName = '${qstr(name)}'`), "Customer");
  if (same && !email) return same.Id;
  const made = await qboApi("POST", "customer", { DisplayName: same ? `${name} (${email})` : name, GivenName: c.first || undefined, FamilyName: c.last || undefined, PrimaryEmailAddr: email ? { Address: email } : undefined, PrimaryPhone: c.phone ? { FreeFormNumber: c.phone } : undefined, BillAddr: c.street ? { Line1: c.street, City: c.city, CountrySubDivisionCode: "FL", PostalCode: c.zip } : undefined });
  return made.Customer.Id;
}
async function qboIncomeAccount(d) {
  if (d.income) return d.income;
  const list = ((await qboQuery("select * from Account where AccountType = 'Income' and Active = true")).QueryResponse || {}).Account || [];
  const pick = list.find(a => /sales of product/i.test(a.Name)) || list.find(a => /sales|income/i.test(a.Name)) || list[0];
  if (!pick) throw new Error("no income account in QuickBooks"); d.income = pick.Id; saveQbo(d); return d.income;
}
async function qboItem(name, price) {
  const d = loadQbo(); d.items = d.items || {}; if (d.items[name]) return d.items[name];
  const hit = first(await qboQuery(`select * from Item where Name = '${qstr(name)}'`), "Item");
  let id = hit && hit.Id;
  if (!id) { const inc = await qboIncomeAccount(d); const made = await qboApi("POST", "item", { Name: name, Type: "NonInventory", UnitPrice: price, IncomeAccountRef: { value: inc }, Taxable: false }); id = made.Item.Id; }
  const d2 = loadQbo(); d2.items = d2.items || {}; d2.items[name] = id; saveQbo(d2); return id;
}
async function qboInvoice(o) {
  const cust = await qboCustomer(o.customer || {}); const lines = []; const t = o.totals || {};
  for (const i of o.items) { const nm = `${i.name} ${i.size || ""}`.trim().slice(0, 100); const itemId = await qboItem(nm, i.price); lines.push({ DetailType: "SalesItemLineDetail", Amount: r2(i.price * i.qty), Description: nm, SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: i.qty, UnitPrice: i.price, TaxCodeRef: { value: "NON" } } }); }
  if (t.ship) lines.push({ DetailType: "SalesItemLineDetail", Amount: t.ship, Description: "Shipping", SalesItemLineDetail: { ItemRef: { value: await qboItem("Shipping", t.ship) }, Qty: 1, UnitPrice: t.ship, TaxCodeRef: { value: "NON" } } });
  if (t.tax) lines.push({ DetailType: "SalesItemLineDetail", Amount: t.tax, Description: "Florida sales tax collected", SalesItemLineDetail: { ItemRef: { value: await qboItem("Sales tax collected", t.tax) }, Qty: 1, UnitPrice: t.tax, TaxCodeRef: { value: "NON" } } });
  const disc = r2((t.disc || 0) + (t.pdisc || 0));
  if (disc) lines.push({ DetailType: "DiscountLineDetail", Amount: disc, Description: o.code ? "Code " + o.code : "Subscription discount", DiscountLineDetail: { PercentBased: false } });
  const inv = await qboApi("POST", "invoice", { CustomerRef: { value: cust }, DocNumber: o.id, TxnDate: String(o.t || new Date().toISOString()).slice(0, 10), Line: lines, PrivateNote: `${o.test ? "TEST " : ""}Web order ${o.id}${o.code ? ", code " + o.code : ""}. Research use only.`, BillEmail: o.customer && o.customer.email ? { Address: o.customer.email } : undefined, CustomerMemo: { value: "All products are for laboratory research use only. Not for human or veterinary use." } });
  return { customerId: cust, invoiceId: inv.Invoice.Id, total: inv.Invoice.TotalAmt };
}
async function qboPayment(o) {
  if (!o.qbo || !o.qbo.invoiceId || o.qbo.paymentId) return;
  const amt = r2((o.totals && o.totals.total) || 0); if (!amt) return;
  const pay = await qboApi("POST", "payment", { CustomerRef: { value: o.qbo.customerId }, TotalAmt: amt, TxnDate: String(o.paidAt || new Date().toISOString()).slice(0, 10), PrivateNote: o.txn ? "Card transaction " + o.txn : "Marked paid on the Varsity dashboard", Line: [{ Amount: amt, LinkedTxn: [{ TxnId: o.qbo.invoiceId, TxnType: "Invoice" }] }] });
  o.qbo.paymentId = pay.Payment.Id;
}
function updateOrder(id, fn) { writing = writing.then(() => { const all = loadOrders(); const o = all.find(x => x.id === id); if (!o) return; fn(o); const tmp = ORDERS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(all, null, 1)); fs.renameSync(tmp, ORDERS_FILE); }); return writing; }
async function qboSync(id) {
  if (!qboConnected()) return null;
  const o = loadOrders().find(x => x.id === id); if (!o) return null;
  try {
    if (!o.qbo || !o.qbo.invoiceId) { const r = await qboInvoice(o); o.qbo = { ...r, at: new Date().toISOString() }; }
    if (o.paid) await qboPayment(o);
    delete o.qbo.error;
  } catch (e) { o.qbo = { ...(o.qbo || {}), error: String(e.message || e).slice(0, 300), at: new Date().toISOString() }; }
  await updateOrder(id, x => { x.qbo = o.qbo; });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "qbo", id, invoice: o.qbo.invoiceId || null, payment: o.qbo.paymentId || null, error: o.qbo.error || null }));
  return o.qbo;
}
function qboStatus() { const d = loadQbo() || {}; const all = loadOrders(); return { configured: qboConfigured(), connected: qboConnected(), env: QBO.env, company: d.company || null, synced: all.filter(o => o.qbo && o.qbo.invoiceId).length, errors: all.filter(o => o.qbo && o.qbo.error).length }; }


// ---------- customer accounts (free members): orders history + resupply reminders ----------
const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, "[]\n");
let custWriting = Promise.resolve();
function loadCustomers() { try { return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, "utf8")); } catch { return []; } }
function saveCustomers(list) { custWriting = custWriting.then(() => { const tmp = CUSTOMERS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, CUSTOMERS_FILE); }); return custWriting; }
const publicCustomer = c => ({ id: c.id, first: c.first, last: c.last, email: c.email, phone: c.phone, reminders: c.reminders !== false, cadence: c.cadence || 28, lastReminded: c.lastReminded || null, t: c.t });
function customerOrders(c) { const em = (c.email || "").toLowerCase(); return loadOrders().filter(o => o.customerId === c.id || (em && o.customer && o.customer.email === em)).map(({ ip, ...o }) => o).sort((a, b) => (a.t < b.t ? 1 : -1)); }
async function runReminders() {
  const list = loadCustomers(); let changed = false; const now = Date.now();
  for (const c of list) {
    if (c.reminders === false || c.removed) continue;
    const orders = customerOrders(c).filter(o => !["cancelled", "refunded"].includes(o.status)); if (!orders.length) continue;
    const last = orders[0]; const cadence = Math.max(14, Math.min(90, c.cadence || 28)); const daysSince = (now - Date.parse(last.t)) / 864e5;
    if (daysSince < cadence) continue;
    if (c.lastReminded && (now - Date.parse(c.lastReminded)) / 864e5 < cadence) continue;
    const site = ENV.site || "https://shopvarsitylabs.com"; const items = last.items.map(i => `${i.qty}x ${i.name} ${i.size}`).join(", ");
    const msg = `Varsity Labs: it's been ${Math.round(daysSince / 7)} weeks since your last order (${items}). Reorder in two taps: ${site}/account . Reply STOP to turn these off.`;
    const [sm, em] = await Promise.all([sendSms(c.phone, msg), sendEmail(c.email, "Time to restock?", msg + "\n\nAll products are for laboratory research use only and are not for human or veterinary use.")]);
    if (sm || em) { c.lastReminded = new Date().toISOString(); changed = true; console.log(JSON.stringify({ at: c.lastReminded, event: "reminder", customer: c.id, sms: sm, email: em })); }
  }
  if (changed) await saveCustomers(list);
}
setTimeout(() => runReminders().catch(e => console.error("reminders", e.message)), 6e4);
setInterval(() => runReminders().catch(e => console.error("reminders", e.message)), 12 * 36e5).unref();

// ---------- Zoho CRM: a contact and a deal per order, deal marked won when paid ----------
const ZOHO_FILE = path.join(DATA_DIR, "zoho.json");
const ZOHO = { id: process.env.ZOHO_CLIENT_ID || "", secret: process.env.ZOHO_CLIENT_SECRET || "", dc: (process.env.ZOHO_DC || "com").replace(/[^a-z.]/g, "") || "com", stageNew: process.env.ZOHO_STAGE_NEW || "Qualification", stagePaid: process.env.ZOHO_STAGE_PAID || "Closed Won" };
const zohoAccounts = () => `https://accounts.zoho.${ZOHO.dc}`;
function loadZoho() { try { return JSON.parse(fs.readFileSync(ZOHO_FILE, "utf8")); } catch { return null; } }
function saveZoho(d) { if (!d) { try { fs.unlinkSync(ZOHO_FILE); } catch {} return; } const tmp = ZOHO_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 1)); fs.renameSync(tmp, ZOHO_FILE); }
const zohoConfigured = () => !!(ZOHO.id && ZOHO.secret);
const zohoConnected = () => { const d = loadZoho(); return !!(d && d.refresh_token); };
const zohoRedirect = req => (ENV.site || ("https://" + req.headers.host)) + "/api/zoho/callback";
async function zohoToken(form) {
  const r = await fetch(zohoAccounts() + "/oauth/v2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: ZOHO.id, client_secret: ZOHO.secret, ...form }) });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error_description || j.error || "token error"); return j;
}
async function zohoAccess() {
  const d = loadZoho(); if (!d || !d.refresh_token) throw new Error("Zoho not connected");
  if (Date.now() < (d.expires_at || 0) - 60e3 && d.access_token) return d;
  const t = await zohoToken({ grant_type: "refresh_token", refresh_token: d.refresh_token });
  Object.assign(d, { access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, api_domain: t.api_domain || d.api_domain }); saveZoho(d); return d;
}
async function zohoApi(method, pathq, body) {
  const d = await zohoAccess(); const base = (d.api_domain || `https://www.zohoapis.${ZOHO.dc}`) + "/crm/v6/";
  const r = await fetch(base + pathq, { method, headers: { Authorization: "Zoho-oauthtoken " + d.access_token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  const first = j.data && j.data[0];
  if (!r.ok || (first && first.status === "error")) { const m = (first && (first.message + (first.details && first.details.api_name ? " (" + first.details.api_name + ")" : ""))) || j.message || ("Zoho " + r.status); throw new Error(m); }
  return j;
}
async function zohoContact(c) {
  const email = (c.email || "").toLowerCase(); const rec = { Last_Name: c.last || c.first || "Customer", First_Name: c.first || undefined, Email: email || undefined, Phone: c.phone || undefined, Mailing_Street: c.street || undefined, Mailing_City: c.city || undefined, Mailing_State: c.zip ? "FL" : undefined, Mailing_Zip: c.zip || undefined, Lead_Source: "Varsity Labs website", Description: "Research use only. Created from a Varsity Labs web order." };
  const j = await zohoApi("POST", "Contacts/upsert", { data: [rec], duplicate_check_fields: ["Email"] });
  return j.data[0].details.id;
}
async function zohoDeal(o, contactId) {
  const t = o.totals || {}; const items = o.items.map(i => `${i.qty} x ${i.name} ${i.size || ""} @ $${i.price}`).join("\n");
  const rec = { Deal_Name: `${o.test ? "TEST " : ""}Varsity Labs ${o.id}`, Amount: t.total || 0, Stage: o.paid ? ZOHO.stagePaid : ZOHO.stageNew, Closing_Date: String(o.t || new Date().toISOString()).slice(0, 10), Contact_Name: { id: contactId }, Lead_Source: "Varsity Labs website", Description: `Web order ${o.id}${o.code ? ", code " + o.code : ""}${o.sub ? ", 4-week resupply" : ""}\n${items}\nSubtotal $${t.sub || 0}, discounts $${((t.disc || 0) + (t.pdisc || 0)).toFixed(2)}, shipping $${t.ship || 0}, tax $${t.tax || 0}, total $${t.total || 0}\nShip to: ${o.customer.street || ""}, ${o.customer.city || ""} ${o.customer.zip || ""}\nAll products are for laboratory research use only.` };
  const j = await zohoApi("POST", "Deals", { data: [rec] });
  return j.data[0].details.id;
}
async function zohoSync(id) {
  if (!zohoConnected()) return null;
  const o = loadOrders().find(x => x.id === id); if (!o) return null;
  try {
    o.zoho = o.zoho || {};
    if (!o.zoho.contactId) o.zoho.contactId = await zohoContact(o.customer || {});
    if (!o.zoho.dealId) o.zoho.dealId = await zohoDeal(o, o.zoho.contactId);
    else if (o.paid && !o.zoho.won) { await zohoApi("PUT", "Deals/" + o.zoho.dealId, { data: [{ Stage: ZOHO.stagePaid }] }); }
    if (o.paid) o.zoho.won = true;
    delete o.zoho.error; o.zoho.at = new Date().toISOString();
  } catch (e) { o.zoho = { ...(o.zoho || {}), error: String(e.message || e).slice(0, 300), at: new Date().toISOString() }; }
  await updateOrder(id, x => { x.zoho = o.zoho; });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "zoho", id, contact: o.zoho.contactId || null, deal: o.zoho.dealId || null, error: o.zoho.error || null }));
  return o.zoho;
}
function zohoStatus() { const d = loadZoho() || {}; const all = loadOrders(); return { configured: zohoConfigured(), connected: zohoConnected(), dc: ZOHO.dc, org: d.org || null, synced: all.filter(o => o.zoho && o.zoho.dealId).length, errors: all.filter(o => o.zoho && o.zoho.error).length, stages: { new: ZOHO.stageNew, paid: ZOHO.stagePaid } }; }

// ---------- sessions ----------
function makeSession(user, role) { const payload = b64u(JSON.stringify({ u: user, r: role, exp: Date.now() + SESSION_HOURS * 36e5, n: crypto.randomBytes(8).toString("hex") })); return payload + "." + sign(payload); }
function readSession(req) {
  const c = parseCookies(req).vl_owner; if (!c) return null;
  const [payload, sig] = c.split("."); if (!payload || !sig) return null;
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)))) return null; } catch { return null; }
  try { const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); if (d.exp < Date.now()) return null; if (d.r === "owner") return OWNERS[d.u] ? d : null; if (d.r === "rep") { const r = loadReps().find(x => x.code === d.u); return r && r.status !== "removed" ? { ...d, rep: r } : null; } if (d.r === "customer") { const c = loadCustomers().find(x => x.id === d.u && !x.removed); return c ? { ...d, customer: c } : null; } return null; } catch { return null; }
}
const cookie = (v, maxAge) => `vl_owner=${v}; Path=/; HttpOnly; SameSite=Lax${SECURE ? "; Secure" : ""}; Max-Age=${maxAge}`;

// ---------- rate limits (in-memory, per instance) ----------
const buckets = new Map();
function limited(key, max, windowMs) { const now = Date.now(); let b = buckets.get(key); if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); } b.n++; return b.n > max; }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 6e4).unref();

// ---------- orders store ----------
let writing = Promise.resolve();
function loadOrders() { try { return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch { return []; } }
function appendOrder(o) { writing = writing.then(() => { const all = loadOrders(); all.push(o); const tmp = ORDERS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(all, null, 1)); fs.renameSync(tmp, ORDERS_FILE); }); return writing; }
function validateOrder(b) {
  if (!b || typeof b !== "object") return "bad body";
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) return "no items";
  for (const i of b.items) { if (typeof i.name !== "string" || i.name.length > 80 || typeof i.price !== "number" || !(i.price >= 0 && i.price < 5000) || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 50) return "bad item"; }
  const c = b.customer || {}; for (const k of ["first", "last", "email", "street", "city", "zip", "phone"]) if (c[k] != null && (typeof c[k] !== "string" || c[k].length > 120)) return "bad customer";
  if (c.email && !/^[^\s@]{1,64}@[^\s@]{1,120}$/.test(c.email)) return "bad email";
  if (b.code != null && (typeof b.code !== "string" || b.code.length > 24)) return "bad code";
  return null;
}
function nextId(all) { let max = 10000; for (const o of all) { const m = /^VL-(\d+)$/.exec(o.id || ""); if (m) max = Math.max(max, +m[1]); } return "VL-" + (max + 1); }

// ---------- pages ----------
function loginPage(err = "", user = "", next = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Log in · Varsity Labs</title>
<meta name="robots" content="noindex"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=Archivo:wght@400;600;700&display=swap">
<style>:root{color-scheme:light dark;--bg:#f6f4ee;--surface:#fff;--line:#dcd8cc;--ink:#161a22;--ink2:#5d6470;--maroon:#8a2432;--gold:#b8842f;--gold-soft:#f6ecd8}@media(prefers-color-scheme:dark){:root{--bg:#141a26;--surface:#1c2331;--line:#313a4b;--ink:#eef0f4;--ink2:#b3b9c6;--maroon:#c9505f;--gold:#d3a04b;--gold-soft:#3a2f1a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font-family:Archivo,system-ui,sans-serif}
.box{width:min(420px,92vw);background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px 26px;box-shadow:0 12px 32px rgba(0,0,0,.12)}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit;margin-bottom:18px}.logo i{width:34px;height:34px;background:var(--maroon);color:#fff;display:grid;place-items:center;font:900 26px "Big Shoulders Display",sans-serif;border-radius:4px;font-style:normal}.logo b{font:800 22px "Big Shoulders Display",sans-serif;letter-spacing:.04em;text-transform:uppercase}
h1{font:800 38px/.95 "Big Shoulders Display",sans-serif;text-transform:uppercase;margin:0 0 6px}p{color:var(--ink2);margin:0 0 18px;font-size:14px}
label{display:block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);margin:12px 0 4px}
select,input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:inherit;font:inherit;font-size:15px}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;background:var(--maroon);color:#fff;font:700 15px Archivo,sans-serif;cursor:pointer}
.err{background:var(--gold-soft);color:var(--gold);border-radius:8px;padding:8px 10px;font-size:13px;font-weight:600;margin-top:12px}
.back{display:block;text-align:center;margin-top:16px;font-size:13px;color:var(--ink2)}</style></head><body>
<form class="box" method="post" action="/login" autocomplete="on"><a class="logo" href="/"><i>V</i><b>Varsity Labs</b></a><h1>Log in</h1><p>Members sign in with their email. Reps with their code, like FSU-JAKE. Owners with their name. Every sign-in is logged.</p>
<input type="hidden" name="next" value="${esc(next)}"><label for="u">Email, rep code or owner name</label><input id="u" name="user" value="${esc(user)}" required autocomplete="username" autocapitalize="characters" spellcheck="false" placeholder="FSU-JAKE">
<label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password">
${err ? `<div class="err">${esc(err)}</div>` : ""}<button type="submit">Sign in</button><a class="back" href="/">← back to the store</a><p style="margin:14px 0 0;text-align:center"><a href="/signup" style="color:var(--maroon);font-weight:600;text-decoration:none">No account? Sign up free</a></p></form></body></html>`;
}

function serveStatic(res, base, rel) {
  let file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return send(res, 403, "forbidden");
  if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html";
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "not found", { "Content-Type": "text/plain" });
    const ext = path.extname(file).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400" };
    if (base === PRIV) headers["Cache-Control"] = "no-store";
    res.writeHead(200, { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", ...headers });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const sess = readSession(req);
  const isOwner = !!(sess && sess.r === "owner");
  try {
    if (p === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });

    // auth: one login for owners and reps
    const home = s => s.r === "owner" ? "/owners" : s.r === "customer" ? "/account" : "/portal";
    const html = (code, body) => send(res, code, body, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    if (p === "/owners/login") return redirect(res, "/login");
    if (p === "/login") {
      if (req.method === "GET") return sess ? redirect(res, home(sess)) : html(200, loginPage("", url.searchParams.get("user") || "", url.searchParams.get("next") || ""));
      if (req.method === "POST") {
        if (limited("login:" + ip(req), 8, 15 * 6e4)) return html(429, loginPage("Too many attempts. Wait 15 minutes."));
        const f = parseForm(await readBody(req, 4096));
        const who = (f.user || "").trim(); const key = who.toLowerCase(); const codeKey = who.toUpperCase();
        let role = null, user = null, err = "Wrong code, name or password.";
        if (OWNERS[key]) { if (!OWNERS[key].pass) err = "This owner account has no password set yet."; else if (safeEq(f.password || "", OWNERS[key].pass)) { role = "owner"; user = key; } }
        else if (key.includes("@")) { const c = loadCustomers().find(x => x.email === key && !x.removed); if (c && checkPw(f.password || "", c.hash)) { role = "customer"; user = c.id; } else err = "Wrong email or password."; }
        else { const reps = loadReps(); const r = reps.find(x => x.code === codeKey && x.status !== "removed"); if (r && checkPw(f.password || "", r.hash)) { role = "rep"; user = r.code; r.lastLogin = new Date().toISOString(); await saveReps(reps); } }
        console.log(JSON.stringify({ at: new Date().toISOString(), event: "login", user: role ? user : who.slice(0, 40), role, ok: !!role, ip: ip(req) }));
        if (!role) return html(401, loginPage(err, who));
        const next = (f.next || "").startsWith("/") && !(f.next || "").startsWith("//") ? f.next : null;
        return redirect(res, next || (role === "owner" ? "/owners" : role === "customer" ? "/account" : "/portal"), { "Set-Cookie": cookie(makeSession(user, role), SESSION_HOURS * 3600) });
      }
    }
    if ((p === "/logout" || p === "/owners/logout") && req.method === "POST") return redirect(res, "/", { "Set-Cookie": cookie("", 0) });
    // customer accounts
    if (p === "/account" || p.startsWith("/account/")) { if (!sess || sess.r !== "customer") return redirect(res, "/login?next=/account"); return serveStatic(res, PUB, "account.html"); }
    if (p === "/api/signup" && req.method === "POST") {
      if (limited("signup:" + ip(req), 10, 36e5)) return json(res, 429, { error: "slow down" });
      let b; try { b = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: "bad json" }); }
      const f = k => String(b[k] || "").trim().slice(0, 120); const email = f("email").toLowerCase();
      if (!f("first") || !/^[^\s@]{1,64}@[^\s@]{1,120}$/.test(email)) return json(res, 400, { error: "First name and a real email are required" });
      if (typeof b.password !== "string" || b.password.length < 8) return json(res, 400, { error: "Password needs at least 8 characters" });
      if (!b.research) return json(res, 400, { error: "Please confirm you are 21+ and buying for laboratory research" });
      const list = loadCustomers(); if (list.some(c => c.email === email && !c.removed)) return json(res, 409, { error: "There's already an account with that email. Log in instead." });
      const c = { id: "C" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), t: new Date().toISOString(), first: f("first"), last: f("last"), email, phone: f("phone").replace(/[^\d+() .-]/g, "").slice(0, 24), hash: hashPw(b.password), reminders: b.reminders !== false, cadence: 28, ip: ip(req) };
      list.push(c); await saveCustomers(list);
      const all = loadOrders(); let linked = 0; all.forEach(o => { if (!o.customerId && o.customer && o.customer.email === email) { o.customerId = c.id; linked++; } }); if (linked) { const tmp = ORDERS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(all, null, 1)); fs.renameSync(tmp, ORDERS_FILE); }
      console.log(JSON.stringify({ at: c.t, event: "signup", customer: c.id, linked }));
      return json(res, 201, { ok: true, id: c.id, linked }, { "Set-Cookie": cookie(makeSession(c.id, "customer"), SESSION_HOURS * 3600) });
    }
    if (p === "/api/account" && req.method === "GET") { if (!sess || sess.r !== "customer") return json(res, 401, { error: "not signed in" }); const c = sess.customer; const orders = customerOrders(c); const last = orders.find(o => !["cancelled", "refunded"].includes(o.status)); const cadence = c.cadence || 28; return json(res, 200, { profile: publicCustomer(c), orders, nextReminder: last && c.reminders !== false ? new Date(Date.parse(last.t) + cadence * 864e5).toISOString() : null, channels: { sms: !!(ENV.twSid && ENV.twToken && ENV.twFrom), email: !!(ENV.resend && ENV.fromEmail) } }); }
    if (p === "/api/account" && req.method === "PATCH") {
      if (!sess || sess.r !== "customer") return json(res, 401, { error: "not signed in" });
      let b; try { b = JSON.parse(await readBody(req, 2048)); } catch { return json(res, 400, { error: "bad json" }); }
      const list = loadCustomers(); const c = list.find(x => x.id === sess.u); if (!c) return json(res, 404, { error: "no account" });
      if (typeof b.reminders === "boolean") c.reminders = b.reminders;
      if (Number.isInteger(b.cadence) && b.cadence >= 14 && b.cadence <= 90) c.cadence = b.cadence;
      if (typeof b.phone === "string") c.phone = b.phone.replace(/[^\d+() .-]/g, "").slice(0, 24);
      if (typeof b.first === "string" && b.first.trim()) c.first = b.first.trim().slice(0, 60);
      if (typeof b.last === "string") c.last = b.last.trim().slice(0, 60);
      await saveCustomers(list); return json(res, 200, publicCustomer(c));
    }
    if (p === "/api/account/password" && req.method === "POST") {
      if (!sess || sess.r !== "customer") return json(res, 401, { error: "not signed in" });
      let b; try { b = JSON.parse(await readBody(req, 2048)); } catch { return json(res, 400, { error: "bad json" }); }
      const list = loadCustomers(); const c = list.find(x => x.id === sess.u); if (!c) return json(res, 404, { error: "no account" });
      if (!checkPw(String(b.current || ""), c.hash)) return json(res, 401, { error: "Current password is wrong" });
      if (typeof b.next !== "string" || b.next.length < 8) return json(res, 400, { error: "New password needs at least 8 characters" });
      c.hash = hashPw(b.next); await saveCustomers(list); return json(res, 200, { ok: true });
    }

    if (p === "/owners" || p.startsWith("/owners/")) {
      if (!sess) return redirect(res, "/login?next=/owners");
      if (sess.r !== "owner") return redirect(res, "/portal");
      return serveStatic(res, PRIV, "owners.html");
    }
    if (p === "/portal" || p.startsWith("/portal/")) {
      if (!sess) return redirect(res, "/login?next=/portal");
      return serveStatic(res, PRIV, "portal.html");
    }

    // public config + tax + stock
    if (p === "/api/config") return json(res, 200, { testPay: ENV.testPay, card: ENV.testPay || !!(ENV.nmiPublic && ENV.nmiSecret), nmiKey: ENV.nmiPublic || null, crypto: ENV.crypto || null, tax: ENV.tax, sameDayPrefix: "323" });
    if (p === "/api/tax") return json(res, 200, { rate: taxRate(url.searchParams.get("zip")) });
    if (p === "/api/promo") { const pr = resolveCode(url.searchParams.get("code")); return pr ? json(res, 200, pr) : json(res, 404, { error: "That code isn't valid or isn't active" }); }
    if (p === "/api/promos" && req.method === "GET") return isOwner ? json(res, 200, loadPromos()) : json(res, 401, { error: "not available for this account" });
    if (p === "/api/promos" && req.method === "PUT") {
      if (!isOwner) return json(res, 401, { error: "not available for this account" });
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch { return json(res, 400, { error: "bad json" }); }
      if (!Array.isArray(b) || b.length > 200) return json(res, 400, { error: "send a list of codes" });
      const clean = []; const seen = new Set();
      for (const x of b) { const code = normCode(x.code); if (!/^[A-Z0-9]{3,20}$/.test(code) || seen.has(code)) continue; if (/^[A-Z]{2,8}-/.test(code)) continue; seen.add(code); clean.push({ code, type: ["pct", "flat", "ship"].includes(x.type) ? x.type : "pct", value: Math.max(0, Math.min(100, +x.value || 0)), label: String(x.label || code).slice(0, 80), min: Math.max(0, +x.min || 0), active: x.active !== false }); }
      await savePromos(clean); return json(res, 200, clean);
    }
    if (p === "/api/stock" && req.method === "GET") return json(res, 200, { soldOut: soldOut(loadStock()) });
    // Zoho CRM connect / status (owners only)
    if (p === "/api/zoho/connect") {
      if (!isOwner) return redirect(res, "/login?next=" + encodeURIComponent("/owners/setup"));
      if (!zohoConfigured()) return json(res, 400, { error: "ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are not set" });
      const state = b64u(String(Date.now())); const st = state + "." + sign(state);
      const u = new URL(zohoAccounts() + "/oauth/v2/auth"); u.search = new URLSearchParams({ scope: "ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.deals.ALL,ZohoCRM.org.READ", client_id: ZOHO.id, response_type: "code", access_type: "offline", prompt: "consent", redirect_uri: zohoRedirect(req), state: st }).toString();
      return redirect(res, u.toString());
    }
    if (p === "/api/zoho/callback") {
      const q = url.searchParams; const st = q.get("state") || ""; const [sv, ssig] = st.split(".");
      if (!sv || !ssig || !safeEq(ssig, sign(sv)) || Date.now() - Number(Buffer.from(sv, "base64url").toString()) > 15 * 60e3) return send(res, 400, "Zoho connect link expired. Open the dashboard and click Connect again.", { "Content-Type": "text/plain" });
      if (!q.get("code")) return send(res, 400, "Zoho did not return a code.", { "Content-Type": "text/plain" });
      try {
        const t = await zohoToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: zohoRedirect(req) });
        if (!t.refresh_token) throw new Error("Zoho did not return a refresh token (connect again and approve)");
        saveZoho({ refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, api_domain: t.api_domain || "", connectedAt: new Date().toISOString() });
        try { const org = await zohoApi("GET", "org"); const d = loadZoho(); d.org = org.org && org.org[0] && org.org[0].company_name; saveZoho(d); } catch {}
        console.log(JSON.stringify({ at: new Date().toISOString(), event: "zoho-connected" }));
      } catch (e) { return send(res, 502, "Zoho connection failed: " + esc(e.message), { "Content-Type": "text/plain" }); }
      return redirect(res, "/owners/setup");
    }
    if (p === "/api/zoho/disconnect" && req.method === "POST") { if (!isOwner) return json(res, 401, { error: "not available for this account" }); saveZoho(null); return json(res, 200, { ok: true }); }
    const zohoM = p.match(/^\/api\/orders\/(VL-\d+)\/zoho$/);
    if (zohoM && req.method === "POST") { if (!isOwner) return json(res, 401, { error: "not available for this account" }); if (!zohoConnected()) return json(res, 400, { error: "Zoho is not connected" }); const r = await zohoSync(zohoM[1]); return json(res, r && !r.error ? 200 : 502, r || { error: "no such order" }); }
    // QuickBooks connect / status (owners only)
    if (p === "/api/qbo/connect") {
      if (!isOwner) return redirect(res, "/login?next=" + encodeURIComponent("/owners/setup"));
      if (!qboConfigured()) return json(res, 400, { error: "QBO_CLIENT_ID and QBO_CLIENT_SECRET are not set" });
      const state = b64u(String(Date.now())); const st = state + "." + sign(state);
      const u = new URL("https://appcenter.intuit.com/connect/oauth2"); u.search = new URLSearchParams({ client_id: QBO.id, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: qboRedirect(req), state: st }).toString();
      return redirect(res, u.toString());
    }
    if (p === "/api/qbo/callback") {
      const q = url.searchParams; const st = q.get("state") || ""; const [sv, ssig] = st.split(".");
      if (!sv || !ssig || !safeEq(ssig, sign(sv)) || Date.now() - Number(Buffer.from(sv, "base64url").toString()) > 15 * 60e3) return send(res, 400, "QuickBooks connect link expired. Open the dashboard and click Connect again.", { "Content-Type": "text/plain" });
      if (!q.get("code") || !q.get("realmId")) return send(res, 400, "QuickBooks did not return a code.", { "Content-Type": "text/plain" });
      try {
        const t = await qboToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: qboRedirect(req) });
        const prev = loadQbo() || {};
        saveQbo({ ...prev, realmId: q.get("realmId"), access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, connectedAt: new Date().toISOString(), items: prev.realmId === q.get("realmId") ? prev.items : {}, income: prev.realmId === q.get("realmId") ? prev.income : undefined });
        try { const ci = await qboApi("GET", "companyinfo/" + q.get("realmId")); const d = loadQbo(); d.company = ci.CompanyInfo && ci.CompanyInfo.CompanyName; saveQbo(d); } catch {}
        console.log(JSON.stringify({ at: new Date().toISOString(), event: "qbo-connected", realm: q.get("realmId") }));
      } catch (e) { return send(res, 502, "QuickBooks connection failed: " + esc(e.message), { "Content-Type": "text/plain" }); }
      return redirect(res, "/owners/setup");
    }
    if (p === "/api/qbo/disconnect" && req.method === "POST") { if (!isOwner) return json(res, 401, { error: "not available for this account" }); saveQbo(null); return json(res, 200, { ok: true }); }
    const qboM = p.match(/^\/api\/orders\/(VL-\d+)\/qbo$/);
    if (qboM && req.method === "POST") { if (!isOwner) return json(res, 401, { error: "not available for this account" }); if (!qboConnected()) return json(res, 400, { error: "QuickBooks is not connected" }); const r = await qboSync(qboM[1]); return json(res, r && !r.error ? 200 : 502, r || { error: "no such order" }); }
    if (p === "/api/pay" && req.method === "POST") {
      if (limited("pay:" + ip(req), 10, 36e5)) return json(res, 429, { error: "slow down" });
      let b; try { b = JSON.parse(await readBody(req, 8192)); } catch { return json(res, 400, { error: "bad json" }); }
      const all = loadOrders(); const o = all.find(x => x.id === b.orderId); if (!o) return json(res, 404, { error: "no such order" });
      if (o.paid) return json(res, 200, { ok: true, already: true });
      if (typeof b.token !== "string" || b.token.length > 200) return json(res, 400, { error: "bad token" });
      const r = await chargeCard(o, b.token);
      if (r.ok) { o.paid = true; o.paidAt = new Date().toISOString(); o.txn = r.txn; o.status = "paid"; const tmp = ORDERS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(all, null, 1)); fs.renameSync(tmp, ORDERS_FILE); notifyOrder(o); qboSync(o.id); zohoSync(o.id); }
      console.log(JSON.stringify({ at: new Date().toISOString(), event: "pay", id: o.id, ok: r.ok, error: r.error || null }));
      return json(res, r.ok ? 200 : 402, r.ok ? { ok: true, txn: r.txn } : { error: r.error });
    }
    if (p === "/api/apply" && req.method === "POST") {
      if (limited("apply:" + ip(req), 5, 36e5)) return json(res, 429, { error: "slow down" });
      let b; try { b = JSON.parse(await readBody(req, 8192)); } catch { return json(res, 400, { error: "bad json" }); }
      const f = k => String(b[k] || "").trim().slice(0, 200);
      if (!f("first") || !f("last") || !/^[^\s@]{1,64}@[^\s@]{1,120}$/.test(f("email")) || !f("campus")) return json(res, 400, { error: "name, email and campus are required" });
      const apps = loadApps(); const a = { id: "A" + Date.now().toString(36), t: new Date().toISOString(), first: f("first"), last: f("last"), email: f("email").toLowerCase(), phone: f("phone"), payout: f("payout"), campus: f("campus").toUpperCase().slice(0, 5), handle: f("handle"), how: f("how").slice(0, 600), notes: f("notes").slice(0, 600), code: f("code").toUpperCase().slice(0, 20), status: "pending", ip: ip(req) };
      apps.push(a); await saveApps(apps);
      console.log(JSON.stringify({ at: a.t, event: "application", code: a.code }));
      if (ENV.notifyEmail) sendEmail(ENV.notifyEmail, "Rep application: " + a.code, `${a.first} ${a.last}, ${a.campus}, ${a.email} ${a.phone}\n${a.how}\n${a.notes}`);
      return json(res, 201, { id: a.id });
    }
    if (p === "/api/applications" && req.method === "GET") return isOwner ? json(res, 200, loadApps().map(({ ip, ...a }) => a)) : json(res, 401, { error: "not available for this account" });
    const appM = p.match(/^\/api\/applications\/([A-Za-z0-9]+)$/);
    if (appM && req.method === "PATCH") {
      if (!isOwner) return json(res, 401, { error: "not available for this account" });
      let b; try { b = JSON.parse(await readBody(req, 2048)); } catch { return json(res, 400, { error: "bad json" }); }
      const apps = loadApps(); const a = apps.find(x => x.id === appM[1]); if (!a) return json(res, 404, { error: "no such application" });
      if (["pending", "approved", "declined"].includes(b.status)) a.status = b.status; await saveApps(apps); return json(res, 200, a);
    }
    if (p === "/api/stock" && req.method === "PUT") {
      if (!isOwner) return json(res, 401, { error: "not available for this account" });
      let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch { return json(res, 400, { error: "bad json" }); }
      const stock = loadStock(); for (const [k, v] of Object.entries(b || {})) { if (typeof k !== "string" || k.length > 80) continue; if (v === null || v === "") delete stock[k]; else if (Number.isInteger(+v) && +v >= 0) stock[k] = +v; }
      await saveStock(stock); return json(res, 200, stock);
    }
    if (p === "/api/stock/all" && req.method === "GET") return isOwner ? json(res, 200, loadStock()) : json(res, 401, { error: "not available for this account" });
    if (p === "/api/setup") { if (!isOwner) return json(res, 401, { error: "not available for this account" }); return json(res, 200, { owners: Object.fromEntries(Object.entries(OWNERS).map(([k, o]) => [k, !!o.pass])), card: !!(ENV.nmiPublic && ENV.nmiSecret), crypto: !!ENV.crypto, email: !!(ENV.resend && ENV.fromEmail), notifyEmail: !!ENV.notifyEmail, sms: !!(ENV.twSid && ENV.twToken && ENV.twFrom), ownerPhone: !!ENV.ownerPhone, tax: ENV.tax, site: ENV.site || null, host: req.headers.host, orders: loadOrders().length, reps: loadReps().filter(r => r.status !== "removed").length, applications: loadApps().filter(a => a.status === "pending").length, tracked: Object.keys(loadStock()).length, qbo: qboStatus(), zoho: zohoStatus(), members: loadCustomers().filter(c => !c.removed).length }); }
    const ordM = p.match(/^\/api\/orders\/(VL-\d+)$/);
    if (ordM && req.method === "PATCH") {
      if (!isOwner) return json(res, 401, { error: "not available for this account" });
      let b; try { b = JSON.parse(await readBody(req, 2048)); } catch { return json(res, 400, { error: "bad json" }); }
      const all = loadOrders(); const o = all.find(x => x.id === ordM[1]); if (!o) return json(res, 404, { error: "no such order" });
      if (["received", "paid", "packed", "out", "delivered", "cancelled", "refunded"].includes(b.status)) o.status = b.status;
      if (typeof b.paid === "boolean") o.paid = b.paid;
      if (typeof b.tracking === "string") o.tracking = b.tracking.slice(0, 80);
      const tmp = ORDERS_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(all, null, 1)); fs.renameSync(tmp, ORDERS_FILE);
      if (b.paid === true || b.status === "paid") { qboSync(o.id); zohoSync(o.id); }
      if (b.status === "out" && o.customer.phone) sendSms(o.customer.phone, `Varsity Labs ${o.id} is out for delivery.${o.tracking ? " Tracking: " + o.tracking : ""}`);
      return json(res, 200, o);
    }

    // rep accounts (owners only)
    if (p === "/api/reps" && req.method === "GET") return isOwner ? json(res, 200, loadReps().filter(r => r.status !== "removed").map(publicRep)) : json(res, 401, { error: "not available for this account" });
    if (p === "/api/reps" && req.method === "POST") {
      if (!isOwner) return json(res, 401, { error: "not available for this account" });
      let b; try { b = JSON.parse(await readBody(req, 8192)); } catch { return json(res, 400, { error: "bad json" }); }
      const campus = String(b.campus || "").toUpperCase(), suffix = String(b.suffix || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!CAMPUSES.includes(campus)) return json(res, 400, { error: "campus must be one of " + CAMPUSES.join(", ") });
      if (!/^[A-Z0-9]{2,12}$/.test(suffix)) return json(res, 400, { error: "code must be 2 to 12 letters or numbers" });
      const name = String(b.name || "").trim().slice(0, 60); if (!name) return json(res, 400, { error: "name required" });
      const tier = TIER_RATE[b.tier] ? b.tier : "Rep";
      const code = campus + "-" + suffix; const reps = loadReps();
      if (reps.some(r => r.code === code && r.status !== "removed")) return json(res, 409, { error: code + " already exists" });
      const temp = tempPassword();
      const r = { code, name, campus, tier, phone: String(b.phone || "").slice(0, 30), email: String(b.email || "").toLowerCase().slice(0, 120), status: "active", hash: hashPw(temp), mustChange: true, created: new Date().toISOString(), createdBy: sess.u };
      reps.push(r); await saveReps(reps);
      console.log(JSON.stringify({ at: r.created, event: "rep_created", code, by: sess.u }));
      return json(res, 201, { rep: publicRep(r), tempPassword: temp });
    }
    const repM = p.match(/^\/api\/reps\/([A-Z0-9-]{3,20})(?:\/(reset))?$/i);
    if (repM && isOwner && req.method === "POST" && repM[2] === "reset") {
      const reps = loadReps(); const r = reps.find(x => x.code === repM[1].toUpperCase() && x.status !== "removed"); if (!r) return json(res, 404, { error: "no such rep" });
      const temp = tempPassword(); r.hash = hashPw(temp); r.mustChange = true; await saveReps(reps);
      console.log(JSON.stringify({ at: new Date().toISOString(), event: "rep_reset", code: r.code, by: sess.u }));
      return json(res, 200, { rep: publicRep(r), tempPassword: temp });
    }
    if (repM && isOwner && req.method === "PATCH" && !repM[2]) {
      let b; try { b = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: "bad json" }); }
      const reps = loadReps(); const r = reps.find(x => x.code === repM[1].toUpperCase() && x.status !== "removed"); if (!r) return json(res, 404, { error: "no such rep" });
      if (b.status && ["active", "paused", "strike", "removed"].includes(b.status)) r.status = b.status;
      if (b.tier && TIER_RATE[b.tier]) r.tier = b.tier;
      if (typeof b.phone === "string") r.phone = b.phone.slice(0, 30);
      if (typeof b.email === "string") r.email = b.email.toLowerCase().slice(0, 120);
      if (typeof b.name === "string" && b.name.trim()) r.name = b.name.trim().slice(0, 60);
      await saveReps(reps);
      console.log(JSON.stringify({ at: new Date().toISOString(), event: "rep_update", code: r.code, by: sess.u, status: r.status, tier: r.tier }));
      return json(res, 200, publicRep(r));
    }

    // rep portal data
    if (p === "/api/portal" && req.method === "GET") {
      if (!sess) return json(res, 401, { error: "not signed in" });
      let r;
      if (sess.r === "rep") r = loadReps().find(x => x.code === sess.u);
      else { const c = (url.searchParams.get("code") || "").toUpperCase(); r = loadReps().find(x => x.code === c && x.status !== "removed"); if (!r) return json(res, 404, { error: "pass ?code=CAMPUS-NAME of a real rep" }); }
      if (!r) return json(res, 404, { error: "no such rep" });
      return json(res, 200, { rep: publicRep(r), viewer: sess.r, orders: repOrders(loadOrders(), r.code), site: (req.headers["x-forwarded-proto"] || "http") + "://" + req.headers.host });
    }
    if (p === "/api/portal/password" && req.method === "POST") {
      if (!sess || sess.r !== "rep") return json(res, 401, { error: "reps only" });
      let b; try { b = JSON.parse(await readBody(req, 4096)); } catch { return json(res, 400, { error: "bad json" }); }
      const reps = loadReps(); const r = reps.find(x => x.code === sess.u); if (!r) return json(res, 404, { error: "no such rep" });
      if (!checkPw(b.current || "", r.hash)) return json(res, 401, { error: "current password is wrong" });
      if (typeof b.next !== "string" || b.next.length < 8 || b.next.length > 100) return json(res, 400, { error: "new password needs 8+ characters" });
      r.hash = hashPw(b.next); r.mustChange = false; await saveReps(reps);
      return json(res, 200, { ok: true });
    }

    // orders API
    if (p === "/api/me") return sess ? json(res, 200, { user: sess.u, role: sess.r, name: sess.r === "owner" ? OWNERS[sess.u].name : sess.r === "customer" ? sess.customer.first : sess.rep.name, memberRate: sess.r === "customer" ? 0.15 : null }) : json(res, 401, { error: "not signed in" });
    if (p === "/api/orders" && req.method === "GET") { if (!isOwner) return json(res, 401, { error: "not available for this account" }); return json(res, 200, loadOrders()); }
    if (p === "/api/orders" && req.method === "POST") {
      if (limited("order:" + ip(req), 20, 36e5)) return json(res, 429, { error: "slow down" });
      let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "bad json" }); }
      const bad = validateOrder(b); if (bad) return json(res, 400, { error: bad });
      const stock = loadStock(); const short = b.items.filter(i => { const q = stock[stockKey(i.name, String(i.size || ""))]; return q != null && q < i.qty; });
      if (short.length) return json(res, 409, { error: "sold out: " + short.map(i => i.name + " " + i.size).join(", "), soldOut: short.map(i => stockKey(i.name, String(i.size || ""))) });
      const all = loadOrders();
      const promo = b.code ? resolveCode(b.code) : null;
      if (b.code && !promo) return json(res, 400, { error: "That code isn't valid or isn't active", badCode: true });
      const items = b.items.map(i => { const k = `${i.name}|${String(i.size || "")}`; const cat = CATALOG[k]; return { name: i.name, size: String(i.size || ""), qty: i.qty, price: cat != null ? cat : i.price }; });
      if (Object.keys(CATALOG).length) { const unknown = items.filter(i => CATALOG[`${i.name}|${i.size}`] == null && !/ blend$/.test(i.name)); if (unknown.length) return json(res, 400, { error: "unknown item: " + unknown.map(i => i.name + " " + i.size).join(", ") }); }
      // owners logged into the dashboard place test orders: simulated card, no stock taken, kept out of rep payouts
      const test = isOwner || ENV.testPay;
      const member = !!(sess && sess.r === "customer"); const pr = priceOrder(items, !!b.sub, promo, b.customer?.zip, member ? 0.15 : 0.10);
      const totals = { sub: pr.sub, disc: pr.disc, pdisc: pr.pdisc, ship: pr.ship, tax: 0, total: 0 };
      { const rate = taxRate(b.customer?.zip); totals.tax = r2((totals.sub - totals.disc - totals.pdisc) * rate); totals.total = r2(totals.sub - totals.disc - totals.pdisc + totals.ship + totals.tax); }
      const o = { id: nextId(all), t: new Date().toISOString(), customer: { first: b.customer?.first || "", last: b.customer?.last || "", email: (b.customer?.email || "").toLowerCase(), phone: b.customer?.phone || "", street: b.customer?.street || "", city: b.customer?.city || "", zip: b.customer?.zip || "" }, items, sub: !!b.sub, code: promo ? promo.code : "", promo: promo ? { type: promo.type, value: promo.value, rep: promo.rep } : null, totals, member, status: "received", paid: false, ...(test ? { test: true } : {}), ip: ip(req), customerId: sess && sess.r === "customer" ? sess.u : (loadCustomers().find(c => !c.removed && c.email === ((b.customer && b.customer.email) || "").toLowerCase()) || {}).id || undefined };
      await appendOrder(o);
      if (!test) { b.items.forEach(i => { const k = stockKey(i.name, String(i.size || "")); if (stock[k] != null) stock[k] = Math.max(0, stock[k] - i.qty); }); await saveStock(stock); }
      console.log(JSON.stringify({ at: o.t, event: "order", id: o.id, total: o.totals && o.totals.total, code: o.code }));
      if (!ENV.nmiSecret && !test) notifyOrder(o);
      qboSync(o.id); zohoSync(o.id);
      return json(res, 201, { id: o.id, total: o.totals ? o.totals.total : null, tax: o.totals ? o.totals.tax : 0, card: !!ENV.nmiSecret || test, testPay: test, crypto: ENV.crypto || null });
    }

    // public store
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    const rel = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
    return serveStatic(res, PUB, rel);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: "server error" });
  }
});
server.listen(PORT, () => console.log(`Varsity Labs site on :${PORT} (data: ${DATA_DIR})`));

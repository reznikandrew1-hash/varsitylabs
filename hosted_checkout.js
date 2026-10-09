  $("#coPay").onclick = async () => {
    const zipv = ($("#coZip").value || "").trim(); const f = [...root.querySelectorAll(".f input")].filter(i => i.id !== "coZip").map(i => i.value.trim()); const [first, last, email, phone, city, street] = f;
    if (!/^\d{5}$/.test(zipv)) { toast("Enter your ZIP first so we can check delivery"); $("#coZip").focus(); return; }
    if (!first || !/^[^\s@]+@[^\s@]+$/.test(email)) { toast("Add your name and a real email so we can confirm"); return; }
    if (!street || !city) { toast("Add the street address and city"); return; }
    const n = totals();
    const body = { customer: { first, last, email, phone, street, city, zip: zipv }, items: state.cart.map(i => ({ name: i.name, size: i.size, qty: i.qty, price: i.price })), sub: state.sub, code: state.promo ? state.promo.code : "", totals: { sub: n.sub, disc: n.disc, pdisc: n.pdisc, ship: n.ship, total: n.total } };
    const btn = $("#coPay"); btn.disabled = true; btn.textContent = "Sending…"; const wantsSub = !!state.sub;
    const local = /^323\d\d$/.test(zipv);
    try {
      const r = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json();
      if (r.status === 409 && j.soldOut) { state.soldOut = [...new Set([...state.soldOut, ...j.soldOut])]; renderGrid(); throw new Error(j.error); }
      if (!r.ok) throw new Error(j.error || "failed");
      const done = (paid, extra) => { state.cart = []; state.promo = null; state.open = false; save(); renderCart(); root.querySelector(".cobox").innerHTML = `<button class="x" id="coX2" aria-label="Close">&times;</button><h3 class="disp">Order ${j.id} received</h3><p style="color:var(--ink-2)">${paid ? "Payment went through. " : ""}A confirmation is on its way to ${email}${phone ? " and " + phone : ""}. ${local ? (beforeCutoff() ? "It arrives today, cold-packed." : "It arrives tomorrow before noon.") : "It ships cold on the next 2pm run with tracking."}</p>${extra || ""}<p class="rou">For research use only. Not for human or veterinary use.</p>${memberBlock(j.id)}`; $("#coX2").onclick = close; const cnt = $("#suCount"); if (cnt) { let n = 8; const tick = setInterval(() => { n--; if (n <= 0) { clearInterval(tick); location.href = $("#suGo").href; } else cnt.textContent = n; }, 1000); $("#suStay").onclick = e => { e.preventDefault(); clearInterval(tick); $("#suAuto").remove(); }; } };
      const memberBlock = id => { const q = new URLSearchParams({ order: id, first, last, email, phone }).toString(); return wantsSub ? `<div class="member"><b>Your 4-week resupply, 15% off as a member</b><p>Create a free member account and every 4-week reorder is 15% off instead of 10%. Track this order, set how often you want a reminder, and get a text and email when it's time. No card on file, nothing automatic. You reorder in two taps.</p><a class="btn pri" id="suGo" href="/signup?${q}">Create my free account</a><p id="suAuto" class="hint">Taking you there in <b id="suCount">8</b>s. <a href="#" id="suStay">Stay here</a></p></div>` : `<p class="hint">Members get 15% off every 4-week reorder, plus order history and resupply reminders. <a href="/signup?${q}">Create a free account.</a></p>`; };
      if (j.testPay) {
        // Test mode (owner signed in, or TEST_PAYMENTS locally): no real card form, pick an outcome instead.
        btn.textContent = "Test payment";
        const pay = async token => { const pr = await fetch("/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: j.id, token }) }); const pj = await pr.json(); if (!pr.ok) throw new Error(pj.error || "declined"); };
        const box = document.createElement("div"); box.className = "testpay"; box.style.cssText = "margin-top:12px;padding:12px 14px;border:1px dashed var(--line-strong,#999);border-radius:10px;font-size:13px";
        box.innerHTML = `<b>Test mode.</b> Order ${j.id} for $${j.total.toFixed(2)} is saved. No card is charged.<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button type="button" class="btn pri" data-tp="ok">Simulate approved card</button><button type="button" class="btn" data-tp="decline">Simulate declined card</button></div>`;
        btn.after(box);
        box.querySelector('[data-tp="ok"]').onclick = async () => { try { await pay("test-ok"); done(true); } catch (e) { toast(e.message); } };
        box.querySelector('[data-tp="decline"]').onclick = async () => { try { await pay("test-decline"); done(true); } catch (e) { done(false, `<p style="color:var(--ink-2)"><b>The card didn't go through (${e.message}).</b> Your order is saved as unpaid; we'll text you a payment link.</p>`); } };
      } else if (j.card && window.CollectJS) {
        btn.textContent = "Opening secure payment…";
        CollectJS.configure({ variant: "lightbox", price: String(j.total.toFixed(2)), currency: "USD", country: "US", callback: async resp => { try { const pr = await fetch("/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: j.id, token: resp.token }) }); const pj = await pr.json(); if (!pr.ok) throw new Error(pj.error || "declined"); done(true); } catch (e) { done(false, `<p style="color:var(--ink-2)"><b>The card didn't go through (${e.message}).</b> Your order is saved as unpaid; we'll text you a payment link.</p>`); } } });
        CollectJS.startPaymentRequest();
      } else {
        done(false, j.crypto ? `<p><a class="btn pri" href="${j.crypto}" target="_blank" rel="noopener">Pay with crypto</a> <span style="font-size:13px;color:var(--ink-2)">or wait for our text with a card link.</span></p>` : `<p style="color:var(--ink-2)">Nothing is charged yet. We'll text you a secure payment link to confirm.</p>`);
      }
    }
    catch (e) { btn.disabled = false; btn.innerHTML = "Place order &middot; " + money(totals().total); toast(e.message === "failed" ? "Couldn't place the order. Try again in a moment." : e.message); }
  };
  $("#coZip").addEventListener("input", async () => { const z = $("#coZip").value.trim(); if (!/^\d{5}$/.test(z)) return; try { const r = await fetch("/api/tax?zip=" + z).then(x => x.json()); state.taxRate = r.rate || 0; coZip(); } catch (e) {} });

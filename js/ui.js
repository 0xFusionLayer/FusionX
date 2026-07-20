/* =========================================================
 * FusionX — UI utilities
 * Escaping, markdown, toasts, modals, the transaction
 * status card, and small formatting helpers.
 * ========================================================= */

const UI = (() => {

  /* ---------- escaping & markdown ---------- */

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function escAttr(s) { return esc(s); }

  /* Markdown -> sanitized HTML. @mentions become profile links. */
  function md(text) {
    let t = String(text ?? "");
    t = t.replace(/(^|\s)@([A-Za-z0-9_]{3,})/g, (m, pre, u) => `${pre}[@${u}](#${u})`);
    let html;
    /* breaks:true — single newlines render as line breaks (people write
       posts Twitter-style; default markdown would collapse them). */
    try { html = marked.parse(t, { mangle: false, headerIds: false, gfm: true, breaks: true }); }
    catch (e) { html = esc(t); }
    html = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ["a","p","br","b","i","em","strong","del","code","pre","blockquote",
                     "ul","ol","li","h1","h2","h3","h4","h5","h6","img","hr","span"],
      ALLOWED_ATTR: ["href","src","alt","title","class"]
    });
    const div = document.createElement("div");
    div.innerHTML = html;
    div.querySelectorAll("a").forEach(a => {
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("#")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    });
    div.querySelectorAll("img").forEach(img => { img.loading = "lazy"; });
    return div.innerHTML;
  }

  /* Preview of markdown, truncated at a word boundary.
   * Truncates the rendered HTML in place so formatting is preserved. */
  function mdPreview(text, postId, maxChars = 300) {
    const full = md(text);
    const div = document.createElement("div");
    div.innerHTML = full;
    const plain = div.textContent || "";
    if (plain.length <= maxChars) return full;

    let budget = maxChars;
    const sp = plain.slice(0, maxChars).lastIndexOf(" ");
    if (sp > maxChars * 0.6) budget = sp;

    let used = 0, done = false;
    (function walk(node) {
      for (const child of Array.from(node.childNodes)) {
        if (done) { child.remove(); continue; }
        if (child.nodeType === Node.TEXT_NODE) {
          const len = child.textContent.length;
          if (used + len >= budget) {
            child.textContent = child.textContent.slice(0, budget - used).replace(/\s+$/, "") + "…";
            done = true;
          } else {
            used += len;
          }
        } else {
          walk(child);
          if (done && !child.textContent && !child.querySelector("img")) child.remove();
        }
      }
    })(div);

    return `${div.innerHTML}<a class="readMore" href="#post${postId}" onclick="event.stopPropagation()">Show more</a>`;
  }

  /* ---------- formatting ---------- */

  function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }

  function timeAgo(ts) {
    const s = Math.floor(Date.now() / 1000) - ts;
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 2592000) return Math.floor(s / 86400) + "d";
    return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function fullDate(ts) { return new Date(ts * 1000).toLocaleString("en-GB"); }
  function joinDate(ts) { return new Date(ts * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric" }); }

  function avatar(info, size = "") {
    const cls = "avatar" + (size ? " " + size : "");
    if (info && info.avatar && info.avatar.trim()) {
      const initial = esc((info.nickname || "?").charAt(0).toUpperCase());
      return `<span class="${cls}" data-initial="${initial}"><img src="${escAttr(info.avatar)}" alt="" loading="lazy"
        onerror="this.parentElement.textContent=this.parentElement.dataset.initial;this.remove()"></span>`;
    }
    const c = info && info.nickname ? info.nickname.charAt(0).toUpperCase() : "?";
    return `<span class="${cls}">${esc(c)}</span>`;
  }

  async function copy(text, label = "Copied to clipboard") {
    try { await navigator.clipboard.writeText(text); toast(label, "success"); }
    catch (e) { toast("Copy failed — copy manually.", "error"); }
  }

  /* ---------- toasts ---------- */

  function toast(msg, type = "info", ms = 3500) {
    const host = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    const icon = type === "success" ? "fa-circle-check" : type === "error" ? "fa-circle-exclamation" : "fa-circle-info";
    el.innerHTML = `<i class="fas ${icon}"></i><span>${esc(msg)}</span>`;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, ms);
  }

  /* ---------- generic modal ---------- */

  let modalKeyHandler = null;

  function modal({ title, body, wide = false, dismissable = true }) {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "activeModal";
    overlay.innerHTML = `
      <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${title}</h3>
          ${dismissable ? `<button class="icon-btn modal-close" aria-label="Close"><i class="fas fa-xmark"></i></button>` : ""}
        </div>
        <div class="modal-body">${body}</div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");
    if (dismissable) {
      overlay.addEventListener("mousedown", e => { if (e.target === overlay) closeModal(); });
      overlay.querySelector(".modal-close").addEventListener("click", closeModal);
      modalKeyHandler = e => { if (e.key === "Escape") closeModal(); };
      document.addEventListener("keydown", modalKeyHandler);
    }
    return overlay.querySelector(".modal");
  }

  function closeModal() {
    document.getElementById("activeModal")?.remove();
    document.body.classList.remove("modal-open");
    if (modalKeyHandler) { document.removeEventListener("keydown", modalKeyHandler); modalKeyHandler = null; }
  }

  function confirm({ title, message, okLabel = "Confirm", danger = false }) {
    return new Promise(resolve => {
      const m = modal({
        title,
        body: `
          <p class="modal-text">${message}</p>
          <div class="modal-actions">
            <button class="btn ghost" id="cfCancel">Cancel</button>
            <button class="btn ${danger ? "danger" : "primary"}" id="cfOk">${esc(okLabel)}</button>
          </div>`
      });
      m.querySelector("#cfCancel").onclick = () => { closeModal(); resolve(false); };
      m.querySelector("#cfOk").onclick = () => { closeModal(); resolve(true); };
    });
  }

  /* ---------- loaders / skeletons ---------- */

  function spinnerHTML(label = "Loading…") {
    return `<div class="inline-loader"><span class="spinner"></span><span>${esc(label)}</span></div>`;
  }

  function skeletons(n = 3) {
    let out = "";
    for (let i = 0; i < n; i++) {
      out += `<div class="post-card skeleton">
        <div class="sk-row"><span class="sk-avatar"></span><span class="sk-line w40"></span></div>
        <div class="sk-line w90"></div><div class="sk-line w70"></div>
      </div>`;
    }
    return out;
  }

  function emptyState(icon, text) {
    return `<div class="empty-state"><i class="fas ${icon}"></i><p>${esc(text)}</p></div>`;
  }

  return {
    esc, escAttr, md, mdPreview,
    shortAddr, timeAgo, fullDate, joinDate, avatar, copy,
    toast, modal, closeModal, confirm,
    spinnerHTML, skeletons, emptyState
  };
})();

/* =========================================================
 * Tx — transaction runner with status card
 *
 * Every on-chain interaction goes through Tx.run():
 *   1. shows a floating card ("Posting comment…")
 *   2. waits for confirmation
 *   3. flips the card to success ("Comment was posted")
 *   4. refreshes the wallet balance
 * ========================================================= */

const Tx = (() => {

  let cardSeq = 0;

  function makeCard(pendingLabel) {
    const host = document.getElementById("txCards");
    const id = "txcard-" + (++cardSeq);
    const el = document.createElement("div");
    el.className = "tx-card pending";
    el.id = id;
    el.innerHTML = `
      <div class="tx-icon"><span class="spinner"></span></div>
      <div class="tx-info">
        <div class="tx-title">${UI.esc(pendingLabel)}</div>
        <div class="tx-sub">Waiting for confirmation…</div>
      </div>
      <button class="icon-btn tx-close" aria-label="Dismiss"><i class="fas fa-xmark"></i></button>`;
    el.querySelector(".tx-close").onclick = () => dismiss(el);
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    return el;
  }

  function dismiss(el, delay = 0) {
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, delay);
  }

  function explorerTx(hash) { return `${CHAIN.explorer}/tx/${hash}`; }

  function friendlyError(e) {
    if (!e) return "Transaction failed.";
    if (e.code === "ACTION_REJECTED") return "Transaction cancelled.";
    if (e.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(e.message || ""))
      return `Not enough ${CHAIN.symbol} to pay for gas. Top up your wallet and try again.`;
    if (e.reason) return e.reason;
    if (e.shortMessage) return e.shortMessage;
    if (e.info && e.info.error && e.info.error.message) return e.info.error.message;
    return (e.message || "Transaction failed.").split("(")[0].slice(0, 160);
  }

  /**
   * run("Posting comment", "Comment was posted", () => Chain.tx.createComment(...))
   * Returns true on success, false on failure.
   */
  async function run(pendingLabel, successLabel, buildTx) {
    if (!Wallet.isUnlocked()) { App.requireWallet(); return false; }
    const card = makeCard(pendingLabel + "…");
    try {
      const tx = await buildTx();
      card.querySelector(".tx-sub").innerHTML =
        `Broadcast — <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">view on FusionScan</a>`;
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Transaction reverted on-chain.");
      await Wallet.refreshBalance();
      card.classList.remove("pending");
      card.classList.add("success");
      card.querySelector(".tx-icon").innerHTML = `<i class="fas fa-circle-check"></i>`;
      card.querySelector(".tx-title").textContent = successLabel;
      card.querySelector(".tx-sub").innerHTML =
        `Confirmed — <a href="${explorerTx(tx.hash)}" target="_blank" rel="noopener">view on FusionScan</a>`;
      dismiss(card, 6000);
      return true;
    } catch (e) {
      console.error(pendingLabel, e);
      card.classList.remove("pending");
      card.classList.add("error");
      card.querySelector(".tx-icon").innerHTML = `<i class="fas fa-circle-exclamation"></i>`;
      card.querySelector(".tx-title").textContent = pendingLabel + " failed";
      card.querySelector(".tx-sub").textContent = friendlyError(e);
      dismiss(card, 9000);
      return false;
    }
  }

  return { run, friendlyError };
})();

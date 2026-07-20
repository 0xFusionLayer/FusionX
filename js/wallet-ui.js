/* =========================================================
 * FusionX — Wallet UI
 * Onboarding (create / import), unlock, navbar chip,
 * and the #wallet page (balance, send, receive, backup).
 * ========================================================= */

const WalletUI = (() => {

  /* ---------- navbar ---------- */

  function renderNavbar() {
    const host = document.getElementById("walletArea");
    if (!Wallet.hasKeystore()) {
      host.innerHTML = `<button class="btn primary" id="nbCreate"><i class="fas fa-wallet"></i> Get Started</button>`;
      host.querySelector("#nbCreate").onclick = openOnboarding;
      return;
    }
    if (!Wallet.isUnlocked()) {
      host.innerHTML = `<button class="btn primary" id="nbUnlock"><i class="fas fa-lock-open"></i> Unlock Wallet</button>`;
      host.querySelector("#nbUnlock").onclick = openUnlock;
      return;
    }
    const addr = Wallet.address();
    host.innerHTML = `
      <a class="balance-chip" href="#wallet" title="Open wallet">
        <i class="fas fa-coins"></i>
        <span id="nbBalance">${Wallet.balanceFormatted()} ${CHAIN.symbol}</span>
      </a>
      <a class="addr-chip" href="#wallet" title="${UI.escAttr(addr)}">${UI.shortAddr(addr)}</a>
      <button class="icon-btn" id="nbLogout" title="Logout"><i class="fas fa-right-from-bracket"></i></button>`;
    host.querySelector("#nbLogout").onclick = doLogout;
  }

  function updateBalanceChip() {
    const el = document.getElementById("nbBalance");
    if (el) el.textContent = `${Wallet.balanceFormatted()} ${CHAIN.symbol}`;
    const wp = document.getElementById("walletPageBalance");
    if (wp) wp.textContent = Wallet.balanceFormatted(6);
  }

  async function doLogout() {
    const ok = await UI.confirm({
      title: "Logout",
      message: "Your wallet will be locked. The encrypted key stays on this device — you can unlock it again with your password.",
      okLabel: "Logout"
    });
    if (!ok) return;
    Wallet.logout();
    UI.toast("Wallet locked. See you soon!", "info");
    App.onWalletChange();
  }

  /* ---------- password strength ---------- */

  function pwHints(pw) {
    if (pw.length < 8) return { ok: false, msg: "Password must be at least 8 characters." };
    return { ok: true, msg: "" };
  }

  function progressBar(id) {
    return `<div class="progress-track" id="${id}" style="display:none"><div class="progress-fill"></div></div>`;
  }

  function setProgress(id, pct) {
    const track = document.getElementById(id);
    if (!track) return;
    track.style.display = "block";
    track.querySelector(".progress-fill").style.width = Math.round(pct * 100) + "%";
  }

  /* ---------- onboarding (create / import) ---------- */

  function openOnboarding(defaultTab) {
    if (typeof defaultTab !== "string") defaultTab = "create"; // tolerate being used as a click handler
    const m = UI.modal({
      title: `Welcome to ${APP_NAME}`,
      body: `
        <div class="tab-row">
          <button class="tab-btn" data-tab="create">Create Wallet</button>
          <button class="tab-btn" data-tab="import">Import Wallet</button>
        </div>
        <div id="obPanel"></div>`
    });
    const panel = m.querySelector("#obPanel");
    const tabs = m.querySelectorAll(".tab-btn");
    function show(tab) {
      tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
      panel.innerHTML = tab === "create" ? createFormHTML() : importFormHTML();
      if (tab === "create") wireCreateForm(panel); else wireImportForm(panel);
    }
    tabs.forEach(t => t.onclick = () => show(t.dataset.tab));
    show(defaultTab);
  }

  function createFormHTML() {
    return `
      <p class="modal-text">A new ${CHAIN.name} wallet will be generated <b>${STORAGE_PLACE}</b>.
      The key is encrypted with your password and stored only ${STORAGE_DETAIL}.</p>
      <label class="field-label">Password (min. 8 characters)</label>
      <input type="password" id="obPw1" class="input" autocomplete="new-password" placeholder="Choose a strong password">
      <label class="field-label">Confirm password</label>
      <input type="password" id="obPw2" class="input" autocomplete="new-password" placeholder="Repeat password">
      <p class="field-error" id="obErr"></p>
      ${progressBar("obProg")}
      <div class="modal-actions">
        <button class="btn primary block" id="obCreateBtn"><i class="fas fa-wand-magic-sparkles"></i> Generate Wallet</button>
      </div>
      <p class="fine-print"><i class="fas fa-shield-halved"></i> ${APP_NAME} has no servers — if you lose the password and your key backup, the wallet cannot be recovered.</p>`;
  }

  function wireCreateForm(panel) {
    panel.querySelector("#obCreateBtn").onclick = async () => {
      const pw1 = panel.querySelector("#obPw1").value;
      const pw2 = panel.querySelector("#obPw2").value;
      const err = panel.querySelector("#obErr");
      const hint = pwHints(pw1);
      if (!hint.ok) { err.textContent = hint.msg; return; }
      if (pw1 !== pw2) { err.textContent = "Passwords do not match."; return; }
      err.textContent = "";
      const btn = panel.querySelector("#obCreateBtn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Encrypting…`;
      try {
        const res = await Wallet.create(pw1, pct => setProgress("obProg", pct));
        showBackup(res);
      } catch (e) {
        btn.disabled = false; btn.innerHTML = `<i class="fas fa-wand-magic-sparkles"></i> Generate Wallet`;
        err.textContent = "Wallet creation failed: " + (e.message || e);
      }
    };
  }

  function showBackup(res) {
    const m = UI.modal({
      title: "Back up your wallet",
      dismissable: false,
      body: `
        <p class="modal-text"><b>This is the only time your key is shown.</b> Save it somewhere safe and offline —
        it is the master key to your account and funds.</p>
        <label class="field-label">Address</label>
        <div class="key-box">
          <code>${UI.esc(res.address)}</code>
          <button class="icon-btn" id="bkCopyAddr" title="Copy"><i class="fas fa-copy"></i></button>
        </div>
        <label class="field-label">Private key</label>
        <div class="key-box danger-box">
          <code>${UI.esc(res.privateKey)}</code>
          <button class="icon-btn" id="bkCopyPk" title="Copy"><i class="fas fa-copy"></i></button>
        </div>
        ${res.mnemonic ? `
        <label class="field-label">Recovery phrase</label>
        <div class="key-box danger-box">
          <code>${UI.esc(res.mnemonic)}</code>
          <button class="icon-btn" id="bkCopyMn" title="Copy"><i class="fas fa-copy"></i></button>
        </div>` : ""}
        <label class="check-row"><input type="checkbox" id="bkConfirm">
          I have saved my private key. I understand it cannot be recovered.</label>
        <div class="modal-actions">
          <button class="btn primary block" id="bkDone" disabled><i class="fas fa-check"></i> I'm safe — enter ${APP_NAME}</button>
        </div>`
    });
    m.querySelector("#bkCopyAddr").onclick = () => UI.copy(res.address, "Address copied");
    m.querySelector("#bkCopyPk").onclick = () => UI.copy(res.privateKey, "Private key copied — store it safely!");
    m.querySelector("#bkCopyMn")?.addEventListener("click", () => UI.copy(res.mnemonic, "Recovery phrase copied — store it safely!"));
    const chk = m.querySelector("#bkConfirm");
    const done = m.querySelector("#bkDone");
    chk.onchange = () => done.disabled = !chk.checked;
    done.onclick = () => {
      UI.closeModal();
      UI.toast("Wallet ready. Welcome to " + APP_NAME + "!", "success");
      App.onWalletChange();
    };
  }

  function importFormHTML() {
    return `
      <p class="modal-text">Paste the private key of an existing wallet. It will be encrypted with your
      password and stored <b>only ${STORAGE_DETAIL}</b>.</p>
      <label class="field-label">Private key</label>
      <input type="password" id="obPk" class="input mono" autocomplete="off" placeholder="0x…">
      <label class="field-label">Password (min. 8 characters)</label>
      <input type="password" id="obPw1" class="input" autocomplete="new-password" placeholder="Choose a strong password">
      <label class="field-label">Confirm password</label>
      <input type="password" id="obPw2" class="input" autocomplete="new-password" placeholder="Repeat password">
      <p class="field-error" id="obErr"></p>
      ${progressBar("obProg")}
      <div class="modal-actions">
        <button class="btn primary block" id="obImportBtn"><i class="fas fa-file-import"></i> Import Wallet</button>
      </div>`;
  }

  function wireImportForm(panel) {
    panel.querySelector("#obImportBtn").onclick = async () => {
      const pk = panel.querySelector("#obPk").value.trim();
      const pw1 = panel.querySelector("#obPw1").value;
      const pw2 = panel.querySelector("#obPw2").value;
      const err = panel.querySelector("#obErr");
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) { err.textContent = "That doesn't look like a valid private key (64 hex characters)."; return; }
      const hint = pwHints(pw1);
      if (!hint.ok) { err.textContent = hint.msg; return; }
      if (pw1 !== pw2) { err.textContent = "Passwords do not match."; return; }
      err.textContent = "";
      const btn = panel.querySelector("#obImportBtn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Encrypting…`;
      try {
        const res = await Wallet.importKey(pk, pw1, pct => setProgress("obProg", pct));
        UI.closeModal();
        UI.toast(`Wallet ${UI.shortAddr(res.address)} imported!`, "success");
        App.onWalletChange();
      } catch (e) {
        btn.disabled = false; btn.innerHTML = `<i class="fas fa-file-import"></i> Import Wallet`;
        err.textContent = "Import failed: " + (e.message || e);
      }
    };
  }

  /* ---------- unlock ---------- */

  function openUnlock() {
    const addr = Wallet.savedAddress();
    const m = UI.modal({
      title: "Unlock Wallet",
      body: `
        <div class="unlock-id">
          ${UI.avatar({ nickname: "•" }, "lg")}
          <div>
            <div class="unlock-label">Saved wallet on this device</div>
            <code class="unlock-addr">${UI.esc(addr || "unknown")}</code>
          </div>
        </div>
        <label class="field-label">Password</label>
        <input type="password" id="ulPw" class="input" autocomplete="current-password" placeholder="Your wallet password" autofocus>
        <p class="field-error" id="ulErr"></p>
        ${progressBar("ulProg")}
        <div class="modal-actions">
          <button class="btn primary block" id="ulBtn"><i class="fas fa-lock-open"></i> Unlock</button>
        </div>
        <p class="fine-print">
          <a href="javascript:void(0)" id="ulForget">Use a different wallet…</a>
        </p>`
    });
    const doUnlock = async () => {
      const pw = m.querySelector("#ulPw").value;
      const err = m.querySelector("#ulErr");
      if (!pw) { err.textContent = "Enter your password."; return; }
      err.textContent = "";
      const btn = m.querySelector("#ulBtn");
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Decrypting…`;
      try {
        await Wallet.unlock(pw, pct => setProgress("ulProg", pct));
        UI.closeModal();
        UI.toast("Wallet unlocked. Welcome back!", "success");
        App.onWalletChange();
      } catch (e) {
        btn.disabled = false; btn.innerHTML = `<i class="fas fa-lock-open"></i> Unlock`;
        err.textContent = "Wrong password — please try again.";
      }
    };
    m.querySelector("#ulBtn").onclick = doUnlock;
    m.querySelector("#ulPw").addEventListener("keydown", e => { if (e.key === "Enter") doUnlock(); });
    m.querySelector("#ulForget").onclick = async () => {
      const ok = await UI.confirm({
        title: "Remove saved wallet?",
        message: "This deletes the encrypted key from this device. Make sure you have the private key backed up — without it the wallet is gone forever.",
        okLabel: "Delete from device", danger: true
      });
      if (ok) { Wallet.forget(); UI.closeModal(); App.onWalletChange(); openOnboarding(); }
    };
  }

  /* ---------- wallet page ---------- */

  function renderWalletPage(container) {
    if (!Wallet.hasKeystore()) {
      container.innerHTML = `
        <div class="panel center-panel">
          <i class="fas fa-wallet panel-hero-icon"></i>
          <h2>No wallet yet</h2>
          <p class="muted">Create a new ${CHAIN.name} wallet or import an existing key. Everything stays ${STORAGE_PLACE} — encrypted ${STORAGE_DETAIL}.</p>
          <button class="btn primary" id="wpCreate"><i class="fas fa-wand-magic-sparkles"></i> Create / Import Wallet</button>
        </div>`;
      container.querySelector("#wpCreate").onclick = () => openOnboarding();
      return;
    }
    if (!Wallet.isUnlocked()) {
      container.innerHTML = `
        <div class="panel center-panel">
          <i class="fas fa-lock panel-hero-icon"></i>
          <h2>Wallet locked</h2>
          <p class="muted">Wallet <code>${UI.esc(UI.shortAddr(Wallet.savedAddress()))}</code> is saved on this device.</p>
          <button class="btn primary" id="wpUnlock"><i class="fas fa-lock-open"></i> Unlock</button>
        </div>`;
      container.querySelector("#wpUnlock").onclick = openUnlock;
      return;
    }

    const addr = Wallet.address();
    container.innerHTML = `
      <div class="panel wallet-hero">
        <div class="wallet-balance-label">Balance</div>
        <div class="wallet-balance"><span id="walletPageBalance">${Wallet.balanceFormatted(6)}</span> <small>${CHAIN.symbol}</small></div>
        <div class="wallet-addr-row">
          <code>${UI.esc(addr)}</code>
          <button class="icon-btn" id="wpCopy" title="Copy address"><i class="fas fa-copy"></i></button>
          <a class="icon-btn" href="${CHAIN.explorer}/address/${UI.escAttr(addr)}" target="_blank" rel="noopener" title="View on FusionScan"><i class="fas fa-arrow-up-right-from-square"></i></a>
        </div>
      </div>

      <div class="wallet-grid">
        <div class="panel">
          <h3><i class="fas fa-paper-plane"></i> Send ${CHAIN.symbol}</h3>
          <label class="field-label">Recipient address</label>
          <input type="text" id="sendTo" class="input mono" placeholder="0x…">
          <label class="field-label">Amount (${CHAIN.symbol})</label>
          <input type="number" id="sendAmt" class="input" min="0" step="any" placeholder="0.0">
          <p class="field-error" id="sendErr"></p>
          <button class="btn primary block" id="sendBtn"><i class="fas fa-paper-plane"></i> Send</button>
        </div>

        <div class="panel">
          <h3><i class="fas fa-qrcode"></i> Receive</h3>
          <p class="muted">Share your address to receive ${CHAIN.symbol} or tips from other users.</p>
          <div class="key-box"><code>${UI.esc(addr)}</code>
            <button class="icon-btn" id="wpCopy2" title="Copy"><i class="fas fa-copy"></i></button>
          </div>
          <p class="fine-print">Need ${CHAIN.symbol}? Visit <a href="${LINKS.website}" target="_blank" rel="noopener">fusionlayer.org</a> to learn how to get it.</p>
        </div>
      </div>

      <div class="panel">
        <h3><i class="fas fa-shield-halved"></i> Security</h3>
        <div class="settings-row">
          <div>
            <b>Backup private key</b>
            <p class="muted">Reveal your key to back it up. Never share it with anyone.</p>
          </div>
          <button class="btn ghost" id="wpReveal"><i class="fas fa-eye"></i> Reveal</button>
        </div>
        <div class="settings-row">
          <div>
            <b>Logout</b>
            <p class="muted">Locks the wallet on this device. Unlock again with your password.</p>
          </div>
          <button class="btn ghost" id="wpLogout"><i class="fas fa-right-from-bracket"></i> Logout</button>
        </div>
        <div class="settings-row">
          <div>
            <b>Remove wallet from device</b>
            <p class="muted">Deletes the encrypted keystore stored ${STORAGE_DETAIL}. Irreversible without your backup.</p>
          </div>
          <button class="btn danger" id="wpForget"><i class="fas fa-trash"></i> Remove</button>
        </div>
      </div>`;

    container.querySelector("#wpCopy").onclick = () => UI.copy(addr, "Address copied");
    container.querySelector("#wpCopy2").onclick = () => UI.copy(addr, "Address copied");
    container.querySelector("#wpLogout").onclick = doLogout;

    container.querySelector("#wpReveal").onclick = async () => {
      const ok = await UI.confirm({
        title: "Reveal private key?",
        message: "Anyone who sees this key controls your wallet. Make sure nobody is watching your screen.",
        okLabel: "Reveal", danger: true
      });
      if (!ok) return;
      const pk = Wallet.revealPrivateKey();
      const m = UI.modal({
        title: "Private key",
        body: `
          <div class="key-box danger-box"><code>${UI.esc(pk)}</code>
            <button class="icon-btn" id="rvCopy" title="Copy"><i class="fas fa-copy"></i></button>
          </div>
          <p class="fine-print"><i class="fas fa-triangle-exclamation"></i> Never paste this key into websites or messages.</p>`
      });
      m.querySelector("#rvCopy").onclick = () => UI.copy(pk, "Private key copied — store it safely!");
    };

    container.querySelector("#wpForget").onclick = async () => {
      const ok = await UI.confirm({
        title: "Remove wallet from this device?",
        message: `The encrypted keystore will be deleted from ${IS_DESKTOP ? "this PC" : "this browser"}. You can only restore the wallet with your private key backup.`,
        okLabel: "Remove wallet", danger: true
      });
      if (!ok) return;
      Wallet.forget();
      UI.toast("Wallet removed from this device.", "info");
      App.onWalletChange();
    };

    container.querySelector("#sendBtn").onclick = async () => {
      const to = container.querySelector("#sendTo").value.trim();
      const amt = container.querySelector("#sendAmt").value.trim();
      const err = container.querySelector("#sendErr");
      err.textContent = "";
      if (!ethers.isAddress(to)) { err.textContent = "Invalid recipient address."; return; }
      if (!amt || isNaN(amt) || Number(amt) <= 0) { err.textContent = "Enter a valid amount."; return; }
      let value;
      try { value = ethers.parseEther(amt); } catch (e) { err.textContent = "Invalid amount."; return; }
      const bal = Wallet.balance();
      if (bal !== null && value > bal) { err.textContent = `Amount exceeds your balance (${Wallet.balanceFormatted(6)} ${CHAIN.symbol}).`; return; }
      const ok = await UI.confirm({
        title: "Confirm transfer",
        message: `Send <b>${UI.esc(amt)} ${CHAIN.symbol}</b> to<br><code>${UI.esc(to)}</code>?<br><br>This cannot be undone.`,
        okLabel: "Send"
      });
      if (!ok) return;
      const success = await Tx.run(`Sending ${amt} ${CHAIN.symbol}`, `${amt} ${CHAIN.symbol} sent`, () => Wallet.send(to, amt));
      if (success) {
        container.querySelector("#sendTo").value = "";
        container.querySelector("#sendAmt").value = "";
      }
    };
  }

  return { renderNavbar, updateBalanceChip, openOnboarding, openUnlock, renderWalletPage };
})();

/* =========================================================
 * FusionX — Built-in Web Wallet
 *
 * Keys are generated / imported in the browser, encrypted
 * with the user's password (standard keystore JSON, scrypt)
 * and stored in localStorage. They never leave the device.
 *
 * A per-tab session (sessionStorage) keeps the wallet
 * unlocked so the user is not asked for the password on
 * every interaction. Logout ends the session; the encrypted
 * keystore stays so the user can unlock again later.
 * ========================================================= */

const Wallet = (() => {

  let provider = null;      // ethers.JsonRpcProvider (read + broadcast)
  let signer = null;        // ethers.Wallet when unlocked, else null
  let balanceWei = null;    // last known balance (bigint)
  let balanceTimer = null;

  const listeners = { change: [], balance: [], rpc: [] };

  function on(evt, fn) { listeners[evt].push(fn); }
  function emit(evt, ...args) { listeners[evt].forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } }); }

  /* ---------- provider & RPC management ---------- */

  let rpcIndex = 0; // rotation index over CHAIN.rpcUrls when no user override is set

  function buildProvider(url) {
    const network = ethers.Network.from({ chainId: CHAIN.chainId, name: CHAIN.name });
    return new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
  }

  function selectedRpc() { return localStorage.getItem(STORE.rpc) || null; }
  function currentRpc() { return selectedRpc() || CHAIN.rpcUrls[rpcIndex]; }
  function isCustomRpcActive() { return !!selectedRpc(); }

  function getProvider() {
    if (!provider) provider = buildProvider(currentRpc());
    return provider;
  }

  /* Point the entire app at a different RPC. Pass null to go back to defaults. */
  function setRpc(url) {
    if (url) localStorage.setItem(STORE.rpc, url);
    else localStorage.removeItem(STORE.rpc);
    rpcIndex = 0;
    provider = buildProvider(currentRpc());
    if (signer) signer = signer.connect(provider);
    emit("rpc", currentRpc());
    refreshBalance();
  }

  /* Called by the read layer when a request fails at the network level.
     With a user-selected RPC we stay on it (rebuild the provider);
     on defaults we rotate to the fallback endpoint. */
  function rotateRpc() {
    if (!selectedRpc()) rpcIndex = (rpcIndex + 1) % CHAIN.rpcUrls.length;
    provider = buildProvider(currentRpc());
    if (signer) signer = signer.connect(provider);
    emit("rpc", currentRpc());
    return provider;
  }

  /* ---------- custom RPC list (persisted) ---------- */

  function customRpcs() {
    try { return JSON.parse(localStorage.getItem(STORE.customRpcs) || "[]"); }
    catch (e) { return []; }
  }
  function addCustomRpc(url) {
    const list = customRpcs();
    if (!list.includes(url)) { list.push(url); localStorage.setItem(STORE.customRpcs, JSON.stringify(list)); }
  }
  function removeCustomRpc(url) {
    localStorage.setItem(STORE.customRpcs, JSON.stringify(customRpcs().filter(u => u !== url)));
    if (selectedRpc() === url) setRpc(null); // fall back to defaults if the active one is removed
  }

  /* Low-level JSON-RPC probe (plain fetch — independent of ethers). */
  async function rpcCall(url, method, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: ctrl.signal
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || "RPC error");
      return j.result;
    } finally {
      clearTimeout(t);
    }
  }

  /* Health-check an endpoint: reachability, chain id, latest block, latency. */
  async function testRpc(url) {
    const started = Date.now();
    try {
      const chainId = parseInt(await rpcCall(url, "eth_chainId"), 16);
      const latency = Date.now() - started;
      let block = null;
      try { block = parseInt(await rpcCall(url, "eth_blockNumber"), 16); } catch (e) {}
      return { reachable: true, chainId, block, latency, matches: chainId === CHAIN.chainId };
    } catch (e) {
      return { reachable: false, error: (e && e.name === "AbortError") ? "timed out" : (e.message || String(e)) };
    }
  }

  /* ---------- keystore state ---------- */

  function hasKeystore() { return !!localStorage.getItem(STORE.keystore); }
  function savedAddress() { return localStorage.getItem(STORE.address) || null; }
  function isUnlocked() { return !!signer; }
  function address() { return signer ? signer.address : null; }
  function getSigner() { return signer; }

  /* ---------- create / import / unlock / logout ---------- */

  async function create(password, progress) {
    const random = ethers.Wallet.createRandom();
    const json = await random.encrypt(password, progress);
    localStorage.setItem(STORE.keystore, json);
    localStorage.setItem(STORE.address, random.address);
    startSession(random.privateKey);
    return { address: random.address, privateKey: random.privateKey, mnemonic: random.mnemonic ? random.mnemonic.phrase : null };
  }

  async function importKey(privateKey, password, progress) {
    let pk = privateKey.trim();
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    const w = new ethers.Wallet(pk); // throws on invalid key
    const json = await w.encrypt(password, progress);
    localStorage.setItem(STORE.keystore, json);
    localStorage.setItem(STORE.address, w.address);
    startSession(w.privateKey);
    return { address: w.address };
  }

  async function unlock(password, progress) {
    const json = localStorage.getItem(STORE.keystore);
    if (!json) throw new Error("No wallet found on this device.");
    const w = await ethers.Wallet.fromEncryptedJson(json, password, progress); // throws on wrong password
    startSession(w.privateKey);
    return { address: w.address };
  }

  function startSession(privateKey) {
    signer = new ethers.Wallet(privateKey, getProvider());
    try { sessionStorage.setItem(STORE.session, privateKey); } catch (e) { /* private mode */ }
    emit("change");
    refreshBalance();
    startBalancePolling();
  }

  /* Restore an unlocked session after a page reload (same tab). */
  function restoreSession() {
    const pk = sessionStorage.getItem(STORE.session);
    if (!pk) return false;
    try {
      signer = new ethers.Wallet(pk, getProvider());
      refreshBalance();
      startBalancePolling();
      return true;
    } catch (e) {
      sessionStorage.removeItem(STORE.session);
      return false;
    }
  }

  function logout() {
    signer = null;
    balanceWei = null;
    sessionStorage.removeItem(STORE.session);
    stopBalancePolling();
    emit("change");
  }

  /* Remove the keystore entirely (user must re-import the key). */
  function forget() {
    logout();
    localStorage.removeItem(STORE.keystore);
    localStorage.removeItem(STORE.address);
    emit("change");
  }

  /* Reveal the private key for backup (requires active session). */
  function revealPrivateKey() {
    if (!signer) throw new Error("Wallet is locked.");
    return signer.privateKey;
  }

  /* ---------- balance ---------- */

  async function refreshBalance() {
    if (!signer) return null;
    try {
      balanceWei = await getProvider().getBalance(signer.address);
      emit("balance", balanceWei);
      return balanceWei;
    } catch (e) {
      console.warn("Balance fetch failed:", e);
      return null;
    }
  }

  function balance() { return balanceWei; }

  function balanceFormatted(digits = 4) {
    if (balanceWei === null) return "…";
    const s = ethers.formatEther(balanceWei);
    const [i, d] = s.split(".");
    return d ? `${i}.${d.slice(0, digits)}` : i;
  }

  function startBalancePolling() {
    stopBalancePolling();
    balanceTimer = setInterval(refreshBalance, 10000);
  }
  function stopBalancePolling() {
    if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; }
  }

  /* Catch deposits made while the tab was in the background. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && signer) refreshBalance();
  });
  window.addEventListener("focus", () => { if (signer) refreshBalance(); });

  /* ---------- native transfer ---------- */

  async function send(to, amountFxl) {
    if (!signer) throw new Error("Wallet is locked.");
    const value = ethers.parseEther(String(amountFxl));
    const tx = await signer.sendTransaction({ to: ethers.getAddress(to), value });
    return tx;
  }

  return {
    on, getProvider, rotateRpc,
    currentRpc, isCustomRpcActive, setRpc, customRpcs, addCustomRpc, removeCustomRpc, testRpc,
    hasKeystore, savedAddress, isUnlocked, address, getSigner,
    create, importKey, unlock, restoreSession, logout, forget, revealPrivateKey,
    refreshBalance, balance, balanceFormatted, send
  };
})();

/* =========================================================
 * FusionX — Application
 * Routing, feeds, posts, comments, profiles, settings.
 * ========================================================= */

const App = (() => {

  /* ================= state ================= */

  const state = {
    registered: false,     // is the unlocked wallet registered on-chain?
    me: null,              // { username, nickname, avatar, ... } for the unlocked wallet
    pinnedId: 0,
    route: "",
    homeFilterFollowing: false   // "Following only" feed filter (off by default, not persisted)
  };

  /* Active infinite feed (only one route visible at a time). */
  let activeFeed = null;

  /* ================= boot ================= */

  async function init() {
    initTheme();
    WalletUI.renderNavbar();

    Wallet.on("balance", WalletUI.updateBalanceChip);
    Wallet.on("change", WalletUI.renderNavbar);

    document.addEventListener("click", delegatedClicks);

    if (Wallet.restoreSession()) WalletUI.renderNavbar();
    await refreshIdentity();

    window.addEventListener("hashchange", route);
    route();

    loadSidebarWidgets();

    /* Chain watcher: roughly once per block — new-post banner + live stats. */
    setInterval(pollChain, 8000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollChain(); });

    /* desktop build tag at the bottom of the sidebar */
    if (IS_DESKTOP && DESKTOP_VERSION) {
      document.getElementById("sidebar")?.insertAdjacentHTML("beforeend",
        `<div class="sidebar-version"><i class="fas fa-desktop"></i> FusionX Desktop v${UI.esc(DESKTOP_VERSION)}</div>`);
    }

    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
    document.getElementById("searchBtn").addEventListener("click", doSearch);
  }

  async function refreshIdentity() {
    state.registered = false;
    state.me = null;
    state.pinnedId = 0;
    followingCache.clear();
    if (!Wallet.isUnlocked()) return;
    try {
      state.registered = await Chain.isRegistered(Wallet.address());
      if (state.registered) {
        Chain.invalidateProfile(Wallet.address());
        const [info, prof] = await Promise.all([
          Chain.displayInfo(Wallet.address()),
          Chain.userProfile(Wallet.address())
        ]);
        state.me = info;
        state.pinnedId = prof.pinnedPost;
      }
    } catch (e) {
      console.warn("identity check failed", e);
    }
  }

  /* Called by WalletUI after create / import / unlock / logout / forget. */
  async function onWalletChange() {
    WalletUI.renderNavbar();
    await refreshIdentity();
    if (Wallet.isUnlocked() && !state.registered) promptRegister();
    route(true);
  }

  /* Guard used before any interaction. Returns true when ready to act. */
  function requireWallet() {
    if (!Wallet.hasKeystore()) { WalletUI.openOnboarding(); return false; }
    if (!Wallet.isUnlocked()) { WalletUI.openUnlock(); return false; }
    return true;
  }

  function requireRegistered() {
    if (!requireWallet()) return false;
    if (!state.registered) { promptRegister(); return false; }
    return true;
  }

  /* ================= theme ================= */

  const THEMES = ["light", "dim", "dark"];

  function initTheme() {
    const saved = localStorage.getItem(STORE.theme);
    const preferred = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dim" : "light");
    applyTheme(THEMES.includes(preferred) ? preferred : "light");
    document.getElementById("themeBtn").addEventListener("click", () => {
      const cur = document.body.dataset.theme || "light";
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      applyTheme(next);
      localStorage.setItem(STORE.theme, next);
    });
  }

  function applyTheme(t) {
    document.body.dataset.theme = t;
    const icon = t === "light" ? "fa-sun" : t === "dim" ? "fa-cloud-moon" : "fa-moon";
    document.querySelector("#themeBtn i").className = "fas " + icon;
  }

  /* ================= routing ================= */

  function pages() { return document.querySelectorAll(".routePage"); }

  function showPage(id) {
    pages().forEach(p => p.classList.toggle("visible", p.id === id));
    document.getElementById("mainContent").scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function setNavActive(hash) {
    document.querySelectorAll("[data-nav]").forEach(a => {
      a.classList.toggle("active", a.dataset.nav === hash);
    });
  }

  function route(force) {
    if (activeFeed) { activeFeed.destroy(); activeFeed = null; }
    const raw = window.location.hash;
    if (!force && raw === state.route && raw !== "") { /* re-run anyway for refresh semantics */ }
    state.route = raw;

    /* deep link:  #post123  or  #post123/#comment45 */
    const deep = raw.match(/^#post(\d+)(?:\/#comment(\d+))?$/);
    if (deep) {
      setNavActive("");
      showPage("postPage");
      renderPostPage(parseInt(deep[1], 10), deep[2] ? parseInt(deep[2], 10) : null);
      return;
    }

    const hash = raw.replace(/^#/, "");

    if (!hash || hash === "home") {
      setNavActive("home"); showPage("homePage"); renderHome();
    } else if (hash === "wallet") {
      setNavActive("wallet"); showPage("walletPage");
      WalletUI.renderWalletPage(document.getElementById("walletPage"));
    } else if (hash === "profile") {
      setNavActive("profile"); showPage("profilePage"); renderMyProfile();
    } else if (hash === "settings") {
      setNavActive("settings"); showPage("settingsPage"); renderSettings();
    } else {
      setNavActive(""); showPage("profilePage"); renderUserProfile(hash);
    }
  }

  function doSearch() {
    const val = document.getElementById("searchInput").value.trim();
    if (!val) return;
    if (/^post\s*\d+$/i.test(val)) {
      window.location.hash = "post" + val.replace(/\D/g, "");
    } else {
      window.location.hash = val.replace(/^@/, "");
    }
    document.getElementById("searchInput").value = "";
  }

  /* ================= infinite feed helper ================= */

  /**
   * Creates an infinite scroll feed inside `container`.
   * `loadBatch(cursor)` must return { html: string, nextCursor: number|null }.
   * cursor === null means done.
   */
  function infiniteFeed(container, startCursor, loadBatch, emptyHTML) {
    let cursor = startCursor;
    let loading = false;
    let destroyed = false;
    let rendered = 0;

    container.innerHTML = "";
    const sentinel = document.createElement("div");
    sentinel.className = "feed-sentinel";
    container.after(sentinel);

    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) next();
    }, { rootMargin: "600px" });

    async function next() {
      if (loading || destroyed || cursor === null) return;
      loading = true;
      sentinel.innerHTML = UI.spinnerHTML("Loading…");
      try {
        const res = await loadBatch(cursor);
        if (destroyed) return;
        if (res.html) {
          container.insertAdjacentHTML("beforeend", res.html);
          rendered++;
        }
        cursor = res.nextCursor;
        if (cursor === null) {
          observer.disconnect();
          sentinel.innerHTML = "";
          if (!container.children.length && emptyHTML) container.innerHTML = emptyHTML;
        } else {
          sentinel.innerHTML = "";
          /* if the batch was fully filtered out, keep pulling */
          if (!res.html) next();
        }
      } catch (e) {
        console.error("feed batch failed", e);
        if (!destroyed) sentinel.innerHTML = `<div class="feed-error">Couldn't reach the ${CHAIN.name} network. <a href="javascript:location.reload()">Retry</a></div>`;
      } finally {
        loading = false;
      }
    }

    observer.observe(sentinel);
    next();

    return {
      destroy() {
        destroyed = true;
        observer.disconnect();
        sentinel.remove();
      }
    };
  }

  /* ================= post & comment cards ================= */

  const REACT_ICON = { like: "fa-thumbs-up", dislike: "fa-thumbs-down" };

  function statBtn(action, icon, count, extraCls = "", title = "") {
    return `<button class="stat-btn ${extraCls}" data-action="${action}" title="${title}">
      <i class="fas ${icon}"></i><span class="stat-count">${count > 0 ? count : ""}</span></button>`;
  }

  async function postCardHTML(post, opts = {}) {
    const me = Wallet.address();
    const isOwner = me && me.toLowerCase() === post.author.toLowerCase();

    /* hidden posts: only the owner sees a stub with an unhide option */
    if (post.hidden) {
      if (!isOwner) return "";
      return `
        <article class="post-card hidden-card" data-postid="${post.id}">
          <div class="hidden-note"><i class="fas fa-eye-slash"></i> This post is hidden from everyone else.</div>
          <button class="btn ghost sm" data-action="unhide-post" data-postid="${post.id}">Unhide</button>
        </article>`;
    }

    const [author, myReaction] = await Promise.all([
      Chain.displayInfo(post.author),
      me ? Chain.reactionOnPost(post.id, me).catch(() => "0") : Promise.resolve("0")
    ]);

    let body;
    if (post.isRepost) body = await repostBodyHTML(post, author);
    else body = opts.full ? UI.md(post.content) : UI.mdPreview(post.content, post.id);

    const pinned = opts.pinned ? `<span class="badge"><i class="fas fa-thumbtack"></i> Pinned</span>` : "";

    let menu = "";
    if (isOwner) {
      const isPinned = state.pinnedId === post.id;
      menu = `
        <div class="card-menu" data-noroute>
          <button class="icon-btn menu-toggle" data-action="menu" title="Options"><i class="fas fa-ellipsis"></i></button>
          <div class="menu-dropdown">
            <button data-action="edit-post" data-postid="${post.id}" data-repost="${post.isRepost ? 1 : 0}"><i class="fas fa-pen"></i> Edit</button>
            <button data-action="hide-post" data-postid="${post.id}"><i class="fas fa-eye-slash"></i> Hide</button>
            <button data-action="${isPinned ? "unpin-post" : "pin-post"}" data-postid="${post.id}">
              <i class="fas fa-thumbtack"></i> ${isPinned ? "Unpin" : "Pin to profile"}</button>
          </div>
        </div>`;
    }

    const profileHref = author.username ? `#${UI.escAttr(author.username)}` : "javascript:void(0)";

    return `
      <article class="post-card ${opts.full ? "full" : "clickable"}" data-postid="${post.id}">
        <div class="card-top">
          <a class="author" href="${profileHref}" data-noroute>
            ${UI.avatar(author)}
            <span class="author-names">
              <span class="author-nick">${UI.esc(author.nickname)}</span>
              <span class="author-user">${author.username ? "@" + UI.esc(author.username) : ""} · ${UI.timeAgo(post.time)}</span>
            </span>
          </a>
          <div class="card-top-right">${pinned}${menu}</div>
        </div>
        <div class="card-body">${body}</div>
        <div class="card-actions" data-noroute>
          ${statBtn("open-post", "fa-comment", post.comments, "", "Comments")}
          ${statBtn("repost", "fa-retweet", post.reposts, "", "Repost")}
          ${statBtn("like-post", REACT_ICON.like, post.likes, myReaction === "like" ? "active-like" : "", "Like")}
          ${statBtn("dislike-post", REACT_ICON.dislike, post.dislikes, myReaction === "dislike" ? "active-dislike" : "", "Dislike")}
          ${statBtn("share", "fa-arrow-up-from-bracket", 0, "", "Share link")}
        </div>
      </article>`;
  }

  async function repostBodyHTML(post, reposter) {
    const note = (post.content || "").trim();
    let noteHTML = note
      ? UI.mdPreview(note, post.id, 240)
      : `<p class="muted"><i class="fas fa-retweet"></i> @${UI.esc(reposter.username || "user")} reposted</p>`;
    try {
      const orig = await Chain.post(post.originalId);
      if (!orig.id || orig.hidden) {
        return noteHTML + `<div class="quoted"><p class="muted">Original post unavailable.</p></div>`;
      }
      const origAuthor = await Chain.displayInfo(orig.author);
      return `
        ${noteHTML}
        <a class="quoted" href="#post${orig.id}" data-noroute>
          <div class="quoted-head">
            ${UI.avatar(origAuthor, "sm")}
            <b>${UI.esc(origAuthor.nickname)}</b>
            <span class="muted">${origAuthor.username ? "@" + UI.esc(origAuthor.username) : ""} · ${UI.timeAgo(orig.time)}</span>
          </div>
          <div class="quoted-body">${UI.mdPreview(orig.content, orig.id, 220)}</div>
        </a>`;
    } catch (e) {
      return noteHTML + `<div class="quoted"><p class="muted">Original post unavailable.</p></div>`;
    }
  }

  async function commentCardHTML(c) {
    const me = Wallet.address();
    const isOwner = me && me.toLowerCase() === c.author.toLowerCase();

    if (c.hidden) {
      if (!isOwner) return "";
      return `
        <div class="comment-card hidden-card" data-postid="${c.postId}" data-commentid="${c.id}">
          <div class="hidden-note"><i class="fas fa-eye-slash"></i> This comment is hidden.</div>
          <button class="btn ghost sm" data-action="unhide-comment" data-postid="${c.postId}" data-commentid="${c.id}">Unhide</button>
        </div>`;
    }

    const [author, myReaction] = await Promise.all([
      Chain.displayInfo(c.author),
      me ? Chain.reactionOnComment(c.postId, c.id, me).catch(() => "0") : Promise.resolve("0")
    ]);

    const menu = isOwner ? `
      <div class="card-menu" data-noroute>
        <button class="icon-btn menu-toggle" data-action="menu" title="Options"><i class="fas fa-ellipsis"></i></button>
        <div class="menu-dropdown">
          <button data-action="edit-comment" data-postid="${c.postId}" data-commentid="${c.id}"><i class="fas fa-pen"></i> Edit</button>
          <button data-action="hide-comment" data-postid="${c.postId}" data-commentid="${c.id}"><i class="fas fa-eye-slash"></i> Hide</button>
        </div>
      </div>` : "";

    const profileHref = author.username ? `#${UI.escAttr(author.username)}` : "javascript:void(0)";

    return `
      <div class="comment-card" id="comment-${c.postId}-${c.id}" data-postid="${c.postId}" data-commentid="${c.id}">
        <div class="card-top">
          <a class="author" href="${profileHref}" data-noroute>
            ${UI.avatar(author, "sm")}
            <span class="author-names">
              <span class="author-nick">${UI.esc(author.nickname)}</span>
              <span class="author-user">${author.username ? "@" + UI.esc(author.username) : ""} · ${UI.timeAgo(c.time)}</span>
            </span>
          </a>
          <div class="card-top-right">${menu}</div>
        </div>
        <div class="card-body">${UI.md(c.text)}</div>
        <div class="card-actions" data-noroute>
          ${statBtn("like-comment", REACT_ICON.like, c.likes, "", "Like")}
          ${statBtn("dislike-comment", REACT_ICON.dislike, c.dislikes, "", "Dislike")}
          ${statBtn("share-comment", "fa-arrow-up-from-bracket", 0, "", "Copy comment link")}
        </div>
      </div>`;
  }

  /* ================= delegated click handling ================= */

  /* Base for external share links (pretty URLs served by meta.php on the
     public host). Desktop serves from 127.0.0.1, so it always shares the
     public web origin. */
  function shareBase() {
    return IS_DESKTOP ? PUBLIC_ORIGIN : location.origin;
  }

  function closest(el, sel) { return el.closest ? el.closest(sel) : null; }

  async function delegatedClicks(e) {
    const menuBtn = closest(e.target, ".menu-toggle");
    /* toggle dropdown menus; close others */
    document.querySelectorAll(".card-menu.open").forEach(m => {
      if (!menuBtn || !m.contains(menuBtn)) m.classList.remove("open");
    });
    if (menuBtn) {
      menuBtn.parentElement.classList.toggle("open");
      e.stopPropagation();
      return;
    }

    const actionEl = closest(e.target, "[data-action]");
    if (actionEl) {
      e.preventDefault();
      e.stopPropagation();
      const card = closest(actionEl, "[data-postid]");
      const postId = parseInt(actionEl.dataset.postid || (card ? card.dataset.postid : 0), 10);
      const commentId = parseInt(actionEl.dataset.commentid || (card ? card.dataset.commentid || 0 : 0), 10);
      await handleAction(actionEl.dataset.action, { postId, commentId, el: actionEl, card });
      return;
    }

    /* whole-card click navigates to the post (ignoring inner links) */
    const cardEl = closest(e.target, ".post-card.clickable");
    if (cardEl && !closest(e.target, "a, button, [data-noroute]")) {
      window.location.hash = "post" + cardEl.dataset.postid;
    }
  }

  async function handleAction(action, ctx) {
    switch (action) {
      case "open-post":
        window.location.hash = "post" + ctx.postId;
        break;

      case "share": {
        UI.copy(shareBase() + "/post/" + ctx.postId, "Post link copied");
        break;
      }

      case "share-comment": {
        UI.copy(shareBase() + "/post/" + ctx.postId + "/comment/" + ctx.commentId, "Comment link copied");
        break;
      }

      case "repost":
        if (!requireRegistered()) return;
        openRepostModal(ctx.postId);
        break;

      case "like-post":
      case "dislike-post": {
        if (!requireRegistered()) return;
        const wanted = action === "like-post" ? "like" : "dislike";
        const current = await Chain.reactionOnPost(ctx.postId, Wallet.address()).catch(() => "0");
        const next = current === wanted ? "none" : wanted;
        const label = next === "none" ? "Removing reaction" : (next === "like" ? "Liking post" : "Disliking post");
        const done = next === "none" ? "Reaction removed" : (next === "like" ? "Post liked" : "Post disliked");
        if (await Tx.run(label, done, () => Chain.tx.reactToPost(ctx.postId, next))) refreshPostCard(ctx.postId);
        break;
      }

      case "like-comment":
      case "dislike-comment": {
        if (!requireRegistered()) return;
        const wanted = action === "like-comment" ? "like" : "dislike";
        const current = await Chain.reactionOnComment(ctx.postId, ctx.commentId, Wallet.address()).catch(() => "0");
        const next = current === wanted ? "none" : wanted;
        const label = next === "none" ? "Removing reaction" : (next === "like" ? "Liking comment" : "Disliking comment");
        const done = next === "none" ? "Reaction removed" : (next === "like" ? "Comment liked" : "Comment disliked");
        if (await Tx.run(label, done, () => Chain.tx.reactToComment(ctx.postId, ctx.commentId, next)))
          refreshCommentCard(ctx.postId, ctx.commentId);
        break;
      }

      case "edit-post":
        if (!requireWallet()) return;
        openEditPostModal(ctx.postId, ctx.el.dataset.repost === "1");
        break;

      case "hide-post": {
        if (!requireWallet()) return;
        const ok = await UI.confirm({
          title: "Hide post?",
          message: "The post stays on-chain but will not be shown to other users. You can unhide it later from your profile.",
          okLabel: "Hide post"
        });
        if (ok && await Tx.run("Hiding post", "Post hidden", () => Chain.tx.hidePost(ctx.postId, true))) route(true);
        break;
      }

      case "unhide-post":
        if (!requireWallet()) return;
        if (await Tx.run("Unhiding post", "Post is visible again", () => Chain.tx.hidePost(ctx.postId, false))) route(true);
        break;

      case "pin-post":
        if (!requireRegistered()) return;
        if (await Tx.run("Pinning post", "Post pinned to your profile", () => Chain.tx.pinPost(ctx.postId))) {
          state.pinnedId = ctx.postId; route(true);
        }
        break;

      case "unpin-post":
        if (!requireRegistered()) return;
        if (await Tx.run("Unpinning post", "Post unpinned", () => Chain.tx.pinPost(0))) {
          state.pinnedId = 0; route(true);
        }
        break;

      case "edit-comment":
        if (!requireWallet()) return;
        openEditCommentModal(ctx.postId, ctx.commentId);
        break;

      case "hide-comment": {
        if (!requireWallet()) return;
        const ok = await UI.confirm({
          title: "Hide comment?",
          message: "The comment stays on-chain but will not be shown to other users.",
          okLabel: "Hide comment"
        });
        if (ok && await Tx.run("Hiding comment", "Comment hidden", () => Chain.tx.hideComment(ctx.postId, ctx.commentId, true)))
          refreshCommentCard(ctx.postId, ctx.commentId);
        break;
      }

      case "unhide-comment":
        if (!requireWallet()) return;
        if (await Tx.run("Unhiding comment", "Comment is visible again", () => Chain.tx.hideComment(ctx.postId, ctx.commentId, false)))
          refreshCommentCard(ctx.postId, ctx.commentId);
        break;
    }
  }

  /* Replace a post card in place with fresh chain data. */
  async function refreshPostCard(postId) {
    const cards = document.querySelectorAll(`.post-card[data-postid="${postId}"]`);
    if (!cards.length) return;
    try {
      const post = await Chain.post(postId);
      for (const card of cards) {
        const html = await postCardHTML(post, { full: card.classList.contains("full"), pinned: !!card.querySelector(".badge") });
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        if (tmp.firstElementChild) card.replaceWith(tmp.firstElementChild);
        else card.remove();
      }
    } catch (e) { console.warn(e); }
  }

  async function refreshCommentCard(postId, commentId) {
    const card = document.querySelector(`[data-postid="${postId}"][data-commentid="${commentId}"]`);
    if (!card) return;
    try {
      const c = await Chain.comment(postId, commentId);
      const html = await commentCardHTML(c);
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      if (tmp.firstElementChild) card.replaceWith(tmp.firstElementChild);
      else card.remove();
    } catch (e) { console.warn(e); }
  }

  /* ================= composer ================= */

  function composerHTML(id, placeholder, btnLabel) {
    if (!Wallet.isUnlocked()) {
      return `
        <div class="panel composer locked">
          <p class="muted"><i class="fas fa-wallet"></i> Unlock your wallet to post on ${APP_NAME}.</p>
          <button class="btn primary sm" onclick="App.requireWallet()">Unlock / Create Wallet</button>
        </div>`;
    }
    if (!state.registered) {
      return `
        <div class="panel composer locked">
          <p class="muted"><i class="fas fa-user-plus"></i> Create your ${APP_NAME} account to start posting.</p>
          <button class="btn primary sm" onclick="App.promptRegister()">Create Account</button>
        </div>`;
    }
    const tools = [
      ["bold", "fa-bold", "Bold"],
      ["italic", "fa-italic", "Italic"],
      ["strike", "fa-strikethrough", "Strikethrough"],
      ["heading", "fa-heading", "Heading"],
      ["quote", "fa-quote-left", "Quote"],
      ["ul", "fa-list-ul", "Bullet list"],
      ["ol", "fa-list-ol", "Numbered list"],
      ["code", "fa-code", "Inline code"],
      ["codeblock", "fa-file-code", "Code block"],
      ["link", "fa-link", "Link"],
      ["image", "fa-image", "Image"]
    ];
    return `
      <div class="panel composer">
        <div class="composer-row">
          ${UI.avatar(state.me)}
          <div class="composer-main">
            <div class="composer-top">
              <div class="md-toolbar" data-noroute>
                ${tools.map(([t, ic, tip]) => `<button class="md-tool" data-mdtool="${t}" title="${tip}" type="button"><i class="fas ${ic}"></i></button>`).join("")}
              </div>
              <div class="composer-tabs" data-noroute>
                <button class="ctab active" data-ctab="write" type="button"><i class="fas fa-pen"></i> Write</button>
                <button class="ctab" data-ctab="preview" type="button"><i class="fas fa-eye"></i> Preview</button>
              </div>
            </div>
            <textarea id="${id}" rows="3" placeholder="${UI.escAttr(placeholder)}" maxlength="10000"></textarea>
            <div class="md-preview card-body" id="${id}Preview" style="display:none"></div>
          </div>
        </div>
        <div class="composer-foot">
          <span class="muted fine-print">Markdown supported · stored on-chain forever</span>
          <button class="btn primary" id="${id}Btn"><i class="fas fa-feather"></i> ${UI.esc(btnLabel)}</button>
        </div>
      </div>`;
  }

  /* ---------- composer helpers ---------- */

  function autoGrow(ta, max = 520) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight + 2, max) + "px";
  }

  /* Wrap the current selection (or a placeholder) with before/after markers. */
  function mdWrap(ta, before, after, ph) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || ph;
    ta.setRangeText(before + sel + after, s, e);
    ta.selectionStart = s + before.length;
    ta.selectionEnd = s + before.length + sel.length;
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  }

  /* Prefix every line of the current selection (lists, quotes, headings). */
  function mdLinePrefix(ta, prefix, numbered) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
    const block = ta.value.slice(lineStart, e);
    const lines = block.split("\n");
    const out = lines.map((l, i) => (numbered ? (i + 1) + ". " : prefix) + l).join("\n");
    ta.setRangeText(out, lineStart, e);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + out.length;
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  }

  function applyMdTool(ta, tool) {
    switch (tool) {
      case "bold":      return mdWrap(ta, "**", "**", "bold text");
      case "italic":    return mdWrap(ta, "*", "*", "italic text");
      case "strike":    return mdWrap(ta, "~~", "~~", "strikethrough");
      case "heading":   return mdLinePrefix(ta, "## ");
      case "quote":     return mdLinePrefix(ta, "> ");
      case "ul":        return mdLinePrefix(ta, "- ");
      case "ol":        return mdLinePrefix(ta, "", true);
      case "code":      return mdWrap(ta, "`", "`", "code");
      case "codeblock": return mdWrap(ta, "```\n", "\n```", "code");
      case "link":      return mdWrap(ta, "[", "](https://)", "link text");
      case "image":     return mdWrap(ta, "![image](", ")", "https://image-url.png");
    }
  }

  function wireComposer(id, onDone) {
    const btn = document.getElementById(id + "Btn");
    if (!btn) return;
    const ta = document.getElementById(id);
    const wrap = ta.closest(".composer");
    const preview = document.getElementById(id + "Preview");

    /* auto-grow with content */
    autoGrow(ta);
    ta.addEventListener("input", () => autoGrow(ta));

    /* markdown toolbar */
    wrap.querySelectorAll("[data-mdtool]").forEach(b => {
      b.onclick = () => applyMdTool(ta, b.dataset.mdtool);
    });

    /* write / preview tabs */
    wrap.querySelectorAll("[data-ctab]").forEach(tab => {
      tab.onclick = () => {
        wrap.querySelectorAll("[data-ctab]").forEach(t => t.classList.toggle("active", t === tab));
        const showPreview = tab.dataset.ctab === "preview";
        ta.style.display = showPreview ? "none" : "";
        preview.style.display = showPreview ? "" : "none";
        wrap.querySelector(".md-toolbar").style.visibility = showPreview ? "hidden" : "";
        if (showPreview) {
          preview.innerHTML = ta.value.trim()
            ? UI.md(ta.value)
            : `<p class="muted">Nothing to preview yet — write something first.</p>`;
        } else {
          ta.focus();
        }
      };
    });

    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return UI.toast("Write something first!", "error");
      btn.disabled = true;
      const ok = await Tx.run("Publishing post", "Post published", () => Chain.tx.createPost(text));
      btn.disabled = false;
      if (ok) {
        ta.value = "";
        wrap.querySelector('[data-ctab="write"]')?.click();
        autoGrow(ta);
        onDone && onDone();
      }
    };
  }

  /* ================= home ================= */

  /* Watcher state: highest post id shown in the feed + block of the last import. */
  const homeWatch = { topId: 0, lastBlock: 0 };

  /* Cache of "do I follow this author?" lookups. */
  const followingCache = new Map();

  async function isFollowedByMe(addr) {
    const me = Wallet.address();
    if (!me || !state.registered) return true;               // no account -> no filtering
    if (addr.toLowerCase() === me.toLowerCase()) return true; // always include own posts
    const key = addr.toLowerCase();
    if (followingCache.has(key)) return followingCache.get(key);
    let v = false;
    try { v = await Chain.isFollowing(me, addr); } catch (e) {}
    followingCache.set(key, v);
    return v;
  }

  async function filterByFollowing(posts) {
    if (!state.homeFilterFollowing) return posts;
    const checks = await Promise.all(posts.map(p => isFollowedByMe(p.author)));
    return posts.filter((p, i) => checks[i]);
  }

  function renderHome() {
    const page = document.getElementById("homePage");
    const canFilter = Wallet.isUnlocked() && state.registered;
    if (!canFilter) state.homeFilterFollowing = false;
    page.innerHTML = `
      <div class="page-title">
        <h2>Home</h2>
        <span class="topbar-spacer"></span>
        ${canFilter ? `
        <label class="switch" title="Only show posts from accounts you follow">
          <input type="checkbox" id="followFilter" ${state.homeFilterFollowing ? "checked" : ""}>
          <span class="switch-track"></span>
          <span class="switch-label">Following only</span>
        </label>` : ""}
      </div>
      <div id="homeComposer">${composerHTML("homePost", "What's happening on " + CHAIN.name + "?", "Post")}</div>
      <button id="newPostsBanner" class="new-posts-banner" style="display:none"></button>
      <div id="homeNotice"></div>
      <div id="homeFeed"></div>`;
    wireComposer("homePost", () => renderHome());

    const filterEl = page.querySelector("#followFilter");
    if (filterEl) {
      filterEl.addEventListener("change", () => {
        state.homeFilterFollowing = filterEl.checked;
        document.getElementById("homeNotice").innerHTML = "";
        startHomeFeed();
      });
    }
    page.querySelector("#newPostsBanner").addEventListener("click", importNewPosts);

    startHomeFeed();
  }

  async function startHomeFeed() {
    if (activeFeed) { activeFeed.destroy(); activeFeed = null; }
    const feedEl = document.getElementById("homeFeed");
    feedEl.innerHTML = UI.skeletons(3);
    const banner = document.getElementById("newPostsBanner");
    banner.style.display = "none";
    banner.disabled = false;

    try {
      const [total, block] = await Promise.all([
        Chain.totalPosts(),
        Wallet.getProvider().getBlockNumber().catch(() => 0)
      ]);
      homeWatch.topId = total;
      homeWatch.lastBlock = block;

      feedEl.innerHTML = "";
      if (total === 0) {
        feedEl.innerHTML = UI.emptyState("fa-feather", "No posts yet. Be the first to write history on-chain!");
        return;
      }
      const emptyHTML = state.homeFilterFollowing
        ? UI.emptyState("fa-filter", "No posts from accounts you follow yet. Turn the filter off to see everyone.")
        : UI.emptyState("fa-feather", "No posts yet.");

      activeFeed = infiniteFeed(feedEl, total, async cursor => {
        const posts = await Chain.postRange(cursor, FEED_BATCH);
        const kept = await filterByFollowing(posts);
        const parts = await Promise.all(kept.map(p => postCardHTML(p)));
        const nextCursor = cursor - FEED_BATCH;
        return { html: parts.join(""), nextCursor: nextCursor >= 1 ? nextCursor : null };
      }, emptyHTML);
    } catch (e) {
      console.error(e);
      feedEl.innerHTML = `<div class="feed-error">Couldn't reach the ${CHAIN.name} network. <a href="javascript:location.reload()">Retry</a></div>`;
    }
  }

  /* Fetch posts newer than homeWatch.topId and prepend them to the feed. */
  async function importNewPosts() {
    const banner = document.getElementById("newPostsBanner");
    const notice = document.getElementById("homeNotice");
    const feedEl = document.getElementById("homeFeed");
    if (!feedEl || !banner || banner.disabled) return;
    banner.disabled = true;
    banner.innerHTML = `<span class="spinner"></span> Importing new posts…`;

    try {
      const [total, block] = await Promise.all([
        Chain.totalPosts(),
        Wallet.getProvider().getBlockNumber().catch(() => 0)
      ]);
      const count = total - homeWatch.topId;
      if (count <= 0) { banner.style.display = "none"; banner.disabled = false; return; }

      const blockSpan = (block && homeWatch.lastBlock) ? block - homeWatch.lastBlock : 0;
      const posts = await Chain.postRange(total, count);
      const kept = await filterByFollowing(posts);
      const parts = await Promise.all(kept.map(p => postCardHTML(p)));
      const html = parts.join("");

      homeWatch.topId = total;
      if (block) homeWatch.lastBlock = block;
      banner.style.display = "none";
      banner.disabled = false;

      if (html) {
        notice.innerHTML = "";
        feedEl.insertAdjacentHTML("afterbegin", html);
      } else if (state.homeFilterFollowing) {
        notice.innerHTML = `<div class="feed-notice"><i class="fas fa-filter"></i>
          No posts from accounts you follow in the last ${blockSpan > 0 ? blockSpan + " blocks" : "blocks scanned"}
          — ${count} new ${count === 1 ? "post" : "posts"} filtered out.</div>`;
      }
    } catch (e) {
      console.error("import new posts failed", e);
      banner.disabled = false;
      banner.innerHTML = `<i class="fas fa-rotate"></i> Import failed — tap to retry`;
    }
  }

  /* ================= chain watcher (stats + new-post banner) ================= */

  let lastUserCount = -1;
  let lastPostCount = -1;

  async function pollChain() {
    if (document.hidden) return;
    try {
      const [users, posts] = await Promise.all([Chain.totalUsers(), Chain.totalPosts()]);

      /* live sidebar stats */
      if (users !== lastUserCount || posts !== lastPostCount) {
        renderStatTiles(users, posts);
      }
      if (users !== lastUserCount) refreshRecentlyJoined(users);
      lastUserCount = users;
      lastPostCount = posts;

      /* new-post banner (home feed only) */
      const banner = document.getElementById("newPostsBanner");
      const onHome = state.route === "" || state.route === "#home";
      if (banner && onHome && !banner.disabled && homeWatch.topId > 0 && posts > homeWatch.topId) {
        const n = posts - homeWatch.topId;
        banner.innerHTML = `<i class="fas fa-arrow-up"></i> ${n} new ${n === 1 ? "post" : "posts"} — click to show`;
        banner.style.display = "block";
      }
    } catch (e) { /* transient network issues are fine */ }
  }

  /* ================= single post ================= */

  async function renderPostPage(postId, targetCommentId) {
    const page = document.getElementById("postPage");
    page.innerHTML = `
      <div class="page-title with-back">
        <button class="icon-btn" onclick="history.back()" title="Back"><i class="fas fa-arrow-left"></i></button>
        <h2>Post #${postId}</h2>
      </div>
      <div id="postDetail">${UI.skeletons(1)}</div>
      <div id="commentComposer"></div>
      <h3 class="section-title" id="commentsTitle"></h3>
      <div id="commentsList"></div>`;

    let post;
    try { post = await Chain.post(postId); }
    catch (e) {
      document.getElementById("postDetail").innerHTML = UI.emptyState("fa-ghost", "Post not found.");
      return;
    }

    const detail = document.getElementById("postDetail");
    if (post.hidden && (!Wallet.address() || Wallet.address().toLowerCase() !== post.author.toLowerCase())) {
      detail.innerHTML = UI.emptyState("fa-eye-slash", "This post has been hidden by its author.");
      return;
    }
    detail.innerHTML = await postCardHTML(post, { full: true });

    /* comment composer */
    const cc = document.getElementById("commentComposer");
    if (Wallet.isUnlocked() && state.registered) {
      cc.innerHTML = `
        <div class="panel composer">
          <div class="composer-row">
            ${UI.avatar(state.me)}
            <textarea id="commentText" rows="2" placeholder="Write a comment…" maxlength="10000"></textarea>
          </div>
          <div class="composer-foot">
            <span></span>
            <button class="btn primary sm" id="commentSubmit"><i class="fas fa-reply"></i> Comment</button>
          </div>
        </div>`;
      const commentTa = cc.querySelector("#commentText");
      autoGrow(commentTa, 360);
      commentTa.addEventListener("input", () => autoGrow(commentTa, 360));
      cc.querySelector("#commentSubmit").onclick = async () => {
        const ta = cc.querySelector("#commentText");
        const text = ta.value.trim();
        if (!text) return UI.toast("Comment is empty.", "error");
        const btn = cc.querySelector("#commentSubmit");
        btn.disabled = true;
        const ok = await Tx.run("Posting comment", "Comment was posted", () => Chain.tx.createComment(postId, text));
        btn.disabled = false;
        if (ok) { ta.value = ""; renderPostPage(postId, null); }
      };
    } else {
      cc.innerHTML = composerHTML("nullComposer", "", "");
    }

    /* comments */
    const list = document.getElementById("commentsList");
    const title = document.getElementById("commentsTitle");

    if (targetCommentId) {
      title.innerHTML = `Comment <a class="fine-print" href="#post${postId}">— show all comments</a>`;
      try {
        const c = await Chain.comment(postId, targetCommentId);
        const html = await commentCardHTML(c);
        list.innerHTML = html || UI.emptyState("fa-comment-slash", "Comment not found or hidden.");
      } catch (e) {
        list.innerHTML = UI.emptyState("fa-comment-slash", "Comment not found.");
      }
      return;
    }

    const total = await Chain.postCommentCount(postId).catch(() => 0);
    title.textContent = total === 1 ? "1 Comment" : `${total} Comments`;
    if (total === 0) {
      list.innerHTML = UI.emptyState("fa-comments", "No comments yet — start the conversation.");
      return;
    }
    activeFeed = infiniteFeed(list, total, async cursor => {
      const ids = [];
      for (let i = cursor; i > Math.max(0, cursor - FEED_BATCH); i--) ids.push(i);
      const results = await Promise.allSettled(ids.map(i => Chain.comment(postId, i)));
      const comments = results.filter(r => r.status === "fulfilled").map(r => r.value);
      const parts = await Promise.all(comments.map(c => commentCardHTML(c)));
      const nextCursor = cursor - FEED_BATCH;
      return { html: parts.join(""), nextCursor: nextCursor >= 1 ? nextCursor : null };
    }, UI.emptyState("fa-comments", "No visible comments."));
  }

  /* ================= profiles ================= */

  async function profileHeaderHTML(addr, basic, prof, stats, isMe) {
    const cover = prof.cover && prof.cover.trim()
      ? `<img class="cover-img" src="${UI.escAttr(prof.cover)}" alt="" onerror="this.remove()">`
      : "";
    const website = prof.website
      ? `<span class="profile-meta-item"><i class="fas fa-link"></i> <a href="${UI.escAttr(prof.website.startsWith("http") ? prof.website : "https://" + prof.website)}" target="_blank" rel="noopener">${UI.esc(prof.website)}</a></span>` : "";
    const location = prof.location
      ? `<span class="profile-meta-item"><i class="fas fa-location-dot"></i> ${UI.esc(prof.location)}</span>` : "";

    let actionBtn = "";
    if (isMe) {
      actionBtn = `<a class="btn ghost" href="#settings"><i class="fas fa-pen"></i> Edit profile</a>`;
    } else if (Wallet.isUnlocked() && state.registered) {
      const following = await Chain.isFollowing(Wallet.address(), addr).catch(() => false);
      actionBtn = `<button class="btn ${following ? "ghost" : "primary"}" id="followBtn" data-following="${following ? 1 : 0}">
        ${following ? "Following" : "Follow"}</button>`;
    }
    actionBtn = `<button class="icon-btn" id="profileShareBtn" title="Copy profile link"><i class="fas fa-arrow-up-from-bracket"></i></button>` + actionBtn;

    return `
      <div class="panel profile-header">
        <div class="cover">${cover}</div>
        <div class="profile-head-row">
          <div class="profile-avatar">${UI.avatar({ nickname: prof.nickname, avatar: prof.avatar }, "xl")}</div>
          <div class="profile-actions">${actionBtn}</div>
        </div>
        <h2 class="profile-nick">${UI.esc(prof.nickname)}</h2>
        <div class="profile-user">@${UI.esc(basic.username)} <span class="muted">· #${basic.userId}</span></div>
        ${prof.about ? `<div class="profile-bio">${UI.md(prof.about)}</div>` : ""}
        <div class="profile-meta">
          ${location}${website}
          <span class="profile-meta-item"><i class="fas fa-calendar"></i> Joined ${UI.joinDate(basic.createdAt)}</span>
          <span class="profile-meta-item"><a href="${CHAIN.explorer}/address/${UI.escAttr(addr)}" target="_blank" rel="noopener"><i class="fas fa-cube"></i> ${UI.shortAddr(addr)}</a></span>
        </div>
        <div class="profile-stats">
          <span><b>${stats.posts}</b> Posts</span>
          <span><b>${stats.comments}</b> Comments</span>
          <span><b>${stats.followers}</b> Followers</span>
          <span><b>${stats.following}</b> Following</span>
        </div>
      </div>`;
  }

  async function renderProfileCommon(page, addr, isMe) {
    let basic, prof, stats;
    try {
      [basic, prof, stats] = await Promise.all([Chain.userBasic(addr), Chain.userProfile(addr), Chain.userStats(addr)]);
    } catch (e) {
      page.innerHTML = UI.emptyState("fa-ghost", "User not found.");
      return;
    }

    const headerHTML = await profileHeaderHTML(addr, basic, prof, stats, isMe);

    page.innerHTML = `
      ${headerHTML}
      ${isMe ? `<div id="profileComposer">${composerHTML("profilePost", "Share something…", "Post")}</div>` : ""}
      <div id="pinnedArea"></div>
      <div class="tab-row page-tabs">
        <button class="tab-btn active" data-tab="posts">Posts</button>
        <button class="tab-btn" data-tab="comments">Comments</button>
      </div>
      <div id="profileFeed"></div>`;

    if (isMe) wireComposer("profilePost", () => route(true));

    /* profile share */
    const psb = page.querySelector("#profileShareBtn");
    if (psb) psb.onclick = () => UI.copy(shareBase() + "/" + basic.username, "Profile link copied");

    /* follow button */
    const fb = page.querySelector("#followBtn");
    if (fb) {
      fb.onclick = async () => {
        const following = fb.dataset.following === "1";
        const verb = following ? "Unfollowing" : "Following";
        const done = following ? `Unfollowed @${basic.username}` : `You follow @${basic.username} now`;
        if (await Tx.run(`${verb} @${basic.username}`, done, () => Chain.tx.followUser(addr, !following))) {
          followingCache.delete(addr.toLowerCase()); // keep the "Following only" filter accurate
          route(true);
        }
      };
    }

    /* pinned post */
    if (prof.pinnedPost > 0) {
      Chain.post(prof.pinnedPost).then(async p => {
        if (p.id && !p.hidden) {
          document.getElementById("pinnedArea").innerHTML = await postCardHTML(p, { pinned: true });
        }
      }).catch(() => {});
    }

    /* tabs */
    const tabs = page.querySelectorAll(".page-tabs .tab-btn");
    tabs.forEach(t => t.onclick = () => {
      tabs.forEach(x => x.classList.toggle("active", x === t));
      if (activeFeed) { activeFeed.destroy(); activeFeed = null; }
      if (t.dataset.tab === "posts") loadProfilePosts(addr, stats.posts);
      else loadProfileComments(addr);
    });

    loadProfilePosts(addr, stats.posts);
  }

  function loadProfilePosts(addr, totalPosts) {
    const feedEl = document.getElementById("profileFeed");
    if (!feedEl) return;
    if (totalPosts === 0) {
      feedEl.innerHTML = UI.emptyState("fa-feather", "No posts yet.");
      return;
    }
    activeFeed = infiniteFeed(feedEl, totalPosts, async cursor => {
      const ids = [];
      for (let i = cursor; i > Math.max(0, cursor - FEED_BATCH); i--) ids.push(i);
      const globals = await Promise.allSettled(ids.map(i => Chain.globalPostId(addr, i)));
      const posts = await Promise.allSettled(
        globals.filter(g => g.status === "fulfilled" && g.value > 0).map(g => Chain.post(g.value))
      );
      const parts = await Promise.all(
        posts.filter(p => p.status === "fulfilled").map(p => postCardHTML(p.value))
      );
      const nextCursor = cursor - FEED_BATCH;
      return { html: parts.join(""), nextCursor: nextCursor >= 1 ? nextCursor : null };
    }, UI.emptyState("fa-feather", "No posts yet."));
  }

  async function loadProfileComments(addr) {
    const feedEl = document.getElementById("profileFeed");
    if (!feedEl) return;
    feedEl.innerHTML = UI.spinnerHTML();
    const total = await Chain.userCommentCount(addr).catch(() => 0);
    if (total === 0) {
      feedEl.innerHTML = UI.emptyState("fa-comments", "No comments yet.");
      return;
    }
    activeFeed = infiniteFeed(feedEl, total, async cursor => {
      const ids = [];
      for (let i = cursor; i > Math.max(0, cursor - FEED_BATCH); i--) ids.push(i);
      const refs = await Promise.allSettled(ids.map(i => Chain.userComment(addr, i)));
      const comments = await Promise.allSettled(
        refs.filter(r => r.status === "fulfilled" && r.value.postId > 0)
            .map(r => Chain.comment(r.value.postId, r.value.commentId))
      );
      const parts = await Promise.all(
        comments.filter(c => c.status === "fulfilled").map(async c => {
          const html = await commentCardHTML(c.value);
          if (!html) return "";
          return `<div class="comment-context"><a class="fine-print" href="#post${c.value.postId}">
            <i class="fas fa-reply"></i> on post #${c.value.postId}</a>${html}</div>`;
        })
      );
      const nextCursor = cursor - FEED_BATCH;
      return { html: parts.join(""), nextCursor: nextCursor >= 1 ? nextCursor : null };
    }, UI.emptyState("fa-comments", "No visible comments."));
  }

  async function renderMyProfile() {
    const page = document.getElementById("profilePage");
    if (!Wallet.isUnlocked()) {
      page.innerHTML = `
        <div class="panel center-panel">
          <i class="fas fa-user-lock panel-hero-icon"></i>
          <h2>Your profile lives on-chain</h2>
          <p class="muted">Unlock or create your wallet to see your ${APP_NAME} profile.</p>
          <button class="btn primary" onclick="App.requireWallet()">Unlock / Create Wallet</button>
        </div>`;
      return;
    }
    if (!state.registered) {
      page.innerHTML = `
        <div class="panel center-panel">
          <i class="fas fa-user-plus panel-hero-icon"></i>
          <h2>Create your account</h2>
          <p class="muted">Pick a nickname and a unique username. Registration is a one-time on-chain transaction.</p>
          <button class="btn primary" onclick="App.promptRegister()">Create Account</button>
        </div>`;
      return;
    }
    page.innerHTML = UI.skeletons(2);
    await renderProfileCommon(page, Wallet.address(), true);
  }

  async function renderUserProfile(username) {
    const page = document.getElementById("profilePage");
    page.innerHTML = UI.skeletons(2);
    let addr = null;
    try { addr = await Chain.addressByUsername(username); } catch (e) {}
    if (!addr) {
      page.innerHTML = UI.emptyState("fa-ghost", `User "@${username}" was not found.`);
      return;
    }
    const isMe = Wallet.address() && addr.toLowerCase() === Wallet.address().toLowerCase();
    await renderProfileCommon(page, addr, !!isMe);
  }

  /* ================= registration ================= */

  function promptRegister() {
    if (!requireWallet()) return;
    const m = UI.modal({
      title: `Create your ${APP_NAME} account`,
      body: `
        <p class="modal-text">Your account is written to the ${CHAIN.name} blockchain and belongs to your wallet
        <code>${UI.esc(UI.shortAddr(Wallet.address()))}</code>.</p>
        <label class="field-label">Nickname (display name)</label>
        <input type="text" id="regNick" class="input" maxlength="50" placeholder="e.g. Satoshi">
        <label class="field-label">Username (min. 5 chars, letters &amp; numbers)</label>
        <input type="text" id="regUser" class="input" maxlength="30" placeholder="e.g. satoshi01">
        <p class="field-error" id="regErr"></p>
        <div id="regBalanceNote">${UI.spinnerHTML("Checking your balance…")}</div>
        <div class="modal-actions">
          <button class="btn primary block" id="regBtn" disabled><i class="fas fa-user-plus"></i> Register on-chain</button>
        </div>`
    });

    /* Registration is a transaction, so the wallet needs FXL for gas. */
    async function checkRegBalance() {
      const note = m.querySelector("#regBalanceNote");
      const btn = m.querySelector("#regBtn");
      if (!note || !btn) return;
      note.innerHTML = UI.spinnerHTML("Checking your balance…");
      const bal = await Wallet.refreshBalance();
      if (!m.isConnected) return; // modal was closed meanwhile
      if (bal === null) {
        note.innerHTML = `<div class="notice warn"><i class="fas fa-triangle-exclamation"></i>
          Couldn't reach the network to check your balance.
          <button class="btn ghost sm" id="regRecheck">Try again</button></div>`;
        btn.disabled = true;
      } else if (bal === 0n) {
        note.innerHTML = `<div class="notice warn"><i class="fas fa-triangle-exclamation"></i>
          <div>Your balance is empty — please deposit some ${CHAIN.symbol} to this address first.
            Registration (and every interaction) needs a small amount of ${CHAIN.symbol} for gas.</div>
          <div class="key-box"><code>${UI.esc(Wallet.address())}</code>
            <button class="icon-btn" id="regCopyAddr" title="Copy address"><i class="fas fa-copy"></i></button></div>
          <button class="btn ghost sm" id="regRecheck"><i class="fas fa-rotate"></i> I've deposited — check again</button></div>`;
        btn.disabled = true;
      } else {
        note.innerHTML = `<p class="fine-print"><i class="fas fa-circle-check" style="color:var(--success)"></i>
          Balance: <b>${Wallet.balanceFormatted()} ${CHAIN.symbol}</b> — registration costs a small amount of ${CHAIN.symbol} gas.</p>`;
        btn.disabled = false;
      }
      m.querySelector("#regRecheck")?.addEventListener("click", checkRegBalance);
      m.querySelector("#regCopyAddr")?.addEventListener("click", () => UI.copy(Wallet.address(), `Address copied — send ${CHAIN.symbol} here`));
    }
    checkRegBalance();
    m.querySelector("#regBtn").onclick = async () => {
      const nick = m.querySelector("#regNick").value.trim();
      const user = m.querySelector("#regUser").value.trim();
      const err = m.querySelector("#regErr");
      err.textContent = "";
      if (!nick) { err.textContent = "Nickname is required."; return; }
      if (!/^[A-Za-z0-9]{5,}$/.test(user)) { err.textContent = "Username: at least 5 characters, letters and numbers only."; return; }
      const btn = m.querySelector("#regBtn");
      btn.disabled = true;
      try {
        const taken = await Chain.addressByUsername(user);
        if (taken) { err.textContent = "That username is already taken."; btn.disabled = false; return; }
      } catch (e) { /* network hiccup — let the tx decide */ }
      UI.closeModal();
      const ok = await Tx.run("Creating account", `Welcome to ${APP_NAME}, @${user}!`, () => Chain.tx.createAccount(nick, user));
      if (ok) {
        await refreshIdentity();
        loadSidebarWidgets();
        window.location.hash = "profile";
        route(true);
      }
    };
  }

  /* ================= modals: repost & edits ================= */

  async function openRepostModal(postId) {
    let orig;
    try { orig = await Chain.post(postId); } catch (e) { return UI.toast("Post not found.", "error"); }
    if (!orig.id || orig.hidden) return UI.toast("This post can't be reposted.", "error");
    const author = await Chain.displayInfo(orig.author);
    const m = UI.modal({
      title: "Repost",
      body: `
        <textarea id="repostNote" class="input" rows="3" placeholder="Add a note (optional)" maxlength="10000"></textarea>
        <div class="quoted static">
          <div class="quoted-head">
            ${UI.avatar(author, "sm")}
            <b>${UI.esc(author.nickname)}</b>
            <span class="muted">${author.username ? "@" + UI.esc(author.username) : ""} · ${UI.timeAgo(orig.time)}</span>
          </div>
          <div class="quoted-body">${UI.mdPreview(orig.content, orig.id, 220)}</div>
        </div>
        <div class="modal-actions">
          <button class="btn primary block" id="repostBtn"><i class="fas fa-retweet"></i> Repost</button>
        </div>`
    });
    m.querySelector("#repostBtn").onclick = async () => {
      const note = m.querySelector("#repostNote").value.trim();
      UI.closeModal();
      if (await Tx.run("Reposting", "Post reposted to your profile", () => Chain.tx.createRepost(postId, note))) {
        refreshPostCard(postId);
      }
    };
  }

  async function openEditPostModal(postId, isRepost) {
    let post;
    try { post = await Chain.post(postId); } catch (e) { return UI.toast("Post not found.", "error"); }
    const m = UI.modal({
      title: isRepost ? "Edit repost note" : "Edit post",
      body: `
        <textarea id="editText" class="input" rows="5" maxlength="10000">${UI.esc(post.content)}</textarea>
        <div class="modal-actions">
          <button class="btn ghost" id="editCancel">Cancel</button>
          <button class="btn primary" id="editSave"><i class="fas fa-check"></i> Save</button>
        </div>`
    });
    m.querySelector("#editCancel").onclick = UI.closeModal;
    m.querySelector("#editSave").onclick = async () => {
      const text = m.querySelector("#editText").value.trim();
      if (!text && !isRepost) return UI.toast("Post content cannot be empty.", "error");
      UI.closeModal();
      const fn = isRepost ? () => Chain.tx.editRepost(postId, text) : () => Chain.tx.editPost(postId, text);
      if (await Tx.run("Saving changes", "Post updated", fn)) refreshPostCard(postId);
    };
  }

  async function openEditCommentModal(postId, commentId) {
    let c;
    try { c = await Chain.comment(postId, commentId); } catch (e) { return UI.toast("Comment not found.", "error"); }
    const m = UI.modal({
      title: "Edit comment",
      body: `
        <textarea id="editText" class="input" rows="4" maxlength="10000">${UI.esc(c.text)}</textarea>
        <div class="modal-actions">
          <button class="btn ghost" id="editCancel">Cancel</button>
          <button class="btn primary" id="editSave"><i class="fas fa-check"></i> Save</button>
        </div>`
    });
    m.querySelector("#editCancel").onclick = UI.closeModal;
    m.querySelector("#editSave").onclick = async () => {
      const text = m.querySelector("#editText").value.trim();
      if (!text) return UI.toast("Comment cannot be empty.", "error");
      UI.closeModal();
      if (await Tx.run("Saving changes", "Comment updated", () => Chain.tx.editComment(postId, commentId, text)))
        refreshCommentCard(postId, commentId);
    };
  }

  /* ================= settings ================= */

  async function renderSettings() {
    const page = document.getElementById("settingsPage");
    page.innerHTML = `
      <div class="page-title"><h2>Settings</h2></div>
      <div id="settingsAccount"></div>
      <div id="settingsNetwork"></div>`;

    /* The network panel never needs a wallet. */
    renderNetworkPanel(document.getElementById("settingsNetwork"));

    const acct = document.getElementById("settingsAccount");
    if (!Wallet.isUnlocked()) {
      acct.innerHTML = `
        <div class="panel center-panel">
          <i class="fas fa-gear panel-hero-icon"></i>
          <h2>Profile settings</h2>
          <p class="muted">Unlock your wallet to manage your on-chain profile.</p>
          <button class="btn primary" onclick="App.requireWallet()">Unlock / Create Wallet</button>
        </div>`;
      return;
    }
    if (!state.registered) {
      acct.innerHTML = `
        <div class="panel center-panel">
          <i class="fas fa-user-plus panel-hero-icon"></i>
          <h2>No account yet</h2>
          <p class="muted">Register to customize your ${APP_NAME} profile.</p>
          <button class="btn primary" onclick="App.promptRegister()">Create Account</button>
        </div>`;
      return;
    }

    acct.innerHTML = UI.skeletons(1);

    let prof, basic;
    try {
      [prof, basic] = await Promise.all([Chain.userProfile(Wallet.address()), Chain.userBasic(Wallet.address())]);
    } catch (e) {
      acct.innerHTML = UI.emptyState("fa-triangle-exclamation", "Couldn't load your profile: " + Tx.friendlyError(e));
      return;
    }

    const fields = [
      { key: "nickname", label: "Nickname", icon: "fa-id-badge", value: prof.nickname, type: "input", fn: Chain.tx.updateNickname, done: "Nickname updated" },
      { key: "about", label: "About", icon: "fa-circle-info", value: prof.about, type: "textarea", fn: Chain.tx.updateAbout, done: "About updated" },
      { key: "website", label: "Website", icon: "fa-link", value: prof.website, type: "input", fn: Chain.tx.updateWebsite, done: "Website updated" },
      { key: "location", label: "Location", icon: "fa-location-dot", value: prof.location, type: "input", fn: Chain.tx.updateLocation, done: "Location updated" },
      { key: "avatar", label: "Profile picture (URL)", icon: "fa-image-portrait", value: prof.avatar, type: "input", fn: Chain.tx.updateProfilePicture, done: "Profile picture updated" },
      { key: "cover", label: "Cover picture (URL)", icon: "fa-panorama", value: prof.cover, type: "input", fn: Chain.tx.updateCoverPicture, done: "Cover picture updated" }
    ];

    acct.innerHTML = `
      <div class="panel">
        <h3><i class="fas fa-user-pen"></i> Profile</h3>
        <p class="muted fine-print">Each update is a separate on-chain transaction.</p>
        ${fields.map(f => `
          <div class="settings-field">
            <label class="field-label"><i class="fas ${f.icon}"></i> ${f.label}</label>
            <div class="settings-input-row">
              ${f.type === "textarea"
                ? `<textarea id="sf-${f.key}" class="input" rows="3" maxlength="1000">${UI.esc(f.value)}</textarea>`
                : `<input type="text" id="sf-${f.key}" class="input" maxlength="500" value="${UI.escAttr(f.value)}">`}
              <button class="btn ghost sm" id="sfBtn-${f.key}">Save</button>
            </div>
          </div>`).join("")}
      </div>
      <div class="panel">
        <h3><i class="fas fa-at"></i> Username</h3>
        <p class="muted fine-print">Your current username is <b>@${UI.esc(basic.username)}</b>. Changing it frees the old one for others.</p>
        <div class="settings-input-row">
          <input type="text" id="sf-username" class="input" maxlength="30" value="${UI.escAttr(basic.username)}">
          <button class="btn danger sm" id="sfBtn-username">Change</button>
        </div>
      </div>`;

    fields.forEach(f => {
      acct.querySelector(`#sfBtn-${f.key}`).onclick = async () => {
        const val = acct.querySelector(`#sf-${f.key}`).value.trim();
        if (f.key === "nickname" && !val) return UI.toast("Nickname cannot be empty.", "error");
        if (await Tx.run(`Updating ${f.label.toLowerCase()}`, f.done, () => f.fn(val))) {
          Chain.invalidateProfile(Wallet.address());
          await refreshIdentity();
        }
      };
    });

    acct.querySelector("#sfBtn-username").onclick = async () => {
      const val = acct.querySelector("#sf-username").value.trim();
      if (!/^[A-Za-z0-9]{5,}$/.test(val)) return UI.toast("Username: at least 5 characters, letters and numbers only.", "error");
      if (val.toLowerCase() === basic.username.toLowerCase()) return UI.toast("That's already your username.", "info");
      try {
        const taken = await Chain.addressByUsername(val);
        if (taken) return UI.toast("That username is already taken.", "error");
      } catch (e) {}
      const ok = await UI.confirm({
        title: "Change username?",
        message: `Links to <b>@${UI.esc(basic.username)}</b> will stop working and the name becomes available to anyone.`,
        okLabel: "Change username", danger: true
      });
      if (ok && await Tx.run("Changing username", `You are now @${val}`, () => Chain.tx.changeUsername(val))) {
        Chain.invalidateProfile(Wallet.address());
        await refreshIdentity();
        renderSettings();
      }
    };
  }

  /* ================= network / RPC panel ================= */

  function renderNetworkPanel(container) {
    const current = Wallet.currentRpc();
    const custom = Wallet.customRpcs();

    const row = (url, isCustom) => {
      const active = url === current;
      return `
        <div class="rpc-item ${active ? "active" : ""}" data-rpc="${UI.escAttr(url)}">
          <i class="fas ${active ? "fa-circle-check" : "fa-circle"} rpc-dot"></i>
          <div class="rpc-meta">
            <code>${UI.esc(url)}</code>
            <span class="rpc-tags">
              <span class="badge">${isCustom ? "Custom" : "Official"}</span>
              ${active ? `<span class="badge">In use</span>` : ""}
            </span>
          </div>
          ${!active ? `<button class="btn ghost sm rpc-use" data-rpc="${UI.escAttr(url)}">Use</button>` : ""}
          ${isCustom ? `<button class="icon-btn rpc-del" data-rpc="${UI.escAttr(url)}" title="Remove"><i class="fas fa-trash"></i></button>` : ""}
        </div>`;
    };

    container.innerHTML = `
      <div class="panel">
        <h3><i class="fas fa-network-wired"></i> Network RPC</h3>
        <p class="muted fine-print" style="margin-top:0">
          Every read and transaction goes through this endpoint. Your choice is saved on this device —
          no wallet or account needed.</p>
        <div class="rpc-status" id="rpcStatus">${UI.spinnerHTML("Checking connection…")}</div>
        <div class="rpc-list">
          ${CHAIN.rpcUrls.map(u => row(u, false)).join("")}
          ${custom.map(u => row(u, true)).join("")}
        </div>
        <label class="field-label">Add a custom RPC (localhost works too)</label>
        <div class="settings-input-row">
          <input type="text" id="rpcInput" class="input mono" placeholder="https://my-node.example.com  or  http://localhost:8545">
          <button class="btn ghost sm" id="rpcAddBtn">Add &amp; Use</button>
        </div>
        <p class="field-error" id="rpcErr"></p>
        ${Wallet.isCustomRpcActive() ? `<button class="btn ghost sm" id="rpcResetBtn"><i class="fas fa-rotate-left"></i> Reset to default RPCs</button>` : ""}
      </div>`;

    /* live health check of the active endpoint */
    (async () => {
      const status = container.querySelector("#rpcStatus");
      const r = await Wallet.testRpc(current);
      if (!status || !status.isConnected) return;
      if (r.reachable && r.matches) {
        status.innerHTML = `<i class="fas fa-circle-check" style="color:var(--success)"></i>
          Connected · chain ID <b>${r.chainId}</b> · block <b>${r.block ?? "?"}</b> · ${r.latency} ms`;
      } else if (r.reachable) {
        status.innerHTML = `<i class="fas fa-triangle-exclamation" style="color:var(--warning)"></i>
          Reachable, but reports chain ID <b>${r.chainId}</b> (expected ${CHAIN.chainId})`;
      } else {
        status.innerHTML = `<i class="fas fa-circle-exclamation" style="color:var(--danger)"></i>
          Unreachable: ${UI.esc(r.error || "unknown error")}`;
      }
    })();

    const applyRpc = (url) => {
      Wallet.setRpc(url);
      UI.toast(url ? "RPC switched — the whole app now uses this endpoint." : "Back to the default RPCs.", "success");
      loadSidebarWidgets();
      renderNetworkPanel(container); // re-render to reflect the new active endpoint
    };

    container.querySelectorAll(".rpc-use").forEach(b => b.onclick = () => applyRpc(b.dataset.rpc));

    container.querySelectorAll(".rpc-del").forEach(b => b.onclick = async () => {
      const url = b.dataset.rpc;
      const ok = await UI.confirm({
        title: "Remove custom RPC?",
        message: `<code>${UI.esc(url)}</code> will be removed from your saved list.` +
                 (url === current ? "<br><br>It is currently in use — the app will fall back to the default RPCs." : ""),
        okLabel: "Remove", danger: true
      });
      if (!ok) return;
      Wallet.removeCustomRpc(url);
      loadSidebarWidgets();
      renderNetworkPanel(container);
    });

    const resetBtn = container.querySelector("#rpcResetBtn");
    if (resetBtn) resetBtn.onclick = () => applyRpc(null);

    container.querySelector("#rpcAddBtn").onclick = async () => {
      const input = container.querySelector("#rpcInput");
      const err = container.querySelector("#rpcErr");
      const btn = container.querySelector("#rpcAddBtn");
      let url = input.value.trim().replace(/\/+$/, "");
      err.textContent = "";
      if (!/^https?:\/\/.+/i.test(url)) { err.textContent = "Enter a valid http(s):// URL."; return; }
      btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Testing…`;
      const r = await Wallet.testRpc(url);
      btn.disabled = false; btn.innerHTML = "Add &amp; Use";
      if (!r.reachable) {
        err.textContent = "Couldn't reach that endpoint: " + (r.error || "no response") + ".";
        return;
      }
      if (!r.matches) {
        const anyway = await UI.confirm({
          title: "Different chain ID",
          message: `This RPC reports chain ID <b>${r.chainId}</b>, but ${CHAIN.name} is <b>${CHAIN.chainId}</b>.
                    Using it will show a different network's data. Continue anyway?`,
          okLabel: "Use anyway", danger: true
        });
        if (!anyway) return;
      }
      Wallet.addCustomRpc(url);
      applyRpc(url);
    };
  }

  /* ================= right sidebar widgets ================= */

  function renderStatTiles(users, posts) {
    const statsEl = document.getElementById("statsContent");
    if (!statsEl) return;
    statsEl.innerHTML = `
      <div class="stat-tile"><b>${users}</b><span>Users</span></div>
      <div class="stat-tile"><b>${posts}</b><span>Posts</span></div>`;
  }

  async function refreshRecentlyJoined(total) {
    const recentEl = document.getElementById("recentlyJoined");
    if (!recentEl) return;
    try {
      if (total === undefined) total = await Chain.totalUsers();
      const ids = [];
      for (let i = total; i > Math.max(0, total - 5); i--) ids.push(i);
      const addrs = (await Promise.allSettled(ids.map(id => Chain.addressById(id))))
        .filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
      const infos = await Promise.all(addrs.map(a => Chain.displayInfo(a)));
      recentEl.innerHTML = infos.map(u => `
        <a class="mini-user" href="#${UI.escAttr(u.username || "")}">
          ${UI.avatar(u, "sm")}
          <span class="mini-user-names">
            <b>${UI.esc(u.nickname)}</b>
            <span class="muted">${u.username ? "@" + UI.esc(u.username) : ""}</span>
          </span>
        </a>`).join("") || `<p class="muted fine-print">No users yet.</p>`;
    } catch (e) {
      recentEl.innerHTML = `<p class="muted fine-print">Network unreachable.</p>`;
    }
  }

  async function loadSidebarWidgets() {
    try {
      const [users, posts] = await Promise.all([Chain.totalUsers(), Chain.totalPosts()]);
      lastUserCount = users;
      lastPostCount = posts;
      renderStatTiles(users, posts);
      await refreshRecentlyJoined(users);
    } catch (e) {
      const statsEl = document.getElementById("statsContent");
      if (statsEl) statsEl.innerHTML = `<p class="muted fine-print">Network unreachable.</p>`;
    }
  }

  return { init, route, onWalletChange, requireWallet, requireRegistered, promptRegister };
})();

window.addEventListener("DOMContentLoaded", App.init);

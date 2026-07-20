/* =========================================================
 * FusionX — Contract layer
 *
 * All reads go through the RPC provider; all writes go
 * through the built-in wallet's signer. Every write is
 * wrapped by Tx.run() (see ui.js) which shows the status
 * card and refreshes the wallet balance on confirmation.
 * ========================================================= */

const Chain = (() => {

  const ZERO = "0x0000000000000000000000000000000000000000";

  let readContract = null;

  /* When the user switches RPC, drop the cached contract so reads rebind. */
  Wallet.on("rpc", () => { readContract = null; });

  function reader() {
    if (!readContract) {
      readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, Wallet.getProvider());
    }
    return readContract;
  }

  function writer() {
    const s = Wallet.getSigner();
    if (!s) throw new Error("Wallet is locked.");
    return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, s);
  }

  /* Retry a read once (on the fallback RPC when using defaults) before giving up. */
  function isNetworkError(e) {
    if (!e) return false;
    if (e.code === "NETWORK_ERROR" || e.code === "TIMEOUT" || e.code === "SERVER_ERROR") return true;
    return /failed to fetch|networkerror|load failed|timeout/i.test(e.message || "");
  }

  async function call(fn, ...args) {
    try {
      return await reader()[fn](...args);
    } catch (e) {
      if (isNetworkError(e)) {
        Wallet.rotateRpc();
        readContract = null;
        return await reader()[fn](...args);
      }
      throw e;
    }
  }

  const toNum = v => Number(v);

  /* ---------- typed read helpers ---------- */

  async function totalUsers()      { return toNum(await call("getTotalUsers")); }
  async function totalPosts()      { return toNum(await call("getGlobalPostCount")); }
  async function isRegistered(a)   { return await call("isUserRegistered", a); }
  async function addressByUsername(u) { const a = await call("getUserAddressByUsername", u); return a === ZERO ? null : a; }
  async function addressById(id)   { const a = await call("getUserAddressById", id); return a === ZERO ? null : a; }

  async function userBasic(a) {
    const r = await call("getUserBasic", a);
    return { userId: toNum(r[0]), username: r[1], createdAt: toNum(r[2]), createdBlock: toNum(r[3]), registered: r[4] };
  }

  async function userProfile(a) {
    const r = await call("getUserProfile", a);
    return { nickname: r[0], about: r[1], website: r[2], location: r[3], avatar: r[4], cover: r[5], pinnedPost: toNum(r[6]) };
  }

  async function userStats(a) {
    const r = await call("getUserStats", a);
    return { posts: toNum(r[0]), comments: toNum(r[1]), followers: toNum(r[2]), following: toNum(r[3]) };
  }

  async function post(id) {
    const r = await call("getPost", id);
    return {
      id: toNum(r[0]), author: r[1], authorPostId: toNum(r[2]), time: toNum(r[3]),
      content: r[4], comments: toNum(r[5]), likes: toNum(r[6]), dislikes: toNum(r[7]),
      hidden: r[8], isRepost: r[9], originalId: toNum(r[10]), reposts: toNum(r[11])
    };
  }

  async function comment(postId, commentId) {
    const r = await call("getComment", postId, commentId);
    return {
      postId: toNum(r[0]), id: toNum(r[1]), author: r[2], time: toNum(r[3]),
      text: r[4], likes: toNum(r[5]), dislikes: toNum(r[6]), hidden: r[7]
    };
  }

  async function postCommentCount(postId)   { return toNum(await call("getPostCommentCount", postId)); }
  async function userCommentCount(a)        { return toNum(await call("getUserCommentCount", a)); }
  async function userComment(a, i)          { const r = await call("getUserComment", a, i); return { postId: toNum(r[0]), commentId: toNum(r[1]) }; }
  async function globalPostId(a, userPostId){ return toNum(await call("getGlobalPostId", a, userPostId)); }
  async function reactionOnPost(id, a)      { return await call("getUserReactionOnPost", id, a); }
  async function reactionOnComment(p, c, a) { return await call("getUserReactionOnComment", p, c, a); }
  async function isFollowing(f, t)          { return await call("getIsFollowing", f, t); }

  /* Fetch a descending range of posts in parallel: ids [from .. from-count+1] */
  async function postRange(from, count) {
    const ids = [];
    for (let i = from; i > Math.max(0, from - count); i--) ids.push(i);
    const results = await Promise.allSettled(ids.map(id => post(id)));
    return results.filter(r => r.status === "fulfilled").map(r => r.value);
  }

  /* ---------- profile cache (username / nickname / avatar) ---------- */

  const profileCache = new Map();

  async function displayInfo(addr) {
    if (!addr) return { nickname: "", username: null, avatar: "", addr };
    const key = addr.toLowerCase();
    if (profileCache.has(key)) return profileCache.get(key);
    let info;
    try {
      const [basic, prof] = await Promise.all([userBasic(addr), userProfile(addr)]);
      info = { nickname: prof.nickname, username: basic.username, avatar: prof.avatar, addr };
    } catch (e) {
      info = { nickname: UI.shortAddr(addr), username: null, avatar: "", addr };
    }
    profileCache.set(key, info);
    return info;
  }

  function invalidateProfile(addr) { if (addr) profileCache.delete(addr.toLowerCase()); }

  /* ---------- writes (raw; use through Tx.run) ---------- */

  const tx = {
    createAccount: (nick, user)       => writer().createAccount(nick, user),
    changeUsername: (u)               => writer().changeUsername(u),
    updateNickname: (v)               => writer().updateNickname(v),
    updateAbout: (v)                  => writer().updateAbout(v),
    updateWebsite: (v)                => writer().updateWebsite(v),
    updateLocation: (v)               => writer().updateLocation(v),
    updateProfilePicture: (v)         => writer().updateProfilePicture(v),
    updateCoverPicture: (v)           => writer().updateCoverPicture(v),
    createPost: (content)             => writer().createPost(content),
    createRepost: (id, note)          => writer().createRepost(id, note),
    editPost: (id, content)           => writer().editPost(id, content),
    editRepost: (id, note)            => writer().editRepost(id, note),
    hidePost: (id, hidden)            => writer().hidePost(id, hidden),
    pinPost: (id)                     => writer().pinPost(id),
    createComment: (postId, text)     => writer().createComment(postId, text),
    editComment: (p, c, text)         => writer().editComment(p, c, text),
    hideComment: (p, c, hidden)       => writer().hideComment(p, c, hidden),
    reactToPost: (id, r)              => writer().reactToPost(id, r),
    reactToComment: (p, c, r)         => writer().reactToComment(p, c, r),
    followUser: (a, follow)           => writer().followUser(a, follow)
  };

  return {
    ZERO, reader,
    totalUsers, totalPosts, isRegistered, addressByUsername, addressById,
    userBasic, userProfile, userStats, post, comment,
    postCommentCount, userCommentCount, userComment, globalPostId,
    reactionOnPost, reactionOnComment, isFollowing, postRange,
    displayInfo, invalidateProfile,
    tx
  };
})();

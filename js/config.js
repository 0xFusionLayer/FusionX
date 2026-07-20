/* =========================================================
 * FusionX — Configuration
 * Chain, contract and official links. Everything the app
 * needs to know about the outside world lives here.
 * ========================================================= */

const APP_NAME = "FusionX";
const APP_TAGLINE = "Built on FusionLayer. Beyond Control.";

const CHAIN = {
  chainId: 5070,
  name: "FusionLayer",
  symbol: "FXL",
  decimals: 18,
  rpcUrls: [
    "https://rpc.fusionlayer.org/",
    "https://rpc.fusionscan.net/"
  ],
  explorer: "https://fusionscan.net"
};

const CONTRACT_ADDRESS = "0x13e4b3fE79388C6eF206481655c8557320811104";

const LINKS = {
  website:    "https://fusionlayer.org/",
  metamask:   "https://fusionlayer.org/metamask",
  explorer:   "https://fusionscan.net/",
  github:     "https://github.com/0xFusionLayer",
  twitter:    "https://x.com/0xFusionLayer",
  tgChannel:  "https://t.me/FusionLayer",
  tgChat:     "https://t.me/FusionLayerChat",
  discord:    "https://discord.gg/FYjW7NUZSt"
};

/* localStorage / sessionStorage keys */
const STORE = {
  keystore:   "fusionx.keystore",   // encrypted JSON keystore (localStorage)
  address:    "fusionx.address",    // saved wallet address (localStorage)
  session:    "fusionx.session",    // decrypted key for this tab (sessionStorage)
  theme:      "fusionx.theme",
  rpc:        "fusionx.rpc",        // user-selected RPC endpoint (overrides defaults)
  customRpcs: "fusionx.rpcs"        // user-saved custom RPC list (JSON array)
};

/* Feed tuning */
const FEED_BATCH = 8;   // posts fetched per scroll step

/* Public web home of the platform — used for share links when the app
   isn't running on a public origin (desktop shell serves from 127.0.0.1). */
const PUBLIC_ORIGIN = "https://fusionx.social";

/* Desktop shell detection (set by the Electron preload before app scripts run).
   Used to adapt copy: on desktop, data lives in AppData, not "the browser". */
const IS_DESKTOP = typeof window !== "undefined" && !!window.FUSIONX_DESKTOP;
const DESKTOP_VERSION = IS_DESKTOP && window.FUSIONX_DESKTOP.version ? String(window.FUSIONX_DESKTOP.version) : null;
const STORAGE_PLACE = IS_DESKTOP ? "on this PC" : "in your browser";
const STORAGE_DETAIL = IS_DESKTOP
  ? "in your AppData folder (%APPDATA%\\FusionX)"
  : "in your browser's local storage on this device";

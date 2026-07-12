# FusionX — Decentralized Social on FusionLayer

**Built on FusionLayer. Beyond Control.**

FusionX is a fully on-chain, adminless social platform. One immutable smart contract holds all
state (users, posts, reposts, comments, reactions, follows); this static frontend reads and
writes it directly over JSON-RPC — no servers, no database, no indexer, no browser extension.

## Key facts

| | |
|---|---|
| Production | https://fusionx.social/ |
| Chain | FusionLayer (chain ID `5070`, currency `FXL`) |
| RPC | `https://rpc.fusionlayer.org/` (fallback: `https://rpc.fusionscan.net/`) |
| Explorer | https://fusionscan.net/ |
| Contract | `0x13e4b3fE79388C6eF206481655c8557320811104` |

## Built-in wallet (no MetaMask)

- **Create** — key pair generated in the browser; private key + recovery phrase shown once with a forced "I saved it" confirmation.
- **Import** — paste an existing private key.
- **Storage** — key encrypted with the user's password (standard Ethereum keystore, scrypt + AES) in `localStorage`. Never leaves the device.
- **Session** — decrypted key kept per-tab (`sessionStorage`), so no password prompt per interaction. Survives reloads; cleared when the tab closes or on **Logout**.
- **Unlock** — after logout the saved address is displayed and only the password is required.
- **Send / receive FXL** — on the Wallet page; live balance in the top bar, refreshed after every transaction and every 30 s.

## Project structure

```
index.html          SPA shell (hash routing)
css/app.css         design system — light / dim / dark themes, responsive
js/config.js        chain, contract address, links, storage keys
js/abi.js           contract ABI
js/wallet.js        wallet engine (create/import/unlock/session/send/balance)
js/wallet-ui.js     onboarding, unlock, navbar chip, wallet page
js/chain.js         typed contract read layer + write methods + profile cache
js/ui.js            escaping, sanitized markdown, toasts, modals, Tx status cards
js/app.js           router, feeds, post/comment cards, profiles, settings
docs/               documentation page
faq/                FAQ page
img/                logo, favicon, social card
legacy/             the previous EtherForum build (reference only)
contract.sol        deployed contract source (reference)
```

## Desktop app (Windows)

The Electron wrapper lives in a **sibling project** — `..\fusionx-desktop` — kept outside this
folder so web deploys never pick it up. It packages a copy of this web app:

- **Data in AppData** — wallet keystore, theme, and RPC settings are stored as a plain JSON file
  in `%APPDATA%\FusionX\fusionx-data.json` (a preload bridge replaces `localStorage`; the web
  code is unchanged). Unlocked sessions still end when the app closes.
- **Tray by default** — closing the window minimizes to the system tray; quit from the tray menu.
  Single-instance: launching again focuses the existing window.
- **Local-only server** — the UI is served from an ephemeral port on `127.0.0.1`; external links
  open in the system browser.

Build (requires Node.js):

```
cd ..\fusionx-desktop
npm install           # requires Node.js 22+
node make-icon.js     # once: generates build/icon.ico from ..\social\img\logo.png
npm run dist          # copies the web app into app/ and produces dist/ (installer + portable exe)
```

`npm start` runs it unpackaged for development.

## Running locally

It's a static site — serve the folder over HTTP with anything, e.g.:

```
npx serve .          # or
python -m http.server 8080
```

CDN dependencies (ethers v6, marked, DOMPurify, Font Awesome, Inter font) load at runtime,
so an internet connection is required.

## Engineering notes

- **Every write** goes through `Tx.run()`: floating status card (pending → confirmed/failed with
  the contract revert reason), FusionScan link, automatic balance refresh.
- **Feeds** load in parallel batches (descending IDs) with `IntersectionObserver` infinite scroll —
  no scroll-handler leaks, no duplicate renders.
- **All user content is sanitized** (DOMPurify) before rendering; markdown + @mentions supported.
- **RPC failover** — reads retry on the secondary RPC automatically.
- **RPC manager** — Settings → Network RPC (no wallet needed): live health check of the active
  endpoint, switch between official RPCs, add/remove custom ones (incl. `http://localhost:…`);
  the selection is persisted and drives the entire app. Chain-ID mismatches warn before switching.
- **Live chain watcher** — ~per-block polling drives the "N new posts" feed banner, auto-updating
  platform stats, and the optional "Following only" feed filter.
- Routes: `#home`, `#wallet`, `#profile`, `#settings`, `#post<id>`, `#post<id>/#comment<n>`, `#<username>`.
  Old EtherForum deep-link format is preserved.

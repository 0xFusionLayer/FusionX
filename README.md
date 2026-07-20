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
contract.sol        deployed contract source (reference)
```

## Cache busting (release checklist)

CSS/JS URLs in `index.html`, `docs/index.html`, and `faq/index.html` carry a `?v=X.Y.Z` query.
`.htaccess` makes HTML always revalidate while CSS/JS cache for a year — so **on every release,
bump the `?v=` value in those three files** (match the desktop version). That one change forces
every visitor's browser to fetch the new assets; without it, users keep running stale cached code.

## Share links & link previews (meta.php)

URL fragments (`#post14`) are never sent to servers, so hash links can't produce per-entity
previews. Share buttons therefore copy pretty URLs, rewritten by `.htaccess` to `meta.php`:

| Entity  | Share URL                                   | Redirects into the app at   |
|---------|---------------------------------------------|-----------------------------|
| Profile | `https://fusionx.social/username`           | `/#username`                |
| Post    | `https://fusionx.social/post/14`            | `/#post14`                  |
| Comment | `https://fusionx.social/post/14/comment/3`  | `/#post14/#comment3`        |

`meta.php` reads the entity straight from the FusionLayer RPC (selectors precomputed, manual ABI
decode, 5-min disk cache) and emits Open Graph / Twitter meta:

- descriptions show the content with markdown converted to readable text (line breaks kept,
  lists as bullets, syntax stripped)
- **og:image only when the content contains an image** (markdown image or bare image URL) —
  never the default site card on posts/comments; profiles use the avatar when set
- hidden/unknown entities get a neutral no-image card

Share buttons: posts (share icon), comments (share icon on each comment), profiles (share icon
in the header). In-app navigation stays 100% hash-based, so the app itself still runs on any
static host or from disk — the pretty URLs only need PHP on the public domain.

## Desktop app (Windows)

The Electron wrapper lives in a **sibling project** — `..\desktop` (project layout:
`D:\FXL\fusionx\web` + `D:\FXL\fusionx\desktop`) — kept outside this folder so web deploys
never pick it up. It packages a copy of this web app:

- **Data in AppData** — wallet keystore, theme, and RPC settings are stored as a plain JSON file
  in `%APPDATA%\FusionX\fusionx-data.json` (a preload bridge replaces `localStorage`; the web
  code is unchanged). Unlocked sessions still end when the app closes.
- **Tray by default** — closing the window minimizes to the system tray; quit from the tray menu.
  Single-instance: launching again focuses the existing window.
- **Local-only server** — the UI is served from an ephemeral port on `127.0.0.1`; external links
  open in the system browser.

Build (requires Node.js):

```
cd ..\desktop
npm install           # requires Node.js 22+
node make-icon.js     # once: generates build/icon.ico from ..\web\img\logo.png
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

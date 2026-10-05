# Off-OS Browser

A small installable browser shell with a local HTTP proxy. It uses Node's built-in modules only, makes no AI calls, and needs no package installation.

## Run

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). The server binds to `127.0.0.1` only; keep it local and do not expose it to the public internet. Install the PWA from your browser's install option.

## Offline behavior

The app shell, recent pages, and bookmarks remain available offline. The service worker caches successful proxied GET responses, so a page you already opened can be reopened while offline. A first visit still needs an internet connection, and pages may depend on uncached assets or live services. This is an offline-capable proxy browser, not an offline copy of the internet.

The proxy rewrites common HTML and CSS resource links and blocks private/local IP addresses. It is a lightweight personal browser, not a complete replacement for a full browser engine: some complex sites, login flows, streaming, and client-side cross-origin requests may not work. The proxied document runs in a sandbox.

## Check

```sh
npm test
```
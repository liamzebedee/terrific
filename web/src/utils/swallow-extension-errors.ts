// Browser extensions (crypto wallets, etc.) inject scripts into every page and
// throw uncaught errors / unhandled rejections that bubble to `window`. Bun's
// dev error overlay listens on `window` and can't tell those apart from our
// bundle's errors, so it pops the fullscreen overlay for extension noise.
//
// Install capture-phase listeners FIRST (before the overlay's) and drop any
// event whose origin is a chrome-extension:// / moz-extension:// URL, so it
// never reaches the overlay.

const isExtensionUrl = (s: unknown): boolean =>
  typeof s === "string" && /^(chrome|moz|safari-web)-extension:\/\//.test(s);

const fromExtension = (stack: unknown): boolean =>
  typeof stack === "string" && /(chrome|moz|safari-web)-extension:\/\//.test(stack);

window.addEventListener(
  "error",
  (e) => {
    if (isExtensionUrl(e.filename) || fromExtension((e.error as Error | undefined)?.stack)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  },
  true, // capture: run before the overlay's bubble-phase listener
);

window.addEventListener(
  "unhandledrejection",
  (e) => {
    const reason = e.reason as { stack?: string } | undefined;
    if (fromExtension(reason?.stack)) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  },
  true,
);

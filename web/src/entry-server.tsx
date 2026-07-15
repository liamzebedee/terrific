// The frontend's server-side render layer — the "render server".
//
// The app ships as a client-rendered SPA, so anything React puts in <head> at
// runtime is invisible to social crawlers (Facebook, Telegram, Slack, …), which
// don't run JS. For server-rendered routes this module renders the HTML document
// itself — React SSR (renderToReadableStream) of the <html> shell — so the
// <head> is correct in the response body. The <body> is just the empty #root +
// the client entry script, so the SPA boots exactly as before (no hydration of
// app content, so app.tsx stays unchanged).
//
// To give a route its own social card, add a branch to `generateMetadata`;
// every route served by `renderDocument` (see main.ts) gets the site card by
// default.

import { renderToReadableStream } from "react-dom/server";
import { spa } from "./spa.ts";

// Next.js-style page metadata. Extend as pages need more (canonical, image, …).
export interface Metadata {
  title: string;
  description: string;
  image?: string; // absolute URL to the social-card image
}

const SITE: Metadata = {
  title: "App Template",
  description: "A typed-RPC + SQLite app template.",
};

// Resolve a URL to its page metadata. Mirrors the client router in app.tsx and
// runs on the server, so it can load per-route data if a card needs it.
async function generateMetadata(_url: URL): Promise<Metadata> {
  return SITE;
}

// The HTML document. React escapes attribute values, so no manual escaping.
function Document({ meta, url }: { meta: Metadata; url: string }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light only" />
        <title>{meta.title}</title>
        <meta name="description" content={meta.description} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="App Template" />
        <meta property="og:title" content={meta.title} />
        <meta property="og:description" content={meta.description} />
        <meta property="og:url" content={url} />
        <meta name="twitter:title" content={meta.title} />
        <meta name="twitter:description" content={meta.description} />
        {meta.image ? (
          <>
            <meta property="og:image" content={meta.image} />
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:image" content={meta.image} />
          </>
        ) : (
          <meta name="twitter:card" content="summary" />
        )}
        {spa?.css.map((href) => <link key={href} rel="stylesheet" href={href} />)}
      </head>
      <body>
        <div id="root" />
        <script type="module" src={spa?.js} />
      </body>
    </html>
  );
}

// Render a full HTML document for a server-rendered route: SSR the shell so the
// <head> ships in the response, then let the client script boot the SPA into the
// empty #root. Registered as the "/*" handler in main.ts (production). React 19
// emits the <!DOCTYPE html> itself when rendering a full <html> document.
export async function renderDocument(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const meta = await generateMetadata(url);
  const stream = await renderToReadableStream(<Document meta={meta} url={url.href} />);
  return new Response(stream, { headers: { "content-type": "text/html;charset=utf-8" } });
}

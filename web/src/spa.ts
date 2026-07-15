// The client bundle, built once in-process (production only).
//
// In production the render server renders each document's HTML itself (React SSR
// of the <html> shell, so the <head> is correct for crawlers). To do that it
// needs the hashed client asset URLs — so we bundle src/index.html here with
// Bun.build and expose the entry <script> + <link> URLs plus routes that serve
// the built chunks. In development main.ts uses Bun's fullstack HMR instead, so
// this build is skipped (spa === null).

import type { BunRequest } from "bun";

export interface Spa {
  js: string;                 // "/chunk-*.js" — the entry module
  css: string[];              // "/chunk-*.css" — stylesheets
  routes: Record<string, (req: BunRequest) => Response>;
}

async function build(): Promise<Spa> {
  const out = await Bun.build({
    entrypoints: [`${import.meta.dir}/index.html`],
    minify: true,
    sourcemap: "none",
    publicPath: "/", // absolute asset URLs, so nested routes (/shared/…) resolve them
  });
  if (!out.success) throw new AggregateError(out.logs, "SPA build failed");

  let js = "";
  const css: string[] = [];
  const routes: Record<string, (req: BunRequest) => Response> = {};
  for (const o of out.outputs) {
    if (o.path.endsWith(".html")) continue; // we render our own document
    const url = `/${o.path.replace(/^\.?\//, "")}`;
    const body = await o.arrayBuffer();
    const type = o.type;
    routes[url] = () =>
      new Response(body, {
        headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" },
      });
    if (o.kind === "entry-point" && url.endsWith(".js")) js = url;
    else if (url.endsWith(".css")) css.push(url);
  }
  return { js, css, routes };
}

export const spa: Spa | null = process.env.NODE_ENV === "production" ? await build() : null;

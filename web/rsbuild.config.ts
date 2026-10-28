import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

/**
 * The mark: a safe whose dial carries a tick (signed, allowed), drawn to read at 16px. Brand blue, no tile;
 * the door's tint strengthens on dark tab bars.
 */
const VAULT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.t{opacity:.28}@media (prefers-color-scheme:dark){.t{opacity:.5}}</style><defs><mask id="m"><rect width="32" height="32" fill="#fff"/><path d="M13.7 14.6l1.6 1.6 3-3.2" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><g fill="#0091fd"><rect class="t" x="6" y="5.5" width="20" height="18.5"/><path fill-rule="evenodd" d="M7.5 3h17a4 4 0 0 1 4 4v15.5a4 4 0 0 1-4 4h-17a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM6.5 6v17.5h19V6z"/><rect x="20" y="13.5" width="6" height="3" rx="0"/><rect x="6.5" y="25.5" width="4" height="3.5" rx="1.5"/><rect x="21.5" y="25.5" width="4" height="3.5" rx="1.5"/><circle cx="16" cy="14.8" r="5.2" mask="url(#m)"/></g></svg>`;

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: "./src/main.tsx", confirm: "./src/confirm.tsx" } },
  html: {
    title: ({ entryName }) => entryName === "confirm" ? "Confirm an owner action" : "Agentic Treasury",
    // The Vault mark inline: no image file to ship.
    tags: [{ tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: `data:image/svg+xml,${encodeURIComponent(VAULT)}` } }],
  },
  output: { distPath: { root: "dist" } },
  // `pnpm server` answers the RPC calls; the dev server only serves the UI.
  server: { port: 3000, proxy: { "/rpc": "http://127.0.0.1:8787" } },
});

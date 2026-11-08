import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Shown on the Sync queue screen so anyone can tell which build their phone is running (a phone can keep an older copy until the app is closed and reopened).
const BUILD_ID = `${(process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "PHC Field Audit",
        short_name: "Field Audit",
        description: "Pre-install site audit for installers. Works offline.",
        theme_color: "#0c0c0c",
        background_color: "#0c0c0c",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "/index.html",
        // Never cache or intercept Supabase API traffic: data goes through our own IndexedDB cache + outbox.
        navigateFallbackDenylist: [/^\/auth\//, /^\/rest\//, /^\/api\//]
      }
    })
  ],
  test: { include: ["test/**/*.test.ts"], environment: "node" }
});

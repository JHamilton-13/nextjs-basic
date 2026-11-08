import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
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

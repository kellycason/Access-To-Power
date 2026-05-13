import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Power Apps Code Apps serve `index.html` from project root and expect a
// predictable bundle layout. Keep asset filenames stable so deploys don't
// thrash CDN caches.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.name && asset.name.endsWith(".css")
            ? "assets/app.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});

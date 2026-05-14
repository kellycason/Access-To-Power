import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

/**
 * Vite dev-mode helper: when the app is running under `npm run dev` (not in
 * the Power Apps Code Apps host), there is no auth context and Dataverse
 * blocks CORS. We work around both by proxying every `/dv-api/*` request to
 * the configured environment and injecting a bearer token grabbed from the
 * local `az` CLI.
 *
 * The token is cached for 30 minutes (Azure AD tokens are valid for ~1 hour;
 * we refresh well before expiry).
 */
let cachedToken: { value: string; expires: number } | null = null;
function getAzToken(resource: string): string {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const out = execSync(
    `cmd.exe /d /c az account get-access-token --resource "${resource}" --query accessToken -o tsv`,
    { encoding: "utf8" },
  ).trim();
  cachedToken = { value: out, expires: Date.now() + 30 * 60 * 1000 };
  return out;
}

// Power Apps Code Apps serve `index.html` from project root and expect a
// predictable bundle layout. Keep asset filenames stable so deploys don't
// thrash CDN caches.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const dvUrl = env.VITE_DATAVERSE_URL?.replace(/\/+$/, "") ?? "";

  return {
    plugins: [react()],
    base: "./",
    server: {
      port: 3000,
      strictPort: true,
      proxy: dvUrl
        ? {
            "/dv-api": {
              target: dvUrl,
              changeOrigin: true,
              secure: true,
              rewrite: (path) => path.replace(/^\/dv-api/, ""),
              configure: (proxy) => {
                proxy.on("proxyReq", (proxyReq) => {
                  try {
                    const token = getAzToken(dvUrl);
                    proxyReq.setHeader("Authorization", `Bearer ${token}`);
                  } catch (e) {
                    console.error("[dv-api proxy] az token fetch failed:", e);
                  }
                });
              },
            },
          }
        : undefined,
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
  };
});

import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import { existsSync, readdirSync, createReadStream } from "node:fs";
import { resolve, sep } from "node:path";

// Optional, locally extracted data is never bundled or published implicitly.
function localBundles(): Plugin {
  const root = resolve(import.meta.dirname, "bundles");
  return {
    name: "local-worldgen-bundles",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname === "/bundles/index.json") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(
              existsSync(root)
                ? readdirSync(root)
                    .filter(
                      (name) =>
                        name.endsWith(".bundle.json") &&
                        !name.endsWith(".structures.bundle.json"),
                    )
                    .sort()
                : [],
            ),
          );
          return;
        }
        if (!pathname.startsWith("/bundles/")) return next();
        let path: string;
        try {
          path = resolve(root, decodeURIComponent(pathname.slice(9)));
        } catch {
          res.statusCode = 400;
          res.end("Invalid bundle path");
          return;
        }
        if (
          !path.startsWith(root + sep) ||
          !path.endsWith(".bundle.json") ||
          !existsSync(path)
        ) {
          res.statusCode = 404;
          res.end("Bundle not found");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        createReadStream(path).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), UnoCSS(), localBundles()],
  server: { port: 8787, strictPort: true },
  preview: { port: 8787, strictPort: true },
  build: { target: "es2022" },
  worker: { format: "es" },
});

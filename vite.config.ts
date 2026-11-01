import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import tsconfigPaths from "vite-tsconfig-paths";
import { stringify } from "yaml";
import config from "./src/plugin.config";

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    cssInjectedByJsPlugin(),
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith("cider-"),
        },
      },
    }),
    {
      name: "emit-plugin-manifest",
      buildStart() {
        this.emitFile({
          fileName: "plugin.yml",
          type: "asset",
          source: stringify(config),
        });
      },
    },
  ],
  build: {
    outDir: "dist/",
    lib: {
      entry: "src/main.ts",
      fileName: "plugin",
      formats: ["es"],
    },
    target: ["es2020", "chrome108"],
  },
  server: {
    port: 3058,
    host: "127.0.0.1",
    cors: true,
  },
  define: {
    "process.env": JSON.stringify({ cider: "2" }),
  },
});

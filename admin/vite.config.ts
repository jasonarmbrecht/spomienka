import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import pkg from "./package.json";

const pbUrl = process.env.VITE_PB_URL || "http://localhost:8090";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "~@ibm": path.resolve(__dirname, "node_modules/@ibm"),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        includePaths: ["node_modules"],
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: pbUrl,
        changeOrigin: true,
      },
    },
  },
});


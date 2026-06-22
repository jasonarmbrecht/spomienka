import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const pbUrl = process.env.VITE_PB_URL || "http://localhost:8090";

export default defineConfig({
  plugins: [react()],
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


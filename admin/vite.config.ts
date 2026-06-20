import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pbUrl = process.env.VITE_PB_URL || "http://localhost:8090";

export default defineConfig({
  plugins: [react()],
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


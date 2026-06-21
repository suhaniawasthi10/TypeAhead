import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy API calls to the Express backend (port 3001) so the browser can call
// "/suggest" and "/search" with no CORS setup — Vite forwards them in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/suggest": "http://localhost:3001",
      "/search": "http://localhost:3001",
      "/trending": "http://localhost:3001",
    },
  },
});

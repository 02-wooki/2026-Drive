import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발: vite(5173)가 /api, /auth 를 로컬 gateway 로 넘긴다. 쿠키·Origin 이 같은 출처로 보이도록 changeOrigin 은 끈다.
const gateway = process.env.GATEWAY_DEV_URL ?? 'http://127.0.0.1:7400';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: gateway, changeOrigin: false },
      '/auth': { target: gateway, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});

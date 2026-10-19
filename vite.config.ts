import { defineConfig } from 'vite';

// 클라이언트는 client/ 폴더에서 빌드되어 dist/public 으로 나가고, 서버가 그 파일을 그대로 제공한다.
// 개발 중(npm run dev)에는 Vite 개발 서버가 Socket.IO 요청을 게임 서버(3000번)로 넘긴다.
export default defineConfig({
  root: 'client',
  build: { outDir: '../dist/public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      '/health': 'http://localhost:3000',
    },
  },
});

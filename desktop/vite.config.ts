/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// v0.7.2：把 tauri.conf.json 的版本号注入前端（__APP_VERSION__），供应用内更新比较
const appVersion = JSON.parse(readFileSync('./src-tauri/tauri.conf.json', 'utf-8')).version as string;

// Web 版构建（vite build --mode web）用 /app/ 子路径，供服务端 go:embed 托管；
// 桌面端 Tauri 构建（默认 mode）保持 /。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'web' ? '/app/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
  },
  // 本机内存有限（ulimit -v 2GB 会弄崩 Node 内置 fetch 的 wasm），测试用单 fork
  test: {
    pool: 'forks',
    maxWorkers: 1,
  },
}));


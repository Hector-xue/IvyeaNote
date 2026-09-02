/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// v0.7.2：把 tauri.conf.json 的版本号注入前端（__APP_VERSION__），供应用内更新比较
const appVersion = JSON.parse(readFileSync('./src-tauri/tauri.conf.json', 'utf-8')).version as string;

/*
 * v0.10.3：**内置默认同步服务器**。
 *
 * 此前登录页第一栏就是空的「服务器地址」，而部署引导还在教你装 Docker——
 * 于是"开启同步"这件事，第一步就是"先去搭一台服务器"。官方发行版没有理由
 * 让人做这一步：地址烧进包里，登录页只剩邮箱和密码，自建的人在「高级」里改。
 *
 * 用环境变量覆盖（`VITE_DEFAULT_SERVER=... npm run build`），
 * 传空串就是"没有默认服务器"，退回手填。
 */
const defaultServer = (process.env.VITE_DEFAULT_SERVER ?? 'https://note.ivyea.com').trim();

// Web 版构建（vite build --mode web）用 /app/ 子路径，供服务端 go:embed 托管；
// 桌面端 Tauri 构建（默认 mode）保持 /。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'web' ? '/app/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __DEFAULT_SERVER__: JSON.stringify(defaultServer),
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


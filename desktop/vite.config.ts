/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// v0.7.2：把 tauri.conf.json 的版本号注入前端（__APP_VERSION__），供应用内更新比较
const appVersion = JSON.parse(readFileSync('./src-tauri/tauri.conf.json', 'utf-8')).version as string;

/*
 * 默认同步服务器。
 *
 * **仓库里永远是空的，绝不能写死任何域名。**
 * v0.10.3 一度把作者自己的 note.ivyea.com 当成了所有构建的默认值——这是个错误：
 * 这是开源项目，公开 Release 的安装包谁都能下，于是每个用户的登录页底下都挂着
 * 别人的私有服务器地址。自托管软件不该有"官方服务器"。
 *
 * 需要预置地址的私有构建自己传 `VITE_DEFAULT_SERVER=... npm run build`。
 * 而由同步服务端托管的网页版（`--mode web`，挂在 /app/）不需要任何预置：
 * 页面就是那台服务器发出来的，直接用当前来源即可（见 lib/serverConn.ts）。
 */
const defaultServer = (process.env.VITE_DEFAULT_SERVER ?? '').trim();

// Web 版构建（vite build --mode web）用 /app/ 子路径，供服务端 go:embed 托管；
// 桌面端 Tauri 构建（默认 mode）保持 /。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'web' ? '/app/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __DEFAULT_SERVER__: JSON.stringify(defaultServer),
    // web 版＝由同步服务端自己托管的那份，可以拿页面来源当服务器地址
    __WEB_BUILD__: JSON.stringify(mode === 'web'),
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


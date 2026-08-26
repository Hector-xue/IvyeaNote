// 让 TypeScript 接受 CSS 副作用导入（vite 客户端类型）
/// <reference types="vite/client" />

// v0.7.2：应用内更新 —— 构建时由 vite.config.ts define 注入当前版本号
declare const __APP_VERSION__: string;

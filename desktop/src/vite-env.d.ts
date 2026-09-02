// 让 TypeScript 接受 CSS 副作用导入（vite 客户端类型）
/// <reference types="vite/client" />

// v0.7.2：应用内更新 —— 构建时由 vite.config.ts define 注入当前版本号
declare const __APP_VERSION__: string;
/** 构建期预置的同步服务器地址。**仓库默认为空**，只有私有构建才会传 VITE_DEFAULT_SERVER */
declare const __DEFAULT_SERVER__: string;
/** 是否 `--mode web` 构建（由同步服务端托管的网页版） */
declare const __WEB_BUILD__: boolean;

/// <reference types="vite/client" />

// Vite 的资源导入（CSS、图片等）类型由 vite/client 提供。
// 单独成文件而非塞进 tsconfig 的 types 数组，是为了让 `tsc --noEmit` 与
// 编辑器都能拿到同一份声明。
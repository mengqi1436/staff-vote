import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 显式监听所有地址（含局域网）。
    //
    // 起因：Vite 默认 host 是 'localhost'，在 Windows 上解析为 IPv6 的 ::1，
    // 于是 http://127.0.0.1:5173 会被拒绝连接（只有 http://localhost:5173 能通），
    // 这是个很难联想到配置的坑。显式 host: true 后两种写法都可用，
    // 同时手机连同一局域网也能打开投票入口验证移动端布局。
    host: true,
    port: 5173,
    strictPort: true,
    // 开发期把 /api 代理到后端，避免跨域；生产环境由 Nginx 反代同一路径。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    /**
     * 用例超时放宽到 15 秒（默认 5 秒）。
     *
     * 原因：antd 的 Table / Modal / Tabs 在 jsdom 里单次渲染就要 1-3 秒，
     * 文件级并行时机器一忙，默认 5 秒会让「单跑绿、整套红」的抖动频繁出现 ——
     * 那是环境噪声而不是断言失败，会严重干扰对真实回归的判断。
     * 挂住的用例仍会在 15 秒后失败，不会把死锁掩盖成通过。
     */
    testTimeout: 15_000,
  },
});
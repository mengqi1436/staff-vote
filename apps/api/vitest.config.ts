import { defineConfig } from 'vitest/config';

/**
 * 后端测试配置。
 *
 * **关闭文件级并行**：三个接口测试文件（vote / admin / e2e）共用
 * `TEST_DATABASE_URL` 指向的同一个测试库，并行执行会互相清数据 ——
 * 症状是「单独跑都过、一起跑就挂」，这类偶发失败最难排查。
 * 串行的代价是整套测试慢十几秒，换来结果稳定可复现，值得。
 *
 * 若将来测试量增长到串行不可接受，正确做法是给每个文件分配独立测试库
 * 并各自推导库名，而不是把并行打开。
 *
 * 超时放宽到 30 秒：测试库可能在远程实例上，且口令哈希用的 scrypt 本身是慢哈希。
 */
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
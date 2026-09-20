import { createApp } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[api] 已启动：http://127.0.0.1:${env.PORT}（${env.NODE_ENV}，TZ=${env.TZ}）`);
});

/**
 * 优雅退出：先停止接收新连接，再断开数据库。
 * 直接 kill 会让正在提交的打分事务被中途掐断。
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[api] 收到 ${signal}，开始关闭…`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
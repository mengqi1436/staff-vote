import express from 'express';
import helmet from 'helmet';
import { apiLimiter } from './lib/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { adminRouter } from './routes/admin/index.js';
import { voteRouter } from './routes/vote.js';

/**
 * 组装 Express 应用。
 *
 * 与启动分离：测试可以拿到 app 实例交给 supertest 直接打请求，
 * 不必真的监听端口，也就不会出现端口占用导致的测试互斥。
 */
export function createApp(): express.Express {
  const app = express();

  // Nginx 反向代理后，真实客户端 IP 在 X-Forwarded-For 里。
  // 不设置 trust proxy，express-rate-limit 会把所有请求当成来自 127.0.0.1。
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(apiLimiter);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.use('/api/vote', voteRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
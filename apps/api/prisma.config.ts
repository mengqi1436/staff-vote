import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 起，迁移与内省所需的项目配置从 `schema.prisma` 迁到本文件：
 * `datasource.url` 不再写在 schema 里（v7 发布说明明确此项已迁移）。
 *
 * 只用于 CLI（migrate / db pull / studio）。运行时的数据库连接由
 * `src/db.ts` 通过 driver adapter（@prisma/adapter-pg）建立。
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
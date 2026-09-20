import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { env } from './env.js';

/**
 * 决定应用连接哪个库。
 *
 * 集成测试优先使用 `TEST_DATABASE_URL`，避免测试数据写进开发库；
 * 该分支只在 `NODE_ENV=test` 时生效，因此生产环境即使误配了
 * TEST_DATABASE_URL 也不会切走。
 */
export function resolveConnectionString(): string {
  if (env.NODE_ENV === 'test' && env.TEST_DATABASE_URL) {
    return env.TEST_DATABASE_URL;
  }
  return env.DATABASE_URL;
}

/**
 * 数据库连接。
 *
 * Prisma 7 起必须显式传入 driver adapter（不再有零配置的引擎连接），
 * 这里用 @prisma/adapter-pg 包住 node-postgres。
 *
 * @param connectionString 目标库连接串，默认按 `resolveConnectionString()` 决定。
 *   集成测试会通过 `NODE_ENV=test` + `TEST_DATABASE_URL` 指向独立的测试库。
 * @returns 独立的 PrismaClient 实例
 */
export function createPrismaClient(connectionString: string = resolveConnectionString()): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

/** 应用共享的 Prisma 客户端。 */
export const prisma = createPrismaClient();
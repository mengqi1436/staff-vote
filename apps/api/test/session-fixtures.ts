import type { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * 场次测试夹具。
 *
 * 业务表新增 session_id 后，直接写库造夹具的测试文件都需要一个场次。
 * 各文件的清理策略（保持"跑完自己后库里只剩默认场次"，与同库其他文件并存）：
 *   - 只用默认场次的文件：beforeAll 调 ensureDefaultSession 兜底即可，无需清理；
 *   - 自建场次的文件：afterAll 按自己的 id 删除。
 */

/** 迁移 0005 写入的默认场次 ID（与 services/admin.ts 的常量一致）。 */
export const DEFAULT_SESSION_ID = '00000000-0000-7000-8000-000000000001';

/**
 * 确保默认场次存在（迁移建的那行被前序测试清掉时补建），返回其 ID。
 */
export async function ensureDefaultSession(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.voteSession.findUnique({ where: { id: DEFAULT_SESSION_ID } });
  if (existing) return existing.id;
  // uuid 由应用生成的约定下，这里显式给固定字面量，保持与迁移写入的一致。
  await prisma.voteSession.create({ data: { id: DEFAULT_SESSION_ID, name: '默认场次' } });
  return DEFAULT_SESSION_ID;
}

/**
 * 建一个测试场次（直接写库，绕开接口与状态机；状态机本身由 sessions.test.ts 验证）。
 * @param status 直接指定状态，voting 便于投票链路夹具直接可用
 */
export async function createTestSession(
  prisma: PrismaClient,
  name: string,
  status: 'draft' | 'voting' | 'paused' | 'ended' = 'draft',
): Promise<string> {
  const session = await prisma.voteSession.create({ data: { name, status } });
  return session.id;
}

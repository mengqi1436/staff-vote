import 'dotenv/config';
import { z } from 'zod';

/**
 * 环境变量校验。缺失或格式错误时【立即失败并退出】，不做静默兜底：
 * 一个连不上的数据库或一个弱密钥，如果等到第一个请求才暴露，
 * 排查成本远高于启动时报错。
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(15667),
  TZ: z.string().default('Asia/Shanghai'),

  /** 应用库连接串。生产环境由部署人员填写。 */
  DATABASE_URL: z.string().min(1),

  /** 集成测试库连接串；仅开发/测试环境需要。 */
  TEST_DATABASE_URL: z.string().optional(),

  /** 登录状态令牌签名密钥。短于此长度的密钥可被暴力还原。 */
  JWT_SECRET: z.string().min(32),

  /** 预留：pgcrypto 加密敏感字段时使用的对称密钥。本期可不配置。 */
  SENSITIVE_FIELD_KEY: z.string().min(16).optional(),

  /** 首次 seed 时写入的初始管理员。 */
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(8).optional(),

  /**
   * 人员目录同步令牌。外部系统在 `X-Sync-Token` 头里带它调用
   * `POST /api/admin/staff-directory/sync`。
   * 未配置 = 同步端点关闭（503）：默认不开放一条无鉴权的写入口。
   */
  STAFF_SYNC_TOKEN: z.string().min(16).optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] 环境变量校验失败，进程退出：');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

/** 是否为生产环境。生产下会收紧 Cookie 的 Secure 标志等行为。 */
export const isProduction = env.NODE_ENV === 'production';
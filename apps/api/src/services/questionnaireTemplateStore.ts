import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * 场次问卷模板（session_questionnaire_templates）的原生 SQL 读写层。
 *
 * 背景：Prisma 7.10 queryCompiler 对该模型的 API 调用（findUnique/create/upsert/
 * findMany 全部）会编译出引用不存在列的坏 SQL，报 P2022 "The column `(not available)`
 * does not exist"；同表原生 SQL 一切正常。已实测排除复合主键形态、字段名、中文默认值、
 * 模型定义位置等因素，根因未定位（生成器/编译器 bug）。因此该表读写一律走本模块，
 * 不要使用 prisma.sessionQuestionnaireTemplate。
 */

/** 行的 camelCase 形态（与旧 Prisma 模型字段同名，调用方无感迁移）。 */
export interface QuestionnaireTemplateRow {
  sessionId: string;
  type: string;
  headerNote: string;
  title: string;
  footerNote: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RawRow {
  session_id: string;
  type: string;
  header_note: string;
  title: string;
  footer_note: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(r: RawRow): QuestionnaireTemplateRow {
  return {
    sessionId: r.session_id,
    type: r.type,
    headerNote: r.header_note,
    title: r.title,
    footerNote: r.footer_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLUMNS = Prisma.sql`"session_id", "type", "header_note", "title", "footer_note", "created_at", "updated_at"`;

/** 读一套模板；行不存在返回 null（调用方退回默认文案）。 */
export async function findTemplate(
  prisma: PrismaClient,
  sessionId: string,
  type: string,
): Promise<QuestionnaireTemplateRow | null> {
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT ${COLUMNS}
    FROM "session_questionnaire_templates"
    WHERE "session_id" = ${sessionId} AND "type" = ${type}
    LIMIT 1`;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * 改一套模板（PATCH 语义：patch 里缺省的键保持现值；行不存在则用列默认值兜底）。
 * 返回落库后的完整行。
 */
export async function upsertTemplate(
  prisma: PrismaClient,
  sessionId: string,
  type: string,
  patch: { headerNote?: string; title?: string; footerNote?: string },
): Promise<QuestionnaireTemplateRow> {
  const existing = await findTemplate(prisma, sessionId, type);
  const headerNote = patch.headerNote ?? existing?.headerNote ?? '附件1-1';
  const title = patch.title ?? existing?.title ?? '';
  const footerNote = patch.footerNote ?? existing?.footerNote ?? '';
  const rows = await prisma.$queryRaw<RawRow[]>`
    INSERT INTO "session_questionnaire_templates"
      ("id", "session_id", "type", "header_note", "title", "footer_note", "created_at", "updated_at")
    VALUES (gen_random_uuid()::text, ${sessionId}, ${type}, ${headerNote}, ${title}, ${footerNote}, now(), now())
    ON CONFLICT ("session_id", "type") DO UPDATE
      SET "header_note" = EXCLUDED."header_note",
          "title" = EXCLUDED."title",
          "footer_note" = EXCLUDED."footer_note",
          "updated_at" = now()
    RETURNING ${COLUMNS}`;
  // INSERT ... ON CONFLICT ... RETURNING 必然返回恰好一行
  return mapRow(rows[0]!);
}

/** 测试/向导夹具用：直接插入一套模板（值全量给定，缺省用列默认）。 */
export async function createTemplate(
  prisma: PrismaClient,
  data: { sessionId: string; type: string; headerNote?: string; title?: string; footerNote?: string },
): Promise<QuestionnaireTemplateRow> {
  const rows = await prisma.$queryRaw<RawRow[]>`
    INSERT INTO "session_questionnaire_templates"
      ("id", "session_id", "type", "header_note", "title", "footer_note", "created_at", "updated_at")
    VALUES (gen_random_uuid()::text, ${data.sessionId}, ${data.type}, ${data.headerNote ?? '附件1-1'}, ${data.title ?? ''}, ${data.footerNote ?? ''}, now(), now())
    RETURNING ${COLUMNS}`;
  return mapRow(rows[0]!);
}

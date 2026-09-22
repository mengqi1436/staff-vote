/**
 * 职工管理：CRUD 与名单导入。
 *
 * 删除为软删除：已提交的评分项仍指向该职工，物理删除会让历史报表掉行。
 *
 * 导入是 multipart 上传。`ponytail:` 这里手写了一个只支持「单个文件字段」的
 * 极简 multipart 解析 —— 本接口只收一份名单，为一个字段引入 multer/busboy 不划算。
 * 将来若要支持多文件、断点续传或超大文件，换官方中间件实现流式解析。
 *
 * 写操作（含 import）逐个挂 `requirePermission`（不是 router.use 整段挂）：
 * 读操作不设权限，没有 employees.write 的角色天然只读，GET 必须照常放行。
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createEmployee,
  disableEmployee,
  importEmployees,
  listEmployees,
  resolveSessionId,
  updateEmployee,
} from '../../services/admin.js';
import { parseRosterFile } from '../../lib/xlsx.js';
import { ApiError } from '../../middleware/errorHandler.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

/** 上传体积上限。名单是文本级数据，5 MB 已能装下十万行。 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ListQuerySchema = z.object({
  departmentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const CreateSchema = z.object({
  departmentId: z.string().min(1, '必须指定部门'),
  sessionId: z.string().min(1).optional(),
  name: z.string().trim().min(1, '姓名不能为空').max(50),
  employeeNo: z.string().trim().max(50).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const PatchSchema = z.object({
  departmentId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(50).optional(),
  employeeNo: z.string().trim().max(50).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

/** 读出请求体原始字节。express.json 只处理 application/json，multipart 得自己收。 */
async function readRawBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '文件超过 5 MB 上限');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 取 multipart 的 boundary；不是 multipart 请求就直接给出可读的 400。 */
function boundaryOf(req: Request): string {
  const contentType = req.headers['content-type'] ?? '';
  if (!/multipart\/form-data/i.test(contentType)) {
    throw ApiError.badRequest('请以 multipart/form-data 上传文件（字段名 file）');
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  if (!boundary) throw ApiError.badRequest('multipart 请求缺少 boundary');
  return boundary;
}

/**
 * 从 multipart 请求体里取出上传的文件。
 *
 * 按 latin1 解码成字符串来做分片：latin1 与字节一一对应，xlsx（zip）这类二进制
 * 内容能原样往返，不会被 UTF-8 解码破坏；文件名再按 UTF-8 还原。
 * 优先取字段名 `file` 的分片，否则取第一个带文件名的分片。
 */
function extractUpload(
  body: Buffer,
  boundary: string,
): { filename: string; content: Buffer } | null {
  let fallback: { filename: string; content: Buffer } | null = null;

  for (const part of body.toString('latin1').split(`--${boundary}`)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd);
    // 只在 content-disposition 行内匹配 name / filename：其它头部（例如 Content-Type）
    // 的参数里也可能出现 name="..."，在整段 headers 上取第一个匹配会拿到错误的字段名。
    const dispositionLine = /^content-disposition:[^\r\n]*/im.exec(headers)?.[0] ?? '';
    const disposition = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(dispositionLine);
    if (!disposition) continue;

    const fieldName = disposition[1] ?? '';
    const rawFilename = disposition[2];
    if (fieldName !== 'file' && !rawFilename) continue;

    let content = part.slice(headerEnd + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);

    const upload = {
      filename: rawFilename
        ? Buffer.from(rawFilename, 'latin1').toString('utf8')
        : 'upload.csv',
      content: Buffer.from(content, 'latin1'),
    };
    if (fieldName === 'file') return upload;
    fallback ??= upload;
  }

  return fallback;
}

export const employeesRouter: Router = Router();

employeesRouter.get('/', async (req, res) => {
  const { departmentId, sessionId } = ListQuerySchema.parse(req.query);
  res.json(await listEmployees(departmentId, await resolveSessionId(sessionId)));
});

/** 导入名单（xlsx / csv，列：部门,姓名,工号）。 */
employeesRouter.post('/import', requirePermission('employees.write'), async (req, res) => {
  const sessionId =
    typeof req.query.sessionId === 'string' && req.query.sessionId.trim() !== ''
      ? req.query.sessionId.trim()
      : undefined;
  const boundary = boundaryOf(req);
  const upload = extractUpload(await readRawBody(req), boundary);
  if (!upload) throw ApiError.badRequest('未找到上传文件，请用字段名 file 提交 xlsx 或 csv');

  const roster = await parseRosterFile(upload.content, upload.filename);
  if (roster.length === 0) throw ApiError.badRequest('文件里没有可导入的行');

  res.json(await importEmployees(roster, operatorOf(req), sessionId));
});

employeesRouter.post('/', requirePermission('employees.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  res.json(await createEmployee(body, operatorOf(req)));
});

employeesRouter.patch('/:id', requirePermission('employees.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = PatchSchema.parse(req.body);
  res.json(await updateEmployee(id, body, operatorOf(req)));
});

employeesRouter.delete('/:id', requirePermission('employees.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await disableEmployee(id, operatorOf(req));
  res.status(204).end();
});
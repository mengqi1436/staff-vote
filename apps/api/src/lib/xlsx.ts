/**
 * Excel 导入导出。
 *
 * 导出：随机码清单、结果报表（多 sheet）。
 * 导入：职工名单（xlsx / csv）。
 *
 * 计分口径不在这里实现 —— 结果报表的数据由 `services/results.ts` 调
 * `lib/scoring.ts` 的 computeResults 算好后传进来，避免出现第二份计分逻辑。
 */
import ExcelJS from 'exceljs';
import type { CellValue, Workbook, Worksheet } from 'exceljs';
import type { Response } from 'express';
import { ApiError } from '../middleware/errorHandler.js';

/** xlsx 的官方 MIME 类型。 */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 导入行数上限。名单是人工维护的，上千行已属异常，超过多半是传错了文件。 */
const MAX_IMPORT_ROWS = 5000;

/**
 * 把单元格转成可读文本。
 * 富文本、公式、超链接单元格在 xlsx 里不是字符串，直接 String() 会得到 `[object Object]`。
 */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();

  const object = value as {
    richText?: Array<{ text?: string }>;
    text?: unknown;
    result?: unknown;
  };
  if (Array.isArray(object.richText)) {
    return object.richText.map((part) => part.text ?? '').join('').trim();
  }
  if (typeof object.text === 'string') return object.text.trim();
  if (object.result !== undefined) return cellText(object.result as CellValue);
  return '';
}

/** 按服务器时区（TZ=Asia/Shanghai）格式化为 Excel 里的可读时间。 */
function formatDateTime(value: Date | null): string {
  if (!value) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  );
}

/** 往工作表里写入「信息行 + 空行 + 表头 + 数据行」的通用版式。 */
function fillSheet(
  sheet: Worksheet,
  info: Array<[string, string]>,
  columns: Array<{ header: string; key: string; width: number }>,
  rows: Array<Record<string, string | number>>,
): void {
  for (const [label, value] of info) {
    sheet.addRow([label, value]);
  }
  if (info.length > 0) sheet.addRow([]);

  const headerRow = sheet.addRow(columns.map((column) => column.header));
  headerRow.font = { bold: true };
  for (const [index, column] of columns.entries()) {
    sheet.getColumn(index + 1).width = column.width;
  }
  for (const row of rows) {
    sheet.addRow(columns.map((column) => row[column.key] ?? ''));
  }
}

// -----------------------------------------------------------------------------
// 导出
// -----------------------------------------------------------------------------

/** 随机码清单的一行（列口径见设计文档第 12.2 节）。 */
export interface TicketExportRow {
  code: string;
  ticketType: string;
  status: string;
  usedAt: Date | null;
  batchId: string;
  createdAt: Date;
}

/**
 * 生成随机码清单工作簿。
 * @param rows 已按查询条件筛选过的随机码
 * @returns 只含单个 sheet 的工作簿
 */
export function buildTicketsWorkbook(rows: TicketExportRow[]): Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '职工素质投票系统';
  const sheet = workbook.addWorksheet('随机码清单');
  fillSheet(
    sheet,
    [],
    [
      { header: '随机码', key: 'code', width: 14 },
      { header: '票种', key: 'ticketType', width: 22 },
      { header: '状态', key: 'status', width: 10 },
      { header: '核销时间', key: 'usedAt', width: 22 },
      { header: '批次', key: 'batchId', width: 40 },
      { header: '创建时间', key: 'createdAt', width: 22 },
    ],
    rows.map((row) => ({
      code: row.code,
      ticketType: row.ticketType,
      status: row.status,
      usedAt: formatDateTime(row.usedAt),
      batchId: row.batchId,
      createdAt: formatDateTime(row.createdAt),
    })),
  );
  return workbook;
}

/** 结果报表的数据（result 服务已用 computeResults 算好）。 */
export interface ResultsExportInput {
  departmentName: string;
  generatedAt: Date;
  /** 综合排名 */
  rows: Array<{
    rank: number;
    voteColumnName: string;
    comprehensiveScore: number;
    criterionCount: number;
  }>;
  /** 各项明细：每行一个「被评列 × 项点」 */
  details: Array<{
    voteColumnName: string;
    criterionName: string;
    rawScore: number;
    normalizedScore: number;
    ticketTypes: string[];
  }>;
  /** 参与票种口径：含未参与计分的票种，便于解释口径 */
  ticketTypes: Array<{ code: string; name: string; weightPercent: number; involved: boolean }>;
}

/**
 * 生成结果报表工作簿：综合排名 / 各项明细 / 参与票种口径。
 * @param input 排名、明细与口径数据
 * @returns 三个 sheet 的工作簿
 */
export function buildResultsWorkbook(input: ResultsExportInput): Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '职工素质投票系统';
  const info: Array<[string, string]> = [
    ['部门', input.departmentName],
    ['生成时间', formatDateTime(input.generatedAt)],
  ];

  fillSheet(
    workbook.addWorksheet('综合排名'),
    info,
    [
      { header: '排名', key: 'rank', width: 8 },
      { header: '被评对象', key: 'voteColumnName', width: 20 },
      { header: '综合得分', key: 'comprehensiveScore', width: 12 },
      { header: '计分项点数', key: 'criterionCount', width: 12 },
    ],
    input.rows.map((row) => ({
      rank: row.rank,
      voteColumnName: row.voteColumnName,
      comprehensiveScore: row.comprehensiveScore,
      criterionCount: row.criterionCount,
    })),
  );

  fillSheet(
    workbook.addWorksheet('各项明细'),
    [],
    [
      { header: '被评对象', key: 'voteColumnName', width: 20 },
      { header: '项点', key: 'criterionName', width: 24 },
      { header: '原始分', key: 'rawScore', width: 12 },
      { header: '归一化分', key: 'normalizedScore', width: 12 },
      { header: '参与票种', key: 'ticketTypes', width: 24 },
    ],
    input.details.map((row) => ({
      voteColumnName: row.voteColumnName,
      criterionName: row.criterionName,
      rawScore: row.rawScore,
      normalizedScore: row.normalizedScore,
      ticketTypes: row.ticketTypes.join('/'),
    })),
  );

  fillSheet(
    workbook.addWorksheet('参与票种口径'),
    info,
    [
      { header: '票种', key: 'code', width: 10 },
      { header: '名称', key: 'name', width: 24 },
      { header: '权重百分比', key: 'weightPercent', width: 14 },
      { header: '是否参与计分', key: 'involved', width: 16 },
    ],
    input.ticketTypes.map((row) => ({
      code: row.code,
      name: row.name,
      weightPercent: row.weightPercent,
      involved: row.involved ? '是' : '否',
    })),
  );

  return workbook;
}

/**
 * 把工作簿写成 Buffer。
 * @param workbook exceljs 工作簿
 */
export async function workbookToBuffer(workbook: Workbook): Promise<Buffer> {
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

/**
 * 导出文件名里的日期戳（YYYYMMDD）。
 * 同一份清单被反复导出时，文件名不要互相覆盖，方便按批次留档。
 */
export function fileStamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * 以附件形式下发 xlsx。
 *
 * 文件名含中文，因此除了 ASCII 回退名，还写 `filename*=UTF-8''` 形式，
 * 否则部分浏览器会把中文名存成乱码。
 */
export function sendWorkbook(res: Response, filename: string, buffer: Buffer): void {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.send(buffer);
}

// -----------------------------------------------------------------------------
// 导入
// -----------------------------------------------------------------------------

/** 名单里的原始一行。校验与去留由服务层决定，这里只负责把文件读成行。 */
export interface RosterRow {
  /** 文件中的行号（从 1 起，含表头），用于把错误指回具体行 */
  rowNumber: number;
  departmentName: string;
  name: string;
  employeeNo: string | null;
}

/** 表头行识别：首列为「部门」或英文 department 时视为表头。 */
function isHeaderRow(cells: string[]): boolean {
  const first = (cells[0] ?? '').trim();
  return /^部门$|^department$/i.test(first);
}

/**
 * 解码 CSV 文本。
 *
 * Excel 导出的中文 CSV 在中文 Windows 上默认是 GBK，按 UTF-8 硬解会得到乱码姓名。
 * 因此先按 UTF-8 解码，出现替换字符（U+FFFD）时再回退 GBK。
 */
function decodeCsv(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '');
  try {
    return new TextDecoder('gbk').decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    // 运行时没有完整 ICU（TextDecoder 不支持 gbk）时退回 UTF-8 结果，至少不丢行。
    return utf8.replace(/^\uFEFF/, '');
  }
}

/** 极简 CSV 解析：支持双引号包裹与 `""` 转义，够用于「部门,姓名,工号」。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 把二维单元格数组转成名单行，并跳过表头。 */
function toRosterRows(table: string[][]): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const [index, cells] of table.entries()) {
    if (isHeaderRow(cells)) continue;
    const departmentName = (cells[0] ?? '').trim();
    const name = (cells[1] ?? '').trim();
    const employeeNo = (cells[2] ?? '').trim();
    rows.push({
      rowNumber: index + 1,
      departmentName,
      name,
      employeeNo: employeeNo === '' ? null : employeeNo,
    });
  }
  return rows;
}

/**
 * exceljs 的类型声明把 Buffer 声明为 ArrayBuffer 的子类型
 * （`declare interface Buffer extends ArrayBuffer`），与 Node 的 Buffer（Uint8Array 子类）
 * 不是一回事。运行时 exceljs 接受 Node Buffer，这里按字节区间转成 ArrayBuffer 以满足类型。
 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/**
 * 解析职工名单文件。
 *
 * 列约定「部门,姓名,工号(可选)」，首行可以是表头。
 * 全空行由服务层计为「跳过」，本函数原样返回，便于把错误指向真实行号。
 *
 * @param buffer 上传的文件内容
 * @param filename 原始文件名，用于判断 csv 还是 xlsx
 */
export async function parseRosterFile(buffer: Buffer, filename: string): Promise<RosterRow[]> {
  if (buffer.length === 0) throw ApiError.badRequest('上传的文件为空');

  // xlsx 是 zip，头两字节固定为 'PK'；文件名不可信时按内容判断。
  const looksLikeZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const byCsv = /\.csv$/i.test(filename)
    ? true
    : /\.(xlsx|xlsm)$/i.test(filename)
      ? false
      : !looksLikeZip;

  let rows: RosterRow[];
  if (byCsv) {
    rows = toRosterRows(parseCsv(decodeCsv(buffer)));
  } else {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(toArrayBuffer(buffer));
    } catch {
      throw ApiError.badRequest('无法解析该表格文件，请上传 xlsx 或 csv');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw ApiError.badRequest('表格里没有可读的工作表');

    const table: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as CellValue[];
      const cells: string[] = [];
      for (let i = 1; i < values.length; i += 1) cells.push(cellText(values[i] ?? null));
      table.push(cells);
    });
    rows = toRosterRows(table);
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    throw ApiError.badRequest(`单次最多导入 ${MAX_IMPORT_ROWS} 行，当前 ${rows.length} 行`);
  }
  return rows;
}
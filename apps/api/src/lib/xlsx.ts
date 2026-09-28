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
  rows: Array<Record<string, string | number | null>>,
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

/** 职工名单导出的一行（列序与导入模板一致，导出件可直接再导入）。 */
// 用类型别名而非 interface：fillSheet 的 rows 参数是 Record<string, ...>，
// 只有别名（带隐式索引签名）能直接赋值，免去调用处逐字段 map。
export type RosterExportRow = {
  departmentName: string;
  name: string;
  gender: string | null;
  age: number | null;
  title: string | null;
};

/** 生成职工名单工作簿。 */
export function buildRosterWorkbook(rows: RosterExportRow[]): Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '职工素质评议系统';
  const sheet = workbook.addWorksheet('职工名单');
  fillSheet(
    sheet,
    [],
    [
      { header: '部门', key: 'departmentName', width: 22 },
      { header: '姓名', key: 'name', width: 14 },
      { header: '性别', key: 'gender', width: 8 },
      { header: '年龄', key: 'age', width: 8 },
      { header: '职称', key: 'title', width: 18 },
    ],
    rows,
  );
  return workbook;
}

/** 随机码清单的一行（发放对账材料；只含未使用的码，无状态/核销时间列 —— 匿名边界）。 */
export interface TicketExportRow {
  code: string;
  ticketType: string;
  batchId: string;
  createdAt: Date;
}

/**
 * 生成随机码清单工作簿。
 * @param rows 已按查询条件筛选过的随机码（服务层保证只含未使用的码）
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
      { header: '批次', key: 'batchId', width: 40 },
      { header: '创建时间', key: 'createdAt', width: 22 },
    ],
    rows.map((row) => ({
      code: row.code,
      ticketType: row.ticketType,
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
  /**
   * 票别口径（计分四口径中的「票别×被评列×项点」与「票别×被评列」）。
   * 行已按票种展开，名称由 results 服务填好，这里只负责排版。
   */
  perTicketType: {
    /** 票别单项明细：每行一个「票种 × 被评对象 × 项点」 */
    criteriaRows: Array<{
      ticketTypeCode: string;
      voteColumnName: string;
      criterionName: string;
      avg: number;
    }>;
    /** 票别合计明细：每行一个「票种 × 被评对象」 */
    columnRows: Array<{ ticketTypeCode: string; voteColumnName: string; average: number }>;
  };
}

/**
 * sheet 名组装：附加部门后缀并保证不超 Excel 的 31 字符上限。
 * 部门名超长时截断后缀（各 sheet 前缀不同，仍互不冲突）。
 */
function sheetName(base: string, suffix = ''): string {
  const full = suffix ? `${base}${suffix}` : base;
  return full.length > 31 ? full.slice(0, 31) : full;
}

/**
 * 把结果报表的五个 sheet（综合排名 / 各项明细 / 参与票种口径 / 票别单项 / 票别合计）
 * 写进指定工作簿。buildResultsWorkbook 与整场导出（每个启用部门一组）共用。
 * @param suffix sheet 名后缀（如 `-技术部`）；空串 = 单部门导出的原始名
 */
function fillResultsSheets(workbook: Workbook, input: ResultsExportInput, suffix = ''): void {
  const info: Array<[string, string]> = [
    ['部门', input.departmentName],
    ['生成时间', formatDateTime(input.generatedAt)],
  ];

  fillSheet(
    workbook.addWorksheet(sheetName('综合排名', suffix)),
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
    workbook.addWorksheet(sheetName('各项明细', suffix)),
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
    workbook.addWorksheet(sheetName('参与票种口径', suffix)),
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

  // 票别口径的两个明细 sheet：评分内容仍匿名，这里只到票别 × 被评对象粒度。
  fillSheet(
    workbook.addWorksheet(sheetName('票别单项明细', suffix)),
    [],
    [
      { header: '票种', key: 'ticketTypeCode', width: 10 },
      { header: '被评对象', key: 'voteColumnName', width: 20 },
      { header: '项点', key: 'criterionName', width: 24 },
      { header: '平均分', key: 'avg', width: 12 },
    ],
    input.perTicketType.criteriaRows.map((row) => ({
      ticketTypeCode: row.ticketTypeCode,
      voteColumnName: row.voteColumnName,
      criterionName: row.criterionName,
      avg: row.avg,
    })),
  );

  fillSheet(
    workbook.addWorksheet(sheetName('票别合计明细', suffix)),
    [],
    [
      { header: '票种', key: 'ticketTypeCode', width: 10 },
      { header: '被评对象', key: 'voteColumnName', width: 20 },
      { header: '平均分', key: 'average', width: 12 },
    ],
    input.perTicketType.columnRows.map((row) => ({
      ticketTypeCode: row.ticketTypeCode,
      voteColumnName: row.voteColumnName,
      average: row.average,
    })),
  );
}

/**
 * 生成结果报表工作簿：综合排名 / 各项明细 / 参与票种口径。
 * @param input 排名、明细与口径数据
 * @returns 三个 sheet 的工作簿
 */
export function buildResultsWorkbook(input: ResultsExportInput): Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '职工素质投票系统';
  fillResultsSheets(workbook, input);
  return workbook;
}

// -----------------------------------------------------------------------------
// 按随机码导出答卷（附件8 形态）
// -----------------------------------------------------------------------------

/** 单码答卷导出的数据（services/results.ts 的 loadTicketAnswerExport 组装）。 */
export interface AnswerSheetExportInput {
  headerNote: string;
  /** 表标题（「xx」已替换为部门名） */
  title: string;
  footerNote: string;
  /** 被评列名，按 sortOrder 排列 */
  columnNames: string[];
  /** 每行 = [项点名(含描述), ...各被评列分数] */
  rows: Array<Array<string | number>>;
  submittedAt: Date;
  /** 票别标签：如「A（领导评议）」 */
  ticketTypeLabel: string;
}

/**
 * 生成单码答卷工作簿，复刻附件8 的纸质形态：
 * 抬头（附件号 + 标题）→ 表体（行 = 项点，列 = 被评列，格 = 分数）→
 * 表尾填写说明（合并整行）→ 提交时间与票别。
 */
export function buildAnswerSheetWorkbook(input: AnswerSheetExportInput): Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '职工素质投票系统';
  const sheet = workbook.addWorksheet('答卷');

  if (input.headerNote) sheet.addRow([input.headerNote]);
  if (input.title) {
    const titleRow = sheet.addRow([input.title]);
    titleRow.font = { bold: true, size: 14 };
  }
  sheet.addRow([]);

  const header = sheet.addRow(['项点', ...input.columnNames]);
  header.font = { bold: true };
  header.alignment = { horizontal: 'center', vertical: 'middle' };
  // 项点列放名称 + 描述，换行显示；分数列窄列居右由 Excel 默认数字对齐兜底。
  sheet.getColumn(1).width = 42;
  sheet.getColumn(1).alignment = { wrapText: true, vertical: 'top' };
  for (let i = 2; i <= input.columnNames.length + 1; i += 1) {
    sheet.getColumn(i).width = 12;
  }

  for (const row of input.rows) {
    sheet.addRow(row);
  }

  if (input.footerNote) {
    const lastColumn = input.columnNames.length + 1;
    const noteRow = sheet.addRow([input.footerNote]);
    if (lastColumn > 1) sheet.mergeCells(noteRow.number, 1, noteRow.number, lastColumn);
    noteRow.alignment = { wrapText: true, vertical: 'top' };
  }

  sheet.addRow([]);
  sheet.addRow(['提交时间', formatDateTime(input.submittedAt)]);
  sheet.addRow(['票别', input.ticketTypeLabel]);

  return workbook;
}

// -----------------------------------------------------------------------------
// 整场整合导出
// -----------------------------------------------------------------------------

/** 整场导出中一个启用部门的结果组（sheet 名加部门后缀区分）。 */
export interface SessionExportPart {
  label: string;
  input: ResultsExportInput;
}

/** 整场导出末尾「答卷汇总」sheet 的数据（services/results.ts 组装）。 */
export interface AnswerSummaryInput {
  columns: Array<{ header: string }>;
  rows: Array<{
    seq: number;
    code: string;
    submittedAt: Date;
    ticketTypeCode: string;
    scores: Array<number | string>;
  }>;
}

/**
 * 生成整场整合工作簿：每个启用部门一组的统分与排名 sheets（多部门时 sheet 名
 * 带部门后缀，单部门保持原始名），末尾追加「答卷汇总」——按随机码定位答卷的
 * 审计视图（无映射的历史答卷 code 留空）。
 */
export function buildSessionWorkbook(
  parts: SessionExportPart[],
  summary: AnswerSummaryInput,
): Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '职工素质投票系统';
  for (const part of parts) {
    fillResultsSheets(workbook, part.input, parts.length > 1 ? `-${part.label}` : '');
  }

  fillSheet(
    workbook.addWorksheet('答卷汇总'),
    [],
    [
      { header: '序号', key: 'seq', width: 6 },
      { header: '随机码', key: 'code', width: 14 },
      { header: '提交时间', key: 'submittedAt', width: 22 },
      { header: '票别', key: 'ticketTypeCode', width: 10 },
      ...summary.columns.map((column, index) => ({
        header: column.header,
        key: `score${index}`,
        width: 12,
      })),
    ],
    summary.rows.map((row) => ({
      seq: row.seq,
      code: row.code,
      submittedAt: formatDateTime(row.submittedAt),
      ticketTypeCode: row.ticketTypeCode,
      ...Object.fromEntries(row.scores.map((value, index) => [`score${index}`, value])),
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
  gender: string | null;
  age: number | null;
  title: string | null;
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
    const gender = (cells[2] ?? '').trim();
    // 年龄非数字时按缺省处理：管理员自维护的数据，比整行报错更省事
    const ageText = (cells[3] ?? '').trim();
    const age = ageText === '' || Number.isNaN(Number(ageText)) ? null : Number(ageText);
    const title = (cells[4] ?? '').trim();
    rows.push({
      rowNumber: index + 1,
      departmentName,
      name,
      gender: gender === '' ? null : gender,
      age,
      title: title === '' ? null : title,
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
 * 列约定「部门,姓名,性别,年龄,职称（后三列可空）」，首行可以是表头。
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
import { describe, expect, it } from 'vitest';
import { parseDownloadFilename } from './api.js';

/**
 * 下载文件名解析（纯函数）。
 *
 * 服务端的 `Content-Disposition` 同时给 ASCII 回退名与 `filename*=UTF-8''` 中文名，
 * 解析顺序错了会让所有导出都叫 export.xlsx（曾出现：文件名看不出是哪个评议）。
 */
describe('parseDownloadFilename', () => {
  const FILENAME = '贵阳西车间评议评议-随机码-20261018.xlsx';
  const EXTENDED = `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(FILENAME)}`;

  it('优先取 filename* 的中文名，而不是 ASCII 回退名', () => {
    expect(parseDownloadFilename(EXTENDED, '/api/admin/tickets/export-by-type.xlsx')).toBe(FILENAME);
  });

  it('只有 filename= 时用它（去掉引号）', () => {
    expect(parseDownloadFilename('attachment; filename="随机码.xlsx"', '/x/y.xlsx')).toBe('随机码.xlsx');
  });

  it('没有 Content-Disposition 时退回 URL 末段，并去掉 query', () => {
    expect(
      parseDownloadFilename('', '/api/admin/tickets/export-by-type.xlsx?batchIds=a,b'),
    ).toBe('export-by-type.xlsx');
  });

  it('百分号编码损坏时原样返回，不抛错', () => {
    expect(parseDownloadFilename("attachment; filename*=UTF-8''%E4%B8", '/x/y.xlsx')).toBe('%E4%B8');
  });
});

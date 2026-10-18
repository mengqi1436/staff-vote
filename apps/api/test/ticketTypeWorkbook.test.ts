import { describe, expect, it } from 'vitest';
import { buildTicketsByTypeWorkbook, safeFileLabel } from '../src/lib/xlsx.js';

/**
 * 导出文件名清洗：场次名由管理员自由填写，直接拼进 Content-Disposition
 * 会让下载名带非法字符（Windows 下 `\ / : * ? " < > |` 都不允许）。
 */
describe('safeFileLabel', () => {
  it('去掉 Windows 非法字符', () => {
    expect(safeFileLabel('贵阳西/车间:评议*评议?')).toBe('贵阳西车间评议评议');
  });

  it('空串或全非法字符时回落到默认名', () => {
    expect(safeFileLabel('   ')).toBe('随机码');
    expect(safeFileLabel('///')).toBe('随机码');
  });

  it('超长评议名截断到 60 字，保证文件名可用', () => {
    expect(safeFileLabel('场'.repeat(80))).toHaveLength(60);
  });
});

/**
 * 发码结果 Excel 的版式（纯函数，任何环境可跑）。
 *
 * 需求口径：**每列是一种票别**，列下是该票别本次生成的随机码。
 * 发码现场打印后按列剪开即可分别发放，不必逐行筛票种。
 */
describe('buildTicketsByTypeWorkbook', () => {
  function readRows(columns: Array<{ header: string; codes: string[] }>): string[][] {
    const workbook = buildTicketsByTypeWorkbook(columns);
    const sheet = workbook.getWorksheet('随机码');
    expect(sheet).toBeTruthy();
    const rows: string[][] = [];
    for (let rowNumber = 1; rowNumber <= sheet!.rowCount; rowNumber += 1) {
      const row = sheet!.getRow(rowNumber);
      rows.push(
        columns.map((_, index) => {
          const value = row.getCell(index + 1).value;
          return value == null ? '' : String(value);
        }),
      );
    }
    return rows;
  }

  it('第一行是人员类别表头，列下依次是该人员类别的码', () => {
    const rows = readRows([
      { header: '领导班子（A）', codes: ['AAAAAAAA', 'BBBBBBBB'] },
      { header: '职工（C）', codes: ['CCCCCCCC'] },
    ]);

    expect(rows[0]).toEqual(['领导班子（A）', '职工（C）']);
    expect(rows[1]).toEqual(['AAAAAAAA', 'CCCCCCCC']);
  });

  it('各人员类别数量不等时，短列留空而不是把别人的码顶上', () => {
    const rows = readRows([
      { header: '领导班子（A）', codes: ['AAAAAAAA', 'BBBBBBBB', 'DDDDDDDD'] },
      { header: '职工（C）', codes: ['CCCCCCCC'] },
    ]);

    expect(rows).toHaveLength(4); // 表头 + 最长列的 3 行
    expect(rows[2]).toEqual(['BBBBBBBB', '']);
    expect(rows[3]).toEqual(['DDDDDDDD', '']);
  });

  it('只有一个人员类别时就是单列', () => {
    const rows = readRows([{ header: '职工（C）', codes: ['CCCCCCCC'] }]);
    expect(rows).toEqual([['职工（C）'], ['CCCCCCCC']]);
  });

  it('空输入不抛错（没有码可导出的边界）', () => {
    const rows = readRows([]);
    expect(rows).toHaveLength(0);
  });
});

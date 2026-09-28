/**
 * 参考样表统计（services/sampleStats.ts）服务测试。
 *
 * 覆盖：
 *   1. 单票别行：项点均分、1-5合计、综合评价得分（票别内等权平均）；
 *   2. ABC汇总行：票种加权原始分 + 加权归一化综合得分（与结果导出同口径）；
 *   3. 排名：个人表「部门×票别」组内同分并列（1、1、…）；车间表票别组内排名；
 *   4. 零票种排除：某票别在某部门一张表都没有时不出行；
 *   5. 无任何提交的部门不产生行；
 *   6. 输出顺序：票别在前（按票种顺序）、ABC汇总在后。
 *
 * 夹具约定：所有数据带 `TSS` 前缀，只清理自己的数据。
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suiteEnabled = Boolean(testDatabaseUrl);

process.env.NODE_ENV = 'test';

const { prisma } = await import('../src/db.js');
const { computeSessionSampleStats } = await import('../src/services/sampleStats.js');

const describeDb = suiteEnabled ? describe : describe.skip;

const TAG = 'TSS';

/** 本文件建的场次 id，afterAll 兜底清理。 */
const sessionIds: string[] = [];

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

async function makeTicketType(sessionId: string, code: string, weight: number) {
  return prisma.ticketType.create({
    data: { sessionId, code: `${TAG}${code}${nextSeq()}`, name: `${TAG}票种-${code}`, weightPercent: weight, enabled: true },
  });
}

interface MadeDept {
  id: string;
  columns: Array<{ id: string; name: string }>;
  criteria: Array<{ id: string; name: string }>;
}

async function makeDepartment(
  sessionId: string,
  label: string,
  type: 'person' | 'workshop',
  columnNames: string[],
  criterionNames: string[],
): Promise<MadeDept> {
  const department = await prisma.department.create({
    data: { sessionId, name: `${TAG}部门-${label}${nextSeq()}`, questionnaireType: type, enabled: true },
  });
  const columns = [] as MadeDept['columns'];
  for (const [index, name] of columnNames.entries()) {
    const column = await prisma.voteColumn.create({
      data: { departmentId: department.id, sessionId, name, sortOrder: index + 1 },
    });
    columns.push({ id: column.id, name });
  }
  const criteria = [] as MadeDept['criteria'];
  for (const [index, name] of criterionNames.entries()) {
    const criterion = await prisma.criterion.create({
      data: { departmentId: department.id, sessionId, name, minScore: 0, maxScore: 100, sortOrder: index + 1 },
    });
    criteria.push({ id: criterion.id, name });
  }
  return { id: department.id, columns, criteria };
}

/** 造一张已提交打分表：scores 为 (被评列, 项点) → 分。 */
async function makeSheet(input: {
  sessionId: string;
  departmentId: string;
  ticketTypeId: string;
  cells: Array<{ voteColumnId: string; criterionId: string; score: number }>;
}) {
  await prisma.scoreSheet.create({
    data: {
      sessionId: input.sessionId,
      departmentId: input.departmentId,
      ticketTypeId: input.ticketTypeId,
      submittedAt: new Date(),
      items: { create: input.cells.map((cell) => ({ ...cell })) },
    },
  });
}

describeDb('参考样表统计 computeSessionSampleStats', () => {
  let sessionId: string;
  let typeA: { id: string };
  let typeB: { id: string };
  let person: MadeDept;
  let workshop: MadeDept;

  beforeAll(async () => {
    sessionId = (
      await prisma.voteSession.create({ data: { name: `${TAG}场次${nextSeq()}`, status: 'ended' } })
    ).id;
    sessionIds.push(sessionId);
    // 权重 60/40，便于心算加权：raw = A均分×0.6 + B均分×0.4。
    typeA = await makeTicketType(sessionId, 'A', 60);
    typeB = await makeTicketType(sessionId, 'B', 40);

    person = await makeDepartment(sessionId, 'P', 'person', ['甲', '乙'], ['第一项', '第二项']);
    workshop = await makeDepartment(sessionId, 'W', 'workshop', ['车间列'], ['车间项点']);

    // noUncheckedIndexedAccess 下解构元素仍视作可空，夹具保证两列两项必在，直接断言非空
    const jia = person.columns[0]!;
    const yi = person.columns[1]!;
    const c1 = person.criteria[0]!;
    const c2 = person.criteria[1]!;

    // person 部门：A 票 2 张（甲乙 A 组内均分相同 → 并列第 1）。
    await makeSheet({
      sessionId,
      departmentId: person.id,
      ticketTypeId: typeA.id,
      cells: [
        { voteColumnId: jia.id, criterionId: c1.id, score: 80 },
        { voteColumnId: jia.id, criterionId: c2.id, score: 60 },
        { voteColumnId: yi.id, criterionId: c1.id, score: 100 },
        { voteColumnId: yi.id, criterionId: c2.id, score: 40 },
      ],
    });
    await makeSheet({
      sessionId,
      departmentId: person.id,
      ticketTypeId: typeA.id,
      cells: [
        { voteColumnId: jia.id, criterionId: c1.id, score: 80 },
        { voteColumnId: jia.id, criterionId: c2.id, score: 60 },
        { voteColumnId: yi.id, criterionId: c1.id, score: 100 },
        { voteColumnId: yi.id, criterionId: c2.id, score: 40 },
      ],
    });
    // B 票 1 张：甲全 100、乙全 0。
    await makeSheet({
      sessionId,
      departmentId: person.id,
      ticketTypeId: typeB.id,
      cells: [
        { voteColumnId: jia.id, criterionId: c1.id, score: 100 },
        { voteColumnId: jia.id, criterionId: c2.id, score: 100 },
        { voteColumnId: yi.id, criterionId: c1.id, score: 0 },
        { voteColumnId: yi.id, criterionId: c2.id, score: 0 },
      ],
    });

    // workshop 部门：只有 A 票 1 张（B 票零票 → 不应出现 B 行）。
    await makeSheet({
      sessionId,
      departmentId: workshop.id,
      ticketTypeId: typeA.id,
      cells: [
        { voteColumnId: workshop.columns[0]!.id, criterionId: workshop.criteria[0]!.id, score: 90 },
      ],
    });
  });

  afterAll(async () => {
    // 只清理本前缀：评分项 → 打分表 → 被评列/项点 → 部门 → 票种 → 场次。
    const departmentIds = (
      await prisma.department.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } })
    ).map((row) => row.id);
    await prisma.scoreItem.deleteMany({ where: { sheet: { departmentId: { in: departmentIds } } } });
    await prisma.scoreSheet.deleteMany({ where: { departmentId: { in: departmentIds } } });
    await prisma.voteColumn.deleteMany({ where: { departmentId: { in: departmentIds } } });
    await prisma.criterion.deleteMany({ where: { departmentId: { in: departmentIds } } });
    await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    await prisma.ticketType.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.voteSession.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.$disconnect();
  });

  it('单票别行：均分、合计、综合得分与并列排名', async () => {
    const result = await computeSessionSampleStats(sessionId);

    expect(result.personal.criteriaNames).toEqual(['第一项', '第二项']);

    const jiaA = result.personal.rows.find((row) => row.targetName === '甲' && row.ticketCode.startsWith('TSSA'));
    expect(jiaA).toBeDefined();
    expect(jiaA!.scores).toEqual([80, 60]);
    expect(jiaA!.total).toBe(140);
    expect(jiaA!.comprehensiveScore).toBe(70);

    const yiA = result.personal.rows.find((row) => row.targetName === '乙' && row.ticketCode.startsWith('TSSA'));
    expect(yiA!.comprehensiveScore).toBe(70);
    // A 组内同分并列：甲乙都是第 1。
    expect(jiaA!.rank).toBe(1);
    expect(yiA!.rank).toBe(1);

    // B 组：甲 100 第 1，乙 0 第 2。
    const jiaB = result.personal.rows.find((row) => row.targetName === '甲' && row.ticketCode.startsWith('TSSB'));
    const yiB = result.personal.rows.find((row) => row.targetName === '乙' && row.ticketCode.startsWith('TSSB'));
    expect(jiaB!.comprehensiveScore).toBe(100);
    expect(jiaB!.rank).toBe(1);
    expect(yiB!.comprehensiveScore).toBe(0);
    expect(yiB!.rank).toBe(2);
  });

  it('ABC汇总行：票种加权原始分与综合得分（60/40 权重心算核对）', async () => {
    const result = await computeSessionSampleStats(sessionId);

    const jiaSummary = result.personal.rows.find((row) => row.targetName === '甲' && row.ticketCode === 'ABC汇总');
    // 第一项：80×0.6 + 100×0.4 = 88；第二项：60×0.6 + 100×0.4 = 76。
    expect(jiaSummary!.scores).toEqual([88, 76]);
    expect(jiaSummary!.total).toBe(164);
    expect(jiaSummary!.comprehensiveScore).toBe(82);

    const yiSummary = result.personal.rows.find((row) => row.targetName === '乙' && row.ticketCode === 'ABC汇总');
    // 第一项：100×0.6 + 0×0.4 = 60；第二项：40×0.6 + 0×0.4 = 24 → 综合 42。
    expect(yiSummary!.scores).toEqual([60, 24]);
    expect(yiSummary!.comprehensiveScore).toBe(42);
    // 汇总组排名：甲 82 第 1、乙 42 第 2。
    expect(jiaSummary!.rank).toBe(1);
    expect(yiSummary!.rank).toBe(2);
  });

  it('车间表：票别组内排名、零票种排除、项点列名', async () => {
    const result = await computeSessionSampleStats(sessionId);

    expect(result.workshop.criteriaNames).toEqual(['车间项点']);
    // 只有 A 票一张表：A 行 + ABC汇总行，B 行不出现。
    expect(result.workshop.rows).toHaveLength(2);
    const rowA = result.workshop.rows.find((row) => row.ticketCode.startsWith('TSSA'))!;
    expect(rowA.scores).toEqual([90]);
    expect(rowA.total).toBe(90);
    expect(rowA.rank).toBe(1);
    const rowSummary = result.workshop.rows.find((row) => row.ticketCode === 'ABC汇总')!;
    expect(rowSummary.comprehensiveScore).toBe(90);
  });

  it('输出顺序：票别在前（按票种顺序）、ABC汇总殿后', async () => {
    const result = await computeSessionSampleStats(sessionId);
    const jiaRows = result.personal.rows.filter((row) => row.targetName === '甲');
    const codes = jiaRows.map((row) => (row.ticketTypeId === null ? 'SUM' : 'T'));
    expect(codes).toEqual(['T', 'T', 'SUM']);
  });

  it('无任何提交的部门不产生行', async () => {
    await prisma.department.create({
      data: { sessionId, name: `${TAG}空部门${nextSeq()}`, questionnaireType: 'person', enabled: true },
    });
    const result = await computeSessionSampleStats(sessionId);
    expect(result.personal.rows.every((row) => !row.departmentName.includes('空部门'))).toBe(true);
  });

  it('无票的被评列不产生行（无票 ≠ 0 分），行携带 voteColumnId', async () => {
    // person 部门再加第三列「丙」：不打任何分，甲乙正常有票
    const extra = await prisma.voteColumn.create({
      data: { departmentId: person.id, sessionId, name: '丙', sortOrder: 9 },
    });
    const result = await computeSessionSampleStats(sessionId);

    // 「丙」单票别行与汇总行都不出现
    expect(result.personal.rows.filter((row) => row.targetName === '丙')).toHaveLength(0);
    // 有票的甲乙行仍在，且每行带唯一 voteColumnId（同名被评列也各自可区分）
    const jiaRow = result.personal.rows.find((row) => row.targetName === '甲');
    expect(jiaRow).toBeDefined();
    expect(jiaRow!.voteColumnId).toBe(person.columns[0]!.id);
    await prisma.voteColumn.delete({ where: { id: extra.id } });
  });

  it('sheetCount 与 generatedAt', async () => {
    const result = await computeSessionSampleStats(sessionId);
    expect(result.sheetCount).toBe(4);
    expect(new Date(result.generatedAt).toString()).not.toBe('Invalid Date');
  });
});

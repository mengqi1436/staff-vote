/**
 * 参考样表统计（services/sampleStats.ts）服务测试。
 *
 * 覆盖：
 *   1. 人员类别行：项点均分、1-5合计、综合评价得分（类别内归一化分等权平均）；
 *   2. 不做跨类别合并：没有「ABC汇总」行，也没有任何加权/合并值；
 *   3. 排名：个人表「部门×人员类别」组内同分并列（1、1、…）；车间表跨部门
 *      同类别内排名；
 *   4. 零票类别排除：某人员类别在某部门一张表都没有时不出行；
 *   5. 无任何提交的部门不产生行；
 *   6. 输出顺序：被评对象内按人员类别配置顺序（不再有汇总行殿后）。
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

/** 本文件建的评议 id，afterAll 兜底清理。 */
const sessionIds: string[] = [];

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

async function makeTicketType(sessionId: string, code: string) {
  return prisma.ticketType.create({
    data: { sessionId, code: `${TAG}${code}${nextSeq()}`, name: `${TAG}人员类别-${code}`, enabled: true },
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
  // 0010 起车间问卷是单一「得分」虚拟列（score_items.vote_column_id 为 NULL），不再建真实被评列
  const effectiveColumns = type === 'workshop' ? [] : columnNames;
  for (const [index, name] of effectiveColumns.entries()) {
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

/** 造一张已提交打分表：scores 为 (被评议人列, 评议项目) → 分。 */
async function makeSheet(input: {
  sessionId: string;
  departmentId: string;
  ticketTypeId: string;
  cells: Array<{ voteColumnId: string | null; criterionId: string; score: number }>;
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
  let workshop2: MadeDept;

  beforeAll(async () => {
    sessionId = (
      await prisma.voteSession.create({ data: { name: `${TAG}评议${nextSeq()}`, status: 'ended' } })
    ).id;
    sessionIds.push(sessionId);
    // 两个人员类别，各自独立统计，没有任何权重。
    typeA = await makeTicketType(sessionId, 'A');
    typeB = await makeTicketType(sessionId, 'B');

    person = await makeDepartment(sessionId, 'P', 'person', ['甲', '乙'], ['第一项', '第二项']);
    workshop = await makeDepartment(sessionId, 'W', 'workshop', ['车间列'], ['车间评议项目']);
    workshop2 = await makeDepartment(sessionId, 'W2', 'workshop', ['车间列'], ['车间评议项目']);

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
      cells: [{ voteColumnId: null, criterionId: workshop.criteria[0]!.id, score: 90 }],
    });
    // 第二个车间：同类别不同部门，用于验证「同一人员类别内跨部门排名」。
    await makeSheet({
      sessionId,
      departmentId: workshop2.id,
      ticketTypeId: typeA.id,
      cells: [{ voteColumnId: null, criterionId: workshop2.criteria[0]!.id, score: 60 }],
    });
  });

  afterAll(async () => {
    // 只清理本前缀：评分项 → 打分表 → 被评议人列/项点 → 部门 → 票种 → 场次。
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

  it('人员类别行：均分、合计、类别内综合得分与并列排名', async () => {
    const result = await computeSessionSampleStats(sessionId);

    expect(result.personal.criteriaNames).toEqual(['第一项', '第二项']);

    const jiaA = result.personal.rows.find((row) => row.targetName === '甲' && row.ticketCode.startsWith('TSSA'));
    expect(jiaA).toBeDefined();
    expect(jiaA!.scores).toEqual([80, 60]);
    expect(jiaA!.total).toBe(140);
    // 类别内综合 = 各格归一化分等权平均 = (80 + 60) / 2
    expect(jiaA!.comprehensiveScore).toBe(70);

    const yiA = result.personal.rows.find((row) => row.targetName === '乙' && row.ticketCode.startsWith('TSSA'));
    expect(yiA!.scores).toEqual([100, 40]);
    expect(yiA!.total).toBe(140);
    // (100 + 40) / 2
    expect(yiA!.comprehensiveScore).toBe(70);
    // A 组内同分并列：甲乙都是第 1。
    expect(jiaA!.rank).toBe(1);
    expect(yiA!.rank).toBe(1);

    // B 组：甲 100 第 1，乙 0 第 2。
    const jiaB = result.personal.rows.find((row) => row.targetName === '甲' && row.ticketCode.startsWith('TSSB'));
    const yiB = result.personal.rows.find((row) => row.targetName === '乙' && row.ticketCode.startsWith('TSSB'));
    expect(jiaB!.scores).toEqual([100, 100]);
    expect(jiaB!.comprehensiveScore).toBe(100);
    expect(jiaB!.rank).toBe(1);
    expect(yiB!.scores).toEqual([0, 0]);
    expect(yiB!.comprehensiveScore).toBe(0);
    expect(yiB!.rank).toBe(2);
  });

  it('不做跨类别合并：没有 ABC 汇总行，也没有加权/合并出来的综合分', async () => {
    const result = await computeSessionSampleStats(sessionId);

    expect(result.personal.rows.some((row) => row.ticketCode === 'ABC汇总')).toBe(false);
    // 甲的两行分别是 A(70) 与 B(100)；旧口径加权合并会多出 82 这样的第三行
    const jiaScores = result.personal.rows
      .filter((row) => row.targetName === '甲')
      .map((row) => row.comprehensiveScore);
    expect(jiaScores).toEqual([70, 100]);
    expect(jiaScores).not.toContain(82);
  });

  it('车间表：同一人员类别内跨部门排名、零人员类别排除、评议项目列名', async () => {
    const result = await computeSessionSampleStats(sessionId);

    expect(result.workshop.criteriaNames).toEqual(['车间评议项目']);
    // 两个车间各一张 A 票：只有 A 行（B 零票不出现），没有汇总行。
    expect(result.workshop.rows).toHaveLength(2);
    expect(result.workshop.rows.every((row) => row.ticketCode.startsWith('TSSA'))).toBe(true);

    const high = result.workshop.rows.find((row) => row.comprehensiveScore === 90)!;
    const low = result.workshop.rows.find((row) => row.comprehensiveScore === 60)!;
    expect(high.scores).toEqual([90]);
    expect(high.total).toBe(90);
    expect(high.rank).toBe(1);
    expect(low.scores).toEqual([60]);
    expect(low.rank).toBe(2);
  });

  it('输出顺序：被评对象内按人员类别配置顺序排列', async () => {
    const result = await computeSessionSampleStats(sessionId);
    const jiaRows = result.personal.rows.filter((row) => row.targetName === '甲');
    expect(jiaRows.map((row) => (row.ticketCode.startsWith('TSSA') ? 'A' : 'B'))).toEqual(['A', 'B']);
  });

  it('无任何提交的部门不产生行', async () => {
    await prisma.department.create({
      data: { sessionId, name: `${TAG}空部门${nextSeq()}`, questionnaireType: 'person', enabled: true },
    });
    const result = await computeSessionSampleStats(sessionId);
    expect(result.personal.rows.every((row) => !row.departmentName.includes('空部门'))).toBe(true);
  });

  it('无票的被评议人列不产生行（无票 ≠ 0 分），行携带 voteColumnId', async () => {
    // person 部门再加第三列「丙」：不打任何分，甲乙正常有票
    const extra = await prisma.voteColumn.create({
      data: { departmentId: person.id, sessionId, name: '丙', sortOrder: 9 },
    });
    const result = await computeSessionSampleStats(sessionId);

    // 「丙」在各人员类别下都不出现
    expect(result.personal.rows.filter((row) => row.targetName === '丙')).toHaveLength(0);
    // 有票的甲乙行仍在，且每行带唯一 voteColumnId（同名被评列也各自可区分）
    const jiaRow = result.personal.rows.find((row) => row.targetName === '甲');
    expect(jiaRow).toBeDefined();
    expect(jiaRow!.voteColumnId).toBe(person.columns[0]!.id);
    await prisma.voteColumn.delete({ where: { id: extra.id } });
  });

  it('sheetCount 与 generatedAt', async () => {
    const result = await computeSessionSampleStats(sessionId);
    // person 3 张 + 两个车间各 1 张
    expect(result.sheetCount).toBe(5);
    expect(new Date(result.generatedAt).toString()).not.toBe('Invalid Date');
  });
});

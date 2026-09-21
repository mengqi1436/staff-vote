import { prisma } from '../src/db.js';

/**
 * 测试人员数据生成（直接写入数据库）。
 *
 * 「重新生成」语义：先清空全部职工再重建，历史选人（vote_columns.employee_id）
 * 由外键 ON DELETE SET NULL 自动置空，随后按职务顺序重新指派。
 *
 * 规则：
 *   - 每个部门生成 8–12 名职工，姓名取自常见姓名池（跨部门错开），工号全局唯一；
 *   - 个人问卷（person）的启用职务列按列顺序依次指派一名职工（「职务与姓名」完整可打印）；
 *     车间问卷的「得分」列不指派人。
 *
 * 运行：pnpm --filter @staff-vote/api db:seed:employees
 */

/** 常见中文姓名池（44 个，跨部门按偏移取用避免每个车间都是同一批人）。 */
const NAME_POOL = [
  '王建国', '李秀英', '张伟', '刘洋', '陈静', '杨勇', '赵敏', '黄强',
  '周丽', '吴刚', '徐明', '孙娟', '马超', '朱琳', '胡军', '郭燕',
  '林峰', '何平', '高翔', '罗娜', '郑磊', '梁爽', '谢东', '宋佳',
  '唐磊', '韩雪', '冯刚', '曹颖', '彭飞', '董洁', '袁帅', '蔡婷',
  '潘磊', '刘畅', '常青', '齐勇', '石磊', '白帆', '冯媛', '侯亮',
  '秦岚', '姚远', '尹红', '薛军',
];

/** 车间问卷的得分列是评分口径不是人，不指派被评人。 */
const NON_PERSON_COLUMN_NAMES = new Set(['得分']);

async function main(): Promise<void> {
  const departments = await prisma.department.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      voteColumns: { where: { enabled: true }, orderBy: { sortOrder: 'asc' } },
    },
  });

  // 重新生成：先清空旧名单。vote_columns.employee_id 会被外键置空，下面统一重指。
  const removed = await prisma.employee.deleteMany();
  console.log(`[seed-employees] 已清除旧职工 ${removed.count} 名`);

  let total = 0;
  let assigned = 0;

  for (const [deptIndex, dept] of departments.entries()) {
    const count = 8 + (deptIndex % 5); // 8–12 人
    const rows = Array.from({ length: count }, (_, i) => ({
      departmentId: dept.id,
      name: NAME_POOL[(deptIndex * 7 + i) % NAME_POOL.length] as string,
      // 工号全局唯一：两位部门序号 + 三位部门内序号
      employeeNo: `${String(deptIndex + 1).padStart(2, '0')}${String(i + 1).padStart(3, '0')}`,
      sortOrder: i + 1,
    }));
    await prisma.employee.createMany({ data: rows });
    total += rows.length;

    if (dept.questionnaireType !== 'person') {
      console.log(`[seed-employees] ${dept.name}：${rows.length} 名职工（车间问卷，不指派被评人）`);
      continue;
    }

    const created = await prisma.employee.findMany({
      where: { departmentId: dept.id },
      orderBy: { sortOrder: 'asc' },
    });
    const personColumns = dept.voteColumns.filter(
      (column) => !NON_PERSON_COLUMN_NAMES.has(column.name),
    );

    for (const [i, column] of personColumns.entries()) {
      const employee = created[i];
      if (!employee) break; // 职务多于人数时多余职务保持未选人
      await prisma.voteColumn.update({
        where: { id: column.id },
        data: { employeeId: employee.id },
      });
      assigned += 1;
    }
    console.log(
      `[seed-employees] ${dept.name}：${rows.length} 名职工，已指派 ${Math.min(personColumns.length, created.length)} 个职务的被评人`,
    );
  }

  console.log(`[seed-employees] 完成：共 ${departments.length} 个部门、${total} 名职工、${assigned} 个职务已绑定被评人`);
}

main()
  .catch((error) => {
    console.error('[seed-employees] 失败：', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

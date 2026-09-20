/**
 * 权限目录：全站权限码的唯一真源。
 *
 * 数据库 permissions 表存这份目录的副本（角色勾选需要外键引用），
 * 由 seed 按 code 幂等同步：新增权限只需改这里并重跑 seed，不必写迁移。
 *
 * 粒度按「不可逆、或能改变投票有效性的动作」划分：配置类写操作按模块各一条，
 * 读操作不设权限 —— 没有任何写权限的角色天然就是只读，不必再列一堆读权限。
 * 前端按钮门控直接写权限码字符串，目录本身从接口取，不重复维护第二份定义。
 */

/** 目录项。 */
export interface PermissionSeed {
  code: string;
  name: string;
  /** 后台勾选框的分组标题 */
  groupName: string;
  /** 组内排序 */
  sortOrder: number;
}

/** 权限清单。 */
export const PERMISSION_CATALOG: PermissionSeed[] = [
  {
    code: 'departments.write',
    name: '管理部门（新增、修改、停用）',
    groupName: '评议准备',
    sortOrder: 10,
  },
  { code: 'employees.write', name: '管理职工名单与导入', groupName: '评议准备', sortOrder: 11 },
  { code: 'criteria.write', name: '管理评分项点', groupName: '评议准备', sortOrder: 12 },
  { code: 'ticketTypes.write', name: '管理票种与权重', groupName: '发票与票种', sortOrder: 20 },
  { code: 'tickets.generate', name: '发放随机码', groupName: '发票与票种', sortOrder: 21 },
  {
    code: 'tickets.revoke',
    name: '作废随机码（单张与一键）',
    groupName: '发票与票种',
    sortOrder: 22,
  },
  {
    code: 'settings.write',
    name: '修改开放时间与系统设置',
    groupName: '评议执行',
    sortOrder: 30,
  },
  {
    code: 'admins.manage',
    name: '管理管理员账号与角色权限',
    groupName: '系统管理',
    sortOrder: 40,
  },
];

/** 全部权限码。 */
export const ALL_PERMISSION_CODES: string[] = PERMISSION_CATALOG.map((item) => item.code);

/** 内置角色的 seed 定义。builtin 角色不允许删除，避免把系统改到无法自行恢复。 */
export interface RoleSeed {
  code: string;
  name: string;
  description: string;
  /** 首次创建时授予的权限；已存在的角色不会被 seed 覆盖（管理员改过的必须保留） */
  permissions: string[];
}

/** 内置角色。 */
export const BUILTIN_ROLES: RoleSeed[] = [
  {
    code: 'super_admin',
    name: '超级管理员',
    description: '拥有全部权限，包括管理其他管理员与角色',
    permissions: ALL_PERMISSION_CODES,
  },
  {
    code: 'review_admin',
    name: '评议管理员',
    description: '可组织评议全流程，但不能管理管理员账号与角色',
    permissions: ALL_PERMISSION_CODES.filter((code) => code !== 'admins.manage'),
  },
  {
    code: 'viewer',
    name: '只读查看',
    description: '只能查看数据与结果，不能做任何修改',
    permissions: [],
  },
];

/** 权限码 → 中文名，用于 403 文案。 */
export const PERMISSION_NAMES: Map<string, string> = new Map(
  PERMISSION_CATALOG.map((item) => [item.code, item.name]),
);
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { adminApi, type AdminUserDto, type PermissionDto, type RoleDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { describeError, formatDateTime } from './lib.js';
import { ErrorState, HelpLabel, LoadingState, PageHeader, useNotify } from './shared.js';

/**
 * 账号与权限（RBAC）管理页。
 *
 * 两个页签：管理员账号按人管，角色与权限按权限集合管。
 *
 * 页面内的门控只是体验层：没有 `admins.manage` 连权限目录都拿不到（后端
 * requirePermission 拦在 router 上），这里提前拦一层，避免管理员看到一堆
 * 点不动的按钮。真正的守卫（不能停用最后一个管理账号等）全在后端，
 * 前端只负责把后端的拒绝原文回显出来。
 *
 * 本页不属于评议流程，底部不加「下一步」引导。
 */

/** 页面自己的权限码。 */
const MANAGE_PERMISSION = 'admins.manage';

interface AdminForm {
  username: string;
  password?: string;
  roleId?: string | null;
  enabled?: boolean;
}

interface RoleForm {
  code: string;
  name: string;
  description?: string;
  permissions?: string[];
}

/** 外层只做权限门控：没权限时连数据请求都不发，内层组件根本不挂载。 */
export function AdminAdmins() {
  const { can } = useAuth();

  if (!can(MANAGE_PERMISSION)) {
    return (
      <div>
        <PageHeader title="账号与权限" description="管理后台账号、角色，以及每个账号能做什么。" />
        <Alert
          type="warning"
          showIcon
          title="没有「管理管理员账号与角色权限」权限"
          description="当前账号无法查看或修改管理员账号与角色权限。如需调整，请联系拥有该权限的管理员。"
        />
      </div>
    );
  }

  return <RbacPanel />;
}

function RbacPanel() {
  const { admin, reload } = useAuth();
  const notify = useNotify();
  // 「当前登录」标签跟随主题主色：实心主色底 + 白字（solid 保证 AA 对比度），
  // 非预设色默认浅底 + 主色字对比度不足；固定 color="blue" 是不随主题变的旧默认蓝板，弃用。
  const { token } = theme.useToken();

  const [adminRows, setAdminRows] = useState<AdminUserDto[] | null>(null);
  const [roleRows, setRoleRows] = useState<RoleDto[] | null>(null);
  const [permissionRows, setPermissionRows] = useState<PermissionDto[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);

  const [adminForm] = Form.useForm<AdminForm>();
  const [roleForm] = Form.useForm<RoleForm>();
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState<AdminUserDto | null>(null);
  const [editingRole, setEditingRole] = useState<RoleDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [nextAdmins, nextRoles, nextPermissions] = await Promise.all([
        adminApi.admins.list(),
        adminApi.roles.list(),
        adminApi.permissions.list(),
      ]);
      setAdminRows(nextAdmins);
      setRoleRows(nextRoles);
      setPermissionRows(nextPermissions);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 权限目录按 groupName 分组，组内保持后端给的 sortOrder。 */
  const permissionGroups = useMemo(() => {
    const groups = new Map<string, PermissionDto[]>();
    for (const item of permissionRows) {
      const list = groups.get(item.groupName);
      if (list) list.push(item);
      else groups.set(item.groupName, [item]);
    }
    return [...groups.entries()];
  }, [permissionRows]);

  const roleOptions = (roleRows ?? []).map((role) => ({ label: role.name, value: role.id }));

  const openAdminCreate = (): void => {
    setEditingAdmin(null);
    adminForm.resetFields();
    adminForm.setFieldsValue({ username: '', roleId: roleRows?.[0]?.id ?? null, enabled: true });
    setAdminModalOpen(true);
  };

  const openAdminEdit = (row: AdminUserDto): void => {
    setEditingAdmin(row);
    adminForm.resetFields();
    adminForm.setFieldsValue({
      username: row.username,
      roleId: row.roleId,
      enabled: row.enabled,
      password: '',
    });
    setAdminModalOpen(true);
  };

  const openRoleCreate = (): void => {
    setEditingRole(null);
    roleForm.resetFields();
    roleForm.setFieldsValue({ code: '', name: '', description: '', permissions: [] });
    setRoleModalOpen(true);
  };

  const openRoleEdit = (row: RoleDto): void => {
    setEditingRole(row);
    roleForm.resetFields();
    roleForm.setFieldsValue({
      code: row.code,
      name: row.name,
      description: row.description ?? '',
      permissions: row.permissions,
    });
    setRoleModalOpen(true);
  };

  /** 账号保存：改角色、启停、重置口令都走同一个 PATCH。 */
  const submitAdmin = async (): Promise<void> => {
    let values: AdminForm;
    try {
      values = await adminForm.validateFields();
    } catch {
      return; // 表单校验失败，antd 已在字段下方标红
    }

    setSaving(true);
    try {
      if (editingAdmin) {
        await adminApi.admins.update(editingAdmin.id, {
          roleId: values.roleId ?? null,
          enabled: values.enabled,
          // 留空表示不改口令：不能把空串当成新口令写进去
          password: values.password ? values.password : undefined,
        });
        notify.success(`已更新账号「${editingAdmin.username}」`);
      } else {
        await adminApi.admins.create({
          username: values.username,
          password: values.password ?? '',
          roleId: values.roleId ?? null,
        });
        notify.success(`已创建账号「${values.username}」`);
      }
      setAdminModalOpen(false);
      await load();
      // 改的可能是自己的角色或口令：立即回读身份，按钮显隐跟上
      await reload();
    } catch (caught) {
      // 后端守卫（最后一个管理账号、不能停用自己等）的原文直接给管理员看
      notify.error(describeError(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: AdminUserDto, checked: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.admins.update(row.id, { enabled: checked });
      notify.success(checked ? `已启用「${row.username}」` : `已停用「${row.username}」`);
      await load();
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setTogglingId(null);
    }
  };

  const removeAdmin = async (row: AdminUserDto): Promise<void> => {
    try {
      await adminApi.admins.remove(row.id);
      notify.success(`已删除账号「${row.username}」`);
      await load();
    } catch (caught) {
      notify.error(describeError(caught));
    }
  };

  /** 角色保存：权限按完整集合提交（后端整组替换），保存后回读身份。 */
  const submitRole = async (): Promise<void> => {
    let values: RoleForm;
    try {
      values = await roleForm.validateFields();
    } catch {
      return;
    }

    setSaving(true);
    try {
      const permissions = values.permissions ?? [];
      if (editingRole) {
        await adminApi.roles.update(editingRole.id, {
          name: values.name,
          description: values.description ? values.description : null,
          permissions,
        });
        notify.success(`已更新角色「${values.name}」`);
      } else {
        await adminApi.roles.create({
          code: values.code,
          name: values.name,
          description: values.description ? values.description : null,
          permissions,
        });
        notify.success(`已创建角色「${values.name}」`);
      }
      setRoleModalOpen(false);
      await load();
      // 权限改动可能落在自己身上：立即回读，按钮显隐不用刷新页面就跟上
      await reload();
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setSaving(false);
    }
  };

  const removeRole = async (row: RoleDto): Promise<void> => {
    try {
      await adminApi.roles.remove(row.id);
      notify.success(`已删除角色「${row.name}」`);
      await load();
    } catch (caught) {
      notify.error(describeError(caught));
    }
  };

  const adminColumns: TableColumnsType<AdminUserDto> = [
    {
      title: '用户名',
      dataIndex: 'username',
      render: (value: string, row) => (
        <Space size={8}>
          <span className="tabular">{value}</span>
          {row.id === admin?.id ? (
            <Tag color={token.colorPrimary} variant="solid">当前登录</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: '角色',
      dataIndex: 'roleName',
      render: (value: string | null) =>
        value ?? <Typography.Text type="secondary">未分配（只读）</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 140,
      render: (value: boolean, row) => {
        const isSelf = row.id === admin?.id;
        return (
          <Space size={8}>
            <Switch
              size="small"
              checked={value}
              disabled={isSelf}
              loading={togglingId === row.id}
              aria-label={`${row.username} 启用状态`}
              onChange={(checked) => void toggleEnabled(row, checked)}
            />
            {/* 状态用文字表意，不靠 Switch 颜色单独传达 */}
            <Typography.Text type={value ? undefined : 'secondary'}>
              {value ? '启用' : '停用'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      render: (_: unknown, row) => {
        const isSelf = row.id === admin?.id;
        // 自己那一行不给停用与删除：停掉自己会立刻掉线，删掉自己更不可逆
        if (isSelf) {
          return (
            <Space size={12}>
              <Button size="small" type="link" disabled style={{ padding: 0 }}>
                删除
              </Button>
              <Typography.Text type="secondary">不能停用或删除当前登录的账号</Typography.Text>
            </Space>
          );
        }
        return (
          <Space size={12}>
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              onClick={() => openAdminEdit(row)}
            >
              编辑
            </Button>
            <Popconfirm
              title={`删除账号「${row.username}」？`}
              description="删除后该账号立即无法登录，已经登录的也会立刻退出。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void removeAdmin(row)}
            >
              <Button size="small" type="link" danger style={{ padding: 0 }}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const roleColumns: TableColumnsType<RoleDto> = [
    {
      title: '角色名',
      dataIndex: 'name',
      render: (value: string, row) => (
        <Space size={8}>
          <span>{value}</span>
          {row.builtin ? <Tag>内置</Tag> : null}
        </Space>
      ),
    },
    { title: '角色标识', dataIndex: 'code', width: 160 },
    {
      title: '权限数',
      dataIndex: 'permissions',
      width: 100,
      render: (codes: string[]) => <span className="tabular">{codes.length} 项</span>,
    },
    {
      title: '账号数',
      dataIndex: 'adminCount',
      width: 100,
      render: (value: number) => <span className="tabular">{value} 个</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: unknown, row) => (
        <Space size={12}>
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            aria-label={`${row.name} 编辑权限`}
            onClick={() => openRoleEdit(row)}
          >
            编辑权限
          </Button>
          <Popconfirm
            title={`删除角色「${row.name}」？`}
            description="删除后使用该角色的账号会失去这些权限，请先确认没有账号在使用。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={row.builtin}
            onConfirm={() => void removeRole(row)}
          >
            <Button
              size="small"
              type="link"
              danger
              style={{ padding: 0 }}
              disabled={row.builtin}
              aria-label={`${row.name} 删除角色`}
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const adminTab = (
    <Card
      title={
        <HelpLabel help="每个账号按角色获得权限，没有角色就只能查看、不能修改。系统里至少要留一个已启用、还能管理账号与权限的账号，否则以后没人能再改权限。">
          管理员账号
        </HelpLabel>
      }
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdminCreate}>
          新增管理员
        </Button>
      }
    >
      <Table<AdminUserDto>
        rowKey="id"
        size="small"
        loading={loading}
        columns={adminColumns}
        dataSource={adminRows ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
    </Card>
  );

  const roleTab = (
    <Card
      title={
        <HelpLabel help="权限按模块分组勾选，保存后马上生效，相关账号不用重新登录。内置角色可以改名称和权限，但不能删除。">
          角色与权限
        </HelpLabel>
      }
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openRoleCreate}>
          新增角色
        </Button>
      }
    >
      <Table<RoleDto>
        rowKey="id"
        size="small"
        loading={loading}
        columns={roleColumns}
        dataSource={roleRows ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
    </Card>
  );

  if (!adminRows || !roleRows) {
    return (
      <div>
        <PageHeader title="账号与权限" description="管理后台账号、角色，以及每个账号能做什么。" />
        {error ? <ErrorState error={error} onRetry={() => void load()} /> : <LoadingState />}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="账号与权限"
        description="管理后台账号、角色，以及每个账号能做什么。权限改完马上生效，相关账号不必重新登录。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      {error ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="最新一次刷新失败，当前显示的是最后一次成功的数据"
          description={error.message}
        />
      ) : null}

      <Tabs
        destroyOnHidden
        items={[
          { key: 'admins', label: '管理员账号', children: adminTab },
          { key: 'roles', label: '角色与权限', children: roleTab },
        ]}
      />

      <Modal
        title={editingAdmin ? `编辑账号：${editingAdmin.username}` : '新增管理员'}
        open={adminModalOpen}
        onCancel={() => setAdminModalOpen(false)}
        onOk={() => void submitAdmin()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form<AdminForm> form={adminForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="username"
            label={
              <HelpLabel
                help={
                  editingAdmin
                    ? '用户名是登录后台时用的名字，创建后不能修改。'
                    : '登录后台时用的名字，全系统不能重复。'
                }
              >
                用户名
              </HelpLabel>
            }
            rules={editingAdmin ? [] : [{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="例如：zhangsan" maxLength={64} disabled={Boolean(editingAdmin)} />
          </Form.Item>

          {editingAdmin ? null : (
            <Form.Item
              name="password"
              label="初始口令"
              rules={[
                { required: true, message: '请输入初始口令' },
                { min: 8, message: '口令至少 8 位' },
              ]}
            >
              <Input.Password placeholder="至少 8 位" maxLength={128} autoComplete="new-password" />
            </Form.Item>
          )}

          <Form.Item
            name="roleId"
            label={<HelpLabel help="不选角色时，这个账号只能查看，不能修改任何内容。">角色</HelpLabel>}
          >
            <Select
              allowClear
              placeholder="请选择角色"
              options={roleOptions}
              optionFilterProp="label"
            />
          </Form.Item>

          {editingAdmin ? (
            <>
              <Form.Item
                name="enabled"
                label={
                  <HelpLabel help="停用后这个账号马上不能登录，已经登录的也会立刻退出。">启用</HelpLabel>
                }
                valuePropName="checked"
              >
                {/* 开关内不放文字：白字在未选中态的浅底上不达 AA 对比度（Settings 页同款纪律），
                    状态由 label 与 extra 文字表达 */}
                <Switch />
              </Form.Item>

              <Form.Item
                name="password"
                label={<HelpLabel help="留空表示这次不改口令。">重置口令</HelpLabel>}
                rules={[{ min: 8, message: '口令至少 8 位' }]}
              >
                <Input.Password
                  placeholder="至少 8 位"
                  maxLength={128}
                  autoComplete="new-password"
                />
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={editingRole ? `编辑角色：${editingRole.name}` : '新增角色'}
        open={roleModalOpen}
        onCancel={() => setRoleModalOpen(false)}
        onOk={() => void submitRole()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnHidden
      >
        <Form<RoleForm> form={roleForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="code"
            label={
              <HelpLabel
                help={
                  editingRole
                    ? '系统靠这个标识来认角色，创建后不能修改。'
                    : '系统用它区分不同角色，建议用英文，例如 review_admin。'
                }
              >
                角色标识
              </HelpLabel>
            }
            rules={editingRole ? [] : [{ required: true, message: '请输入角色标识' }]}
          >
            <Input placeholder="例如：review_admin" maxLength={64} disabled={Boolean(editingRole)} />
          </Form.Item>

          <Form.Item
            name="name"
            label="角色名称"
            rules={[{ required: true, message: '请输入角色名称' }]}
          >
            <Input placeholder="例如：评议管理员" maxLength={64} />
          </Form.Item>

          <Form.Item name="description" label="描述">
            <Input.TextArea
              placeholder="这个角色能做什么，给谁用的"
              maxLength={200}
              rows={2}
              showCount
            />
          </Form.Item>

          <Form.Item name="permissions" label="权限">
            <Checkbox.Group style={{ width: '100%' }}>
              {permissionGroups.map(([groupName, items]) => (
                <div key={groupName} style={{ marginBottom: 12 }}>
                  <Typography.Text strong>{groupName}</Typography.Text>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    {items.map((item) => (
                      <Checkbox key={item.code} value={item.code}>
                        {item.name}
                      </Checkbox>
                    ))}
                  </div>
                </div>
              ))}
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
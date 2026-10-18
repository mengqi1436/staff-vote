import { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { ApiError, adminApi, type StaffEntryDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { usePolling } from '../../lib/usePolling.js';
import { EMPTY_TEXT, describeError } from './lib.js';
import { ErrorState, HelpLabel, LoadingState, PageHeader, StaleDataAlert, useNotify } from './shared.js';

interface StaffForm {
  employeeNo: string;
  name: string;
  gender: string | null;
  age: number | null;
  title: string | null;
  orgDepartmentId: string | null;
}

/**
 * 人员管理（全局人员目录）。
 *
 * 人员数据的唯一真源：外部系统定期推送到 `/api/admin/staff-directory/sync`
 * （X-Sync-Token 鉴权），管理员也可在此手工补录/更正。
 * 打分表选人从这里按姓名 / 工号 / 部门搜索，选中的人按「列所属部门」落入评议副本。
 *
 * 同步不硬删：名单外的人只停用（enabled=false），已绑定的被评议人列不会丢姓名。
 */
export function AdminEmployees() {
  const notify = useNotify();
  const { can } = useAuth();
  const canWrite = can('employees.write');

  const [keyword, setKeyword] = useState('');
  /** 已提交的搜索词（回车/点搜索才生效，避免每敲一个字都打一次接口）。 */
  const [query, setQuery] = useState('');
  const [orgDepartmentId, setOrgDepartmentId] = useState<string | undefined>(undefined);

  const loadDepartments = useCallback(() => adminApi.orgDepartments.list(), []);
  const departments = usePolling(loadDepartments, 0);

  const loadStaff = useCallback(
    () =>
      adminApi.staffDirectory.list({
        q: query || undefined,
        orgDepartmentId,
        // 列表中保留停用的人：同步停用后管理员仍需看到并核实，而不是凭空消失
        enabledOnly: false,
        limit: 200,
      }),
    [query, orgDepartmentId],
  );
  const { data, error, loading, refresh } = usePolling(loadStaff, 0);

  const [form] = Form.useForm<StaffForm>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StaffEntryDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  /**
   * 统一的失败处理：403 单独呈现在页面内（权限问题要让管理员读到后端给的原因），
   * 其余错误仍走全局提示。
   */
  const handleFailure = (caught: unknown, fallback = '操作失败，请重试'): void => {
    if (caught instanceof ApiError && caught.status === 403) {
      setDenied(caught.message);
      return;
    }
    notify.error(describeError(caught, fallback));
  };

  const departmentOptions = (departments.data?.departments ?? []).map((item) => ({
    value: item.id,
    label: item.enabled ? item.name : `${item.name}（已停用）`,
  }));

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      employeeNo: '',
      name: '',
      gender: null,
      age: null,
      title: '',
      orgDepartmentId: null,
    });
    setModalOpen(true);
  };

  const openEdit = (row: StaffEntryDto): void => {
    setEditing(row);
    form.setFieldsValue({
      employeeNo: row.employeeNo,
      name: row.name,
      gender: row.gender,
      age: row.age,
      title: row.title,
      orgDepartmentId: row.orgDepartmentId,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await adminApi.staffDirectory.update(editing.id, {
          name: values.name,
          gender: values.gender,
          age: values.age,
          title: values.title,
          orgDepartmentId: values.orgDepartmentId,
        });
        notify.success('人员信息已更新');
      } else {
        await adminApi.staffDirectory.create(values);
        notify.success('人员已新增');
      }
      setModalOpen(false);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  /** 停用/启用：同步停用的人若确认仍在岗，可在这里手工恢复。 */
  const toggleEnabled = async (row: StaffEntryDto, enabled: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.staffDirectory.update(row.id, { enabled });
      notify.success(`「${row.name}」已${enabled ? '启用' : '停用'}`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setTogglingId(null);
    }
  };

  const columns: TableColumnsType<StaffEntryDto> = [
    { title: '工号', dataIndex: 'employeeNo', width: 120, className: 'tabular' },
    { title: '姓名', dataIndex: 'name', width: 120 },
    { title: '性别', dataIndex: 'gender', width: 80, render: (value: string | null) => value ?? EMPTY_TEXT },
    {
      title: '年龄',
      dataIndex: 'age',
      width: 80,
      align: 'right',
      className: 'tabular',
      render: (value: number | null) => value ?? EMPTY_TEXT,
    },
    { title: '职称', dataIndex: 'title', width: 140, render: (value: string | null) => value ?? EMPTY_TEXT },
    {
      title: '所属车间',
      dataIndex: 'orgDepartmentName',
      width: 140,
      render: (value: string | null) => value ?? EMPTY_TEXT,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 90,
      render: (enabled: boolean) =>
        enabled ? <Tag color="success">启用</Tag> : <Tag>已停用</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, row: StaffEntryDto) => (
        <Space size="small">
          <Button
            size="small"
            type="link"
            disabled={!canWrite}
            onClick={() => openEdit(row)}
          >
            编辑
          </Button>
          <Popconfirm
            title={row.enabled ? `停用「${row.name}」？` : `启用「${row.name}」？`}
            description={
              row.enabled
                ? '停用后不再出现在打分表选人的结果里，已选进评议的不受影响。'
                : '启用后重新出现在选人搜索结果里。'
            }
            okText="确定"
            cancelText="取消"
            disabled={!canWrite}
            onConfirm={() => void toggleEnabled(row, !row.enabled)}
          >
            <Button size="small" type="link" danger={row.enabled} disabled={!canWrite || togglingId === row.id}>
              {row.enabled ? '停用' : '启用'}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="人员管理"
        description="全所人员目录，打分表选人时从这里搜索。人员数据由外部系统定期同步：按工号认人，姓名重复也不会认错；名册里没有的人只会停用、不会删除，已选进评议的被评议人不会丢姓名。"
        extra={
          <Space>
            {canWrite ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新增人员
              </Button>
            ) : null}
            <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
              刷新
            </Button>
          </Space>
        }
      />

      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索姓名 / 工号 / 车间"
            value={keyword}
            style={{ width: 260 }}
            onChange={(event) => setKeyword(event.target.value)}
            onPressEnter={() => setQuery(keyword.trim())}
          />
          <Select
            allowClear
            placeholder="全部车间"
            style={{ width: 180 }}
            value={orgDepartmentId}
            options={departmentOptions}
            onChange={(value) => setOrgDepartmentId(value ?? undefined)}
          />
          <Button type="primary" onClick={() => setQuery(keyword.trim())}>
            搜索
          </Button>
        </Space>

        {denied ? (
          <Alert type="error" showIcon style={{ marginBottom: 16 }} title={denied} />
        ) : null}

        {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}

        {error && !data ? (
          <ErrorState error={error} onRetry={refresh} />
        ) : loading && !data ? (
          <LoadingState />
        ) : (
          <Table<StaffEntryDto>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={data ?? []}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            locale={{ emptyText: '没有匹配的人员' }}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          共 {data?.length ?? 0} 人（最多显示 200 条，请用搜索缩小范围）。
        </Typography.Paragraph>
      </Card>

      <Modal
        title={editing ? '编辑人员' : '新增人员'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="employeeNo"
            label={
              <HelpLabel
                help={
                  editing
                    ? '工号是外部系统同步时认人的依据，创建后不能修改。'
                    : '外部系统按工号识别是不是同一个人，请照实际工号填写。'
                }
              >
                工号
              </HelpLabel>
            }
            rules={[{ required: true, message: '请填写工号' }]}
          >
            <Input placeholder="如：100238" maxLength={50} disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请填写姓名' }]}>
            <Input placeholder="职工姓名" maxLength={64} />
          </Form.Item>
          <Form.Item name="gender" label="性别">
            <Select
              allowClear
              placeholder="留空表示不填"
              options={[
                { value: '男', label: '男' },
                { value: '女', label: '女' },
              ]}
            />
          </Form.Item>
          <Form.Item name="age" label="年龄">
            <InputNumber min={0} max={150} precision={0} placeholder="留空表示不填" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="title" label="职称">
            <Input placeholder="如：高级工程师" maxLength={50} />
          </Form.Item>
          <Form.Item name="orgDepartmentId" label="所属车间">
            <Select allowClear placeholder="留空表示未归属" options={departmentOptions} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

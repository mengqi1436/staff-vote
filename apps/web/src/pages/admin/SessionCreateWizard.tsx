import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Steps,
  Table,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { type Dayjs } from 'dayjs';
import { useNavigate } from 'react-router';
import {
  adminApi,
  type AdminSessionDto,
  type OrgDepartmentDto,
  type TicketPlanItem,
  type TicketPlanResult,
} from '../../lib/api.js';
import { QuestionnaireGrid } from '../../components/admin/QuestionnaireGrid.js';
import { describeError } from './lib.js';
import { HelpLabel, HelpTip, useNotify } from './shared.js';

/**
 * 新建评议向导（三步）：
 *   ① 基本信息：名称（默认「{部门名}评议」）+ 全局部门 + 开始/结束时间 → 创建评议；
 *   ② 打分表基础表：复用共享打分表网格，所见即所得、即时保存；
 *   ③ 人员类别分配：编码/名称/数量，一次提交建类别与发码。
 *
 * 三步严格按接口契约串联：第 1 步成功才有评议 id，第 2/3 步都作用于这个新评议
 * （显式传 sessionId，不依赖「当前评议」上下文——新建的评议还没被设为当前）。
 */

interface BasicForm {
  name: string;
  orgDepartmentId: string;
  opensAt: Dayjs | null;
  closesAt: Dayjs | null;
}

/** 人员类别规划编辑行（key 仅用于表格 rowKey）。 */
interface PlanRow {
  key: number;
  code: string;
  name: string;
  count: number;
}

export function SessionCreateWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** 第 1 步创建成功后回调（调用方刷新评议列表）；完成/关闭时也会触发列表刷新。 */
  onCreated?: (session: AdminSessionDto) => void;
}) {
  const notify = useNotify();
  const navigate = useNavigate();

  const [current, setCurrent] = useState(0);
  const [form] = Form.useForm<BasicForm>();
  const [creating, setCreating] = useState(false);
  /** 名称是否被管理员手动改过：改过之后不再自动按部门名覆盖默认值 */
  const [nameTouched, setNameTouched] = useState(false);

  /** 全局部门列表（步骤 1 下拉）：打开时拉一次 */
  const [orgDepartments, setOrgDepartments] = useState<OrgDepartmentDto[] | null>(null);
  const [orgLoadError, setOrgLoadError] = useState<string | null>(null);

  /** 第 1 步创建出的评议；存在才能进入第 2/3 步 */
  const [session, setSession] = useState<AdminSessionDto | null>(null);

  // ---- 步骤 3：人员类别规划编辑态 ----
  const [planRows, setPlanRows] = useState<PlanRow[]>([]);
  const [nextRowKey, setNextRowKey] = useState(1);
  const [submittingPlan, setSubmittingPlan] = useState(false);
  const [planResult, setPlanResult] = useState<TicketPlanResult | null>(null);

  const loadOrgDepartments = useCallback(async (): Promise<void> => {
    setOrgLoadError(null);
    try {
      const result = await adminApi.orgDepartments.list();
      setOrgDepartments(result.departments);
    } catch (caught) {
      setOrgLoadError(describeError(caught, '部门列表加载失败'));
    }
  }, []);

  // 每次打开都重置到第 1 步，并重新拉部门列表（管理员可能刚在「部门管理」加了新部门）
  useEffect(() => {
    if (!open) return;
    setCurrent(0);
    setSession(null);
    setPlanResult(null);
    setPlanRows([]);
    setNextRowKey(1);
    setNameTouched(false);
    setOrgDepartments(null);
    form.resetFields();
    void loadOrgDepartments();
  }, [open, form, loadOrgDepartments]);

  const departmentOptions = (orgDepartments ?? []).map((item) => ({
    value: item.id,
    label: item.enabled ? item.name : `${item.name}（已停用）`,
  }));

  /**
   * 表单值变化的统一入口（用 Form 的 onValuesChange 而不是子控件的 onChange：
   * antd 6 的 Form.Item 注入会覆盖子控件自己的 onChange）。
   * - 名称被键入过 → 停止自动填默认值；
   * - 选了部门且名称未键入过 → 自动填「{部门名}评议评议」。
   */
  const handleValuesChange = (changed: Partial<BasicForm>): void => {
    if (changed.name !== undefined) setNameTouched(true);
    if (changed.orgDepartmentId && !nameTouched) {
      const dept = (orgDepartments ?? []).find((item) => item.id === changed.orgDepartmentId);
      if (dept) form.setFieldsValue({ name: `${dept.name}评议` });
    }
  };

  const planReady = planRows.every(
    (row) => row.code.trim() !== '' && row.name.trim() !== '',
  );

  const updateRow = (key: number, patch: Partial<PlanRow>): void => {
    setPlanRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    setPlanRows((prev) => [...prev, { key: nextRowKey, code: '', name: '', count: 0 }]);
    setNextRowKey((value) => value + 1);
  };

  const removeRow = (key: number): void => {
    setPlanRows((prev) => prev.filter((row) => row.key !== key));
  };

  /** 第 1 步：校验 + 创建评议（契约 B），成功进入第 2 步。 */
  const handleCreate = async (): Promise<void> => {
    let values: BasicForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const { opensAt, closesAt } = values;
    if (opensAt && closesAt && closesAt.isBefore(opensAt)) {
      notify.error('结束时间不能早于开始时间');
      return;
    }
    setCreating(true);
    try {
      const result = await adminApi.sessions.create({
        name: values.name.trim(),
        orgDepartmentId: values.orgDepartmentId,
        opensAt: opensAt!.toISOString(),
        closesAt: closesAt ? closesAt.toISOString() : null,
      });
      setSession(result.session);
      notify.success(`评议「${result.session.name}」已创建，继续配置打分表和人员类别`);
      onCreated?.(result.session);
      setCurrent(1);
    } catch (caught) {
      notify.error(describeError(caught, '创建评议失败，请重试'));
    } finally {
      setCreating(false);
    }
  };

  /** 第 3 步：提交人员类别规划（契约 D），成功显示各人员类别发码数与进入工作台入口。 */
  const handlePlanSubmit = async (): Promise<void> => {
    if (!session) return;
    const types: TicketPlanItem[] = planRows.map((row) => ({
      code: row.code.trim(),
      name: row.name.trim(),
      count: Number(row.count) || 0,
    }));
    setSubmittingPlan(true);
    try {
      const result = await adminApi.sessions.ticketPlan(session.id, types);
      setPlanResult(result);
      notify.success('人员类别已保存，随机码已按数量生成');
    } catch (caught) {
      notify.error(describeError(caught, '人员类别保存失败，请重试'));
    } finally {
      setSubmittingPlan(false);
    }
  };

  const handleClose = (): void => {
    onClose();
  };

  const goWorkspace = (): void => {
    if (!session) return;
    handleClose();
    void navigate(`/admin/sessions/${session.id}`);
  };

  const planColumns: TableColumnsType<PlanRow> = [
    {
      title: '编码',
      width: 120,
      render: (_: unknown, row: PlanRow) => (
        <Input
          aria-label={`人员类别编码（第 ${row.key} 行）`}
          value={row.code}
          maxLength={8}
          placeholder="如 A"
          onChange={(event) => updateRow(row.key, { code: event.target.value })}
        />
      ),
    },
    {
      title: '名称',
      render: (_: unknown, row: PlanRow) => (
        <Input
          aria-label={`人员类别名称（第 ${row.key} 行）`}
          value={row.name}
          maxLength={32}
          placeholder="如 职工代表"
          onChange={(event) => updateRow(row.key, { name: event.target.value })}
        />
      ),
    },
    {
      title: '数量（张）',
      width: 140,
      align: 'right',
      render: (_: unknown, row: PlanRow) => (
        <InputNumber
          aria-label={`发码数量（第 ${row.key} 行）`}
          value={row.count}
          min={0}
          precision={0}
          style={{ width: '100%' }}
          onChange={(value) => updateRow(row.key, { count: Number(value) || 0 })}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 88,
      render: (_: unknown, row: PlanRow) => (
        <Popconfirm title="删除该人员类别？" okText="删除" cancelText="取消" onConfirm={() => removeRow(row.key)}>
          <Button size="small" type="link" danger>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Modal
      title="新建评议"
      open={open}
      onCancel={handleClose}
      width={880}
      footer={null}
      destroyOnHidden
    >
      <Steps
        size="small"
        style={{ marginBottom: 24 }}
        current={planResult ? 3 : current}
        items={[
          { title: '基本信息' },
          {
            title: (
              <HelpLabel help="直接在表上修改，离开输入框后自动保存；评议项目行和被评议列的增删也在表上完成。">
                打分表
              </HelpLabel>
            ),
          },
          { title: '人员类别分配' },
        ]}
      />

      {/* 第 1 步：基本信息 */}
      {current === 0 && !planResult ? (
        <>
          <Form<BasicForm>
            form={form}
            layout="vertical"
            requiredMark={false}
            onValuesChange={handleValuesChange}
          >
            <Form.Item
              name="orgDepartmentId"
              label={
                <HelpLabel help="先选部门：本评议用到的部门和打分表表头都会按所选部门自动生成。选项来自「部门管理」里的部门列表；没有需要的部门，先到「部门管理」新增。">
                  部门
                </HelpLabel>
              }
              rules={[{ required: true, message: '请选择部门' }]}
              extra={
                orgLoadError ? `部门列表加载失败：${orgLoadError}（可关闭后重试）` : undefined
              }
            >
              <Select
                placeholder="选择部门"
                aria-label="选择部门"
                options={departmentOptions}
                loading={orgDepartments === null}
                notFoundContent={orgLoadError ?? '暂无部门'}
              />
            </Form.Item>
            <Form.Item
              name="name"
              label="评议名称"
              rules={[
                { required: true, message: '请输入评议名称' },
                { min: 1, max: 64, message: '长度需在 1-64 字符之间' },
              ]}
            >
              <Input placeholder="选择部门后自动填写，可修改" maxLength={64} />
            </Form.Item>
            <Space size={16} align="start" style={{ display: 'flex' }}>
              <Form.Item
                name="opensAt"
                label="开始时间"
                rules={[{ required: true, message: '请选择开始时间' }]}
                style={{ flex: 1 }}
              >
                <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="closesAt"
                label="结束时间"
                style={{ flex: 1 }}
              >
                <DatePicker
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  placeholder="留空 = 永久开放"
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Space>
          </Form>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>取消</Button>
            <Button type="primary" loading={creating} onClick={() => void handleCreate()}>
              创建并配置打分表
            </Button>
          </div>
        </>
      ) : null}

      {/* 第 2 步：打分表基础表（共享网格，即时保存） */}
      {current === 1 && session ? (
        <>
          <div style={{ maxHeight: 480, overflow: 'auto', marginBottom: 16 }}>
            <QuestionnaireGrid sessionId={session.id} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setCurrent(0)}>上一步</Button>
            <Button type="primary" onClick={() => setCurrent(2)}>
              下一步：人员类别分配
            </Button>
          </div>
        </>
      ) : null}

      {/* 第 3 步：人员类别分配 */}
      {current === 2 && session && !planResult ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <Typography.Text strong>分配人员类别</Typography.Text>
            <HelpTip text="这次提交的人员类别就是全部启用的类别：表里没有的旧类别会被停用。数量填 0 表示只建类别、不发随机码。已经有答卷的人员类别不能改编码（随机码和答卷都按编码对应）。这里发出的随机码不分部门；要按部门定点发放，请到「随机码」页签。" />
          </div>
          <Table<PlanRow>
            rowKey="key"
            size="small"
            columns={planColumns}
            dataSource={planRows}
            pagination={false}
            locale={{
              emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有人员类别，点击下方「添加人员类别」开始" />
              ),
            }}
          />
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 12,
              marginTop: 12,
              marginBottom: 16,
            }}
          >
            <Button icon={<PlusOutlined />} onClick={addRow}>
              添加人员类别
            </Button>
            {!planReady && planRows.length > 0 ? (
              <Typography.Text type="secondary">每行都需填写编码与名称</Typography.Text>
            ) : null}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setCurrent(1)}>上一步</Button>
            <Button
              type="primary"
              loading={submittingPlan}
              disabled={!planReady || planRows.length === 0}
              onClick={() => void handlePlanSubmit()}
            >
              保存人员类别并生成随机码
            </Button>
          </div>
        </>
      ) : null}

      {/* 完成态：显示各人员类别发码数与进入工作台入口 */}
      {planResult ? (
        <>
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            title="评议配置完成"
            description="可以进入工作台导出或打印随机码，或点「开始投票」开放本次评议。"
          />
          <Table<TicketPlanResult['generated'][number]>
            rowKey="ticketTypeId"
            size="small"
            pagination={false}
            columns={[
              {
                title: '人员类别',
                key: 'type',
                render: (_, row) => typeLabel(planResult, row.ticketTypeId),
              },
              {
                title: '本批发码',
                dataIndex: 'count',
                width: 120,
                align: 'right',
                render: (value: number) => <span className="tabular">{value} 张</span>,
              },
            ]}
            dataSource={planResult.generated}
            locale={{ emptyText: '没有生成随机码（所有人员类别数量都是 0），可以稍后在工作台「随机码」页签发放' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Button onClick={handleClose}>留在评议列表</Button>
            <Button type="primary" onClick={goWorkspace}>
              进入工作台
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

/** 完成态里把 ticketTypeId 翻译成「名称（编码）」——数据来自提交返回的 ticketTypes。 */
function typeLabel(result: TicketPlanResult, id: string): string {
  const type = result.ticketTypes.find((item) => item.id === id);
  return type ? `${type.name}（${type.code}）` : id;
}

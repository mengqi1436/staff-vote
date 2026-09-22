import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Tooltip,
} from 'antd';
import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  ApiError,
  adminApi,
  type CriterionDto,
  type DepartmentAdminDto,
  type EmployeeDto,
  type VoteColumnDto,
} from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError } from './lib.js';
import {
  ErrorState,
  LoadingState,
  NextStep,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

/**
 * 问卷配置（评议准备第 2 步）——附件8.问卷调查表.xlsx 的所见即所得版式。
 *
 * 页面主体就是那张 Excel 表，与 docs/附件文件包/附件8.问卷调查表.xlsx 完全同构：
 *   附件号 → 表标题 → 表头（序号 / 职务与姓名斜线格 / 各被评列）→ 项点行 → 填写说明。
 * 版式细节（宋体、字号、行高、列宽、带框/无框行、斜线表头）见 global.css 的 .sheet-excel 段。
 *
 * 配置直接在表上编辑，失焦自动保存：
 *   - 附件号：单元格内联输入（departments.write）；
 *   - 表标题：标题中的「xx」是内嵌的部门下拉框，选谁就显示并编辑谁的问卷；
 *     标题其余文字悬停后点铅笔编辑（保存的仍是含 xx 占位的完整标题）；
 *   - 被评列：列头内联输入改名、悬停 × 删除（criteria.write），新增在页头按钮；
 *   - 问卷类型：页头 Segmented 切换，个人问卷（双行表头）↔ 车间问卷（单行表头）；
 *   - 填写说明：悬停点铅笔编辑，展示态还原原表的关键词富文本（满分20分/0分 红粗）。
 * 项点（表的行）在「评分项点」页配置，这里只读展示。
 *
 * 前端权限只是体验层门控，真正的防线在后端。
 */

/** 新增被评列表单的字段。 */
interface ColumnForm {
  name: string;
  sortOrder: number;
}

/**
 * 填写说明的关键词富文本：与附件8一致，「满分20分」「0分」红色加粗，「弃权」「不填」加粗。
 * 说明是自由文本，按关键词匹配还原原表的重点标注。
 */
function renderFooterNote(text: string): ReactNode[] {
  return text.split(/(满分20分|0分|弃权|不填)/g).map((part, index) => {
    if (part === '满分20分' || part === '0分') {
      return (
        <strong key={index} className="note-red">
          {part}
        </strong>
      );
    }
    if (part === '弃权' || part === '不填') {
      return <strong key={index}>{part}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

/** 单元格内的常驻无框输入：像 Excel 一样点进去改，失焦时值有变化才提交。 */
function InlineInput({
  value,
  onCommit,
  disabled,
  ariaLabel,
  className,
  placeholder,
  multiline = false,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  /** 多行文本（项点描述），回车换行、失焦提交。 */
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };

  if (multiline) {
    return (
      <Input.TextArea
        variant="borderless"
        className={className}
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoSize={{ minRows: 1, maxRows: 6 }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    );
  }

  return (
    <Input
      variant="borderless"
      className={className}
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onPressEnter={(event) => event.currentTarget.blur()}
      onBlur={commit}
    />
  );
}

export function AdminQuestionnaire() {
  const { sessionId } = useAdminSession();
  const departments = usePolling(
    useCallback(() => adminApi.departments.list({ sessionId }), [sessionId]),
    0,
  );

  /**
   * 部门选择同步到 URL（?departmentId=xxx）：
   * 刷新后恢复上次正在配置的部门——否则每次刷新都退回列表第一个部门，
   * 管理员配了一半的问卷会「凭空消失」（其实是换到了没配置的部门）。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const departmentId = searchParams.get('departmentId') ?? '';
  const selectDepartment = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('departmentId', id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // URL 里没有部门时（首次进入）默认选中第一个，避免管理员每次都要手点
  useEffect(() => {
    if (!departmentId && departments.data?.length) {
      selectDepartment(departments.data[0]?.id ?? '');
    }
  }, [departments.data, departmentId, selectDepartment]);

  const loadColumns = useCallback(
    () =>
      departmentId
        ? adminApi.voteColumns.list(departmentId, sessionId)
        : Promise.resolve<VoteColumnDto[]>([]),
    [departmentId, sessionId],
  );
  const columns = usePolling(loadColumns, 0);

  const loadCriteria = useCallback(
    () =>
      departmentId
        ? adminApi.criteria.list(departmentId, sessionId)
        : Promise.resolve<CriterionDto[]>([]),
    [departmentId, sessionId],
  );
  const criteria = usePolling(loadCriteria, 0);

  // 职工名单：被评列第二行「职务与姓名」里选人用的候选池
  const loadEmployees = useCallback(
    () =>
      departmentId
        ? adminApi.employees.list(departmentId, sessionId)
        : Promise.resolve<EmployeeDto[]>([]),
    [departmentId, sessionId],
  );
  const employees = usePolling(loadEmployees, 0);

  const notify = useNotify();
  const { can } = useAuth();
  const canWriteDepartment = can('departments.write');
  const canWriteColumn = can('criteria.write');

  const [denied, setDenied] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingFooter, setEditingFooter] = useState(false);
  const [footerDraft, setFooterDraft] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [columnForm] = Form.useForm<ColumnForm>();

  const current: DepartmentAdminDto | null =
    departments.data?.find((item) => item.id === departmentId) ?? null;
  const isWorkshop = current?.questionnaireType === 'workshop';

  const handleFailure = (caught: unknown, fallback = '操作失败，请重试'): void => {
    if (caught instanceof ApiError && caught.status === 403) {
      setDenied(caught.message);
      return;
    }
    notify.error(describeError(caught, fallback));
  };

  /** 抬头配置统一走部门 PATCH；成功后刷新部门数据让表格回显最新值。 */
  const saveHeader = async (patch: {
    questionnaireType?: string;
    headerNote?: string;
    title?: string;
    footerNote?: string;
  }): Promise<void> => {
    if (!departmentId) return;
    try {
      await adminApi.departments.update(departmentId, patch);
      departments.refresh();
    } catch (caught) {
      handleFailure(caught, '保存失败，请重试');
    }
  };

  const startTitleEdit = (): void => {
    if (!current || !canWriteDepartment) return;
    setTitleDraft(current.title);
    setEditingTitle(true);
  };

  const commitTitle = (): void => {
    setEditingTitle(false);
    if (current && titleDraft.trim() !== '' && titleDraft !== current.title) {
      void saveHeader({ title: titleDraft });
    }
  };

  const startFooterEdit = (): void => {
    if (!current || !canWriteDepartment) return;
    setFooterDraft(current.footerNote);
    setEditingFooter(true);
  };

  const commitFooter = (): void => {
    setEditingFooter(false);
    if (current && footerDraft !== current.footerNote) {
      void saveHeader({ footerNote: footerDraft });
    }
  };

  const saveColumnName = async (row: VoteColumnDto, name: string): Promise<void> => {
    if (name.trim() === '' || name === row.name) return;
    try {
      await adminApi.voteColumns.update(row.id, { name: name.trim() });
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  /** 表头第二行选人：提交到被评列，null = 清除已选人员。 */
  const saveColumnEmployee = async (row: VoteColumnDto, employeeId: string | null): Promise<void> => {
    if (employeeId === row.employeeId) return;
    try {
      await adminApi.voteColumns.update(row.id, { employeeId });
      notify.success(`「${row.name}」被评人已更新`);
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  /** 项点行内联编辑：名称与描述直接 PATCH 项点，描述空串清除为 null。 */
  const saveCriterion = async (
    row: CriterionDto,
    patch: { name?: string; description?: string | null },
  ): Promise<void> => {
    try {
      await adminApi.criteria.update(row.id, patch);
      criteria.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const removeColumn = async (row: VoteColumnDto): Promise<void> => {
    try {
      await adminApi.voteColumns.remove(row.id);
      notify.success(`已删除「${row.name}」`);
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const handleColumnSubmit = async (): Promise<void> => {
    if (!departmentId) {
      notify.error('请先选择部门');
      return;
    }
    let values: ColumnForm;
    try {
      values = await columnForm.validateFields();
    } catch {
      return;
    }
    try {
      await adminApi.voteColumns.create({ departmentId, ...values }, sessionId);
      notify.success(`被评列「${values.name}」已创建`);
      setModalOpen(false);
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const openCreate = (): void => {
    columnForm.resetFields();
    columnForm.setFieldsValue({ name: '', sortOrder: (columns.data?.length ?? 0) + 1 });
    setModalOpen(true);
  };

  // 只显示启用的被评列：删除是软删（历史评分保留），表上不应再出现
  const voteColumns = (columns.data ?? []).filter((column) => column.enabled);
  const enabledCriteria = (criteria.data ?? []).filter((item) => item.enabled);
  const columnCount = 2 + voteColumns.length;
  const departmentOptions = (departments.data ?? []).map((item) => ({
    value: item.id,
    label: item.enabled ? item.name : `${item.name}（已停用）`,
  }));

  /**
   * 表标题按「xx」占位拆分：xx 段渲染成内嵌的部门下拉框（本题意要求），
   * 其余段原样展示。标题为空或不含占位符时，下拉退回到标题行末尾，
   * 保证任何时候都能通过它切换部门。
   */
  const titleSegments = (current?.title ?? '').split(/(xx|XX)/);
  const hasDeptSlot = titleSegments.some((segment) => segment === 'xx' || segment === 'XX');

  return (
    <>
      <PageHeader
        title="问卷配置"
        description="与附件8.问卷调查表完全一致的 Excel 版式：直接在表上改，失焦自动保存。项点（表的行）在「评分项点」页配置。"
        extra={
          <Space size={8} wrap>
            <Segmented
              aria-label="问卷类型"
              value={current?.questionnaireType ?? 'person'}
              disabled={!current || !canWriteDepartment}
              options={[
                { value: 'person', label: '个人问卷' },
                { value: 'workshop', label: '车间问卷' },
              ]}
              onChange={(value) => void saveHeader({ questionnaireType: String(value) })}
            />
            {canWriteColumn ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!current}
                onClick={openCreate}
              >
                新增被评列
              </Button>
            ) : null}
            <Button
              icon={<ReloadOutlined />}
              loading={
                departments.loading || columns.loading || criteria.loading || employees.loading
              }
              onClick={() => {
                departments.refresh();
                columns.refresh();
                criteria.refresh();
                employees.refresh();
              }}
            >
              刷新
            </Button>
          </Space>
        }
      />

      {denied ? (
        <Alert
          type="error"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          title="操作被拒绝"
          description={denied}
          onClose={() => setDenied(null)}
        />
      ) : null}

      {departments.error && !departments.data ? (
        <ErrorState error={departments.error} onRetry={departments.refresh} />
      ) : null}
      {columns.error && columns.data ? (
        <StaleDataAlert error={columns.error} onRetry={columns.refresh} />
      ) : null}
      {criteria.error && criteria.data ? (
        <StaleDataAlert error={criteria.error} onRetry={criteria.refresh} />
      ) : null}

      {departments.data === null ? (
        <LoadingState />
      ) : !current ? (
        <Alert type="info" showIcon title="请先选择部门" description="每个部门各有一套问卷配置。" />
      ) : (
        <div className="sheet-wrap">
          {/*
            版式与附件8.问卷调查表.xlsx 同构：
              附件号行（黑体，无框）→ 标题行（宋体 16pt 粗体，无框）→ [空行，仅个人问卷]
              → 表头（有框；个人问卷两行，序号与斜线格跨行）→ 项点行（有框，只读）
              → 填写说明行（无框，关键词富文本）。
          */}
          <table className={`sheet-excel ${isWorkshop ? 'is-workshop' : 'is-person'}`}>
            <colgroup>
              <col className="col-no" />
              <col className="col-criterion" />
              {voteColumns.map((column) => (
                <col key={column.id} className="col-score" />
              ))}
            </colgroup>
            <tbody>
              {/* 附件号（原表 A1:B1 合并，黑体左对齐，无框） */}
              <tr className="row-caption">
                <td colSpan={columnCount}>
                  <InlineInput
                    ariaLabel="附件号"
                    value={current.headerNote}
                    disabled={!canWriteDepartment}
                    className="cell-inline-input"
                    placeholder="点击填写附件号，如：附件1-1"
                    onCommit={(next) => void saveHeader({ headerNote: next.trim() })}
                  />
                </td>
              </tr>

              {/* 表标题（原表 A2 合并整行，居中 16pt 粗体，无框；xx 是部门下拉） */}
              <tr className="row-title">
                <td colSpan={columnCount}>
                  {editingTitle ? (
                    <Input
                      autoFocus
                      variant="borderless"
                      aria-label="表标题"
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onPressEnter={(event) => event.currentTarget.blur()}
                      onBlur={commitTitle}
                      className="cell-inline-input"
                      style={{ textAlign: 'center', fontWeight: 700, fontSize: 21 }}
                    />
                  ) : (
                    <span className="title-text">
                      {titleSegments.map((segment, index) =>
                        segment === 'xx' || segment === 'XX' ? (
                          <Select
                            key={`dept-${index}`}
                            className="title-dept"
                            aria-label="选择部门"
                            variant="borderless"
                            value={departmentId || undefined}
                            onChange={(value) => selectDepartment(value)}
                            options={departmentOptions}
                            loading={departments.loading}
                            style={{
                              width: `${Math.max(3, (current.name.length ?? 3) + 2)}em`,
                            }}
                          />
                        ) : (
                          <span key={`seg-${index}`}>{segment}</span>
                        ),
                      )}
                      {!hasDeptSlot ? (
                        <Select
                          className="title-dept"
                          aria-label="选择部门"
                          variant="borderless"
                          placeholder="选择部门"
                          value={departmentId || undefined}
                          onChange={(value) => selectDepartment(value)}
                          options={departmentOptions}
                          loading={departments.loading}
                          style={{ width: '9em' }}
                        />
                      ) : null}
                      {canWriteDepartment ? (
                        <Tooltip title="编辑标题（xx 为部门下拉占位）">
                          <Button
                            type="text"
                            size="small"
                            aria-label="编辑标题"
                            className="sheet-edit-btn"
                            icon={<EditOutlined />}
                            onClick={startTitleEdit}
                          />
                        </Tooltip>
                      ) : null}
                    </span>
                  )}
                </td>
              </tr>

              {/* 原表个人问卷在标题与表头之间有一行空行（第 3 行），车间问卷没有 */}
              {isWorkshop ? null : (
                <tr className="row-spacer" aria-hidden="true">
                  <td colSpan={columnCount} />
                </tr>
              )}

              {/* 表头：个人问卷两行（序号、斜线格跨行）；车间问卷单行（序号 | 项点 | 得分…） */}
              <tr className="row-head">
                <th rowSpan={isWorkshop ? 1 : 2} className="cell-no">
                  序号
                </th>
                {isWorkshop ? (
                  <th>项点</th>
                ) : (
                  <th rowSpan={2} className="cell-diag">
                    {/*
                      斜线按原表 diagonalDown：从左上角到右下角的贴角直线。
                      linear-gradient(to bottom right) 的分界线垂直于对角线（方向反），
                      所以用 SVG 直线精确贴角：百分比端点随格子尺寸拉伸。
                    */}
                    <svg className="diag-line" aria-hidden="true">
                      <line x1="0" y1="0" x2="100%" y2="100%" stroke="#000" strokeWidth="1" />
                    </svg>
                    <span className="diag-name">职务与姓名</span>
                    <span className="diag-criterion">评价项点</span>
                  </th>
                )}
                {voteColumns.map((column) => (
                  <th key={column.id} className="cell-col-head">
                    <InlineInput
                      ariaLabel={`被评列：${column.name}`}
                      value={column.name}
                      disabled={!canWriteColumn}
                      className="col-name-input"
                      onCommit={(next) => void saveColumnName(column, next)}
                    />
                    {canWriteColumn ? (
                      <Popconfirm
                        title={`删除「${column.name}」？`}
                        description="删除即停用：该列不再出现在打分表，历史评分保留。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void removeColumn(column)}
                      >
                        <Button
                          type="text"
                          size="small"
                          danger
                          aria-label={`删除「${column.name}」`}
                          className="col-remove"
                        >
                          ×
                        </Button>
                      </Popconfirm>
                    ) : null}
                  </th>
                ))}
              </tr>
              {isWorkshop
                ? null
                : // 原表第 5 行：列名下方的「姓名」格——电子版在这里为该职务选择具体被评人，
                  // 打印空白表时留空；被评列为空时保留一格避免整行高度塌陷
                  (
                    <tr className="row-head row-head2">
                      {voteColumns.length === 0 ? (
                        <td colSpan={1} />
                      ) : (
                        voteColumns.map((column) => {
                          /* 一个人只担任一个职务：已被其他列选中的人员从本列下拉中排除
                             （本列自己选中的保留，允许换人）。后端仍会校验，这里是体验层。 */
                          const takenByOthers = new Set(
                            voteColumns
                              .filter((other) => other.id !== column.id && other.employeeId)
                              .map((other) => other.employeeId as string),
                          );
                          return (
                            <td key={column.id}>
                              <Select
                                className="col-employee-select"
                                aria-label={`${column.name}被评人`}
                                variant="borderless"
                                showSearch
                                optionFilterProp="label"
                                allowClear
                                placeholder="选择人员"
                                value={column.employeeId ?? undefined}
                                onChange={(value) => void saveColumnEmployee(column, value ?? null)}
                                options={(employees.data ?? [])
                                  .filter(
                                    (employee) =>
                                      employee.enabled && !takenByOthers.has(employee.id),
                                  )
                                  .map((employee) => ({
                                    value: employee.id,
                                    label: employee.name,
                                  }))}
                                loading={employees.loading}
                                disabled={!canWriteColumn}
                              />
                            </td>
                          );
                        })
                      )}
                    </tr>
                  )}

              {/* 项点行：名称与描述在表上直接编辑（对应「评分项点」的数据），失焦自动保存 */}
              {enabledCriteria.map((criterion, index) => (
                <tr key={criterion.id} className="row-criterion">
                  <td className="cell-no">{index + 1}</td>
                  <th className="cell-criterion">
                    <div className="criterion-name">
                      <InlineInput
                        ariaLabel={`项点名称：${criterion.name}`}
                        value={criterion.name}
                        disabled={!canWriteColumn}
                        className="criterion-name-input"
                        placeholder="点击填写项点名称"
                        onCommit={(next) => {
                          const name = next.trim();
                          if (name !== '') void saveCriterion(criterion, { name });
                        }}
                      />
                      <span aria-hidden="true">：</span>
                    </div>
                    <InlineInput
                      multiline
                      ariaLabel={`项点描述：${criterion.name}`}
                      value={criterion.description ?? ''}
                      disabled={!canWriteColumn}
                      className="criterion-desc-input"
                      placeholder="点击填写描述"
                      onCommit={(next) =>
                        void saveCriterion(criterion, {
                          description: next.trim() === '' ? null : next,
                        })
                      }
                    />
                  </th>
                  {voteColumns.map((column) => (
                    <td key={column.id} aria-hidden="true" />
                  ))}
                </tr>
              ))}
              {enabledCriteria.length === 0 ? (
                <tr className="row-criterion">
                  <td className="cell-no">1</td>
                  <th className="cell-criterion" colSpan={columnCount - 1}>
                    <span className="sheet-placeholder">
                      尚未配置项点。请到「评分项点」页配置打分表的行。
                    </span>
                  </th>
                </tr>
              ) : null}

              {/* 填写说明（原表末行合并整行，无框；展示态还原原表关键词富文本） */}
              <tr className="row-footer">
                <td colSpan={columnCount}>
                  {editingFooter ? (
                    <Input.TextArea
                      autoFocus
                      variant="borderless"
                      aria-label="填写说明"
                      value={footerDraft}
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      onChange={(event) => setFooterDraft(event.target.value)}
                      onBlur={commitFooter}
                      onPressEnter={(event) => event.currentTarget.blur()}
                    />
                  ) : (
                    <span>
                      {current.footerNote === '' ? (
                        <span className="sheet-placeholder">点击编辑填写说明</span>
                      ) : (
                        renderFooterNote(current.footerNote)
                      )}
                      {canWriteDepartment ? (
                        <Tooltip title="编辑填写说明">
                          <Button
                            type="text"
                            size="small"
                            aria-label="编辑填写说明"
                            className="sheet-edit-btn"
                            icon={<EditOutlined />}
                            onClick={startFooterEdit}
                          />
                        </Tooltip>
                      ) : null}
                    </span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <Modal
        title="新增被评列"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleColumnSubmit()}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        // columnForm 在页面加载时就创建了，Modal 关闭时也保持 Form 挂载，消除 useForm 未连接警告
        forceRender
      >
        <Form form={columnForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="列名"
            rules={[{ required: true, message: '请输入列名' }]}
            extra="表头原样显示这个名字，例如：主任"
          >
            <Input placeholder="例如：主任" maxLength={50} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序" extra="数字小的排在前面，即打分表靠左的列">
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <NextStep to="/admin/criteria">评分项点</NextStep>
    </>
  );
}

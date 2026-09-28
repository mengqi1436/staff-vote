import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Input, Popconfirm, Segmented, Select, Tooltip } from 'antd';
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
import { usePolling } from '../../lib/usePolling.js';
import { describeError } from '../../pages/admin/lib.js';
import { useNotify } from '../../pages/admin/shared.js';

/**
 * 问卷网格（附件8.问卷调查表.xlsx 的所见即所得版式）——工作台「问卷」页签与
 * 新建场次向导第 2 步的共享组件。
 *
 * 组件完全自治：按传入的场次拉取场内部门/被评列/项点/职工名单，配置直接在表上
 * 编辑、失焦自动保存。相比旧「问卷配置」页多承接了两件事（原「部门」「项点」
 * 页签并入本网格）：
 *   - 项点（表的行）：行内新增（表尾草稿行）/删除/上移/下移，走 criteria API；
 *   - 被评列（表的列）：表尾空列头内联输入创建，不再跳页或弹窗。
 *
 * 版式与 docs/附件文件包/附件8.问卷调查表.xlsx 同构，细节见 global.css 的
 * .sheet-excel 段（版式基准不可动，本组件不携带任何版式覆盖，只用既有 class）。
 * 前端权限只是体验层门控，真正的防线在后端。
 */

/** 填写说明的关键词富文本：与附件8一致，「满分20分」「0分」红色加粗，「弃权」「不填」加粗。 */
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
  autoFocus = false,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  /** 多行文本（项点描述），回车换行、失焦提交。 */
  multiline?: boolean;
  /** 表尾草稿行需要自动聚焦，直接开写。 */
  autoFocus?: boolean;
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
        autoFocus={autoFocus}
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
      autoFocus={autoFocus}
      onChange={(event) => setDraft(event.target.value)}
      onPressEnter={(event) => event.currentTarget.blur()}
      onBlur={commit}
    />
  );
}

/** 项点行内的小操作按钮：悬停该行才出现（复用 .sheet-edit-btn 的淡入），不破坏版面。 */
function SheetAction({
  title,
  ariaLabel,
  icon,
  danger,
  disabled,
  onClick,
}: {
  title: string;
  ariaLabel: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={title}>
      <Button
        type="text"
        size="small"
        danger={danger}
        disabled={disabled}
        aria-label={ariaLabel}
        className="sheet-edit-btn"
        icon={icon}
        onClick={onClick}
      />
    </Tooltip>
  );
}

export function QuestionnaireGrid({
  sessionId,
  departmentId: controlledDepartmentId,
  onDepartmentChange,
}: {
  sessionId: string | null;
  /** 受控当前部门（工作台问卷页用 URL 同步传入）；不传时组件自选第一个部门。 */
  departmentId?: string;
  onDepartmentChange?: (id: string) => void;
}) {
  // 轻量轮询部门列表（标题下拉的数据源）：部门管理页新增/停用部门后，
  // 无需刷新或切换，下拉选项在 10s 内自动联动；切换部门时另有 refresh 兜底。
  const departments = usePolling(
    useCallback(() => adminApi.departments.list({ sessionId }), [sessionId]),
    10000,
  );

  // 当前部门：传了受控值就完全跟随，否则内部维护（默认选第一个，管理员少点一次）
  const [internalDepartmentId, setInternalDepartmentId] = useState('');
  const departmentId = controlledDepartmentId ?? internalDepartmentId;
  const selectDepartment = useCallback(
    (id: string) => {
      if (onDepartmentChange) onDepartmentChange(id);
      else setInternalDepartmentId(id);
    },
    [onDepartmentChange],
  );
  useEffect(() => {
    if (!departmentId && departments.data?.length) {
      selectDepartment(departments.data[0]?.id ?? '');
    }
  }, [departments.data, departmentId, selectDepartment]);

  // 切换部门时重新拉取部门列表：抬头（标题/说明/类型）来自列表缓存，
  // 部门配置可能已在别处（其他页面、接口调用）被修改，切换时刷新以回显最新值；
  // 同时收起编辑态，避免上一个部门的编辑草稿 blur 时误写入新部门。
  const lastLoadedDepartmentId = useRef('');
  useEffect(() => {
    if (departmentId && lastLoadedDepartmentId.current !== departmentId) {
      lastLoadedDepartmentId.current = departmentId;
      departments.refresh();
      setEditingTitle(false);
      setEditingFooter(false);
    }
  }, [departmentId, departments]);

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
  /** 表尾新增项点的草稿行开关。 */
  const [criterionDraft, setCriterionDraft] = useState(false);
  /** 新增被评列草稿的重置序号：仅创建成功后递增，重挂载输入框清空草稿。 */
  const [columnDraftSeq, setColumnDraftSeq] = useState(0);

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

  /** 表尾空列头内联新增被评列：输入列名失焦即创建（排序取现有列数 + 1）。 */
  const commitNewColumn = async (name: string): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || !departmentId) return;
    try {
      await adminApi.voteColumns.create(
        { departmentId, name: trimmed, sortOrder: (columns.data?.length ?? 0) + 1 },
        sessionId,
      );
      notify.success(`被评列「${trimmed}」已创建`);
      setColumnDraftSeq((value) => value + 1);
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  /** 表尾草稿行新增项点：默认分值区间 0～100（与旧「评分项点」页新建默认一致）。 */
  const commitDraftCriterion = async (name: string): Promise<void> => {
    setCriterionDraft(false);
    const trimmed = name.trim();
    if (!trimmed || !departmentId) return;
    try {
      await adminApi.criteria.create(
        {
          departmentId,
          name: trimmed,
          description: null,
          minScore: 0,
          maxScore: 100,
          sortOrder:
            (criteria.data ?? []).reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1,
        },
        sessionId,
      );
      notify.success(`项点「${trimmed}」已新增，可在表上继续补描述`);
      criteria.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  /** 删除项点：软删除（停用），历史评分保留，可到后端再启用。 */
  const removeCriterion = async (row: CriterionDto): Promise<void> => {
    try {
      await adminApi.criteria.remove(row.id);
      notify.success(`已删除「${row.name}」`);
      criteria.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  /**
   * 上移/下移：与相邻行互换 sortOrder（两个 PATCH 串行提交）。
   * ponytail: 若历史数据两行 sortOrder 相同，互换后顺序不变——需要重排全表时再换成
   * 逐行重写 sortOrder 的实现。
   */
  const moveCriterion = async (index: number, direction: -1 | 1): Promise<void> => {
    const currentRow = enabledCriteria[index];
    const targetRow = enabledCriteria[index + direction];
    if (!currentRow || !targetRow) return;
    try {
      await adminApi.criteria.update(currentRow.id, { sortOrder: targetRow.sortOrder });
      await adminApi.criteria.update(targetRow.id, { sortOrder: currentRow.sortOrder });
      criteria.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  // 只显示启用的被评列：删除是软删（历史评分保留），表上不应再出现
  const voteColumns = (columns.data ?? []).filter((column) => column.enabled);
  const enabledCriteria = (criteria.data ?? []).filter((item) => item.enabled);
  // 表尾空列头（内联新增被评列）：只有可写时出现
  const canAddColumn = canWriteColumn && Boolean(current);
  const columnCount = 2 + voteColumns.length + (canAddColumn ? 1 : 0);
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

      {/* 网格上方的两件常驻控件：问卷类型切换（即时保存）与手动刷新 */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
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
      </div>

      {!current ? (
        <Alert type="info" showIcon title="请先选择部门" description="每个部门各有一套问卷配置。" />
      ) : (
        <div className="sheet-wrap">
          {/*
            版式与附件8.问卷调查表.xlsx 同构：
              附件号行（黑体，无框）→ 标题行（宋体 16pt 粗体，无框）→ [空行，仅个人问卷]
              → 表头（有框；个人问卷两行，序号与斜线格跨行）→ 项点行（有框，可直接编辑）
              → 填写说明行（无框，关键词富文本）。
          */}
          <table className={`sheet-excel ${isWorkshop ? 'is-workshop' : 'is-person'}`}>
            <colgroup>
              <col className="col-no" />
              <col className="col-criterion" />
              {voteColumns.map((column) => (
                <col key={column.id} className="col-score" />
              ))}
              {canAddColumn ? <col className="col-score" /> : null}
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
                {canAddColumn ? (
                  <th className="cell-col-head">
                    {/* 表尾空列头：输入列名失焦即创建（契约：新增被评列不再跳页/弹窗）。
                        key 绑定重置序号：创建成功后重挂载清空草稿，失败保留便于改错重试。 */}
                    <InlineInput
                      key={columnDraftSeq}
                      ariaLabel="新增被评列"
                      value=""
                      className="col-name-input"
                      placeholder="＋ 新增列"
                      onCommit={(next) => void commitNewColumn(next)}
                    />
                  </th>
                ) : null}
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
                      {canAddColumn ? <td aria-hidden="true" /> : null}
                    </tr>
                  )}

              {/* 项点行：名称与描述在表上直接编辑（失焦自动保存）；
                  行内右上角悬停操作：上移 / 下移 / 删除，新增在表尾草稿行 */}
              {enabledCriteria.map((criterion, index) => (
                <tr key={criterion.id} className="row-criterion">
                  <td className="cell-no">{index + 1}</td>
                  <th className="cell-criterion" style={{ position: 'relative' }}>
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
                    {canWriteColumn ? (
                      <span
                        style={{ position: 'absolute', top: 2, right: 2, display: 'inline-flex' }}
                      >
                        <SheetAction
                          title="上移"
                          ariaLabel={`上移「${criterion.name}」`}
                          disabled={index === 0}
                          icon="↑"
                          onClick={() => void moveCriterion(index, -1)}
                        />
                        <SheetAction
                          title="下移"
                          ariaLabel={`下移「${criterion.name}」`}
                          disabled={index === enabledCriteria.length - 1}
                          icon="↓"
                          onClick={() => void moveCriterion(index, 1)}
                        />
                        <SheetAction
                          title="在此行下方新增"
                          ariaLabel={`在「${criterion.name}」下方新增项点`}
                          icon={<PlusOutlined />}
                          onClick={() => setCriterionDraft(true)}
                        />
                        <Popconfirm
                          title={`删除「${criterion.name}」？`}
                          description="删除即停用：该行不再出现在打分表，历史评分保留。"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() => void removeCriterion(criterion)}
                        >
                          <Tooltip title="删除">
                            <Button
                              type="text"
                              size="small"
                              danger
                              aria-label={`删除「${criterion.name}」`}
                              className="sheet-edit-btn"
                              icon="×"
                            />
                          </Tooltip>
                        </Popconfirm>
                      </span>
                    ) : null}
                  </th>
                  {voteColumns.map((column) => (
                    <td key={column.id} aria-hidden="true" />
                  ))}
                  {canAddColumn ? <td aria-hidden="true" /> : null}
                </tr>
              ))}

              {/* 表尾草稿行：输入名称失焦即新增（留空取消）；只有可写且已选部门时出现 */}
              {canWriteColumn && current && criterionDraft ? (
                <tr className="row-criterion">
                  <td className="cell-no">{enabledCriteria.length + 1}</td>
                  <th className="cell-criterion">
                    <div className="criterion-name">
                      <InlineInput
                        autoFocus
                        ariaLabel="新增项点名称"
                        value=""
                        className="criterion-name-input"
                        placeholder="输入名称，失焦新增；留空取消"
                        onCommit={(next) => void commitDraftCriterion(next)}
                      />
                      <span aria-hidden="true">：</span>
                    </div>
                  </th>
                  {voteColumns.map((column) => (
                    <td key={column.id} aria-hidden="true" />
                  ))}
                  {canAddColumn ? <td aria-hidden="true" /> : null}
                </tr>
              ) : null}

              {enabledCriteria.length === 0 && !criterionDraft ? (
                <tr className="row-criterion">
                  <td className="cell-no">1</td>
                  <th className="cell-criterion" colSpan={columnCount - 1}>
                    {canWriteColumn ? (
                      <Button
                        type="text"
                        size="small"
                        icon={<PlusOutlined />}
                        aria-label="新增项点"
                        onClick={() => setCriterionDraft(true)}
                      >
                        新增项点
                      </Button>
                    ) : (
                      <span className="sheet-placeholder">尚未配置项点，请先新增打分表的行。</span>
                    )}
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
    </>
  );
}

import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useAdminSession } from '../../lib/sessionContext.js';
import { QuestionnaireGrid } from '../../components/admin/QuestionnaireGrid.js';
import { PageHeader } from './shared.js';

/**
 * 问卷配置（场次工作台页签）——附件8.问卷调查表.xlsx 的所见即所得版式。
 *
 * 页面本体是共享的 QuestionnaireGrid（components/admin/QuestionnaireGrid.tsx），
 * 与新建场次向导第 2 步共用同一份实现。本页只保留工作台特有的两件事：
 *   - 页头说明；
 *   - 部门选择同步到 URL（?departmentId=xxx），刷新后恢复上次正在配置的部门——
 *     否则每次刷新都退回列表第一个部门，管理员配了一半的问卷会「凭空消失」。
 * 原「部门」「项点」独立页签的职能已并入网格（场内部门在建场时自动落一条，
 * 项点的新增/删除/上下移直接在表上操作），不再各自跳页。
 */
export function AdminQuestionnaire() {
  const { sessionId } = useAdminSession();

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

  return (
    <>
      <PageHeader
        title="问卷配置"
        description="与附件8.问卷调查表完全一致的 Excel 版式：直接在表上改，失焦自动保存。项点的增删与上下移、被评列的新增都在表上完成。"
      />
      <QuestionnaireGrid
        sessionId={sessionId}
        departmentId={departmentId}
        onDepartmentChange={selectDepartment}
      />
    </>
  );
}

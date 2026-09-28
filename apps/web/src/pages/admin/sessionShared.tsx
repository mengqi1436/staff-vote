/**
 * 场次列表与场次工作台共享的场次模块。
 *
 * 状态机按钮的「哪个状态有哪些操作」与开放窗口编辑弹窗都只有这一份实现：
 * 两处各自决定渲染形态（列表用小号链接按钮、工作台用普通按钮），
 * 但操作集合、确认框文案与提交契约不再各写一份，避免漂移。
 */
import { useEffect } from 'react';
import { DatePicker, Form, Modal, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { adminApi, type AdminSessionDto } from '../../lib/api.js';
import { describeError, formatDateTime } from './lib.js';
import { useNotify } from './shared.js';

/** 状态不靠颜色单独表意：文字才是表意手段，Tag 颜色只是辅助。 */
export const SESSION_STATUS_META: Record<
  AdminSessionDto['status'],
  { text: string; color?: string }
> = {
  draft: { text: '未开始' },
  voting: { text: '投票中', color: 'success' },
  paused: { text: '已暂停', color: 'warning' },
  ended: { text: '已结束' },
};

const END_CONFIRM = {
  title: '结束本场投票？',
  description: '结束后不可恢复，本场次将无法再接收投票。',
  okText: '结束投票',
};

/**
 * 场次状态机操作集（数据描述，不渲染）。
 *
 * 状态机：draft → voting → paused ⇄ voting → ended（终态，不可逆）。
 * - draft：开始投票；voting：暂停 / 结束；paused：继续 / 结束；ended：无操作。
 * - paused → voting 也走 start 接口（「继续投票」）。
 * 非法流转后端返回 409 INVALID_SESSION_TRANSITION，调用方统一走 describeError 提示；
 * 后端负责真正的状态机校验，前端按钮显隐只是体验层。
 */
export function sessionActions(
  status: AdminSessionDto['status'],
  /** draft 场次的开始投票阻塞缺项（后端 startBlockers）；非空时开始按钮禁用 */
  startBlockers: string[] = [],
): Array<{
  key: 'start' | 'pause' | 'end';
  label: string;
  danger: boolean;
  /** 需要二次确认时的确认框文案；不需要确认时为 undefined */
  confirm?: { title: string; description: string; okText: string };
  /** 配置未完成等前端禁用场景；禁用时按钮必须配 Tooltip 说明原因 */
  disabled?: boolean;
  disabledReason?: string;
}> {
  switch (status) {
    case 'draft': {
      const blocked = startBlockers.length > 0;
      return [
        {
          key: 'start',
          label: '开始投票',
          danger: false,
          disabled: blocked,
          // 缺项可能逐部门长清单（Tooltip 会炸屏），这里只给总数与前两条示例；
          // 完整明细仍由 start 接口的 409 detail 提供
          disabledReason: blocked
            ? `配置未完成，共缺 ${startBlockers.length} 项：${startBlockers.slice(0, 2).join('；')}${startBlockers.length > 2 ? '…' : ''}`
            : undefined,
        },
      ];
    }
    case 'voting':
      return [
        { key: 'pause', label: '暂停投票', danger: false },
        { key: 'end', label: '结束投票', danger: true, confirm: END_CONFIRM },
      ];
    case 'paused':
      return [
        { key: 'start', label: '继续投票', danger: false },
        { key: 'end', label: '结束投票', danger: true, confirm: END_CONFIRM },
      ];
    case 'ended':
      return [];
  }
}

interface WindowForm {
  range: [Dayjs | null, Dayjs | null] | null;
}

/**
 * 开放时间窗编辑弹窗（场次列表行内与工作台页头共用）。
 *
 * 起止任一侧留空表示该侧不限制：开始留空 = 不限开始，
 * 结束留空 = 长期开放（界面上必须写明）。提交契约：
 * 有值传 ISO 字符串、留空传 null（清空），真正的校验在后端（opensAt < closesAt）。
 */
export function SessionWindowModal({
  session,
  open,
  onClose,
  onSaved,
}: {
  session: AdminSessionDto | null;
  open: boolean;
  onClose: () => void;
  /** 保存成功后回调（带后端返回的最新场次），调用方负责刷新自己的数据源 */
  onSaved: (session: AdminSessionDto) => void;
}) {
  const [form] = Form.useForm<WindowForm>();
  const notify = useNotify();

  // 每次打开都按目标场次灌初值，关闭后不残留上一次的编辑内容
  useEffect(() => {
    if (open && session) {
      form.setFieldsValue({
        range: [
          session.opensAt ? dayjs(session.opensAt) : null,
          session.closesAt ? dayjs(session.closesAt) : null,
        ],
      });
    }
  }, [open, session, form]);

  const handleSubmit = async (): Promise<void> => {
    if (!session) return;
    let values: WindowForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const [start, end] = values.range ?? [null, null];
    if (start && end && end.isBefore(start)) {
      notify.error('结束时间不能早于开始时间');
      return;
    }

    try {
      const result = await adminApi.sessions.update(session.id, {
        // ISO 字符串或 null（清空该侧限制）；toISOString 输出 UTC，显示时按本地时区还原
        opensAt: start ? start.toISOString() : null,
        closesAt: end ? end.toISOString() : null,
      });
      notify.success('开放时间窗已保存');
      onSaved(result.session);
      onClose();
    } catch (caught) {
      notify.error(describeError(caught, '保存失败，请重试'));
    }
  };

  return (
    <Modal
      title={`开放时间窗 · ${session?.name ?? ''}`}
      open={open}
      onCancel={onClose}
      onOk={() => void handleSubmit()}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        开始时间留空表示不限开始；结束时间为空视为长期开放。
      </Typography.Paragraph>
      <Form<WindowForm> form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="range" label="开放时间段">
          <DatePicker.RangePicker
            showTime={{ format: 'HH:mm' }}
            format="YYYY-MM-DD HH:mm"
            allowEmpty={[true, true]}
            style={{ width: '100%' }}
            placeholder={['开始时间（可留空）', '结束时间（可留空）']}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * 场次开放窗口的单行描述：「开始 ～ 结束」，任一侧留空给出对应含义。
 * formatDateTime 已把 null 显示为「-」，这里换成更明确的说法。
 */
export function formatWindow(
  opensAt: string | null,
  closesAt: string | null,
): string {
  const start = opensAt ? formatDateTime(opensAt) : '不限开始';
  const end = closesAt ? formatDateTime(closesAt) : '长期开放';
  return `${start} ～ ${end}`;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import type { TableColumnsType } from 'antd';
import { ApiError, adminApi, type SettingsDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { usePolling } from '../../lib/usePolling.js';
import {
  evaluateVoteWindow,
  formatDateTime,
  voteWindowConditions,
  type VoteWindowCondition,
} from './lib.js';
import {
  ErrorState,
  LoadingState,
  NextStep,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

interface SettingsForm {
  title: string;
  open: boolean;
  window: [Dayjs | null, Dayjs | null] | null;
}

/** 三层条件中的一条，用于把「为什么还没开放」拆开摆给管理员看。 */
const CONDITION_COLUMNS: TableColumnsType<VoteWindowCondition> = [
  { title: '序号', dataIndex: 'seq', width: 64 },
  { title: '条件', dataIndex: 'condition' },
  {
    title: '当前值',
    dataIndex: 'current',
    render: (value: string) => <span className="tabular">{value}</span>,
  },
  {
    title: '判定',
    dataIndex: 'met',
    width: 96,
    render: (value: boolean) => (
      // 判定另有文字，颜色只是加重，不单独表意。
      // 「满足」不用 antd 的 success 绿（#52c41a 作正文只有 2.3:1），
      // 取官方色板 green-8，白底约 5.6:1 达 AA。
      <Typography.Text strong type={value ? undefined : 'danger'} style={value ? { color: '#237804' } : undefined}>
        {value ? '满足' : '不满足'}
      </Typography.Text>
    ),
  },
];

/** 服务端字符串值 → 表单值。 */
function toFormValues(settings: SettingsDto): SettingsForm {
  return {
    title: settings['system.title'],
    open: settings['vote.open'] === 'true',
    window: [
      settings['vote.startAt'] ? dayjs(settings['vote.startAt']) : null,
      settings['vote.endAt'] ? dayjs(settings['vote.endAt']) : null,
    ],
  };
}

/**
 * 投票开放时间与系统设置（评议工作流第 6 步：开放投票）。
 *
 * 开放条件是三层的：总开关打开 + 当前时间不早于开始时间 + 不晚于结束时间。
 * 页面把这三层拆成一张判定表逐条列出，并给出「当前是否开放」与原因 ——
 * 管理员看到的不是一句「未开放」，而是到底卡在哪一条。
 *
 * 起止任一侧留空表示该侧不限制（RangePicker 的 allowEmpty）。
 * 真正的防线在后端 evaluateVoteWindow，前端判定只是提示。
 */
export function AdminSettings() {
  const load = useCallback(() => adminApi.settings.get(), []);
  // 30 秒轮询：其他管理员改了开关或时间窗，这里能自动跟上
  const { data, error, loading, refresh } = usePolling(load, 30000);
  const notify = useNotify();
  const { can } = useAuth();
  const canWrite = can('settings.write');
  const [form] = Form.useForm<SettingsForm>();
  const [saving, setSaving] = useState(false);
  // 后端 403 的文案要能在界面读出来：页面内用 Alert 摆出来，其余错误仍走全局提示
  const [denied, setDenied] = useState<string | null>(null);

  /**
   * 统一的失败处理：403 单独呈现在页面内（权限问题要让管理员读到后端给的原因），
   * 其余错误仍走全局提示。
   */
  const handleFailure = (caught: unknown, fallback = '保存失败，请重试'): void => {
    if (caught instanceof ApiError && caught.status === 403) {
      setDenied(caught.message);
      return;
    }
    notify.error(caught instanceof Error ? caught.message : fallback);
  };
  const initialized = useRef(false);
  // 总开关的开/关状态由旁边文字表达（开关内不放文字，上轮无障碍修复）
  const openValue = Form.useWatch('open', form);

  // 只在首次拿到数据时灌入表单；后续轮询不覆盖管理员正在编辑的内容
  useEffect(() => {
    if (!data || initialized.current) return;
    initialized.current = true;
    form.setFieldsValue(toFormValues(data));
  }, [data, form]);

  const handleSubmit = async (): Promise<void> => {
    let values: SettingsForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    const start = values.window?.[0] ?? null;
    const end = values.window?.[1] ?? null;
    if (start && end && end.isBefore(start)) {
      notify.error('结束时间不能早于开始时间');
      return;
    }

    setSaving(true);
    try {
      const saved = await adminApi.settings.update({
        'system.title': values.title,
        'vote.open': values.open ? 'true' : 'false',
        // 空串表示该侧不限制，与后端约定一致；toISOString 输出 UTC，显示时按本地时区还原
        'vote.startAt': start ? start.toISOString() : '',
        'vote.endAt': end ? end.toISOString() : '',
      });
      form.setFieldsValue(toFormValues(saved));
      notify.success('设置已保存');
      refresh();
    } catch (caught) {
      handleFailure(caught, '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const now = dayjs();
  const state = data ? evaluateVoteWindow(data, now) : null;
  const conditions = data ? voteWindowConditions(data, now) : [];

  return (
    <>
      <PageHeader
        title="开放时间与系统设置"
        description="控制投票入口何时可以进入。投票入口与后端接口同时生效：窗口外提交一定被拒。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              重新载入
            </Button>
            {/* 无权限时不渲染保存入口，而不是给一个点不动的按钮 */}
            {canWrite ? (
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void handleSubmit()}>
                保存设置
              </Button>
            ) : null}
          </>
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

      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      {error && !data ? <ErrorState error={error} onRetry={refresh} /> : null}

      {!data && loading ? <LoadingState rows={5} /> : null}

      {data ? (
        <>
          <Card
            title={state?.open ? '当前状态：投票开放中' : '当前状态：未开放'}
            extra={`判定时刻 ${now.format('YYYY-MM-DD HH:mm')}`}
            style={{ marginBottom: 16 }}
          >
            <Alert
              type={state?.open ? 'success' : 'warning'}
              showIcon
              style={{ marginBottom: 16 }}
              title={
                state?.open
                  ? '三层条件全部满足，投票入口可以进入。'
                  : `未开放的原因：${state?.reason ?? '未知原因'}`
              }
            />
            <Typography.Paragraph type="secondary">
              服务端返回的窗口：
              <span className="tabular">{formatDateTime(data['vote.startAt'])}</span> 至{' '}
              <span className="tabular">{formatDateTime(data['vote.endAt'])}</span>
              （留空表示该侧不限制）。
            </Typography.Paragraph>
            {/* 开放口径（产品原则 4）：内容保留 */}
            <ul style={{ margin: 0, paddingLeft: 20, color: 'rgba(0, 0, 0, 0.45)' }}>
              <li>非开放时段，投票入口显示「当前未开放投票」；即使有人已经拿到随机码，提交也会被后端拒绝。</li>
              <li>这里的判定是前端提示，真正的防线在后端（产品原则 5：截止时间与核销是硬的）。</li>
              <li>本页每 30 秒自动重新取数，其他管理员改动开关或时间窗后会跟上。</li>
            </ul>
          </Card>

          <Card title="三层条件全部满足才算开放" extra="① AND ② AND ③" style={{ marginBottom: 16 }}>
            <Typography.Paragraph type="secondary">
              三层条件是「与」的关系：任一条不满足即不开放。任一侧时间留空，视为该侧不限制（该条满足）。
              时间按本地时区显示与判定；数据库统一存 timestamptz，跨时区访问不会错位。
            </Typography.Paragraph>
            <Table<VoteWindowCondition>
              rowKey="seq"
              columns={CONDITION_COLUMNS}
              dataSource={conditions}
              pagination={false}
              scroll={{ x: 'max-content' }}
            />
          </Card>

          <Card title="投票开放时间设置">
            <Typography.Paragraph type="secondary">
              系统标题同时用于后台、投票入口与打印版抬头（默认「职工素质评议」），不得虚构单位名称。
              保存后立即生效：投票入口与后端接口同时按新窗口判定。
            </Typography.Paragraph>
            {/* 无权限时整张表单不可编辑：保存入口不渲染，表单仍可改会让人白填一遍 */}
            <Form<SettingsForm>
              form={form}
              layout="vertical"
              requiredMark={false}
              disabled={!canWrite}
              style={{ maxWidth: 720 }}
            >
              <Form.Item name="title" label="系统标题" rules={[{ required: true, message: '请输入系统标题' }]}>
                <Input placeholder="例如：某某单位职工素质评议" maxLength={64} />
              </Form.Item>

              <Form.Item
                label="投票总开关"
                extra="关闭后无论时间窗如何设置，投票入口都会显示「当前未开放投票」"
              >
                <Space align="center">
                  <Form.Item name="open" valuePropName="checked" noStyle>
                    {/* 开关内不放文字：白字在未选中态的浅底上只有 2.5:1，不达 AA。
                        开/关状态由旁边的文字表达，语义另见下方条件判定表。 */}
                    <Switch aria-label="投票总开关" />
                  </Form.Item>
                  <Typography.Text type="secondary">
                    当前设置：{openValue ? '已开启' : '已关闭'}
                  </Typography.Text>
                </Space>
              </Form.Item>

              <Form.Item
                name="window"
                label="开放时间段"
                extra="可只填一侧：只填开始时间表示从该时刻起不再限制结束；两侧都留空表示时间上不限制。支持选择到分钟。"
              >
                <DatePicker.RangePicker
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  allowEmpty={[true, true]}
                  style={{ width: '100%' }}
                  placeholder={['开始时间（可留空）', '结束时间（可留空）']}
                />
              </Form.Item>
            </Form>

            <Space style={{ marginTop: 8 }}>
              {/* 主操作：无权限时不渲染保存入口，而不是给一个点不动的按钮 */}
              {canWrite ? (
                <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void handleSubmit()}>
                  保存设置
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  form.setFieldsValue(toFormValues(data));
                  notify.success('已恢复为服务端当前值');
                }}
              >
                放弃修改，恢复当前值
              </Button>
            </Space>
          </Card>
        </>
      ) : null}

      <NextStep to="/admin">概览（实时监控）</NextStep>
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { ApiError, adminApi, type SettingsDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { usePolling } from '../../lib/usePolling.js';
import { ErrorState, HelpLabel, LoadingState, PageHeader, StaleDataAlert, useNotify } from './shared.js';

interface SettingsForm {
  title: string;
}

/** 服务端字符串值 → 表单值。 */
function toFormValues(settings: SettingsDto): SettingsForm {
  return { title: settings['system.title'] };
}

/**
 * 系统设置。
 *
 * 开放时间已下沉到每次评议（评议列表 / 评议工作台里设置），
 * 全局设置只剩系统标题：它同时用于后台、投票入口与打印版抬头（默认「职工素质评议」），
 * 不得虚构单位名称。
 */
export function AdminSettings() {
  const load = useCallback(() => adminApi.settings.get(), []);
  // 30 秒轮询：其他管理员改了标题，这里能自动跟上
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

    setSaving(true);
    try {
      const saved = await adminApi.settings.update({ 'system.title': values.title });
      form.setFieldsValue(toFormValues(saved));
      notify.success('设置已保存');
      refresh();
    } catch (caught) {
      handleFailure(caught, '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="系统设置"
        description="全局设置只剩系统标题；每次评议的开放时间在「评议管理」或评议工作台里设置。"
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

      {!data && loading ? <LoadingState rows={3} /> : null}

      {data ? (
        <Card title={<HelpLabel help="开放时间属于单次评议：开始与结束时间在「评议管理」列表或对应评议的工作台里设置，结束时间为空表示一直开放。">系统标题</HelpLabel>}>
          <Form<SettingsForm>
            form={form}
            layout="vertical"
            requiredMark={false}
            disabled={!canWrite}
            style={{ maxWidth: 720 }}
          >
            <Form.Item
              name="title"
              label={<HelpLabel help="同时用于后台、投票入口与打印版抬头（默认「职工素质评议」）。">系统标题</HelpLabel>}
              rules={[{ required: true, message: '请输入系统标题' }]}
            >
              <Input placeholder="例如：某某单位职工素质评议" maxLength={64} />
            </Form.Item>
          </Form>

          {/* 主操作：无权限时不渲染保存入口，而不是给一个点不动的按钮 */}
          {canWrite ? (
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              onClick={() => void handleSubmit()}
            >
              保存设置
            </Button>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

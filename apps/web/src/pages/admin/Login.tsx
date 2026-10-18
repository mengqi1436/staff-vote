import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useNavigate } from 'react-router';
import { adminApi } from '../../lib/api.js';
import { describeLoginError } from './lib.js';
import { HelpLabel } from './shared.js';

interface LoginForm {
  username: string;
  password: string;
}

/**
 * 管理员登录页：居中卡片，视觉全部由全局 token（Apple 风契约 v1）决定，
 * 无本地硬编码色值。
 *
 * 登录状态走 httpOnly Cookie（由 /api/admin/login 下发），前端不保存任何令牌。
 * 失败提示区分 401（用户名或口令错误）与 429（尝试过于频繁），其余情况回显
 * 后端消息，不额外暴露内部信息；提示以 role="alert" 就地展示在字段下方，
 * 不靠浮层 toast —— 浮层消失后管理员会不知道刚才发生了什么。
 */
export function AdminLogin() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState('');

  const handleFinish = async (values: LoginForm): Promise<void> => {
    setSubmitting(true);
    setErrorText('');
    try {
      await adminApi.login(values.username, values.password);
      void navigate('/admin', { replace: true });
    } catch (caught) {
      setErrorText(describeLoginError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            <HelpLabel help="登录后可以配置打分表、发放随机码、导出和打印结果。登录状态会在浏览器里保留 2 小时，超时后需要重新登录；登录尝试每分钟最多 10 次，超过后稍等再试。">
              职工素质评议系统 · 后台管理
            </HelpLabel>
          </Typography.Title>
        </div>

        <Form<LoginForm>
          layout="vertical"
          requiredMark={false}
          onFinish={handleFinish}
          // 一旦重新输入就撤掉上一次的失败提示，避免旧错误压住字段级的校验提示
          onValuesChange={() => setErrorText('')}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input autoComplete="username" placeholder="管理员用户名" autoFocus />
          </Form.Item>

          <Form.Item name="password" label="口令" rules={[{ required: true, message: '请输入口令' }]}>
            <Input.Password autoComplete="current-password" placeholder="登录口令" />
          </Form.Item>

          {errorText ? (
            <Alert
              role="alert"
              type="error"
              showIcon
              title={errorText}
              style={{ marginBottom: 16 }}
            />
          ) : null}

          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}

import type { ThemeConfig } from 'antd';

/**
 * 主题：Apple 风契约 v1 = 全队统一的基础 token 定制见 main.tsx 的全局
 * ConfigProvider（colorPrimary #0071e3、colorError #d70015、borderRadius 10）。
 * 本文件只管投票端与后台的密度分叉，不再重复声明颜色/圆角。
 *
 * ponytail: 上一轮为「纸上年鉴」写了 150 行定制 token（0 圆角、墨黑主色、
 * 规则线体系），按用户要求废弃。教训仍然成立：只在 token 值层面做克制定制，
 * 不要拿艺术方向去替换 antd 的组件体系与结构，那是负资产。
 *
 * 投票端尺寸差异：职工一年用一两次、可能用手机，正文 16px、触控目标 44px；
 * 后台全程用 antd 默认密度。本主题嵌套在全局 ConfigProvider 内，antd 的
 * 嵌套合并（token 逐项 merge）会让投票端自动继承新的主色与圆角，
 * 故这里只写密度四项，不显式补色值。
 */
export const voteTheme: ThemeConfig = {
  token: {
    fontSize: 16,
    controlHeight: 44,
    controlHeightLG: 48,
    controlHeightSM: 36,
  },
};
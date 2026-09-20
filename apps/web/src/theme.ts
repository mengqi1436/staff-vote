import type { ThemeConfig } from 'antd';

/**
 * 主题：标准企业风 = antd 默认设计，不做 token 定制。
 *
 * ponytail: 上一轮为「纸上年鉴」写了 150 行定制 token（0 圆角、墨黑主色、
 * 规则线体系），按用户要求废弃。教训：antd 默认就是「标准企业脸」，
 * 不要拿艺术方向去替换默认主题，那是负资产。
 *
 * 唯一保留的差异是投票端尺寸：职工一年用一两次、可能用手机，
 * 正文 16px、触控目标 44px。后台全程用 antd 默认密度。
 */
export const voteTheme: ThemeConfig = {
  token: {
    fontSize: 16,
    controlHeight: 44,
    controlHeightLG: 48,
    controlHeightSM: 36,
  },
};
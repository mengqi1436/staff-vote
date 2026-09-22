import type { DepartmentBrief, VoteTicketTypeDto } from '../../lib/api.js';

/**
 * 投票会话的展示数据缓存。
 *
 * 令牌本身由 lib/api.ts 管理（同样存在 sessionStorage，关掉标签即失效）。
 * 这里只缓存 session 接口返回的票种与部门列表 —— 没有它，打分表页一刷新
 * 就会因为拿不到部门列表而被退回入口，已经填了一半的职工会白填。
 */

const KEY = 'staff_vote_session_info';

/** 缓存内容：票种、部门列表与所在场次（场次为多场评议新增，旧后端没有，恒可缺省）。 */
export interface CachedVoteSession {
  ticketType: VoteTicketTypeDto;
  departments: DepartmentBrief[];
  /** 所在场次；旧后端不返回该字段，恒为 undefined */
  session?: { id: string; name: string; status: string };
}

/** 写入缓存（入口页拿到会话后调用）。 */
export function saveVoteSessionInfo(info: CachedVoteSession): void {
  sessionStorage.setItem(KEY, JSON.stringify(info));
}

/**
 * 读取缓存。
 * @returns 数据缺失或损坏时返回 null，由调用方退回入口
 */
export function readVoteSessionInfo(): CachedVoteSession | null {
  const raw = sessionStorage.getItem(KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedVoteSession> | null;
    if (parsed === null || parsed === undefined) return null;
    if (!Array.isArray(parsed.departments) || parsed.departments.length === 0) return null;
    if (parsed.ticketType === undefined) return null;
    return {
      ticketType: parsed.ticketType,
      departments: parsed.departments,
      // 场次是可选字段：旧缓存/旧后端没有就不带，调用方必须容错
      session: parsed.session,
    };
  } catch {
    // 缓存损坏（手改、旧格式）时当作没有：退回入口重来比带着坏数据渲染安全
    return null;
  }
}

/** 清除缓存（提交成功后调用，公共电脑上尤其要清干净）。 */
export function clearVoteSessionInfo(): void {
  sessionStorage.removeItem(KEY);
}
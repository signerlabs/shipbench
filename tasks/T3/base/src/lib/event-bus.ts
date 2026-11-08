/**
 * 进程内事件总线
 *
 * 简单的发布/订阅模式，用于在 App Runner 单进程内广播事件。
 * 主要用途：SSE 实时监控推送。
 *
 * Created by guiping on 2026/03/31
 */

// ============================================================
// 事件类型定义
// ============================================================

/** 定位事件 payload（成功和失败共用） */
export interface LocationEvent {
  type: 'success' | 'failed';
  restaurantId: string;
  restaurantName: string;
  locationHint: string;
  city: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  postRefs: string[];
  timestamp: string;
}

/** 用户反馈事件 payload */
export interface IssueEvent {
  restaurantId: string;
  restaurantName: string;
  city: string;
  issueTypes: string[];
  description: string;
  identityId: string;
  timestamp: string;
}

/** 所有事件类型映射 */
export interface EventMap {
  'location-result': LocationEvent;
  'issue-submitted': IssueEvent;
}

// ============================================================
// EventBus 实现
// ============================================================

type Listener<T> = (payload: T) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  /** 注册事件监听器 */
  addListener<K extends keyof EventMap>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as Listener<unknown>);
  }

  /** 移除事件监听器 */
  removeListener<K extends keyof EventMap>(
    event: K,
    listener: Listener<EventMap[K]>,
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener as Listener<unknown>);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  /** 发布事件 */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[event-bus] 事件 ${String(event)} 监听器执行出错:`, err);
      }
    }
  }
}

/** 全局单例 */
export const eventBus = new EventBus();

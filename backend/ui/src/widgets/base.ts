// base.ts —— 所有 Widget 组件的抽象基类
import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';

export abstract class BaseWidget extends LitElement {
  @property({ type: Object, attribute: false }) state: unknown = {};
  @property({ type: Object, attribute: false }) cfg: Record<string, unknown> = {};

  static widgetId: string;
  static widgetTitle: string;
  static widgetIcon: string;
}

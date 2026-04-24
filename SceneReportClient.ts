/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SceneReport } from './SceneReport';

type Listener = (report: SceneReport) => void;

export class SceneReportClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<Listener>();
  private reconnectTimer: number | null = null;
  private closed = false;
  latest: SceneReport | null = null;
  connected = false;

  constructor(url: string) {
    this.url = url;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      console.log('[SceneReportClient] connected', this.url);
    };
    this.ws.onmessage = (ev) => {
      try {
        const report = JSON.parse(ev.data as string) as SceneReport;
        this.latest = report;
        this.listeners.forEach((l) => l(report));
      } catch (e) {
        console.warn('[SceneReportClient] bad payload', e);
      }
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.scheduleReconnect();
    };
    this.ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  onUpdate(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose() {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.listeners.clear();
  }
}

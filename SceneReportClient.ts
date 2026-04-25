/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SceneReport } from './SceneReport';

type Listener = (report: SceneReport) => void;
type FrameResolver = (report: SceneReport) => void;

export class SceneReportClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<Listener>();
  private reconnectTimer: number | null = null;
  private closed = false;
  /// When `requestFrame()` is awaiting an image-bearing SceneReport, the
  /// resolver sits here. The next inbound report whose `image` field is
  /// populated fires it and clears the slot. We keep this single-slot
  /// (no queue) because Detect is user-driven and never overlapping.
  private pendingFrameResolve: FrameResolver | null = null;
  private pendingFrameReject: ((reason: Error) => void) | null = null;
  private pendingFrameTimeout: number | null = null;
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
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = async (ev) => {
      try {
        let text: string;
        if (typeof ev.data === 'string') {
          text = ev.data;
        } else if (ev.data instanceof ArrayBuffer) {
          text = new TextDecoder().decode(ev.data);
        } else if (ev.data instanceof Blob) {
          text = await ev.data.text();
        } else {
          console.warn('[SceneReportClient] unknown payload type', ev.data);
          return;
        }
        const report = JSON.parse(text) as SceneReport;
        this.latest = report;
        this.listeners.forEach((l) => l(report));
        if (report.image && this.pendingFrameResolve) {
          const resolve = this.pendingFrameResolve;
          this.pendingFrameResolve = null;
          this.pendingFrameReject = null;
          if (this.pendingFrameTimeout !== null) {
            window.clearTimeout(this.pendingFrameTimeout);
            this.pendingFrameTimeout = null;
          }
          resolve(report);
        }
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

  /// Ask the iPhone for one fresh JPEG keyframe. Resolves with the next
  /// inbound SceneReport whose `image` field is populated. Rejects on
  /// timeout (default 3 s — LAN round-trip is sub-200ms, anything longer
  /// usually means the iPhone isn't streaming or BoxerNet stalled).
  /// Single-slot: a second call before the first resolves cancels the
  /// first with a 'superseded' error.
  requestFrame(timeoutMs = 3000): Promise<SceneReport> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not open'));
    }
    if (this.pendingFrameReject) {
      this.pendingFrameReject(new Error('superseded by newer requestFrame'));
      this.pendingFrameResolve = null;
      this.pendingFrameReject = null;
      if (this.pendingFrameTimeout !== null) {
        window.clearTimeout(this.pendingFrameTimeout);
        this.pendingFrameTimeout = null;
      }
    }
    return new Promise<SceneReport>((resolve, reject) => {
      this.pendingFrameResolve = resolve;
      this.pendingFrameReject = reject;
      this.pendingFrameTimeout = window.setTimeout(() => {
        this.pendingFrameResolve = null;
        this.pendingFrameReject = null;
        this.pendingFrameTimeout = null;
        reject(new Error(`requestFrame timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      try {
        this.ws!.send(JSON.stringify({ type: 'request_frame' }));
      } catch (e) {
        if (this.pendingFrameTimeout !== null) {
          window.clearTimeout(this.pendingFrameTimeout);
          this.pendingFrameTimeout = null;
        }
        this.pendingFrameResolve = null;
        this.pendingFrameReject = null;
        reject(e as Error);
      }
    });
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

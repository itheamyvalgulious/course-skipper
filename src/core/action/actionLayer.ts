import { Notification, dialog, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import { IActionLayer, NotificationOptions } from './types';

export class ActionLayer extends EventEmitter implements IActionLayer {
  private targetFocusWindow: BrowserWindow | null = null;

  constructor() {
    super();
  }

  /**
   * Set target window to focus when a notification is clicked (e.g. the live browser window)
   */
  public setTargetFocusWindow(win: BrowserWindow | null): void {
    this.targetFocusWindow = win;
  }

  /**
   * Trigger a notification popup.
   * Supports:
   *   notify({ title, body, reason, summary })
   *   notify("老师讲完题目", "开始讲解下一个知识点")
   */
  public async notify(
    optionsOrReason: NotificationOptions | string,
    summary?: string
  ): Promise<boolean> {
    let opts: NotificationOptions;

    if (typeof optionsOrReason === 'string') {
      const reason = optionsOrReason;
      opts = {
        title: '🔔 Skipper 听课助手提醒',
        body: summary ? `【${reason}】\n${summary}` : reason,
        reason,
        summary: summary || reason,
        urgency: 'critical',
        silent: false,
      };
    } else {
      opts = {
        title: optionsOrReason.title || '🔔 Skipper 听课助手提醒',
        body: optionsOrReason.body,
        reason: optionsOrReason.reason,
        summary: optionsOrReason.summary,
        urgency: optionsOrReason.urgency || 'critical',
        silent: optionsOrReason.silent ?? false,
        onClick: optionsOrReason.onClick,
      };
    }

    console.log(`[ActionLayer] Sending notification: ${opts.title} - ${opts.body}`);
    this.emit('notification', opts);

    const isSupported = Notification.isSupported();

    if (isSupported) {
      try {
        const notif = new Notification({
          title: opts.title,
          body: opts.body,
          urgency: opts.urgency,
          silent: opts.silent,
        });

        notif.on('click', () => {
          console.log('[ActionLayer] Notification clicked');
          if (opts.onClick) {
            opts.onClick();
          } else if (this.targetFocusWindow && !this.targetFocusWindow.isDestroyed()) {
            if (this.targetFocusWindow.isMinimized()) this.targetFocusWindow.restore();
            this.targetFocusWindow.show();
            this.targetFocusWindow.focus();
          }
        });

        notif.show();
        return true;
      } catch (err) {
        console.error('[ActionLayer] Native notification failed, falling back to dialog:', err);
        await this.showAlert(opts.title, opts.body);
        return false;
      }
    } else {
      console.warn('[ActionLayer] Desktop notifications not supported, using dialog alert');
      await this.showAlert(opts.title, opts.body);
      return true;
    }
  }

  /**
   * Display a modal alert dialog.
   */
  public async showAlert(title: string, message: string): Promise<void> {
    try {
      if (this.targetFocusWindow && !this.targetFocusWindow.isDestroyed()) {
        await dialog.showMessageBox(this.targetFocusWindow, {
          type: 'info',
          title,
          message,
          buttons: ['我知道了'],
        });
      } else {
        await dialog.showMessageBox({
          type: 'info',
          title,
          message,
          buttons: ['我知道了'],
        });
      }
    } catch (err) {
      console.error('[ActionLayer] Error showing alert dialog:', err);
    }
  }

  public onNotification(callback: (notification: NotificationOptions) => void): void {
    this.on('notification', callback);
  }
}

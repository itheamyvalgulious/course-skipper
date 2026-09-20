export interface NotificationOptions {
  title: string;
  body: string;
  reason?: string;
  summary?: string;
  silent?: boolean;
  urgency?: 'normal' | 'critical' | 'low';
  onClick?: () => void;
}

export interface IActionLayer {
  /**
   * Send a system notification / popup alert.
   * Can accept either an options object or (reason, summary) as specified in version1.md.
   */
  notify(options: NotificationOptions | string, summary?: string): Promise<boolean>;

  /**
   * Display a direct modal alert dialog.
   */
  showAlert(title: string, message: string): Promise<void>;

  /**
   * Listen to sent notifications (for history / UI updates).
   */
  onNotification(callback: (notification: NotificationOptions) => void): void;
}

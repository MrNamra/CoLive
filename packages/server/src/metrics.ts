export class ServerMetrics {
  public activeSessions = 0;
  public activeParticipants = 0;
  public messagesTotal = 0;
  public bytesTotal = 0;

  private messageWindow: Array<{ time: number; count: number }> = [];
  private byteWindow: Array<{ time: number; bytes: number }> = [];

  public recordMessage(bytes: number): void {
    const now = Date.now();
    this.messagesTotal++;
    this.bytesTotal += bytes;

    this.messageWindow.push({ time: now, count: 1 });
    this.byteWindow.push({ time: now, bytes });

    this.pruneWindows(now);
  }

  public getMessagesPerSec(): number {
    const now = Date.now();
    this.pruneWindows(now);
    const sum = this.messageWindow.reduce((acc, m) => acc + m.count, 0);
    return Math.round((sum / 5) * 10) / 10; // 5-second moving window average
  }

  public getBytesPerSec(): number {
    const now = Date.now();
    this.pruneWindows(now);
    const sum = this.byteWindow.reduce((acc, b) => acc + b.bytes, 0);
    return Math.round(sum / 5);
  }

  private pruneWindows(now: number): void {
    const cutoff = now - 5000;
    while (this.messageWindow.length > 0 && this.messageWindow[0]!.time < cutoff) {
      this.messageWindow.shift();
    }
    while (this.byteWindow.length > 0 && this.byteWindow[0]!.time < cutoff) {
      this.byteWindow.shift();
    }
  }

  public toPrometheusText(): string {
    return [
      '# HELP colive_active_sessions Current number of active collaboration sessions',
      '# TYPE colive_active_sessions gauge',
      `colive_active_sessions ${this.activeSessions}`,
      '',
      '# HELP colive_active_participants Current number of connected participants',
      '# TYPE colive_active_participants gauge',
      `colive_active_participants ${this.activeParticipants}`,
      '',
      '# HELP colive_messages_total Total messages received',
      '# TYPE colive_messages_total counter',
      `colive_messages_total ${this.messagesTotal}`,
      '',
      '# HELP colive_bytes_total Total bytes received',
      '# TYPE colive_bytes_total counter',
      `colive_bytes_total ${this.bytesTotal}`,
      '',
      '# HELP colive_messages_per_sec Messages per second (5s avg)',
      '# TYPE colive_messages_per_sec gauge',
      `colive_messages_per_sec ${this.getMessagesPerSec()}`,
      '',
      '# HELP colive_bytes_per_sec Bytes per second (5s avg)',
      '# TYPE colive_bytes_per_sec gauge',
      `colive_bytes_per_sec ${this.getBytesPerSec()}`,
      '',
    ].join('\n');
  }
}

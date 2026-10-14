export type SessionLifecycleState = 'idle' | 'connecting' | 'active' | 'reconnecting' | 'ended';

export interface SessionStateChangeEvent {
  previous: SessionLifecycleState;
  current: SessionLifecycleState;
  reason?: string;
}

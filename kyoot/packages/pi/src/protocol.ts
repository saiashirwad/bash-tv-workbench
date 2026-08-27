export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface PromptCommand {
  readonly type: "prompt";
  readonly message: string;
  readonly images?: readonly unknown[];
  readonly streamingBehavior?: "steer" | "followUp";
}

export interface FollowUpCommand {
  readonly type: "follow_up";
  readonly message: string;
  readonly images?: readonly unknown[];
}

export interface SteerCommand {
  readonly type: "steer";
  readonly message: string;
  readonly images?: readonly unknown[];
}

export interface AbortCommand {
  readonly type: "abort";
}

export interface GetStateCommand {
  readonly type: "get_state";
}

export interface CompactCommand {
  readonly type: "compact";
  readonly customInstructions?: string;
}

export interface GetMessagesCommand {
  readonly type: "get_messages";
}

export type Command =
  | PromptCommand
  | FollowUpCommand
  | SteerCommand
  | AbortCommand
  | GetStateCommand
  | CompactCommand
  | GetMessagesCommand;

export interface RpcSuccess<A = unknown> {
  readonly type: "response";
  readonly id: string;
  readonly command: string;
  readonly success: true;
  readonly data?: A;
}

export interface RpcFailure {
  readonly type: "response";
  readonly id: string;
  readonly command: string;
  readonly success: false;
  readonly error: string;
}

export type RpcResponse<A = unknown> = RpcSuccess<A> | RpcFailure;

export interface SessionState {
  readonly model: unknown;
  readonly thinkingLevel: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly sessionFile: string | null;
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly messageCount: number;
  readonly pendingMessageCount: number;
}

export interface CompactResult {
  readonly tokensBefore?: number;
  readonly estimatedTokensAfter?: number;
  readonly [key: string]: unknown;
}

export interface PiEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AgentEndEvent extends PiEvent {
  readonly type: "agent_end";
  readonly messages: readonly unknown[];
}

/**
 * The agent brain port.
 *
 * Agents in this system are narrow: each one is given structured facts and asked for a
 * structured judgement, and the schema of that judgement is fixed by the caller. There is
 * no open-ended tool loop, because the orchestration *is* the loop — that is what the
 * harness is for.
 *
 * Two implementations. The Anthropic one is what production runs. The deterministic one
 * is a rules engine over the same input and output shapes, and it exists for the same
 * three reasons it does in any system like this: the hosted demo runs with no API key,
 * the tests are hermetic, and a model outage degrades the system instead of stopping it.
 */

export interface BrainRequest<TOutput> {
  /** Which agent is asking. Used for prompt selection and for the audit trail. */
  agent: string;
  /** The facts. Everything the agent is allowed to reason from. */
  facts: Record<string, unknown>;
  /** What a valid answer looks like. Sent to the model and validated on the way back. */
  schema: {
    description: string;
    jsonSchema: Record<string, unknown>;
    parse: (value: unknown) => TOutput;
  };
  /** Policy the agent must not contradict. Kept separate from the facts deliberately. */
  rules: string[];
}

export interface BrainResponse<TOutput> {
  output: TOutput;
  /** Why. Recorded on the task so a human reviewing an approval can see the reasoning. */
  reasoning: string;
  /** 0–1. Drives whether a decision needs human review. */
  confidence: number;
  usage?: { inputTokens: number; outputTokens: number; model: string };
}

export interface Brain {
  readonly name: string;
  think<TOutput>(request: BrainRequest<TOutput>): Promise<BrainResponse<TOutput>>;
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
    this.name = "BrainError";
  }
}

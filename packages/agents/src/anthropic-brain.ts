import Anthropic from "@anthropic-ai/sdk";
import { BrainError, type Brain, type BrainRequest, type BrainResponse } from "./brain";

/**
 * Claude, constrained to a structured answer.
 *
 * The output schema is enforced twice: the model is given a tool whose input schema *is*
 * the answer shape, and the result is then parsed with zod on the way back. The first
 * makes a well-formed answer likely; the second makes a malformed one impossible to act
 * on. In a system that sends money-related email on the strength of these answers, the
 * belt and the braces are both load-bearing.
 *
 * `rules` are separate from `facts` on purpose. Facts are data the agent reasons over;
 * rules are policy it must not contradict, and keeping them apart means a change to
 * policy is a change to one array rather than an edit to a prompt somebody has to
 * re-read.
 */

export interface AnthropicBrainOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** Low by default: these are judgements, not copywriting. */
  temperature?: number;
  client?: Anthropic;
}

const DEFAULT_MODEL = "claude-sonnet-5";

export class AnthropicBrain implements Brain {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(options: AnthropicBrainOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 1500;
    this.temperature = options.temperature ?? 0.2;
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): AnthropicBrain | null {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    return new AnthropicBrain({ apiKey, ...(env.ANTHROPIC_MODEL ? { model: env.ANTHROPIC_MODEL } : {}) });
  }

  async think<TOutput>(request: BrainRequest<TOutput>): Promise<BrainResponse<TOutput>> {
    const toolName = "answer";

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: [
          {
            type: "text",
            text: buildSystem(request),
            // The system prompt is stable per agent, so it is worth caching across the
            // many runs a nightly collections sweep produces.
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [
          {
            name: toolName,
            description: request.schema.description,
            input_schema: withReasoning(request.schema.jsonSchema) as Anthropic.Tool.InputSchema,
          },
        ],
        // Forcing the tool is what makes prose impossible: there is no path where the
        // model answers with a paragraph and a downstream parser has to guess.
        tool_choice: { type: "tool", name: toolName },
        messages: [{ role: "user", content: JSON.stringify(request.facts, null, 2) }],
      });
    } catch (error) {
      throw classify(error);
    }

    const block = response.content.find(
      (candidate): candidate is Anthropic.ToolUseBlock => candidate.type === "tool_use",
    );
    if (!block) {
      throw new BrainError("The model answered without using the tool", true, "brain.no_tool_use");
    }

    const raw = block.input as Record<string, unknown>;
    const { _reasoning, _confidence, ...answer } = raw;

    let output: TOutput;
    try {
      output = request.schema.parse(answer);
    } catch (error) {
      // A schema violation is retryable: a second attempt at a slightly different
      // temperature usually produces a valid answer, and the alternative is failing a
      // run over a stray field.
      throw new BrainError(
        `The model's answer did not match the schema: ${error instanceof Error ? error.message : String(error)}`,
        true,
        "brain.schema_violation",
      );
    }

    return {
      output,
      reasoning: typeof _reasoning === "string" ? _reasoning : "",
      confidence: clampConfidence(_confidence),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: this.model,
      },
    };
  }
}

function buildSystem(request: BrainRequest<unknown>): string {
  return [
    `You are the "${request.agent}" agent inside an accounts-and-sales automation system.`,
    "",
    "You are given facts as JSON and must answer using the provided tool. You do not have",
    "access to anything beyond the facts, and you must not assume anything they do not say.",
    "",
    "RULES YOU MUST NOT BREAK:",
    ...request.rules.map((rule) => `- ${rule}`),
    "",
    "Set _confidence honestly. Low confidence routes the decision to a person, which is the",
    "correct outcome when the facts do not settle the question — it is not a failure.",
  ].join("\n");
}

/** Every answer carries its reasoning and confidence, whatever the agent's own schema is. */
function withReasoning(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) };
  const required = [...((schema.required as string[]) ?? [])];

  properties._reasoning = {
    type: "string",
    description: "Two sentences on why. A person reviewing this decision will read it.",
  };
  properties._confidence = {
    type: "number",
    description: "0 to 1. Below 0.7 sends the decision to a human.",
  };

  return { ...schema, properties, required: [...required, "_reasoning", "_confidence"] };
}

function clampConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.min(1, Math.max(0, parsed));
}

function classify(error: unknown): BrainError {
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : String(error);

  // 429 and 5xx are worth another go; 400 and 401 are not going to change.
  if (status === 429) return new BrainError(message, true, "brain.rate_limited");
  if (status !== undefined && status >= 500) return new BrainError(message, true, "brain.upstream");
  if (status === 401 || status === 403) return new BrainError(message, false, "brain.unauthorised");
  if (status === 400) return new BrainError(message, false, "brain.bad_request");

  // A network error with no status is usually transient.
  return new BrainError(message, status === undefined, "brain.unknown");
}

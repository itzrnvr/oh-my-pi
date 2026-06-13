import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type {
	AssistantMessage,
	Message,
	Model,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Tests for the simplified 2-path reasoning preservation logic.
 *
 * The new rule:
 * - Same model: preserve signatures (they're still valid)
 * - Official API on either end: demote to text / drop / strip signature
 * - 3p → 3p: preserve reasoning as native block, strip signature for
 *   cross-3p wire-format compatibility
 *
 * Detection mechanism:
 * - Target: `isOfficialApiByUrl(model.baseUrl)` — checks for api.openai.com
 *   or api.anthropic.com
 * - Source: `assistantMsg.isOfficialApi` flag stamped at message creation
 *   time. `undefined` is treated as 3p so old sessions still work.
 */

function makeModel(overrides: {
	api?: "anthropic-messages" | "openai-completions" | "openai-responses";
	provider?: string;
	id?: string;
	baseUrl?: string;
	reasoning?: boolean;
	legacy_style?: boolean;
}): Model {
	const api = overrides.api ?? "anthropic-messages";
	return buildModel({
		api,
		provider: overrides.provider ?? "custom-3p",
		id: overrides.id ?? "test-model",
		name: "Test Model",
		baseUrl: overrides.baseUrl ?? "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: overrides.reasoning ?? true,
		...(api === "openai-completions" && overrides.legacy_style !== undefined
			? { compat: { legacy_style: overrides.legacy_style } }
			: {}),
	} as Parameters<typeof buildModel>[0]);
}

function makeUser(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "custom-3p",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...overrides,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

describe("Simplified 2-path reasoning preservation (isOfficialApi)", () => {
	it("treats undefined isOfficialApi flag as 3p (backward compat for old sessions)", () => {
		// Old session without the isOfficialApi flag → treated as 3p
		// 3p source + 3p target → preserve
		const target = makeModel({ provider: "3p-a", id: "model-a" });
		const messages: Message[] = [
			makeUser("Hello"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "reasoning chain", thinkingSignature: "sig_source" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } },
				],
				{ provider: "3p-b", model: "model-b" }, // no isOfficialApi flag
			),
			toolResult("tc1", "ok"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "done" },
				],
				{ stopReason: "stop" },
			),
			makeUser("thanks"),
		];

		const result = transformMessages(messages, target);
		const assistants = result.filter(m => m.role === "assistant");
		const priorThinking = (assistants[0] as AssistantMessage).content.find(
			b => b.type === "thinking",
		) as { type: "thinking"; thinking: string; thinkingSignature?: string } | undefined;
		expect(priorThinking).toBeDefined();
		expect(priorThinking?.thinking).toBe("reasoning chain");
	});

	it("strips signature when source is an official API (isOfficialApi: true)", () => {
		// Source stamped as official → strip signature, preserve thinking
		const target = makeModel({ provider: "3p-a", id: "model-a" });
		const messages: Message[] = [
			makeUser("Hello"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "official reasoning", thinkingSignature: "encrypted" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } },
				],
				{ provider: "openai", model: "o1-preview", isOfficialApi: true },
			),
			toolResult("tc1", "ok"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "done" },
				],
				{ stopReason: "stop" },
			),
			makeUser("thanks"),
		];

		const result = transformMessages(messages, target);
		const assistants = result.filter(m => m.role === "assistant");
		const priorThinking = (assistants[0] as AssistantMessage).content.find(
			b => b.type === "thinking",
		) as { type: "thinking"; thinking: string; thinkingSignature?: string } | undefined;
		// Thinking block preserved (content matters for 3p reasoning)
		expect(priorThinking).toBeDefined();
		expect(priorThinking?.thinking).toBe("official reasoning");
		// Signature stripped because source was official
		expect(priorThinking?.thinkingSignature).toBeUndefined();
	});

	it("strips signature when target is an official API (baseUrl = api.anthropic.com)", () => {
		// Target is official Anthropic → strip signature, preserve thinking
		const target = makeModel({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
		});
		const messages: Message[] = [
			makeUser("Hello"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "3p reasoning", thinkingSignature: "sig_3p" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } },
				],
				{ provider: "3p-source", model: "model-source" },
			),
			toolResult("tc1", "ok"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "done" },
				],
				{ stopReason: "stop" },
			),
			makeUser("thanks"),
		];

		const result = transformMessages(messages, target);
		const assistants = result.filter(m => m.role === "assistant");
		const priorThinking = (assistants[0] as AssistantMessage).content.find(
			b => b.type === "thinking",
		) as { type: "thinking"; thinking: string; thinkingSignature?: string } | undefined;
		expect(priorThinking).toBeDefined();
		expect(priorThinking?.thinking).toBe("3p reasoning");
		// Signature stripped because target is official
		expect(priorThinking?.thinkingSignature).toBeUndefined();
	});

	it("preserves same-model with signature (signatures still valid)", () => {
		// Same provider, api, model id → signatures valid, preserve
		const target = makeModel({ provider: "3p-same", id: "same-model" });
		const messages: Message[] = [
			makeUser("Hello"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig_same" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } },
				],
				{ provider: "3p-same", model: "same-model" },
			),
			toolResult("tc1", "ok"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "done" },
				],
				{ stopReason: "stop" },
			),
			makeUser("thanks"),
		];

		const result = transformMessages(messages, target);
		const assistants = result.filter(m => m.role === "assistant");
		const priorThinking = (assistants[0] as AssistantMessage).content.find(
			b => b.type === "thinking",
		) as { type: "thinking"; thinking: string; thinkingSignature?: string } | undefined;
		expect(priorThinking).toBeDefined();
		expect(priorThinking?.thinkingSignature).toBe("sig_same");
	});

	it("demotes cross-API 3p → 3p to text (with signature strip)", () => {
		// Cross-API: openai-completions source → openai-responses target
		// 3p → 3p → preserve reasoning, strip signature
		const target = makeModel({
			api: "openai-responses",
			provider: "3p-a",
			id: "model-a",
		});
		const messages: Message[] = [
			makeUser("Hello"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "3p chain-of-thought", thinkingSignature: "sig" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } },
				],
				{ api: "openai-completions", provider: "3p-b", model: "model-b" },
			),
			toolResult("tc1", "ok"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "done" },
				],
				{ stopReason: "stop", api: "openai-responses" },
			),
			makeUser("thanks"),
		];

		const result = transformMessages(messages, target);
		const assistants = result.filter(m => m.role === "assistant");
		const priorContent = (assistants[0] as AssistantMessage).content;
		// 3p → 3p cross-API preserves reasoning
		const priorThinking = priorContent.find(
			b => b.type === "thinking",
		) as { type: "thinking"; thinking: string; thinkingSignature?: string } | undefined;
		expect(priorThinking).toBeDefined();
		expect(priorThinking?.thinking).toBe("3p chain-of-thought");
		// Signature stripped for cross-3p wire-format compatibility
		expect(priorThinking?.thinkingSignature).toBeUndefined();
	});

	it("legacy_style override demotes cross-3p to text", () => {
		// legacy_style: true forces old OMP text-demotion behavior
		const target = makeModel({
			api: "openai-completions",
			provider: "3p-a",
			id: "model-a",
		});
		// buildModel doesn't preserve legacy_style; set directly
		(target.compat as Record<string, unknown>).legacy_style = true;
		const messages: Message[] = [
			makeUser("Hello"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "3p reasoning", thinkingSignature: "sig" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } },
				],
				{ api: "openai-completions", provider: "3p-b", model: "model-b" },
			),
			toolResult("tc1", "ok"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "done" },
				],
				{ stopReason: "stop", api: "openai-completions" },
			),
			makeUser("thanks"),
		];

		const result = transformMessages(messages, target);
		const assistants = result.filter(m => m.role === "assistant");
		const priorContent = (assistants[0] as AssistantMessage).content;
		// legacy_style forces demote
		expect(priorContent.find(b => b.type === "thinking")).toBeUndefined();
		const text = priorContent.find(b => b.type === "text") as { type: "text"; text: string } | undefined;
		expect(text?.text).toBe("3p reasoning");
	});

	it("demotes cross-API to text when target is official OpenAI", () => {
		// 3p openai-completions source → official openai-responses target
		const target = makeModel({
			api: "openai-responses",
			provider: "openai",
			id: "gpt-4o",
			baseUrl: "https://api.openai.com",
		});
		const messages: Message[] = [
			makeUser("Hello"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "3p reasoning", thinkingSignature: "sig" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } },
				],
				{ api: "openai-completions", provider: "3p-b", model: "model-b" },
			),
			toolResult("tc1", "ok"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "done" },
				],
				{ stopReason: "stop", api: "openai-responses" },
			),
			makeUser("thanks"),
		];

		const result = transformMessages(messages, target);
		const assistants = result.filter(m => m.role === "assistant");
		const priorContent = (assistants[0] as AssistantMessage).content;
		// Official target → demote to text
		expect(priorContent.find(b => b.type === "thinking")).toBeUndefined();
		const text = priorContent.find(b => b.type === "text") as { type: "text"; text: string } | undefined;
		expect(text?.text).toBe("3p reasoning");
	});
});

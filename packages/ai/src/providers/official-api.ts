/**
 * Detect official API endpoints by baseUrl.
 *
 * Official APIs (api.openai.com, api.anthropic.com) encrypt or sign reasoning
 * content for security reasons. When targeting these APIs, transformMessages
 * converts thinking blocks to plain text to avoid sending invalid signatures
 * or attempting to decrypt content we don't have keys for.
 *
 * For third-party providers (regardless of API type — anthropic-messages,
 * openai-completions, openai-responses, etc.), this returns false, and
 * reasoning is preserved as native blocks.
 *
 * @param baseUrl - The model's baseUrl to check
 * @returns true if the baseUrl points to an official API endpoint
 */
export function isOfficialApiByUrl(baseUrl: string | undefined): boolean {
	const url = (baseUrl || "").toLowerCase();
	return url.includes("api.openai.com") || url.includes("api.anthropic.com");
}

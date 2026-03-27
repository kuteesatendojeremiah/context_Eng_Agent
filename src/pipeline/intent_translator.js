// ============================================================
// Intent Translator (Paper: GPT-5 → Substitute: Claude Opus)
// Converts vague user requests into structured task specs
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INTENT_SYSTEM_PROMPT = `You are an expert software architect and requirements analyst.
Your job is to take a user's natural language request about a code change or feature,
and transform it into a precise, structured task specification.

Output a JSON object with this exact structure:
{
  "title": "Short task title",
  "summary": "2-3 sentence summary of what needs to be done",
  "requirements": ["requirement 1", "requirement 2", ...],
  "steps": [
    {
      "id": 1,
      "description": "Concrete step description",
      "agent_role": "frontend|backend|devops|reviewer|planner",
      "files_likely_affected": ["path/to/file.js", ...],
      "depends_on": []
    }
  ],
  "acceptance_criteria": ["criterion 1", "criterion 2", ...],
  "complexity": "low|medium|high",
  "search_queries": ["query to find relevant docs", ...]
}

Be specific. Enumerate every file that likely needs changing.
Assign each step to the correct agent role.
List search queries that would help find relevant external documentation.`;

export async function translateIntent(userRequest, projectContext = "") {
  console.log("\n🧠 [Intent Translator] Analyzing request...");

  const userContent = projectContext
    ? `Project context:\n${projectContext}\n\nUser request:\n${userRequest}`
    : `User request:\n${userRequest}`;

  const response = await client.messages.create({
    model: process.env.INTENT_MODEL || "claude-opus-4-5-20251101",
    max_tokens: 2000,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content[0].text;

  try {
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const spec = JSON.parse(jsonMatch[0]);
    console.log(
      `✅ [Intent Translator] Task broken into ${spec.steps.length} steps`
    );
    return spec;
  } catch (e) {
    // Fallback: return raw text wrapped in a basic spec
    console.warn("⚠️  [Intent Translator] Could not parse JSON, using raw spec");
    return {
      title: "Task",
      summary: userRequest,
      requirements: [userRequest],
      steps: [
        {
          id: 1,
          description: userRequest,
          agent_role: "backend",
          files_likely_affected: [],
          depends_on: [],
        },
      ],
      acceptance_criteria: ["Task completed successfully"],
      complexity: "medium",
      search_queries: [userRequest],
      raw: text,
    };
  }
}

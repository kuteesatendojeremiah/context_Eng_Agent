// ============================================================
// Knowledge Retriever (Paper: Elicit → Substitute: Claude with
// web_search tool + Anthropic API)
// Fetches relevant external documentation and guides
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RETRIEVAL_SYSTEM_PROMPT = `You are a research assistant helping a software engineer.
Given search queries about a coding task, find and summarize relevant:
- Library documentation and API references  
- Best practices and implementation guides
- Common patterns and pitfalls to avoid
- Algorithm or architecture explanations

For each query, provide a structured summary of what you found.
Format your response as JSON:
{
  "results": [
    {
      "query": "original query",
      "title": "Resource title",
      "summary": "Key points summary (2-4 sentences)",
      "key_insights": ["insight 1", "insight 2", ...],
      "implementation_notes": "Specific notes for implementation"
    }
  ]
}`;

export async function retrieveKnowledge(searchQueries, taskSpec) {
  console.log("\n🔍 [Knowledge Retriever] Searching for relevant documentation...");

  if (!searchQueries || searchQueries.length === 0) {
    return { results: [] };
  }

  const queriesText = searchQueries
    .slice(0, 5)
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  // Use Claude with web_search tool (substitute for Elicit)
  const response = await client.messages.create({
    model: process.env.INTENT_MODEL || "claude-opus-4-5-20251101",
    max_tokens: 3000,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
      },
    ],
    system: RETRIEVAL_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Task: ${taskSpec.title}\n\nSearch for information on these topics:\n${queriesText}\n\nSummarize what you find as a JSON response.`,
      },
    ],
  });

  // Extract text from response (may include tool_use blocks)
  let fullText = "";
  for (const block of response.content) {
    if (block.type === "text") fullText += block.text;
  }

  try {
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`✅ [Knowledge Retriever] Found ${parsed.results?.length || 0} relevant resources`);
    return parsed;
  } catch {
    console.warn("⚠️  [Knowledge Retriever] Could not parse results, using raw");
    return {
      results: [
        {
          query: searchQueries[0],
          title: "Retrieved Knowledge",
          summary: fullText.slice(0, 500),
          key_insights: [],
          implementation_notes: fullText.slice(0, 1000),
        },
      ],
    };
  }
}

// ============================================================
// Knowledge Synthesizer (Paper: NotebookLM → Substitute: Claude)
// Distills retrieved docs into actionable bullet points
// ============================================================

const SYNTHESIS_SYSTEM_PROMPT = `You are a technical knowledge synthesizer.
Given retrieved documentation and research results, distill them into a concise,
actionable knowledge summary for a software engineer about to implement a feature.

Output JSON:
{
  "executive_summary": "2-3 sentence overview",
  "key_concepts": ["concept: explanation", ...],
  "implementation_guide": ["step 1", "step 2", ...],
  "apis_and_functions": ["function_name: description", ...],
  "pitfalls": ["pitfall: how to avoid", ...],
  "code_patterns": ["pattern name: brief description", ...]
}`;

export async function synthesizeKnowledge(retrievedResults, taskSpec) {
  console.log("\n📚 [Knowledge Synthesizer] Distilling documentation...");

  if (!retrievedResults.results || retrievedResults.results.length === 0) {
    return { executive_summary: "No external knowledge retrieved.", key_concepts: [], implementation_guide: [], apis_and_functions: [], pitfalls: [], code_patterns: [] };
  }

  const docsText = retrievedResults.results
    .map(
      (r) =>
        `### ${r.title}\nQuery: ${r.query}\nSummary: ${r.summary}\nInsights: ${r.key_insights?.join(", ")}\nNotes: ${r.implementation_notes}`
    )
    .join("\n\n");

  const response = await client.messages.create({
    model: process.env.INTENT_MODEL || "claude-opus-4-5-20251101",
    max_tokens: 2000,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Task: ${taskSpec.title}\n\nRetrieved documentation:\n${docsText}\n\nSynthesize this into an actionable knowledge summary.`,
      },
    ],
  });

  const text = response.content[0].text;

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON");
    const parsed = JSON.parse(jsonMatch[0]);
    console.log("✅ [Knowledge Synthesizer] Knowledge distilled successfully");
    return parsed;
  } catch {
    return {
      executive_summary: text.slice(0, 300),
      key_concepts: [],
      implementation_guide: [],
      apis_and_functions: [],
      pitfalls: [],
      code_patterns: [],
    };
  }
}

// ============================================================
// Preview Builder
// Takes all agent outputs and assembles a self-contained
// HTML preview that can be rendered in an iframe.
//
// For web projects: extracts & merges HTML/CSS/JS into one file
// For APIs/components: generates a visual mock/demo page
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PREVIEW_SYSTEM_PROMPT = `You are an expert frontend developer. 
Your job is to take code outputs from multiple AI agents (which may include React components, 
HTML, CSS, JS, API designs, etc.) and produce a SINGLE self-contained HTML file that 
visually demonstrates what was built.

Rules:
1. Output ONLY a complete HTML file. No explanation. No markdown. No code fences.
2. The file must be fully self-contained — all CSS and JS inline, no external dependencies 
   except CDN links for libraries (Tailwind, Alpine.js, Chart.js etc. from cdnjs.cloudflare.com).
3. If the task produced a website/UI: render the actual UI as faithfully as possible.
4. If the task produced an API or backend: render a beautiful mock UI that shows what the 
   feature does (e.g. a card showing endpoint docs + a simulated request/response demo).
5. If the task produced a component: show it rendered with realistic sample data.
6. Make it look REAL and POLISHED. Use proper styling, realistic content, and good design.
7. Include a small "Built by Multi-Agent System" watermark in the bottom corner.
8. The preview should be fully interactive where possible (forms, buttons, navigation, etc.)
9. Use realistic sample data — real brand names, real-looking content, real images from 
   https://images.unsplash.com (free, no auth needed).

Start your response with <!DOCTYPE html> and nothing else.`;

export async function buildPreview(taskSpec, agentResults, reviewResult) {
  console.log("\n🖼️  [Preview Builder] Assembling live preview...");

  // Collect all generated code from agents
  const allCode = agentResults
    .map(
      (ar) =>
        `=== Step ${ar.step.id} (${ar.agentResult.role}): ${ar.step.description} ===\n${ar.agentResult.result}`
    )
    .join("\n\n");

  const prompt = `Task that was built: "${taskSpec.title}"

Summary: ${taskSpec.summary}

Requirements implemented:
${taskSpec.requirements?.join("\n") || ""}

Generated code from all agents:
${allCode.slice(0, 12000)}

Build a self-contained HTML preview that visually demonstrates this project.
Remember: output ONLY the HTML file, starting with <!DOCTYPE html>.`;

  const response = await client.messages.create({
    model: process.env.SUBAGENT_MODEL || "claude-sonnet-4-20250514",
    max_tokens: 8000,
    system: PREVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  let html = response.content[0].text.trim();

  // Ensure it starts with DOCTYPE
  if (!html.startsWith("<!DOCTYPE") && !html.startsWith("<html")) {
    const match = html.match(/<!DOCTYPE[\s\S]*/i) || html.match(/<html[\s\S]*/i);
    html = match ? match[0] : wrapFallback(taskSpec, agentResults);
  }

  console.log(`✅ [Preview Builder] Preview generated (${html.length} chars)`);
  return html;
}

// Fallback if model doesn't produce clean HTML
function wrapFallback(taskSpec, agentResults) {
  const codeBlocks = agentResults
    .map(
      (ar) => `
      <div class="code-block">
        <div class="code-header">${ar.agentResult.role} — ${ar.step.description}</div>
        <pre>${escapeHtml(ar.agentResult.result.slice(0, 2000))}</pre>
      </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${taskSpec.title} — Preview</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  .code-block { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
  .code-header { background: #21262d; padding: 10px 16px; font-size: 0.8rem; color: #8b949e; font-weight: 600; }
  pre { padding: 16px; font-size: 0.75rem; overflow-x: auto; white-space: pre-wrap; color: #79c0ff; }
</style>
</head>
<body>
<h1>${taskSpec.title}</h1>
<p style="color:#8b949e;margin-bottom:24px">${taskSpec.summary}</p>
${codeBlocks}
</body>
</html>`;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// Sub-Agent System
// Defines specialist agents (planner, frontend, backend, etc.)
// and executes them via Claude API
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Agent Role Definitions ────────────────────────────────────────────────────
export const AGENT_ROLES = {
  planner: {
    name: "Planner",
    emoji: "📋",
    system: `You are a senior software architect and technical planner.
Your role is to create detailed, actionable implementation plans for coding tasks.
Given a task specification and codebase context, produce:
1. A step-by-step implementation plan
2. Which files need to be created or modified
3. Dependencies between steps
4. Potential risks and how to mitigate them

Be specific about file paths, function names, and data structures.
Output your plan in clear numbered steps.`,
  },

  frontend: {
    name: "Frontend Specialist",
    emoji: "🎨",
    system: `You are a senior frontend engineer specializing in React, TypeScript, and modern web frameworks.
Your role is to implement UI components, pages, and client-side logic.
Focus on:
- Component architecture and reusability
- State management
- TypeScript types and interfaces
- Accessibility and performance
- Following existing project patterns

Always provide complete, working code. Include imports. Follow the project's coding style.`,
  },

  backend: {
    name: "Backend Architect",
    emoji: "⚙️",
    system: `You are a senior backend engineer specializing in APIs, databases, and server-side logic.
Your role is to implement API routes, database schemas, business logic, and server infrastructure.
Focus on:
- RESTful API design
- Database schema design and migrations
- Error handling and validation
- Security and authentication
- Performance and scalability

Always provide complete, working code with proper error handling.`,
  },

  devops: {
    name: "DevOps Engineer",
    emoji: "🚀",
    system: `You are a senior DevOps engineer specializing in CI/CD, infrastructure, and deployment.
Your role is to handle configuration files, deployment scripts, environment setup, and CI/CD pipelines.
Focus on:
- Docker and containerization
- CI/CD configuration (GitHub Actions, etc.)
- Environment variable management
- Build and deployment scripts
- Monitoring and logging configuration`,
  },

  reviewer: {
    name: "Code Reviewer",
    emoji: "🔍",
    system: `You are an expert code reviewer with deep knowledge of software engineering best practices.
Your role is to review code changes and identify:
1. Bugs and logical errors
2. Security vulnerabilities
3. Performance issues
4. Code style and convention violations
5. Missing error handling
6. TypeScript type issues
7. Missing tests

For each issue found, explain the problem and suggest a fix.
Also highlight what was done well. Be constructive and specific.`,
  },

  tester: {
    name: "Test Engineer",
    emoji: "🧪",
    system: `You are a senior QA/test engineer specializing in automated testing.
Your role is to write comprehensive tests for code changes.
Focus on:
- Unit tests for individual functions
- Integration tests for API endpoints
- Edge cases and error conditions
- Test data setup and teardown
- Using the project's existing test framework

Always write tests that actually verify the behavior, not just that code runs.`,
  },
};

// ── Agent Executor ────────────────────────────────────────────────────────────
export async function runAgent(role, task, context = {}) {
  const agentDef = AGENT_ROLES[role];
  if (!agentDef) throw new Error(`Unknown agent role: ${role}`);

  const { projectContext = "", codeSnippets = [], knowledgeSummary = "", planContext = "" } = context;

  console.log(`\n${agentDef.emoji} [${agentDef.name}] Starting task: ${task.slice(0, 80)}...`);

  // Build context message
  let contextParts = [];

  if (projectContext) {
    contextParts.push(`## Project Context\n${projectContext}`);
  }

  if (knowledgeSummary) {
    contextParts.push(`## Relevant External Knowledge\n${knowledgeSummary}`);
  }

  if (codeSnippets.length > 0) {
    const snippetsText = codeSnippets
      .map((s) => `### ${s.metadata?.file || "file"}:${s.metadata?.start_line || 0}\n\`\`\`\n${s.content.slice(0, 800)}\n\`\`\``)
      .join("\n\n");
    contextParts.push(`## Relevant Code from Repository\n${snippetsText}`);
  }

  if (planContext) {
    contextParts.push(`## Implementation Plan\n${planContext}`);
  }

  const contextMessage = contextParts.join("\n\n---\n\n");
  const fullUserMessage = contextMessage
    ? `${contextMessage}\n\n---\n\n## Your Task\n${task}`
    : `## Your Task\n${task}`;

  const response = await client.messages.create({
    model: process.env.SUBAGENT_MODEL || "claude-sonnet-4-20250514",
    max_tokens: parseInt(process.env.MAX_TOKENS_PER_AGENT || "2800", 10),
    system: agentDef.system,
    messages: [{ role: "user", content: fullUserMessage }],
  });

  const result = response.content[0].text;
  console.log(`✅ [${agentDef.name}] Task completed (${result.length} chars)`);

  return {
    role,
    agentName: agentDef.name,
    task,
    result,
    tokensUsed: response.usage?.input_tokens + response.usage?.output_tokens,
  };
}

// ── File Operations ───────────────────────────────────────────────────────────
export function applyCodeChanges(agentResult, repoPath) {
  const { result } = agentResult;
  const changes = [];

  // Extract code blocks with file paths
  // Pattern: ```language:path/to/file or // FILE: path/to/file
  const fileBlockPattern =
    /```(?:\w+)?(?::([^\n]+))?\n([\s\S]*?)```|\/\/ FILE:\s*([^\n]+)\n([\s\S]*?)(?=\/\/ FILE:|$)/g;

  let match;
  while ((match = fileBlockPattern.exec(result)) !== null) {
    const filePath = match[1] || match[3];
    const code = match[2] || match[4];

    if (filePath && code) {
      const fullPath = path.join(repoPath, filePath.trim());
      const dir = path.dirname(fullPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, code.trim());
      changes.push({ file: filePath.trim(), action: "written" });
      console.log(`📝 Applied: ${filePath.trim()}`);
    }
  }

  return changes;
}

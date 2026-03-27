// ============================================================
// Main Entry Point
// CLI interface for the multi-agent system
// Usage: node src/index.js "your task description here"
// ============================================================

import "dotenv/config";
import { Orchestrator } from "./agents/orchestrator.js";
import { indexRepository } from "./rag/indexer.js";
import fs from "fs";
import path from "path";
import readline from "readline";

// ── CLI Colors ────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

function printBanner() {
  console.log(`
${c.cyan}${c.bold}
╔═══════════════════════════════════════════════════════════╗
║     CONTEXT-ENGINEERED MULTI-AGENT CODE ASSISTANT        ║
║     Based on: arXiv:2508.08322                           ║
╚═══════════════════════════════════════════════════════════╝
${c.reset}
  Components:
  ${c.green}✓${c.reset} Intent Translator    (Claude Opus  ← replaces GPT-5)
  ${c.green}✓${c.reset} Knowledge Retriever  (Web Search  ← replaces Elicit)
  ${c.green}✓${c.reset} Knowledge Synthesizer(Claude      ← replaces NotebookLM)
  ${c.green}✓${c.reset} RAG Code Index       (Local JSON  ← replaces Zilliz/Chroma)
  ${c.green}✓${c.reset} Multi-Agent System   (Claude Code agents)
`);
}

async function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  printBanner();

  // ✅ Use /tmp for Vercel, ./sample_repo locally if REPO_PATH is set
  const repoPath = process.env.REPO_PATH || path.join("/tmp", "sample_repo");

  // Check for required env vars
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "your_anthropic_api_key_here") {
    console.error(`${c.red}❌ ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.${c.reset}`);
    process.exit(1);
  }

  // Create sample repo if it doesn't exist
  if (!fs.existsSync(repoPath)) {
    console.log(`${c.yellow}📁 Creating sample repository at ${repoPath}...${c.reset}`);
    createSampleRepo(repoPath);
  }

  // Auto-index if no index exists
  const indexPath = path.join(process.cwd(), ".code_index.json");
  if (!fs.existsSync(indexPath)) {
    console.log(`${c.yellow}🔍 No code index found. Indexing repository...${c.reset}`);
    await indexRepository(repoPath);
  }

  // Get task from CLI args or prompt
  let userTask = process.argv[2];

  if (!userTask) {
    console.log(`${c.dim}Example tasks:
  • "Add input validation to the user registration form"
  • "Fix the authentication bug where tokens expire too early"
  • "Add a dark mode toggle to the navbar"
  • "Create a REST API endpoint for user profile updates"
${c.reset}`);
    userTask = await promptUser(`${c.cyan}${c.bold}Enter your task: ${c.reset}`);
  }

  if (!userTask.trim()) {
    console.error(`${c.red}❌ No task provided.${c.reset}`);
    process.exit(1);
  }

  // Run the orchestrator
  const orchestrator = new Orchestrator(repoPath);
  const results = await orchestrator.run(userTask);

  // Save report
  const reportPath = path.join(process.cwd(), "reports", `report_${Date.now()}.json`);
  fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
  orchestrator.saveReport(results, reportPath);

  // Print summary
  printResultSummary(results);
}

function printResultSummary(results) {
  const { taskSpec, review, tests, meta } = results;

  console.log(`\n${c.bold}${"─".repeat(60)}${c.reset}`);
  console.log(`${c.bold}📊 EXECUTION SUMMARY${c.reset}`);
  console.log(`${"─".repeat(60)}`);
  console.log(`Task: ${c.cyan}${taskSpec?.title}${c.reset}`);
  console.log(`Steps completed: ${c.green}${meta?.stepsCompleted}${c.reset}`);
  console.log(`Agents used: ${c.green}${meta?.agentsUsed}${c.reset}`);
  console.log(`Duration: ${meta?.duration}`);
  console.log(`Tokens used: ~${meta?.totalTokens}`);

  if (review?.result) {
    console.log(`\n${c.bold}🔍 Code Review Summary:${c.reset}`);
    console.log(review.result.slice(0, 500) + (review.result.length > 500 ? "..." : ""));
  }

  console.log(`\n${c.green}✅ Full results saved to reports/ directory${c.reset}`);
  console.log(`${c.dim}Open reports/report_*.json to see all generated code${c.reset}\n`);
}

// ── Sample Repository Creator ─────────────────────────────────────────────────
function createSampleRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(path.join(repoPath, "src/components"), { recursive: true });
  fs.mkdirSync(path.join(repoPath, "src/api"), { recursive: true });
  fs.mkdirSync(path.join(repoPath, "src/utils"), { recursive: true });

  fs.writeFileSync(path.join(repoPath, "README.md"), `# SampleApp
A sample web application for testing the multi-agent code assistant.
`);

  console.log(`✅ Sample repository created at: ${repoPath}`);
}

main().catch(console.error);
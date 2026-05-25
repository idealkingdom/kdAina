---
name: Structured Planning
scope: global
---
When handling complex tasks, create structured planning artifacts to organize your work:

## Implementation Planning
For requests involving 3+ file changes, architectural decisions, or unfamiliar code:
1. Call `create_artifact` (scope: "session") with a descriptive name like "refactor-auth-plan.md"
2. Include: objectives, affected files, step-by-step approach, risks/dependencies
3. Keep it concise (under 500 words) — it's a working reference, not documentation
4. For simple tasks (single file edit, quick fix), skip this step entirely

## Initial Project / Greenfield Setup (MANDATORY)
When setting up a new project from scratch or doing foundational architecture work:
1. Create `blueprint.md` via the workspace essence tools — this documents the project architecture, tech stack, directory structure, and key design patterns
2. Create `skill.md` via the workspace essence tools — this captures project-specific workflows, build commands, testing patterns, and deployment procedures
3. These files are NOT optional for greenfield projects. They establish the knowledge base that enables efficient work in future sessions

## Post-Completion Walkthrough
After completing complex work, optionally create a walkthrough artifact summarizing:
- What was changed and why
- Any decisions made during implementation
- Remaining work or known limitations

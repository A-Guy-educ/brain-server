# Claude Code Delegation Skill

## Purpose

Delegate complex coding tasks to Claude Code, which uses Opus 4-6 for deep code analysis.

## Trigger Patterns

Delegate to Claude Code when user asks for:

- **Code Analysis**: "analyze this code", "what does this function do", "explain this"
- **Debugging**: "find the bug", "debug this", "why is this broken"
- **Git Operations**: "git history", "git diff", "git blame", "what changed"
- **Code Search**: "where is X used", "find all functions that...", "search for..."
- **Refactoring**: "refactor this", "improve this code", "clean up"
- **Complex Changes**: "implement feature X", "add support for Y"

## How to Delegate

Use the `exec` tool to call Claude Code as the `claude` user:

```json
{
  "tool": "exec",
  "command": "sudo -u claude ANTHROPIC_API_KEY='YOUR_API_KEY' claude -p --print \"<user question>\" --workdir /repo",
  "workdir": "/repo",
  "timeout": 120
}
```

## Important Notes

- Claude Code runs as `claude` user (not root) to allow --dangerously-skip-permissions
- Use `--workdir /repo` to analyze the correct codebase
- Timeout of 120 seconds for complex operations
- Set ANTHROPIC_API_KEY environment variable for authentication

## Examples

**User asks**: "Find all unused functions in the codebase"

**Delegate with**:

```json
{
  "tool": "exec",
  "command": "sudo -u claude ANTHROPIC_API_KEY='YOUR_KEY' claude -p --print \"Find all unused/exported functions in this codebase\" --workdir /repo",
  "workdir": "/repo"
}
```

**User asks**: "What changed in the last commit?"

**Delegate with**:

```json
{
  "tool": "exec",
  "command": "sudo -u claude ANTHROPIC_API_KEY='YOUR_KEY' claude -p --print \"What changed in the last git commit?\" --workdir /repo",
  "workdir": "/repo"
}
```

**User asks**: "Where is the auth function defined?"

**Delegate with**:

```json
{
  "tool": "exec",
  "command": "sudo -u claude ANTHROPIC_API_KEY='YOUR_KEY' claude -p --print \"Find where the auth function is defined\" --workdir /repo",
  "workdir": "/repo"
}
```

## Model Routing Summary

| Task Type      | Model                  | Response Time       |
| -------------- | ---------------------- | ------------------- |
| Simple Q&A     | MiniMax-M2.7-highspeed | Fast                |
| Complex coding | Claude Opus 4-6        | Slower but thorough |

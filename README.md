# claude-orchestrator

Central MCP plugin for Claude Code that provides persistent tooling for reminders, workflows, skill self-improvement, session state, multi-model dispatch, and agent team coordination.

## Features

- **21 tools** across 6 groups
- **Atomic writes** — crash-safe JSON persistence (tmp + fsync + rename)
- **Schema versioning** — future-proof storage migrations
- **Task state machine** — robust async dispatch with marker files
- **Startup recovery** — detects and recovers orphaned dispatch tasks
- **Pagination** — all list tools support limits
- **Pre-built workflow templates** — new-skill, multi-model-critique, publish-to-github

## Tool Groups

### Reminders (3 tools)
| Tool | Purpose |
|------|---------|
| `set_reminder` | Create contextual reminder (keyword/event/always triggers) |
| `list_reminders` | List/match reminders with optional context firing |
| `dismiss_reminder` | Remove a reminder |

### Workflows (4 tools)
| Tool | Purpose |
|------|---------|
| `define_workflow` | Create reusable workflow template |
| `start_workflow` | Begin from template or custom steps |
| `get_workflow_status` | Current step, progress, notes |
| `advance_step` | Complete current step, move next |

### Skill Learning (3 tools)
| Tool | Purpose |
|------|---------|
| `note_learning` | Record a pattern/gotcha for a skill |
| `get_learnings` | Retrieve learnings (paginated) |
| `fold_learnings` | Generate SKILL.md update suggestions |

### Session Context (3 tools)
| Tool | Purpose |
|------|---------|
| `set_context` | Persist key-value across sessions |
| `get_context` | Retrieve one or all entries |
| `clear_context` | Remove an entry |

### Multi-Model Dispatch (5 tools)
| Tool | Purpose |
|------|---------|
| `dispatch` | Send task to Codex/Gemini |
| `get_dispatch_result` | Get status and output |
| `cancel_dispatch` | Kill running task |
| `retry_dispatch` | Re-run failed task |
| `list_dispatches` | Dispatch history |

### Agent Teams (3 tools)
| Tool | Purpose |
|------|---------|
| `create_team` | Define team with goal and roles |
| `get_team_status` | Active teams and progress |
| `dissolve_team` | Clean up a team |

## Installation

```bash
# Clone
git clone https://github.com/ccwriter369-beep/claude-orchestrator.git ~/.claude/plugins/claude-orchestrator

# Install & build
cd ~/.claude/plugins/claude-orchestrator
bun install
bun run build

# Register with Claude Code
claude mcp add orchestrator node ~/.claude/plugins/claude-orchestrator/scripts/mcp-server.cjs
```

## Development

```bash
bun install          # Install deps
bun run build        # Build CJS bundle
bun test             # Run tests
```

## Architecture

- **Runtime**: Bun + TypeScript → single CJS bundle via `bun build`
- **Transport**: stdio (MCP SDK standard)
- **Storage**: JSON files in `~/.claude/orchestrator/` with atomic writes
- **Dispatch**: Wraps `dispatch-wrapper.sh` with task state machine

## Storage Safety

Every write follows: `writeFileSync(tmp)` → `fsyncSync` → `renameSync(tmp, target)`. This prevents corruption on crash. Schema version fields enable future migrations.

## License

MIT

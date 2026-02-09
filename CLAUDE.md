# claude-orchestrator

Central MCP plugin providing 21 tools across 6 groups for session orchestration.

## Tool Groups
1. **Context** (3): set_context, get_context, clear_context
2. **Reminders** (3): set_reminder, list_reminders, dismiss_reminder
3. **Workflows** (4): define_workflow, start_workflow, get_workflow_status, advance_step
4. **Learning** (3): note_learning, get_learnings, fold_learnings
5. **Dispatch** (5): dispatch, get_dispatch_result, cancel_dispatch, retry_dispatch, list_dispatches
6. **Teams** (3): create_team, get_team_status, dissolve_team

## Storage
- All data in `~/.claude/orchestrator/` as JSON files
- Atomic writes: tmp → fsync → rename
- Schema versioned for future migrations

## Dispatch
- Wraps `~/.claude/orchestration/templates/dispatch-wrapper.sh`
- Task state machine: created → running → completed/failed/cancelled/timeout
- Marker files for status tracking
- Startup recovery for orphaned tasks

## Workflow Templates
- `new-skill` — full skill creation flow
- `multi-model-critique` — draft → dispatch to Codex+Gemini → synthesize
- `publish-to-github` — verify → test → push → update memory

## Development
```bash
bun run build   # Build CJS bundle
bun test        # Run tests
```

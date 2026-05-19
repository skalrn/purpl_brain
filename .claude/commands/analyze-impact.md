Analyze the impact of a proposed change on existing architectural decisions stored in the project brain.

Use the `brain_analyze_impact` MCP tool with:
- `change_description`: $ARGUMENTS
- `project_id`: use the project_id from CLAUDE.md if set, otherwise ask the user

Report:
1. Overall risk tier (critical / high / medium / low)
2. Which existing decisions are affected and why
3. Any linked Jira tickets that may be impacted
4. A concrete recommendation — proceed as-is, proceed with caution, or stop and discuss first

If $ARGUMENTS is empty, ask the user to describe the change they are about to make before calling the tool.

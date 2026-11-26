---
name: development-workflow
description: "Use for implementation: scale scope, delivery steps and verification to the size of the change."
metadata:
  pibot-version: "1"
  pibot-name: "Development delivery"
---

# Development delivery

1. Establish deliverables and observable behavior from existing requirements and project instructions; small fixes need scope and acceptance points, while features need a brief approach.
2. Split complex features by contracts, data changes and dependencies into independently checkable steps, using existing documentation locations.
3. Before editing, use `code_navigate` to locate the target declaration with its references and callers (outline / symbol first, then read only the relevant ranges) instead of reading the whole repository; follow the references when a contract changes.
4. Complete a minimal end-to-end path before exception handling and compatibility work, avoiding unrelated modules in the same change.
5. Run checks with commands the project itself declares (package.json scripts, check commands in the project instructions): targeted typecheck / lint / tests for the changed packages or files first, then the full check the project requires; do not invent commands or skip failures. Commands run through run_command under current permissions; if refused, say so and keep the results already produced.
6. Record artifact locations and verification evidence for completed work (what actually ran and how it ended), and blockers and next actions for remaining work.

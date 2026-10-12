---
name: drive-pr-stack
description: Use when several dependent PRs (A→B→C, each based on the previous branch) must each reach a mergeable state in merge order, or the user says "drive the stack".
---

# Drive a PR Stack (outer loop)

## Overview

Run **drive-pr-to-mergeable** on each PR in merge order. REQUIRED SUB-SKILL:
drive-pr-to-mergeable (all its rules, including "no merge without explicit user
approval", apply per PR and to the stack as a whole).

## Inputs

Ordered list: PR number, branch, base, worktree. Stack-specific context
(temporary fallbacks, follow-up PR plans, peer handoffs) is passed as args,
never baked in here. Baselines per PR.

## Steps

1. `ListAgents`: no other session working on any of these PRs.
2. For each PR in order: finish its inner loop (fix the parent first).
3. **Merge-forward** the finished PR's branch into the next PR's branch (merge
   commit, no rebase, no force-push), push, then start the next inner loop.
4. A fix to an earlier PR after a later one started → merge-forward again
   through every child. After any merge-forward, the child's next review is
   against its base branch (`--base origin/<parent-branch>`), not its last
   reviewed SHA, so parent commits are not re-reviewed as the child's; re-record
   the child's baseline.
5. Not converging on one PR → stop the whole stack, get a second opinion (the
   `advisor` tool if available), then the user.

## Ready report

Per-PR table (rounds, issues filed, CI), deferred items, merge order. Ask:
"Ready — which PRs do you authorize me to merge?" Merge nothing, and in no
order, until the user names them by number (merge approval rules:
drive-pr-to-mergeable). **Before** merging an authorized parent, retarget its
child PR to the parent's base (`gh pr edit <child> --base <parent's base>`): if
the parent's branch is deleted first, GitHub closes the child for good. Never
merge a child into its parent branch. After the retarget, the child's `<base>`
is the new base: use it for sync, review and baseline from then on. After a
parent merges, each child gets a new head (merge the new base, push): re-run its
gates and CI, send its ready report again, and ask again for that PR — an
earlier authorization covered the old head. Any agreed post-merge handoff (e.g.
sending a merge SHA to a peer) happens only after the user-authorized merge.

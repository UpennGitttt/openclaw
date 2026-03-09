# Feishu Multi-Account Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Feishu plugin tools bind to the current agent/message account instead of the first configured account.

**Architecture:** Reuse OpenClaw plugin tool factory context (`agentAccountId`) and existing Feishu account resolution helpers. Keep the change inside the Feishu extension. Add regression tests that prove tools use the active account and respect per-account tool enablement.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin SDK, Feishu extension

---

### Task 1: Write failing regression tests

- Add tests for `feishu_doc` using `agentAccountId` instead of the first configured account.
- Add tests for `feishu_drive`, `feishu_perm`, `feishu_wiki`, and `feishu_bitable` to cover the same multi-account binding.
- Run the targeted Feishu extension tests and verify failure.

### Task 2: Implement minimal account-resolution fix

- Add a shared helper that resolves the active Feishu account from `agentAccountId`, falling back to the configured default account.
- Convert Feishu tool registrations to plugin tool factories so each tool instance is created with the current account context.
- Preserve existing behavior for single-account configs.

### Task 3: Verify and tighten

- Re-run targeted tests and full Feishu extension tests.
- Confirm the reproduced session failure maps to the wrong-account bug.
- Summarize root cause, fix scope, and any remaining risks.

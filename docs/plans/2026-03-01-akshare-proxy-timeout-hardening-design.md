# AKShare Proxy Isolation + Hard Timeout (Design)

Date: 2026-03-01
Owner: yuhaoyou

## Context

AKShare requests intermittently fail with `ProxyError` and `RemoteDisconnected` even when `AKSHARE_DISABLE_PROXY=true`. Current implementation only strips env proxy vars during calls; AKShare also uses its internal proxy config (`akshare.utils.context.config.proxies`), so system or inherited proxies can still be applied. In addition, some calls exceed the tool-level 30s timeout, causing chain failures.

## Goals

- Enforce strong, per-call proxy isolation for AKShare only.
- Add a hard timeout so single calls cannot block the tool for long.
- Preserve existing retry/backoff behavior and call budgets.
- No impact to OpenClaw `web_search` or other tools.

## Non-Goals

- Change global proxy behavior for the whole process.
- Replace AKShare data sources or refactor unrelated tool logic.
- Optimize performance beyond the timeout guard.

## Proposal

### 1) Strong proxy isolation for AKShare calls

Create a stricter context used inside `_call_akshare_with_retry`:

- Clear env proxy vars (`http_proxy`, `https_proxy`, `all_proxy`, plus uppercase variants).
- Set `NO_PROXY=*` (and `no_proxy=*`) for the duration of the call.
- Call `akshare.utils.context.set_proxies({})` for the duration of the call (and restore previous value afterwards).

This guarantees `requests` sees no proxies and AKShare internal proxy config is empty during the call. Scope is limited to the call context so other tools are unaffected.

### 2) Add a hard timeout per call

Wrap the AKShare function call in a `ThreadPoolExecutor` and enforce a hard timeout (env-driven, default 12s):

- `AKSHARE_HARD_TIMEOUT_SECONDS` (global default for all calls)
- Optional per-path overrides (e.g. `AKSHARE_QUOTE_HARD_TIMEOUT_SECONDS`, `AKSHARE_SPOT_HARD_TIMEOUT_SECONDS`)

If the hard timeout is exceeded, abort the wait and raise a clear error: `AKShare 硬超时：超过 X 秒`.

### 3) Testing

Add tests to `test_akshare_resilience.py`:

- Proxy isolation sets `NO_PROXY` and restores it afterwards.
- Proxy isolation calls `set_proxies({})` and restores previous proxies.
- Hard timeout triggers when a call blocks longer than the limit.

## Behavior Summary

- AKShare calls never use proxies unless we explicitly allow them in the future.
- Long-running calls fail fast with a hard timeout error.
- `web_search` and other tools remain unchanged.

## Risks and Mitigations

- Some environments require proxies for external access: the strong isolation would cause AKShare calls to fail. This is expected; the environment must provide direct access for AKShare.
- Hard timeout uses threads; the worker thread may continue briefly, but the tool returns promptly and avoids cascading timeouts.

## Rollout

- Implement proxy guard + hard timeout.
- Run unit tests for AKShare resilience.
- Validate with `get_data_source_health` and `get_stock_quote`.

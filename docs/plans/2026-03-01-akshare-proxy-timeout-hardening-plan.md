# AKShare Proxy Isolation + Hard Timeout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure AKShare calls always bypass proxies and enforce a hard timeout to avoid chain timeouts.

**Architecture:** Wrap AKShare calls in a strict no-proxy context and add a hard timeout guard inside the retry wrapper. Keep changes local to `akshare_tools.py` so other tools (e.g. `web_search`) are unaffected.

**Tech Stack:** Python 3.12, unittest, ThreadPoolExecutor.

---

Note: The target files live under `/Users/yuhaoyou/.openclaw/agents/anthony/tools`, which is outside the git repo. Commit steps are included for discipline, but skip if not applicable.

### Task 1: Add failing tests for proxy guard and hard timeout

**Files:**

- Modify: `/Users/yuhaoyou/.openclaw/agents/anthony/tools/tests/test_akshare_resilience.py`

**Step 1: Write the failing test**

```python
    def test_proxy_guard_sets_no_proxy_and_restores(self):
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:7890"
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7890"
        os.environ["NO_PROXY"] = "localhost"

        with tools._without_proxy_env(enabled=True):
            self.assertNotIn("HTTP_PROXY", os.environ)
            self.assertNotIn("HTTPS_PROXY", os.environ)
            self.assertEqual(os.environ.get("NO_PROXY"), "*")

        self.assertEqual(os.environ.get("HTTP_PROXY"), "http://127.0.0.1:7890")
        self.assertEqual(os.environ.get("HTTPS_PROXY"), "http://127.0.0.1:7890")
        self.assertEqual(os.environ.get("NO_PROXY"), "localhost")

    def test_proxy_guard_calls_akshare_set_proxies(self):
        calls = []

        def fake_set(value):
            calls.append(value)
            return {"http": "old"}

        with mock.patch("akshare_tools._set_akshare_proxies", side_effect=fake_set):
            with tools._without_proxy_env(enabled=True):
                pass

        self.assertEqual(calls[0], {})
        self.assertEqual(calls[-1], {"http": "old"})

    def test_hard_timeout_triggers(self):
        def slow():
            time.sleep(0.05)
            return "ok"

        with self.assertRaises(Exception) as ctx:
            tools._call_akshare_with_retry(
                slow,
                max_retries=0,
                backoff_seconds=0,
                hard_timeout_seconds=0.01,
            )

        self.assertIn("硬超时", str(ctx.exception))
```

**Step 2: Run test to verify it fails**

Run: `/opt/homebrew/opt/python@3.12/bin/python3.12 -m pytest -q /Users/yuhaoyou/.openclaw/agents/anthony/tools/tests/test_akshare_resilience.py`

Expected: FAIL with missing `_set_akshare_proxies` and no hard timeout behavior.

**Step 3: Commit**

```bash
git -C /Users/yuhaoyou/openclaw status --short
# If these files are not tracked in git, skip commit.
```

### Task 2: Implement strong proxy guard

**Files:**

- Modify: `/Users/yuhaoyou/.openclaw/agents/anthony/tools/akshare_tools.py`

**Step 1: Write minimal implementation**

```python
@contextlib.contextmanager
def _without_proxy_env(enabled: bool = True):
    if not enabled:
        yield
        return
    removed = {}
    for key in _PROXY_ENV_KEYS:
        if key in os.environ:
            removed[key] = os.environ.pop(key)

    old_no_proxy = os.environ.get("NO_PROXY")
    old_no_proxy_lower = os.environ.get("no_proxy")
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"

    old_akshare = _set_akshare_proxies({})
    try:
        yield
    finally:
        _set_akshare_proxies(old_akshare)
        if old_no_proxy is None:
            os.environ.pop("NO_PROXY", None)
        else:
            os.environ["NO_PROXY"] = old_no_proxy
        if old_no_proxy_lower is None:
            os.environ.pop("no_proxy", None)
        else:
            os.environ["no_proxy"] = old_no_proxy_lower
        for key, value in removed.items():
            os.environ[key] = value
```

Also add helper:

```python
def _set_akshare_proxies(value):
    try:
        from akshare.utils import context as ak_context
    except Exception:
        return None
    old = ak_context.get_proxies()
    ak_context.set_proxies(value)
    return old
```

**Step 2: Run test to verify it passes**

Run: `/opt/homebrew/opt/python@3.12/bin/python3.12 -m pytest -q /Users/yuhaoyou/.openclaw/agents/anthony/tools/tests/test_akshare_resilience.py`

Expected: FAIL only on hard timeout test (proxy tests now pass).

**Step 3: Commit**

```bash
git -C /Users/yuhaoyou/openclaw status --short
# If these files are not tracked in git, skip commit.
```

### Task 3: Implement hard timeout in retry wrapper

**Files:**

- Modify: `/Users/yuhaoyou/.openclaw/agents/anthony/tools/akshare_tools.py`

**Step 1: Write minimal implementation**

```python
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

def _run_with_hard_timeout(func, args, kwargs, timeout_seconds: float):
    if timeout_seconds is None or timeout_seconds <= 0:
        return func(*args, **kwargs)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(func, *args, **kwargs)
        try:
            return future.result(timeout=timeout_seconds)
        except FutureTimeout:
            raise Exception(f"AKShare 硬超时：超过 {timeout_seconds:.1f} 秒")
```

Update `_call_akshare_with_retry` signature and call:

```python
def _call_akshare_with_retry(..., hard_timeout_seconds: float = None, ...):
    hard_timeout = _safe_float_env("AKSHARE_HARD_TIMEOUT_SECONDS", 12.0) if hard_timeout_seconds is None else hard_timeout_seconds
    ...
    with _without_proxy_env(enabled=remove_proxy):
        return _run_with_hard_timeout(func, args, kwargs, hard_timeout)
```

Pass overrides where needed (spot/quote):

```python
spot_timeout = _safe_float_env("AKSHARE_SPOT_HARD_TIMEOUT_SECONDS", hard_timeout)
quote_timeout = _safe_float_env("AKSHARE_QUOTE_HARD_TIMEOUT_SECONDS", hard_timeout)
```

**Step 2: Run test to verify it passes**

Run: `/opt/homebrew/opt/python@3.12/bin/python3.12 -m pytest -q /Users/yuhaoyou/.openclaw/agents/anthony/tools/tests/test_akshare_resilience.py`

Expected: PASS.

**Step 3: Commit**

```bash
git -C /Users/yuhaoyou/openclaw status --short
# If these files are not tracked in git, skip commit.
```

### Task 4: Update tool README

**Files:**

- Modify: `/Users/yuhaoyou/.openclaw/agents/anthony/tools/README.md`

**Step 1: Add env var docs**

Add to the env list:

- `AKSHARE_HARD_TIMEOUT_SECONDS` (default 12)
- `AKSHARE_QUOTE_HARD_TIMEOUT_SECONDS`
- `AKSHARE_SPOT_HARD_TIMEOUT_SECONDS`
- Note that AKShare always bypasses proxies regardless of system settings

**Step 2: Commit**

```bash
git -C /Users/yuhaoyou/openclaw status --short
# If these files are not tracked in git, skip commit.
```

### Task 5: Verification (manual)

Run:

- `openclaw gateway call chat.send ... get_data_source_health`
- `openclaw gateway call chat.send ... get_stock_quote 601138`

Expected:

- Health check shows `AKSHARE_DISABLE_PROXY` true and no ProxyError from env proxies.
- Quote returns quickly or fails with hard timeout message (not 30s stall).

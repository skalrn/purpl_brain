# Labeling Scaffold — encode/httpx PRs

For each PR below, decide:
1. Does the PR (or its reviews/comments) contain a **decision**?
   A decision = a choice made with rationale: technology, approach, API design, deliberate trade-off.
   Bug fixes and refactors without design discussion are NOT decisions.
2. If yes, what is the decision? Record it in `label-scaffold.json`:
   - `has_decision: true`
   - `decisions: [{ quoted_text: "...", summary: "..." }]`

---

## PR #3773 — https://github.com/encode/httpx/pull/3773
**event_id:** `seed_pr_3773`

### PR content
```
Adapt test_response_decode_text_using_autodetect for chardet 6.0

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

See https://github.com/encode/httpx/discussions/3772. Version 6.0.0 of `chardet` detects this byte string as `WINDOWS-1252`, while previous versions detected `ISO-8859-1`. Since both are plausible (the encoded byte string decodes to the same Unicode string under either encoding), this PR adjusts the test to accept either claim.
<!-- Write a small summary about what is happening here. -->

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [x] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change. **No new test required, as this fixes a test regression.**
- [x] I've updated the documentation accordingly. **No documentation changes required.**

```

### Reviews / comments (1)
**lovelydinosaur** (pr_review):
```
There's more we could say about this, though... yep. Thanks
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3765 — https://github.com/encode/httpx/pull/3765
**event_id:** `seed_pr_3765`

### PR content
```
docs: use canonical Requests docs URL

Update Requests docs link to `/en/latest/` (canonical stable URL).
```

### Reviews / comments (1)
**droppingbeans** (comment):
```
Closing to focus PR bandwidth on higher-priority repos. Thanks for considering!
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3762 — https://github.com/encode/httpx/pull/3762
**event_id:** `seed_pr_3762`

### PR content
```
Bump cryptography from 45.0.7 to 46.0.5

Bumps [cryptography](https://github.com/pyca/cryptography) from 45.0.7 to 46.0.5.
<details>
<summary>Changelog</summary>
<p><em>Sourced from <a href="https://github.com/pyca/cryptography/blob/main/CHANGELOG.rst">cryptography's changelog</a>.</em></p>
<blockquote>
<p>46.0.5 - 2026-02-10</p>
<pre><code>
* An attacker could create a malicious public key that reveals portions of your
  private key when using certain uncommon elliptic curves (binary curves).
  This version now includes additional security checks to prevent this attack.
  This issue only affects binary elliptic curves, which are rarely used in
  real-world applications. Credit to **XlabAI Team of Tencent Xuanwu Lab and
  Atuin Automated Vulnerability Discovery Engine** for reporting the issue.
  **CVE-2026-26007**
* Support for ``SECT*`` binary elliptic curves is deprecated and will be
  removed in the next release.
<p>.. v46-0-4:</p>
<p>46.0.4 - 2026-01-27<br />
</code></pre></p>
<ul>
<li><code>Dropped support for win_arm64 wheels</code>_.</li>
<li>Updated Windows, macOS, and Linux wheels to be compiled with OpenSSL 3.5.5.</li>
</ul>
<p>.. _v46-0-3:</p>
<p>46.0.3 - 2025-10-15</p>
[truncated]
```

### Reviews / comments (1)
**dependabot[bot]** (comment):
```
Superseded by #3785.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3759 — https://github.com/encode/httpx/pull/3759
**event_id:** `seed_pr_3759`

### PR content
```
Fix: Merge URL query parameters instead of replacing them

## Summary

Fixes #3621

When a URL already contains query parameters and additional `params` are passed, httpx was dropping the original URL parameters instead of merging them. This was inconsistent with the `requests` library behavior.

## Problem

```python
url = 'https://api.com/get?page=1&sort=desc'
params = {'size': 10, 'filter': 'active'}

# Before this fix
response = httpx.get(url=url, params=params)
# URL sent: https://api.com/get?size=10&filter=active
# (page=1 and sort=desc were lost!)

# After this fix
response = httpx.get(url=url, params=params)
# URL sent: https://api.com/get?page=1&sort=desc&size=10&filter=active
# (all parameters are present)
```

## Solution

Modified `URL.__init__()` in `_urls.py` to:
1. Extract existing query parameters from the URL
2. Merge them with new parameters from the `params` argument
3. When the same key exists in both, new params override old ones (merge semantics)

## Changes

- Modified `httpx/_urls.py`: Updated param handling to merge instead of replace
- Added comprehensive tests in `tests/models/test_url.py`

## Test Cases

**Merge existing and new params:**
```python
url =
[truncated]
```

### Reviews / comments (2)
**veeceey** (comment):
```
All CI passing on Python 3.9-3.13, ready for merge
```
**veeceey** (comment):
```
Closing in favor of #3761 which takes a simpler approach - using the existing `copy_merge_params()` method in `Request.__init__` rather than modifying the `URL` constructor. Less invasive and leverages existing API.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3746 — https://github.com/encode/httpx/pull/3746
**event_id:** `seed_pr_3746`

### PR content
```
Fix SSL context memory issue by breaking reference cycles (#3734)

## Summary

This PR fixes issue #3734 by breaking reference cycles in `BoundSyncStream` and `BoundAsyncStream` that prevent timely garbage collection of SSL contexts.

## Problem

When using `httpx.Client` or `httpx.AsyncClient`, the `create_ssl_context()` function is called for each Transport instantiation. Each SSL context can consume 10s or 100s of MB of memory.

The issue is exacerbated by reference cycles between `Response` objects and their associated `BoundSyncStream`/`BoundAsyncStream` instances:

```
response.stream → BoundSyncStream
BoundSyncStream._response → response  ← creates cycle!
```

This cycle prevents the garbage collector from immediately reclaiming response objects and their associated resources (including SSL contexts), leading to excessive memory usage.

## Solution

Use `weakref.ref` to break the reference cycle. The stream now holds a weak reference to the response instead of a strong reference:

```python
# Before
self._response = response

# After  
self._response_ref = weakref.ref(response)
```

When closing the stream, we safely dereference and only set `ela
[truncated]
```

### Reviews / comments (1)
**rodrigobnogueira** (comment):
```
duplicate
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3739 — https://github.com/encode/httpx/pull/3739
**event_id:** `seed_pr_3739`

### PR content
```
chore: add support for Python 3.14

# Summary

Similar to PR #3460, we add support for Python 3.14 to the classifiers and the CI test matrix.

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [x] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
- [ ] I've updated the documentation accordingly.

```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3731 — https://github.com/encode/httpx/pull/3731
**event_id:** `seed_pr_3731`

### PR content
```
[WIP] Fix errors for invalid request schemes and missing host

Thanks for the feedback on #3729. I've created this new PR, which merges into #3729, to address your comment. I will work on the changes and keep this PR's description up to date as I make progress.

Original PR: #3729
Triggering comment (https://github.com/encode/httpx/pull/3729#issuecomment-3665379256):
> @copilot Are you able to re-run these tests merging against the latest v1.


<!-- START COPILOT CODING AGENT TIPS -->
---

💡 You can make Copilot smarter by setting up custom instructions, customizing its development environment and configuring Model Context Protocol (MCP) servers. Learn more [Copilot coding agent tips](https://gh.io/copilot-coding-agent-tips) in the docs.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3730 — https://github.com/encode/httpx/pull/3730
**event_id:** `seed_pr_3730`

### PR content
```
3.11+

Removed Python 3.10 from the test matrix.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3720 — https://github.com/encode/httpx/pull/3720
**event_id:** `seed_pr_3720`

### PR content
```
fix: resolve test hang with websockets 14+

## Summary

Fixes #3708

The test suite hangs indefinitely when upgrading `websockets` from 13.x to 14.x or 15.x. This is because [websockets 14.0 switched to a new asyncio implementation](https://websockets.readthedocs.io/en/stable/project/changelog.html#id12) by default, which has different behavior around event loop handling.

## Root Cause

The issue stems from how the `TestServer` manages event loops when running in a background thread:

1. **In `TestServer.serve()`**: The deprecated `asyncio.get_event_loop()` + `loop.create_task()` pattern doesn't work correctly with websockets 14+'s new asyncio handling
2. **In `serve_in_thread()`**: The `server.run()` method relies on `asyncio.run()` which doesn't play well with the threaded setup when websockets is involved

## Changes

1. **`TestServer.serve()`**: Replace deprecated `asyncio.get_event_loop()` pattern with `asyncio.create_task()` which is the modern way to create tasks when already inside an async context.

2. **`serve_in_thread()`**: Instead of relying on `server.run()` which uses `asyncio.run()`, explicitly create a new event loop in the background thread with `asyncio.new_even
[truncated]
```

### Reviews / comments (4)
**karpetrosyan** (comment):
```
Duplicate of #3693, but thank you very much for the contribution. I will mention you in the fix as a co author!
```
**mtelka** (comment):
```
@SamMorrowDrums I applied this change on top of `httpx 0.28.1` and testing still hangs for me with Python 3.9.25 and `websockets 15.0.1`.  Any suggestion?  Thank you.
```
**mtelka** (comment):
```
When I uninstall `websockets 15.0.1` then all tests pass.
```
**mtelka** (comment):
```
Please note that I use `uvicorn 0.39.0`.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3719 — https://github.com/encode/httpx/pull/3719
**event_id:** `seed_pr_3719`

### PR content
```
fix: set default elapsed on MockTransport responses

## Summary

This PR fixes #3712 by setting a default `elapsed` value of `timedelta(0)` on responses returned from `MockTransport`.

## Problem

When creating a `Response` with pre-loaded content (e.g., `json=...`, `content=...`, `text=...`), the content is immediately read into `_content` in the Response's `__init__`. Later, when the client wraps the response stream with `BoundSyncStream`/`BoundAsyncStream` to track elapsed time, the stream is never actually consumed because `_content` is already set.

This causes a `RuntimeError` when accessing `response.elapsed`:

```python
def handler(request):
    return httpx.Response(200, json={"message": "Hello"})

transport = httpx.MockTransport(handler)
with httpx.Client(transport=transport) as client:
    response = client.get("https://example.com/")
    print(response.elapsed)  # RuntimeError: .elapsed accessed before response finished
```

## Solution

Set `elapsed = timedelta(0)` as a default in `MockTransport.handle_request()` and `handle_async_request()` if the response doesn't already have `_elapsed` set.

This:
1. Allows users to access `response.elapsed` without errors
2. Preser
[truncated]
```

### Reviews / comments (2)
**SamMorrowDrums** (comment):
```
The CI failure appears to be an unrelated flaky network test (`test_sync_proxy_close` in `tests/client/test_proxies.py`) that timed out trying to connect to a proxy server:

```
E   httpx.ReadTimeout: timed out
tests/client/test_proxies.py:118
```

Test summary: **1 failed, 1416 passed, 1 skipped**

This is not related to the MockTransport changes in this PR. 
```
**karpetrosyan** (comment):
```
I'll close this for now until we have a good design decision around it
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3715 — https://github.com/encode/httpx/pull/3715
**event_id:** `seed_pr_3715`

### PR content
```
Feat/mock transport duration

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

This PR adds native support for simulating request latency in MockTransport by introducing an optional delay parameter.
When provided, the transport sets response.elapsed according to the delay value, unless the handler explicitly defines its own elapsed time.

This resolves the inconvenience described in issue #3712, where users needed to manually patch response.elapsed inside handlers to test timeout- or latency-sensitive logic.

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [x] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
- [x] I've updated the documentation accordingly.

```

### Reviews / comments (1)
**karpetrosyan** (comment):
```
I'll close this for now until we have a good design decision around it
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3711 — https://github.com/encode/httpx/pull/3711
**event_id:** `seed_pr_3711`

### PR content
```
typo on docs

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

<!-- Write a small summary about what is happening here. -->

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [x] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
- [x] I've updated the documentation accordingly.

```

### Reviews / comments (1)
**karpetrosyan** (comment):
```
There is no type here. It’s saying that you are trying to pass a synchronous auth class to `AsyncClient`
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3703 — https://github.com/encode/httpx/pull/3703
**event_id:** `seed_pr_3703`

### PR content
```
docs/ssl: fix typo

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

<!-- Write a small summary about what is happening here. -->

Fix typo equivelent -> equivalent

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [ ] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
- [ ] I've updated the documentation accordingly.

```

### Reviews / comments (1)
**karpetrosyan** (pr_review):
```
Thanks for the contribution!
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3699 — https://github.com/encode/httpx/pull/3699
**event_id:** `seed_pr_3699`

### PR content
```
Expose `FunctionAuth` in `__all__`

# Summary

Just adding `FunctionAuth` to `httpx._auth`'s `__all__` so it can be imported as `httpx.FunctionAuth`.

(Note this just seems to be an omission in https://github.com/encode/httpx/pull/3106)

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [ ] ~I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.~
  - `tests/test_exported_members.py:test_exported_members` covers this
- [ ] ~I've updated the documentation accordingly.~
  - Also didn't seem worth documenting 🤷‍♂️ 

```

### Reviews / comments (1)
**karpetrosyan** (pr_review):
```
LGTM! Thanks
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3698 — https://github.com/encode/httpx/pull/3698
**event_id:** `seed_pr_3698`

### PR content
```
support chunked upload in async file-like interfaces

# Summary

This PR resolves #1620 and implements chunked upload for `anyio.open_file`, `trio.open_file` and `aiofiles.open_file` when used as `content=` parameter for `post` and `put` request. And implements support for multipart file upload for the same libraries. Most of the code for multipart file upload copied from my old stale PR https://github.com/encode/httpx/pull/3339.

changes:
- `_compat.py` file added to define `TypeIs` and `aclosing` for the range of supported python versions
- `_types.AsyncReadableFile` protocol was added along with `is_async_readable_file` type predicate function to detect and perform type narrowing for trio/asyncio/aiofiles async files
- `_types.FileContent` was extended to include the. `_types.AsyncReadableFile` protocol
- `_content.AsyncIteratorByteStream` updated to use `async read` methods for async files instead of looping over lines
- `_content.encode_content` updated to attach content length header for `_types.AsyncReadableFile` type
- `_multipart.FileField` updated to include async versions of `render` and `render_data`
- `_multipart.MultipartStream` updated with async version o
[truncated]
```

### Reviews / comments (1)
**maretodoric** (comment):
```
It's 2026, python is booming with async functionality, feature requested since early 2021, multiple pull requests open - yet we still don't have this feature.
What gives?
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3694 — https://github.com/encode/httpx/pull/3694
**event_id:** `seed_pr_3694`

### PR content
```
feat: warn when brotli extra missing

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

feat: warn when brotli extra missing

  - add explicit warning if server sends Content-Encoding: br without brotli support
  - surface optional feature flags in decoders and ensure behavior covered by test
  - document this repo's contribution workflow for agents in AGENTS.md

  PR description:

  ## Summary
  - raise a clear warning when responses arrive with Content-Encoding: br but brotli support isn't installed to avoid silent compressed payloads
  - expose decoder availability via flags to share state with response handling
  - document contributor workflow and add a regression test covering the warning path

  ## Testing
  - scripts/install
  - scripts/test

<!-- Write a small summary about what is happening here. -->

# Checklist

- [ ] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [ ] I've added a test for each change that was introduced, and I tried as much as possible to ma
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3693 — https://github.com/encode/httpx/pull/3693
**event_id:** `seed_pr_3693`

### PR content
```
Python 3.14

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary
Hi, this is my first contribution!!! Please be a little gentle with me ;-)

This is based on https://github.com/encode/httpx/pull/3664 but I add fixes for 


 - in the test suite deprecations are marked as fatal, and uvicorn is used to set up the tests, and uvicorn generates a deprecation warning because of iscoroutinefunction()
 - uvicorn is about to create a new release with a fix: https://github.com/Kludex/uvicorn/pull/2723 👀Python 3.14 has stricter requirements for event loops in background threads. The original code in httpx called server.run() which internally uses asyncio.run(), but this doesn't work properly in background threads in Python 3.14.
 - asyncio.get_event_loop() deprecated: The TestServer.serve() method was using asyncio.get_event_loop() which is now more restrictive in Python 3.14.

I'm not fully sure if this also passes on 3.9, it might need a little more work, but on 3.14 I think this fixes the problems ;-)
```

### Reviews / comments (3)
**cclauss** (pr_review):
```
https://pypi.org/project/uvicorn is currently 0.38.0
```
**apteryks** (comment):
```
I can't apply this https://github.com/encode/httpx/pull/3693.patch cleanly to either 0.28 or the master branch. This is for commit def4778d622e8bf49a9fea4dda78cca4cf666d8a:

```
source is at 'python-httpx-0.28.1-checkout'
applying '/gnu/store/axdb3iyc1gg49my2lfgdx4mgaglkzg6b-python-httpx-python-3.14.patch'...
patching file httpx/concurrency/asyncio/__init__.py
Cannot rename file without two valid file names
9 out of 9 hunks ignored
patching file httpx/concurrency/asyncio/compat.py
can't find file to patch at input line 326
Perhaps you used the wrong -p or --strip option?
The text le
[truncated]
```
**karpetrosyan** (comment):
```
Thanks for the contribution! When I ran it locally, it looked like the CI was not passing. I polished it a bit and opened another PR. You will be mentioned as a co author! #3722 
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3692 — https://github.com/encode/httpx/pull/3692
**event_id:** `seed_pr_3692`

### PR content
```
Fixed a syntax error in the file upload example

The code from the documentation contains a syntax error that raises an exception in Python.
```

### Reviews / comments (1)
**thewhitetea0001** (comment):
```
:v 
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3691 — https://github.com/encode/httpx/pull/3691
**event_id:** `seed_pr_3691`

### PR content
```
chore: require minimum httpcore with security fix for h11

# Summary

The `httpcore` subdependency `h11` has a security fix for the [critical security issue](https://osv.dev/vulnerability/GHSA-vqfr-h8mv-ghfj)  that requires the minimum version [`1.0.9`](https://github.com/encode/httpcore/releases/tag/1.0.9).

References:
- https://osv.dev/vulnerability/GHSA-vqfr-h8mv-ghfj
- https://github.com/encode/httpcore/releases/tag/1.0.9

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [x] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
- [x] I've updated the documentation accordingly.

```

### Reviews / comments (4)
**davidrogger** (comment):
```
Nice work!
```
**lovelydinosaur** (comment):
```
Duplicate of https://github.com/encode/httpx/discussions/3560
```
**BryceLohr** (comment):
```
> Duplicate of #3560

I'm trying to understand what this means: are you saying that httpx will _not_ update its dependency to resolve this security issue? Or am I misunderstanding this?
```
**zanieb** (comment):
```
Yes there's no need to change the minimum required version for users to receive the security fix as was discussed at length in https://github.com/encode/httpx/pull/3564#issuecomment-2858720787
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3690 — https://github.com/encode/httpx/pull/3690
**event_id:** `seed_pr_3690`

### PR content
```
Add `.wait_ready` to parser for clean server disconnects

Add `.wait_ready()` to `HTTPParser`...

We need this in order to differentiate between clean disconnects at the start of a new request/response cycle, rather than a `ProtocolError` while calling `recv_method_line()`.

```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3678 — https://github.com/encode/httpx/pull/3678
**event_id:** `seed_pr_3678`

### PR content
```
Bump the python-packages group with 8 updates

Bumps the python-packages group with 8 updates:

| Package | From | To |
| --- | --- | --- |
| [mkdocs-material](https://github.com/squidfunk/mkdocs-material) | `9.6.18` | `9.6.21` |
| [twine](https://github.com/pypa/twine) | `6.1.0` | `6.2.0` |
| [coverage[toml]](https://github.com/nedbat/coveragepy) | `7.10.6` | `7.10.7` |
| [cryptography](https://github.com/pyca/cryptography) | `45.0.7` | `46.0.2` |
| [mypy](https://github.com/python/mypy) | `1.17.1` | `1.18.2` |
| [pytest](https://github.com/pytest-dev/pytest) | `8.4.1` | `8.4.2` |
| [ruff](https://github.com/astral-sh/ruff) | `0.12.11` | `0.13.2` |
| [uvicorn](https://github.com/Kludex/uvicorn) | `0.35.0` | `0.37.0` |

Updates `mkdocs-material` from 9.6.18 to 9.6.21
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/squidfunk/mkdocs-material/releases">mkdocs-material's releases</a>.</em></p>
<blockquote>
<h2>mkdocs-material-9.6.21</h2>
<ul>
<li>Updated Serbian translations</li>
<li>Fixed <a href="https://redirect.github.com/squidfunk/mkdocs-material/issues/8458">#8458</a>: Temporary pin of click dependency</li>
</ul>
<h2>mkdocs-material-9.6.
[truncated]
```

### Reviews / comments (9)
**cclauss** (comment):
```
Upgrade `ruff` with...

@dependabot rebase
```
**dependabot[bot]** (comment):
```
Sorry, only users with push access can use that command.
```
**cclauss** (comment):
```
@lovelydinosaur, is there a reason to hold this up?  Some of these upgrades seem vital for Py3.14.

@ilovelinux

```
**cclauss** (comment):
```
@lovelydinosaur @browniebroke can you please make the following comment to force an upgrade of this PR and then merge it?

Several of these dependencies need to be upgraded to support Python 3.14, and that effort is blocked on multiple PRs.

@dependabot recreate
```
**dependabot[bot]** (comment):
```
Sorry, only users with push access can use that command.
```
**dependabot[bot]** (comment):
```
Sorry, only users with push access can use that command.
```
**dependabot[bot]** (comment):
```
Sorry, only users with push access can use that command.
```
**dependabot[bot]** (comment):
```
Sorry, only users with push access can use that command.
```
**dependabot[bot]** (comment):
```
Looks like these dependencies are updatable in another way, so this is no longer needed.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3664 — https://github.com/encode/httpx/pull/3664
**event_id:** `seed_pr_3664`

### PR content
```
Add Python 3.14 to test matrix

Tests here were hanging on a previous run, let's see if that's resolved.
```

### Reviews / comments (2)
**lovelydinosaur** (comment):
```
*Well that's tedious*.

We're not doing any gnarly Python magic here, so Python 3.13 -> 3.14 breaking almost certainly isn't something that the `httpx` package is causing. If anyone's got a good guess onto what part of dependency tooling is getting snarled up here???

```
**karpetrosyan** (comment):
```
Hey Kim! I opened a PR (#3722 ) with the fixes. I would love to make a release with these updates, since httpx has not had a release in over a year! I would appreciate it if you could review it!
Best, Kar
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3645 — https://github.com/encode/httpx/pull/3645
**event_id:** `seed_pr_3645`

### PR content
```
GitHub Actions: Add Python 3.14 to test matrix

UPDATE: Python 3.14 (the π version) was released today.
https://www.python.org/downloads/release/python-3140/
https://github.com/actions/python-versions/releases

```diff
-       python-version: ["3.9", "3.10", "3.11", "3.12", "3.13"]
+       python-version: ["3.9", "3.10", "3.11", "3.12", "3.13", "3.14"]
```
* #3616
* #3644

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

<!-- Write a small summary about what is happening here. -->

Why are 1,418 pytests collected on Python 3.14rc2, but none of them run?

All dependencies are up to date!  All other reasonable Python versions pass as expected in about 1 minute.

Read the second comment to see that some tests can pass, but many others go into an infinite loop!

While the tests are not starting, let's temporarily save resources by adding `timeout-minutes: 10`.
```diff
      - name: "Run tests"
        run: "scripts/test"
+       timeout-minutes: 10  # TODO(@cclauss): Remove once Python 3.14 tests are passing.
```

# Checklist

- [x] I
[truncated]
```

### Reviews / comments (9)
**cclauss** (comment):
```
Ignoring 9 test files passes on Python 3.14rc2.
```
uv run pytest \
    --ignore=tests/client/test_async_client.py \
    --ignore=tests/client/test_client.py \
    --ignore=tests/client/test_event_hooks.py \
    --ignore=tests/test_api.py \
    --ignore=tests/test_config.py \
    --ignore=tests/test_exceptions.py \
    --ignore=tests/test_main.py \
    --ignore=tests/test_timeouts.py \
    --ignore=tests/test_utils.py

========== test session starts ==========
platform darwin -- Python 3.14.0rc2, pytest-8.4.1, pluggy-1.6.0
rootdir: /Users/cclauss/Python/itinerant_futurizer/httpx
[truncated]
```
**hugovk** (comment):
```
Try bumping cryptography from 45.0.7 to latest 46.0.2, which has wheels for 3.14?

* https://pypi.org/project/cryptography/45.0.7/#files
* https://pypi.org/project/cryptography/46.0.2/#files
```
**cclauss** (comment):
```
OK... Upgraded `cryptography==46.0.2` but we still have the original problem...

> Why are 1,418 pytests collected on Python 3.14rc2, but none of them run?
```
**hugovk** (comment):
```
The 3.14 job did collect 1418 items:

```
collected 1418 items

Error: The operation was canceled.
```

https://github.com/encode/httpx/actions/runs/18341635177/job/52238338891?pr=3645

But was cancelled because the 3.14t job is failing: 
```
ImportError while loading conftest '/home/runner/work/httpx/httpx/tests/conftest.py'.
tests/conftest.py:20: in <module>
    import httpx
httpx/__init__.py:2: in <module>
    from ._api import *
httpx/_api.py:6: in <module>
    from ._client import Client
httpx/_client.py:13: in <module>
    from ._auth import Auth, BasicAuth, FunctionA
[truncated]
```
**cclauss** (comment):
```
Py3.14t dropped.  Py314 hung in pytest...
```
**cclauss** (comment):
```
After reading #3616, perhaps `scripts/install` is not a good idea.
* #3616

Update: Nope, that did not change the hanging pytests.
```
**cclauss** (comment):
```
The pytest blockage was caused by one of the other dependency upgrades in:
* #3678 
```
**mirthebeijers** (comment):
```
Hi :wave: see my try at https://github.com/encode/httpx/pull/3693
```
**cclauss** (comment):
```
Closing in favor of
* #3722
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3613 — https://github.com/encode/httpx/pull/3613
**event_id:** `seed_pr_3613`

### PR content
```
Use standard libary Zstandard for Python 3.14+

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary
[PEP 784](https://peps.python.org/pep-0784/) add a Zstandard implementation to the Python standard library under `compression.zstd`, and is scheduled for release in Python 3.14. This PR adapts `ZStandardDecoder` to work with either the standard library implementation or the implementation from the [`zstandard`](https://github.com/indygreg/python-zstandard) package.

This has the implication that Zstandard content decoding is available by default on Python 3.14 and later, without the need to install the `zstd` extra. 

# Checklist
- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [ ] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
  - Testing this requires Python 3.14, but the existing zstd unit tests pass with the standard library implementation. I'm always happy to add more tests if needed!
- [x] I've updated the doc
[truncated]
```

### Reviews / comments (16)
**mollymorphous** (pr_review):
```
Thanks for the review! Firefox and Chrome currently support zstd ([caniuse](https://caniuse.com/zstd)). Safari does not yet, but plans to: https://github.com/WebKit/standards-positions/issues/168

I wasn't able to find a hard number on server-side deployments, the answer seems to be not a lot, but CloudFlare recently added support to the CDN.
```
**lovelydinosaur** (comment):
```
Ooh interesting, thanks.

Any idea on how widely zstd is currently supported? (Wrt both browsers and servers.)

Related to this... compression is one of the currently unimplemented features in the httpx 1.0 prerelease... https://www.encode.io/httpnext/
```
**lilydjwg** (comment):
```
> Any idea on how widely zstd is currently supported? (Wrt both browsers and servers.)

At least crates.io, packagist and sourceforge support it. (My tests blow up because I cache http responses and there are zstd responses from other Python versions; the "zstandard" module doesn't support 3.14 yet.)
```
**lovelydinosaur** (comment):
```
From a bit of time reviewing this I've not been able to track down good examples of URLs to use for comparison purposes here. 

Eg...

* CloudFlare blog pages don't appear to use compression for hosted images.
* GitHub pages sites don't appear to use compression for hosted images.
* WikiPedia supports gzip compression throughout.

Here's one example of a URL that does support zstd, though in this particular case it appears less efficient than gzip...

```
$ curl https://help.netflix.com/en/node/30081 -H "Accept-Encoding: br" --output netflix.br 
$ curl https://help.netflix.com/en/n
[truncated]
```
**cclauss** (comment):
```
I suggest adding Python 3.14 to the test suite as in:
* #3645
```
**tuffnatty** (comment):
```
I would suggest dropping `zstandard` and switch to stdlib-compatible `backports.zstd` on Python 3.9-3.13, as `httpx` has dropped Python 3.8 support already.
```
**tuffnatty** (comment):
```
> The CloudFlare pitch for zstd https://blog.cloudflare.com/new-standards/ isn't _neccessarily_ convincing... gzip is essentially just as fast, and looks to have slightly less efficient though notably more stable compression ratios.

gzip is definitely not just as fast (without hardware offloading), it's just that they measure the whole response time, where the compression speed difference does not seem to matter much _on average_.
> 
> I'm reviewing this for the purposes of `httpx` 1.0, and I'm expecting that _only supporting gzip_ might be a reasonable default.

> Does anyone have some
[truncated]
```
**cclauss** (comment):
```
@tuffnatty Would you be willing to create an alternative pull request that uses the backport and adds automated tests on Py3.14 like
* #3645
```
**lovelydinosaur** (comment):
```
Okay, so my review of this was that *supporting gzip only* would be a sensible policy.
That's what we'll go for in 1.0. Let's not spend any more time rejigging zstd here.
```
**lilydjwg** (comment):
```
> Okay, so my review of this was that _supporting gzip only_ would be a sensible policy.
> That's what we'll go for in 1.0. Let's not spend any more time rejigging zstd here.

Would there be a mechanism to add support for other compression methods via third-party code then? I'm a bit worried about interoperability with not-so-good servers and proxies.
```
**lovelydinosaur** (comment):
```
That's a good question... ...I can't answer that fully at the moment.

There might not be any API *explicitly* for that purpose. Here's how interop. with the streams class would be...

```python
# A custom stream on top of the streams API...
class ZstdStream(httpx.Stream):
    def __init__(self, stream: httpx.Stream):
        self._wrapped = stream

    # Implement `.read()` and `.close()`

# Usage...
stream = ZStdStream(response.stream)
body = stream.read()
```

We probably don't want specific dials to "support for other compression methods via third-party code", since the le
[truncated]
```
**tuffnatty** (comment):
```
> @tuffnatty Would you be willing to create an alternative pull request that uses the backport 

@cclauss Thanks but the issue has been resolved in another way.
```
**ddelange** (comment):
```
> Okay, so my review of this was that _supporting gzip only_ would be a sensible policy. That's what we'll go for in 1.0. Let's not spend any more time rejigging zstd here.

fwiw, the major alternatives to httpx support zstd (and for sure brotli):
- [aiohttp](https://github.com/aio-libs/aiohttp/commit/4872fce3426119e63e1a892c39b474786dafddac)
- [urllib3](https://github.com/urllib3/urllib3/commit/c4b5917e911a90c8bf279448df8952a682294135)
  - requests

supporting only gzip/deflate might be insufficient in 2025. especially brotli accounts for 33% of compressed http responses already in 202
[truncated]
```
**cclauss** (comment):
```
> the issue has been resolved in another way.

How was the issue resolved?
```
**tuffnatty** (comment):
```
> > the issue has been resolved in another way.
> 
> How was the issue resolved?

https://github.com/encode/httpx/pull/3613#issuecomment-3302376638
```
**ddelange** (comment):
```
disregard my last comment, I see that they're all [supported](https://github.com/encode/httpx/blob/0.28.1/httpx/_decoders.py) :+1: 
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3564 — https://github.com/encode/httpx/pull/3564
**event_id:** `seed_pr_3564`

### PR content
```
fix CVE-2025-43859

h11 accepts some malformed Chunked-Encoding bodies before 0.16.0, httpcore 1.0.9 ensure using at least 0.16.0

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

<!-- Write a small summary about what is happening here. -->

# Checklist

- [ ] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [ ] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
- [ ] I've updated the documentation accordingly.

```

### Reviews / comments (12)
**zanieb** (comment):
```
I'm actually not sure this is correct. I don't think `httpx` needs to enforce this for you. You can just upgrade that downstream package? I don't think `httpx` should say it is _incompatible_ with earlier versions of `h11`.
```
**imredobos** (comment):
```
i have actually upgraded the downstream package to fix immediately, in my opinion, enforcing a version which solves a critical vulnerability is good thing, but i understand your point

```
**LeoSL** (comment):
```
Coming here because I also had to fix a CVE on my repo and found this `httpx` dependency. I also believe enforcing a version which solves a critical vulnerability is a good thing for `httpx`
```
**zanieb** (comment):
```
I don't really agree, you'd have to upgrade httpx for us to enforce the version at which point you might as well have updated the dependency?
```
**LeoSL** (comment):
```
@zanieb thanks for replying :) 

I'm not too sure what are the deptree repercussions if I bump the h11 version while httpx's dependencies require a lower version. In my view, that leads to inconsistencies and messes up with the pip's dependency resolver.

Please educate me if I'm not seeing things straight.
```
**zanieb** (comment):
```
> I'm not too sure what are the deptree repercussions if I bump the h11 version while httpx's dependencies require a lower version. In my view, that leads to inconsistencies and messes up with the pip's dependency resolver.

I'm not sure I follow, but httpx itself does not require the lower version — it allows any 1.x version. There shouldn't be repercussions to bumping h11. If some other dependency requires a _lower_ version of h11, and does not allow a newer version, that is indeed a problem and should be fixed in that package.
```
**LeoSL** (comment):
```
Ah I see, I see.

The problem is within httpx's dependency `httpcore`, as we can see on this dep tree:
```
httpx==0.28.1
├── httpcore [required: ==1.*, installed: 1.0.5]
│   └── h11 [required: >=0.13,<0.15, installed: 0.14.0]
```


```
**LeoSL** (comment):
```
Alright, after installing manually declaring `httpcore==1.0.9` (that requires h11's >= 0.16), this CVE seems to be fixed.

```
httpx==0.28.1
├── httpcore [required: ==1.*, installed: 1.0.9]
│   ├── certifi [required: Any, installed: 2025.1.31]
│   └── h11 [required: >=0.16, installed: 0.16.0]
```
```
**Kludex** (comment):
```
As @zanieb said, there's no need for HTTPX to actually enforce this. It would only be a problem if httpx didn't allow you to install the safe h11 version.
```
**danielfcollier** (comment):
```
If it is enforced, the ecosystem would gain awareness of the vulnerability. Not enforcing is going along with the problem.
```
**zanieb** (comment):
```
@danielfcollier adding a lower bound to a new version of httpx does not "increase awareness" of a vulnerability, it just forces an upgrade of the package when upgrading httpx. In either case, you need to be performing upgrades to resolve the vulnerability. You should be using dedicated tooling, e.g., Dependabot, for awareness of CVEs.
```
**danielfcollier** (comment):
```
 It is just a fact that enforcing a higher version would raise the bar, enforce security, and raise awareness - some people are just not educated about vulnerabilities or do not have a security department to take care of these scans. But, ok, when someone reverse engineers the ecosystem to find projects with top vulnerabilities, someone might consider enforcing some updates to strategic dependencies.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3540 — https://github.com/encode/httpx/pull/3540
**event_id:** `seed_pr_3540`

### PR content
```
docs: Add link to Event Hooks docs on Compatibility page

# Summary

Add a nice-to-have link to the Event Hooks docs on the Compatibility page.

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [x] I've added a test for each change that was introduced, and I tried as much as possible to make a single atomic change.
- [x] I've updated the documentation accordingly.
```

### Reviews / comments (1)
**injust** (comment):
```
Abandoning due to inactivity
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3513 — https://github.com/encode/httpx/pull/3513
**event_id:** `seed_pr_3513`

### PR content
```
Remove user credentials in URLs when converting to a string

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

<!-- Write a small summary about what is happening here. -->

As previously noted in [this GitHub discussion](https://github.com/encode/httpx/discussions/2765), this library by default leaks credentials which are included in URL strings (common for basic authentication). It can also raise exceptions which contain the credentials in the error string if a request fails (see `raise_for_status`).

This PR updates the `__str__` method on URLs to remove the user & password details. I believe this is the correct default behaviour for a library like this, as it avoids any risk of leakage. Removing the user & password entirely seems both (a) the safest option, and (b) the simplest implementation. These credentials are passed as headers in reality, and are not technically part of the URL.

# Checklist

- [x] I understand that this PR may be closed in case there was no previous discussion. (This doesn't apply to typos!)
- [x] I've added a test for each
[truncated]
```

### Reviews / comments (5)
**karpetrosyan** (comment):
```
Yep, hiding user credentials at the lowest layer and preventing them from being passed higher makes perfect sense.

Now it's exposed in URL.__str__, but not in URL.__repr__, which is a bit weird. __str__ is supposed to show more user-related data, while __repr__ is more for debugging and development. So, hiding it in __repr__ would make more sense. However, I think preventing it entirely is the most secure way.
```
**zanderxyz** (comment):
```
> Yep, hiding user credentials at the lowest layer and preventing them from being passed higher makes perfect sense.
> 
> Now it's exposed in URL.**str**, but not in URL.**repr**, which is a bit weird. **str** is supposed to show more user-related data, while **repr** is more for debugging and development. So, hiding it in **repr** would make more sense. However, I think preventing it entirely is the most secure way.

Just to clarify - after the change in this PR, the username & password are not exposed in either **str** or **repr✱. I do think this is the most secure implementation, and I 
[truncated]
```
**grahamwhiteuk** (comment):
```
Anyone have a view on when this might get merged (and released)?
```
**grahamwhiteuk** (comment):
```
Seems to be taking an age to be reviewed/merge so in the meantime, if you find this and don't want to log secrets you could just alter the log level of httpx...

```python
import logging

httpx_logger = logging.getLogger("httpx")
httpx_logger.setLevel(logging.WARNING)
```
```
**lovelydinosaur** (comment):
```
> This PR updates the __str__ method on URLs to remove the user & password details.

Thank you no.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3465 — https://github.com/encode/httpx/pull/3465
**event_id:** `seed_pr_3465`

### PR content
```
Make `UseClientDefault` public

It's not possible what was suggested on https://github.com/encode/starlette/pull/2709/files#r1815401043.
```

### Reviews / comments (1)
**KalleDK** (comment):
```
I also keep bumping into this problem - Hope it gets merged :)
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3262 — https://github.com/encode/httpx/pull/3262
**event_id:** `seed_pr_3262`

### PR content
```
fix HTTP/2 docs

Note on forcing HTTP/2 to be enabled by disabling HTTP/1.1 for the client

issue: https://github.com/encode/httpx/issues/3261
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #3241 — https://github.com/encode/httpx/pull/3241
**event_id:** `seed_pr_3241`

### PR content
```
Change default encoding to utf-8 in `normalize_header_key` and `normalize_header_value` functions

<!-- Thanks for contributing to HTTPX! 💚
Given this is a project maintained by volunteers, please read this template to not waste your time, or ours! 😁 -->

# Summary

<!-- Write a small summary about what is happening here. -->

This Pull Request addresses the issue of decoding errors encountered when using ASCII encoding in the `normalize_header_key` and `normalize_header_value` functions in `_utils.py`. By changing the default encoding to UTF-8, we can handle a wider range of input values without raising errors.

# Changes

- Updated the default encoding in `normalize_header_key` and `normalize_header_value` functions from "ascii" to "utf-8".

# Example Code

```python
def normalize_header_key(
    value: str | bytes,
    lower: bool,
    encoding: str | None = None,
) -> bytes:
    """
    Coerce str/bytes into a strictly byte-wise HTTP header key.
    """
    if isinstance(value, bytes):
        bytes_value = value
    else:
        bytes_value = value.encode(encoding or "utf-8")

    return bytes_value.lower() if lower else bytes_value

def norma
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

# Labeling Scaffold — honojs_hono PRs

For each PR below, decide:
1. Does the PR (or its reviews/comments) contain a **decision**?
   A decision = a choice made with rationale: technology, approach, API design, deliberate trade-off.
   Bug fixes and refactors without design discussion are NOT decisions.
2. If yes, what is the decision? Record it in `label-scaffold.json`:
   - `has_decision: true`
   - `decisions: [{ quoted_text: "...", summary: "..." }]`

---

## PR #honojs/hono/pull/2675 — https://github.com/honojs/hono/pull/2675
**event_id:** `hono_pr_2675`

### PR content
```
feat(utils/body): add dot notation support for `parseBody`

Closes #2656

cc @yusukebe  @MathurAditya724 

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun denoify` to generate files for Deno
- [x] `bun run format:fix && bun run lint:fix` to format the code

```

### Reviews / comments (3)
**MathurAditya724** (pr_review):
```
These are some basic changes you can do to improve this. I haven't looked at the `setNestedValue` func and the test cases (this was all the time I had 😅), but I will try to look at it soon.
```
**MathurAditya724** (pr_review):
```
Just some minor changes for the improvements you did based on my review
```
**MathurAditya724** (pr_review):
```
Hey @fzn0x, I have gone through the functions and made some improvements. All the tests are passing. Also, I added some pointers where we can improve this more. Let me know what you think
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2813 — https://github.com/honojs/hono/pull/2813
**event_id:** `hono_pr_2813`

### PR content
```
feat(middleware): Introduce IP Restriction Middleware

Recreated #2807 
***

I created IP Limit Middleware.

You can limit request by IP Address.

For example, you can limit request, this server accepts local-only requests:
```ts
import { Hono } from 'hono'
import { ipLimit } from 'hono/ip-limit'
import { getConnInfo } from 'hono/...'

const app = new Hono()

app.use('*', ipLimit(getConnInfo, {
  deny: [],
  allow: ['127.0.0.1', '::1']
}))
app.get('/', c => c.text('Hello world!'))
```
`deny` takes precedence over `allow`.

Rules supported some syntax:

| Title | example of IPv4 | example of IPv6 |
| --- | --- | --- |
| static | `0.0.0.0` | `::1` |
| CIDR | `192.168.2.1/24` | `abcd::ef01/64` |
| Wildcard | `192.*.2.*` |  |

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [ ] `bun denoify` to generate files for Deno
- [x] `bun run format:fix && bun run lint:fix` to format the code

```

### Reviews / comments (2)
**usualoma** (pr_review):
```
@nakasyou Thank you. I have made some comments, please check them.
```
**ryuapp** (pr_review):
```
@nakasyou 
Good job. Allow me to leave some comments.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2285 — https://github.com/honojs/hono/pull/2285
**event_id:** `hono_pr_2285`

### PR content
```
Optimize RegExpRouter and maybe more

I'm not done yet.

Gonna do more optimizations to the build step as well.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3491 — https://github.com/honojs/hono/pull/3491
**event_id:** `hono_pr_3491`

### PR content
```
PR #3491: ci: Display performance measurement results as custom metrics

### The author should do the following, if applicable

- [ ] Add tests
- [ ] Run tests
- [ ] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code

### What's this all about?

This will be an improvement in type checking performance monitoring added by the following Pull Request.
https://github.com/honojs/hono/pull/3406

In conjunction with octocov, type checking performance will be displayed as Pull Request comments and CI summary as follows

* [Pull Request  comments](https://github.com/k2tzumi/hono/pull/2#issuecomment-2484429361)
  <img width="695" alt="image" src="https://github.com/user-attachments/assets/43df287a-bc00-4211-b2a3-5c15675d2124">
  ~~note: The bundle size is not shown as a diff since it is the first time, but it will be shown after the main branch is updated.~~
  Looks like the diff showed up just fine!

* [CI summary](https://github.com/k2tzumi/hono/actions/runs/11903458839?pr=2#summary-33170471302)
  <img width="549" alt="image" src="https://github.com/user-
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4291 — https://github.com/honojs/hono/pull/4291
**event_id:** `hono_pr_4291`

### PR content
```
PR #4291: feat(serve-static): use `join` to correct path resolution

This PR introduces a new mechanism for the serve static middleware. This can fix unintended path resolution.

* Duplicated `pathResolve` option
* Added `join` option
* Simplified `src/middleware/serve-static/index.ts`
* Implemented `defaultJoin`. It is used if the `join` option is not specified
* Updated serve static for deno/bun
* Fixed some tests to support new functions

It is inspired by https://github.com/honojs/node-server/pull/261

## Problems

In previous implementations, paths starting with `C:\Users\yusuke\` on Windows were converted to `/Users/yusuke`. This caused unintended behavior because the drive name was lost.

If we use a function such as `join` exported by `path:node`, we can solve this problem and simplify the code. The `pathResolve` option is also unnecessary.

## Breaking changes?

I changed the test code, but only `path` passed to `onFound` and `onNotFound` has been slightly changed.

Other behaviors remain unchanged. Additionally, unexpected path resolution issues should be resolved immediately. Release a minor version without changing the major version.

### The auth
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3082 — https://github.com/honojs/hono/pull/3082
**event_id:** `hono_pr_3082`

### PR content
```
PR #3082: feat(middleware): introduce Request ID middleware

Request ID middleware generates a unique id for a request.
The unique request id can be used to trace a request end-to-end.
```ts
const app = new Hono()

app.use(requestId())
app.get('/', (c) => {
    console.log(c.get('requestId'))
    return c.text('Hello World!')
})
```

It is also easily customizable with several options.

```ts
type RequesIdOptions = {
  // The maximum length of request id.
  // The default value is 255. 
  limitLength?: number
  // The header name used in request id.
  // The default value is 'X-Request-Id'.
  headerName?: string
  // The request id generation function.
  // The default value is 'crypto.randomUUID()'.
  generator?: (c: Context) => string
}
```


### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

fzn0x (review): Looks good to me

usualoma (review): Thanks for the great pull request!

### Performance improvement proposals

If the req
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/563 — https://github.com/honojs/hono/pull/563
**event_id:** `hono_pr_563`

### PR content
```
PR #563: feat(validator): add support for JSON array path validation

This PR adds support for JSON array paths in the JSONPath util, and also support for validating JSON array paths from a validator context.

The update doesn't break backwards compatibility with the current API (besides the previous less standard `.i` syntax, eg. `posts.4` instead of `posts[4]`) and provides the ability to validate arbitrary array paths, including complex paths of nested arrays and objects.

For example this:
```ts
const jsonBody = {
  posts: [
    {
       title: 'New Post 1',
       tags: ['new-ish', false],
    },
    {
       title: 'New Post 2',
       tags: ['newest', true],
    },
  ],
}
```
Can have arbitrary validations like this:
```ts
validator((v) => ({
  title: v.json('posts[*].title').isRequired(),
  secondTag: v.json('posts[*].tags[1]').asBoolean().isRequired(),
}))
```

One thing I would like to do in the future is to provide messages to the API consumer about which specific values in an array path failed validation, eg. `posts[2].title is required -- undefined`. I have a working version of this in a patch for the old middleware using `validator.js`, but 
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2077 — https://github.com/honojs/hono/pull/2077
**event_id:** `hono_pr_2077`

### PR content
```
PR #2077: feat: new built-in middleware bodyLimit

### Author should do the followings, if applicable
I saw this DISCUSSION and implemented it.
https://github.com/orgs/honojs/discussions/2048
It takes a little time to prepare an explanation.

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno



---

usualoma (review): Hi @EdamAme-x 

### content-type

If the Content-Type is not what is expected, the size will not be checked. I don't think this is the behavior you expect.

```ts
app.post(
  '/',
  bodyLimit({
    type: 'json',
    limit: 1,
  }),
  async (c) => {
    return c.text(JSON.stringify(await c.req.json()))
  }
)
```

```
$ curl -X POST -H "Content-Type: application/json" -d '{"message":"OK"}' http://127.0.0.1:8787
413 Request Entity Too Large                                                                        
$ curl -X POST -H "Content-Type: text/plain" -d '{"message":"OK"}' http://127.0.0.1:8787
{"message":"OK"}
```


### in bun

This is FYI, but in bun, `c.req.raw.clone()` does not seem to get the original body, I think it is a bug in bun, but we need to be aware of this limitation if we merge this mid
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4100 — https://github.com/honojs/hono/pull/4100
**event_id:** `hono_pr_4100`

### PR content
```
PR #4100: fix: reduce Context code

This PR reduces the code size of `src/context.ts` and fixes some bugs.

## Reducing the code size

The current implementation uses `#preparedHeaders` and `#isFresh` to avoid generating `Headers` and `Response` objects as much as possible. This increases the amount of code and makes the code more complex.

In this PR, we have removed them and shortened the code.

This change has reduced the bundle size by about 900B with a minified minimum app using the `hono/tiny`.

![CleanShot 2025-06-07 at 07 46 32@2x](https://github.com/user-attachments/assets/ef6db390-480c-4039-86d0-87fd11d96de6)

## Fixes weird behaviors

There are some bugs in the current implementation of `context.ts` that cause weird behaviors. The following tests have failed. This PR allows those tests to succeed.

https://github.com/honojs/hono/pull/4100/commits/f4cb6ac55f9e2846b310318c5ade539f5984c7c

Therefore, the following Issues are fixed.

Fixes https://github.com/honojs/node-server/issues/226
Fixes https://github.com/honojs/hono/issues/3736 (maybe)

## Performance

This PR shows a slight decrease in performance related to application speed. Benchmark resu
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2662 — https://github.com/honojs/hono/pull/2662
**event_id:** `hono_pr_2662`

### PR content
```
PR #2662: feat(jsr): support JSR

This PR will enable Hono to support the [JSR](https://jsr.io/).

We've done:

* Added type annotations to reduce [Slow Types](https://jsr.io/docs/about-slow-types). https://github.com/honojs/hono/pull/2663 
* I added the `jsr-dry-run` command in CI to check if it's ready to publish JSR. https://github.com/honojs/hono/pull/2662/commits/8b247079ce0620aa487fa1efef15035214444298
* Added `deno.json`. https://github.com/honojs/hono/pull/2662/commits/7ac63060928d04beab51e5a3f94adaf02658f37e And modified.
* Made `JSX` be exported from `hono/jsx/jsx-runtime` not `global`. https://github.com/honojs/hono/pull/2662/commits/5bd2b71709a3e8d28a83c193fb70d7363b65dc85
* Made `hono-base.ts` does not use `dynamicClass`. https://github.com/honojs/hono/pull/2662/commits/b9025907175d31879e5f3648661d60536af1a787
* Made `ExecutionContext` is not declared in `global`. https://github.com/honojs/hono/pull/2662/commits/cf020c64c52df488393343efc06a5a2ce3bb6e5a
* Removed `deno_dist` and `denoify` completely. https://github.com/honojs/hono/pull/2662/commits/0c776fa22696b54cbc31c51c7262a0a056316499
* Made `deno.json` exports `./`, `./jsx/jsx-runtime`, ~~`./middleware`,
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2265 — https://github.com/honojs/hono/pull/2265
**event_id:** `hono_pr_2265`

### PR content
```
PR #2265: feat: Introduce WebSocket Helper / Adapter

Reference: https://github.com/honojs/hono/issues/1153

If we marge this PR, we can use WebSocket API through Hono easier.

Example (Bun):
```tsx
// app.tsx

/** @jsx jsx */
/** @jsxImportSource ./hono/src/jsx */
import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/ws/bun'

const { upgradeWebSocket, websocket } = createBunWebSocket()

const app = new Hono()

app.get('/', c => {
  return c.html(
  <html>
    <head>
      <meta charset="UTF-8" />
    </head>
    <body>
      <h1>Hono WebSocket Example</h1>
      <div id="now-time"></div>
      <script dangerouslySetInnerHTML={{
        __html: `
        const ws = new WebSocket('/ws')
        const $nowTime = document.getElementById('now-time')
        ws.onmessage = evt => {
          $nowTime.textContent = evt.data
        }
        `
      }}></script>
    </body>
  </html>)
})

const ws = app.get('/ws', upgradeWebSocket(c => {
  let intervalId: number
  return {
    onOpen(evt, ws) {
      intervalId = setInterval(() => {
        ws.send(new Date().toString())
      }, 200) as unknown as number
    },
    onClose ()
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4227 — https://github.com/honojs/hono/pull/4227
**event_id:** `hono_pr_4227`

### PR content
```
PR #4227: Next

For `v4.8.0`.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4834 — https://github.com/honojs/hono/pull/4834
**event_id:** `hono_pr_4834`

### PR content
```
PR #4834: feat(css): add classNameSlug option to createCssContext

## Description

Adds an optional `classNameSlug` function to `createCssContext` that lets users customize generated CSS class names instead of the default `css-1234567890` format.

Closes #4577

**Before:** Always generates `css-1234567890`
**After:** Pass `classNameSlug: (hash, label, css) => string` to get custom names

```ts
const { css, Style } = createCssContext({
  id: 'my-styles',
  classNameSlug: (hash, label) => label.trim() ? `h-${label.trim()}` : hash,
})

const hero = css`/* hero-section */ background: blue;`
// .h-hero-section { background: blue; }
```

## Changes

- `src/helper/css/common.ts` — exported `ClassNameSlug` type, added optional `classNameSlug` param to `cssCommon()`
- `src/helper/css/index.ts` — added `classNameSlug` option to `createCssContext()`, exported `ClassNameSlug` type
- `src/helper/css/index.test.tsx` — 4 new tests for custom slug, label extraction, fallback, and default behavior

## Verification

- All existing tests pass
- TypeScript: 0 errors
- ESLint: 0 warnings
- Prettier: all files formatted

## API

```ts
type ClassNameSlug = (hash: string, label: string, css: string) => st
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3826 — https://github.com/honojs/hono/pull/3826
**event_id:** `hono_pr_3826`

### PR content
```
PR #3826: feat(hono/jwk): JWK Auth Middleware

Hello, I recently needed a JWK middleware for my projects, but I figured contributing it to hono has the potential to save me and others a lot of time.

### Middleware Features:
- Set `options.keys` to a static array of public keys `HonoJsonWebKey[]` in code.
- Set `options.keys` to an async function that returns a `Promise<HonoJsonWebKey[]>` for flexibility
- Set `options.jwks_uri` to fetch JWKs from a URI, after which it appends those fetched keys to provided `keys` if any
- Set an optional `init` parameter (only used for `jwks_uri`)—useful if your host supports caching through custom init options.

#### Added extra:
- Added `JwtHeaderRequiresKid` exception. Since the middleware requires presence of a `kid` field in the header in order to select the correct key.
- Added `Jwt.verifyFromJwks` util function _(batteries included)_.

### Addressed issues:
- https://github.com/honojs/hono/issues/3658
- https://github.com/honojs/hono/issues/2589
- https://github.com/honojs/hono/issues/672

### Other code changes:
- Typescript-extended `JsonWebKey` to have `kid?: string` (This is a standard: https://datatracker.ietf.org/doc
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3589 — https://github.com/honojs/hono/pull/3589
**event_id:** `hono_pr_3589`

### PR content
```
PR #3589: feat(helper/proxy): introduce proxy helper

fixes #3518

### Naming

The name `proxyFetch` seems a little redundant, but I rejected the other candidates for the following reasons.

* `proxy` : The name `proxy` is simple but is avoided because it is confusing with the JavaScript `Proxy` object.
* `fetch` : The name `fetch` is also good. Although it is in the `helper/proxy` namespace, so it can be distinguished, when it is used by being incorporated into the application, from the standpoint of reading the code, it looks like `globalThis.fetch` is being called, so I decided to avoid it because of the cognitive load.

### Usage

```ts
app.get('/proxy/:path', (c) => {
  return proxyFetch(new Request(`http://${originServer}/${c.req.param('path')}`, c.req.raw), {
    proxySetRequestHeaders: {
      'X-Forwarded-For': '127.0.0.1',
      'X-Forwarded-Host': c.req.header('host'),
      Authorization: undefined, // prevent propagating "Authorization" request headers in c.req.raw
    },
    proxyDeleteResponseHeaderNames: ['Cookie'],
  })
})
```

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fi
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1904 — https://github.com/honojs/hono/pull/1904
**event_id:** `hono_pr_1904`

### PR content
```
PR #1904: feat: Introducing a New SSG Adaptor/Helper 

To celebrate the release of Hono v4, I propose a new feature. This is somewhat niche, but it's a Helper (or Adaptor) designed to convert Hono code into static HTML. Utilizing this, users can easily host SSG on platforms like S3 or R2. Currently, I'm grappling with three main concerns.

1. is this within the scope of responsibilities for the Hono framework? If it's deemed unnecessary, I might consider moving it to hono/middleware.
2. I'm wondering if it's more fitting to provide this as an Adaptor rather than a Helper, given its nature.
3. is the functionality interface appropriate? I've found myself pondering over this and have started studying SSG in other frameworks as well :)

### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno



---

yusukebe (review): Looks great!

sor4chi: Hi @watany, excuse me from outside.

Thanks for the great suggestions! I like the concept.
In terms of Hono's built-in middleware approach, I think we have to avoid dependence on runtime as much as possible.

For example, I thought it would be cleaner to expo
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2595 — https://github.com/honojs/hono/pull/2595
**event_id:** `hono_pr_2595`

### PR content
```
PR #2595: feat: Introduce ConnInfo helper/adapter

I created ConnInfo helper/adapter for Bun, Deno and CF Workers.
You can get client IP Address with Hono easier if we marge PR.

This provides runtime-less ConnInfo object.

For example, you can get IP Address on Bun:
```ts
import { Hono } from 'hono'
import { getConnInfo } from 'hono/bun'

const app = new Hono()

app.get('/', c => c.text(`Your ip address is ${getConnInfo(c).remote.address}!!`))

Bun.serve(app)
```

If you want to use Workers, replace import:
```ts
import { getConnInfo } from 'hono/cloudflare-workers'
```

In Deno:
```ts
import { getConnInfo } from 'https://deno.land/x/hono/helper.ts'
```
### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun denoify` to generate files for Deno



---

yusukebe (review): LGTM!

nakasyou: reference:
- https://github.com/honojs/hono/issues/379
- https://github.com/orgs/honojs/discussions/1439
- https://github.com/orgs/honojs/discussions/1600
- https://github.com/orgs/honojs/discussions/1187

yusukebe: @nakasyou 

CI fails. Could you run `bun run lint:fix` (As you said on X, I might have made a mistake in confi
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4382 — https://github.com/honojs/hono/pull/4382
**event_id:** `hono_pr_4382`

### PR content
```
PR #4382: feat(request): add cloneRawRequest utility for request cloning

**Problem**

After using Hono validators, the `raw` Request obejct gets consumed
during body parsing, making it unusable for external libraries like
`better-auth`.
This results in the error:

```shell
TypeError: Cannot construct a Request with a Request object that has already been used.
```

**Root Cause**

The issue occurs in the `#cachedBody` method in `HonoRequest`. When parsing request
bodies (json, text, etc.), the method directly calls parsing methods on the raw Request
object, which consumes its body stream. Once consumed, the Request cannot be cloned or
reused by external libraries.

**Solution**

Adding a utility function to clone HonoRequest's underlying raw Request
object, handling both consumed and unconsumed request bodies.

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

yusukebe: Hi @kamaal111 

Why I didn't implement clo
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1437 — https://github.com/honojs/hono/pull/1437
**event_id:** `hono_pr_1437`

### PR content
```
PR #1437: feat: Add `c.stream()`

Hi, @yusukebe, @ geelen

I implemented `c.stream()` according to #914. I'd like to see @ geelen added as a co-author as well, since I'm pretty much quoting the code from the issue.

This is the first time I've use a StreamAPI, so feel free to point out any mistakes.

@yusukebe asked me to give some examples of using `c.stream()`.
Below are some examples.

## Usecase

### 1: ChatGPT Proxy
Enable rate limiting to protect or hide external APIs

<details>
<summary>Code</summary>

```ts
import OpenAI from 'openai'
import { Hono } from 'hono'

const app = new Hono<{
  Bindings: {
    OPENAI_API_KEY: string
  }
}>()

const PROMPT = (message: string) => [
  {
    role: 'system' as const,
    content:
      'You are an Web developer. If you receive a question about Web-related technologies, you can answer it.',
  },
  {
    role: 'user' as const,
    content: message,
  },
]

app.post('/', async (c) => {
  const body = await c.req.json()
  const openai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY })

  return c.stream(async (stream) => {
    const chatStream = await openai.chat.completions.create({
      messages:
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2119 — https://github.com/honojs/hono/pull/2119
**event_id:** `linked_pr_honojs_hono_2119`

### PR content
```
As the number of MIME increases in the future, it will be impossible to support them all due to file size problems.
We think that it should primarily support files used by browsers.
Instead, you can maintain the previous state by using mimes option #2094 .

## Delete extension List

**azw(application/vnd.amazon.ebook)**
If Amazon is using Hono, it should not be deleted.

**abw, csh, doc, docs, xls, xlsx, odp, ods, odt, ppt, pptx, vsd**
Files used by specific software.

**swf, xul**
Files for software whose support has ended.

**mpkg, sh**
Installer and scripts.

**jar, php**
Other language files.

**arc, bz, bz2, tar, 7z**
Archive and compressed files.


### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno


---

yusukebe: > Instead, you can maintain the previous state by using mimes option #2094 .

Exactly, now we have a `mimes` option! Thanks. Merge now.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2046 — https://github.com/honojs/hono/pull/2046
**event_id:** `linked_pr_honojs_hono_2046`

### PR content
```
Fix https://github.com/honojs/hono/issues/2019.

### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno


---

agatan: Sorry, I forgot to run `yarn format:fix`.

yusukebe: @agatan 

Awesome! Thanks for the hard work!
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2130 — https://github.com/honojs/hono/pull/2130
**event_id:** `linked_pr_honojs_hono_2130`

### PR content
```
This PR allows changing the type of value returned by the validator.

```ts
import { Hono } from 'hono'
import { validator } from 'hono/validator'

const app = new Hono()

app.get(
  '/',
  validator('query', () => {
    return {
      age: 123
    }
  }),
  (c) => {
    const { age } = c.req.valid('query')
    return c.json({
      'your age is': age // number
    })
  }
)
```

The Zod Validator will need to be modified later.

Related to https://github.com/honojs/middleware/issues/368

### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno

```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2675 — https://github.com/honojs/hono/pull/2675
**event_id:** `hono_pr_2675`

### PR content
```
PR #2675: feat(utils/body): add dot notation support for `parseBody`

Closes #2656

cc @yusukebe  @MathurAditya724 

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun denoify` to generate files for Deno
- [x] `bun run format:fix && bun run lint:fix` to format the code



---

MathurAditya724 (review): These are some basic changes you can do to improve this. I haven't looked at the `setNestedValue` func and the test cases (this was all the time I had 😅), but I will try to look at it soon.

MathurAditya724 (review): Just some minor changes for the improvements you did based on my review

MathurAditya724 (review): Hey @fzn0x, I have gone through the functions and made some improvements. All the tests are passing. Also, I added some pointers where we can improve this more. Let me know what you think

fzn0x: @MathurAditya724 Reviews resolved, to decide whether is it `dot` or `transformDotNotation` naming, we can wait @yusukebe first.

fzn0x: Dot notation support documentation will be added here: https://hono.dev/api/request#parsebody

--- 

## Dot Notation

```ts
// assume you pass `obj.key1` in the request body
const bod
[truncated]
```

### Reviews / comments (3)
**MathurAditya724** (pr_review):
```
These are some basic changes you can do to improve this. I haven't looked at the `setNestedValue` func and the test cases (this was all the time I had 😅), but I will try to look at it soon.
```
**MathurAditya724** (pr_review):
```
Just some minor changes for the improvements you did based on my review
```
**MathurAditya724** (pr_review):
```
Hey @fzn0x, I have gone through the functions and made some improvements. All the tests are passing. Also, I added some pointers where we can improve this more. Let me know what you think
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2813 — https://github.com/honojs/hono/pull/2813
**event_id:** `hono_pr_2813`

### PR content
```
PR #2813: feat(middleware): Introduce IP Restriction Middleware

Recreated #2807 
***

I created IP Limit Middleware.

You can limit request by IP Address.

For example, you can limit request, this server accepts local-only requests:
```ts
import { Hono } from 'hono'
import { ipLimit } from 'hono/ip-limit'
import { getConnInfo } from 'hono/...'

const app = new Hono()

app.use('*', ipLimit(getConnInfo, {
  deny: [],
  allow: ['127.0.0.1', '::1']
}))
app.get('/', c => c.text('Hello world!'))
```
`deny` takes precedence over `allow`.

Rules supported some syntax:

| Title | example of IPv4 | example of IPv6 |
| --- | --- | --- |
| static | `0.0.0.0` | `::1` |
| CIDR | `192.168.2.1/24` | `abcd::ef01/64` |
| Wildcard | `192.*.2.*` |  |

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [ ] `bun denoify` to generate files for Deno
- [x] `bun run format:fix && bun run lint:fix` to format the code



---

usualoma (review): @nakasyou Thank you. I have made some comments, please check them.

ryuapp (review): @nakasyou 
Good job. Allow me to leave some comments.

EdamAme-x: I think it would be good to have `*` autom
[truncated]
```

### Reviews / comments (2)
**usualoma** (pr_review):
```
@nakasyou Thank you. I have made some comments, please check them.
```
**ryuapp** (pr_review):
```
@nakasyou 
Good job. Allow me to leave some comments.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2285 — https://github.com/honojs/hono/pull/2285
**event_id:** `hono_pr_2285`

### PR content
```
PR #2285: Optimize RegExpRouter and maybe more

I'm not done yet.

Gonna do more optimizations to the build step as well.



---

usualoma: Hi @aquapi 
Thanks for trying to optimize RegExpRouter.

However, regarding d907da1 and 6dcc1a4, I do not want to merge those changes. I see little benefit to be gained by merging them.
If you think there are improvements that could be made by merging these PRs, please let us know specifically, e.g. by benchmarking.

But I think that maybe the following changes could have a good outcome.

https://github.com/honojs/hono/pull/2285/commits/d907da1bbb1de166df37ff5c24ec457357fe4cd9#diff-06f981941f95eecd6e249629fd9d5d4 badaf8dfbe96ade6219e67691359df679L217-R212

If there are changes that clearly make a difference in performance, I would like to see them broken down into smaller pieces instead of being grouped into one PR.

Best regards.

aquapi: @usualoma I want to make the code easier for JIT to optimize out.
It's not really gonna improve performance significantly but it is simply better code :).

Some changes I will make:
- Replace `forEach` usage with simple for loops
- Change loops
- Cache callback functions if possible (avoid
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3491 — https://github.com/honojs/hono/pull/3491
**event_id:** `hono_pr_3491`

### PR content
```
PR #3491: ci: Display performance measurement results as custom metrics

### The author should do the following, if applicable

- [ ] Add tests
- [ ] Run tests
- [ ] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code

### What's this all about?

This will be an improvement in type checking performance monitoring added by the following Pull Request.
https://github.com/honojs/hono/pull/3406

In conjunction with octocov, type checking performance will be displayed as Pull Request comments and CI summary as follows

* [Pull Request  comments](https://github.com/k2tzumi/hono/pull/2#issuecomment-2484429361)
  <img width="695" alt="image" src="https://github.com/user-attachments/assets/43df287a-bc00-4211-b2a3-5c15675d2124">
  ~~note: The bundle size is not shown as a diff since it is the first time, but it will be shown after the main branch is updated.~~
  Looks like the diff showed up just fine!

* [CI summary](https://github.com/k2tzumi/hono/actions/runs/11903458839?pr=2#summary-33170471302)
  <img width="549" alt="image" src="https://github.com/user-
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4291 — https://github.com/honojs/hono/pull/4291
**event_id:** `hono_pr_4291`

### PR content
```
PR #4291: feat(serve-static): use `join` to correct path resolution

This PR introduces a new mechanism for the serve static middleware. This can fix unintended path resolution.

* Duplicated `pathResolve` option
* Added `join` option
* Simplified `src/middleware/serve-static/index.ts`
* Implemented `defaultJoin`. It is used if the `join` option is not specified
* Updated serve static for deno/bun
* Fixed some tests to support new functions

It is inspired by https://github.com/honojs/node-server/pull/261

## Problems

In previous implementations, paths starting with `C:\Users\yusuke\` on Windows were converted to `/Users/yusuke`. This caused unintended behavior because the drive name was lost.

If we use a function such as `join` exported by `path:node`, we can solve this problem and simplify the code. The `pathResolve` option is also unnecessary.

## Breaking changes?

I changed the test code, but only `path` passed to `onFound` and `onNotFound` has been slightly changed.

Other behaviors remain unchanged. Additionally, unexpected path resolution issues should be resolved immediately. Release a minor version without changing the major version.

### The auth
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3082 — https://github.com/honojs/hono/pull/3082
**event_id:** `hono_pr_3082`

### PR content
```
PR #3082: feat(middleware): introduce Request ID middleware

Request ID middleware generates a unique id for a request.
The unique request id can be used to trace a request end-to-end.
```ts
const app = new Hono()

app.use(requestId())
app.get('/', (c) => {
    console.log(c.get('requestId'))
    return c.text('Hello World!')
})
```

It is also easily customizable with several options.

```ts
type RequesIdOptions = {
  // The maximum length of request id.
  // The default value is 255. 
  limitLength?: number
  // The header name used in request id.
  // The default value is 'X-Request-Id'.
  headerName?: string
  // The request id generation function.
  // The default value is 'crypto.randomUUID()'.
  generator?: (c: Context) => string
}
```


### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

fzn0x (review): Looks good to me

usualoma (review): Thanks for the great pull request!

### Performance improvement proposals

If the req
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/563 — https://github.com/honojs/hono/pull/563
**event_id:** `hono_pr_563`

### PR content
```
PR #563: feat(validator): add support for JSON array path validation

This PR adds support for JSON array paths in the JSONPath util, and also support for validating JSON array paths from a validator context.

The update doesn't break backwards compatibility with the current API (besides the previous less standard `.i` syntax, eg. `posts.4` instead of `posts[4]`) and provides the ability to validate arbitrary array paths, including complex paths of nested arrays and objects.

For example this:
```ts
const jsonBody = {
  posts: [
    {
       title: 'New Post 1',
       tags: ['new-ish', false],
    },
    {
       title: 'New Post 2',
       tags: ['newest', true],
    },
  ],
}
```
Can have arbitrary validations like this:
```ts
validator((v) => ({
  title: v.json('posts[*].title').isRequired(),
  secondTag: v.json('posts[*].tags[1]').asBoolean().isRequired(),
}))
```

One thing I would like to do in the future is to provide messages to the API consumer about which specific values in an array path failed validation, eg. `posts[2].title is required -- undefined`. I have a working version of this in a patch for the old middleware using `validator.js`, but 
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2077 — https://github.com/honojs/hono/pull/2077
**event_id:** `hono_pr_2077`

### PR content
```
PR #2077: feat: new built-in middleware bodyLimit

### Author should do the followings, if applicable
I saw this DISCUSSION and implemented it.
https://github.com/orgs/honojs/discussions/2048
It takes a little time to prepare an explanation.

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno



---

usualoma (review): Hi @EdamAme-x 

### content-type

If the Content-Type is not what is expected, the size will not be checked. I don't think this is the behavior you expect.

```ts
app.post(
  '/',
  bodyLimit({
    type: 'json',
    limit: 1,
  }),
  async (c) => {
    return c.text(JSON.stringify(await c.req.json()))
  }
)
```

```
$ curl -X POST -H "Content-Type: application/json" -d '{"message":"OK"}' http://127.0.0.1:8787
413 Request Entity Too Large                                                                        
$ curl -X POST -H "Content-Type: text/plain" -d '{"message":"OK"}' http://127.0.0.1:8787
{"message":"OK"}
```


### in bun

This is FYI, but in bun, `c.req.raw.clone()` does not seem to get the original body, I think it is a bug in bun, but we need to be aware of this limitation if we merge this mid
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4100 — https://github.com/honojs/hono/pull/4100
**event_id:** `hono_pr_4100`

### PR content
```
PR #4100: fix: reduce Context code

This PR reduces the code size of `src/context.ts` and fixes some bugs.

## Reducing the code size

The current implementation uses `#preparedHeaders` and `#isFresh` to avoid generating `Headers` and `Response` objects as much as possible. This increases the amount of code and makes the code more complex.

In this PR, we have removed them and shortened the code.

This change has reduced the bundle size by about 900B with a minified minimum app using the `hono/tiny`.

![CleanShot 2025-06-07 at 07 46 32@2x](https://github.com/user-attachments/assets/ef6db390-480c-4039-86d0-87fd11d96de6)

## Fixes weird behaviors

There are some bugs in the current implementation of `context.ts` that cause weird behaviors. The following tests have failed. This PR allows those tests to succeed.

https://github.com/honojs/hono/pull/4100/commits/f4cb6ac55f9e2846b310318c5ade539f5984c7c

Therefore, the following Issues are fixed.

Fixes https://github.com/honojs/node-server/issues/226
Fixes https://github.com/honojs/hono/issues/3736 (maybe)

## Performance

This PR shows a slight decrease in performance related to application speed. Benchmark resu
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2662 — https://github.com/honojs/hono/pull/2662
**event_id:** `hono_pr_2662`

### PR content
```
PR #2662: feat(jsr): support JSR

This PR will enable Hono to support the [JSR](https://jsr.io/).

We've done:

* Added type annotations to reduce [Slow Types](https://jsr.io/docs/about-slow-types). https://github.com/honojs/hono/pull/2663 
* I added the `jsr-dry-run` command in CI to check if it's ready to publish JSR. https://github.com/honojs/hono/pull/2662/commits/8b247079ce0620aa487fa1efef15035214444298
* Added `deno.json`. https://github.com/honojs/hono/pull/2662/commits/7ac63060928d04beab51e5a3f94adaf02658f37e And modified.
* Made `JSX` be exported from `hono/jsx/jsx-runtime` not `global`. https://github.com/honojs/hono/pull/2662/commits/5bd2b71709a3e8d28a83c193fb70d7363b65dc85
* Made `hono-base.ts` does not use `dynamicClass`. https://github.com/honojs/hono/pull/2662/commits/b9025907175d31879e5f3648661d60536af1a787
* Made `ExecutionContext` is not declared in `global`. https://github.com/honojs/hono/pull/2662/commits/cf020c64c52df488393343efc06a5a2ce3bb6e5a
* Removed `deno_dist` and `denoify` completely. https://github.com/honojs/hono/pull/2662/commits/0c776fa22696b54cbc31c51c7262a0a056316499
* Made `deno.json` exports `./`, `./jsx/jsx-runtime`, ~~`./middleware`,
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2265 — https://github.com/honojs/hono/pull/2265
**event_id:** `hono_pr_2265`

### PR content
```
PR #2265: feat: Introduce WebSocket Helper / Adapter

Reference: https://github.com/honojs/hono/issues/1153

If we marge this PR, we can use WebSocket API through Hono easier.

Example (Bun):
```tsx
// app.tsx

/** @jsx jsx */
/** @jsxImportSource ./hono/src/jsx */
import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/ws/bun'

const { upgradeWebSocket, websocket } = createBunWebSocket()

const app = new Hono()

app.get('/', c => {
  return c.html(
  <html>
    <head>
      <meta charset="UTF-8" />
    </head>
    <body>
      <h1>Hono WebSocket Example</h1>
      <div id="now-time"></div>
      <script dangerouslySetInnerHTML={{
        __html: `
        const ws = new WebSocket('/ws')
        const $nowTime = document.getElementById('now-time')
        ws.onmessage = evt => {
          $nowTime.textContent = evt.data
        }
        `
      }}></script>
    </body>
  </html>)
})

const ws = app.get('/ws', upgradeWebSocket(c => {
  let intervalId: number
  return {
    onOpen(evt, ws) {
      intervalId = setInterval(() => {
        ws.send(new Date().toString())
      }, 200) as unknown as number
    },
    onClose ()
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4227 — https://github.com/honojs/hono/pull/4227
**event_id:** `hono_pr_4227`

### PR content
```
PR #4227: Next

For `v4.8.0`.
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4834 — https://github.com/honojs/hono/pull/4834
**event_id:** `hono_pr_4834`

### PR content
```
PR #4834: feat(css): add classNameSlug option to createCssContext

## Description

Adds an optional `classNameSlug` function to `createCssContext` that lets users customize generated CSS class names instead of the default `css-1234567890` format.

Closes #4577

**Before:** Always generates `css-1234567890`
**After:** Pass `classNameSlug: (hash, label, css) => string` to get custom names

```ts
const { css, Style } = createCssContext({
  id: 'my-styles',
  classNameSlug: (hash, label) => label.trim() ? `h-${label.trim()}` : hash,
})

const hero = css`/* hero-section */ background: blue;`
// .h-hero-section { background: blue; }
```

## Changes

- `src/helper/css/common.ts` — exported `ClassNameSlug` type, added optional `classNameSlug` param to `cssCommon()`
- `src/helper/css/index.ts` — added `classNameSlug` option to `createCssContext()`, exported `ClassNameSlug` type
- `src/helper/css/index.test.tsx` — 4 new tests for custom slug, label extraction, fallback, and default behavior

## Verification

- All existing tests pass
- TypeScript: 0 errors
- ESLint: 0 warnings
- Prettier: all files formatted

## API

```ts
type ClassNameSlug = (hash: string, label: string, css: string) => st
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3826 — https://github.com/honojs/hono/pull/3826
**event_id:** `hono_pr_3826`

### PR content
```
PR #3826: feat(hono/jwk): JWK Auth Middleware

Hello, I recently needed a JWK middleware for my projects, but I figured contributing it to hono has the potential to save me and others a lot of time.

### Middleware Features:
- Set `options.keys` to a static array of public keys `HonoJsonWebKey[]` in code.
- Set `options.keys` to an async function that returns a `Promise<HonoJsonWebKey[]>` for flexibility
- Set `options.jwks_uri` to fetch JWKs from a URI, after which it appends those fetched keys to provided `keys` if any
- Set an optional `init` parameter (only used for `jwks_uri`)—useful if your host supports caching through custom init options.

#### Added extra:
- Added `JwtHeaderRequiresKid` exception. Since the middleware requires presence of a `kid` field in the header in order to select the correct key.
- Added `Jwt.verifyFromJwks` util function _(batteries included)_.

### Addressed issues:
- https://github.com/honojs/hono/issues/3658
- https://github.com/honojs/hono/issues/2589
- https://github.com/honojs/hono/issues/672

### Other code changes:
- Typescript-extended `JsonWebKey` to have `kid?: string` (This is a standard: https://datatracker.ietf.org/doc
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3589 — https://github.com/honojs/hono/pull/3589
**event_id:** `hono_pr_3589`

### PR content
```
PR #3589: feat(helper/proxy): introduce proxy helper

fixes #3518

### Naming

The name `proxyFetch` seems a little redundant, but I rejected the other candidates for the following reasons.

* `proxy` : The name `proxy` is simple but is avoided because it is confusing with the JavaScript `Proxy` object.
* `fetch` : The name `fetch` is also good. Although it is in the `helper/proxy` namespace, so it can be distinguished, when it is used by being incorporated into the application, from the standpoint of reading the code, it looks like `globalThis.fetch` is being called, so I decided to avoid it because of the cognitive load.

### Usage

```ts
app.get('/proxy/:path', (c) => {
  return proxyFetch(new Request(`http://${originServer}/${c.req.param('path')}`, c.req.raw), {
    proxySetRequestHeaders: {
      'X-Forwarded-For': '127.0.0.1',
      'X-Forwarded-Host': c.req.header('host'),
      Authorization: undefined, // prevent propagating "Authorization" request headers in c.req.raw
    },
    proxyDeleteResponseHeaderNames: ['Cookie'],
  })
})
```

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fi
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1904 — https://github.com/honojs/hono/pull/1904
**event_id:** `hono_pr_1904`

### PR content
```
PR #1904: feat: Introducing a New SSG Adaptor/Helper 

To celebrate the release of Hono v4, I propose a new feature. This is somewhat niche, but it's a Helper (or Adaptor) designed to convert Hono code into static HTML. Utilizing this, users can easily host SSG on platforms like S3 or R2. Currently, I'm grappling with three main concerns.

1. is this within the scope of responsibilities for the Hono framework? If it's deemed unnecessary, I might consider moving it to hono/middleware.
2. I'm wondering if it's more fitting to provide this as an Adaptor rather than a Helper, given its nature.
3. is the functionality interface appropriate? I've found myself pondering over this and have started studying SSG in other frameworks as well :)

### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno



---

yusukebe (review): Looks great!

sor4chi: Hi @watany, excuse me from outside.

Thanks for the great suggestions! I like the concept.
In terms of Hono's built-in middleware approach, I think we have to avoid dependence on runtime as much as possible.

For example, I thought it would be cleaner to expo
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2595 — https://github.com/honojs/hono/pull/2595
**event_id:** `hono_pr_2595`

### PR content
```
PR #2595: feat: Introduce ConnInfo helper/adapter

I created ConnInfo helper/adapter for Bun, Deno and CF Workers.
You can get client IP Address with Hono easier if we marge PR.

This provides runtime-less ConnInfo object.

For example, you can get IP Address on Bun:
```ts
import { Hono } from 'hono'
import { getConnInfo } from 'hono/bun'

const app = new Hono()

app.get('/', c => c.text(`Your ip address is ${getConnInfo(c).remote.address}!!`))

Bun.serve(app)
```

If you want to use Workers, replace import:
```ts
import { getConnInfo } from 'hono/cloudflare-workers'
```

In Deno:
```ts
import { getConnInfo } from 'https://deno.land/x/hono/helper.ts'
```
### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun denoify` to generate files for Deno



---

yusukebe (review): LGTM!

nakasyou: reference:
- https://github.com/honojs/hono/issues/379
- https://github.com/orgs/honojs/discussions/1439
- https://github.com/orgs/honojs/discussions/1600
- https://github.com/orgs/honojs/discussions/1187

yusukebe: @nakasyou 

CI fails. Could you run `bun run lint:fix` (As you said on X, I might have made a mistake in confi
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4382 — https://github.com/honojs/hono/pull/4382
**event_id:** `hono_pr_4382`

### PR content
```
PR #4382: feat(request): add cloneRawRequest utility for request cloning

**Problem**

After using Hono validators, the `raw` Request obejct gets consumed
during body parsing, making it unusable for external libraries like
`better-auth`.
This results in the error:

```shell
TypeError: Cannot construct a Request with a Request object that has already been used.
```

**Root Cause**

The issue occurs in the `#cachedBody` method in `HonoRequest`. When parsing request
bodies (json, text, etc.), the method directly calls parsing methods on the raw Request
object, which consumes its body stream. Once consumed, the Request cannot be cloned or
reused by external libraries.

**Solution**

Adding a utility function to clone HonoRequest's underlying raw Request
object, handling both consumed and unconsumed request bodies.

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

yusukebe: Hi @kamaal111 

Why I didn't implement clo
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1437 — https://github.com/honojs/hono/pull/1437
**event_id:** `hono_pr_1437`

### PR content
```
PR #1437: feat: Add `c.stream()`

Hi, @yusukebe, @ geelen

I implemented `c.stream()` according to #914. I'd like to see @ geelen added as a co-author as well, since I'm pretty much quoting the code from the issue.

This is the first time I've use a StreamAPI, so feel free to point out any mistakes.

@yusukebe asked me to give some examples of using `c.stream()`.
Below are some examples.

## Usecase

### 1: ChatGPT Proxy
Enable rate limiting to protect or hide external APIs

<details>
<summary>Code</summary>

```ts
import OpenAI from 'openai'
import { Hono } from 'hono'

const app = new Hono<{
  Bindings: {
    OPENAI_API_KEY: string
  }
}>()

const PROMPT = (message: string) => [
  {
    role: 'system' as const,
    content:
      'You are an Web developer. If you receive a question about Web-related technologies, you can answer it.',
  },
  {
    role: 'user' as const,
    content: message,
  },
]

app.post('/', async (c) => {
  const body = await c.req.json()
  const openai = new OpenAI({ apiKey: c.env.OPENAI_API_KEY })

  return c.stream(async (stream) => {
    const chatStream = await openai.chat.completions.create({
      messages:
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3787 — https://github.com/honojs/hono/pull/3787
**event_id:** `hono_pr_3787`

### PR content
```
PR #3787: feat: add language detector middleware and helpers

Closes #3785

## Description
Add language detector middleware to support future i18n functionality in Hono applications.

## Features
- Detect language from multiple sources:
  - Query parameters
  - Cookies
  - Accept-Language header
  - URL path
- Type-safe language access via `c.get('language')`
- Configurable detection order
- Support for language caching
- Comprehensive test coverage

## Usage
```typescript
import { languageDetector } from 'hono/language'

app.use('*', languageDetector({
  supportedLanguages: ['en', 'ar', 'es'],
  fallbackLanguage: 'en'
}))

app.get('/', (c) => {
  const lang = c.get('language')
  return c.text(`Current language: ${lang}`)
})

### The author should do the following, if applicable

- [X] Add tests
- [X] Run tests
- [X] `bun run format:fix && bun run lint:fix` to format the code
- [X] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code
…function



---

askorupskyy (review): I love it! This entirely solves the lang detection for me. Would also be cool to have a way to disable cookie/query detection a
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3832 — https://github.com/honojs/hono/pull/3832
**event_id:** `hono_pr_3832`

### PR content
```
PR #3832: feat(etag): allow for custom hashing methods to be used to etag

resolve: https://github.com/honojs/hono/issues/3829

```ts
const app = new Hono()

app.use(
  '/etag/*',
  etag({
    generateDigest: (body: Uint8Array) =>
      crypto.subtle.digest({
          name: 'SHA-256',
        },
        body
      ),
  })
)
```

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

EdamAme-x: Can you review this?
@Gobd @usualoma

Gobd: I'll try it out later today

EdamAme-x: @Gobd Sorry for ping, how?

usualoma: Hi @EdamAme-x!

Thank you for creating the PR. I'm sorry for the very late response. Please wait a little while as I check it.

usualoma: @EdamAme-x 
This method of PR is very good because users can generate the etag value simply by passing a custom hash function. Users don't need to be aware of the stream, and it's very simple.

However, the current etag of hono is limited by the fact that `crypto.subtle` d
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4599 — https://github.com/honojs/hono/pull/4599
**event_id:** `hono_pr_4599`

### PR content
```
PR #4599: feat(ssg): add redirect plugin

close #4389

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

yusukebe: @3w36zj6 

Please ping me if it's ready to review.

3w36zj6: Sorry for the delayed response. Other tasks besides ESLint rule enforcement are currently unfinished.

Once I've completed the fixes and replied to comments, I'll send review request.

3w36zj6: I've finished addressing the review.

This might be a nitpick, but should we also treat 303[^1], 307[^2], and 308[^3] as triggers for generating redirect HTML? Since all of them require the `Location` header, I feel it would make the implementation more consistent with the specification.

[^1]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/303
[^2]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/307
[^3]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/308

yusukebe: @3w36zj6 

> This might be a nitpi
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2615 — https://github.com/honojs/hono/pull/2615
**event_id:** `hono_pr_2615`

### PR content
```
PR #2615: feat(middleware): Introduce Timeout Middleware

I used to use it for personal use, but I see here that there seems to be a demand for it, so I share it with you.
https://github.com/orgs/honojs/discussions/1765

Many cloud environments implement infrastructure-level timeouts, but it is useful if you want to set per-route timeouts on the application side.

---

## Timeout Middleware
This middleware enables you to easily manage request timeouts in your application. It allows you to set a maximum duration for requests and define custom error responses if the specified timeout is exceeded.

## Import

```typescript
import { Hono } from 'hono';
import { timeout } from 'hono/timeout';
```

## Usage

Here's how to use the Timeout Middleware with default and custom settings:

Default Settings:

```typescript
const app = new Hono();

// Applying a 5-second timeout
app.use('/api', timeout(5000));

// Handling a route
app.get('/api/data', async (c) => {
  // Your route handler logic
  return c.json({ data: 'Your data here' });
});
```

## Custom Timeout Settings:

```typescript
app.use('/api/long-process', timeout('1m', {
  message: 'Request ti
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2408 — https://github.com/honojs/hono/pull/2408
**event_id:** `hono_pr_2408`

### PR content
```
PR #2408: feat: add middlewares resolve trailing slashes on GET request

### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno

As titled. Tests provided and denoified.



---

yusukebe (review): `yarn.lock` should not be changed. Can you remove the change for it?

yusukebe (review): Great! LGTM.

yusukebe: Hi @rnmeow 

Thanks for the PR. This is nice! But I'm now considering whether to merge this into the core. This is so simple that users may define it themselves. And we could put how to make it in the document.

But we may accept this later.

cnrkuo: RE: @yusukebe

Understand. Dealing with trailing slashes, in my point of view, is perhaps an essential need for people building web applications, especially the larger ones.

As a framework (and also plays an important role of router), it would be convenient if Hono offers the solution out-of-the-box.  
Using middlewares might not be the best way to achieve that. Instead, for a better architecture, I may suggest to implement that in:

a) the `Hono` interface

```js
const app = new Hono({ trailingSlash: 'append' }) // 'append' | 'trim' |
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3661 — https://github.com/honojs/hono/pull/3661
**event_id:** `hono_pr_3661`

### PR content
```
PR #3661: ci: compare bundle size

### The author should do the following, if applicable

- [ ] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

k2tzumi (review): Looks good to me!

m-shaka (review): Sorry for being late. Great work!

It would be nicer if you could see a unit(like KB or MB) of bundle size, but it's OK to add it later

yusukebe (review): LGTM!

EdamAme-x: if this pr is merged, `before.js` will also be output to show the change in bundle size.

![image](https://github.com/user-attachments/assets/f6603a5a-e933-4e4b-bdcd-cfc4ddc9002e)

EdamAme-x: Hi @m-shaka, could you please check this?

yusukebe: Hi @k2tzumi! Can you review this, you too?

EdamAme-x: what happen, DDoS...?
![image](https://github.com/user-attachments/assets/c51371b2-22ae-4bf6-b039-e44f830a936c)

EdamAme-x: hi @yusukebe, this pr should be ready.

EdamAme-x: > It would be nicer if you could see a unit(like KB or MB) of bundle size, but it's OK to add it later

Agreed!  
We will add custom metrics later, so it seems like a good idea to
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3420 — https://github.com/honojs/hono/pull/3420
**event_id:** `hono_pr_3420`

### PR content
```
PR #3420: feat(serve-static): support absolute root

This PR enables the serve static middleware to support an absolute path for `root`. This change affects the `serveStatic` from Bun and Deno adapter.

```ts
import { serveStatic } from 'hono/bun'

// ...

app.all(
  '/static/*',
  serveStatic({ root: '/home/hono/app/static', allowAbsoluteRoot: true })
)
```

To use an absolute path for `root`, you should set `allowAbsoluteRoot` as `true`. This is because it prevents security issues. If the user does not know a root can have an absolute path, an intended string that includes an absolute path is set; it will cause unexpected behavior for them. And using an absolute path has a risk of accessing the whole of the system. So, setting the flag explicitly is a good design.

We should implement the same feature for the Node.js adapter later.

Related to #3383 #3108

Closes #3107

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

usualoma (review): I
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2269 — https://github.com/honojs/hono/pull/2269
**event_id:** `hono_pr_2269`

### PR content
```
PR #2269: feat(cookie): add secure and host prefix support

Hello @yusukebe!

I have added support for secure and host prefixes. This PR resolves https://github.com/honojs/hono/issues/1203

### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno

cc: @Code-Hex



---

yusukebe (review): Looks good to me!

Code-Hex (review): LGTM

yusukebe: Hey @Code-Hex !

Could you also review this one?

Code-Hex: @Datron I added a few comments but almost looks great to me!

Datron: @Code-Hex I've resolved your comments.

Code-Hex: @yusukebe Could you check one more time?

yusukebe: Looks good again!

Thanks @Datron and @Code-Hex !

I'll merge this into the "next" branch for `v4.1.0`. I'll release it maybe soon (when the WebSocket feature is merged!).
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1796 — https://github.com/honojs/hono/pull/1796
**event_id:** `hono_pr_1796`

### PR content
```
PR #1796: feat(reg-exp-router): Introduced PreparedRegExpRouter

### What is the PR to improve?

With this PR, we aim to improve the reduction of RegExpRouter bundle size and initial addition time.

As you can see in the code I added to the following unit test, we can prepare regular expressions, etc. in advance by passing the routing information to `buildInitParams()`. This can be used to simplify the initialization process at startup.

[src/router/reg-exp-router/router.test.ts](https://github.com/honojs/hono/compare/main...usualoma:hono:feat/prepared-reg-exp-router?expand=1#diff-9c118fa74a63028640569d2d36dc3980faa196b86b3a706dc1c1c211931e8639R662)

### Benchmark

In Node.js, it is more than 10 times faster than RegExpRouter and close to LinearRouter; in Bun, it may be faster than LinearRouter.

```
$ npm run bench-includes-init:node

> bench-includes-init:node
> tsx ./src/bench-includes-init.mts

cpu: Apple M2 Pro
runtime: node v20.0.0 (arm64-darwin)

benchmark                 time (avg)             (min … max)       p75       p99      p995
------------------------------------------------------------ -----------------------------
• GET /user
--------------
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4214 — https://github.com/honojs/hono/pull/4214
**event_id:** `hono_pr_4214`

### PR content
```
PR #4214: feat(service-worker): add `fire()`

This PR introduces the `fire()` method in the Service Worker adapter. It will do `addEventListener('fetch', handle(app))` for the given Hono instance. Usage:

```ts
import { Hono } from 'hono'
import { fire } from 'hono/service-worker'

const app = new Hono()

app.get('/', (c) => c.text('Hi'))

fire(app)
```

The background: https://github.com/honojs/hono/issues/3127#issuecomment-2843529188

### The author should do the following, if applicable

- [ ] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

rajsite (review): 🔥

yusukebe: Hi @rajsite!

I create the PR for the feature you may want. Can you review this?

yusukebe: Hi @rajsite, can you review this again?

yusukebe: @rajsite Thanks!
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3638 — https://github.com/honojs/hono/pull/3638
**event_id:** `hono_pr_3638`

### PR content
```
PR #3638: chore(build): validate if exporting is correct in `package.json` and `jsr.json`

Related: https://github.com/honojs/hono/pull/3636

If there is a difference between the two exports, the build will fail.



---

yusukebe (review): LGTM!

EdamAme-x: It fails as follows.
![image](https://github.com/user-attachments/assets/a6825ede-6753-4bab-9fb9-66d1a21724fe)
https://github.com/honojs/hono/actions/runs/11704963747/job/32598601119?pr=3638

The test succeeds when this PR is merged.
https://github.com/honojs/hono/pull/3636

EdamAme-x: Fixed some missing exports

EdamAme-x: @yusukebe 
Could you review this?

yusukebe: Hi @EdamAme-x !

This PR means you added a function to validate the configuration of exporting modules in `package.json` and `jsr.json` with `validateExports`, right?

EdamAme-x: That is what I mean.
If an endpoint is missing that should be exported to either, throw an error.

yusukebe: @EdamAme-x 

Thanks! Seems to be good. But adding a test for `validateExports` like `remove-private-fields.test.ts` is better.

EdamAme-x: thanks, okay.

EdamAme-x: @yusukebe 
ready for review

EdamAme-x: @yusukebe 
Re-ready for review

yusukebe: Hi @nakasyou Can you 
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2999 — https://github.com/honojs/hono/pull/2999
**event_id:** `hono_pr_2999`

### PR content
```
PR #2999: fix: change to allow use of websocket options

Closes https://github.com/honojs/hono/issues/2997

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

EdamAme-x: typed
![image](https://github.com/honojs/hono/assets/121654029/e1fba46a-46ff-4dcf-a810-d8a2e6877eb6)

yusukebe: Hi @EdamAme-x 

Is this ready to review?

EdamAme-x: @yusukebe  yes. but
I currently have duplicate type definitions in deno.d.ts and websocket.ts, what should I do? 
I have tried several approaches, but the types will be broken. (e.x. import from websocket.ts, define in d.ts)
Or I think I can define the type with "any" handler options in deno.d.ts.

EdamAme-x: @yusukebe Ready for review

yusukebe: Hi @EdamAme-x 

I think it's not bad to use `any` in this case. I've left a comment; please check it!

EdamAme-x: thanks @yusukebe

EdamAme-x: hi @yusukebe 
hmm... Github actions throw error

```console
info - 2024-06-21 06:36:46,045 -- ci service found
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1858 — https://github.com/honojs/hono/pull/1858
**event_id:** `hono_pr_1858`

### PR content
```
PR #1858: feat(css): Implement css helper with callback

### What kind of implementation is this?

The callback mechanism used in Suspense and ErrorBoundary is used to insert the class name.
It is primarily targeted to be used in JSX components, but can also be used in `html` tag functions.
It does not depend on jsxRenderer.

### Pros

* It does not depend on jsxRenderer, so you can use any pattern you like.
* In environments where initialization does not occur with every request, It works very fast because CSS is not recalculated when class names are predefined globally.

### Cons

* The mechanism is complicated because the string is always a `Promise<string>` and callback must be properly called to obtain the final result. (However, if you use c.html(), you do not need to be aware of this complexity.)
* Allowing Promise<string> in the `class` attribute may confuse some linters (e.g. https://github.com/honojs/hono/issues/1812 ).
    * https://github.com/honojs/hono/compare/feat/css-helper...usualoma:hono:feat/css-helper?expand=1#diff-eea0d4f8a89b330f26eea854ef087c7d92cfca29268164f8ee315f770e4be7e8L26-R26

### Demo

```ts
import { Hono } from './src'
import { j
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1009 — https://github.com/honojs/hono/pull/1009
**event_id:** `hono_pr_1009`

### PR content
```
PR #1009: feat(adapter): Added aws-handler support for APIGatewayProxyEventV2

Super exicted about the slim adapter! Got the chance to start using it yesterday and ran into some missing mappings when calling lambda directly through the function URL.

- Renamed `APIGatewayEvent` to `APIGatewayProxyEvent` to follow the convention from `@types/aws-lambda`
- Added `APIGatewayEventV2`. The type used by function urls
- Added support for sending files through streams. Ran into issues while using with `serveStatic`. Files will be converted to `base64`.
- Broke the handler into smaller functions. It became quite bloated when accounting for base64 and event mapping

Submitted directly through github.com - will catch up on any red flags 👍



---

yusukebe (review): @schonert 

Do you run `yarn test:lambda`?

And I've leave some comments.

schonert: All tests are green 👍

yusukebe: Hi @schonert !

Thank you for creating PR! I am glad you wish Lambda adapter for Hono.

I commented on several points of concern. And I also get the following error in the test. How about making `queryStringParameters` optional and checking it in the adapter?

<img width="675" alt="SS" src="https:
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/2426 — https://github.com/honojs/hono/pull/2426
**event_id:** `hono_pr_2426`

### PR content
```
PR #2426: feat: support for `vary` header in cache middleware

This PR adds support for the `Vary` header in cache middleware, allowing developers to specify headers that should trigger separate cache entries. This feature is essential for applications serving content that varies based on client headers, such as Accept or Accept-Language, enhancing content negotiation and caching efficiency.

closed: https://github.com/honojs/hono/issues/2395

### Example Usage

```ts
app.use('/example/*', cache({ cacheName: 'my-app-cache', vary: 'Accept, Accept-Encoding' }));
app.get('/example/', (c) => {
  return c.text('This content is cached with Vary header.');
});
```

This simple addition enables the server to cache different versions of a resource based on the specified header(s), ensuring that clients receive content that's tailored to their needs, such as different image formats or languages.


**Author should do the following, if applicable:**
- [X] Add tests.
- [X] Run tests.
- [X] `yarn denoify` to generate files for Deno.



---

yusukebe (review): Looks good to me!

yusukebe: Hi @naporin0624 !

Thanks! I've left some comments. Please check them.

@usualoma If y
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1960 — https://github.com/honojs/hono/pull/1960
**event_id:** `hono_pr_1960`

### PR content
```
PR #1960: feat: Added `ssgParams` middleware

I added `ssgParams` middleware.
This is implemented https://github.com/honojs/hono/pull/1904#issuecomment-188809839.

There is 2 changes.

#### 1. API like `generateStaticPaths`.
You can use API like `generateStaticPaths`.
Example:
```tsx
import { Hono } from 'hono'
import { toSSG, ssgParams } from 'hono/ssg'
import * as fs from 'fs/promises'

app.get('/', c => c.html(<h1>Top page</h1>))
app.get('/post/:id', ssgParams([{ id: '1' }]), c => c.html(<h1>{c.req.params('id')}</h1>)

await toSSG(app, fs)
```
#### 2. Switching SSR/SSG
You can add No-SSG routes such as:
```tsx
import { Hono } from 'hono'
import { toSSG, ssgParams } from 'hono/ssg'
import * as fs from 'fs/promises'

app.get('/', c => c.html(<h1>Top page</h1>)) // SSG
app.get(
  '/api',
  ssgParams(false), // Don't SSG
  c => c.json({ status: 'ok' })
) 

await toSSG(app, fs)
```
This code is SSG-based mode like [Astro hybrid mode](https://docs.astro.build/en/guides/server-side-rendering/#enable-on-demand-server-rendering).

Not only this code, you can use SSR-Based mode.
```tsx
import { Hono } from 'hono'
import { toSSG, ssgParams } from 'hon
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1630 — https://github.com/honojs/hono/pull/1630
**event_id:** `hono_pr_1630`

### PR content
```
PR #1630: feat: Introduce streaming API with `Suspense` and `use`.

This PR is based on #1626.

### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno



---

yusukebe (review): Please update `package.json` for `hono/jsx/streaming`:

```js
  "exports": {
    //...
    "./jsx/streaming": {
      "types": "./dist/types/jsx/streaming.d.ts",
      "import": "./dist/jsx/streaming.js",
      "require": "./dist/cjs/jsx/streaming.js"
    },
```

```js
  "typesVersions": {
    "*": {
      //...
      "jsx/streaming": [
        "./dist/types/jsx/streaming.d.ts"
      ],
```

usualoma: Hi @yusukebe!

There are no significant changes from https://github.com/usualoma/hono/pull/3, but I have added the following three refactorings and a test of the replacement results using "happy-dom".

* 442538e
* b154592
* d7efbab
* 2d15249

usualoma: Refactoring is complete.

yusukebe: Hi @usualoma,

I'll take a look this PR along with #1626 and check how it feels to use it. So please give me a minute. Thanks.

yusukebe: @usualoma 

Is it OK to assume that this PR includes all of #1626? But, if so
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/1341 — https://github.com/honojs/hono/pull/1341
**event_id:** `hono_pr_1341`

### PR content
```
PR #1341: feat(middleware): Alternative middleware equivalent to Helmet

I created this middleware as an experimental equivalent to Helmet. Originally made for my own use, I've opened a PR in this repository because there was a request for Helmet in the Github Issues. One difference from the official Helmet is that this middleware only adopts headers that can be set with fixed values, and users can only set each header to true/false.

I'm still undecided about the name of the middleware. It's not a pure Helmet. Names like 'mini-helmet' or 'kabuto' could be interesting, but for now, I've opted for a straightforward naming.



### Author should do the followings, if applicable

- [x] Add tests
- [x] Run tests
- [x] `yarn denoify` to generate files for Deno

## Doc(sample)

---
### Secure Header Middleware
This middleware simplifies the setup of security headers. Inspired in part by the capabilities of Helmet, it allows you to control the activation and deactivation of specific security headers.

#### Installation
The middleware is built into the Hono framework, so no additional installation is required.

#### Usage
```ts
import { secureHeader } from 'hono/secur
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4552 — https://github.com/honojs/hono/pull/4552
**event_id:** `hono_pr_4552`

### PR content
```
PR #4552: fix(types): replace schema-based path tracking with CurrentPath parameter

- ref: #4529

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

kosei28: I found a part that works differently than expected outside of the test cases, so I'll put the PR in draft.

kosei28: I fixed it according to the original specifications and added tests for them.

kosei28: The number of instantiations is now 694,649.

kosei28: I fixed the pathless handler's path to be a union to match the original type. However, in the actual routing, `this.#path` (which stores the last registered path) is used for the pathless handler, resulting in the following behavior. The `CurrentPath` implementation before the fix might have been better.

Also, even if the handler's return value isn't `Promise<void>`, calling `next` will route to the subsequent handler, so I don't think type branching based on the return type is necessary.

```ts
import { Hono } from "
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4314 — https://github.com/honojs/hono/pull/4314
**event_id:** `hono_pr_4314`

### PR content
```
PR #4314: feat: add `parseResponse` util to smartly parse `hc`'s Response

This PR adds a `hcParse` util that will automatically parse the response from a `hc` fetch, throwing a structured error if response is not `ok`, it is also type-safe.

Somewhat resolves #3894

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code - I added some doc, but not fully semantics JSDoc.

Note: this is an alternative PR for #4313, this PR does not add any dependency, ~however, do note that this PR do not have a graceful fail-safe for `json` parsing from [`destr`].~

This PR reimplements `fetch-result-please` minimally that is customized for Hono and integrates with `hcParse` better., do note that while the code have a different behavior compared to `fetch-result-please`/`ofetch` (removed `blob` response, `text` for undefined content-type header because we removed `destr`), but the UX should be the same and transparent for Hono's users because Hono always set the `content-type` for us
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4161 — https://github.com/honojs/hono/pull/4161
**event_id:** `hono_pr_4161`

### PR content
```
PR #4161: CI: add type benchmark with typescript-go preview

- issue: https://github.com/honojs/hono/issues/4159
- Adding performance check with typescript-go
- Refactored GitHub Actions configuration to support benchmarks for two implementations.

### The author should do the following, if applicable

- [ ] Add tests
- [ ] Run tests
- [ ] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

sushichan044: It seems an error is occurring when type checking external libraries.
While it executes successfully if `skipLibCheck: true` is set, this isn't the outcome we're looking for.

https://github.com/honojs/hono/actions/runs/15224335180/job/42824439319?pr=4161#step:5:7

note: This is not happening in `tsc`.

<details><summary>Details</summary>
<p>

```
./../node_modules/vitest/dist/chunks/reporters.6vxQttCV.d.ts:6:10 - error TS2305: Module '"/Users/sushichan044/workspace/github.com/sushichan044/honojs-hono/node_modules/vite/index"' has no exported member 'TransformResult'.

6 import { TransformResult as TransformResul
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3673 — https://github.com/honojs/hono/pull/3673
**event_id:** `hono_pr_3673`

### PR content
```
PR #3673: fix: Private name "#errorHandler" must be declared in an enclosing class

This PR fixes https://github.com/honojs/hono/issues/3671

on `hono-base.ts` the `route` method accepts `app: Hono<SubEnv, SubSchema, SubBasePath>`, so when using the `app` instance we don't have access on private methods.

before the `errorHandler` propery was `private errorHandler` (only valid on typescript) but now is `#errorHandler`, so is not  accessible  anymore.

related: https://github.com/honojs/hono/pull/3596

### The author should do the following, if applicable

- [ ] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe: @TiBianMod Thanks!

> on `hono-base.ts` the `route` method accepts `app: Hono<SubEnv, SubSchema, SubBasePath>`, so when using the `app` instance we don't have access on private methods.

Does it throw an error? If so, can you share the minimal code to reproduce it?

TiBianMod: @yusukebe Thanks,

please checkout https://github.com/TiBianMod/3673-reproduction

but like i set, `#errorHandler` 
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3596 — https://github.com/honojs/hono/pull/3596
**event_id:** `hono_pr_3596`

### PR content
```
PR #3596: refactor: use `#` for private methods to reduce the minified file size

This PR reduces the bundle size using `#` for the private methods instead of the `private` keyword when the code is minified.

The result for the "Hello World" app with the `hono/tiny` preset. This is minified with `esbuild --minify` command:

```
-rw-r--r--@  1 yusuke  staff  12167 10 31 16:13 current.js
-rw-r--r--@  1 yusuke  staff  11688 10 31 16:18 next.js
```

`479 bytes` will be reduced without changing any logic and without performance degradation!

### `#` vs `private`

For example, you have the code:

```ts
class A {
  private myPrivateMethod() {}
  myPublicMethod() {
    this.myPrivateMethod()
  }
}
```

If you use the `private` keyword for the private method, the function name is not minifed with esbuild

```js
"use strict";class A{myPrivateMethod(){}myPublicMethod(){this.myPrivateMethod()}}
```

Instead of `private`, you can use `#` for the private method.

```ts
class A {
  #myPrivateMethod() {}
  myPublicMethod() {
    this.#myPrivateMethod()
  }
}
```

Then, the function name will be minified!

```js
"use strict";class A{#t(){}myPublicMethod()
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4485 — https://github.com/honojs/hono/pull/4485
**event_id:** `hono_pr_4485`

### PR content
```
PR #4485: feat: Improve auth middlewares

Closes #4484 

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe: Hey @MathurAditya724 

A question. Is only the Bearer Auth related to https://github.com/honojs/middleware/pull/1318? JWT/JWK is not related to https://github.com/honojs/middleware/pull/1318, right?

MathurAditya724: I have checked the `simpleMcpAuth` with Stytch, Clerk, Auth0 and WorkOS and each have a different way of authenticating in the middleware.

These 3 will be used the most depending on the dev. I just added the `bearerAuth` middleware in `@hono/mcp` cause that is like a super set for the other 2, so it will be working with everyone and didn't wanted to copy all 3 of them. If you look at the bearerAuth file in https://github.com/honojs/middleware/pull/1318, I have copied the whole file from here.

Ideally we should be supporting all 3 for having a good MCP support, but if you think it's to much I will update the branch to limit my changes to `bearerAuth`

yusukebe: @MathurAditya724 

[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4360 — https://github.com/honojs/hono/pull/4360
**event_id:** `hono_pr_4360`

### PR content
```
PR #4360: feat(proxy): add `customFetch` option to allow custom fetch function

Resolves #4351

This PR will add the option parameter `customFetch` to allow the user to override the global `fetch` in Proxy helper.

Usage:

```ts
app.get('/', () =>
  proxy(`https://example.com/`, {
    customFetch,
  })
)
```

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

karthik2804 (review): This looks good to me! I really appreciate the swift PR. Thank you!

yusukebe: Hey @karthik2804 @riywo @usualoma , can you review this?

riywo: LGTM as well!

yusukebe: @karthik2804 @riywo @BarryThePenguin @usualoma 

As discussed in the discussion: https://github.com/honojs/hono/pull/4360#pullrequestreview-3135719109, I decided to go with this API:

```ts
app.get('/', () =>
  proxy(`https://example.com/`, {
    customFetch,
  })
)
```

Thank you!
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4353 — https://github.com/honojs/hono/pull/4353
**event_id:** `hono_pr_4353`

### PR content
```
PR #4353: feat(csrf): Add modern CSRF protection with Fetch Metadata support

### Add modern CSRF protection with Fetch Metadata support

**Why this change?**

Modern browsers support [Fetch Metadata headers (Sec-Fetch-Site)](https://web.dev/articles/fetch-metadata) which provide a more reliable way to detect cross-origin requests than traditional Origin header checking alone. This enhancement adds opt-in support for Fetch Metadata based CSRF protection while maintaining full backwards compatibility.

### References and Inspiration

The implementation is inspired by:
- the go std lib (net/http) implementation: https://github.com/golang/go/blob/5dac42363ba8281a3f4f08e03af2292b763adc38/src/net/http/csrf.go#L122-L163
- the go RFC https://github.com/golang/go/issues/73626#issue-3046320918

More references:
- https://web.dev/articles/fetch-metadata
- https://developer.mozilla.org/en-US/docs/Glossary/Fetch_metadata_request_header
- https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/CSRF#fetch_metadata

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- 
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/3943 — https://github.com/honojs/hono/pull/3943
**event_id:** `hono_pr_3943`

### PR content
```
PR #3943: feat(middleware/cache): add `cacheableStatusCodes` option

This pull request updates the cache middleware to avoid caching when it is defined as uncacheable in RFC 7231.
Caching will no longer occur under the following conditions.

## Conditions for Avoiding Caching

### 1. Status codes defined as uncacheable by default

> Responses with status codes that are defined as cacheable by default
(e.g., 200, 203, 204, 206, 300, 301, 404, 405, 410, 414, and 501 in this specification)
https://datatracker.ietf.org/doc/html/rfc7231#section-6.1

Additionally, It introducing an optional argument to allow caching of arbitrary status codes.

```ts
// In this case, only 412 will be cached.
app.use(
  '/*',
  cache({
    cacheName: 'foo',
    wait: true,
    cacheControl: 'max-age=10',
    cacheableStatusCodes: [412],
  })
)
```

### 2. Request methods defined as uncacheable

Only GET, HEAD, POST, and PATCH will be cached, otherwise it is no longer cached.

> this specification defines GET, HEAD, and POST as
   cacheable

https://datatracker.ietf.org/doc/html/rfc7231#section-4.2.3

> A response to this method is only cacheable if it contains explicit fr
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4539 — https://github.com/honojs/hono/pull/4539
**event_id:** `hono_pr_4539`

### PR content
```
PR #4539: feat(context-storage): Add optional tryGetContext helper to context-storage middleware

introduce getContextIfAny, which returns the stored context or undefined without throwing
make the existing getContext delegate to the softer helper so behavior stays unchanged when no context exists
expand the context-storage tests to cover both success and missing-context scenarios for the new helper



---

yusukebe (review): LGTM!

yusukebe: This PR will resolve #4536.

yusukebe: @AyushCoder9 Thank you for the PR!

Hi @elibarzilay! What do you think of this PR? I think good.

elibarzilay: > @AyushCoder9 Thank you for the PR!
> 
> Hi @elibarzilay! What do you think of this PR? I think good.

LGTM either way -- I specifically avoided thinking too much about a good name, to leave it up to people who might know the codebase better :)

AyushCoder9: > > @AyushCoder9 Thank you for the PR!
> > 
> > Hi @elibarzilay! What do you think of this PR? I think good.
> 
> LGTM either way -- I specifically avoided thinking too much about a good name, to leave it up to people who might know the codebase better :)
> 
@elibarzilay are you merging this pr ? Tell me if I need to change something 
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4469 — https://github.com/honojs/hono/pull/4469
**event_id:** `hono_pr_4469`

### PR content
```
PR #4469: fix(aws-lambda): serve microsoft office files as binary in lambda handler

This PR fixes https://github.com/honojs/hono/issues/4468

# Description:
When serving Microsoft Office files, due to the existence of "xml" as part of the mimetype, the function `defaultIsContentTypeBinary` incorrectly classifies the response as plain text and not binary. Leading to a broken file download to the user.

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code



---

yusukebe (review): LGTM!

usualoma (review): Thank you!

usualoma: Hi @matthiasfeist, @web-dev-sayantan

Thanks for creating the issue ticket and the PR, and for the review. Since the original regular expression can be reorganized, I think the approach in #4470 is the way to go.

yusukebe: @matthiasfeist @web-dev-sayantan @usualoma Thank you all!

matthiasfeist: Thanks @yusukebe @usualoma @web-dev-sayantan It was fun to contribute! thanks so much for your help!
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4451 — https://github.com/honojs/hono/pull/4451
**event_id:** `hono_pr_4451`

### PR content
```
PR #4451: feat(aws-lambda): handle AWS Lattice events

For types I was going by [these docs](https://docs.aws.amazon.com/vpc-lattice/latest/ug/lambda-functions.html) and request dumps extracted from a Lambda sitting behind Lattice.

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [ ] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

watany-dev (review): @anho 
Thank you. The logic seems fine. LatticeV2 and Lattice notations are mixed, so how about unifying them to V2, like APIGateway? (I'm not familiar with Lattice, so please correct me if I'm saying anything strange.)

yusukebe (review): LGTM!

anho: @yusukebe any chance this can be merged any time soon?

yusukebe: @anho Maybe! But I'm not so familiar with AWS.

Hey @watany-dev, can you view this?

watany-dev: I'll make sure to watch it this week. Thanks.

anho: @watany-dev I would appreciate it if you could give this a timely look.

anho: @yusukebe is there anything that can be done to move this forward? We at [Contentful](https://github.com/contentful/) p
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

## PR #honojs/hono/pull/4394 — https://github.com/honojs/hono/pull/4394
**event_id:** `hono_pr_4394`

### PR content
```
PR #4394: feat(ssg): add default plugin that defines the recommended behavior

cf. https://github.com/honojs/hono/issues/4389#issuecomment-3248655086

### The author should do the following, if applicable

- [x] Add tests
- [x] Run tests
- [x] `bun run format:fix && bun run lint:fix` to format the code
- [x] Add [TSDoc](https://tsdoc.org/)/[JSDoc](https://jsdoc.app/about-getting-started) to document the code



---

yusukebe (review): LGTM!

yusukebe (review): LGTM!

3w36zj6: Should I inject `defaultPlugin` as a default argument?

```diff
diff --git a/src/helper/ssg/ssg.ts b/src/helper/ssg/ssg.ts
index 68eb0a9b..33a40330 100644
--- a/src/helper/ssg/ssg.ts
+++ b/src/helper/ssg/ssg.ts
@@ -373,7 +373,7 @@ export const toSSG: ToSSGInterface = async (app, fs, options) => {
   let result: ToSSGResult | undefined
   const getInfoPromises: Promise<unknown>[] = []
   const savePromises: Promise<string | undefined>[] = []
-  const plugins = options?.plugins || []
+  const plugins = options?.plugins || [defaultPlugin]
   const beforeRequestHooks: BeforeRequestHook[] = []
   const afterResponseHooks: AfterResponseHook[] = []
   const afterGenerateHooks: AfterGenerateHook[
[truncated]
```

**Label:** `has_decision:` ___  `decisions:` ___

---

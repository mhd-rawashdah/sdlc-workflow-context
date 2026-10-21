# Security review — checklist

Detailed checks for `../SKILL.md` step 2. Each section: what to look for, where in this kind of
codebase (Next.js App Router · AEM-backed · pnpm workspace), and leads to grep for. **Grep output is
a lead to read, never a finding by itself** — a finding needs the source → sink path.

Run the leads over the changed files first (`$REPORTS_DIR/changed-files.txt` from `VERIFY.md` §2),
then over the paths the changes reach.

```bash
cd "$TARGET_REPO"
grep -E '\.(ts|tsx|js|mjs|cjs|json|ya?ml)$' "$REPORTS_DIR/changed-files.txt" > "$REPORTS_DIR/security-files.txt"
lead() { tr '\n' '\0' < "$REPORTS_DIR/security-files.txt" | xargs -0 -r grep -nHE -- "$1"; }
```

---

## 1. Authentication

- Route handlers (`app/api/**/route.ts`) and server actions that act on data or trigger side effects
  verify the caller: shared secret header, signed token (JWT/IAM SigV4/API key from `lib/auth/**`),
  or session — **before** reading the body or doing work.
- Secret comparison is constant-time (`lib/security/safe-compare`), never `===`/`!==` on secrets.
- Token generation uses vetted libraries, adequate entropy, expiry; no secrets embedded in tokens.
- mTLS/client-certificate paths fail closed when certificates are missing.
- Leads: `lead "export (async )?function (GET|POST|PUT|PATCH|DELETE)"`, `lead "headers\.get\("`,
  `lead "(!==|===)\s*env\.[A-Z_]*(SECRET|KEY|TOKEN)"`.

## 2. Authorisation

- Every action checks that **this** caller may act on **this** resource (no IDOR via ids in paths,
  query or body).
- Revalidation/ingest/admin endpoints restrict what they may touch (tag/path allow-lists).
- Middleware redirects and rewrites cannot be used to reach internal routes.
- Feature flags are not the only control over privileged behaviour.

## 3. Input validation

- All external input — query, params, body, headers, cookies, `postMessage`, CMS fields used as
  control data — is validated for type, shape, length and allowed values at the boundary.
- `request.json()` failures are handled; arrays and nested objects are bounded.
- Locale, slug and path segments are validated before use in fetches or file paths
  (`lib/aem/slug-utils`, `lib/middleware/parse-variant-path`).
- Leads: `lead "request\.(json|text|formData)\("`, `lead "searchParams\.get\("`, `lead "params\."`.

## 4. Injection

- **SSRF:** outbound URLs built from input go through an allow-list (`apps/dco/src/lib/safe-url.ts`
  `toAllowedUrl` / `hostsFrom`); no user-controlled host, protocol or port; redirects not followed
  blindly to new hosts.
- **Query injection:** GraphQL/AEM queries use variables, not string interpolation of input.
- **Command/path injection:** no `child_process` with input; no `fs` paths from input; scripts under
  `scripts/` that take arguments validate them.
- **Header/log injection:** CR/LF stripped from values placed in headers or log lines.
- **Code execution:** no `eval`, `new Function`, `vm`, dynamic `import()` of input.
- Leads: `lead "fetch\(|axios|httpClient"`, `lead "gql|graphql|query:"` (then read each query for
  interpolated input), `lead "child_process|execSync|spawn\("`, `lead "\beval\(|new Function"`.

## 5. Cross-site scripting

- Every `dangerouslySetInnerHTML` source is sanitised through `atoms/rte-renderer` (`sanitize-html`
  allow-list); no second sanitiser; no bypass of the allow-list (`allowedTags: false`, `*`
  attributes beyond `class`).
- URLs placed in `href`/`src`/`action` reject `javascript:`, `data:` (except vetted images) and
  `vbscript:`; CMS links pass the safe-link checks (`isSafeAbsoluteLink`, `resolve-link`).
- No `innerHTML`/`outerHTML`/`document.write`/`insertAdjacentHTML` with dynamic content.
- JSON embedded in `<script>` (structured data) is serialised safely (escape `<`, `>`, `&`, U+2028/9).
- CSP (`apps/dco/csp.mjs`) is not weakened: no new `'unsafe-eval'`, wildcard sources, or removed
  directives without justification.
- Leads: `lead "dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write"`,
  `lead "href=\{|src=\{"`, `lead "unsafe-(eval|inline)|\*\."` (in `csp.mjs`).

## 6. CSRF (where applicable)

- State-changing endpoints called from browsers with cookies use non-`GET` methods and verify origin
  (`Origin`/`Referer`), a CSRF token, or `SameSite` cookies; form submissions to third parties
  (reCAPTCHA-protected forms) validate the token server-side.
- Not applicable to endpoints authenticated only by a non-cookie shared secret header — say so.

## 7. API security

- Methods restricted to those implemented; unexpected methods rejected.
- Rate limiting / abuse protection on public, expensive or enumerable endpoints (search,
  search-ingest, logs) — or an explicit note that infrastructure provides it.
- Response bodies return only needed fields; no internal identifiers, stack traces or upstream
  error bodies.
- CORS: no `Access-Control-Allow-Origin: *` with credentials; allowed origins explicit.
- Caching: personalised or authenticated responses are not cached publicly (`Cache-Control`,
  `revalidate`, CDN `s-maxage`).
- Leads: `lead "Access-Control-Allow|Cache-Control|revalidate"`.

## 8. Secret exposure

- No credentials, tokens, private keys or private endpoints in source, tests, fixtures, docs,
  workflows or commit history of the PR.
- Server-only secrets never prefixed `NEXT_PUBLIC_` and never read in client components or in the
  design-system package; `turbo.json` `passThroughEnv` additions reviewed for client exposure.
- `.env*` files not committed (only samples with `.invalid` placeholder hosts).
- Storybook config does not expose non-public env (it loads only `NEXT_PUBLIC_*` from the app's
  `.env.local`).
- Leads: `lead "(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*['\"]"`,
  `lead "AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}"`,
  `lead "NEXT_PUBLIC_[A-Z0-9_]*(SECRET|KEY|TOKEN|PASSWORD)"`, `lead "process\.env\."`.

## 9. Sensitive-data handling

- Personal data (form submissions, newsletter emails, CRM payloads) is transmitted over HTTPS only,
  not logged, not stored in web storage, not placed in URLs or analytics payloads.
- Cookies carrying identifiers set `Secure`, `HttpOnly` (when not needed by JS) and `SameSite`.
- Consent is respected before analytics/marketing tags fire (`@workspace/analytics` consent helpers).
- Leads: `lead "localStorage|sessionStorage|document\.cookie|setCookie|cookies\("`,
  `lead "email|phone|nationalId|passport"` near `logger.` or `trackEvent`.

## 10. Unsafe third-party integrations

- New scripts, iframes, SDKs or CDNs are justified, loaded from expected origins, added to CSP
  deliberately, and use `integrity`/`crossorigin` where static.
- `postMessage` targets an exact origin and listeners check `event.origin`.
- External links with `target="_blank"` carry `rel="noopener noreferrer"`.
- Data sent to third parties (analytics, maps, reCAPTCHA) contains nothing beyond what the ticket
  requires.
- Leads: `lead "postMessage|addEventListener\(['\"]message"`, `lead "<script|<iframe|next/script"`.

## 11. Dependencies and supply chain

- Each added or upgraded dependency: necessary, maintained, reputable publisher, licence compatible,
  pinned by the lockfile; no install scripts doing unexpected work.
- Lockfile changes correspond to manifest changes; no unexplained registry or tarball URLs.
- `pnpm.overrides` changes do not downgrade a security pin (the target pins many transitive versions
  for advisories).
- `pnpm audit --prod` advisories introduced by this change are findings; pre-existing ones are
  recorded as context.
- Leads: `git -C "$TARGET_REPO" diff "$MERGE_BASE" -- '**/package.json' pnpm-lock.yaml | grep -E '^[+-]\s+"'`.

## 12. Logging and error handling

- Errors returned to clients are generic; details go to the server logger (`@workspace/logger`).
- Logs contain no secrets, tokens, full request bodies with personal data, or secret **lengths**/
  partial values that aid guessing.
- Failures fail closed (deny) for auth and validation; exceptions in middleware do not bypass checks.
- Error pages (`error.tsx`, `global-error.tsx`, `500`) do not render stack traces in production.
- Leads: `lead "logger\.(info|warn|error|debug)\(|console\."`, `lead "catch \(\w*\) \{\s*\}"`.

## 13. Configuration security

- Security headers and CSP in `next.config.*` / `csp.mjs` not weakened; `poweredByHeader` stays off
  where set; image `remotePatterns` restricted to known hosts.
- CI workflows: no secrets echoed, no `pull_request_target` with checkout of untrusted code, actions
  pinned, permissions minimal; scanning workflows (Trivy, ZAP, TruffleHog) not disabled.
- Build-time flags (`ALLOW_BUILD_WITHOUT_AEM`, `PRODUCTION_SOURCE_MAP`) not enabled for production.
- Leads: `lead "remotePatterns|headers\(\)|poweredByHeader|productionBrowserSourceMaps"`,
  workflow diffs under `.github/workflows/`.

## 14. Security regressions

- Compare against the merge-base: was a validation, sanitiser, allow-list, auth check, header, CSP
  directive, test of a security control, or scanner step **removed or relaxed**?
- Do changed security helpers keep their tests, and do the tests still assert the denial cases?
- Leads: `git -C "$TARGET_REPO" diff "$MERGE_BASE" -- '**/security/**' '**/auth/**' '**/safe-url.ts' '**/csp.mjs' '**/middleware*' '.github/workflows/**'`.

---

## Writing a finding

```
| 3 | HIGH | CONFIRMED | XSS | packages/ui/src/components/blocks/promo/index.tsx:41 |
  CMS field `promoHtml` (cfData → PromoWrapper → Promo) is rendered with dangerouslySetInnerHTML
  without passing through sanitiseRte; AEM authors and anyone who can write the fragment control the
  markup. | Stored XSS on every page using the block. |
  Render through `atoms/rte-renderer` (`<RteRenderer html={promoHtml} />`) and drop the raw prop. |
```

State the source, the path, the sink, why existing controls do not stop it, the impact, and the
remediation in terms of this codebase.

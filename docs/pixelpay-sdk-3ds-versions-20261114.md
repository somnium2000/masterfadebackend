# PixelPay SDK 3DS: version evidence, 2026-11-14

## Decision

Keep `@pixelpay/sdk-core` pinned to **2.5.8** in this patch. Official npm publishes
2.5.9 and 2.5.10, with `latest=2.5.10`, but neither version makes the existing
Node Sale capable of completing a browser-dependent `songbird` continuation.
This is demonstrated by package comparison and synthetic tests; no financial
requests were made. Genuine browser authentication and provider settlement remain
unverified.

Source: [official npm registry metadata](https://registry.npmjs.org/@pixelpay%2fsdk-core),
read on **2026-11-14 14:29:27-14:29:36 UTC** (metadata and three version dist records).
The evidence is a point-in-time observation, not a promise about future releases.

## Official package identity

Packages were downloaded using `npm pack --ignore-scripts` from registry.npmjs.org.
No application dependencies or lockfiles were updated.

| Version | Official tarball | SHA-256 |
| --- | --- | --- |
| 2.5.8 | [sdk-core-2.5.8.tgz](https://registry.npmjs.org/@pixelpay/sdk-core/-/sdk-core-2.5.8.tgz) | `e65c02651706608c3531cccf2dfdab247b3b3419f3ee13ac9437eb7e5a3508ad` |
| 2.5.9 | [sdk-core-2.5.9.tgz](https://registry.npmjs.org/@pixelpay/sdk-core/-/sdk-core-2.5.9.tgz) | `09c7990ce5f37e68da8ae2fb7321bb121cfa772be68846900bca3662ce3ae2a4` |
| 2.5.10 | [sdk-core-2.5.10.tgz](https://registry.npmjs.org/@pixelpay/sdk-core/-/sdk-core-2.5.10.tgz) | `db4acb70e065c265f92f669115f3392fde36f95620aa9b401aeee1e0c6e9476f` |

## Comparison matrix

Paths and lines below refer to the extracted official packages, not application
files. The package changelog dates 2.5.9 to 2026-10-29 and 2.5.10 to 2026-11-02.

| Version | Component | Demonstrated change | MasterFade impact | Proof |
| --- | --- | --- | --- | --- |
| 2.5.8 | `lib/services/Transaction.js:25-26,38-46` | Explicit 3DS rejects outside browser; a provider 202 dispatches `songbird`, `payload`, or `router` after the Sale POST. | Adding `withAuthenticationRequest()` in Node rejects before send; omitting it does not prevent a provider 202 from invoking DOM code. | Installed-SDK contract tests; raw Node fixtures. |
| 2.5.9 | `lib/services/Transaction.js:36-44` | Removes `router` branch and `RouterManager`; removes transaction `source` field. | Routing behavior changes; this is not a songbird fix. A 202 `router` now throws an invalid-type exception. | Exact file diff and version fixture. |
| 2.5.10 | `lib/services/Transaction.js` | Byte-identical to 2.5.9. | Same browser requirement and same dispatch; no Node continuation added. | SHA-256 file comparison. |
| All three | `lib/libraries/PayloadManager.js:40-66` | Byte-identical. Uses `document` at line 43, iframe and `window.onmessage`. | Synthetic 202 `payload` still produces `ReferenceError: document is not defined` in Node. | Raw Node fixture on all three versions. |
| All three | `lib/libraries/CardinalManager.js:33-63` | Byte-identical. With collection URL, constructs form/iframe; otherwise loads Songbird and uses `window.Cardinal`. | `songbird` still requires browser APIs. Upgrading cannot supply the missing React/Node exchange. | Both Node branches reproduced; bounded DOM contract tests. |
| 2.5.10 | `lib/requests/PaymentTransaction.js:94-96`, `lib/requests/LookupTransaction.js:49-50,77-78,106-121`, `lib/services/CardinalAuthentication.js:12-14` | Adds `setBeforeAuthenticate(callback)`, copies callback into lookup, awaits callback and assigns its returned string to `payment_token`. | Potential extension point; not a documented payment-token issuance, scoped handoff, or backend verification contract. | Synthetic callback returns a fake token; lookup sees that token. |
| All three | `lib/entities/TransactionResult.js:35-48` | Byte-identical; accepts response classes and copies financial fields from `response.data`. | Does not add nested Status extraction or prove approval/identity/hash. Preserve MasterFade's stricter verification. | Hash comparison; incomplete 200 fixture has no payment UUID despite accepted response class. |
| All three | `lib/base/ServiceBehaviour.js:67-116,173-181` | Byte-identical; 202 maps to `PayloadResponse`, 412/418 to `PreconditionalResponse`; caught transport exceptions become `FailureResponse` 520. | An SDK response class alone cannot determine financial outcome. | 200/202/201/412/transport fixtures. |
| All three | `lib/models/Settings.js`, `lib/base/ServiceBehaviour.js:27-65` | Byte-identical settings, credential/header construction and endpoint configuration. Same runtime dependencies. | No demonstrated credential/signature/environment repair from an upgrade. | File hashes and package manifests. |
| All three | `lib/services/Transaction.js` | `getStatus` still posts the same status path; `verifyPaymentHash` still performs backend-only order/key/secret MD5 comparison. | No upgraded Status contract or browser-safe hash verification. | Exact unchanged source. |

Selected identical-file SHA-256 prefixes across **all three** packages:

| File | SHA-256 prefix |
| --- | --- |
| `PayloadManager.js` | `f77ca1eb2e310e04` |
| `CardinalManager.js` | `f940fc6710f91c8b` |
| `TransactionResult.js` | `387db412352a6bb9` |
| `ServiceBehaviour.js` | `23aaec943b2fe796` |
| `Settings.js` | `1140ebb41417aac0` |

## What songbird actually does in the SDK

**DEMONSTRATED IN CODE:** the initial Sale POST precedes the `songbird` dispatch.
This does not establish whether an acquirer has captured funds. HTTP 202 alone is
neither capture evidence nor proof that no financial action occurred.

`CardinalManager` handles two branches:

1. `payload` plus optional `collection_url` is passed to `init`. Without collection
   URL it loads Cardinal Commerce Songbird; with the URL it submits a JWT in an
   iframe form. The JWT is opaque here, not an assumed financial approval.
2. `payments.setupComplete` supplies a session reference. The manager creates a
   `LookupTransaction`, gathers browser EMV fields and calls
   `api/v2/cardinal/authentication/lookup` (`CardinalManager.js:68-84`).
3. A lookup may require a challenge: Songbird `continue('cca', ...)` or a submitted
   challenge form (`CardinalManager.js:256-283`). The response's identifier is
   assigned to `transaction.authentication_identifier` at line 257.
4. `payments.validated` with a JWT invokes
   `api/v2/cardinal/authentication/continue`, followed by `retryTransaction`.
   `NOACTION` also invokes `retryTransaction` (`CardinalManager.js:87-118`).
5. `retryTransaction` POSTs the same transaction type to `/transaction/sale` or
   `/transaction/auth` (`CardinalAuthentication.js:18-29` in 2.5.8; 19-30 in 2.5.10).

The second Sale POST is a **real SDK control-flow behavior**, reproduced using
fixtures. It must not be silently transplanted into MasterFade's one-attempt
guard or described as guaranteed safe just because the SDK implements it.
PixelPay must confirm its continuation/idempotency semantics and the identity
binding before a cross-tier integration can safely use it. No such POST was sent
to a real provider during this work.

`ui.close` only hides the modal. The SDK does not thereby settle its Promise,
persist a resume handle, or prove cancellation. Destroying browser state loses
the installed listeners. Synthetic tests characterize this as unresolved, not
approved or definitively failed.

## Documentation versus missing contract

**DOCUMENTED:** [JavaScript installation](https://docs.pixelpay.com/page/sdk/installation/javascript)
states the browser requirement for 3DS; [SDK requests](https://docs.pixelpay.com/page/sdk/requests)
places `withAuthenticationRequest()` on the client and `doSale`/`doAuth` in the
backend. [Getting started](https://docs.pixelpay.com/page/sdk/getting-started)
recommends backend execution except that method.

**DEMONSTRATED IN CODE:** `withAuthenticationRequest()` only sets
`authentication_request=true` (`PaymentTransaction.js:82-84`). It does not itself
collect evidence, initialize Cardinal, issue a scoped token or implement a
React/Node channel.

**PENDING PROVIDER:** a supported cross-tier protocol for initial 202, scoped
browser data, payment-token issuance/use, TTL, allowed origins, lookup/continue
authentication, final verified result, continuation replay and recovery without
payment UUID. The 2.5.10 hook does not define these requirements. Do not send
`auth_hash`, secret key, signed router credentials or arbitrary provider HTML to
React to bridge this gap.

Questions supported by the reproduction:

1. Is the documented split client/backend supported by SDK 2.5.8, or is 2.5.10's
   lookup token callback required? Provide the complete issuance/validation flow
   and the exact allowlisted browser response, without merchant credentials.
2. Does the post-authentication second Sale POST resume the original payment or
   create a new financial attempt? Which identifiers and idempotency guarantee
   make retries safe after timeout, duplicate event, reload or network loss?
3. Which authenticated backend evidence proves final captured outcome after the
   browser closes, including when the first 202 lacks a payment UUID?

## Tests and limits

Committed regression command (Node 20.20.2):

```sh
node --test test/pixelpay-sdk-3ds-contract.test.mjs
```

Result: **12 PASS, 0 FAIL, 0 SKIP**. Uses installed 2.5.8 and bounded globals/helpers,
with network connections rejected in continuation fixtures. Covers Node rejection,
Node DOM exceptions, synthetic lookup/challenge/validated callbacks, NOACTION,
SDK-internal second Sale POST count, collection origins, close/disconnect/reload.
No new dependency is needed. These are contract characterizations, **not browser
E2E, bank authentication, capture or genuine 3DS PASS**.

Separate local version experiment: **82 PASS, 0 FAIL, 0 SKIP** in Node 20.20.2 on
Windows, across the three extracted official packages with existing jsdom. The
82 test-runner entries include six grouping tests, 75 fixture tests and a final
zero-network guard. The experiment overrides HTTP methods and script/form loading;
network socket attempts were zero. It additionally covers HTTP 200/201/412,
incomplete/unknown responses, transport/runtime failures, router removal, collection
URL provider error/missing identifier, and 2.5.10 token callback. Its tooling and
downloaded packages are outside the PR and are not application dependencies.

Remaining **BLOCKED / NOT EXECUTED**: real browser/cardinal authentication,
provider token validity, real cancellation, physical browser disconnection,
authenticated resume after reload, late provider result and financial settlement.
Synthetic unresolved-state assertions do not turn those items into PASS.

Reproduce package provenance/comparison in a disposable directory:

```sh
npm view @pixelpay/sdk-core versions dist-tags --json --registry=https://registry.npmjs.org
npm pack @pixelpay/sdk-core@2.5.8 @pixelpay/sdk-core@2.5.9 @pixelpay/sdk-core@2.5.10 --ignore-scripts --registry=https://registry.npmjs.org
```

Extract each archive into a separate version directory, compare the cited files
byte-for-byte and run the installed-SDK regression above from the backend checkout.
Downloading or comparing a package does not authorize running its financial examples.

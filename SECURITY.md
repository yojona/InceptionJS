# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of
https://github.com/yojona/InceptionJS and choose **Report a vulnerability**.

Please do not open a public issue, pull request or discussion for a vulnerability.

Include what you can: affected version, steps to reproduce, impact, and whether you
need the report kept confidential.

## What to expect

- Acknowledgement within 3 business days.
- A first assessment within 10 business days.
- Fix targets by severity: critical 7 days, high 30 days, others at the next release.
  These are goals for a small project, not guarantees; we will say so if we need longer.
- Coordinated disclosure: we ask for 90 days from your report before you publish, and
  will tell you when a fix ships. We credit reporters who want it.

## Scope

In scope:

- The host library (`<inception-view>`, protocol, provenance, storage, downloads).
- The relay (`inceptionjs/server`): SSRF and range-check bypasses, token forgery or
  replay, origin allowlist bypass, resource exhaustion.
- The engine and our WebKit patch series: escapes from a loaded page into the host
  page or across isolation modes, memory corruption.
- The agent namespace: ways around the policy callback, risk classes or control
  hand-over.
- The identity measures: ways a page can hide or defeat the UA token,
  `navigator.inception`, or the provenance badge and notice for a view that has them on.

Out of scope:

- Vulnerabilities that exist unchanged in upstream WebKit (report them to the WebKit
  project; tell us too, so we can rebase quickly).
- Reports that depend on an embedder's own misconfiguration (a public relay without
  tokens, `--dev` in production, missing isolation headers).
- Phishing or abuse by a third party using the project: report it through the same
  private channel with the URL. We cannot remove code others have forked.
- Denial of service by volume, and social engineering of maintainers.
- What a loaded page does inside its own view is visible to the embedder by design.
  Embedders must not load sites whose secrets they should not see.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.x latest minor | Yes |
| Older 0.x | No |

We track WebKit security advisories and rebase the patch series on them; the goal is
monthly, sooner for critical fixes.

## Safe harbor

We will not pursue or support legal action against researchers who act in good faith:
they test only against their own deployments or the project's code, avoid privacy
violations and service disruption, do not access or keep other people's data, report
promptly, and give us reasonable time to fix before disclosure.

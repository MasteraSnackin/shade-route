# Security policy

## Supported versions

ShadeRoute has not published a stable release. Security fixes are applied only
to the current `main` branch. Earlier commits, demonstration media and local
forks are not supported versions.

## Report a vulnerability

Do not put exploit details, secrets, personal data or precise journey history in
a public issue.

Use GitHub's **Report a vulnerability** control on the repository's
[Security page](https://github.com/MasteraSnackin/shade-route/security) when it
is available. If that control is unavailable, open a minimal
[support issue](https://github.com/MasteraSnackin/shade-route/issues/new/choose)
that asks the repository owner to establish a private channel; include no
sensitive technical details.

Include in the private report:

- the affected commit or deployed URL;
- the component and impact;
- minimal reproduction steps or a proof of concept;
- whether credentials or personal data may be exposed; and
- any temporary mitigation already applied.

No response or remediation service level has been established. Do not test
against systems or data you do not own or have permission to use. Avoid service
disruption, provider quota exhaustion and access to another person's data.

## Safety and privacy defects

Incorrect shade estimates, misleading access claims and exposed journey data
can be harmful even when they are not conventional security vulnerabilities.
Report sensitive instances privately using the process above. Non-sensitive
model or data-quality reports may use the dedicated public issue form.

Never commit provider tokens. If a token is exposed, revoke it at the provider
first; deleting it from the latest commit is not sufficient.

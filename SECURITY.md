# Security

## Reporting

If you find a vulnerability in Kulmi, email `gpernoca@gmail.com` with a clear description and steps to reproduce. Do not open a public issue for security reports.

I will acknowledge receipt when I can and work with you on a fix timeline before any public disclosure.

## Scope

In scope:

- Sandbox escapes on macOS Seatbelt or Linux Bubblewrap
- Credential or secret leakage through tool output, logs, or sessions
- Path traversal or unauthorized filesystem access
- SSRF or private-network access through fetch or search tools
- Privilege escalation through the shell policy or process tools

Out of scope:

- Abuse of a user-supplied model API key or provider account
- Issues that require disabling the sandbox or running with `sandbox.mode = "off"`
- Vulnerabilities only present in unreleased local changes

## Hardening notes

Kulmi fails closed when the required OS sandbox backend is unavailable. Model-controlled commands run with a minimal environment, isolated temporary directories, output redaction, and a shell policy blocklist. Network access from sandboxed commands is off by default.

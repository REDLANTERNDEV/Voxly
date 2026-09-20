# ADR-0018 — Meta content remains an ordinary link

- **Status:** accepted
- **Date:** 2026-09-20

Voxly deliberately does not embed Instagram, Facebook, Threads, or other Meta
content. Supporting those providers through their current official path would
require the self-hosted server to call Meta's oEmbed service and members'
browsers to execute Meta SDK code. That tracking surface conflicts with the
product's privacy direction, so Meta URLs remain safe ordinary links: no Meta
API request, SDK, iframe, image, cookie, CSP origin, or configuration is added.
This is a provider boundary rather than a technical limitation; changing it
requires an explicit replacement of this decision.

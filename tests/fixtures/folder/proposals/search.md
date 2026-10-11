---
title: "Proposal: search across documents"
---

# Search across documents

Readers keep **dozens** of agent reports open<img src="preview-probe.png" onerror="window.__mdvPwned='preview-img'"> and need to find a phrase in all of them<script>window.__mdvPwned='preview-script'</script>, so the viewer indexes the folder's files when search is first opened. See [the API handoff](../handoffs/2026-10-01-api.md) and ![a diagram](diagram.png).

## Design

The index is built lazily, a few files at a time, and never blocks the page.

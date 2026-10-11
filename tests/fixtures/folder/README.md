# Project notes

Status reports, handoffs and proposals for the search project, written by the agents that work on it. Start with the weekly status.

- [Weekly status](status.md)
- [Handoff: the API](handoffs/2026-10-01-api.md)
- [Handoff: the reading UI](handoffs/2026-10-08-ui.md)
- [Proposal: search across documents](proposals/search.md)
- [An idea we set aside](proposals/archive/old-idea.markdown)
- [A note that is not Markdown](notes.txt)

This folder is the test fixture of the folder sidebar, quick open, search in files, recent documents and link previews. The tests add a `.git` folder and a `node_modules` folder at run time (git does not store a folder named `.git`, and `node_modules` is ignored), and check that neither is listed, nor `.drafts`, nor anything more than 8 folders deep.

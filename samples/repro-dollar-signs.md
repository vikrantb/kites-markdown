# Repro: dollar signs outside math

Open this file in the viewer to reproduce a known rendering bug (see `docs/roadmap.md`, known issue 8).
Every dollar sign below is NOT math. On GitHub this file renders correctly.

The basic plan costs $5 and the pro plan costs $10 per month.

Inline code: `echo $HOME $PATH`

```bash
echo "$HOME" and "$PATH"
```

Only this line is math: $a^2 + b^2 = c^2$

**Expected:** prices and both code samples render as plain text; one formula.
**Actual (2026-10-04, Chrome):** "and the pro plan costs" is typeset as italic math, and both code
samples show raw KaTeX HTML markup inside the code.

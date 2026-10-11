# Dollar signs

Each case is named D01 to D23. The browser test reads every case and checks whether it became math.

- D01 inline: $x^2$
- D02 two prices: costs $5 and $10 per month
- D03 space after the opening dollar: $ x$
- D04 space before the closing dollar: $x $
- D05 digit after the closing dollar: $x$5
- D06 escaped dollars: \$x\$
- D07 escaped dollar inside math: $a\$b$
- D08 code span: `echo $HOME $PATH`
- D09 a code span inside a would-be formula: $x `y` z$
- D10 inline display: $$e^{i\pi}+1=0$$
- D11 underscores and stars stay TeX: $a_1 * b_1 = c_1 * d_1$
- D12 a price, then a shell variable in code: costs $5, see `$PATH`
- D13 a currency code before the dollar: US$5 and US$10
- D14 a slash between prices: $5/$10
- D22 spaces inside the dollars: $ a + b $
- D23 a comment after a lone dollar: $x <!-- narrate: y$ --> stays a comment

| Case | Cell |
|---|---|
| D15 | $\alpha + \beta$ |

<!-- narrate: D16 a narration that mentions $5 and $10 -->

D17 display block:

$$
\frac{a}{b}
$$

D18 a blank line inside double dollars is not math:

$$
a

b
$$

D19 one-line display block:

$$ \sqrt{2} $$

- D20 display block in a list item:

  $$
  x + y
  $$

```bash
echo "$HOME" and "$PATH"   # D21 fenced code
```

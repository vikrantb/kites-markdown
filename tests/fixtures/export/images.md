# Images in an export

An exported page carries its local images inside it. Each image below takes a different route.

![A chart next to the document](chart.png)

![The same chart, by its path from the viewer](tests/fixtures/export/chart.png)

![An image that does not exist](no-such-image.png)

![An image on the web](https://example.invalid/picture.png)

A diagram, so the page has one:

```mermaid
flowchart LR
    Source --> Export
```

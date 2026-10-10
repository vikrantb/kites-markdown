# Diagram gallery

Every diagram type the viewer draws, in one place. Each is a plain Mermaid fenced block, so this file reads the same on GitHub. In the viewer each diagram takes the colours of the current theme (light, sepia or dark) and is redrawn when the theme changes. Click a diagram, or its expand button, to open it full screen, where you can drag to pan, scroll or pinch to zoom, and press `0` to fit, `1` for actual size and `Esc` to close.

## Flowchart

```mermaid
flowchart LR
    Draft[Draft] --> Review{Review}
    Review -->|approve| Publish([Publish])
    Review -->|changes| Draft
    Publish --> Archive[(Archive)]
    subgraph Editing
      Draft
      Review
    end
```

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor Reader
    participant V as Viewer
    participant M as Mermaid
    Reader->>V: Open a document
    V->>M: Draw each diagram
    M-->>V: SVG
    Note over V,M: A theme change redraws every diagram from its saved source, in the new palette.
    alt The diagram has a syntax error
        V-->>Reader: Show the reason and the source
    else
        V-->>Reader: Show the diagram
    end
    loop Every theme change
        V->>M: Draw again
    end
```

## Class diagram

```mermaid
classDiagram
    class Document {
      +String path
      +String text
      +render() Html
    }
    class Diagram {
      +String source
      +String type
      +draw(theme) Svg
    }
    class Theme {
      +String name
      +palette() Map
    }
    Document "1" *-- "many" Diagram : contains
    Diagram ..> Theme : uses
```

## State diagram

```mermaid
stateDiagram-v2
    [*] --> Closed
    Closed --> Open: open
    Open --> Expanded: expand
    Expanded --> Open: Esc
    Open --> [*]: close
    state Expanded {
      [*] --> Fit
      Fit --> Zoomed: wheel or pinch
      Zoomed --> Fit: press 0
    }
```

## Entity relationship diagram

```mermaid
erDiagram
    AUTHOR ||--o{ DOCUMENT : writes
    DOCUMENT ||--|{ SECTION : has
    SECTION ||--o{ COMMENT : collects
    AUTHOR {
      string name
      string email
    }
    DOCUMENT {
      string path PK
      date updated
    }
    COMMENT {
      string id PK
      string body
      string status
    }
```

## Gantt chart

```mermaid
gantt
    title Release plan
    dateFormat YYYY-MM-DD
    axisFormat %b %d
    section Design
    Palette and type      :done,    d1, 2026-10-01, 4d
    Diagram theme         :active,  d2, after d1, 5d
    section Build
    Pan and zoom          :         b1, after d2, 4d
    Tests                 :crit,    b2, after b1, 3d
    section Ship
    Release               :milestone, m1, after b2, 0d
```

## Pie chart

```mermaid
pie showData
    title Reading time by block type
    "Prose" : 52
    "Code" : 18
    "Diagrams" : 14
    "Tables" : 9
    "Math" : 7
```

## Mind map

```mermaid
mindmap
  root((Reading))
    Structure
      Outline
      Minimap
      Folding
    Visuals
      Diagrams
      Math
      Code
    Listening
      Read aloud
      Narration
```

## Timeline

```mermaid
timeline
    title A document's life
    Draft : Outline : First pass
    Review : Comments : Revisions
    Publish : Share a link : Read anywhere
```

## User journey

```mermaid
journey
    title Reading a design review
    section Arrive
      Open the file: 5: Reader
      Skim the outline: 4: Reader
    section Understand
      Expand a diagram: 5: Reader
      Check the math: 3: Reader
    section Respond
      Leave a comment: 4: Reader, Author
```

## Git graph

```mermaid
gitGraph
    commit id: "import"
    branch visuals
    checkout visuals
    commit id: "palette"
    commit id: "diagrams"
    checkout main
    commit id: "docs"
    merge visuals
    commit id: "release"
```

## Quadrant chart

```mermaid
quadrantChart
    title Features by effort and value
    x-axis Low effort --> High effort
    y-axis Low value --> High value
    quadrant-1 Plan carefully
    quadrant-2 Do first
    quadrant-3 Maybe later
    quadrant-4 Avoid
    Copy button: [0.15, 0.62]
    Dark diagrams: [0.42, 0.9]
    Pan and zoom: [0.58, 0.76]
    Export: [0.82, 0.4]
```

## XY chart

```mermaid
xychart-beta
    title "Words read per day"
    x-axis [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
    y-axis "Words" 0 --> 9000
    bar [3200, 4100, 5300, 4700, 6900, 8200, 7600]
    line [3200, 4100, 5300, 4700, 6900, 8200, 7600]
```

## Linked nodes

A node whose label is exactly the text of a heading in the document links to that heading: click it, or reach it with Tab and press Enter. Each node below jumps to its section of this page.

```mermaid
flowchart LR
    A[Pie chart] --> B[Mind map] --> C[Timeline]
```

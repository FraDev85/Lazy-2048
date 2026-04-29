# Lazy 2048

A physics-based reimagining of the classic 2048 puzzle game, built with vanilla JavaScript (ES6 modules). Drag, stack, and merge numbered tiles in a fully simulated 2D physics world — or just sit back and watch them fall.

## Features

- **Physics simulation** — tiles behave as rigid bodies with constraints, collisions, and gravity
- **Drag-to-merge gameplay** — grab any tile and fling it toward its match
- **Procedural audio** — sfxr-style sound effects synthesised entirely in-browser; no audio files required
- **Generative music** — a tracker-based music engine composes background music at runtime
- **Adaptive quality** — high/low quality rendering modes; automatically switches to low quality on mobile
- **Responsive layout** — scales to any screen size; requests fullscreen on mobile and high-DPI displays
- **Zero dependencies** — pure HTML, CSS, and JavaScript; no frameworks, no build step

## How to Play

| Action | Result |
|---|---|
| **Drag** a tile | Move it around the canvas |
| **Stack** two tiles with the same number | They merge into the next value |
| **Reach 2048** | You win 🎉 |
| **Do nothing** | Tiles drift on their own (recommended for the highly lazy) |

## Getting Started

No installation or build tools needed. Just serve the files from any static web server:

```bash
# Python 3
python -m http.server 8080

# Node.js (npx)
npx serve .
```

Then open `http://localhost:8080` in your browser.

Alternatively, open `index.html` directly in a modern browser — note that some browsers restrict the Web Audio API for `file://` URLs, so a local server is recommended for full audio support.

## Project Structure

```
├── index.html   # Game shell and DOM layout
├── style.css    # Styles, animations, and toggle controls
├── script.js    # All game logic (physics, audio, rendering)
├── LICENSE.txt  # MIT License
└── README.md    # This file
```

## Browser Compatibility

Requires a modern browser with support for:

- ES2020+ (classes, optional chaining, nullish coalescing)
- Canvas 2D API
- Web Audio API (`AudioContext`)
- `requestAnimationFrame`

Tested on Chrome, Firefox, Safari, and their mobile equivalents.

## Settings

| Option | Description |
|---|---|
| **Music** | Toggle the generative background music |
| **Sound FX** | Toggle in-game sound effects |
| **High Quality** | Toggle high-quality canvas rendering (auto-disabled on mobile) |

## Credits

- Original concept: [Lazy 2048 on CodePen](https://codepen.io/snazzysanoj/pen/KWmBpj) by snazzysanoj
- Rewrite & improvements: Francesco Comunale

## License

Released under the [MIT License](LICENSE.txt).

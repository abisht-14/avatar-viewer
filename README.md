# Roblox Avatar 3D Viewer

A browser-based 3D viewer for inspecting Roblox avatar rigs, layered clothing, and cage deformers. Built with Three.js.

![Screenshot](https://img.shields.io/badge/Three.js-r167-blue)

## Features

- **Inspector** - Per-mesh render stats: triangles, vertices, draw calls, GPU memory, materials, textures, bones, skinning weights
- **Stress Test** - Clone avatars (1-49x) with live FPS, CPU/GPU render time, JS heap, and frame budget bar
- **Budget Mode** - Triangle budget breakdown by body part
- **Report Mode** - Full performance report card
- **Procedural Animations** - Idle, Run, and Jump (no animation files needed)
- **Visibility Overlay** - Heatmap shader showing front-facing triangle orientation
- **LOD Preview** - Side-by-side LOD comparison

## Quick Start

```bash
git clone <repo-url>
cd avatar_viewer
python3 -m http.server 8090
```

Then open [http://localhost:8090](http://localhost:8090)

### Alternative servers

```bash
# Node.js (npx, no install needed)
npx serve -p 8090

# Node.js http-server
npx http-server -p 8090
```

> **Note**: You must use an HTTP server. Opening `index.html` directly via `file://` won't work due to browser fetch/CORS restrictions.

## Project Structure

```
avatar_viewer/
├── index.html          # Single-file app (HTML + CSS + JS)
├── manifest.json       # Model metadata catalog
├── models/
│   ├── rigs/           # 9 avatar rig files (.glb)
│   ├── clothing/       # 33 layered clothing files (.glb)
│   └── cage_deformers/ # 8 cage deformer test meshes (.glb)
├── convert_assets.py   # Build tool (FBX → GLB converter, optional)
├── .gitignore
└── README.md
```

## How It Works

The entire app is a single `index.html` file (~3000 lines) with embedded CSS and JavaScript. It uses:

- [Three.js r167](https://threejs.org/) via CDN (jsdelivr) for WebGL rendering
- GLTFLoader for loading `.glb` models
- OrbitControls for camera interaction
- Custom procedural animation system (no animation clips)
- WebGL GPU timer queries for render profiling

All 50 included `.glb` models are Roblox avatar assets converted from FBX.

## Requirements

- A modern browser with WebGL2 support (Chrome, Firefox, Edge, Safari)
- Internet connection (Three.js is loaded from CDN)
- Any HTTP server to serve the files

## Build Tool (Optional)

`convert_assets.py` is the script that was used to convert the original FBX source files to GLB and generate `manifest.json`. You don't need to run it — the converted models are already included.

If you do want to regenerate from FBX sources, it requires:
- Python 3.9+
- [assimp](https://github.com/assimp/assimp) CLI tool (`brew install assimp` on macOS)
- Source FBX files (not included in this repo)

## License

MIT

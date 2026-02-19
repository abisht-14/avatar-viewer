#!/usr/bin/env python3
"""
Batch FBX→GLB converter + manifest generator for the avatar 3D viewer.
Converts all FBX files from /Users/Abisht/Documents/repo/avatar/ into GLB,
categorizes them, and merges pre-computed performance metrics.
"""

import subprocess
import os
import re
import json
from pathlib import Path

AVATAR_DIR = Path("/Users/Abisht/Documents/repo/avatar")
OUTPUT_DIR = Path(__file__).parent
MODELS_DIR = OUTPUT_DIR / "models"
ASSIMP = "/opt/homebrew/bin/assimp"

# Pre-computed analysis files
RIGS_JSON = Path("/Users/Abisht/Documents/repo/Trading2.0/avatar_rigs_analysis.json")
CLOTHING_JSON = Path("/Users/Abisht/Documents/repo/Trading2.0/layered_clothing_analysis.json")

# Skip these paths (duplicates of LayeredClothing examples)
SKIP_PREFIXES = ["cage_deformer/layered_clothing"]


def categorize(fbx_path: Path) -> str:
    """Categorize an FBX file by its relative path under the avatar dir."""
    rel = fbx_path.relative_to(AVATAR_DIR).as_posix().lower()
    if rel.startswith("rigs/"):
        return "rigs"
    if rel.startswith("cage_deformer/cube/"):
        return "cage_deformers"
    return "clothing"


def should_skip(fbx_path: Path) -> bool:
    """Check if file should be skipped."""
    rel = fbx_path.relative_to(AVATAR_DIR).as_posix().lower()
    return any(rel.startswith(prefix) for prefix in SKIP_PREFIXES)


def convert_fbx_to_glb(fbx_path: Path, glb_path: Path) -> bool:
    """Convert FBX to GLB using assimp export."""
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [ASSIMP, "export", str(fbx_path), str(glb_path)],
            capture_output=True, text=True, timeout=30
        )
        return result.returncode == 0
    except Exception as e:
        print(f"  ERROR converting {fbx_path.name}: {e}")
        return False


def count_real_joints(fbx_path: Path) -> int:
    """Count real skeleton joints by dumping the scene and filtering out AssimpFbx helper nodes."""
    try:
        result = subprocess.run(
            [ASSIMP, "dump", str(fbx_path), "/dev/stdout", "-s"],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return -1
        # Extract all node names, filter out AssimpFbx decomposition helpers,
        # _Geo mesh nodes, _Att attachment points, RootNode, and texture paths
        all_names = set(re.findall(r'<Node name="([^"]+)"', result.stdout))
        real_joints = set()
        for name in all_names:
            if "AssimpFbx" in name:
                continue
            if name in ("RootNode",):
                continue
            if name.endswith("_Geo"):
                continue
            if name.endswith("_Att"):
                continue
            # Skip texture paths
            if "/" in name or "\\" in name:
                continue
            if name == "Texture":
                continue
            real_joints.add(name)
        return len(real_joints)
    except Exception:
        return -1


def parse_assimp_info(output: str) -> dict:
    """Parse assimp info output into metrics dict (reused from avatar_analyzer_v2.py)."""
    metrics = {
        "total_vertices": 0, "total_faces": 0, "mesh_count": 0,
        "node_count": 0, "max_depth": 0, "material_count": 0,
        "texture_count": 0, "memory_bytes": 0,
        "vertex_buffer_kb": 0, "index_buffer_kb": 0,
        "bone_matrices_kb": 0, "total_gpu_memory_kb": 0,
        "meshes": [], "warnings": []
    }
    patterns = {
        "memory_bytes": r"Memory consumption:\s*(\d+)",
        "node_count": r"Nodes:\s*(\d+)",
        "max_depth": r"Maximum depth\s*(\d+)",
        "mesh_count": r"Meshes:\s*(\d+)",
        "material_count": r"Materials:\s*(\d+)",
        "texture_count": r"Textures \(embed\.\):\s*(\d+)",
        "total_vertices": r"Vertices:\s*(\d+)",
        "total_faces": r"Faces:\s*(\d+)",
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, output)
        if match:
            metrics[key] = int(match.group(1))

    # Mesh breakdown
    mesh_section = re.search(r"Meshes:.*?\n(.*?)(?=Named Materials:|$)", output, re.DOTALL)
    if mesh_section:
        for line in mesh_section.group(1).strip().split("\n"):
            m = re.match(r"\s*\d+\s+\(([^)]+)\):\s*\[(\d+)\s*/\s*(\d+)\s*/\s*(\d+)\s*\|", line)
            if m:
                metrics["meshes"].append({
                    "name": m.group(1),
                    "vertices": int(m.group(2)),
                    "bones": int(m.group(3)),
                    "faces": int(m.group(4))
                })

    # GPU memory estimates
    vb = metrics["total_vertices"] * 64
    ib = metrics["total_faces"] * 3 * 4
    bm = metrics["node_count"] * 64
    metrics["vertex_buffer_kb"] = round(vb / 1024, 2)
    metrics["index_buffer_kb"] = round(ib / 1024, 2)
    metrics["bone_matrices_kb"] = round(bm / 1024, 2)
    metrics["total_gpu_memory_kb"] = round((vb + ib + bm) / 1024, 2)

    # Warnings (note: bone/joint warnings are deferred until real_joint_count is known)
    if metrics["total_faces"] > 15000:
        metrics["warnings"].append(f"HIGH TRIANGLE COUNT: {metrics['total_faces']:,} (budget: 15,000)")
    if metrics["total_vertices"] > 20000:
        metrics["warnings"].append(f"HIGH VERTEX COUNT: {metrics['total_vertices']:,} (budget: 20,000)")
    if metrics["material_count"] > 5:
        metrics["warnings"].append(f"MANY MATERIALS: {metrics['material_count']} (budget: 5)")
    if metrics["mesh_count"] > 20:
        metrics["warnings"].append(f"MANY MESHES: {metrics['mesh_count']} (may cause draw call overhead)")

    return metrics


def analyze_fbx(fbx_path: Path) -> dict:
    """Run assimp info on a file and parse the output."""
    try:
        result = subprocess.run(
            [ASSIMP, "info", str(fbx_path)],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return {"error": result.stderr.strip()}
        metrics = parse_assimp_info(result.stdout)
        metrics["real_joint_count"] = count_real_joints(fbx_path)
        return metrics
    except Exception as e:
        return {"error": str(e)}


def load_precomputed() -> dict:
    """Load pre-computed metrics, keyed by file_name."""
    lookup = {}
    for json_path in [RIGS_JSON, CLOTHING_JSON]:
        if json_path.exists():
            data = json.loads(json_path.read_text())
            for entry in data:
                lookup[entry["file_name"]] = entry
    return lookup


def make_display_name(file_name: str) -> str:
    """Turn file_name into a readable display name."""
    name = Path(file_name).stem
    # Remove common prefixes
    for prefix in ["LCL_", "LC_"]:
        if name.startswith(prefix):
            name = name[len(prefix):]
    # Replace underscores with spaces
    name = name.replace("_", " ")
    return name


def main():
    precomputed = load_precomputed()
    print(f"Loaded {len(precomputed)} pre-computed entries")

    # Collect all FBX files
    fbx_files = []
    for ext in ["*.fbx", "*.FBX"]:
        fbx_files.extend(AVATAR_DIR.rglob(ext))

    # Deduplicate (case-insensitive glob may double-count on macOS)
    seen = set()
    unique_fbx = []
    for f in sorted(fbx_files):
        if f.resolve() not in seen:
            seen.add(f.resolve())
            unique_fbx.append(f)

    print(f"Found {len(unique_fbx)} FBX files")

    manifest = {"rigs": [], "clothing": [], "cage_deformers": []}
    converted = 0
    skipped = 0

    for fbx_path in unique_fbx:
        if should_skip(fbx_path):
            skipped += 1
            continue

        category = categorize(fbx_path)
        stem = fbx_path.stem
        glb_rel = f"models/{category}/{stem}.glb"
        glb_path = OUTPUT_DIR / glb_rel

        # Convert
        print(f"  [{category:>15}] {fbx_path.name} → {stem}.glb ...", end=" ", flush=True)
        if convert_fbx_to_glb(fbx_path, glb_path):
            converted += 1
            print("OK")
        else:
            print("FAILED (skipping)")
            continue

        # Get metrics: pre-computed or fresh analysis
        fname = fbx_path.name
        if fname in precomputed:
            metrics = precomputed[fname]
        else:
            print(f"    Running assimp info for {fname}...")
            metrics = analyze_fbx(fbx_path)

        # Always count real joints from the FBX hierarchy
        real_joints = metrics.get("real_joint_count", -1)
        if real_joints < 0:
            real_joints = count_real_joints(fbx_path)

        # Rebuild warnings with correct joint count
        warnings = [w for w in metrics.get("warnings", [])
                     if "BONE COUNT" not in w]
        if real_joints > 75:
            warnings.append(f"HIGH JOINT COUNT: {real_joints} (budget: 75)")

        node_count = metrics.get("node_count", 0)

        entry = {
            "id": stem,
            "name": make_display_name(fname),
            "file": glb_rel,
            "category": category,
            "file_size_mb": round(metrics.get("file_size_mb", 0), 2),
            "total_vertices": metrics.get("total_vertices", 0),
            "total_faces": metrics.get("total_faces", 0),
            "mesh_count": metrics.get("mesh_count", 0),
            "node_count": node_count,
            "real_joint_count": real_joints,
            "max_depth": metrics.get("max_depth", 0),
            "material_count": metrics.get("material_count", 0),
            "texture_count": metrics.get("texture_count", 0),
            "total_gpu_memory_kb": round(metrics.get("total_gpu_memory_kb", 0), 1),
            "vertex_buffer_kb": round(metrics.get("vertex_buffer_kb", 0), 1),
            "index_buffer_kb": round(metrics.get("index_buffer_kb", 0), 1),
            "bone_matrices_kb": round(metrics.get("bone_matrices_kb", 0), 1),
            "meshes": metrics.get("meshes", []),
            "warnings": warnings,
        }

        manifest[category].append(entry)

    # Sort each category by name
    for cat in manifest:
        manifest[cat].sort(key=lambda x: x["name"])

    # Write manifest
    manifest_path = OUTPUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))

    total = sum(len(v) for v in manifest.values())
    print(f"\nDone! Converted {converted} files, skipped {skipped} duplicates")
    print(f"Manifest: {total} models ({len(manifest['rigs'])} rigs, "
          f"{len(manifest['clothing'])} clothing, {len(manifest['cage_deformers'])} cage deformers)")
    print(f"Output: {manifest_path}")


if __name__ == "__main__":
    main()

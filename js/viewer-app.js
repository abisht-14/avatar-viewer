import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getManifest } from './services/backend-api.js';

// ─── Three.js Setup ───
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x1a1a2e);
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(2, 1.5, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.8, 0);
controls.update();

// Grid
const grid = new THREE.GridHelper(10, 20, 0x2a2a4a, 0x1e1e38);
scene.add(grid);

// Lights: 3-point
const ambient = new THREE.AmbientLight(0x404060, 0.6);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x8888cc, 0.4);
fillLight.position.set(-3, 2, -2);
scene.add(fillLight);
const hemi = new THREE.HemisphereLight(0x6666aa, 0x222244, 0.5);
scene.add(hemi);

// Resize
function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// Forward-declare so animate() and animation functions can reference it
let currentModel = null;
let cachedGltf = null;

// ─── Visibility Overlay ───
let visibilityOverlayEnabled = false;

// Visibility heatmap shader: colors triangles by how much they face the camera
// Orange = facing camera directly, dark blue = grazing/edge-on angle
const visHeatmapVertSrc = `
  varying vec3 vNormalView;
  void main() {
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const visHeatmapSkinnedVertSrc = `
  #include <skinning_pars_vertex>
  varying vec3 vNormalView;
  void main() {
    #include <skinbase_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    #include <project_vertex>

    // Transform normal with skinning
    vec3 objectNormal = normal;
    #ifdef USE_SKINNING
      mat4 skinMatrix = bindMatrix * (
        skinWeight.x * boneMatX +
        skinWeight.y * boneMatY +
        skinWeight.z * boneMatZ +
        skinWeight.w * boneMatW
      ) * bindMatrixInverse;
      objectNormal = (skinMatrix * vec4(objectNormal, 0.0)).xyz;
    #endif
    vNormalView = normalize(normalMatrix * objectNormal);
  }
`;
const visHeatmapFragSrc = `
  varying vec3 vNormalView;
  void main() {
    // dot with view direction (0,0,1 in view space = toward camera)
    float facing = dot(normalize(vNormalView), vec3(0.0, 0.0, 1.0));
    facing = clamp(facing, 0.0, 1.0);

    // Color ramp: dark blue (grazing) -> orange (facing camera)
    vec3 orange = vec3(0.93, 0.53, 0.20);
    vec3 darkBlue = vec3(0.12, 0.12, 0.22);
    vec3 color = mix(darkBlue, orange, facing);
    gl_FragColor = vec4(color, 1.0);
  }
`;
const visHeatmapMaterial = new THREE.ShaderMaterial({
  side: THREE.FrontSide,
  vertexShader: visHeatmapVertSrc,
  fragmentShader: visHeatmapFragSrc
});
const visHeatmapSkinnedMaterial = new THREE.ShaderMaterial({
  side: THREE.FrontSide,
  vertexShader: visHeatmapSkinnedVertSrc,
  fragmentShader: visHeatmapFragSrc
});

let savedMaterials = new Map();

function enableVisibilityOverlay() {
  if (!currentModel) return;
  savedMaterials.clear();
  const models = [currentModel, ...stressClones];
  for (const mdl of models) {
    mdl.traverse(child => {
      if (!child.isMesh) return;
      savedMaterials.set(child, child.material);
      child.material = child.isSkinnedMesh ? visHeatmapSkinnedMaterial : visHeatmapMaterial;
    });
  }
}

function disableVisibilityOverlay() {
  for (const [mesh, mat] of savedMaterials) {
    mesh.material = mat;
  }
  savedMaterials.clear();
}

// ─── Mode System ───
let currentMode = 'inspector'; // 'inspector' | 'stress' | 'budget' | 'report'

// ─── Stress Test State ───
let stressClones = [];
let stressAnimEnabled = true;
let stressCloneBones = []; // array of {bones, restPoses} per clone
const fpsHistory = [];
const scalingSnapshots = [];
let lastStressCount = 1;

// ─── LOD Preview State ───
let lodActive = false;
let lodRenderers = [];
let lodScenes = [];
let lodCameras = [];
let lodModels = [];
let lodControls = [];
let lodSyncEnabled = false;
let lodSyncing = false;
let lodAnimFrame = null;

// ─── Procedural Animation System ───
const animClock = new THREE.Clock();
let animState = 'none'; // 'none' | 'idle' | 'run' | 'jump'
const animBones = {};    // name -> Object3D
const restPoses = {};    // name -> { x, y, z } euler angles
let jumpPhase = 'none';  // 'crouch' | 'launch' | 'airborne' | 'land' | 'none'
let jumpTimer = 0;
let modelRestY = 0;

const R15_BONE_NAMES = [
  'HumanoidRootPart', 'LowerTorso', 'UpperTorso', 'Head',
  'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot'
];

function discoverBones(model) {
  // Clear previous
  for (const k in animBones) delete animBones[k];
  for (const k in restPoses) delete restPoses[k];

  const boneSet = new Set(R15_BONE_NAMES);
  model.traverse(node => {
    if (!node.name) return;
    // Skip geometry, attachment, and Assimp helper nodes
    if (node.name.includes('_Geo') || node.name.includes('_Att') || node.name.includes('AssimpFbx')) return;
    if (boneSet.has(node.name) && !animBones[node.name]) {
      animBones[node.name] = node;
      restPoses[node.name] = { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z };
    }
  });
  const found = Object.keys(animBones);
  console.log(`Discovered bones: ${found.length}`, found);
}

function resetToRestPose() {
  for (const name in animBones) {
    const bone = animBones[name];
    const rest = restPoses[name];
    if (bone && rest) {
      bone.rotation.x = rest.x;
      bone.rotation.y = rest.y;
      bone.rotation.z = rest.z;
    }
  }
  if (currentModel) {
    currentModel.position.y = modelRestY;
  }
  jumpPhase = 'none';
  jumpTimer = 0;
}

function updateIdleAnimation(elapsed) {
  const b = animBones;
  const r = restPoses;
  if (!b.UpperTorso) return;

  // Breathing: subtle chest expansion on X axis
  if (b.UpperTorso && r.UpperTorso) {
    b.UpperTorso.rotation.x = r.UpperTorso.x + Math.sin(elapsed * 1.2 * Math.PI * 2) * 0.015;
  }
  // Gentle sway on LowerTorso Z
  if (b.LowerTorso && r.LowerTorso) {
    b.LowerTorso.rotation.z = r.LowerTorso.z + Math.sin(elapsed * 0.3 * Math.PI * 2) * 0.01;
  }
  // Slight head drift Y
  if (b.Head && r.Head) {
    b.Head.rotation.y = r.Head.y + Math.sin(elapsed * 0.5 * Math.PI * 2) * 0.02;
    b.Head.rotation.x = r.Head.x + Math.sin(elapsed * 0.7 * Math.PI * 2) * 0.008;
  }
  // Arms relax slightly
  if (b.LeftUpperArm && r.LeftUpperArm) {
    b.LeftUpperArm.rotation.z = r.LeftUpperArm.z + Math.sin(elapsed * 0.4 * Math.PI * 2) * 0.01;
  }
  if (b.RightUpperArm && r.RightUpperArm) {
    b.RightUpperArm.rotation.z = r.RightUpperArm.z - Math.sin(elapsed * 0.4 * Math.PI * 2) * 0.01;
  }
}

function updateRunAnimation(elapsed) {
  const b = animBones;
  const r = restPoses;
  if (!b.LeftUpperArm) return;

  const freq = 2.5; // Hz
  const t = elapsed * freq * Math.PI * 2;
  const sinT = Math.sin(t);
  const cosT = Math.cos(t);

  // Contralateral arm/leg swing
  // Upper arms swing forward/back (X rotation)
  if (b.LeftUpperArm && r.LeftUpperArm) {
    b.LeftUpperArm.rotation.x = r.LeftUpperArm.x + sinT * 0.6;
  }
  if (b.RightUpperArm && r.RightUpperArm) {
    b.RightUpperArm.rotation.x = r.RightUpperArm.x - sinT * 0.6;
  }
  // Elbows bend on forward swing (only when arm is forward)
  if (b.LeftLowerArm && r.LeftLowerArm) {
    b.LeftLowerArm.rotation.x = r.LeftLowerArm.x - Math.max(0, sinT) * 0.5;
  }
  if (b.RightLowerArm && r.RightLowerArm) {
    b.RightLowerArm.rotation.x = r.RightLowerArm.x - Math.max(0, -sinT) * 0.5;
  }

  // Upper legs swing opposite to arms
  if (b.LeftUpperLeg && r.LeftUpperLeg) {
    b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - sinT * 0.7;
  }
  if (b.RightUpperLeg && r.RightUpperLeg) {
    b.RightUpperLeg.rotation.x = r.RightUpperLeg.x + sinT * 0.7;
  }
  // Knees bend on back swing
  if (b.LeftLowerLeg && r.LeftLowerLeg) {
    b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + Math.max(0, sinT) * 0.8;
  }
  if (b.RightLowerLeg && r.RightLowerLeg) {
    b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + Math.max(0, -sinT) * 0.8;
  }

  // Torso lean forward + twist
  if (b.UpperTorso && r.UpperTorso) {
    b.UpperTorso.rotation.x = r.UpperTorso.x + 0.08;
    b.UpperTorso.rotation.y = r.UpperTorso.y + sinT * 0.04;
  }
  if (b.LowerTorso && r.LowerTorso) {
    b.LowerTorso.rotation.y = r.LowerTorso.y - sinT * 0.03;
  }

  // Head stays relatively stable, slight counter-rotation
  if (b.Head && r.Head) {
    b.Head.rotation.y = r.Head.y - sinT * 0.03;
  }

  // Vertical bob on model position
  if (currentModel) {
    currentModel.position.y = modelRestY + Math.abs(Math.sin(t)) * 0.03;
  }
}

function updateJumpAnimation(delta) {
  const b = animBones;
  const r = restPoses;
  if (!b.LeftUpperArm) return;

  jumpTimer += delta;

  if (jumpPhase === 'crouch') {
    // 0.25s — squat down, arms back
    const t = Math.min(jumpTimer / 0.25, 1);
    const ease = t * t; // ease-in

    if (b.LeftUpperLeg && r.LeftUpperLeg)
      b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - ease * 0.5;
    if (b.RightUpperLeg && r.RightUpperLeg)
      b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - ease * 0.5;
    if (b.LeftLowerLeg && r.LeftLowerLeg)
      b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + ease * 0.7;
    if (b.RightLowerLeg && r.RightLowerLeg)
      b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + ease * 0.7;
    if (b.LeftUpperArm && r.LeftUpperArm)
      b.LeftUpperArm.rotation.x = r.LeftUpperArm.x + ease * 0.4;
    if (b.RightUpperArm && r.RightUpperArm)
      b.RightUpperArm.rotation.x = r.RightUpperArm.x + ease * 0.4;
    if (b.UpperTorso && r.UpperTorso)
      b.UpperTorso.rotation.x = r.UpperTorso.x + ease * 0.1;
    if (currentModel)
      currentModel.position.y = modelRestY - ease * 0.08;

    if (jumpTimer >= 0.25) { jumpPhase = 'launch'; jumpTimer = 0; }

  } else if (jumpPhase === 'launch') {
    // 0.15s — straighten + rise
    const t = Math.min(jumpTimer / 0.15, 1);
    const ease = 1 - (1 - t) * (1 - t); // ease-out

    if (b.LeftUpperLeg && r.LeftUpperLeg)
      b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - 0.5 * (1 - ease);
    if (b.RightUpperLeg && r.RightUpperLeg)
      b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - 0.5 * (1 - ease);
    if (b.LeftLowerLeg && r.LeftLowerLeg)
      b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + 0.7 * (1 - ease);
    if (b.RightLowerLeg && r.RightLowerLeg)
      b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + 0.7 * (1 - ease);
    if (b.LeftUpperArm && r.LeftUpperArm)
      b.LeftUpperArm.rotation.x = r.LeftUpperArm.x - ease * 0.5;
    if (b.RightUpperArm && r.RightUpperArm)
      b.RightUpperArm.rotation.x = r.RightUpperArm.x - ease * 0.5;
    if (b.UpperTorso && r.UpperTorso)
      b.UpperTorso.rotation.x = r.UpperTorso.x + 0.1 * (1 - ease);
    if (currentModel)
      currentModel.position.y = modelRestY - 0.08 + ease * 0.08 + ease * 0.15;

    if (jumpTimer >= 0.15) { jumpPhase = 'airborne'; jumpTimer = 0; }

  } else if (jumpPhase === 'airborne') {
    // 0.5s — parabolic arc, tucked pose
    const t = Math.min(jumpTimer / 0.5, 1);
    // Parabolic height: peaks at t=0.5
    const height = 0.15 + 0.35 * (4 * t * (1 - t));

    if (b.LeftUpperLeg && r.LeftUpperLeg)
      b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - 0.3;
    if (b.RightUpperLeg && r.RightUpperLeg)
      b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - 0.3;
    if (b.LeftLowerLeg && r.LeftLowerLeg)
      b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + 0.4;
    if (b.RightLowerLeg && r.RightLowerLeg)
      b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + 0.4;
    if (b.LeftUpperArm && r.LeftUpperArm)
      b.LeftUpperArm.rotation.x = r.LeftUpperArm.x - 0.5;
    if (b.RightUpperArm && r.RightUpperArm)
      b.RightUpperArm.rotation.x = r.RightUpperArm.x - 0.5;
    if (b.LeftUpperArm && r.LeftUpperArm)
      b.LeftUpperArm.rotation.z = r.LeftUpperArm.z - 0.3;
    if (b.RightUpperArm && r.RightUpperArm)
      b.RightUpperArm.rotation.z = r.RightUpperArm.z + 0.3;
    if (b.Head && r.Head)
      b.Head.rotation.x = r.Head.x - 0.1;
    if (currentModel)
      currentModel.position.y = modelRestY + height;

    if (jumpTimer >= 0.5) { jumpPhase = 'land'; jumpTimer = 0; }

  } else if (jumpPhase === 'land') {
    // 0.3s — impact squat + recovery
    const t = Math.min(jumpTimer / 0.3, 1);
    // Impact squat peaks at t=0.3, then recovers
    const impact = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    const ease = t * t * (3 - 2 * t); // smoothstep for recovery

    if (b.LeftUpperLeg && r.LeftUpperLeg)
      b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - impact * 0.4 * (1 - ease);
    if (b.RightUpperLeg && r.RightUpperLeg)
      b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - impact * 0.4 * (1 - ease);
    if (b.LeftLowerLeg && r.LeftLowerLeg)
      b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + impact * 0.5 * (1 - ease);
    if (b.RightLowerLeg && r.RightLowerLeg)
      b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + impact * 0.5 * (1 - ease);
    if (b.LeftUpperArm && r.LeftUpperArm) {
      b.LeftUpperArm.rotation.x = r.LeftUpperArm.x + impact * 0.2 * (1 - ease);
      b.LeftUpperArm.rotation.z = r.LeftUpperArm.z - 0.3 * (1 - ease);
    }
    if (b.RightUpperArm && r.RightUpperArm) {
      b.RightUpperArm.rotation.x = r.RightUpperArm.x + impact * 0.2 * (1 - ease);
      b.RightUpperArm.rotation.z = r.RightUpperArm.z + 0.3 * (1 - ease);
    }
    if (b.UpperTorso && r.UpperTorso)
      b.UpperTorso.rotation.x = r.UpperTorso.x + impact * 0.08 * (1 - ease);
    if (currentModel)
      currentModel.position.y = modelRestY - impact * 0.06 * (1 - ease);

    if (jumpTimer >= 0.3) {
      // Auto-transition to idle
      resetToRestPose();
      animState = 'idle';
      // Update toolbar buttons
      document.querySelectorAll('.anim-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.anim === 'idle');
      });
      animClock.start();
    }
  }
}

function updateProceduralAnimation(elapsed, delta) {
  if (animState === 'none') return;
  if (Object.keys(animBones).length === 0) return;

  if (animState === 'idle') {
    updateIdleAnimation(elapsed);
  } else if (animState === 'run') {
    updateRunAnimation(elapsed);
  } else if (animState === 'jump') {
    updateJumpAnimation(delta);
  }
}

// ─── GPU Timer Query ───
const gl = renderer.getContext();
let timerExt = null;
let gpuTimerAvailable = false;
try {
  timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  gpuTimerAvailable = !!timerExt;
} catch(e) { console.warn('GPU timer init failed:', e); }
let gpuQuery = null;
let gpuTimeMs = -1; // -1 = unavailable
let pendingGpuQuery = false;

function beginGpuTimer() {
  if (!gpuTimerAvailable || pendingGpuQuery) return;
  try {
    gpuQuery = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQuery);
  } catch (e) {
    gpuTimerAvailable = false;
  }
}

function endGpuTimer() {
  if (!gpuTimerAvailable || !gpuQuery) return;
  try {
    gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    pendingGpuQuery = true;
  } catch (e) {
    gpuTimerAvailable = false;
  }
}

function pollGpuTimer() {
  if (!pendingGpuQuery || !gpuQuery) return;
  const available = gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT_AVAILABLE);
  const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
  if (available && !disjoint) {
    const ns = gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT);
    gpuTimeMs = ns / 1e6; // nanoseconds to ms
  }
  if (available || disjoint) {
    gl.deleteQuery(gpuQuery);
    gpuQuery = null;
    pendingGpuQuery = false;
  }
}

// ─── Live Render Stats ───
let frameCount = 0;
let fps = 0;
let frameTime = 0;
let cpuRenderMs = 0;
const FPS_SAMPLE_INTERVAL = 500;
let lastFpsUpdate = 0;
const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _edge1 = new THREE.Vector3(), _edge2 = new THREE.Vector3(), _faceNormal = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();

function countVisibleGeometry() {
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);
  camera.getWorldDirection(_camDir);

  let gpuVerts = 0, gpuTris = 0, frontTris = 0, visMeshes = 0, totalMeshes = 0;
  const modelsToCount = currentModel ? [currentModel, ...stressClones] : [];
  for (const mdl of modelsToCount) {
    mdl.traverse(child => {
      if (!child.isMesh) return;
      totalMeshes++;
      if (!child.geometry.boundingSphere) child.geometry.computeBoundingSphere();
      const sphere = child.geometry.boundingSphere.clone();
      sphere.applyMatrix4(child.matrixWorld);
      if (!frustum.intersectsSphere(sphere)) return;

      visMeshes++;
      const pos = child.geometry.getAttribute('position');
      if (!pos) return;
      gpuVerts += pos.count;
      const idx = child.geometry.index;
      const triCount = idx ? idx.count / 3 : pos.count / 3;
      gpuTris += triCount;

      // Backface culling estimate: check each triangle's normal vs camera direction
      _normalMatrix.getNormalMatrix(child.matrixWorld);

      for (let i = 0; i < triCount; i++) {
        let i0, i1, i2;
        if (idx) {
          i0 = idx.getX(i * 3);
          i1 = idx.getX(i * 3 + 1);
          i2 = idx.getX(i * 3 + 2);
        } else {
          i0 = i * 3; i1 = i * 3 + 1; i2 = i * 3 + 2;
        }
        _v0.fromBufferAttribute(pos, i0);
        _v1.fromBufferAttribute(pos, i1);
        _v2.fromBufferAttribute(pos, i2);
        _edge1.subVectors(_v1, _v0);
        _edge2.subVectors(_v2, _v0);
        _faceNormal.crossVectors(_edge1, _edge2);
        _faceNormal.applyMatrix3(_normalMatrix);
        // Front-facing if normal points toward camera (dot < 0 in view space)
        if (_faceNormal.dot(_camDir) <= 0) frontTris++;
      }
    });
  }
  return { gpuVerts, gpuTris: Math.round(gpuTris), frontTris: Math.round(frontTris), visMeshes, totalMeshes };
}

function countSceneLights() {
  let directional = 0, point = 0, spot = 0, ambient = 0, hemi = 0;
  scene.traverse(child => {
    if (child.isDirectionalLight) directional++;
    else if (child.isPointLight) point++;
    else if (child.isSpotLight) spot++;
    else if (child.isAmbientLight) ambient++;
    else if (child.isHemisphereLight) hemi++;
  });
  return { directional, point, spot, ambient, hemi, total: directional + point + spot + ambient + hemi };
}

function getModelMaterialTypes() {
  const types = new Set();
  if (currentModel) {
    currentModel.traverse(child => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => types.add(m.type));
    });
  }
  return [...types];
}

function updateRenderStats(now) {
  frameCount++;
  const elapsed = now - lastFpsUpdate;
  if (elapsed >= FPS_SAMPLE_INTERVAL) {
    fps = Math.round((frameCount * 1000) / elapsed);
    frameTime = (elapsed / frameCount).toFixed(1);
    frameCount = 0;
    lastFpsUpdate = now;

    pollGpuTimer();

    const info = renderer.info;
    const { gpuVerts, gpuTris, frontTris, visMeshes, totalMeshes } = countVisibleGeometry();
    const backfacePct = gpuTris > 0 ? Math.round((1 - frontTris / gpuTris) * 100) : 0;

    // Front-facing (visible) triangles — changes with rotation
    const ftEl = document.getElementById('rs-front-tris');
    ftEl.querySelector('.value').textContent = frontTris.toLocaleString();
    ftEl.className = 'render-stat' + (frontTris > 15000 ? ' bad' : frontTris > 8000 ? ' warn' : '');
    document.getElementById('rs-front-sub').textContent =
      `${backfacePct}% backface culled`;

    // Submitted to GPU (before backface cull)
    const stEl = document.getElementById('rs-submitted-tris');
    stEl.querySelector('.value').textContent = gpuTris.toLocaleString();
    stEl.className = 'render-stat' + (gpuTris > 15000 ? ' bad' : gpuTris > 8000 ? ' warn' : '');
    document.getElementById('rs-submitted-sub').textContent =
      `${gpuVerts.toLocaleString()} vertices`;

    // Visible meshes
    const vmEl = document.getElementById('rs-visible-meshes');
    vmEl.querySelector('.value').innerHTML = `${visMeshes} <span class="frac">/ ${totalMeshes}</span>`;

    // Draw calls
    const dcEl = document.getElementById('rs-drawcalls');
    dcEl.querySelector('.value').textContent = info.render.calls;
    dcEl.className = 'render-stat' + (info.render.calls > 50 ? ' bad' : info.render.calls > 20 ? ' warn' : '');

    // CPU render time
    const cpuEl = document.getElementById('rs-cpu-time');
    cpuEl.querySelector('.value').textContent = cpuRenderMs.toFixed(2) + ' ms';
    cpuEl.className = 'render-stat' + (cpuRenderMs > 8 ? ' bad' : cpuRenderMs > 4 ? ' warn' : '');

    // GPU render time
    const gpuEl = document.getElementById('rs-gpu-time');
    if (gpuTimerAvailable && gpuTimeMs >= 0) {
      gpuEl.querySelector('.value').textContent = gpuTimeMs.toFixed(2) + ' ms';
      gpuEl.className = 'render-stat' + (gpuTimeMs > 8 ? ' bad' : gpuTimeMs > 4 ? ' warn' : '');
    } else {
      gpuEl.querySelector('.value').textContent = 'N/A';
      gpuEl.className = 'render-stat na';
    }

    // FPS
    const fpsEl = document.getElementById('rs-fps');
    fpsEl.querySelector('.value').textContent = fps;
    fpsEl.className = 'render-stat' + (fps < 30 ? ' bad' : fps < 55 ? ' warn' : '');
    const fpsPct = Math.min(100, (fps / 60) * 100);
    const fpsFill = document.getElementById('fps-fill');
    fpsFill.style.width = fpsPct + '%';
    fpsFill.style.background = fps >= 55 ? '#44cc88' : fps >= 30 ? '#ddaa44' : '#ff5544';

    // Frame time
    const fmEl = document.getElementById('rs-frametime');
    fmEl.querySelector('.value').textContent = frameTime + ' ms';
    fmEl.className = 'render-stat' + (frameTime > 33 ? ' bad' : frameTime > 18 ? ' warn' : '');

    // Pipeline bar (frame budget visualization)
    const TARGET = 16.67; // 60fps target
    const cpuPct = Math.min(100, (cpuRenderMs / TARGET) * 100);
    const gpuPct = gpuTimeMs >= 0 ? Math.min(100 - cpuPct, (gpuTimeMs / TARGET) * 100) : 0;
    const idlePct = Math.max(0, 100 - cpuPct - gpuPct);
    document.getElementById('seg-cpu').style.width = cpuPct + '%';
    document.getElementById('seg-cpu').textContent = cpuPct > 10 ? cpuRenderMs.toFixed(1) + 'ms' : '';
    document.getElementById('seg-gpu').style.width = gpuPct + '%';
    document.getElementById('seg-gpu').textContent = gpuPct > 10 && gpuTimeMs >= 0 ? gpuTimeMs.toFixed(1) + 'ms' : '';
    document.getElementById('seg-idle').style.width = idlePct + '%';
    const usedPct = Math.round(cpuPct + gpuPct);
    document.getElementById('budget-pct').textContent = usedPct + '% of 16.7ms budget';

    // Shader & lighting
    const lights = countSceneLights();
    document.querySelector('#si-lights .value').textContent =
      `${lights.total} (${lights.directional}D ${lights.ambient}A ${lights.hemi}H)`;
    document.querySelector('#si-programs .value').textContent =
      info.programs ? info.programs.length : 0;
    const matTypes = getModelMaterialTypes();
    document.querySelector('#si-materials .value').textContent =
      matTypes.length > 0 ? matTypes.map(t => t.replace('Material', '')).join(', ') : '-';
    document.querySelector('#si-textures-gpu .value').textContent = info.memory.textures;

    // Notes
    const note = document.getElementById('rs-note');
    note.textContent = `Visible tris = front-facing after backface culling (changes with rotation). Submitted = sent to GPU after frustum culling (${visMeshes}/${totalMeshes} meshes). Asset verts (${currentEntry ? currentEntry.total_vertices.toLocaleString() : '-'}) < GPU verts (${gpuVerts.toLocaleString()}) due to hard-edge splitting.`;

    const pNote = document.getElementById('platform-note');
    if (!gpuTimerAvailable) {
      pNote.textContent = 'GPU timer unavailable (macOS disables EXT_disjoint_timer_query for security). Use Chrome on Windows/Linux for GPU latency.';
    } else {
      pNote.textContent = '';
    }
  }
}

// Animation loop
let cpuTotalMs = 0;
function animate() {
  requestAnimationFrame(animate);
  const frameStart = performance.now();
  controls.update();

  // Procedural animation update
  const animDelta = animClock.getDelta();
  const animElapsed = animClock.elapsedTime;
  updateProceduralAnimation(animElapsed, animDelta);

  // Stress test animation
  if (currentMode === 'stress' && stressAnimEnabled && stressClones.length > 0) {
    updateStressAnimation(animElapsed, animDelta);
  }

  // Measure CPU render time
  beginGpuTimer();
  const cpuStart = performance.now();
  renderer.render(scene, camera);
  cpuRenderMs = performance.now() - cpuStart;
  endGpuTimer();

  updateRenderStats(performance.now());

  // Update stress test live metrics
  if (currentMode === 'stress') {
    updateStressMetrics();
  }

  cpuTotalMs = performance.now() - frameStart;
}
animate();

// ─── GPU Info (one-time probe) ───
function populateGpuInfo() {
  // Unmasked renderer/vendor (requires WEBGL_debug_renderer_info)
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  if (debugInfo) {
    document.getElementById('gpu-renderer-name').textContent =
      gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    document.getElementById('gpu-vendor-name').textContent =
      gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
  } else {
    document.getElementById('gpu-renderer-name').textContent =
      gl.getParameter(gl.RENDERER);
    document.getElementById('gpu-vendor-name').textContent =
      gl.getParameter(gl.VENDOR);
  }

  // WebGL version
  const ver = gl.getParameter(gl.VERSION);
  document.getElementById('gc-webgl').textContent =
    ver.includes('2.0') ? '2.0' : ver.includes('1.0') ? '1.0' : ver;

  // Capabilities
  document.getElementById('gc-maxtex').textContent =
    gl.getParameter(gl.MAX_TEXTURE_SIZE).toLocaleString();
  document.getElementById('gc-vertunif').textContent =
    gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS);
  document.getElementById('gc-fragunif').textContent =
    gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
  document.getElementById('gc-attribs').textContent =
    gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
  document.getElementById('gc-varyings').textContent =
    gl.getParameter(gl.MAX_VARYING_VECTORS);
  const maxVp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  document.getElementById('gc-viewport').textContent =
    maxVp[0].toLocaleString() + 'x' + maxVp[1].toLocaleString();

  // Shader precision
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  document.getElementById('gc-precision').textContent =
    hp && hp.precision > 0 ? 'highp' : 'mediump';

  // Key extensions check
  const perfExtensions = [
    ['EXT_disjoint_timer_query_webgl2', 'GPU Timing'],
    ['WEBGL_debug_renderer_info', 'GPU Name'],
    ['EXT_texture_filter_anisotropic', 'Anisotropic'],
    ['OES_texture_float', 'Float Textures'],
    ['WEBGL_compressed_texture_s3tc', 'S3TC Compress'],
    ['EXT_color_buffer_float', 'Float Render'],
    ['OES_texture_half_float', 'Half Float'],
    ['WEBGL_lose_context', 'Context Loss'],
  ];

  const extEl = document.getElementById('gpu-ext-list');
  extEl.innerHTML = perfExtensions.map(([ext, label]) => {
    const available = gl.getExtension(ext) !== null;
    const cls = available ? 'ext-available' : 'ext-unavailable';
    const icon = available ? '\u2713' : '\u2717';
    return `<span class="${cls}">${icon} ${label}</span>`;
  }).join(' &nbsp; ');
}
try { populateGpuInfo(); } catch(e) { console.error('GPU info probe failed:', e); }

// ─── Model Management ───
const loader = new GLTFLoader();

function disposeModel() {
  if (!currentModel) return;
  savedMaterials.clear();
  currentModel.traverse(child => {
    if (child.isMesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose());
      } else if (child.material) {
        child.material.dispose();
      }
    }
  });
  scene.remove(currentModel);
  currentModel = null;

  // Clear animation state
  for (const k in animBones) delete animBones[k];
  for (const k in restPoses) delete restPoses[k];
  jumpPhase = 'none';
  jumpTimer = 0;
}

function loadModel(entry) {
  disposeModel();
  const loadingEl = document.getElementById('loading');
  loadingEl.classList.add('visible');

  loader.load(
    entry.file,
    (gltf) => {
      loadingEl.classList.remove('visible');
      cachedGltf = gltf;
      const model = gltf.scene;

      // Auto-center and scale to ~2 units tall
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 0 ? 2 / maxDim : 1;
      model.scale.setScalar(scale);

      // Recompute after scaling
      const box2 = new THREE.Box3().setFromObject(model);
      const center2 = box2.getCenter(new THREE.Vector3());
      const minY = box2.min.y;
      model.position.sub(center2);
      model.position.y -= minY;

      // Assign a default material to any mesh without one,
      // and hide cage/attachment development meshes
      model.traverse(child => {
        if (child.isMesh && !child.material) {
          child.material = new THREE.MeshStandardMaterial({ color: 0x8888cc });
        }
        if (child.isMesh && child.name &&
            (child.name.includes('Cage') || child.name.endsWith('_Att'))) {
          child.visible = false;
        }
      });

      scene.add(model);
      currentModel = model;

      // Reapply visibility overlay if active
      if (visibilityOverlayEnabled) {
        enableVisibilityOverlay();
      }

      // Discover bones for procedural animation
      discoverBones(model);
      modelRestY = model.position.y;
      animClock.start();

      // Reset camera
      controls.target.set(0, (box2.max.y - minY) * 0.4, 0);
      camera.position.set(2, 1.5, 3);
      controls.update();
    },
    undefined,
    (err) => {
      loadingEl.classList.remove('visible');
      console.error('Load error:', err);
    }
  );
}

// ─── UI ───
let manifest = null;
let activeItem = null;
let currentEntry = null;

function fmt(n) { return n.toLocaleString(); }

function thresholdClass(value, greenMax, yellowMax) {
  if (value <= greenMax) return 'green';
  if (value <= yellowMax) return 'yellow';
  return 'red';
}

function setMetricCard(id, value, colorClass) {
  const card = document.getElementById(id);
  card.querySelector('.value').textContent = typeof value === 'number' ? fmt(value) : value;
  card.className = 'metric-card ' + colorClass;
}

function updatePanel(entry) {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('panel-content').style.display = 'block';

  document.getElementById('model-title').textContent = entry.name;
  const catLabels = { rigs: 'Rig', clothing: 'Layered Clothing', cage_deformers: 'Cage Deformer' };
  document.getElementById('model-category').textContent = catLabels[entry.category] || entry.category;

  // Metric cards
  setMetricCard('mc-vertices', entry.total_vertices, thresholdClass(entry.total_vertices, 10000, 20000));
  setMetricCard('mc-faces', entry.total_faces, thresholdClass(entry.total_faces, 8000, 15000));
  setMetricCard('mc-meshes', entry.mesh_count, 'neutral');
  const joints = entry.real_joint_count >= 0 ? entry.real_joint_count : entry.node_count;
  setMetricCard('mc-joints', joints, thresholdClass(joints, 50, 75));
  setMetricCard('mc-materials', entry.material_count, 'neutral');
  setMetricCard('mc-textures', entry.texture_count, 'neutral');

  // GPU memory
  const gpuKB = entry.total_gpu_memory_kb;
  const gpuText = gpuKB > 1024 ? (gpuKB / 1024).toFixed(2) + ' MB' : gpuKB.toFixed(1) + ' KB';
  const gpuEl = document.getElementById('gpu-total');
  gpuEl.textContent = gpuText;
  // Color: <500KB green, 500-1000 yellow, >1000 red
  const gpuColor = gpuKB <= 500 ? '#44cc88' : gpuKB <= 1000 ? '#ddaa44' : '#ff5544';
  gpuEl.style.color = gpuColor;
  const fill = document.getElementById('gpu-fill');
  const pct = Math.min(100, (gpuKB / 1500) * 100);
  fill.style.width = pct + '%';
  fill.style.background = gpuColor;
  document.getElementById('gpu-vb').textContent = entry.vertex_buffer_kb.toFixed(1) + ' KB';
  document.getElementById('gpu-ib').textContent = entry.index_buffer_kb.toFixed(1) + ' KB';
  document.getElementById('gpu-bm').textContent = entry.bone_matrices_kb.toFixed(1) + ' KB';

  // Warnings
  const wBox = document.getElementById('warnings-box');
  const wList = document.getElementById('warnings-list');
  if (entry.warnings && entry.warnings.length > 0) {
    wBox.classList.add('visible');
    wList.innerHTML = entry.warnings.map(w => `<div class="warn-item">${w}</div>`).join('');
  } else {
    wBox.classList.remove('visible');
    wList.innerHTML = '';
  }

  // Mesh table (sortable)
  currentMeshes = [...(entry.meshes || [])];
  renderMeshTable('faces', true);
}

// ─── Sortable mesh table ───
let currentMeshes = [];
let meshSortKey = 'faces';
let meshSortDesc = true;

function renderMeshTable(sortKey, desc) {
  meshSortKey = sortKey;
  meshSortDesc = desc;
  const tbody = document.getElementById('mesh-tbody');
  const sorted = [...currentMeshes].sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'string') {
      return desc ? vb.localeCompare(va) : va.localeCompare(vb);
    }
    return desc ? vb - va : va - vb;
  });

  tbody.innerHTML = sorted.map(m =>
    `<tr><td title="${m.name}">${m.name}</td><td>${fmt(m.vertices)}</td><td>${fmt(m.faces)}</td><td>${m.bones}</td></tr>`
  ).join('');

  // Update header arrows
  document.querySelectorAll('#mesh-table th').forEach(th => {
    const key = th.dataset.key;
    const arrow = th.querySelector('.sort-arrow');
    if (key === sortKey) {
      th.classList.add('sorted');
      arrow.textContent = desc ? ' \u25BC' : ' \u25B2';
    } else {
      th.classList.remove('sorted');
      arrow.textContent = '';
    }
  });
}

// Attach click handlers to table headers
document.querySelectorAll('#mesh-table th').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    const desc = (key === meshSortKey) ? !meshSortDesc : (th.dataset.type === 'num');
    renderMeshTable(key, desc);
  });
});

function selectModel(entry, itemEl) {
  if (activeItem) activeItem.classList.remove('active');
  itemEl.classList.add('active');
  activeItem = itemEl;
  currentEntry = entry;
  loadModel(entry);
  updatePanel(entry);
  // Rebuild stress grid if in stress mode
  if (currentMode === 'stress') {
    setTimeout(() => buildStressGrid(lastStressCount), 500);
  }
}

function buildSidebar() {
  const list = document.getElementById('model-list');
  const categories = [
    { key: 'rigs', label: 'Rigs' },
    { key: 'clothing', label: 'Clothing' },
    { key: 'cage_deformers', label: 'Cage Deformers' },
  ];

  let firstItem = null;
  let firstEntry = null;

  for (const cat of categories) {
    const items = manifest[cat.key] || [];
    if (items.length === 0) continue;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `${cat.label} <span class="category-count">(${items.length})</span>`;
    list.appendChild(header);

    for (const entry of items) {
      const item = document.createElement('div');
      item.className = 'model-item';
      item.textContent = entry.name;
      if (entry.warnings && entry.warnings.length > 0) {
        const dot = document.createElement('span');
        dot.className = 'warning-dot';
        item.appendChild(dot);
      }
      item.addEventListener('click', () => selectModel(entry, item));
      list.appendChild(item);

      if (!firstItem) { firstItem = item; firstEntry = entry; }
    }
  }

  // Auto-load first rig
  if (firstItem && firstEntry) {
    selectModel(firstEntry, firstItem);
  }
}

// ─── Animation Toolbar ───
document.querySelectorAll('.anim-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const anim = btn.dataset.anim;

    // Handle LOD toggle separately
    if (anim === 'lod') {
      if (lodActive) {
        teardownLodPreview();
        btn.classList.remove('active');
      } else {
        setupLodPreview();
        btn.classList.add('active');
      }
      return;
    }

    // Update active button (only non-LOD buttons)
    document.querySelectorAll('.anim-btn:not([data-anim="lod"])').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Sync stress anim buttons
    document.querySelectorAll('.stress-anim-btn').forEach(b => b.classList.remove('active'));
    const stressBtn = document.querySelector(`.stress-anim-btn[data-anim="${anim}"]`);
    if (stressBtn) stressBtn.classList.add('active');

    resetToRestPose();
    animState = anim;
    animClock.start();

    if (anim === 'jump') {
      jumpPhase = 'crouch';
      jumpTimer = 0;
      for (const entry of stressCloneBones) { entry.jumpPhase = 'crouch'; entry.jumpTimer = 0; if (entry.model) entry.model.position.y = entry.restY; }
    }
  });
});

// ─── Stress Animation Buttons ───
document.querySelectorAll('.stress-anim-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const anim = btn.dataset.anim;
    // Update stress anim buttons
    document.querySelectorAll('.stress-anim-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Sync main toolbar buttons
    document.querySelectorAll('.anim-btn:not([data-anim="lod"])').forEach(b => b.classList.remove('active'));
    const mainBtn = document.querySelector(`.anim-btn[data-anim="${anim}"]`);
    if (mainBtn) mainBtn.classList.add('active');
    // Apply animation
    resetToRestPose();
    animState = anim;
    animClock.start();
    if (anim === 'jump') {
      jumpPhase = 'crouch';
      jumpTimer = 0;
      for (const entry of stressCloneBones) { entry.jumpPhase = 'crouch'; entry.jumpTimer = 0; if (entry.model) entry.model.position.y = entry.restY; }
    }
  });
});

// ─── Visibility Toggle ───
document.getElementById('visibility-toggle').addEventListener('click', () => {
  const btn = document.getElementById('visibility-toggle');
  visibilityOverlayEnabled = !visibilityOverlayEnabled;
  btn.classList.toggle('active', visibilityOverlayEnabled);
  if (visibilityOverlayEnabled) {
    enableVisibilityOverlay();
  } else {
    disableVisibilityOverlay();
  }
});

// ─── Mode Switching ───
function switchMode(mode) {
  currentMode = mode;
  document.body.className = 'mode-' + mode;
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));

  // Show/hide containers
  const budgetC = document.getElementById('budget-container');
  const reportC = document.getElementById('report-container');
  const stressC = document.getElementById('stress-controls');
  const panelContent = document.getElementById('panel-content');
  const emptyState = document.getElementById('empty-state');

  budgetC.style.display = mode === 'budget' ? 'block' : 'none';
  reportC.style.display = mode === 'report' ? 'block' : 'none';
  stressC.style.display = mode === 'stress' ? 'block' : 'none';

  if (mode === 'stress') {
    panelContent.style.display = 'none';
    emptyState.style.display = 'none';
    buildStressGrid(lastStressCount);
  } else {
    disposeStressGrid();
    if (currentEntry) {
      panelContent.style.display = mode === 'inspector' ? 'block' : 'none';
      emptyState.style.display = 'none';
    } else {
      emptyState.style.display = mode === 'inspector' ? 'block' : 'none';
    }
  }

  if (mode === 'budget') renderBudgetDashboard();
  if (mode === 'report') renderReportPanel();

  // Teardown LOD if leaving inspector
  if (mode !== 'inspector' && lodActive) {
    teardownLodPreview();
    document.getElementById('lod-toggle').classList.remove('active');
  }
}

document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

// ─── Stress Test System ───
function cloneModelForStress(sourceModel) {
  const clone = sourceModel.clone(true);
  // Deep clone materials so they don't share state
  clone.traverse(child => {
    if (child.isMesh) {
      if (Array.isArray(child.material)) {
        child.material = child.material.map(m => m.clone());
      } else if (child.material) {
        child.material = child.material.clone();
      }
    }
  });
  return clone;
}

function discoverBonesForClone(model) {
  const bones = {};
  const rests = {};
  const boneSet = new Set(R15_BONE_NAMES);
  model.traverse(node => {
    if (!node.name) return;
    if (node.name.includes('_Geo') || node.name.includes('_Att') || node.name.includes('AssimpFbx')) return;
    if (boneSet.has(node.name) && !bones[node.name]) {
      bones[node.name] = node;
      rests[node.name] = { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z };
    }
  });
  return { bones, rests };
}

function buildStressGrid(count) {
  disposeStressGrid();
  if (!currentModel || !cachedGltf) return;

  lastStressCount = count;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const spacing = 2.5;

  for (let i = 0; i < count; i++) {
    const clone = cloneModelForStress(currentModel);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const offsetX = (col - (cols - 1) / 2) * spacing;
    const offsetZ = (row - (rows - 1) / 2) * spacing;
    clone.position.x = currentModel.position.x + offsetX;
    clone.position.z = currentModel.position.z + offsetZ;
    clone.position.y = currentModel.position.y;
    clone.scale.copy(currentModel.scale);
    scene.add(clone);
    stressClones.push(clone);

    const boneData = discoverBonesForClone(clone);
    boneData.model = clone;
    boneData.restY = clone.position.y;
    boneData.jumpPhase = 'none';
    boneData.jumpTimer = 0;
    stressCloneBones.push(boneData);
  }

  // Zoom camera to fit grid
  const gridWidth = cols * spacing;
  const gridDepth = rows * spacing;
  const maxSpan = Math.max(gridWidth, gridDepth, 3);
  camera.position.set(maxSpan * 0.8, maxSpan * 0.6, maxSpan * 1.0);
  controls.target.set(0, 0.8, 0);
  controls.update();

  // Capture snapshot for scaling table
  captureStressSnapshot(count);

  // Update quick buttons
  document.querySelectorAll('.quick-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.count) === count);
  });
  document.getElementById('stress-slider').value = count;
  document.getElementById('stress-count-label').textContent = count;
}

function disposeStressGrid() {
  for (const clone of stressClones) {
    clone.traverse(child => {
      if (child.isMesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else if (child.material) child.material.dispose();
      }
    });
    scene.remove(clone);
  }
  stressClones = [];
  stressCloneBones = [];
}

function updateStressAnimation(elapsed, delta) {
  if (animState === 'none') return;
  let allJumpsDone = true;
  for (const entry of stressCloneBones) {
    const { bones: b, rests: r } = entry;
    if (Object.keys(b).length === 0) continue;
    if (animState === 'idle') {
      if (b.UpperTorso && r.UpperTorso)
        b.UpperTorso.rotation.x = r.UpperTorso.x + Math.sin(elapsed * 1.2 * Math.PI * 2) * 0.015;
      if (b.LowerTorso && r.LowerTorso)
        b.LowerTorso.rotation.z = r.LowerTorso.z + Math.sin(elapsed * 0.3 * Math.PI * 2) * 0.01;
      if (b.Head && r.Head) {
        b.Head.rotation.y = r.Head.y + Math.sin(elapsed * 0.5 * Math.PI * 2) * 0.02;
        b.Head.rotation.x = r.Head.x + Math.sin(elapsed * 0.7 * Math.PI * 2) * 0.008;
      }
    } else if (animState === 'run') {
      const t = elapsed * 2.5 * Math.PI * 2;
      const sinT = Math.sin(t);
      if (b.LeftUpperArm && r.LeftUpperArm) b.LeftUpperArm.rotation.x = r.LeftUpperArm.x + sinT * 0.6;
      if (b.RightUpperArm && r.RightUpperArm) b.RightUpperArm.rotation.x = r.RightUpperArm.x - sinT * 0.6;
      if (b.LeftUpperLeg && r.LeftUpperLeg) b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - sinT * 0.7;
      if (b.RightUpperLeg && r.RightUpperLeg) b.RightUpperLeg.rotation.x = r.RightUpperLeg.x + sinT * 0.7;
      if (b.LeftLowerLeg && r.LeftLowerLeg) b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + Math.max(0, sinT) * 0.8;
      if (b.RightLowerLeg && r.RightLowerLeg) b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + Math.max(0, -sinT) * 0.8;
    } else if (animState === 'jump') {
      if (entry.jumpPhase === 'done') continue;
      entry.jumpTimer += delta;
      const m = entry.model;
      const ry = entry.restY;

      if (entry.jumpPhase === 'crouch') {
        const t = Math.min(entry.jumpTimer / 0.25, 1);
        const ease = t * t;
        if (b.LeftUpperLeg && r.LeftUpperLeg) b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - ease * 0.5;
        if (b.RightUpperLeg && r.RightUpperLeg) b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - ease * 0.5;
        if (b.LeftLowerLeg && r.LeftLowerLeg) b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + ease * 0.7;
        if (b.RightLowerLeg && r.RightLowerLeg) b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + ease * 0.7;
        if (b.LeftUpperArm && r.LeftUpperArm) b.LeftUpperArm.rotation.x = r.LeftUpperArm.x + ease * 0.4;
        if (b.RightUpperArm && r.RightUpperArm) b.RightUpperArm.rotation.x = r.RightUpperArm.x + ease * 0.4;
        if (b.UpperTorso && r.UpperTorso) b.UpperTorso.rotation.x = r.UpperTorso.x + ease * 0.1;
        if (m) m.position.y = ry - ease * 0.08;
        if (entry.jumpTimer >= 0.25) { entry.jumpPhase = 'launch'; entry.jumpTimer = 0; }
      } else if (entry.jumpPhase === 'launch') {
        const t = Math.min(entry.jumpTimer / 0.15, 1);
        const ease = 1 - (1 - t) * (1 - t);
        if (b.LeftUpperLeg && r.LeftUpperLeg) b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - 0.5 * (1 - ease);
        if (b.RightUpperLeg && r.RightUpperLeg) b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - 0.5 * (1 - ease);
        if (b.LeftLowerLeg && r.LeftLowerLeg) b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + 0.7 * (1 - ease);
        if (b.RightLowerLeg && r.RightLowerLeg) b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + 0.7 * (1 - ease);
        if (b.LeftUpperArm && r.LeftUpperArm) b.LeftUpperArm.rotation.x = r.LeftUpperArm.x - ease * 0.5;
        if (b.RightUpperArm && r.RightUpperArm) b.RightUpperArm.rotation.x = r.RightUpperArm.x - ease * 0.5;
        if (b.UpperTorso && r.UpperTorso) b.UpperTorso.rotation.x = r.UpperTorso.x + 0.1 * (1 - ease);
        if (m) m.position.y = ry - 0.08 + ease * 0.08 + ease * 0.15;
        if (entry.jumpTimer >= 0.15) { entry.jumpPhase = 'airborne'; entry.jumpTimer = 0; }
      } else if (entry.jumpPhase === 'airborne') {
        const t = Math.min(entry.jumpTimer / 0.5, 1);
        const height = 0.15 + 0.35 * (4 * t * (1 - t));
        if (b.LeftUpperLeg && r.LeftUpperLeg) b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - 0.3;
        if (b.RightUpperLeg && r.RightUpperLeg) b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - 0.3;
        if (b.LeftLowerLeg && r.LeftLowerLeg) b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + 0.4;
        if (b.RightLowerLeg && r.RightLowerLeg) b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + 0.4;
        if (b.LeftUpperArm && r.LeftUpperArm) { b.LeftUpperArm.rotation.x = r.LeftUpperArm.x - 0.5; b.LeftUpperArm.rotation.z = r.LeftUpperArm.z - 0.3; }
        if (b.RightUpperArm && r.RightUpperArm) { b.RightUpperArm.rotation.x = r.RightUpperArm.x - 0.5; b.RightUpperArm.rotation.z = r.RightUpperArm.z + 0.3; }
        if (b.Head && r.Head) b.Head.rotation.x = r.Head.x - 0.1;
        if (m) m.position.y = ry + height;
        if (entry.jumpTimer >= 0.5) { entry.jumpPhase = 'land'; entry.jumpTimer = 0; }
      } else if (entry.jumpPhase === 'land') {
        const t = Math.min(entry.jumpTimer / 0.3, 1);
        const impact = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
        const ease = t * t * (3 - 2 * t);
        if (b.LeftUpperLeg && r.LeftUpperLeg) b.LeftUpperLeg.rotation.x = r.LeftUpperLeg.x - impact * 0.4 * (1 - ease);
        if (b.RightUpperLeg && r.RightUpperLeg) b.RightUpperLeg.rotation.x = r.RightUpperLeg.x - impact * 0.4 * (1 - ease);
        if (b.LeftLowerLeg && r.LeftLowerLeg) b.LeftLowerLeg.rotation.x = r.LeftLowerLeg.x + impact * 0.5 * (1 - ease);
        if (b.RightLowerLeg && r.RightLowerLeg) b.RightLowerLeg.rotation.x = r.RightLowerLeg.x + impact * 0.5 * (1 - ease);
        if (b.LeftUpperArm && r.LeftUpperArm) { b.LeftUpperArm.rotation.x = r.LeftUpperArm.x + impact * 0.2 * (1 - ease); b.LeftUpperArm.rotation.z = r.LeftUpperArm.z - 0.3 * (1 - ease); }
        if (b.RightUpperArm && r.RightUpperArm) { b.RightUpperArm.rotation.x = r.RightUpperArm.x + impact * 0.2 * (1 - ease); b.RightUpperArm.rotation.z = r.RightUpperArm.z + 0.3 * (1 - ease); }
        if (b.UpperTorso && r.UpperTorso) b.UpperTorso.rotation.x = r.UpperTorso.x + impact * 0.08 * (1 - ease);
        if (m) m.position.y = ry - impact * 0.06 * (1 - ease);
        if (entry.jumpTimer >= 0.3) {
          // Reset this clone to rest pose
          for (const name in b) {
            if (r[name]) { b[name].rotation.x = r[name].x; b[name].rotation.y = r[name].y; b[name].rotation.z = r[name].z; }
          }
          if (m) m.position.y = ry;
          entry.jumpPhase = 'done';
        }
      }
      if (entry.jumpPhase !== 'done') allJumpsDone = false;
    }
  }
  // When all clones finish jump, transition to idle
  if (animState === 'jump' && allJumpsDone && stressCloneBones.length > 0) {
    animState = 'idle';
    resetToRestPose();
    animClock.start();
    document.querySelectorAll('.anim-btn:not([data-anim="lod"])').forEach(b => b.classList.toggle('active', b.dataset.anim === 'idle'));
    document.querySelectorAll('.stress-anim-btn').forEach(b => b.classList.toggle('active', b.dataset.anim === 'idle'));
  }
}

function updateStressMetrics() {
  document.getElementById('stress-fps').textContent = fps;
  const info = renderer.info;
  const totalTris = info.render.triangles || 0;
  document.getElementById('stress-tris').textContent = totalTris.toLocaleString();
  document.getElementById('stress-dc').textContent = info.render.calls;
  const memKB = currentEntry ? currentEntry.total_gpu_memory_kb * (1 + stressClones.length) : 0;
  document.getElementById('stress-gpu').textContent = memKB > 1024 ? (memKB / 1024).toFixed(1) + ' MB' : memKB.toFixed(0) + ' KB';
  document.getElementById('stress-clones').textContent = stressClones.length;
  document.getElementById('stress-cpu').textContent = cpuRenderMs.toFixed(2) + ' ms';
  const gpuTimeEl = document.getElementById('stress-gpu-time');
  gpuTimeEl.textContent = (gpuTimerAvailable && gpuTimeMs >= 0) ? gpuTimeMs.toFixed(2) + ' ms' : 'N/A';

  // CPU total per frame & utilization
  document.getElementById('stress-cpu-total').textContent = cpuTotalMs.toFixed(2) + ' ms';
  const utilPct = Math.min(100, (cpuTotalMs / 16.7) * 100);
  const utilEl = document.getElementById('stress-cpu-util');
  utilEl.textContent = utilPct.toFixed(0) + '%';
  utilEl.style.color = utilPct > 80 ? '#ff5555' : utilPct > 50 ? '#ffaa44' : '#66ddcc';

  // JS Heap (Chrome only)
  const heapEl = document.getElementById('stress-js-heap');
  if (performance.memory) {
    const usedMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
    const totalMB = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0);
    heapEl.textContent = usedMB + ' / ' + totalMB + ' MB';
  } else {
    heapEl.textContent = 'N/A';
    heapEl.parentElement.title = 'JS Heap is only available in Chromium browsers';
  }

  // Frame budget bar
  const TARGET = 16.67;
  const sCpuPct = Math.min(100, (cpuRenderMs / TARGET) * 100);
  const sGpuPct = gpuTimeMs >= 0 ? Math.min(100 - sCpuPct, (gpuTimeMs / TARGET) * 100) : 0;
  const sIdlePct = Math.max(0, 100 - sCpuPct - sGpuPct);
  document.getElementById('stress-seg-cpu').style.width = sCpuPct + '%';
  document.getElementById('stress-seg-cpu').textContent = sCpuPct > 10 ? cpuRenderMs.toFixed(1) + 'ms' : '';
  document.getElementById('stress-seg-gpu').style.width = sGpuPct + '%';
  document.getElementById('stress-seg-gpu').textContent = sGpuPct > 10 && gpuTimeMs >= 0 ? gpuTimeMs.toFixed(1) + 'ms' : '';
  document.getElementById('stress-seg-idle').style.width = sIdlePct + '%';
  const sUsedPct = Math.round(sCpuPct + sGpuPct);
  document.getElementById('stress-budget-pct').textContent = sUsedPct + '% of 16.7ms budget';

  // FPS history sparkline
  fpsHistory.push(fps);
  if (fpsHistory.length > 120) fpsHistory.shift();
  drawFpsChart();
}

function drawFpsChart() {
  const canvas = document.getElementById('fps-sparkline');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.parentElement.clientWidth;
  const h = 60;
  canvas.width = w;
  canvas.height = h;

  ctx.clearRect(0, 0, w, h);
  if (fpsHistory.length < 2) return;

  const max = Math.max(65, ...fpsHistory);
  const step = w / (fpsHistory.length - 1);

  // 60fps reference line
  const y60 = h - (60 / max) * (h - 4);
  ctx.strokeStyle = '#2a4a2a';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y60);
  ctx.lineTo(w, y60);
  ctx.stroke();
  ctx.setLineDash([]);

  // FPS line
  ctx.beginPath();
  ctx.strokeStyle = '#44cc88';
  ctx.lineWidth = 2;
  for (let i = 0; i < fpsHistory.length; i++) {
    const x = i * step;
    const y = h - (fpsHistory[i] / max) * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill under
  ctx.lineTo((fpsHistory.length - 1) * step, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(68,204,136,0.1)';
  ctx.fill();
}

function captureStressSnapshot(count) {
  // Delay to let a few frames render first
  setTimeout(() => {
    const info = renderer.info;
    scalingSnapshots.push({
      count,
      fps,
      drawCalls: info.render.calls,
      tris: (info.render.triangles || 0)
    });
    renderScalingTable();
  }, 1000);
}

function renderScalingTable() {
  const tbody = document.getElementById('scaling-tbody');
  tbody.innerHTML = scalingSnapshots.map(s =>
    `<tr><td>${s.count}</td><td>${s.fps}</td><td>${s.drawCalls}</td><td>${s.tris.toLocaleString()}</td></tr>`
  ).join('');
}

// Stress test event listeners
document.getElementById('stress-slider').addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  document.getElementById('stress-count-label').textContent = val;
  if (currentMode === 'stress') buildStressGrid(val);
});
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const count = parseInt(btn.dataset.count);
    document.getElementById('stress-slider').value = count;
    document.getElementById('stress-count-label').textContent = count;
    if (currentMode === 'stress') buildStressGrid(count);
  });
});
document.getElementById('stress-anim-toggle').addEventListener('change', (e) => {
  stressAnimEnabled = e.target.checked;
});

// ─── LOD Preview System ───
function setupLodPreview() {
  if (lodActive || !currentModel || !currentEntry) return;
  lodActive = true;

  const vp = document.getElementById('viewport');
  const split = document.createElement('div');
  split.className = 'lod-split';
  split.id = 'lod-split';

  const totalFaces = currentEntry.total_faces;
  const levels = [
    { title: 'LOD 0 — Near', tris: totalFaces, pct: '100%', distance: 3.5, material: 'normal' },
    { title: 'LOD 1 — Mid', tris: Math.round(totalFaces * 0.5), pct: '50% target', distance: 6, material: 'wireframe' },
    { title: 'LOD 2 — Far', tris: Math.round(totalFaces * 0.25), pct: '25% target', distance: 9, material: 'points' },
  ];

  for (let i = 0; i < 3; i++) {
    const col = document.createElement('div');
    col.className = 'lod-column';

    const miniRenderer = new THREE.WebGLRenderer({ antialias: true });
    miniRenderer.setClearColor(0x1a1a2e);
    miniRenderer.outputColorSpace = THREE.SRGBColorSpace;
    col.appendChild(miniRenderer.domElement);

    const miniScene = new THREE.Scene();
    miniScene.add(new THREE.AmbientLight(0x404060, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2);
    dl.position.set(3, 5, 4);
    miniScene.add(dl);
    miniScene.add(new THREE.HemisphereLight(0x6666aa, 0x222244, 0.5));
    miniScene.add(new THREE.GridHelper(10, 20, 0x2a2a4a, 0x1e1e38));

    const clone = cloneModelForStress(currentModel);
    if (levels[i].material === 'wireframe') {
      clone.traverse(child => {
        if (child.isMesh) {
          child.material = new THREE.MeshStandardMaterial({
            color: 0x5566ff, wireframe: true, transparent: true, opacity: 0.6
          });
        }
      });
    } else if (levels[i].material === 'points') {
      clone.traverse(child => {
        if (child.isMesh) {
          child.material = new THREE.PointsMaterial({ color: 0x5566ff, size: 0.02 });
          // Convert mesh to points visually
          const points = new THREE.Points(child.geometry, child.material);
          points.position.copy(child.position);
          points.rotation.copy(child.rotation);
          points.scale.copy(child.scale);
          child.visible = false;
          child.parent.add(points);
        }
      });
    }
    miniScene.add(clone);

    const miniCam = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    const d = levels[i].distance;
    miniCam.position.set(d * 0.55, d * 0.3 + 0.5, d * 0.65);
    miniCam.lookAt(0, 0.9, 0);

    const miniControls = new OrbitControls(miniCam, miniRenderer.domElement);
    miniControls.target.set(0, 0.9, 0);
    miniControls.enableDamping = true;
    miniControls.dampingFactor = 0.1;
    miniControls.enablePan = false;

    const label = document.createElement('div');
    label.className = 'lod-label';
    label.innerHTML = `<div class="lod-title">${levels[i].title}</div>` +
      `<span class="lod-budget">Budget: ${levels[i].tris.toLocaleString()} tris (${levels[i].pct})</span>` +
      `<span class="lod-actual">Rendered: —</span>`;
    col.appendChild(label);

    split.appendChild(col);
    lodRenderers.push(miniRenderer);
    lodScenes.push(miniScene);
    lodCameras.push(miniCam);
    // Sync rotation: when one control changes, update the others
    const idx = i;
    miniControls.addEventListener('change', () => {
      if (!lodSyncEnabled || lodSyncing) return;
      lodSyncing = true;
      const src = lodCameras[idx];
      const srcTarget = lodControls[idx].target;
      // Get spherical direction from source
      const offset = src.position.clone().sub(srcTarget);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      for (let j = 0; j < lodCameras.length; j++) {
        if (j === idx) continue;
        const dstTarget = lodControls[j].target;
        const dstOffset = lodCameras[j].position.clone().sub(dstTarget);
        const dstR = dstOffset.length(); // preserve each camera's own distance
        const synced = new THREE.Vector3().setFromSphericalCoords(dstR, spherical.phi, spherical.theta);
        lodCameras[j].position.copy(dstTarget).add(synced);
        lodControls[j].update();
      }
      lodSyncing = false;
    });

    lodControls.push(miniControls);
    lodModels.push(clone);
  }

  // Add sync toggle button
  const syncBtn = document.createElement('button');
  syncBtn.className = 'lod-sync-btn';
  syncBtn.textContent = 'Sync Rotation';
  syncBtn.addEventListener('click', () => {
    lodSyncEnabled = !lodSyncEnabled;
    syncBtn.classList.toggle('active', lodSyncEnabled);
    syncBtn.textContent = lodSyncEnabled ? 'Sync: ON' : 'Sync Rotation';
  });
  split.appendChild(syncBtn);

  vp.appendChild(split);

  // Start LOD render loop
  let lodStatsFrame = 0;
  function lodAnimate() {
    lodAnimFrame = requestAnimationFrame(lodAnimate);
    lodStatsFrame++;
    for (let i = 0; i < 3; i++) {
      const col = split.children[i];
      const w = col.clientWidth;
      const h = col.clientHeight;
      if (w && h) {
        lodRenderers[i].setSize(w, h);
        lodCameras[i].aspect = w / h;
        lodCameras[i].updateProjectionMatrix();
        lodControls[i].update();
        lodRenderers[i].render(lodScenes[i], lodCameras[i]);
        // Update per-column actual render stats every 15 frames
        if (lodStatsFrame % 15 === 0) {
          const info = lodRenderers[i].info.render;
          const actualEl = col.querySelector('.lod-actual');
          if (actualEl) {
            actualEl.textContent = `Rendered: ${info.triangles.toLocaleString()} tris, ${info.calls} draws`;
          }
        }
      }
    }
  }
  lodAnimate();
}

function teardownLodPreview() {
  if (!lodActive) return;
  lodActive = false;

  if (lodAnimFrame) {
    cancelAnimationFrame(lodAnimFrame);
    lodAnimFrame = null;
  }

  for (const c of lodControls) c.dispose();
  for (const r of lodRenderers) r.dispose();
  for (const s of lodScenes) {
    s.traverse(child => {
      if (child.isMesh || child.isPoints) {
        child.geometry?.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      }
    });
  }

  lodRenderers = [];
  lodScenes = [];
  lodCameras = [];
  lodControls = [];
  lodModels = [];
  lodSyncEnabled = false;
  lodSyncing = false;

  const split = document.getElementById('lod-split');
  if (split) split.remove();
}

// ─── Budget Dashboard ───
const BUDGETS = {
  triangles: { green: 10000, yellow: 15000 },
  vertices:  { green: 10000, yellow: 20000 },
  joints:    { green: 50,    yellow: 75 },
  materials: { green: 3,     yellow: 5 },
  meshes:    { green: 10,    yellow: 20 },
  gpuMemKB:  { green: 500,   yellow: 1000 },
};

function getBudgetLevel(metric, value) {
  const b = BUDGETS[metric];
  if (!b) return 'green';
  if (value <= b.green) return 'green';
  if (value <= b.yellow) return 'yellow';
  return 'red';
}

function getBudgetStatus(entry) {
  const joints = entry.real_joint_count >= 0 ? entry.real_joint_count : entry.node_count;
  const levels = [
    getBudgetLevel('triangles', entry.total_faces),
    getBudgetLevel('vertices', entry.total_vertices),
    getBudgetLevel('joints', joints),
    getBudgetLevel('materials', entry.material_count),
    getBudgetLevel('meshes', entry.mesh_count),
    getBudgetLevel('gpuMemKB', entry.total_gpu_memory_kb),
  ];
  if (levels.includes('red')) return 'fail';
  if (levels.includes('yellow')) return 'warn';
  return 'pass';
}

let budgetSortKey = 'name';
let budgetSortDesc = false;

function renderBudgetDashboard() {
  if (!manifest) return;
  const container = document.getElementById('budget-container');

  // Collect all entries
  const allEntries = [];
  for (const cat of ['rigs', 'clothing', 'cage_deformers']) {
    for (const e of (manifest[cat] || [])) allEntries.push(e);
  }

  // Compute statuses
  const statuses = allEntries.map(e => ({ entry: e, status: getBudgetStatus(e) }));
  const passCount = statuses.filter(s => s.status === 'pass').length;
  const warnCount = statuses.filter(s => s.status === 'warn').length;
  const failCount = statuses.filter(s => s.status === 'fail').length;

  // Worst offenders (most budget violations)
  const offenders = allEntries.map(e => {
    const joints = e.real_joint_count >= 0 ? e.real_joint_count : e.node_count;
    let violations = 0;
    if (getBudgetLevel('triangles', e.total_faces) === 'red') violations++;
    if (getBudgetLevel('vertices', e.total_vertices) === 'red') violations++;
    if (getBudgetLevel('joints', joints) === 'red') violations++;
    if (getBudgetLevel('materials', e.material_count) === 'red') violations++;
    if (getBudgetLevel('meshes', e.mesh_count) === 'red') violations++;
    if (getBudgetLevel('gpuMemKB', e.total_gpu_memory_kb) === 'red') violations++;
    return { name: e.name, violations };
  }).filter(o => o.violations > 0).sort((a, b) => b.violations - a.violations).slice(0, 3);

  // Sort entries
  const sorted = [...allEntries].sort((a, b) => {
    let va, vb;
    const aj = a.real_joint_count >= 0 ? a.real_joint_count : a.node_count;
    const bj = b.real_joint_count >= 0 ? b.real_joint_count : b.node_count;
    switch (budgetSortKey) {
      case 'name': va = a.name; vb = b.name; break;
      case 'category': va = a.category; vb = b.category; break;
      case 'tris': va = a.total_faces; vb = b.total_faces; break;
      case 'verts': va = a.total_vertices; vb = b.total_vertices; break;
      case 'joints': va = aj; vb = bj; break;
      case 'materials': va = a.material_count; vb = b.material_count; break;
      case 'meshes': va = a.mesh_count; vb = b.mesh_count; break;
      case 'gpu': va = a.total_gpu_memory_kb; vb = b.total_gpu_memory_kb; break;
      case 'status': va = getBudgetStatus(a); vb = getBudgetStatus(b); break;
      default: va = a.name; vb = b.name;
    }
    if (typeof va === 'string') return budgetSortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
    return budgetSortDesc ? vb - va : va - vb;
  });

  const catLabels = { rigs: 'Rig', clothing: 'Clothing', cage_deformers: 'Cage' };
  const makeHeader = (key, label) => {
    const cls = budgetSortKey === key ? 'sorted' : '';
    const arrow = budgetSortKey === key ? (budgetSortDesc ? ' \u25BC' : ' \u25B2') : '';
    return `<th class="${cls}" data-bkey="${key}">${label} <span class="sort-arrow">${arrow}</span></th>`;
  };

  container.innerHTML = `
    <h2 style="font-size:16px;color:#8888cc;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px">Roblox Avatar Budget Compliance</h2>
    <div class="budget-summary">
      <div class="budget-badge pass">${passCount}/${allEntries.length} Pass All Budgets</div>
      <div class="budget-badge warn">${warnCount} Warnings</div>
      <div class="budget-badge fail">${failCount} Over Budget</div>
    </div>
    ${offenders.length > 0 ? `<div class="budget-worst">
      <h3>Worst Offenders</h3>
      ${offenders.map(o => `<div class="offender">${o.name} — ${o.violations} metric${o.violations > 1 ? 's' : ''} over budget</div>`).join('')}
    </div>` : ''}
    <table class="budget-table">
      <thead><tr>
        ${makeHeader('name', 'Name')}
        ${makeHeader('category', 'Category')}
        ${makeHeader('tris', 'Tris')}
        ${makeHeader('verts', 'Verts')}
        ${makeHeader('joints', 'Joints')}
        ${makeHeader('materials', 'Mats')}
        ${makeHeader('meshes', 'Meshes')}
        ${makeHeader('gpu', 'GPU Mem')}
        ${makeHeader('status', 'Status')}
      </tr></thead>
      <tbody>
        ${sorted.map(e => {
          const joints = e.real_joint_count >= 0 ? e.real_joint_count : e.node_count;
          const status = getBudgetStatus(e);
          const gpuKB = e.total_gpu_memory_kb;
          const gpuStr = gpuKB > 1024 ? (gpuKB / 1024).toFixed(1) + ' MB' : gpuKB.toFixed(0) + ' KB';
          return `<tr data-model-id="${e.id}">
            <td style="color:#fff">${e.name}</td>
            <td style="color:#6666aa">${catLabels[e.category] || e.category}</td>
            <td class="cell-${getBudgetLevel('triangles', e.total_faces)}">${e.total_faces.toLocaleString()}</td>
            <td class="cell-${getBudgetLevel('vertices', e.total_vertices)}">${e.total_vertices.toLocaleString()}</td>
            <td class="cell-${getBudgetLevel('joints', joints)}">${joints}</td>
            <td class="cell-${getBudgetLevel('materials', e.material_count)}">${e.material_count}</td>
            <td class="cell-${getBudgetLevel('meshes', e.mesh_count)}">${e.mesh_count}</td>
            <td class="cell-${getBudgetLevel('gpuMemKB', gpuKB)}">${gpuStr}</td>
            <td class="status-${status}">${status.toUpperCase()}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  // Sort handlers
  container.querySelectorAll('.budget-table th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.bkey;
      if (budgetSortKey === key) budgetSortDesc = !budgetSortDesc;
      else { budgetSortKey = key; budgetSortDesc = false; }
      renderBudgetDashboard();
    });
  });

  // Row click -> jump to inspector
  container.querySelectorAll('.budget-table tbody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.modelId;
      const allModels = [...(manifest.rigs || []), ...(manifest.clothing || []), ...(manifest.cage_deformers || [])];
      const entry = allModels.find(e => e.id === id);
      if (!entry) return;
      switchMode('inspector');
      // Find and click the sidebar item
      const items = document.querySelectorAll('.model-item');
      for (const item of items) {
        if (item.textContent.trim().startsWith(entry.name)) {
          selectModel(entry, item);
          break;
        }
      }
    });
  });
}

// ─── Batch Performance Report ───
let benchmarkResults = [];
let benchmarkRunning = false;

function renderReportPanel() {
  const container = document.getElementById('report-container');
  if (benchmarkResults.length > 0) {
    renderReportResults();
    return;
  }
  container.innerHTML = `
    <h2 style="font-size:16px;color:#8888cc;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px">Batch Performance Report</h2>
    <div class="report-header">
      <button class="report-btn" id="run-benchmark-btn" onclick="">Run Full Benchmark</button>
      <div class="report-config">
        <label>Frames per model: <input type="number" id="bench-frames" value="120" min="30" max="600"></label>
      </div>
    </div>
    <div class="progress-bar-container" id="bench-progress">
      <div class="progress-bar-track"><div class="progress-bar-fill" id="bench-progress-fill"></div></div>
      <div class="progress-label" id="bench-progress-label">Preparing...</div>
    </div>
    <div id="report-results"></div>
  `;
  document.getElementById('run-benchmark-btn').addEventListener('click', () => runBenchmark());
}

async function runBenchmark() {
  if (benchmarkRunning) return;
  benchmarkRunning = true;
  benchmarkResults = [];

  const allEntries = [...(manifest.rigs || []), ...(manifest.clothing || []), ...(manifest.cage_deformers || [])];
  const frameCount = parseInt(document.getElementById('bench-frames').value) || 120;

  const btn = document.getElementById('run-benchmark-btn');
  btn.disabled = true;
  btn.textContent = 'Running...';
  const progressContainer = document.getElementById('bench-progress');
  progressContainer.style.display = 'block';
  const progressFill = document.getElementById('bench-progress-fill');
  const progressLabel = document.getElementById('bench-progress-label');

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    progressLabel.textContent = `Testing ${entry.name} (${i + 1}/${allEntries.length})`;
    progressFill.style.width = ((i / allEntries.length) * 100) + '%';

    const result = await benchmarkSingleModel(entry, frameCount);
    benchmarkResults.push(result);
  }

  progressFill.style.width = '100%';
  progressLabel.textContent = 'Complete!';
  benchmarkRunning = false;
  btn.disabled = false;
  btn.textContent = 'Re-run Benchmark';

  renderReportResults();
}

function benchmarkSingleModel(entry, frameCount) {
  return new Promise((resolve) => {
    const loadStart = performance.now();

    loader.load(entry.file, (gltf) => {
      const loadTime = performance.now() - loadStart;
      const model = gltf.scene;

      // Auto-center and scale
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 0 ? 2 / maxDim : 1;
      model.scale.setScalar(scale);
      const box2 = new THREE.Box3().setFromObject(model);
      const center2 = box2.getCenter(new THREE.Vector3());
      model.position.sub(center2);
      model.position.y -= box2.min.y;

      model.traverse(child => {
        if (child.isMesh && !child.material)
          child.material = new THREE.MeshStandardMaterial({ color: 0x8888cc });
        if (child.isMesh && child.name && (child.name.includes('Cage') || child.name.endsWith('_Att')))
          child.visible = false;
      });

      // Temporarily add to scene
      const prevModel = currentModel;
      if (prevModel) scene.remove(prevModel);
      scene.add(model);

      let frames = 0;
      const fpsSamples = [];
      const cpuSamples = [];
      let dcTotal = 0;
      let trisTotal = 0;

      function benchFrame() {
        const fStart = performance.now();
        renderer.render(scene, camera);
        const fEnd = performance.now();
        cpuSamples.push(fEnd - fStart);

        const info = renderer.info;
        dcTotal += info.render.calls;
        trisTotal += (info.render.triangles || 0);

        frames++;
        if (frames < frameCount) {
          requestAnimationFrame(benchFrame);
        } else {
          // Collect results
          scene.remove(model);
          model.traverse(child => {
            if (child.isMesh) {
              child.geometry.dispose();
              if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
              else if (child.material) child.material.dispose();
            }
          });

          if (prevModel) scene.add(prevModel);

          const avgCpu = cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length;
          const avgFps = 1000 / avgCpu;
          const minFps = 1000 / Math.max(...cpuSamples);

          resolve({
            name: entry.name,
            id: entry.id,
            category: entry.category,
            loadTime: Math.round(loadTime),
            avgFps: Math.round(avgFps),
            minFps: Math.round(minFps),
            avgCpuMs: parseFloat(avgCpu.toFixed(2)),
            drawCalls: Math.round(dcTotal / frameCount),
            tris: entry.total_faces,
            gpuMemKB: entry.total_gpu_memory_kb,
            budgetStatus: getBudgetStatus(entry),
            vertices: entry.total_vertices,
            joints: entry.real_joint_count >= 0 ? entry.real_joint_count : entry.node_count,
            materials: entry.material_count,
          });
        }
      }

      requestAnimationFrame(benchFrame);
    }, undefined, () => {
      resolve({
        name: entry.name, id: entry.id, category: entry.category,
        loadTime: -1, avgFps: 0, minFps: 0, avgCpuMs: 0,
        drawCalls: 0, tris: 0, gpuMemKB: 0, budgetStatus: 'fail',
        vertices: 0, joints: 0, materials: 0, error: true,
      });
    });
  });
}

let reportSortKey = 'name';
let reportSortDesc = false;

function renderReportResults() {
  const container = document.getElementById('report-container');
  const results = benchmarkResults;

  if (results.length === 0) { renderReportPanel(); return; }

  const avgLoad = Math.round(results.reduce((a, r) => a + r.loadTime, 0) / results.length);
  const fpsValues = results.map(r => r.avgFps).sort((a, b) => a - b);
  const medianFps = fpsValues[Math.floor(fpsValues.length / 2)];
  const passingCount = results.filter(r => r.budgetStatus === 'pass').length;

  // Sort
  const sorted = [...results].sort((a, b) => {
    let va, vb;
    switch (reportSortKey) {
      case 'name': va = a.name; vb = b.name; break;
      case 'category': va = a.category; vb = b.category; break;
      case 'loadTime': va = a.loadTime; vb = b.loadTime; break;
      case 'avgFps': va = a.avgFps; vb = b.avgFps; break;
      case 'minFps': va = a.minFps; vb = b.minFps; break;
      case 'avgCpuMs': va = a.avgCpuMs; vb = b.avgCpuMs; break;
      case 'drawCalls': va = a.drawCalls; vb = b.drawCalls; break;
      case 'tris': va = a.tris; vb = b.tris; break;
      case 'gpuMemKB': va = a.gpuMemKB; vb = b.gpuMemKB; break;
      case 'status': va = a.budgetStatus; vb = b.budgetStatus; break;
      default: va = a.name; vb = b.name;
    }
    if (typeof va === 'string') return reportSortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
    return reportSortDesc ? vb - va : va - vb;
  });

  const catLabels = { rigs: 'Rig', clothing: 'Clothing', cage_deformers: 'Cage' };
  const makeH = (key, label) => {
    const cls = reportSortKey === key ? 'sorted' : '';
    const arrow = reportSortKey === key ? (reportSortDesc ? ' \u25BC' : ' \u25B2') : '';
    return `<th class="${cls}" data-rkey="${key}">${label} <span class="sort-arrow">${arrow}</span></th>`;
  };

  container.innerHTML = `
    <h2 style="font-size:16px;color:#8888cc;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px">Batch Performance Report</h2>
    <div class="report-header">
      <button class="report-btn" id="run-benchmark-btn">Re-run Benchmark</button>
      <div class="report-config">
        <label>Frames per model: <input type="number" id="bench-frames" value="120" min="30" max="600"></label>
      </div>
      <button class="report-btn secondary" id="export-json-btn">Export JSON</button>
      <button class="report-btn secondary" id="export-csv-btn">Export CSV</button>
    </div>
    <div class="progress-bar-container" id="bench-progress">
      <div class="progress-bar-track"><div class="progress-bar-fill" id="bench-progress-fill" style="width:100%"></div></div>
      <div class="progress-label" id="bench-progress-label">Complete!</div>
    </div>
    <div class="report-summary">
      <div class="stat"><div class="label">Avg Load Time</div><div class="value">${avgLoad} ms</div></div>
      <div class="stat"><div class="label">Median FPS</div><div class="value">${medianFps}</div></div>
      <div class="stat"><div class="label">Passing Budget</div><div class="value">${passingCount}/${results.length}</div></div>
      <div class="stat"><div class="label">Models Tested</div><div class="value">${results.length}</div></div>
    </div>
    <table class="report-table">
      <thead><tr>
        ${makeH('name', 'Model')}
        ${makeH('category', 'Category')}
        ${makeH('loadTime', 'Load (ms)')}
        ${makeH('avgFps', 'Avg FPS')}
        ${makeH('minFps', 'Min FPS')}
        ${makeH('avgCpuMs', 'CPU (ms)')}
        ${makeH('drawCalls', 'Draw Calls')}
        ${makeH('tris', 'Tris')}
        ${makeH('gpuMemKB', 'GPU Mem')}
        ${makeH('status', 'Status')}
      </tr></thead>
      <tbody>
        ${sorted.map(r => {
          const gpuStr = r.gpuMemKB > 1024 ? (r.gpuMemKB / 1024).toFixed(1) + ' MB' : r.gpuMemKB.toFixed(0) + ' KB';
          const statusCls = r.budgetStatus === 'fail' ? 'cell-red' : '';
          return `<tr>
            <td style="color:#fff">${r.name}</td>
            <td style="color:#6666aa">${catLabels[r.category] || r.category}</td>
            <td>${r.loadTime}</td>
            <td${r.avgFps < 30 ? ' class="cell-red"' : ''}>${r.avgFps}</td>
            <td${r.minFps < 20 ? ' class="cell-red"' : ''}>${r.minFps}</td>
            <td${r.avgCpuMs > 8 ? ' class="cell-red"' : ''}>${r.avgCpuMs}</td>
            <td>${r.drawCalls}</td>
            <td>${r.tris.toLocaleString()}</td>
            <td>${gpuStr}</td>
            <td class="${statusCls}">${r.budgetStatus.toUpperCase()}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  // Sort handlers
  container.querySelectorAll('.report-table th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.rkey;
      if (reportSortKey === key) reportSortDesc = !reportSortDesc;
      else { reportSortKey = key; reportSortDesc = false; }
      renderReportResults();
    });
  });

  // Button handlers
  document.getElementById('run-benchmark-btn').addEventListener('click', () => runBenchmark());
  document.getElementById('export-json-btn').addEventListener('click', () => exportJSON(results));
  document.getElementById('export-csv-btn').addEventListener('click', () => exportCSV(results));
}

function exportJSON(results) {
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const report = {
    timestamp: new Date().toISOString(),
    browser: navigator.userAgent,
    gpu: gpuName,
    modelCount: results.length,
    results: results,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `avatar-perf-report-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCSV(results) {
  const headers = ['Model', 'Category', 'Load Time (ms)', 'Avg FPS', 'Min FPS', 'CPU (ms)', 'Draw Calls', 'Triangles', 'Vertices', 'Joints', 'Materials', 'GPU Memory (KB)', 'Budget Status'];
  const rows = results.map(r => [
    r.name, r.category, r.loadTime, r.avgFps, r.minFps, r.avgCpuMs,
    r.drawCalls, r.tris, r.vertices, r.joints, r.materials,
    r.gpuMemKB.toFixed(1), r.budgetStatus
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `avatar-perf-report-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Init ───
async function initializeManifest() {
  try {
    manifest = await getManifest();
  } catch (apiErr) {
    console.warn('Backend manifest endpoint unavailable; falling back to static manifest.json', apiErr);
    const fallbackResp = await fetch('manifest.json');
    if (!fallbackResp.ok) {
      throw new Error(`manifest fetch failed: ${fallbackResp.status}`);
    }
    manifest = await fallbackResp.json();
  }

  buildSidebar();
}

document.body.classList.add('mode-inspector');
initializeManifest().catch(err => {
  console.error('Failed to load manifest:', err);
  document.getElementById('model-list').innerHTML =
    '<div style="padding:16px;color:#ff5544">Failed to load manifest from backend or manifest.json.</div>';
});

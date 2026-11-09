import * as THREE from "three";
import { ArchiveVisibility } from "./archive-visibility";
import { ArchiveDrawCoverage, ArchiveShadowCoverage } from "./archive-draw-coverage";
import { InstanceUpdates } from "./instance-updates";
import { RenderState } from "./render-state";
import { SharedDepthAO, SharedDepthBokeh } from "./shared-depth";
import { disposeThreeTree } from "./three-resources";
import { ThemeWave } from "./theme-motion";
import { themeMaterial, themeEnvironment } from "./theme-material";
import { RhythmMotion, rhythmDisplacement, quietBands, type MusicBands, type RhythmStyle } from "./archive-play-motion";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createArchiveLighting, type LightingLook } from "./archive-lighting";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { normalizeQuality, type RenderQuality } from "./render-quality";
import { applyTextureQuality, resizeQuality } from "./quality-renderer";
import { CardAppearance } from "./appearance";
import { configureInternalOptics } from "./internal-optics";
import { DecryptionController } from "./decryption";
import { fileAtSlot, fileLocation, records } from "./data";
import {
  cellKey,
  sameCell,
  selectionCell,
  fileAtCell,
  poolCell,
  LOOP_COLUMNS,
  LOOP_ROWS,
  COLUMN_SPACING,
  ROW_SPACING,
  type ArchiveCell,
  type ArchiveNavigation,
} from "./archive-loop";
import { labelMarkSvg } from "./brand";
import { archiveFraming } from "./viewport-layout";
import { ArchiveDrag, ArchivePlaneMomentum, type DragAxis, type DragProjection, type DragPosition } from "./archive-drag";
import { assetUrl as publicAsset } from "./asset-url";
// ★ 封面资源版本号：重制 panels / atlas 后改这里，浏览器才会重新下载
//   （public/ 下的文件名固定，不带 hash，不换 v 会一直命中旧缓存）
const PANEL_ASSET_VERSION = "20261108i";
const panelUrl = (key: string) =>
  `${publicAsset(`assets/sixiang/panels/${key}.jpg`)}?v=${PANEL_ASSET_VERSION}`;
import { fullMotion, reducedMotion, type MotionPreferences } from "./motion-preferences";
import {
  archiveWave,
  extraction,
  baselineSelectionWave,
  rippleEnvelope,
  settlingWave,
  damp,
  columnStrength,
  idleWave,
  cinematicField,
  INSPECTION_LIFT,
  returnStep,
} from "./motion";

const ease = (t: number) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export class ArchiveScene {
  private inputEvents = new AbortController();
  private presence = 1;
  private presenceTarget = 1;
  setPresentationVisible(visible: boolean, immediate = false) {
    this.presenceTarget = Number(visible);
    if (immediate) this.presence = this.presenceTarget;
    if (!visible) this.cancelPointer();
  }
  get presentationHidden() { return this.presenceTarget === 0 && this.presence === 0; }
  private presentationDrop(cell: ArchiveCell) {
    const delay = .15 * (1 + Math.tanh((cell.row - this.selectedCell.row) * .1 + (cell.lane - this.selectedCell.lane) * .25));
    return 35 * Math.pow(THREE.MathUtils.clamp((1 - this.presence - delay) / .7, 0, 1), 2);
  }
  revealImmediately() { this.reveal = this.targetReveal; }
  dispose() {
    this.inputEvents.abort();
    this.cancelPointer();
    disposeThreeTree(this.scene);
    this.appearance.disposeSources();
    this.model.clear();
    this.outgoing = [];
    this.instances = [];
    this.assemblyTemplate?.then(disposeThreeTree).catch(() => {});
    this.assemblyTemplate = undefined;
    this.light.shadow.map?.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.loaded = false;
  }
  uiOnlyParallax = false;
  private theme = new ThemeWave();
  private subduedIndex = { value: 0 };
  private selectedIndexOnly = false;
  private superPerformance = false;
  setSuperPerformance(enabled: boolean) {
    if (this.superPerformance === enabled) return;
    this.superPerformance = enabled;
    for (const inst of this.instances) {
      const original = (inst.userData.fullMaterial ??= inst.material) as THREE.MeshPhysicalMaterial;
      if (enabled && !inst.userData.fastMaterial) {
        const fast = original.clone();
        fast.onBeforeCompile = original.onBeforeCompile;
        fast.customProgramCacheKey = original.customProgramCacheKey.bind(original);
        fast.transmission = 0;
        fast.clearcoat = 0;
        fast.roughness = Math.max(.45, original.roughness);
        inst.userData.fastMaterial = fast;
      }
      inst.material = enabled ? inst.userData.fastMaterial : original;
      inst.visible = !enabled || original.name.replace(/\.\d+$/, "") !== "Titanium_Fasteners";
    }
    this.resize();
  }
  setSelectedIndexAccent(onlySelected: boolean) { this.selectedIndexOnly = onlySelected; }
  private themeAttribute?: THREE.InstancedBufferAttribute;
  get themeAmount() { return this.theme.background(performance.now() / 1000); }
  setTheme(dark: boolean, immediate = false) { this.theme.set(dark, performance.now() / 1000, this.selectedCell, immediate); }
  private playfield = { enabled: false, bands: quietBands(), strength: 1, flatten: 0, target: null as string | null, breathing: true };
  private flatMix = 0;
  private rhythm = new RhythmMotion();
  private rhythmStyle: RhythmStyle = "legacy";
  setRhythmStyle(style: RhythmStyle) { this.rhythmStyle = style; }
  private relayLifts = new Map<string, number>();
  private relayPoints = new Map<string, { cell: ArchiveCell; point: THREE.Vector3 }>();
  private relayActive = false;
  onRelayPick?: (key: string | null) => void;
  setPlayfield(enabled: boolean, bands: MusicBands, strength: number, flatten: number, target: string | null, breathing = true) {
    this.playfield = { enabled, bands, strength, flatten, target, breathing };
  }
  setRelayActive(active: boolean) {
    if (active === this.relayActive) return;
    this.cancelPointer(); this.setHover(null); this.relayActive = active;
    this.pointer.set(0, 0);
  }
  relayPulse(key: string) {
    const cell = this.relayPoints.get(key)?.cell;
    if (cell && !this.reduced) this.emitPulse(cell);
  }
  projectRelay(key: string) {
    const item = this.relayPoints.get(key);
    if (!item) return null;
    const point = item.point.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }
  relayCandidates() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.scene.updateMatrixWorld(true);
    return [...this.relayPoints.keys()].filter(key => {
      const p = this.projectRelay(key)!;
      const x = (p.x - rect.left) / rect.width, y = (p.y - rect.top) / rect.height;
      if (x < .18 || x > .82 || y < .32 || y > .76) return false;
      const hit = this.pickCell(p.x, p.y);
      return hit && cellKey(hit) === key;
    });
  }
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  // The reference uses a long lens 72–140 units from the cassette. A 0.1 near
  // plane quantizes adjacent optical layers to the same depth (visible shimmer).
  // All visible foreground geometry is beyond 5; retain the framing and lens.
  readonly camera = new THREE.PerspectiveCamera(34, 16 / 9, 5, 300);
  private composer: EffectComposer;
  private ao: SharedDepthAO;
  private bokeh: BokehPass;
  private instances: THREE.InstancedMesh[] = [];
  private matrixUpdates?: InstanceUpdates;
  private themeUpdates?: InstanceUpdates;
  private renderState = new RenderState();
  private shadowState = new RenderState();
  private renderedFrames = 0;
  private reusedFrames = 0;
  private visibility = new ArchiveVisibility();
  private drawCoverage = new ArchiveDrawCoverage();
  private shadowCoverage?: ArchiveShadowCoverage;
  private instanceCapacity = LOOP_COLUMNS * LOOP_ROWS;
  private drawnCells: ArchiveCell[] = [];
  private extraCoverage = false;
  setArchiveCoverage(extra: boolean) { this.extraCoverage = extra; }
  private model = new THREE.Group();
  private appearance = new CardAppearance();
  private decryption = new DecryptionController();
  private cursor = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private cells: ArchiveCell[] = [];
  private selectedCell: ArchiveCell = { lane: 2, row: 12 };
  private looping = false;
  private coordinateOrigin: ArchiveCell = { lane: 0, row: 0 };
  private lift = { value: 0, velocity: 0 };
  private rail = { value: 0, velocity: 0 };
  private shoulder = { value: 12, velocity: 0 };
  private laneFocus = { value: 2, velocity: 0 };
  private columnCamera = { value: 0, velocity: 0 };
  private returnY: number | null = null;
  private canInspect = false;
  private clearance = 0;
  private pulseGain = 1;
  private idleGain = 0;
  private lastInteraction = 0;
  private scanTime = 29.1;
  private scanBlend = 0;
  private cameraAim = new THREE.Vector3();
  private outgoing: {
    group: THREE.Group;
    slot: number;
    cell: ArchiveCell;
    lift: { value: number; velocity: number };
    returnY: number | null;
    clarity: number;
  }[] = [];
  private pulses: { row: number; lane: number; time: number }[] = [];
  private pendingPulse: ArchiveCell | null = null;
  private selectedSlot = 76;
  private detail = 0;
  private targetDetail = 0;
  private reveal = 0;
  private targetReveal = 0;
  private last = 0;
  private pointer = new THREE.Vector2();
  private dragging = false;
  private hoverCell: ArchiveCell | null = null;
  private hoverLifts = new Map<string, number>();
  private archiveDrag = new ArchiveDrag();
  private dragTrack: DragPosition | null = null;
  private navigatingDrag = false;
  private archiveMomentum: { motion: ArchivePlaneMomentum; time: number } | null = null;
  private holdingArchive = false;
  private cancelPointer = () => {};
  private pendingHover: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType'> | null = null;
  private flushHover = () => {};
  private rotation = 0;
  private targetRotation = 0;
  private light: THREE.DirectionalLight;
  private clock = 0;
  private loaded = false;
  private labelCanvas = document.createElement("canvas");
  private labelTexture?: THREE.Texture;
  private labelMark = new Image();
  // ★ 展框改造：标签面用外部贴图，不再是程序化 Canvas
  private labelMesh?: THREE.Mesh;
  private labelUrl = "";
  private labelToken = 0;
  // ★ 阵列展框层：每盏板子的朝上面都贴自己的展框图
  private panelLayer = new THREE.Group();
  private panelTextures = new Map<string, THREE.Texture>();
  private pendingPanelKeys = new Set<string>();
  // ★ 展框图集（贴到 cassette 大面，每实例用 UV 矩形选图）
  private panelAtlasTexture?: THREE.Texture;
  private panelAtlasMeta?: { cols: number; rows: number; uv: Record<string, { u0: number; v0: number; u1: number; v1: number }> };
  private panelUvAttribute?: THREE.InstancedBufferAttribute;
  private selectedPanel?: THREE.Mesh;
  // ★ 当前已贴到封面片上的档案 key（换档案时用它判断要不要换图）
  private selectedPanelKey = "";
  private panelUvUpdate?: InstanceUpdates;
  // ★ 每个 cell 一个展框面（不能按档案 key 复用：循环阵列里同一档案会出现在多处）
  private panelByCell = new Map<string, THREE.Mesh>();
  private panelTextureLoader = new THREE.TextureLoader();
  private motion: MotionPreferences = fullMotion();
  private quality = normalizeQuality(undefined);
  private appliedQuality = "";
  private smaa = new SMAAPass();
  private aoKernelSize = 32;
  private displayHeight = 0;
  private layoutKind = "";
  onSelect?: (index: number, cell?: ArchiveCell) => void;
  onHover?: (index: number | null) => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  constructor(
    private container: HTMLElement,
    private readonly selectionPulse = baselineSelectionWave,
    private readonly deferSelectionPulse = false,
    private readonly lightingLook: LightingLook = "baseline",
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.5) *
        Math.min(innerWidth / 1920, innerHeight / 1080),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    // All composer passes see the same geometry within one application frame.
    // Generate the shadow map in the beauty pass and reuse it in depth/normal passes.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "三维研究档案阵列，点击选择，左右拖动切列，上下拖动或滚轮切换列内档案",
    );
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.renderState.invalidate();
      this.shadowState.invalidate();
    }, { signal: this.inputEvents.signal });
    this.scene.background = new THREE.Color("#eae5e1");
    // The frame updates world matrices once after simulation; subsequent
    // beauty, normal, depth and transmission renders reuse those same matrices.
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.fog = new THREE.Fog("#eae5e1", 22, 47);
    this.light = createArchiveLighting(this.renderer, this.scene, lightingLook);
    this.light.castShadow = true;
    Object.assign(this.light.shadow.camera, {
      left: -16,
      right: 16,
      top: 15,
      bottom: -15,
      near: 0.1,
      far: 45,
    });
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = lightingLook === "refined" ? 0.018 : 0.035;
    this.light.shadow.bias = lightingLook === "refined" ? -0.00012 : -0.0003;
    this.light.shadow.radius = 4;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: "#d8c9b9", roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.name = "archive-floor";
    floor.position.y = -4.63;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.cameraAim.set(-0.5, 1.1, 0.4);
    this.camera.fov = 6.15;
    this.camera.lookAt(this.cameraAim);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new SharedDepthAO(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    this.ao.kernelRadius = lightingLook === "refined" ? 0.44 : 0.38;
    this.ao.minDistance = 0.001;
    this.ao.maxDistance = 0.09;
    this.composer.addPass(this.ao);
    this.bokeh = new SharedDepthBokeh(this.scene, this.camera, {
      focus: 25,
      aperture: 0.0018,
      maxblur: 0.011,
    }, () => this.ao);
    this.composer.addPass(this.bokeh);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
    this.bindPointer();
  }
  async load(assetUrl = publicAsset("assets/archive-cassette.glb")) {
    this.labelMark.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelMarkSvg)}`;
    await this.labelMark.decode();
    // ★ 展框图集与 UV 索引
    //   ?v= 用于强制刷新浏览器缓存（封面重制后旧图会一直命中的老大难问题）
    try {
      const [meta, tex] = await Promise.all([
        fetch(`${publicAsset("assets/sixiang/panels-atlas.json")}?v=${PANEL_ASSET_VERSION}`).then((r) => r.json()),
        new THREE.TextureLoader().loadAsync(
          `${publicAsset("assets/sixiang/panels-atlas.jpg")}?v=${PANEL_ASSET_VERSION}`,
        ),
      ]);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.panelAtlasTexture = tex;
      this.panelAtlasMeta = meta;
    } catch (e) {
      console.warn("展框图集加载失败", e);
    }
    const gltf = await new GLTFLoader().loadAsync(
      assetUrl,
    );
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    const count = LOOP_COLUMNS * LOOP_ROWS;
    for (let index = 0; index < count; index++) {
      const cell = poolCell(index);
      this.cells.push(cell);
    }
    for (const mesh of meshes) {
      const geom = mesh.geometry
        .clone()
        .applyMatrix4(mesh.matrixWorld)
        .scale(1, 1, 1);
      const source = mesh.material as THREE.MeshStandardMaterial;
      const name = source.name.replace(/\.\d+$/, "");
      const mat = source.clone() as THREE.MeshPhysicalMaterial;
      mat.envMapIntensity = 0.6;
      if (name === "Frosted_Polymer") {
        // ★ 抽出的这块**不挂图集**：它的 UV 是 Blender 烘的，
        //   会把 70 格图集整张铺在卡面上（一格里出现好几只神兽 + 镜像字）。
        //   封面改由前面的 selectedPanel 面片直贴 panels/{key}.jpg。
        mat.map = null;
        mat.needsUpdate = true;
        // 封面面片比盒面小一圈，露出的边也要是木色，不然会有一圈白边
        mat.color.set("#3a2214");
        mat.transmission = 0.9;
        mat.thickness = 0.12;
        mat.roughness = 0.21;
        mat.ior = 1.46;
        mat.attenuationColor = new THREE.Color("#eee6df");
        mat.attenuationDistance = 2;
      }
      if (name === "Internal_Ceramic") {
        mat.color.set(this.lightingLook === "refined" ? "#c4baae" : "#c7beb6");
        mat.roughness = 0.6;
      }
      if (name === "Printed_Label") mat.color.set("#eae5dc");
      if (name === "Ivory_Edges") {
        // ★ 木框外观：原来的奶白塑料壳 → 深胡桃木
        mat.color.set("#8a6440");
        mat.roughness = 0.52;
        mat.metalness = 0.04;
        mat.transmission = 0;
        mat.thickness = 0.04;
      }
      if (name === "Optical_Diffuser") {
        mat.color.set("#e2dad4");
        mat.transmission = 0;
        mat.roughness = 0.7;
      }
      if (name === "Subsurface_Optics") {
        mat.color.set(this.lightingLook === "refined" ? "#b9a796" : "#b9aba1");
        mat.roughness = 0.48;
        mat.metalness = 0.05;
      }
      if (name === "Optical_Edges") {
        // Internal refractive shoulders must be in the opaque capture: WebGL's
        // screen-space transmission cannot recursively sample another glass mesh.
        mat.transmission = 0;
        mat.color.set(this.lightingLook === "refined" ? "#d8c7b5" : "#d4c7be");
        mat.roughness = 0.26;
        mat.metalness = 0.08;
      }
      if (name === "Frosted_Polymer") {
        // 抽出的这块没有实例属性 → 用 uniform 传 UV 矩形
        const uvRect = { value: new THREE.Vector4(0, 0, 0, 0) };
        (mat as unknown as { userData: Record<string, unknown> }).userData.panelUvRect = uvRect;
        mat.customProgramCacheKey = () => "sixiang-panel-uniform";
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.panelUvRect = uvRect;
          shader.vertexShader =
            "varying float vPanelHeight;\nvarying vec3 vLocalNormal;\nvarying vec3 vLocalPos;\n" +
            shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvPanelHeight = position.y / 3.7;\nvLocalNormal = normal;\nvLocalPos = position;",
          );
          shader.fragmentShader =
            "varying float vPanelHeight;\nvarying vec3 vLocalNormal;\nvarying vec3 vLocalPos;\nuniform vec4 panelUvRect;\n" +
            shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <map_fragment>",
            `#include <map_fragment>
            #ifdef USE_MAP
              vec3 nrmS = normalize(vLocalNormal);
              float wideS = step(0.55, abs(nrmS.z));
              if (wideS > 0.5) {
                vec2 local01 = vec2(
                  clamp(vLocalPos.x / 5.0 + 0.5, 0.0, 1.0),
                  clamp(vLocalPos.y / 3.7, 0.0, 1.0)
                );
                vec2 atlasUvS = vec2(
                  mix(panelUvRect.x, panelUvRect.z, local01.x),
                  mix(panelUvRect.y, panelUvRect.w, local01.y)
                );
                vec4 panelTexS = texture2D(map, atlasUvS);
                vec3 bodyTintS = mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94),
                                     smoothstep(0.1, 1.0, vPanelHeight));
                diffuseColor.rgb = panelTexS.rgb * bodyTintS;
              }
            #endif`,
          );
        };
      }
      configureInternalOptics(name, mat);
      if (name === "Carbon_Ink") continue;
      const selectedMesh = new THREE.Mesh(geom, mat);
      selectedMesh.userData.surface = name;
      selectedMesh.castShadow = name === "Optical_Diffuser";
      selectedMesh.receiveShadow = true;
      this.model.add(selectedMesh);
      // Only the shell, edge and fasteners remain visible within tightly packed rows.
      // Keep sub-millimetre optical/typographic geometry on the extracted cassette.
      if (
        ![
          "Frosted_Polymer",
          "Ivory_Edges",
          "Titanium_Fasteners",
          "Index_Inlay",
          "Optical_Diffuser",
        ].includes(name)
      ) {
        this.appearance.register(name, mat);
        continue;
      }
      const arrayMat = mat.clone();
      if (name === "Frosted_Polymer") {
        // ★ 展框改造：cassette 的**大面**贴我们的神兽展框图（贴图集）。
        //   每个实例用 archivePanelUv 属性选图集里的对应格子。
        arrayMat.map = this.panelAtlasTexture ?? null;
        arrayMat.needsUpdate = true;
        arrayMat.transmission = 0.78;
        if (this.lightingLook === "refined") {
          // Longer oblique paths pick up the warm body tint, while the thin
          // edges and the extracted clear cover retain a brighter response.
          arrayMat.thickness = 0.28;
          arrayMat.attenuationColor.set("#d4c7b4");
          arrayMat.attenuationDistance = 1.2;
        }
        arrayMat.transparent = false;
        arrayMat.color.set("#fff7ed");
        arrayMat.onBeforeCompile = (shader) => {
          shader.vertexShader =
            "varying float vPanelHeight;\nattribute vec4 archivePanelUv;\nvarying vec4 vPanelUv;\nvarying vec3 vLocalNormal;\nvarying vec3 vLocalPos;\n" +
            shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvPanelHeight = position.y / 3.7;\nvPanelUv = archivePanelUv;\nvLocalNormal = normal;\nvLocalPos = position;",
          );
          shader.fragmentShader =
            "varying float vPanelHeight;\nvarying vec4 vPanelUv;\nvarying vec3 vLocalNormal;\nvarying vec3 vLocalPos;\n" + shader.fragmentShader;
          // ★ 展框：把贴图 UV 重映射到图集里本实例对应的那一格
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <map_fragment>",
            `#include <map_fragment>
            #ifdef USE_MAP
              // ★ 只在 cassette 的**大面**贴展框。
              //   用**局部法线**（不受模型旋转与相机影响）：
              //   GLB 实测 extent = X5.0 × Y3.7 × Z0.032 → 板子竖立，
              //   宽面在 XY 平面、法线沿 ±Z；窄边法线沿 ±X 或 ±Y。
              // ★ 展框贴图：**只在 cassette 的宽面**（局部法线 ±Z）贴展框图；
              //   窄边（±X / ±Y）保持原版白色塑料质感 —— 与原版参考视频一致
              //   （阵列里看到的是板子的侧边，只有抽出来转向观众时才看到展框）。
              // ★ 用**局部坐标**直接算 UV，不依赖 Blender 烘的 vMapUv
              //   （那个 UV 在 cube 上会重复/超出，导致采样到图集格外 → 褐色）。
              //   cassette 大面：X ∈ [-2.5, 2.5]、Y ∈ [0, 3.7]（GLB 实测）
              //   → 归一化到 0..1 再映射到图集格。
              // ★ 展框图：宽面（±Z，法线）贴整张展框；
              //   长边（±X，5×0.032 的窄条）贴**缩略条**（把展框图横向压扁），
              //   这样从阵列侧面看过去，每条边上也有我们的内容。
              // ★ 展框贴图（三面都贴，阵列里从任何角度都能看到我们的内容）：
              //   · 宽面 ±Z（5 × 3.7，746 顶点）→ 整张展框
              //   · 顶/底边 ±Y（5 × 0.032，164 顶点）→ 展框的**顶部题签条**
              //     （这是 45° 俯视时唯一能看到的面 —— 原版这里只是褐色渐变）
              //   · 端边 ±X（0.032 × 3.7，162 顶点）→ 展框的**竖排题签栏**
              vec3 nrm = normalize(vLocalNormal);
              float wide = step(0.55, abs(nrm.z));
              float topEdge = step(0.55, abs(nrm.y));
              float endEdge = step(0.55, abs(nrm.x));
              vec2 atlasUv;
              if (wide > 0.5) {
                vec2 local01 = vec2(
                  clamp(vLocalPos.x / 5.0 + 0.5, 0.0, 1.0),
                  clamp(vLocalPos.y / 3.7, 0.0, 1.0)
                );
                atlasUv = vec2(
                  mix(vPanelUv.x, vPanelUv.z, local01.x),
                  mix(vPanelUv.y, vPanelUv.w, local01.y)
                );
              } else if (topEdge > 0.5) {
                // 顶边（5 × 0.032）：沿 X 铺开，取展框图的**上部 22%**
                //   —— 含题签栏与朱砂印章，这是 45° 俯视时唯一看得清的面
                float t = clamp(vLocalPos.x / 5.0 + 0.5, 0.0, 1.0);
                atlasUv = vec2(
                  mix(vPanelUv.x, vPanelUv.z, t),
                  mix(vPanelUv.w - 0.22, vPanelUv.w, 0.5)
                );
              } else if (endEdge > 0.5) {
                // 端边：沿 Y 铺开，取展框图右侧的竖排题签栏
                float t = clamp(vLocalPos.y / 3.7, 0.0, 1.0);
                atlasUv = vec2(
                  mix(vPanelUv.z - 0.055, vPanelUv.z, 0.5),
                  mix(vPanelUv.y, vPanelUv.w, t)
                );
              } else {
                atlasUv = vec2(vPanelUv.x, vPanelUv.y);
              }
              // ★ 用 emissive 叠加而不是 diffuse —— Frosted_Polymer 是
              //   transmission=0.78 的半透明玻璃，diffuse 会被透射冲淡，
              //   自发光才能透过玻璃清晰可见。
              // ★ 展框图叠在原版渐变之上：原版的「下深上浅」立体感保留，
              //   我们的展框内容覆盖其上。透明玻璃里的自发光保证透过后仍可读。
              vec4 panelTex = texture2D(map, atlasUv);
              // 原版的「下深上浅」渐变（照搬，保留立体感）
              vec3 bodyTint = mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94),
                                  smoothstep(0.1, 1.0, vPanelHeight));
              diffuseColor.rgb = panelTex.rgb * bodyTint;
              // ★ 自发光要够强才能穿透 Frosted_Polymer 的磨砂玻璃（transmission 0.78）
              // 暗色模式下环境光很弱，只靠 diffuse 会让立绘沉进黑底 →
              // 按主题强度补自发光（浅色 0.22，深色 0.62）
              float panelDark = clamp(vRhineTheme, 0.0, 1.0);
              totalEmissiveRadiance += panelTex.rgb * mix(0.22, 0.62, panelDark) * bodyTint;
            #endif`,
          );
          // 原版的「下深上浅」渐变已并入 map_fragment 的贴图分支，
          //   这里不再单独乘一次（否则会二次压暗）。
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>",
          );
        };
        arrayMat.roughness = 0.28;
        arrayMat.clearcoat = 0.3;
        arrayMat.clearcoatRoughness = 0.25;
      }
      if (name === "Optical_Diffuser") arrayMat.color.set("#806447");
      if (name === "Ivory_Edges") {
        // ★ 木框外观（阵列 70 块共用）：深胡桃木 + 哑光
        arrayMat.transmission = 0;
        arrayMat.color.set(this.lightingLook === "refined" ? "#8a6440" : "#9a7248");
        arrayMat.roughness = 0.55;
        arrayMat.metalness = 0.03;
      }
      if (name === "Index_Inlay") {
        arrayMat.color.set("#e4d6c5");
        arrayMat.metalness = 0.05;
      }
      this.appearance.register(name, mat, arrayMat);
      this.themeAttribute ??= new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute("archiveTheme", this.themeAttribute);
      // ★ 展框图集：每实例的 UV 矩形（u0,v0,u1,v1）
      this.panelUvAttribute ??= new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute("archivePanelUv", this.panelUvAttribute);
      this.panelUvUpdate ??= new InstanceUpdates(this.panelUvAttribute);
      themeMaterial(arrayMat, name, true, this.subduedIndex);
      const inst = new THREE.InstancedMesh(geom, arrayMat, count);
      // All surfaces move rigidly together; share the transform buffer on the GPU.
      inst.instanceMatrix = this.instances[0]?.instanceMatrix ?? inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.castShadow = name === "Optical_Diffuser";
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.instances.push(inst);
      this.scene.add(inst);
    }
    this.shadowCoverage = new ArchiveShadowCoverage(this.instances.find(mesh => mesh.castShadow)!);
    this.scene.add(this.shadowCoverage.mesh);
    this.labelCanvas.width = 1024;
    this.labelCanvas.height = 440;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.anisotropy =
      this.renderer.capabilities.getMaxAnisotropy();
    // ★ 展框面板（抽出的这块）：单独一个面片贴在 cassette 的宽面（+Z）。
    //   阵列里的板子走图集（Frosted_Polymer 材质 + 实例 UV），
    //   抽出的这块用独立 mesh → 内容清晰、不被磨砂玻璃冲淡。
    this.selectedPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(4.86, 3.66),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    );
    // ★ 贴住正面玻璃。实测各部件局部 z：
    //   磨砂前盖 Frosted_Polymer 0.174~0.206、内置标签条到 0.246。
    //   → 封面片放 0.252，只离面 6mm 级别（0.006），跟着板子一起转，
    //     不会像 0.82 那样悬在盒外「浮」着，也不会像 0.12 那样被塞进盒子里。
    this.selectedPanel.position.set(0, 1.85, 0.252);
    // 告诉 appearance：这块自带贴图，别套主题材质（否则暗色会反相）
    this.selectedPanel.userData.keepMaterial = true;
    this.selectedPanel.renderOrder = 3;
    this.selectedPanel.visible = false;
    this.model.add(this.selectedPanel);
    this.appearance.prepare(this.model);
    this.appearance.apply(this.model, 0);
    this.drawLabel(0);
    this.scene.add(this.model);

    this.model.position.copy(this.cellPosition(poolCell(this.selectedSlot)));
    // ★ 调试钩子：暴露展框面板状态供自动化检查
    (window as any).__dumpScene = () => {
      const out: any[] = [];
      this.scene.traverse((o: any) => {
        if (!o.isMesh) return;
        const m = o.material;
        const map = m?.map;
        const img = map?.image;
        out.push({
          name: o.name,
          mat: m?.name,
          geo: o.geometry?.type,
          params: o.geometry?.parameters,
          visible: o.visible,
          mapSrc: img?.src ? String(img.src).slice(-46) : null,
          mapSize: img ? [img.width, img.height] : null,
          repeat: map ? [map.repeat.x, map.repeat.y] : null,
          offset: map ? [map.offset.x, map.offset.y] : null,
          world: o.getWorldPosition(new THREE.Vector3()).toArray().map((v: number) => Math.round(v * 100) / 100),
        });
      });
      const bb = new THREE.Box3().setFromObject(this.model);
      const panelW = this.selectedPanel ? this.selectedPanel.getWorldPosition(new THREE.Vector3()) : null;
      return {
        modelBox: { min: bb.min.toArray().map((v: number) => Math.round(v * 1000) / 1000), max: bb.max.toArray().map((v: number) => Math.round(v * 1000) / 1000) },
        panelWorld: panelW ? panelW.toArray().map((v: number) => Math.round(v * 1000) / 1000) : null,
        camPos: this.camera.position.toArray().map((v: number) => Math.round(v * 100) / 100),
        modelRotY: Math.round(this.model.rotation.y * 100) / 100,
        detail: Math.round(this.detail * 100) / 100, lift: Math.round(this.lift.value * 100) / 100, panelKey: this.selectedPanelKey, panelVisible: this.selectedPanel?.visible ?? null, meshes: out.filter((x) => x.visible || x.mapSize), total: out.length };
    };
    this.loaded = true;
  }

  private assemblyTemplate?: Promise<THREE.Group>;
  async createAssemblyModel() {
    this.assemblyTemplate ??= new GLTFLoader()
      .loadAsync(publicAsset("assets/archive-assembly.glb"))
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      })
      .catch((error) => {
        this.assemblyTemplate = undefined;
        throw error;
      });
    const template = await this.assemblyTemplate;
    const model = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = (object.material as THREE.Material).name.replace(
        /\.\d+$/,
        "",
      );
      const mesh = new THREE.Mesh(
        object.geometry.clone().applyMatrix4(object.matrixWorld),
        object.material,
      );
      mesh.userData.surface = name;
      mesh.userData.assemblyPart = object.userData.assemblyPart;
      model.add(mesh);
      meshes.push(mesh);
    });
    this.appearance.prepare(model);
    this.appearance.apply(model, 1);
    this.appearance.setClarity(model, this.modelClarity());
    this.appearance.setTheme(model, this.themeAmount);
    const canvas = document.createElement("canvas");
    canvas.width = this.labelCanvas.width;
    canvas.height = this.labelCanvas.height;
    canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.99, 0.46),
      new THREE.MeshBasicMaterial({
        map: texture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    label.position.set(-1.36, 3.04, 0.255);
    label.userData.assemblyPart = "cover";
    label.userData.themeAmount = themeMaterial(label.material, "Printed_Canvas");
    label.userData.themeAmount.value = this.themeAmount;
    model.add(label);
    meshes.push(label);
    return {
      model,
      setClarity: (value: number) => this.appearance.setClarity(model, value),
      dispose: () => {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        texture.dispose();
      },
    };
  }
  setMode(mode: "hidden" | "archive" | "detail") {
    this.cancelPointer();
    this.setHover(null);
    if (mode === "detail") this.decryption.enter(this.scanBlend > .9 && this.decryption.clarity > .999);
    else this.decryption.leave();
    if (mode === "hidden") this.decryption.select();
    if (mode !== "archive") this.pendingPulse = null;
    this.looping = mode !== "hidden";
    if (!this.looping) {
      const canonical = fileLocation(fileAtSlot(this.selectedSlot));
      this.selectedCell = { lane: canonical.lane, row: canonical.row };
      this.coordinateOrigin = { lane: 0, row: 0 };
      for (const old of this.outgoing) {
        this.scene.remove(old.group);
        this.appearance.dispose(old.group);
      }
      this.outgoing = [];
    }
    this.lastInteraction = this.clock;
    this.targetReveal = mode === "hidden" ? 0 : 1;
    this.targetDetail = mode === "detail" ? 1 : 0;
    this.dragging = false;
    if (mode !== "detail") {
      this.targetRotation = 0;
      if (this.rotation !== 0) this.returnY = this.model.position.y;
    } else this.returnY = null;
  }
  // Legacy review pages use the old whole-scene toggle.
  setReduced(value: boolean) { this.setMotion(value ? reducedMotion() : fullMotion()); }
  setMotion(value: MotionPreferences) {
    if ((!value.pointerParallax || !value.dragMomentum) && (this.motion.pointerParallax || this.motion.dragMomentum)) this.cancelPointer();
    if (!value.dragMomentum) {
      this.archiveMomentum = null;
      this.columnCamera.velocity = 0;
      this.rail.velocity = 0;
    }
    if (!value.pointerParallax) this.pointer.set(0, 0);
    if (!value.selectionWave) this.pulses = [];
    if (!value.idleWave) this.idleGain = 0;
    this.motion = { ...value };
    if (!value.modelDecryption) {
      this.appearance.setClarity(this.model, this.modelClarity());
      for (const old of this.outgoing) {
        old.clarity = 0;
        this.appearance.setClarity(old.group, 0);
      }
    }
  }
  private get reduced() { return Object.values(this.motion).every(value => !value); }
  private modelClarity() {
    // Disabling the reveal animation preserves the material state of each mode.
    return this.motion.modelDecryption ? this.decryption.clarity : this.targetDetail;
  }
  setQuality(value: RenderQuality | boolean) {
    const quality =
      typeof value === "boolean"
        ? normalizeQuality(undefined, value)
        : normalizeQuality(value);
    const key = JSON.stringify(quality);
    if (this.appliedQuality === key) return;
    this.appliedQuality = key;
    this.quality = quality;
    if (quality.aoSamples && quality.aoSamples !== this.aoKernelSize) {
      const old = this.ao;
      this.ao = new SharedDepthAO(this.scene, this.camera, 1, 1, quality.aoSamples);
      this.ao.kernelRadius = old.kernelRadius;
      this.ao.minDistance = old.minDistance;
      this.ao.maxDistance = old.maxDistance;
      const index = this.composer.passes.indexOf(old);
      this.composer.removePass(old);
      this.composer.insertPass(this.ao, index);
      old.dispose();
      this.aoKernelSize = quality.aoSamples;
    }
    this.ao.enabled = quality.aoSamples > 0;
    this.bokeh.enabled = quality.depthOfField > 0;
    this.smaa.enabled = quality.antialias === "smaa";
    this.renderer.shadowMap.enabled = quality.shadows > 0;
    const size = Math.min(
      quality.shadows || 1024,
      this.renderer.capabilities.maxTextureSize,
    );
    if (this.light.shadow.mapSize.x !== size) {
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
      this.light.shadow.mapSize.set(size, size);
    }
    this.light.shadow.needsUpdate = true;
    applyTextureQuality(this.scene, this.renderer, quality);
    this.resize();
  }
  private cellPosition(cell: ArchiveCell) {
    return new THREE.Vector3(
      (cell.lane - 2) * COLUMN_SPACING,
      -4.6,
      (cell.row - 15.5) * ROW_SPACING,
    );
  }
  private rebaseCoordinates() {
    // Periodically reduce the logical coordinates while preserving every
    // relative position, spring velocity, ripple and idle phase.
    const shift = {
      lane:
        Math.abs(this.selectedCell.lane) > 2048
          ? Math.round((this.selectedCell.lane - 2) / 5) * 5
          : 0,
      row:
        Math.abs(this.selectedCell.row) > 2048
          ? Math.floor((this.selectedCell.row - 12) / 8) * 8
          : 0,
    };
    if (!shift.lane && !shift.row) return;
    this.setHover(null);
    this.hoverLifts.clear();
    this.selectedCell.lane -= shift.lane;
    this.selectedCell.row -= shift.row;
    this.coordinateOrigin.lane += shift.lane;
    this.coordinateOrigin.row += shift.row;
    this.laneFocus.value -= shift.lane;
    this.shoulder.value -= shift.row;
    this.columnCamera.value -= shift.lane * COLUMN_SPACING;
    this.rail.value += shift.row * ROW_SPACING;
    for (const old of this.outgoing) {
      old.cell.lane -= shift.lane;
      old.cell.row -= shift.row;
    }
    for (const pulse of this.pulses) {
      pulse.lane -= shift.lane;
      pulse.row -= shift.row;
    }
    if (this.pendingPulse) {
      this.pendingPulse.lane -= shift.lane;
      this.pendingPulse.row -= shift.row;
    }
  }
  select(index: number, navigation?: ArchiveNavigation) {
    if (!this.navigatingDrag) this.cancelPointer();
    this.setHover(null);
    this.lastInteraction = this.clock;
    const next = fileLocation(index).slot;
    const canonical = fileLocation(index);
    const cell = this.looping
      ? selectionCell(index, this.selectedCell, navigation)
      : { lane: canonical.lane, row: canonical.row };
    const changed = !sameCell(cell, this.selectedCell);
    if (this.looping && changed && this.loaded && this.lift.value > 0.0001) {
      const group = this.model.clone(true);
      const label = group.children[group.children.length - 1] as THREE.Mesh;
      const canvas = document.createElement("canvas");
      canvas.width = 1024;
      canvas.height = 440;
      canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      label.material = new THREE.MeshBasicMaterial({
        map,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      });
      // Clone carries the selected label material by reference. Replace it
      // before installing appearance shaders, so theme hooks are not appended
      // to the original label a second time on every selection.
      this.appearance.prepare(group);
      this.appearance.apply(group, ease(this.lift.value / 0.4));
      this.appearance.setClarity(group, this.modelClarity());
      this.scene.add(group);
      this.outgoing.push({
        group,
        slot: this.selectedSlot,
        cell: { ...this.selectedCell },
        lift: { ...this.lift },
        returnY: group.rotation.y !== 0 ? group.position.y : null,
        clarity: this.modelClarity(),
      });
      this.lift.value = 0;
      this.lift.velocity = 0;
    }
    this.selectedSlot = next;
    this.selectedCell = cell;
    if (changed) {
      this.decryption.select();
      this.rotation = 0;
      this.returnY = null;
    }
    const returning = this.outgoing.findIndex((o) => sameCell(o.cell, cell));
    if (returning >= 0) {
      const o = this.outgoing[returning];
      this.lift = { ...o.lift };
      this.rotation = o.group.rotation.y;
      this.returnY = o.returnY;
      this.decryption.select(o.clarity);
      this.scene.remove(o.group);
      this.appearance.dispose(o.group);
      this.outgoing.splice(returning, 1);
    }
    if (this.deferSelectionPulse) {
      this.pendingPulse = this.looping ? { ...cell } : null;
    } else this.emitPulse(cell);
    this.targetRotation = 0;
    this.drawLabel(index);
  }
  /**
   * ★ 展框面同步：让每个阵列 cell 的板子朝上面贴自己的展框图。
   * 阵列实例是 InstancedMesh（无法每实例不同贴图），所以另起一层普通 Mesh，
   * 复用实例矩阵来摆放。贴图按 key 懒加载并缓存。
   */
  /**
   * 抽出的那块板子：显示它的展框图（独立贴图，不走图集）。
   * 面板正对观众时才显示 —— 阵列浏览时隐藏，保持原版观感。
   */
  private updateSelectedPanel(cell: ArchiveCell) {
    const panel = this.selectedPanel;
    if (!panel) return;
    const record = records[fileAtCell(cell)];
    if (!record) return;
    const key = this.panelKeyOf(record);
    if (!key) return;
    const mat = panel.material as THREE.MeshBasicMaterial;
    // ★ 选中的档案变了就必须换图。旧实现只在 mat.map 为空时加载一次，
    //   结果无论选哪只，抽出来的封面永远是第一只（白虎）→ 档案与封面错位。
    if (this.selectedPanelKey !== key) {
      this.selectedPanelKey = key;
      const cached = this.panelTextures.get(key);
      if (cached) {
        mat.map = cached;
        mat.needsUpdate = true;
      } else {
        mat.map = null;
        mat.needsUpdate = true;
        if (!this.pendingPanelKeys.has(key)) {
          this.pendingPanelKeys.add(key);
          this.panelTextureLoader.load(
            panelUrl(key),
            (t) => {
              t.colorSpace = THREE.SRGBColorSpace;
              t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
              this.panelTextures.set(key, t);
              this.pendingPanelKeys.delete(key);
              if (this.selectedPanelKey === key) {
                mat.map = t;
                mat.needsUpdate = true;
              }
            },
            undefined,
            () => { this.pendingPanelKeys.delete(key); },
          );
        }
      }
    }
    // 常驻显示：这块板子在阵列里也是「已经被选中/抬起」的那一块，
    // 只让它到详情页才有封面的话，阵列里最高的那块就是一张白板。
    panel.visible = true;
    // ★ 面片是 this.model 的子节点，detail 时 model 已经整体转向观众
    //   （见 model.rotation.y = yawToViewer）。这里再转一次就是转两遍：
    //   实测约 69° 侧对镜头 → 细笔立绘被斜角磨平成一纸空白，只剩竖排名和朱砂印。
    //   所以固定为 0，跟着板子走。
    panel.rotation.set(0, 0, 0);
  }
  /** 写第 i 个实例的展框 UV 矩形（从图集索引里取）。 */
  private writePanelUv(index: number, cell: ArchiveCell) {
    if (!this.panelUvUpdate || !this.panelAtlasMeta) return;
    const record = records[fileAtCell(cell)];
    if (!record) return;
    const key = this.panelKeyOf(record);
    const uv = key ? this.panelAtlasMeta.uv[key] : undefined;
    const o = index * 4;
    if (uv) {
      this.panelUvUpdate.set(o, [uv.u0, uv.v0, uv.u1, uv.v1]);
    } else {
      this.panelUvUpdate.set(o, [0, 0, 0, 0]);
    }
  }
  private setPanelVisible(group: THREE.Group, visible: boolean) {
    for (const child of group.children) {
      if (!child.userData.keepVisible) continue;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = visible ? 1 : 0;
      mat.transparent = !visible;
    }
  }
  private emitPulse(cell: ArchiveCell) {
    this.pulses.push({ ...cell, time: this.clock });
    this.pulses = this.pulses.slice(-6);
  }
  /**
   * 面板标签贴图：换成我们的「展框」图（手绘立绘 + 朱砂印章 + 竖排题签）。
   * 原实现是程序化绘制 RHINE LAB 的印刷标签；这里改为按档案索引加载
   * public/assets/sixiang/panels/{key}.jpg。
   */
  private drawLabel(index: number) {
    const record = records[index];
    if (!record) return;
    const key = this.panelKeyOf(record);
    if (!key) return;
    const url = panelUrl(key);
    // 同一张图已经在缓存里就不重复加载
    if (this.labelUrl === url) return;
    this.labelUrl = url;
    const token = ++this.labelToken;
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (token !== this.labelToken) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        const previous = this.labelTexture;
        this.labelTexture = tex;
        if (this.labelMesh) {
          const mat = this.labelMesh.material as THREE.MeshBasicMaterial;
          mat.map = tex;
          mat.needsUpdate = true;
        }
        previous?.dispose();
      },
      undefined,
      () => {
        // 贴图缺失时静默退回（面板保持空白即可）
      },
    );
  }
  /** 档案 → 展框贴图文件名：与 content/archives.json 的顺序一致，取神兽的拼音 key。 */
  private panelKeyOf(record: (typeof records)[number]): string | null {
    const raw = record.en ?? "";
    // ★ 去重音符号：素材里曾出现 HUASHÉ（é）→ key 变成 "huashé"，
    //   正则不认、文件也加载不了 → 这条档案直接没有封面。
    const key = raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, "_");
    return /^[a-z0-9_]+$/.test(key) ? key : null;
  }
  private ensureInstanceCapacity(required: number) {
    if (required <= this.instanceCapacity) return;
    const capacity = Math.max(required, this.instanceCapacity * 2);
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
    matrix.array.set(this.instances[0].instanceMatrix.array);
    for (const inst of this.instances) {
      inst.dispose();
      inst.instanceMatrix = matrix;
    }
    const previousTheme = this.themeAttribute;
    this.themeAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    if (previousTheme) this.themeAttribute.array.set(previousTheme.array);
    for (const inst of this.instances) inst.geometry.setAttribute("archiveTheme", this.themeAttribute);
    this.matrixUpdates = new InstanceUpdates(matrix);
    this.themeUpdates = new InstanceUpdates(this.themeAttribute);
    this.instanceCapacity = capacity;
  }
  resize() {
    this.renderState.invalidate();
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    const kind = this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout ?? "";
    const displayHeight = this.container.getBoundingClientRect().height;
    if (this.layoutKind === "cinematic" && kind !== "cinematic" && this.displayHeight > 0) {
      // Removing letterboxing starts from the same apparent model size. The
      // existing camera interpolation then carries it to the responsive anchor.
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * displayHeight / this.displayHeight,
      ));
    }
    this.displayHeight = displayHeight;
    this.layoutKind = kind;
    const dimensions = resizeQuality(
      this.renderer,
      this.composer,
      this.container,
      this.quality,
      this.superPerformance,
    );
    this.ao.setSize(
      Math.max(1, Math.floor(dimensions.width * this.quality.aoResolution)),
      Math.max(1, Math.floor(dimensions.height * this.quality.aoResolution)),
    );
    this.ao.setSharing(this.ao.enabled && this.bokeh.enabled && this.quality.aoResolution === 1 && !this.superPerformance);
    this.container.dataset.renderQuality = JSON.stringify({
      ...JSON.parse(this.container.dataset.renderQuality!),
      aoSamples: this.ao.enabled ? this.aoKernelSize : 0,
      aoWidth: this.ao.width,
      aoHeight: this.ao.height,
      shadows: this.renderer.shadowMap.enabled
        ? this.light.shadow.mapSize.x
        : 0,
      depthOfField: this.bokeh.enabled ? this.quality.depthOfField : 0,
    });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  private canBrowse() {
    return (
      this.presenceTarget === 1 &&
      this.looping &&
      !this.targetDetail &&
      this.detail < 0.2 &&
      this.reveal >= 0.8 &&
      this.loaded &&
      !this.container.closest("[inert]")
    );
  }
  // 悬停锚点：70 个盒子排得很密，同一个像素位置射线可能这次打中 A、下次打中 B，
  // 指针稍微抖一下就来回跳 → 屏上的名字「时不时变一下」。加个位移死区。
  private hoverAnchor = { x: 0, y: 0 };
  private setHover(cell: ArchiveCell | null) {
    if (
      (!cell && !this.hoverCell) ||
      (cell && this.hoverCell && sameCell(cell, this.hoverCell))
    )
      return;
    this.hoverCell = cell ? { ...cell } : null;
    this.onHover?.(cell ? fileAtCell(cell) : null);
  }
  private pickCell(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.cursor.set(
      ((x - r.left) / r.width) * 2 - 1,
      (-(y - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.cursor, this.camera);
    const hit = this.raycaster.intersectObjects(
      [this.instances[0], this.model, ...this.outgoing.map((o) => o.group)],
      true,
    )[0];
    if (!hit) return null;
    if (hit.instanceId !== undefined) return { ...this.drawnCells[hit.instanceId] };
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      const copy = this.outgoing.find((o) => o.group === object);
      if (copy) return { ...copy.cell };
      object = object.parent;
    }
    return { ...this.selectedCell };
  }
  private trackCoordinate(axis: DragAxis, value: number) {
    return axis === "lane"
      ? value / COLUMN_SPACING + 2
      : (-value - 2.17) / ROW_SPACING + 15.5;
  }
  private dragProjection(): DragProjection {
    this.model.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const center = this.model.localToWorld(new THREE.Vector3(0, 1.85, 0));
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = (motion: THREE.Vector3) => {
      const from = center
        .clone()
        .addScaledVector(motion, -0.5)
        .project(this.camera);
      const to = center
        .clone()
        .addScaledVector(motion, 0.5)
        .project(this.camera);
      return {
        x: ((to.x - from.x) * rect.width) / 2,
        y: (-(to.y - from.y) * rect.height) / 2,
      };
    };
    // Positive navigation moves the array along -X for columns and -Z for rows.
    return {
      lane: project(new THREE.Vector3(-COLUMN_SPACING, 0, 0)),
      row: project(new THREE.Vector3(0, 0, -ROW_SPACING)),
    };
  }
  private trackPosition(axis: DragAxis, coordinate: number) {
    return axis === "lane"
      ? (coordinate - 2) * COLUMN_SPACING
      : -2.17 - (coordinate - 15.5) * ROW_SPACING;
  }
  private navigatePlane(coordinate: DragPosition) {
    const goal = { lane: Math.round(coordinate.lane), row: Math.round(coordinate.row) };
    if (sameCell(goal, this.selectedCell)) return;
    const from = { ...this.selectedCell };
    const steps = Math.min(64, Math.max(Math.abs(goal.lane - from.lane), Math.abs(goal.row - from.row)));
    this.navigatingDrag = true;
    try {
      // Select physical cells along the travelled segment in one update per cell.
      // Column memory is updated by onSelect, but never pulls a held plane away.
      for (let i = 1; i <= steps; i++) {
        const cell = {
          lane: Math.round(from.lane + (goal.lane - from.lane) * i / steps),
          row: Math.round(from.row + (goal.row - from.row) * i / steps),
        };
        if (!sameCell(cell, this.selectedCell)) this.onSelect?.(fileAtCell(cell), cell);
      }
    } finally {
      this.navigatingDrag = false;
    }
  }
  private stopMomentum() {
    if (this.archiveMomentum) {
      this.columnCamera.velocity = 0;
      this.rail.velocity = 0;
    }
    this.archiveMomentum = null;
  }
  private bindPointer() {
    const canvas = this.renderer.domElement;
    let activePointer: number | null = null;
    let previousX = 0,
      startX = 0,
      startY = 0,
      moved = false;
    let browse = false,
      cancelled = false;
    let startTrack = { lane: 0, row: 0 };
    let wheelTotal = 0,
      wheelTime = 0;
    const pointers = new Set<number>();
    const hover = (e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType'>) => {
      if (
        e.pointerType !== "mouse" ||
        !this.canBrowse() ||
        this.archiveMomentum
      )
        return;
      const r = canvas.getBoundingClientRect();
      this.pointer.set(
        (e.clientX - r.left) / r.width - 0.5,
        (e.clientY - r.top) / r.height - 0.5,
      );
      const cell = this.pickCell(e.clientX, e.clientY);
      // ★ 死区（10px）：指针还贴在原来那块附近时，**换块和打空都不算**。
      //   板与板之间有缝隙，鼠标微动会让射线漏过去命中空气 →
      //   标签先消失再出现，看起来就是「字时不时变一下」。
      if (this.hoverCell) {
        const moved = Math.hypot(e.clientX - this.hoverAnchor.x, e.clientY - this.hoverAnchor.y);
        if (moved < 10 && (!cell || !sameCell(cell, this.hoverCell))) return;
      }
      this.hoverAnchor = { x: e.clientX, y: e.clientY };
      this.setHover(cell);
      canvas.style.cursor = cell ? "pointer" : "grab";
    };
    this.flushHover = () => {
      const sample = this.pendingHover;
      this.pendingHover = null;
      if (sample) hover(sample);
    };
    const reset = () => {
      this.pendingHover = null;
      const id = activePointer;
      activePointer = null;
      this.dragging = false;
      this.dragTrack = null;
      this.holdingArchive = false;
      browse = false;
      this.setHover(null);
      canvas.style.cursor = this.canBrowse() ? "grab" : "default";
      if (id !== null && canvas.hasPointerCapture(id))
        canvas.releasePointerCapture(id);
    };
    this.cancelPointer = () => {
      cancelled = true;
      this.stopMomentum();
      pointers.clear();
      wheelTotal = 0;
      reset();
    };
    const moveArchive = (e: PointerEvent) => {
      const pending = !this.archiveDrag.active;
      for (const sample of e.getCoalescedEvents?.() ?? []) {
        this.archiveDrag.move(sample.clientX, sample.clientY, sample.timeStamp);
      }
      this.archiveDrag.move(e.clientX, e.clientY, e.timeStamp);
      moved ||= this.archiveDrag.moved;
      if (!this.archiveDrag.active) return;
      if (pending) {
        startTrack = { lane: this.columnCamera.value, row: this.rail.value };
      }
      this.setHover(null);
      this.lastInteraction = this.clock;
      canvas.style.cursor = "grabbing";
      this.dragTrack = {
        lane: startTrack.lane + this.archiveDrag.value.lane * COLUMN_SPACING,
        row: startTrack.row - this.archiveDrag.value.row * ROW_SPACING,
      };
      this.columnCamera.value = this.dragTrack.lane;
      this.rail.value = this.dragTrack.row;
      this.columnCamera.velocity = this.rail.velocity = 0;
      this.navigatePlane({
        lane: this.trackCoordinate("lane", this.columnCamera.value),
        row: this.trackCoordinate("row", this.rail.value),
      });
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (!this.canBrowse() && !this.canInspect) return;
      this.pendingHover = null;
      pointers.add(e.pointerId);
      if (pointers.size > 1) {
        cancelled = true;
        reset();
        return;
      }
      activePointer = e.pointerId;
      cancelled = false;
      moved = this.archiveMomentum !== null;
      startX = previousX = e.clientX;
      startY = e.clientY;
      browse = this.canBrowse();
      this.stopMomentum();
      if (browse) {
        this.columnCamera.velocity = 0;
        this.rail.velocity = 0;
      }
      this.holdingArchive = browse;
      this.dragging = !browse && this.canInspect;
      startTrack = { lane: this.columnCamera.value, row: this.rail.value };
      this.archiveDrag.start(e.clientX, e.clientY, this.dragProjection(), e.timeStamp);
      this.setHover(null);
      canvas.setPointerCapture(e.pointerId);
      if (this.relayActive) { this.holdingArchive = false; this.dragging = false; }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointermove", (e) => {
      if (this.relayActive) {
        if (e.pointerId === activePointer) moved ||= Math.hypot(e.clientX - startX, e.clientY - startY) > 7;
        return;
      }
      if (activePointer !== null && e.pointerId !== activePointer) return;
      if (activePointer === null) {
        // Coalesce uncaptured hover only; dragging and release velocity stay immediate.
        this.pendingHover = { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType };
        return;
      }
      if (cancelled) return;
      moved ||= Math.hypot(e.clientX - startX, e.clientY - startY) > 7;
      if (browse) {
        if (!this.canBrowse()) {
          this.cancelPointer();
          return;
        }
        moveArchive(e);
        return;
      }
      if (this.dragging && this.canInspect) {
        this.targetRotation = THREE.MathUtils.clamp(
          this.targetRotation + (e.clientX - previousX) * 0.004,
          -0.8,
          0.8,
        );
        previousX = e.clientX;
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId !== activePointer) return;
      if (this.relayActive) {
        if (!cancelled && !moved) { const cell = this.pickCell(e.clientX, e.clientY); this.onRelayPick?.(cell ? cellKey(cell) : null); }
        reset(); return;
      }
      if (!cancelled && browse && this.canBrowse()) {
        moveArchive(e);
        if (this.archiveDrag.active) {
          if (this.motion.dragMomentum) {
            this.archiveMomentum = {
              time: performance.now() / 1000,
              motion: new ArchivePlaneMomentum(
                { lane: this.trackCoordinate("lane", this.columnCamera.value), row: this.trackCoordinate("row", this.rail.value) },
                this.archiveDrag.releaseVelocity(e.timeStamp, false),
              ),
            };
          }
        } else if (!moved) {
          const cell = this.pickCell(e.clientX, e.clientY);
          if (cell) this.onSelect?.(fileAtCell(cell), cell);
        }
      }
      reset();
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) {
        cancelled = true;
        reset();
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("lostpointercapture", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) {
        cancelled = true;
        reset();
      }
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener("pointerleave", () => {
      this.pendingHover = null;
      this.pointer.set(0, 0);
      this.setHover(null);
    }, { signal: this.inputEvents.signal });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (this.relayActive) { e.preventDefault(); return; }
        if (
          !this.canBrowse() ||
          activePointer !== null ||
          e.ctrlKey ||
          Math.abs(e.deltaX) > Math.abs(e.deltaY)
        )
          return;
        e.preventDefault();
        if (this.archiveMomentum) this.stopMomentum();
        const now = performance.now();
        const delta = THREE.MathUtils.clamp(
          e.deltaY *
            (e.deltaMode === 1
              ? 40
              : e.deltaMode === 2
                ? canvas.clientHeight
                : 1),
          -300,
          300,
        );
        if (now - wheelTime > 180 || Math.sign(delta) !== Math.sign(wheelTotal))
          wheelTotal = 0;
        wheelTime = now;
        wheelTotal += delta;
        const steps = Math.min(3, Math.floor(Math.abs(wheelTotal) / 100));
        if (!steps) return;
        const direction = Math.sign(wheelTotal);
        wheelTotal -= direction * steps * 100;
        this.navigatingDrag = true;
        try {
          for (let i = 0; i < steps; i++) this.onNavigate?.("row", direction);
        } finally {
          this.navigatingDrag = false;
        }
      },
      { ...{ passive: false }, signal: this.inputEvents.signal },
    );
    window.addEventListener("blur", () => this.cancelPointer(), { signal: this.inputEvents.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelPointer();
    }, { signal: this.inputEvents.signal });
    window.addEventListener("resize", () => this.cancelPointer(), { signal: this.inputEvents.signal });
    // After multi-touch cancels capture, a finger can finish outside the canvas.
    window.addEventListener("pointerup", (e) => pointers.delete(e.pointerId), { signal: this.inputEvents.signal });
    window.addEventListener("pointercancel", (e) =>
      pointers.delete(e.pointerId), { signal: this.inputEvents.signal }
    );
  }
  update(
    time: number,
    cinematic?: { reveal: number; lift: number; zoom: number; time: number },
  ) {
    const elapsed = Math.max(0, time - this.last || 0.016);
    const dt = Math.min(elapsed, 0.05);
    this.last = time;
    this.clock = time;
    if (!this.loaded) return;
    this.flushHover();
    const step = !this.motion.surfaceTransitions ? 1 : Math.min(elapsed, .25) / 1.1;
    this.presence += Math.sign(this.presenceTarget - this.presence) * Math.min(step, Math.abs(this.presenceTarget - this.presence));
    this.renderer.domElement.style.opacity = String(THREE.MathUtils.clamp(this.presence / .16, 0, 1));
    this.theme.beginFrame();
    themeEnvironment(this.scene, this.renderer, this.themeAmount);
    const blend = 1 - Math.exp(-dt * (this.motion.selectionTransition ? 2.8 : 35));
    const detailBlend = 1 - Math.exp(-dt * (this.motion.detailTransition ? 2.8 : 35));
    this.reveal = cinematic
      ? cinematic.reveal
      : THREE.MathUtils.lerp(this.reveal, this.targetReveal, blend);
    this.rotation = this.targetDetail
      ? THREE.MathUtils.lerp(this.rotation, this.targetRotation, detailBlend)
      : returnStep(this.rotation, dt, !this.motion.detailTransition);
    const shot = cinematic?.time ?? 29.1;
    if (cinematic) {
      this.scanTime = shot;
      this.scanBlend = 1;
    } else {
      this.scanTime += dt;
      this.scanBlend *= Math.exp(-dt * 3);
    }
    if (!this.canBrowse()) {
      this.setHover(null);
      if (this.holdingArchive || this.archiveMomentum) this.cancelPointer();
    }
    if (this.looping && !cinematic && !this.holdingArchive && !this.archiveMomentum) this.rebaseCoordinates();
    const momentum = !cinematic ? this.archiveMomentum : null;
    if (momentum) {
      momentum.motion.step(Math.min(Math.max(time - momentum.time, 0), 0.25));
      momentum.time = time;
      this.navigatePlane(momentum.motion.value);
      this.lastInteraction = time;
    }
    const hoverKey = !cinematic && this.hoverCell ? cellKey(this.hoverCell) : null;
    if (hoverKey && !this.hoverLifts.has(hoverKey)) this.hoverLifts.set(hoverKey, 0);
    for (const [key, value] of this.hoverLifts) {
      const target = key === hoverKey ? 0.28 : 0;
      const next = cinematic ? 0 : !this.motion.selectionTransition ? target : THREE.MathUtils.lerp(value, target, 1 - Math.exp(-dt * 14));
      if (target === 0 && next < 0.0001) this.hoverLifts.delete(key);
      else this.hoverLifts.set(key, next);
    }
    const hoverLift = (cell: ArchiveCell) => this.hoverLifts.get(cellKey(cell)) ?? 0;
    const chosen = this.cellPosition(this.selectedCell);
    const selectedRow = this.selectedCell.row;
    const selectedLane = this.selectedCell.lane;
    damp(this.shoulder, selectedRow, this.motion.selectionTransition ? 5 : 35, dt);
    damp(this.laneFocus, selectedLane, this.motion.selectionTransition ? 4 : 35, dt);
    // A held or freely coasting plane owns both tracks; selection cannot pull it.
    if (!this.holdingArchive && !momentum) {
      damp(this.columnCamera, chosen.x, this.motion.selectionTransition ? 3.7 : 35, dt);
      damp(this.rail, cinematic ? 0 : -2.17 - chosen.z, this.motion.selectionTransition ? 3.7 : 35, dt);
    }
    if (momentum) {
      this.columnCamera.value = this.trackPosition("lane", momentum.motion.lane.value);
      this.rail.value = this.trackPosition("row", momentum.motion.row.value);
      this.columnCamera.velocity = momentum.motion.lane.velocity * COLUMN_SPACING;
      this.rail.velocity = -momentum.motion.row.velocity * ROW_SPACING;
      if (momentum.motion.phase === "idle") this.archiveMomentum = null;
    }
    if (this.dragTrack && !cinematic) {
      this.columnCamera.value = this.dragTrack.lane;
      this.rail.value = this.dragTrack.row;
      this.columnCamera.velocity = this.rail.velocity = 0;
    }
    if (cinematic) {
      this.rail.value = 0;
      this.rail.velocity = 0;
      this.lift.value = extraction(shot);
      this.lift.velocity = 0;
      this.shoulder.value = selectedRow;
      this.laneFocus.value = selectedLane;
      this.laneFocus.velocity = 0;
      this.columnCamera.value = chosen.x;
      this.columnCamera.velocity = 0;
    }
    // Keep the illuminated set near the origin. Lateral navigation is a track
    // movement of the whole array, just like the existing front/back rail.
    const trackX = cinematic ? 0 : this.columnCamera.value;
    this.pulses = this.pulses.filter((p) => time - p.time < 3.2);
    const aligningCopy = this.outgoing.some((o) => o.returnY !== null);
    const idle =
      !cinematic &&
      this.motion.idleWave &&
      this.targetReveal > 0 &&
      !this.targetDetail &&
      this.detail < 0.01 &&
      this.returnY === null &&
      !aligningCopy &&
      time - this.lastInteraction > 2.5;
    this.idleGain = cinematic
      ? 0
      : THREE.MathUtils.lerp(
          this.idleGain,
          idle ? (this.playfield.enabled ? (this.playfield.breathing && !this.relayActive ? 1 - this.playfield.bands.activity : 0) : 1) : 0,
          1 - Math.exp(-dt * (idle ? 0.8 : 4)),
        );
    this.pulseGain = THREE.MathUtils.lerp(
      this.pulseGain,
      this.targetDetail || this.returnY !== null || aligningCopy ? 0 : 1,
      1 - Math.exp(-dt * 8),
    );
    const play = this.playfield;
    const activePlay = !cinematic && !this.targetDetail && play.enabled;
    const rhythm = this.rhythm.update(activePlay && !this.reduced ? play.bands : quietBands(), time, dt, this.rhythmStyle);
    this.flatMix += ((activePlay ? play.flatten : 0) - this.flatMix) * (this.reduced ? 1 : 1 - Math.exp(-dt * 4));
    this.subduedIndex.value = Math.max(Number(this.selectedIndexOnly), this.flatMix);
    const indexDim = (lift: number) => this.selectedIndexOnly
      ? 1 - ease(lift / .4) * (1 - this.flatMix)
      : this.flatMix;
    const gameTarget = activePlay ? play.target : null;
    if (gameTarget && !this.relayLifts.has(gameTarget)) this.relayLifts.set(gameTarget, 0);
    for (const [key, height] of this.relayLifts) {
      const next = height + ((key === gameTarget ? .95 : 0) - height) * (this.reduced ? 1 : 1 - Math.exp(-dt * 8));
      if (next < .001 && key !== gameTarget) this.relayLifts.delete(key); else this.relayLifts.set(key, next);
    }
    const spectrumPoint = new THREE.Vector3();
    const screenX = (row: number, lane: number) => {
      spectrumPoint.set((lane - 2) * COLUMN_SPACING - trackX, -4.6, (row - 15.5) * ROW_SPACING + this.rail.value).project(this.camera);
      return (spectrumPoint.x + 1) / 2;
    };
    const fieldCache = new Map<number, Map<number, number>>();
    const calculateField = (row: number, lane: number) => {
      if (cinematic)
        return cinematicField(
          row,
          lane,
          shot,
          this.shoulder.value,
          this.laneFocus.value,
        );
      const height =
        archiveWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          this.scanTime,
        ) *
          this.scanBlend;
      const breathing = idleWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          time,
        ) *
          this.idleGain;
      let pulseHeight = 0;
      if (!cinematic && this.motion.selectionWave) {
        let ripple = 0;
        for (const p of this.pulses) {
          const distance = Math.hypot(row - p.row, (lane - p.lane) * 2.2);
          const age = time - p.time;
          ripple +=
            this.selectionPulse(distance, age) *
            (this.deferSelectionPulse ? rippleEnvelope(distance, age) : 1);
        }
        pulseHeight = THREE.MathUtils.clamp(ripple, -0.6, 0.6) * this.pulseGain;
      }
      const distance = row - this.shoulder.value;
      return (
        (height +
        settlingWave(distance, 26.56) *
          columnStrength(lane, this.laneFocus.value)) * (1 - this.flatMix) + breathing + pulseHeight +
        (activePlay && !this.reduced ? rhythmDisplacement(row, lane, time, play.bands, play.strength, rhythm, screenX(row, lane)) : 0) +
        (this.relayLifts.get(cellKey({ row, lane })) ?? 0)
      );
    };
    const field = (row: number, lane: number): number => {
      let values = fieldCache.get(lane);
      if (!values) { values = new Map(); fieldCache.set(lane, values); }
      const previous = values.get(row);
      if (previous !== undefined) return previous;
      const value = calculateField(row, lane);
      values.set(row, value);
      return value;
    };
    const selectedBase = chosen.y + field(selectedRow, selectedLane);
    if (!cinematic) {
      if (this.returnY !== null && this.rotation !== 0) {
        this.lift.value = this.returnY - selectedBase;
        this.lift.velocity = 0;
      } else {
        this.returnY = null;
        damp(
          this.lift,
          this.targetDetail
            ? INSPECTION_LIFT
            : this.outgoing.some(
                  (o) =>
                    o.returnY !== null &&
                    o.cell.lane === selectedLane &&
                    Math.abs(o.cell.row - selectedRow) < 5,
                )
              ? 0
              : 0.4 * this.targetReveal * (1 - this.flatMix),
          !this.motion.detailTransition
            ? 35
            : this.deferSelectionPulse &&
                !this.targetDetail &&
                this.lift.value < 0.4
              ? 7.6
              : 4.2,
          dt,
        );
      }
    }
    const cameraTarget = this.targetDetail
      ? ease((this.lift.value - 0.8) / 2.4)
      : this.returnY !== null
        ? this.detail
        : ease((this.lift.value - 0.4) / (INSPECTION_LIFT - 0.4));
    this.detail = cinematic
      ? cinematic.zoom
      : THREE.MathUtils.lerp(this.detail, cameraTarget, detailBlend);
    const detail = this.detail;
    // Keep the physical decryption timeline alive even when its model visuals
    // are disabled; the document mask uses the same timeline independently.
    this.decryption.update(dt, detail > .78 && this.lift.value > 3.3, false,
      cinematic ? shot + 5 : undefined);
    this.appearance.apply(this.model, ease(this.lift.value / 0.4));
    this.appearance.setClarity(this.model, this.modelClarity());
    // Reference 26.92–27.76: the array travels horizontally into a white field.
    const entry = cinematic ? ease((shot - 21.9) / 0.86) : this.reveal;
    const entranceTime = THREE.MathUtils.clamp((shot - 21.92) / 0.75, 0, 1);
    const entryZ = cinematic
      ? -23 * (1 - entranceTime) ** 2
      : -28 * (1 - entry);
    for (let i = this.outgoing.length - 1; i >= 0; i--) {
      const o = this.outgoing[i];
      const p = this.cellPosition(o.cell);
      const baseY = p.y + field(o.cell.row, o.cell.lane);
      o.group.rotation.y = returnStep(o.group.rotation.y, dt, !this.motion.detailTransition);
      if (o.returnY !== null) {
        o.lift.value = o.returnY - baseY;
        o.lift.velocity = 0;
        if (o.group.rotation.y === 0) o.returnY = null;
      } else damp(o.lift, 0, this.motion.detailTransition ? 4.5 : 35, dt);
      o.group.position.set(
        p.x - trackX,
        baseY + o.lift.value + hoverLift(o.cell) - this.presentationDrop(o.cell),
        p.z + entryZ + this.rail.value,
      );
      const quality = ease(o.lift.value / 0.4);
      this.appearance.apply(o.group, quality);
      this.appearance.setTheme(o.group, this.theme.sample(o.cell, time), indexDim(o.lift.value));
      o.clarity = this.motion.modelDecryption ? o.clarity * Math.exp(-dt * 9) : 0;
      this.appearance.setClarity(o.group, o.clarity);
      const { row, lane } = o.cell;
      o.group.rotation.x =
        (field(row + 0.5, lane) - field(row - 0.5, lane)) *
        0.024 *
        (1 - detail) *
        (1 - quality);
      if (o.lift.value < 0.0001 && Math.abs(o.group.rotation.y) < 0.0001) {
        this.scene.remove(o.group);
        this.appearance.dispose(o.group);
        this.outgoing.splice(i, 1);
      }
    }
    if (
      this.pendingPulse &&
      !cinematic &&
      !this.targetDetail &&
      this.targetReveal
    ) {
      const selectedY = selectedBase + this.lift.value;
      const oldCardsLower = this.outgoing.every(
        (old) =>
          old.cell.lane !== selectedLane ||
          Math.abs(old.cell.row - selectedRow) > 4 ||
          old.group.position.y + 0.015 < selectedY,
      );
      // The new file causes the wave: finish most of its rise and let nearby
      // outgoing files get below it before starting the outward pulse.
      if (this.lift.value >= 0.35 && this.returnY === null && oldCardsLower) {
        if (this.motion.selectionWave) this.emitPulse(this.pendingPulse);
        this.pendingPulse = null;
      }
    }
    this.appearance.setTheme(this.model, this.theme.sample(this.selectedCell, time), indexDim(this.lift.value));
    // ★ 展框：抽出的那块显示它的展框图
    this.updateSelectedPanel(this.selectedCell);
    this.model.position.set(
      chosen.x - trackX,
      chosen.y + field(selectedRow, selectedLane) + this.lift.value + hoverLift(this.selectedCell) - this.presentationDrop(this.selectedCell),
      chosen.z + entryZ + this.rail.value,
    );
    // Extraction only changes elevation. Reframing belongs to the camera.
    // ★ 展框改造：detail（抽出查看）时把板子**转向观众**，
    //   让大面（法线沿 ±Z）的展框图正对相机。
    //   阵列视角完全不变 —— 只动被抽出的这一块。
    const toViewer = detail * (1 - (cinematic ? 1 : 0));
    const yawToViewer = Math.atan2(
      this.camera.position.x - this.model.position.x,
      this.camera.position.z - this.model.position.z,
    );
    this.model.rotation.set(
      (field(selectedRow + 0.5, selectedLane) -
        field(selectedRow - 0.5, selectedLane)) *
        0.024 *
        (1 - detail) *
        (1 - ease(this.lift.value / 0.4)),
      cinematic ? 0 : (this.rotation * (1 - toViewer) + yawToViewer * toViewer),
      0,
    );
    // Measured from frame 787: X edge (382,-204), adjacent row (78,38).
    // The label vertical edge constrains height; the file base is occluded.
    // Do not calibrate field of view from the visible fragment of a file.
    const orbit = ease((shot - 22.6) / 1.6);
    const settle = ease((shot - 24.25) / 2.25);
    const yaw = THREE.MathUtils.degToRad(89 - 22 * orbit - 8 * settle);
    const elevation = THREE.MathUtils.degToRad(
      3 + 40 * ease((shot - 21.96) / 0.22) - 8 * orbit - 16 * settle,
    );
    const span = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(10.8, 10.3, orbit),
      7.33,
      settle,
    );
    const responsiveOpening = Boolean(cinematic) && this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "opening";
    const openingAspect = responsiveOpening ? this.container.clientWidth / this.container.clientHeight / (16 / 9) : 1;
    const openingSpan = (value: number) => value / Math.min(1, openingAspect);
    const distance = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(28 + 7 * orbit, 140, settle),
      72,
      detail,
    );
    const arrayAim = new THREE.Vector3(
      -1.091,
      THREE.MathUtils.lerp(-2.55 + 0.4 * orbit, -0.045, settle),
      THREE.MathUtils.lerp(2.48, 0.481, settle),
    );
    const cameraAim = arrayAim.clone();
    const viewDirection = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    );
    if (cinematic) {
      const earlyTurn = ease((shot - 27.3) / 1.3);
      const finalTurn = ease((shot - 28.6) / 5.4);
      const shotYaw =
        yaw - THREE.MathUtils.degToRad(9 * earlyTurn + 32 * finalTurn);
      const shotElevation =
        elevation - THREE.MathUtils.degToRad(1.5 * earlyTurn + 3.7 * finalTurn);
      viewDirection.set(
        -Math.sin(shotYaw) * Math.cos(shotElevation),
        Math.sin(shotElevation),
        Math.cos(shotYaw) * Math.cos(shotElevation),
      );
    } else {
      viewDirection
        .lerp(new THREE.Vector3(-0.277, 0.238, 0.931), detail)
        .normalize();
    }
    if (cinematic) {
      const pan = ease((shot - 25.4) / 0.95);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      cameraAim.addScaledVector(
        right,
        -2.05 * (1 - pan) * ease((shot - 24.2) / 0.8),
      );
    }
    if (cinematic && shot >= 25.05 && shot <= 27.3) {
      // Frames 760–785: the camera carries the same physical column from the
      // right into the selected position while the neighboring crests subside.
      const pan = ease((shot - 25.4) / 1.05);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const pixelScale = 1080 / openingSpan(span);
      const anchorAim = this.model.position
        .clone()
        .add(new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(
        right,
        -(THREE.MathUtils.lerp(840, 518, pan) - 960) * openingAspect / pixelScale,
      );
      anchorAim.addScaledVector(
        up,
        -(540 - THREE.MathUtils.lerp(340, 288, pan)) / pixelScale,
      );
      cameraAim.lerp(anchorAim, ease((shot - 25.05) / 0.35));
    }
    if (cinematic && shot > 27.3) {
      const close = ease((shot - 27.3) / 6.7);
      const extractionCamera = ease((shot - 27.3) / 1.25);
      const screenX = THREE.MathUtils.lerp(
        518 - 98 * extractionCamera,
        618,
        close,
      );
      const screenY = THREE.MathUtils.lerp(
        296 + 34 * extractionCamera,
        287,
        close,
      );
      const pixelScale = 1080 / openingSpan(THREE.MathUtils.lerp(span, 5.9, detail));
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const anchorAim = this.model.position
        .clone()
        .add(new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(right, -(screenX - 960) * openingAspect / pixelScale);
      anchorAim.addScaledVector(up, -(540 - screenY) / pixelScale);
      cameraAim.lerp(anchorAim, ease((shot - 27.3) / 0.5));
    }
    const framing = archiveFraming(this.container.clientWidth, this.container.clientHeight, span, detail,
      this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "compact");
    if (!cinematic) {
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const width = this.container.clientWidth, height = this.container.clientHeight;
      const pixelScale = height / framing.span;
      if (framing.portrait) {
        // Keep the preview camera independent of the live lift, wave and rail.
        // Following model.position here would visually cancel those motions.
        const previewAim = new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * height / pixelScale);
        cameraAim.copy(previewAim);
      }
      const detailAim = this.model.position
        .clone()
        .add(new THREE.Vector3(0, 1.85, 0));
      detailAim.addScaledVector(right, (0.5 - framing.detailX) * width / pixelScale);
      detailAim.addScaledVector(up, (framing.detailY - 0.5) * height / pixelScale);
      cameraAim.lerp(detailAim, detail);
    }
    const cameraPosition = cameraAim
      .clone()
      .addScaledVector(viewDirection, distance);
    if (!cinematic && this.motion.pointerParallax && !this.uiOnlyParallax) {
      cameraPosition.x += this.pointer.x * 0.12;
      cameraPosition.y -= this.pointer.y * 0.12;
    }
    const cameraTransition = this.targetDetail || this.detail > 0.01
      ? this.motion.detailTransition
      : this.motion.selectionTransition;
    const cameraBlend = cinematic ? 1 : cameraTransition ? 1 - Math.exp(-dt * 5) : 1;
    this.camera.position.lerp(cameraPosition, cameraBlend);
    this.cameraAim.lerp(cameraAim, cameraBlend);
    this.camera.lookAt(this.cameraAim);
    this.camera.fov = THREE.MathUtils.lerp(
      this.camera.fov,
      THREE.MathUtils.radToDeg(
        2 * Math.atan((cinematic ? openingSpan(THREE.MathUtils.lerp(span, 5.9, detail)) : framing.span) / (2 * distance)),
      ),
      cameraBlend,
    );
    const fog = this.scene.fog as THREE.Fog;
    // The camera position is damped after its target distance changes. Anchor
    // fog to the rendered camera, or entry puts the array behind the far plane
    // until the camera catches up (a brief white wash that exit never showed).
    const renderedDistance = this.camera.position.distanceTo(this.cameraAim);
    const fogTheme = this.themeAmount;
    fog.near = renderedDistance + THREE.MathUtils.lerp(5 - 4 * fogTheme, -1, detail);
    fog.far = renderedDistance + THREE.MathUtils.lerp(25 - 9 * fogTheme, 12, detail);

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    // Music can depend on projected X; invalidate after the camera advances.
    if (activePlay && !this.reduced) fieldCache.clear();
    // Build and compact the instance set only after the actual damped camera
    // is final for this frame. Picking uses the same packed index-to-cell map.
    const fixed = (Boolean(cinematic) || !this.looping) && !responsiveOpening;
    this.cells = fixed ? Array.from({ length: 160 }, (_, i) => poolCell(i))
      : this.visibility.update(this.camera, fog.far, trackX, entryZ + this.rail.value, this.extraCoverage);
    const hidden = new Set(this.outgoing.map(o => cellKey(o.cell)));
    hidden.add(cellKey(this.selectedCell));
    this.drawnCells = [];
    this.relayPoints.clear();
    this.drawCoverage.update(this.camera);
    this.shadowCoverage?.begin();
    this.matrixUpdates ??= new InstanceUpdates(this.instances[0].instanceMatrix);
    if (this.themeAttribute) this.themeUpdates ??= new InstanceUpdates(this.themeAttribute);
    for (const cell of this.cells) {
      const { row, lane } = cell;
      if (hidden.has(cellKey(cell))) continue;
      const x = (lane - 2) * COLUMN_SPACING - trackX;
      const y = -4.6 + field(row, lane) + hoverLift(cell) - this.presentationDrop(cell);
      const z = (row - 15.5) * ROW_SPACING + entryZ + this.rail.value;
      if (!fixed && !this.visibility.intersects(x, y, z)) continue;

      const slope = field(row + .5, lane) - field(row - .5, lane);
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(slope * .024 * (1 - detail), 0, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      if (play.enabled) this.relayPoints.set(cellKey(cell), { cell: { ...cell }, point: new THREE.Vector3(0, 3.5, 0).applyMatrix4(this.dummy.matrix) });
      this.shadowCoverage?.add(this.dummy.matrix);
      if (!this.drawCoverage.contains(x, y, z)) continue;
      const i = this.drawnCells.length;
      this.ensureInstanceCapacity(i + 1);
      this.drawnCells.push(cell);
      this.themeUpdates?.scalar(i, this.theme.sample(cell, time));
      this.matrixUpdates!.set(i * 16, this.dummy.matrix.elements);
      // ★ 展框图集：把本实例对应的 UV 矩形写进去
      this.writePanelUv(i, cell);
    }
    const countChanged = this.instances[0].count !== this.drawnCells.length;
    const visibleMatricesChanged = this.matrixUpdates!.commit();
    const shadowMatricesChanged = this.shadowCoverage?.commit() ?? false;
    const matricesChanged = visibleMatricesChanged || shadowMatricesChanged;
    for (const inst of this.instances) {
      inst.count = this.drawnCells.length;
    }
    // Picking uses only the first instanced surface. The other batches disable
    // renderer culling and do not need an O(n) bound recomputation each frame.
    if (matricesChanged || countChanged || !this.instances[0].boundingSphere) this.instances[0].computeBoundingSphere();
    this.themeUpdates?.commit();
    this.panelUvUpdate?.commit();
    let neighborTop = -Infinity;
    const lane = selectedLane,
      row = selectedRow;
    for (let r = row - 5; r <= row + 5; r++) {
      if (r !== row)
        neighborTop = Math.max(neighborTop, -4.6 + field(r, lane) + 3.76);
    }
    for (const o of this.outgoing) {
      if (o.cell.lane === lane && Math.abs(o.cell.row - row) <= 5) {
        neighborTop = Math.max(neighborTop, o.group.position.y + 3.76);
      }
    }
    this.clearance = this.model.position.y - neighborTop;
    this.canInspect =
      !cinematic &&
      Boolean(this.targetDetail) &&
      detail > 0.9 &&
      this.pulseGain < 0.01 &&
      this.clearance > 0.3;
    this.container.dataset.inspection =
      this.returnY !== null
        ? "aligning"
        : this.canInspect
          ? "ready"
          : this.targetDetail
            ? "lifting"
            : "preview";
    const focalPoint = this.model.position
      .clone()
      .add(new THREE.Vector3(0, 2, 0))
      .applyMatrix4(this.camera.matrixWorldInverse);
    const bokehUniforms = this.bokeh.uniforms as Record<
      string,
      { value: number }
    >;
    bokehUniforms.focus.value = -focalPoint.z;
    bokehUniforms.aperture.value =
      (THREE.MathUtils.lerp(0.0003, 0.0008, detail) *
        this.quality.depthOfField) /
      100;
    this.renderer.info.reset();
    // Keep all simulation and picking current. Reuse the composited canvas only
    // when its actual inputs are identical, including late textures and materials.
    const state = this.renderState;
    this.scene.updateMatrixWorld();
    // A changed instance buffer already proves the image changed. Avoid a
    // material/matrix snapshot on those busy frames; capture when it settles.
    if (matricesChanged || cinematic) {
      state.invalidate();
    } else {
      state.begin();
      state.floats(...this.camera.projectionMatrix.elements, ...this.camera.matrixWorldInverse.elements,
        ...this.camera.position.toArray(),
        fog.near, fog.far, this.themeAmount, this.subduedIndex.value,
        bokehUniforms.focus.value, bokehUniforms.aperture.value);
      this.scene.traverse(object => {
        state.add(object.id, Number(object.visible));
        if (!(object instanceof THREE.Mesh)) return;
        object.modelViewMatrix.multiplyMatrices(this.camera.matrixWorldInverse, object.matrixWorld);
        object.normalMatrix.getNormalMatrix(object.modelViewMatrix);
        state.floats(...object.modelViewMatrix.elements, ...object.normalMatrix.elements, ...object.matrixWorld.elements);
        const mat = object.material as THREE.MeshPhysicalMaterial;
        // Three increments material.version for its own double-sided transmission
        // passes. Track application-controlled inputs, not that render-side counter.
        state.add(object.geometry.id, mat.uuid, mat.map?.uuid, mat.map?.version ?? 0);
        state.floats(
          mat.opacity, mat.roughness, mat.metalness, mat.transmission, mat.thickness,
          mat.attenuationDistance, mat.clearcoat, mat.clearcoatRoughness,
          mat.color.r, mat.color.g, mat.color.b,
          mat.attenuationColor?.r ?? 0, mat.attenuationColor?.g ?? 0, mat.attenuationColor?.b ?? 0);
        for (const name of ['appearance', 'glassClarity', 'themeAmount', 'subduedIndex'])
          state.floats(object.userData[name]?.value ?? 0);
        if (object instanceof THREE.InstancedMesh)
          state.add(object.count, object.instanceMatrix.version, this.themeAttribute?.version ?? 0);
      });
      if (!state.end()) { this.reusedFrames++; return; }
    }
    this.renderedFrames++;
    const shadow = this.shadowState;
    shadow.begin();
    shadow.add(this.light.shadow.mapSize.x, Number(this.renderer.shadowMap.enabled));
    shadow.floats(...this.light.matrixWorld.elements, ...this.light.target.matrixWorld.elements);
    this.scene.traverseVisible(object => {
      if (!(object instanceof THREE.Mesh) || !object.castShadow) return;
      shadow.add(object.id, object.geometry.id);
      shadow.floats(...object.matrixWorld.elements);
      if (object instanceof THREE.InstancedMesh) shadow.add(object.count, object.instanceMatrix.version);
    });
    this.renderer.shadowMap.needsUpdate = shadow.end() || this.light.shadow.needsUpdate;
    if (this.superPerformance) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
  projectCard(x: number, y: number) {
    this.model.updateMatrixWorld(true);
    const p = this.model
      .localToWorld(new THREE.Vector3(x, y, 0.255))
      .project(this.camera);
    return [(p.x + 1) * this.container.clientWidth / 2, (1 - p.y) * this.container.clientHeight / 2];
  }
  get decryptionFrame() { return this.decryption.frame; }
  finishDecryption() { this.decryption.finish(); }
  get detailVisibility() {
    return ease((this.detail - 0.25) / 0.55);
  }
  getStats() {
    this.model.updateMatrixWorld(true);
    const project = (x: number, y: number, z: number) => {
      const p = this.model
        .localToWorld(new THREE.Vector3(x, y, z))
        .project(this.camera);
      return [Math.round((p.x + 1) * this.container.clientWidth / 2), Math.round((1 - p.y) * this.container.clientHeight / 2)];
    };
    return {
      decryption: { ...this.decryption.frame, clarity: this.decryption.clarity, modelClarity: this.modelClarity() },
      topLeft: project(-2.5, 3.7, 0),
      topRight: project(2.5, 3.7, 0),
      labelTopLeft: project(-1.855, 3.27, 0.255),
      labelBottomLeft: project(-1.855, 2.81, 0.255),
      modelPosition: this.model.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraPosition: this.camera.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      fieldOfView: this.camera.fov,
      loaded: this.loaded,
      drawCalls: this.renderer.info.render.calls,
      renderedFrames: this.renderedFrames,
      reusedFrames: this.reusedFrames,
      superPerformance: this.superPerformance,
      presentation: this.presence,
      triangles: this.renderer.info.render.triangles,
      archiveCount: this.drawnCells.length,
      archiveCandidates: this.cells.length,
      archiveCulled: this.cells.length - this.drawnCells.length,
      archiveCapacity: this.instanceCapacity,
      archiveCoverage: this.extraCoverage ? "extra" : "standard",
      returningFiles: this.outgoing.length,
      selectionPhase: this.pendingPulse
        ? "lifting"
        : this.pulses.length
          ? "wave"
          : "settled",
      pendingPulse: this.pendingPulse ? { ...this.pendingPulse } : null,
      pulses: this.pulses.map((pulse) => ({ ...pulse })),
      referenceTime: Math.round((this.scanTime + 5) * 100) / 100,
      selectedSlot: this.selectedSlot,
      selectedLane: Math.floor(this.selectedSlot / 32),
      selectedCell: { ...this.selectedCell },
      hoverCell: this.hoverCell ? { ...this.hoverCell } : null,
      hoverLifts: Object.fromEntries(this.hoverLifts),
      dragTrack: this.dragTrack ? { ...this.dragTrack } : null,
      archiveMomentum: this.archiveMomentum ? {
        phase: this.archiveMomentum.motion.phase,
        value: this.archiveMomentum.motion.value,
        velocity: this.archiveMomentum.motion.velocity,
      } : null,
      holdingArchive: this.holdingArchive,
      dragProjection: this.dragProjection(),
      dragMapping: this.archiveDrag.active ? "free" : null,
      coordinateOrigin: { ...this.coordinateOrigin },
      poolBounds: {
        minLane: Math.min(...this.cells.map((c) => c.lane)),
        maxLane: Math.max(...this.cells.map((c) => c.lane)),
        minRow: Math.min(...this.cells.map((c) => c.row)),
        maxRow: Math.max(...this.cells.map((c) => c.row)),
      },
      laneFocus: this.laneFocus.value,
      columnCamera: this.columnCamera.value,
      rotation: this.rotation,
      clearance: this.clearance,
      canInspect: this.canInspect,
      returnPhase: this.returnY !== null ? "aligning" : "lowering",
      extraction: Math.round(this.lift.value * 1000) / 1000,
      appearance: Math.round(ease(this.lift.value / 0.4) * 1000) / 1000,
      cameraDetail: Math.round(this.detail * 1000) / 1000,
      idleGain: this.idleGain,
      flatten: this.flatMix,
      spectrumActivity: this.playfield.bands.activity,
      selectedIndexDim: this.model.children.find(child => child.userData.surface === "Index_Inlay")?.userData.subduedIndex?.value,
      returningIndexDims: this.outgoing.map(o => ({ cell: o.cell, dim: o.group.children.find(child => child.userData.surface === "Index_Inlay")?.userData.subduedIndex?.value })),
      cameraDistance: this.camera.position.distanceTo(this.cameraAim),
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      fogNear: (this.scene.fog as THREE.Fog).near,
      fogFar: (this.scene.fog as THREE.Fog).far,
      returningAppearance: this.outgoing.map((o) => ({
        slot: o.slot,
        clarity: o.group.children.find(child => child.userData.surface === "Frosted_Polymer")?.userData.glassClarity?.value,
        cell: { ...o.cell },
        lift: o.lift.value,
        quality: ease(o.lift.value / 0.4),
        rotation: o.group.rotation.y,
        worldY: o.group.position.y,
        phase: o.returnY !== null ? "aligning" : "lowering",
      })),
      rail: Math.round(this.rail.value * 1000) / 1000,
    };
  }
}

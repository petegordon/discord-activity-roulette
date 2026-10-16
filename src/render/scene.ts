import * as THREE from "three";
import { pocketColor, POCKETS, WHEEL_ORDER } from "../game/rules";
import { BallPath, LAUNCH_ANGLE, pocketAngle, TRACK, WHEEL_FRICTION, type Hop, type SpinPlan } from "../wheel/spin";

/** Look down steeply on tall screens; a short, wide stage gets a lower, more side-on view so the wheel stays big. */
const PITCH_TALL = THREE.MathUtils.degToRad(55);
const PITCH_WIDE = THREE.MathUtils.degToRad(38);
const FOV = 36;
const TAU = Math.PI * 2;
const SEG = TAU / POCKETS;
/** How fast the wheel runs down once the ball has landed (per second). */
const POCKET_FRICTION = 0.45;

/** Radii and heights of the wheel's parts. TRACK (spin.ts) has the ones the ball uses. */
const R = {
  turret: 0.32,
  coneTop: 0.45,
  coneOuter: 1.72,
  pocketInner: 1.72,
  pocketOuter: 2.18,
  numberOuter: 2.62,
  trackInner: 2.62,
  trackOuter: 3.22,
  rimOuter: 3.62,
};
const Y = { pocketFloor: 0.05, numberRing: 0.12, trackInner: 0.27, trackOuter: 0.78, rimTop: 0.98 };

export type SpinCallbacks = {
  onHop: (hop: Hop) => void;
  /** ~every frame while the ball rolls: its speed in rad/s (0 once it stops). */
  onRoll: (speed: number) => void;
};

type BallMode =
  /** Waiting at the launch spot on the track. */
  | { kind: "hand"; blend: number; from: THREE.Vector3 }
  | { kind: "spinning"; path: BallPath; start: number; nextHop: number; cb: SpinCallbacks; done: () => void }
  /** In a pocket, riding the wheel. */
  | { kind: "pocket"; pocket: number };

/** Position on the wheel for angle `a` (see pocketAngle in spin.ts). */
const polar = (a: number, r: number, y: number, out = new THREE.Vector3()) => out.set(r * Math.sin(a), y, r * Math.cos(a));

/**
 * The 3D wheel. The stator (bowl, ball track, deflectors) stays still; the
 * rotor (cone, pockets, numbers, turret) turns about +Y. The ball is a
 * world-space object positioned from BallPath while it rolls.
 */
export class WheelScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
  private rotor = new THREE.Group();
  private ball: THREE.Mesh;
  private marker: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private clock = new THREE.Clock();
  /** rad, the rotor's rotation about +Y. */
  private angle = 0;
  /** rad/s. */
  private rate = 0;
  /** Where the spinner's twists want the wheel; the scene eases toward it. */
  private rateTarget: number | null = null;
  private ballMode: BallMode = { kind: "hand", blend: 1, from: new THREE.Vector3() };

  constructor(private readonly container: HTMLElement) {
    const lowPower = /Android|iPhone|iPad/i.test(navigator.userAgent) && Math.min(screen.width, screen.height) < 500;
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowPower, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = lowPower ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color("#0f1a14");
    this.buildTable();
    this.buildStator();
    this.buildRotor();
    this.buildLights(lowPower);

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(TRACK.ballR, 24, 16),
      new THREE.MeshStandardMaterial({ color: "#fbfaf5", roughness: 0.25, metalness: 0.05 }),
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);
    polar(LAUNCH_ANGLE, TRACK.rimR, TRACK.rimY, this.ball.position);

    this.marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.17, 0.025, 8, 32),
      new THREE.MeshBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0 }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.rotor.add(this.marker);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get wheelRate() {
    return this.rate;
  }

  get isSpinning() {
    return this.ballMode.kind === "spinning";
  }

  /** The spinner's live wheel speed (rad/s), from their twists. */
  setWheelRate(rate: number) {
    if (this.ballMode.kind === "spinning") return;
    this.rateTarget = rate;
  }

  /** Pick the ball out of its pocket and hold it at the launch spot. */
  toHand() {
    if (this.ballMode.kind === "hand" || this.ballMode.kind === "spinning") return;
    this.ballMode = { kind: "hand", blend: 0, from: this.ball.position.clone() };
    this.marker.material.opacity = 0;
  }

  /** Launch the ball. Resolves once it has settled into `plan.pocket`. */
  play(plan: SpinPlan, cb: SpinCallbacks): Promise<void> {
    return new Promise((done) => {
      if (this.ballMode.kind === "spinning") this.ballMode.done();
      this.marker.material.opacity = 0;
      this.rateTarget = null;
      const path = new BallPath(plan, this.angle);
      this.ballMode = { kind: "spinning", path, start: performance.now(), nextHop: 0, cb, done };
    });
  }

  private buildTable() {
    const felt = new THREE.Mesh(
      new THREE.CircleGeometry(30, 64),
      new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 }),
    );
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = -0.01;
    felt.receiveShadow = true;
    this.scene.add(felt);
  }

  private buildStator() {
    const wood = new THREE.MeshStandardMaterial({ color: "#6b3f1d", roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
    const track = new THREE.MeshStandardMaterial({ color: "#3b2414", roughness: 0.35, metalness: 0.1, side: THREE.DoubleSide });
    // Bowl profile, from the inner edge of the ball track out over the rim and down to the felt.
    const bowl = lathe(
      [
        [R.trackInner, Y.trackInner],
        [R.trackOuter, Y.trackOuter],
        [R.trackOuter + 0.04, Y.rimTop],
        [R.rimOuter - 0.08, Y.rimTop + 0.04],
        [R.rimOuter, Y.rimTop - 0.06],
        [R.rimOuter + 0.1, 0],
      ],
      track,
    );
    bowl.receiveShadow = true;
    this.scene.add(bowl);
    const rim = lathe(
      [
        [R.trackOuter + 0.02, Y.rimTop - 0.02],
        [R.rimOuter - 0.08, Y.rimTop + 0.05],
        [R.rimOuter + 0.02, Y.rimTop - 0.05],
        [R.rimOuter + 0.14, 0],
      ],
      wood,
    );
    rim.castShadow = true;
    this.scene.add(rim);

    // Deflectors ("diamonds") on the ball track.
    const brass = new THREE.MeshStandardMaterial({ color: "#d8b25a", roughness: 0.3, metalness: 0.9 });
    const diamond = new THREE.OctahedronGeometry(0.11, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + TAU / 16;
      const r = 2.85;
      const y = Y.trackInner + ((r - R.trackInner) / (R.trackOuter - R.trackInner)) * (Y.trackOuter - Y.trackInner);
      const d = new THREE.Mesh(diamond, brass);
      polar(a, r, y + 0.03, d.position);
      d.scale.set(0.6, 0.35, 1.4);
      d.rotation.y = a + (i % 2 ? 0 : Math.PI / 2);
      d.castShadow = true;
      this.scene.add(d);
    }
  }

  private buildRotor() {
    this.scene.add(this.rotor);
    const face = faceTexture();
    // Cone, pockets and the number ring share one texture drawn in polar coordinates.
    const top = lathe(
      [
        [R.turret, Y.numberRing + 0.42],
        [R.coneOuter, Y.numberRing],
        [R.pocketInner, Y.pocketFloor],
        [R.pocketOuter, Y.pocketFloor],
        [R.pocketOuter, Y.numberRing],
        [R.numberOuter, Y.numberRing + 0.04],
        [R.numberOuter + 0.02, Y.trackInner - 0.06],
      ],
      new THREE.MeshStandardMaterial({ map: face, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide }),
      true,
    );
    top.receiveShadow = true;
    this.rotor.add(top);

    // Frets between the pockets.
    const metal = new THREE.MeshStandardMaterial({ color: "#d9d4c7", roughness: 0.25, metalness: 0.9 });
    const fretLen = R.pocketOuter - R.pocketInner;
    const fret = new THREE.BoxGeometry(0.028, 0.13, fretLen);
    for (let i = 0; i < POCKETS; i++) {
      const a = pocketAngle(WHEEL_ORDER[i]) + SEG / 2;
      const m = new THREE.Mesh(fret, metal);
      polar(a, (R.pocketInner + R.pocketOuter) / 2, Y.pocketFloor + 0.065, m.position);
      m.rotation.y = a;
      m.castShadow = true;
      this.rotor.add(m);
    }

    // The turret: a spindle with a four-armed handle.
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.7, 24), metal);
    spindle.position.y = Y.numberRing + 0.6;
    spindle.castShadow = true;
    this.rotor.add(spindle);
    const arm = new THREE.CylinderGeometry(0.035, 0.035, 1.2, 12);
    const knob = new THREE.SphereGeometry(0.075, 16, 12);
    for (let i = 0; i < 2; i++) {
      const bar = new THREE.Mesh(arm, metal);
      bar.rotation.z = Math.PI / 2;
      bar.rotation.y = (i * Math.PI) / 2;
      bar.position.y = Y.numberRing + 0.85;
      bar.castShadow = true;
      this.rotor.add(bar);
    }
    for (let i = 0; i < 4; i++) {
      const k = new THREE.Mesh(knob, metal);
      polar((i * Math.PI) / 2, 0.6, Y.numberRing + 0.85, k.position);
      this.rotor.add(k);
    }
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), metal);
    cap.position.y = Y.numberRing + 0.98;
    this.rotor.add(cap);
  }

  private buildLights(lowPower: boolean) {
    this.scene.add(new THREE.HemisphereLight("#fff6e5", "#20302a", 1.3));
    const key = new THREE.DirectionalLight("#ffffff", 2.4);
    key.position.set(-5, 14, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(lowPower ? 512 : 1024, lowPower ? 512 : 1024);
    const s = key.shadow.camera;
    s.left = s.bottom = -5;
    s.right = s.top = 5;
    s.near = 1;
    s.far = 40;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rimLight = new THREE.PointLight("#ffd9a0", 18, 20);
    rimLight.position.set(4, 5, -4);
    this.scene.add(rimLight);
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Fit the whole wheel at the fixed pitch: wide enough, and deep enough foreshortened.
    const half = R.rimOuter + 0.25;
    const vFov = THREE.MathUtils.degToRad(FOV);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const pitch = this.camera.aspect > 1.3 ? PITCH_WIDE : PITCH_TALL;
    const distForWidth = half / Math.tan(hFov / 2) + half * 0.3;
    const projected = half * Math.sin(pitch) + 0.35;
    const distForDepth = projected / Math.tan(vFov / 2) + half * Math.cos(pitch);
    const dist = Math.max(distForWidth, distForDepth);
    const target = new THREE.Vector3(0, 0.3, 0.15);
    this.camera.position.set(0, target.y + Math.sin(pitch) * dist, target.z + Math.cos(pitch) * dist);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const mode = this.ballMode;
    if (mode.kind === "spinning") {
      this.updateSpin(mode);
    } else {
      if (this.rateTarget !== null) {
        this.rate += (this.rateTarget - this.rate) * Math.min(1, dt * 8);
        // The spinner's updates stop when they stop twisting; then it coasts.
        this.rateTarget *= Math.exp(-WHEEL_FRICTION * dt);
      } else {
        // After a spin the croupier lets the wheel run down, so the next spinner has to twist it again.
        const friction = mode.kind === "pocket" ? POCKET_FRICTION : WHEEL_FRICTION;
        this.rate *= Math.exp(-friction * dt);
      }
      this.angle += this.rate * dt;
      this.rotor.rotation.y = this.angle;
      if (mode.kind === "hand") {
        mode.blend = Math.min(1, mode.blend + dt * 2.5);
        const e = 1 - (1 - mode.blend) ** 3;
        const target = polar(LAUNCH_ANGLE, TRACK.rimR, TRACK.rimY);
        this.ball.position.lerpVectors(mode.from, target, e);
        this.ball.position.y += Math.sin(e * Math.PI) * 0.6;
      } else {
        this.placeInPocket(mode.pocket);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  private updateSpin(mode: Extract<BallMode, { kind: "spinning" }>) {
    const { path } = mode;
    const t = (performance.now() - mode.start) / 1000;
    this.angle = path.wheelAngle(t);
    this.rate = path.plan.wheel * Math.exp(-WHEEL_FRICTION * t);
    this.rotor.rotation.y = this.angle;
    const pose = path.pose(t);
    polar(pose.angle, pose.r, pose.y, this.ball.position);
    this.ball.rotation.x += 0.2;
    while (mode.nextHop < path.hops.length && path.hops[mode.nextHop].t <= t) mode.cb.onHop(path.hops[mode.nextHop++]);
    mode.cb.onRoll(t < path.duration ? path.speed(t) : 0);
    if (t >= path.duration) {
      this.ballMode = { kind: "pocket", pocket: path.plan.pocket };
      this.placeInPocket(path.plan.pocket);
      polar(pocketAngle(path.plan.pocket), TRACK.pocketR, Y.pocketFloor + 0.01, this.marker.position);
      this.marker.material.opacity = 0.95;
      mode.done();
    }
  }

  private placeInPocket(pocket: number) {
    polar(this.angle + pocketAngle(pocket), TRACK.pocketR, TRACK.pocketY, this.ball.position);
  }
}

/** A surface of revolution from [radius, height] points, with UVs for the polar face texture. */
function lathe(points: [number, number][], material: THREE.Material, polarUv = false): THREE.Mesh {
  const geo = new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    POCKETS * 4,
  );
  if (polarUv) {
    // Map each vertex to where it sits seen from above, so the texture is a plain top-down drawing.
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, 0.5 + pos.getX(i) / (2 * FACE_EXTENT), 0.5 - pos.getZ(i) / (2 * FACE_EXTENT));
    }
    uv.needsUpdate = true;
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

/** The face texture covers −FACE_EXTENT..FACE_EXTENT in x and z. */
const FACE_EXTENT = R.numberOuter + 0.05;

const COLORS = { red: "#b3172a", black: "#16120f", green: "#11804a" };

/**
 * The rotor seen from above: wood cone, coloured pockets, and the number
 * ring. Canvas y runs down = world +z, matching the UVs in lathe().
 */
function faceTexture(): THREE.Texture {
  const size = 2048;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const px = (r: number) => (r / FACE_EXTENT) * c;
  /** World angle a (x = r·sin a, z = r·cos a) to a canvas angle (x right, y down). */
  const canvasAngle = (a: number) => Math.atan2(Math.cos(a), Math.sin(a));

  // Cone: radial wood.
  const wood = ctx.createRadialGradient(c, c, px(0.2), c, c, px(R.coneOuter));
  wood.addColorStop(0, "#9a6a3a");
  wood.addColorStop(1, "#5a3518");
  ctx.fillStyle = wood;
  ctx.beginPath();
  ctx.arc(c, c, px(R.coneOuter), 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(240, 210, 150, 0.35)";
  ctx.lineWidth = 6;
  for (const r of [0.75, 1.25]) {
    ctx.beginPath();
    ctx.arc(c, c, px(r), 0, TAU);
    ctx.stroke();
  }

  for (let i = 0; i < POCKETS; i++) {
    const n = WHEEL_ORDER[i];
    const mid = pocketAngle(n);
    // Canvas angles run the other way from world angles, so the pocket spans a1..a1+SEG (computed, never wrapped).
    const a1 = canvasAngle(mid + SEG / 2);
    const a0 = a1 + SEG;
    const color = COLORS[pocketColor(n)];
    // Pocket floor, then its number segment.
    for (const [r0, r1, fill] of [
      [R.pocketInner - 0.02, R.pocketOuter, shade(color, 0.75)],
      [R.pocketOuter, R.numberOuter + 0.05, color],
    ] as const) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(c, c, px(r1), a1, a0);
      ctx.arc(c, c, px(r0), a0, a1, true);
      ctx.closePath();
      ctx.fill();
    }
    // Number, reading outward.
    ctx.save();
    ctx.translate(c, c);
    const ca = canvasAngle(mid);
    ctx.rotate(ca + Math.PI / 2);
    ctx.translate(0, -px((R.pocketOuter + R.numberOuter) / 2));
    ctx.fillStyle = "#f6efdc";
    ctx.font = `bold ${Math.round(px(0.27))}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), 0, 0);
    ctx.restore();
  }
  // Gold separators between the number segments.
  ctx.strokeStyle = "#d8b25a";
  ctx.lineWidth = 4;
  for (let i = 0; i < POCKETS; i++) {
    const a = canvasAngle(pocketAngle(WHEEL_ORDER[i]) + SEG / 2);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * px(R.pocketOuter), c + Math.sin(a) * px(R.pocketOuter));
    ctx.lineTo(c + Math.cos(a) * px(R.numberOuter), c + Math.sin(a) * px(R.numberOuter));
    ctx.stroke();
  }
  for (const r of [R.pocketOuter, R.numberOuter - 0.01]) {
    ctx.beginPath();
    ctx.arc(c, c, px(r), 0, TAU);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(v * k).toString(16).padStart(2, "0");
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

function feltTexture(): THREE.Texture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, "#1f7a4a");
  grad.addColorStop(1, "#0d3d24");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

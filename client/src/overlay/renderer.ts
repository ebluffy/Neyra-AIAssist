import {
  AmbientLight, Box3, DirectionalLight, Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { blinkWeight, lookTarget, nextBlinkDelay, poseFor } from './animation';
import type { CharacterState } from './state';

export interface Rig {
  setState(state: CharacterState): void;
  setMouth(open: number): void;
  setLook(x: number, y: number): void;
  setFps(fps: number): void;
  stats(): { frames: number; mouth: number; blink: number };
  dispose(): void;
}

export async function startVrm(canvas: HTMLCanvasElement, bytes: ArrayBuffer, fps: number): Promise<Rig> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(bytes, '');
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error('not a VRM file');
  VRMUtils.rotateVRM0(vrm);

  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.width, canvas.height, false);

  const scene = new Scene();
  scene.add(vrm.scene, new AmbientLight(0xffffff, 1.2));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 2, 3);
  scene.add(sun);

  const box = new Box3().setFromObject(vrm.scene);
  const size = box.getSize(new Vector3());
  const camera = new PerspectiveCamera(28, canvas.width / canvas.height, 0.1, 50);
  const focusY = box.min.y + size.y * 0.78;
  camera.position.set(0, focusY, Math.max(size.y * 1.1, 1.2) + 0.6);
  camera.lookAt(0, focusY - size.y * 0.12, 0);

  const target = new Object3D();
  scene.add(target);
  if (vrm.lookAt) vrm.lookAt.target = target;

  let state: CharacterState = 'idle';
  let mouth = 0;
  let look = { x: 0, y: 0 };
  let interval = 1000 / Math.max(1, fps);
  let frames = 0;
  let blink = 0;
  let blinkStart = -1;
  let nextBlinkAt = performance.now() + nextBlinkDelay(Math.random());
  let last = 0;
  let raf = 0;
  const expressions = vrm.expressionManager;

  const draw = (now: number) => {
    raf = requestAnimationFrame(draw);
    if (document.hidden || now - last < interval) return;
    const delta = last === 0 ? 1 / 30 : (now - last) / 1000;
    last = now;
    const seconds = now / 1000;
    const pose = poseFor(state, seconds);
    const chest = vrm.humanoid?.getNormalizedBoneNode('chest') ?? vrm.humanoid?.getNormalizedBoneNode('spine');
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    if (chest) chest.rotation.x = pose.chestX;
    if (head) { head.rotation.x = pose.headX; head.rotation.z = pose.headZ; }
    const at = lookTarget(look.x, look.y, pose.lookUp);
    target.position.set(at.x, at.y, at.z);
    if (blinkStart < 0 && now >= nextBlinkAt) blinkStart = now;
    if (blinkStart >= 0) {
      blink = blinkWeight(now - blinkStart);
      if (now - blinkStart > 200) { blinkStart = -1; blink = 0; nextBlinkAt = now + nextBlinkDelay(Math.random()); }
    }
    expressions?.setValue('blink', blink);
    expressions?.setValue('aa', state === 'speaking' ? mouth : 0);
    vrm.update(delta);
    renderer.render(scene, camera);
    frames += 1;
  };
  raf = requestAnimationFrame(draw);

  return {
    setState: (next) => { state = next; },
    setMouth: (open) => { mouth = Math.min(1, Math.max(0, open)); },
    setLook: (x, y) => { look = { x, y }; },
    setFps: (value) => { interval = 1000 / Math.min(60, Math.max(10, value)); },
    stats: () => ({ frames, mouth: expressions?.getValue('aa') ?? 0, blink: expressions?.getValue('blink') ?? 0 }),
    dispose: () => {
      cancelAnimationFrame(raf);
      VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
    },
  };
}

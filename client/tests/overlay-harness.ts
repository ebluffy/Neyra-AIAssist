import { startVrm } from '../src/overlay/renderer';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const report = (value: object) => { document.title = JSON.stringify(value); };

async function main() {
  const bytes = await (await fetch('/tests/fixtures/neyra-test.vrm')).arrayBuffer();
  const rig = await startVrm(canvas, bytes, 30);
  rig.setState('speaking');
  rig.setMouth(1);
  rig.setLook(0.5, -0.2);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stats = rig.stats();
  report({ ok: stats.frames >= 1 && stats.mouth > 0.9, ...stats });
}
main().catch((error) => report({ ok: false, error: String(error) }));

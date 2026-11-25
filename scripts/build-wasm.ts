import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import process from 'node:process';

const target = 'wasm32-unknown-unknown';
const build = spawnSync('cargo', [
  'build', '--locked', '--release',
  '--manifest-path', 'sobosuba-engine/Cargo.toml',
  '--target', target,
  '--target-dir', 'sobosuba-engine/target',
], { stdio: 'inherit' });

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync('src/sobosuba', { recursive: true });
copyFileSync(
  `sobosuba-engine/target/${target}/release/sobosuba_engine.wasm`,
  'src/sobosuba/sobosuba_engine.wasm',
);

import { useEffect, useRef } from 'react';
import {
  AmbientLight,
  CatmullRomCurve3,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { VisualResult } from '../visual/types';
import { parameterRenderKey } from './visual-parameters';

interface IdentifiedVisualResult extends VisualResult {
  code?: string | null;
  params?: Record<string, number>;
  revision?: number;
  revisionId?: string;
}

interface ArtworkCanvasProps {
  mode?: 'inspection' | 'interactive';
  visual: IdentifiedVisualResult;
}

interface ThreeRuntime {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls?: OrbitControls;
  material: MeshStandardMaterial;
  mode: 'inspection' | 'interactive';
  frame?: {
    center: Vector3;
    radius: number;
  };
  mesh?: Mesh<TubeGeometry, MeshStandardMaterial>;
}

export function artworkRenderKey(
  visual: IdentifiedVisualResult,
): string | undefined {
  const visualKey = visual.revisionId
    ? `revision:${visual.revisionId}`
    : visual.code
      ? `code:${visual.code}`
      : visual.revision !== undefined
        ? `legacy:${visual.revision}`
        : undefined;
  return parameterRenderKey(visualKey, visual.params);
}

function frameArtwork(runtime: ThreeRuntime) {
  if (!runtime.frame) return;

  const { camera, controls, frame } = runtime;
  const verticalHalfFov = (camera.fov * Math.PI) / 360;
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * camera.aspect,
  );
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  const distance = (frame.radius / Math.sin(limitingHalfFov)) * 1.08;
  const direction = runtime.mode === 'inspection'
    ? new Vector3(9, 7, 11).normalize()
    : camera.position.clone().sub(controls!.target).normalize();

  camera.position.copy(frame.center).addScaledVector(direction, distance);
  camera.near = Math.max(frame.radius / 1_000, 0.001);
  camera.far = distance + frame.radius * 100;
  camera.updateProjectionMatrix();
  if (controls) {
    controls.target.copy(frame.center);
    controls.minDistance = frame.radius * 0.24;
    controls.maxDistance = frame.radius * 24;
    controls.update();
  } else {
    camera.lookAt(frame.center);
  }
}

export function ArtworkCanvas({
  mode = 'interactive',
  visual,
}: ArtworkCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ThreeRuntime | undefined>(undefined);
  const renderVersion = artworkRenderKey(visual) ?? visual;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new Scene();

    const camera = new PerspectiveCamera(38, 1, 0.01, 10_000);
    camera.position.set(9, 7, 11);

    const renderer = new WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(
      mode === 'inspection' ? 1 : Math.min(window.devicePixelRatio, 2),
    );
    renderer.outputColorSpace = 'srgb';
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.draggable = false;
    const preventNativeDrag = (event: DragEvent) => event.preventDefault();
    renderer.domElement.addEventListener('dragstart', preventNativeDrag);
    host.appendChild(renderer.domElement);

    const controls = mode === 'interactive'
      ? new OrbitControls(camera, renderer.domElement)
      : undefined;
    if (controls) {
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
    }

    scene.add(new AmbientLight('#fefffe', 2.1));
    const keyLight = new DirectionalLight('#ffffff', 4.5);
    keyLight.position.set(8, 12, 10);
    scene.add(keyLight);
    const fillLight = new DirectionalLight('#9eb4c9', 2.2);
    fillLight.position.set(-10, -4, -6);
    scene.add(fillLight);

    const material = new MeshStandardMaterial({
      color: '#152c49',
      roughness: 0.44,
      metalness: 0.04,
    });

    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      if (runtimeRef.current) frameArtwork(runtimeRef.current);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame: number | undefined;
    if (controls) {
      const draw = () => {
        controls.update();
        renderer.render(scene, camera);
        frame = requestAnimationFrame(draw);
      };
      draw();
    }

    runtimeRef.current = {
      scene,
      camera,
      renderer,
      controls,
      material,
      mode,
    };

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      controls?.dispose();
      runtimeRef.current?.mesh?.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener('dragstart', preventNativeDrag);
      renderer.domElement.remove();
      runtimeRef.current = undefined;
    };
  }, [mode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    if (runtime.mesh) {
      runtime.scene.remove(runtime.mesh);
      runtime.mesh.geometry.dispose();
    }

    const points = visual.points.map(
      (point) => new Vector3(point.x, point.y, point.z),
    );
    const closed = visual.render.closed ?? false;
    const curve = new CatmullRomCurve3(points, closed, 'centripetal', 0.5);
    const geometry = new TubeGeometry(
      curve,
      Math.max(96, points.length * 3),
      visual.render.radius,
      10,
      closed,
    );
    const mesh = new Mesh(geometry, runtime.material);
    runtime.scene.add(mesh);
    runtime.mesh = mesh;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      minZ = Math.min(minZ, point.z);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      maxZ = Math.max(maxZ, point.z);
    }

    const center = new Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    );
    const radius = Math.max(
      ...points.map((point) => point.distanceTo(center)),
      0.5,
    ) + visual.render.radius;
    runtime.frame = { center, radius };
    frameArtwork(runtime);
    runtime.renderer.render(runtime.scene, runtime.camera);

    if (runtime.mode === 'inspection') {
      requestAnimationFrame(() => {
        if (runtimeRef.current !== runtime) return;
        runtime.renderer.render(runtime.scene, runtime.camera);
        runtime.renderer.domElement.parentElement?.setAttribute(
          'data-inspection-ready',
          'true',
        );
      });
    }
  }, [renderVersion]);

  return (
    <div
      aria-label={mode === 'inspection'
        ? 'Canonical three-dimensional artwork inspection render.'
        : 'Interactive three-dimensional artwork. Drag to orbit and scroll to zoom.'}
      className="artwork-canvas"
      data-mode={mode}
      ref={hostRef}
      role="img"
    />
  );
}

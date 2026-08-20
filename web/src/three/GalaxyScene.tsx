import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, Stars } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useCallback, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Nebula } from './Nebula';
import type { TreeNode } from '../store/data';
import { colorFromString } from '../lib/text';

/**
 * The Galaxy view: every top-level category is a world, and the tasks inside
 * it orbit as moons. It is not decoration — the size of a world tracks how
 * much is inside it, its ring shows completion, and an overdue world pulses
 * red, so the shape of your workload is readable at a glance from across
 * the room.
 */

export interface GalaxyProps {
  nodes: TreeNode[];
  focusedId: string | null;
  onSelect(id: string): void;
  onEnter(id: string): void;
  quality: 'full' | 'balanced';
  theme: 'dark' | 'light';
}

interface WorldLayout {
  node: TreeNode;
  position: THREE.Vector3;
  radius: number;
  color: THREE.Color;
  orbitRadius: number;
  orbitSpeed: number;
  phase: number;
  overdue: boolean;
  progress: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function layoutWorlds(nodes: TreeNode[]): WorldLayout[] {
  const now = Date.now();
  return nodes.map((node, index) => {
    // A phyllotaxis spiral spreads the worlds evenly without clustering,
    // however many there are.
    const angle = index * GOLDEN_ANGLE;
    // Spacing grows a little faster than the worlds do, so big categories do
    // not collide with their neighbours as the spiral tightens.
    const distance = 6.5 + Math.sqrt(index + 0.5) * 4.9;
    const height = Math.sin(index * 1.7) * 2.8;

    const total = node.totalDescendants;
    const radius = 1.1 + Math.min(1.9, Math.log2(total + 2) * 0.42);
    const progress = total > 0 ? node.doneDescendants / total : node.item.status === 'done' ? 1 : 0;
    const overdue = hasOverdue(node, now);

    return {
      node,
      position: new THREE.Vector3(Math.cos(angle) * distance, height, Math.sin(angle) * distance),
      radius,
      color: new THREE.Color(node.item.color || colorFromString(node.item.title)),
      orbitRadius: radius + 1.5,
      orbitSpeed: 0.16 + (index % 5) * 0.035,
      phase: index * 1.3,
      overdue,
      progress,
    };
  });
}

function hasOverdue(node: TreeNode, now: number): boolean {
  if (node.item.status === 'open' && node.item.dueAt && new Date(node.item.dueAt).getTime() < now) return true;
  return node.children.some((child) => hasOverdue(child, now));
}

function World({
  layout,
  selected,
  onSelect,
  onEnter,
  quality,
}: {
  layout: WorldLayout;
  selected: boolean;
  onSelect(id: string): void;
  onEnter(id: string): void;
  quality: 'full' | 'balanced';
}) {
  const group = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  const moons = useMemo(
    () =>
      layout.node.children.slice(0, quality === 'full' ? 10 : 5).map((child, i, all) => ({
        child,
        angle: (i / Math.max(1, all.length)) * Math.PI * 2,
        distance: layout.orbitRadius + (i % 3) * 0.42,
        speed: 0.5 + (i % 4) * 0.16,
        size: 0.14 + (child.totalDescendants > 0 ? 0.08 : 0),
        done: child.item.status === 'done',
      })),
    [layout, quality],
  );

  useFrame((state, delta) => {
    if (!group.current || !core.current) return;
    core.current.rotation.y += delta * 0.18;

    // Overdue worlds breathe; a selected one lifts toward the viewer.
    const time = state.clock.elapsedTime;
    const pulse = layout.overdue ? 1 + Math.sin(time * 3 + layout.phase) * 0.055 : 1;
    const target = (hovered || selected ? 1.14 : 1) * pulse;
    const current = group.current.scale.x;
    group.current.scale.setScalar(current + (target - current) * Math.min(1, delta * 8));
    group.current.position.y = layout.position.y + Math.sin(time * 0.5 + layout.phase) * 0.22;
  });

  const emissive = layout.overdue ? new THREE.Color('#ff4d6d') : layout.color;

  return (
    <group ref={group} position={layout.position}>
      <mesh
        ref={core}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(layout.node.item.id);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onEnter(layout.node.item.id);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = '';
        }}
      >
        {/* Detail 3 is the floor: below that the facets of a flat-shaded
            icosahedron read as a rendering fault rather than a style. */}
        <icosahedronGeometry args={[layout.radius, quality === 'full' ? 4 : 3]} />
        <meshStandardMaterial
          color={layout.color}
          emissive={emissive}
          emissiveIntensity={selected ? 1.5 : hovered ? 1.05 : 0.62}
          roughness={0.28}
          metalness={0.55}
        />
      </mesh>

      {/* Completion ring — how much of this world is finished. */}
      <mesh rotation={[Math.PI / 2.1, 0, 0]}>
        <torusGeometry args={[layout.orbitRadius, 0.035, 8, 96, Math.PI * 2 * Math.max(0.02, layout.progress)]} />
        <meshBasicMaterial color={layout.progress >= 1 ? '#3ddc97' : layout.color} transparent opacity={0.9} />
      </mesh>
      <mesh rotation={[Math.PI / 2.1, 0, 0]}>
        <torusGeometry args={[layout.orbitRadius, 0.012, 6, 64]} />
        <meshBasicMaterial color={layout.color} transparent opacity={0.18} />
      </mesh>

      {moons.map((moon, index) => (
        <Moon
          key={moon.child.item.id}
          {...moon}
          color={layout.color}
          index={index}
          trails={quality === 'full'}
          onSelect={() => onSelect(moon.child.item.id)}
        />
      ))}

      <Html
        center
        distanceFactor={16}
        position={[0, -layout.radius - 1.1, 0]}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[8, 0]}
      >
        <div className={`galaxy-label ${selected ? 'is-selected' : ''}`}>
          <span className="galaxy-label__icon">{layout.node.item.icon || '🌐'}</span>
          <span className="galaxy-label__title">{layout.node.item.title}</span>
          {layout.node.totalDescendants > 0 && (
            <span className="galaxy-label__count mono">
              {layout.node.doneDescendants}/{layout.node.totalDescendants}
            </span>
          )}
        </div>
      </Html>
    </group>
  );
}

function Moon({
  angle,
  distance,
  speed,
  size,
  done,
  color,
  index,
  trails,
  onSelect,
}: {
  angle: number;
  distance: number;
  speed: number;
  size: number;
  done: boolean;
  color: THREE.Color;
  index: number;
  trails: boolean;
  onSelect(): void;
}) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime * speed + angle;
    ref.current.position.set(
      Math.cos(t) * distance,
      Math.sin(t * 0.7 + index) * 0.35,
      Math.sin(t) * distance,
    );
  });

  return (
    <mesh
      ref={ref}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <sphereGeometry args={[size, 12, 12]} />
      <meshStandardMaterial
        color={done ? '#3ddc97' : color}
        emissive={done ? '#3ddc97' : color}
        // Open work glows; finished work fades back and stops competing for attention.
        emissiveIntensity={done ? 0.35 : trails ? 1.35 : 1.05}
        transparent
        opacity={done ? 0.45 : 1}
      />
    </mesh>
  );
}

/**
 * Eases the camera toward a selected world instead of snapping to it, and
 * pulls back far enough to frame however many worlds there are.
 */
function CameraRig({ target, spread }: { target: THREE.Vector3 | null; spread: number }) {
  const { camera } = useThree();
  const home = useMemo(
    () => new THREE.Vector3(0, Math.min(16, 7 + spread * 0.25), Math.min(60, 20 + spread * 0.9)),
    [spread],
  );
  const desired = useRef(home.clone());

  useFrame((_, delta) => {
    if (target) desired.current.set(target.x * 1.45, target.y + 4.5, target.z * 1.45 + 9);
    else desired.current.copy(home);
    camera.position.lerp(desired.current, Math.min(1, delta * 1.6));
  });
  return null;
}

export function GalaxyScene({ nodes, focusedId, onSelect, onEnter, quality, theme }: GalaxyProps) {
  const worlds = useMemo(() => layoutWorlds(nodes), [nodes]);
  const focusTarget = useMemo(
    () => worlds.find((w) => w.node.item.id === focusedId)?.position ?? null,
    [worlds, focusedId],
  );
  const handleMiss = useCallback(() => onSelect(''), [onSelect]);

  // How far the outermost world sits from the centre, used to frame the shot.
  const spread = useMemo(
    () => worlds.reduce((max, w) => Math.max(max, w.position.length() + w.radius), 10),
    [worlds],
  );

  return (
    <Canvas
      camera={{ position: [0, 8, 22], fov: 55 }}
      dpr={quality === 'full' ? [1, 2] : [1, 1.4]}
      gl={{ antialias: quality === 'full', powerPreference: 'high-performance' }}
      onPointerMissed={handleMiss}
    >
      <color attach="background" args={[theme === 'light' ? '#e4e8f7' : '#05060f']} />
      <Nebula theme={theme} intensity={theme === 'light' ? 1.25 : 1} />
      <Stars radius={90} depth={50} count={quality === 'full' ? 3500 : 1200} factor={4} fade speed={0.6} />

      <ambientLight intensity={theme === 'light' ? 1.1 : 0.45} />
      <pointLight position={[0, 12, 0]} intensity={90} distance={80} color="#a68bff" />
      <pointLight position={[14, -6, 10]} intensity={55} distance={70} color="#7ce7ff" />

      {worlds.map((layout) => (
        <World
          key={layout.node.item.id}
          layout={layout}
          selected={layout.node.item.id === focusedId}
          onSelect={onSelect}
          onEnter={onEnter}
          quality={quality}
        />
      ))}

      <CameraRig target={focusTarget} spread={spread} />
      <OrbitControls
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={8}
        maxDistance={Math.max(50, spread * 2.2)}
        maxPolarAngle={Math.PI * 0.85}
      />

      {quality === 'full' && (
        <EffectComposer>
          <Bloom intensity={0.85} luminanceThreshold={0.28} luminanceSmoothing={0.9} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={theme === 'light' ? 0.3 : 0.8} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

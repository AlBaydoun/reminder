import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

/**
 * The backdrop: a shader-painted sphere rendered from the inside, so the
 * camera is always surrounded by drifting nebula rather than looking at a
 * flat image. Fractal brownian motion over simplex-ish value noise gives the
 * cloud structure; it is cheap enough to run on a phone because it is a
 * single draw call with no textures.
 */

const vertexShader = /* glsl */ `
  varying vec3 vPosition;
  void main() {
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vPosition;
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform float uIntensity;

  // Value noise + fbm. Cheaper than gradient noise and, smeared across a
  // sphere this large, visually indistinguishable.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }

  float fbm(vec3 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      total += noise(p) * amplitude;
      p *= 2.02;
      amplitude *= 0.5;
    }
    return total;
  }

  void main() {
    vec3 dir = normalize(vPosition);
    float t = uTime * 0.02;
    float clouds = fbm(dir * 2.2 + vec3(t, t * 0.6, -t * 0.4));
    float detail = fbm(dir * 6.0 - vec3(t * 0.8, 0.0, t));

    vec3 color = mix(uColorA, uColorB, smoothstep(0.25, 0.75, clouds));
    color = mix(color, uColorC, smoothstep(0.45, 0.95, detail) * 0.55);

    // Darken toward the poles so the horizon reads as depth, not a seam.
    float vignette = 1.0 - pow(abs(dir.y), 1.6) * 0.55;
    gl_FragColor = vec4(color * vignette * uIntensity, 1.0);
  }
`;

export function Nebula({ intensity = 1, theme = 'dark' }: { intensity?: number; theme?: 'dark' | 'light' }) {
  const material = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: intensity },
      uColorA: { value: new THREE.Color(theme === 'light' ? '#dfe6ff' : '#05060f') },
      uColorB: { value: new THREE.Color(theme === 'light' ? '#c6d2ff' : '#13123a') },
      uColorC: { value: new THREE.Color(theme === 'light' ? '#a9bcff' : '#3a1c6b') },
    }),
    [theme, intensity],
  );

  useFrame((_, delta) => {
    if (material.current) material.current.uniforms.uTime.value += delta;
  });

  return (
    <mesh scale={[-1, 1, 1]} frustumCulled={false}>
      <sphereGeometry args={[120, 32, 32]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        side={THREE.BackSide}
        depthWrite={false}
      />
    </mesh>
  );
}

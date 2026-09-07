/**
 * Cosmos — Star lifecycle theater
 * Scrub cosmic time; morph through formation → death with mass branching.
 */
import * as THREE from "three";

/** @typedef {'low'|'high'} MassPath */

export const STAGES_LOW = [
  {
    id: "cloud",
    name: "Molecular cloud",
    short: "Nursery",
    t0: 0,
    t1: 0.14,
    note: "Cold H₂ / dust lanes collapse under gravity. Dense cores seed stars.",
    era: "0 — formation",
  },
  {
    id: "protostar",
    name: "Protostar",
    short: "Protostar",
    t0: 0.14,
    t1: 0.28,
    note: "Infall heats a luminous core. Bipolar jets clear polar cavities.",
    era: "~10⁵ yr",
  },
  {
    id: "main",
    name: "Main sequence",
    short: "Main seq.",
    t0: 0.28,
    t1: 0.48,
    note: "Sun-like star: H→He fusion in the core. Stable for ~10 Gyr.",
    era: "Gyr · G2V",
  },
  {
    id: "giant",
    name: "Red giant",
    short: "Red giant",
    t0: 0.48,
    t1: 0.62,
    note: "Core H exhausted. Envelope swells; He ash builds. Tip of RGB/AGB.",
    era: "~Gyr later",
  },
  {
    id: "pn",
    name: "Planetary nebula",
    short: "PN",
    t0: 0.62,
    t1: 0.78,
    note: "Outer layers shed as glowing shells. Hot core ionizes the wind.",
    era: "~10⁴ yr",
  },
  {
    id: "wd",
    name: "White dwarf",
    short: "White dwarf",
    t0: 0.78,
    t1: 1,
    note: "Earth-sized remnant supported by electron degeneracy. Cools for eons.",
    era: "remnant",
  },
];

export const STAGES_HIGH = [
  {
    id: "cloud",
    name: "Molecular cloud",
    short: "Nursery",
    t0: 0,
    t1: 0.12,
    note: "Giant molecular cloud fragments. Massive cores form quickly.",
    era: "0 — formation",
  },
  {
    id: "protostar",
    name: "Massive protostar",
    short: "Protostar",
    t0: 0.12,
    t1: 0.24,
    note: "Rapid accretion; strong UV and outflows. May still be embedded.",
    era: "~10⁴–10⁵ yr",
  },
  {
    id: "main",
    name: "Massive main sequence",
    short: "O/B star",
    t0: 0.24,
    t1: 0.4,
    note: "O/B star: fierce luminosity, short life (~few–tens of Myr).",
    era: "Myr · O/B",
  },
  {
    id: "giant",
    name: "Red supergiant",
    short: "Supergiant",
    t0: 0.4,
    t1: 0.52,
    note: "Envelope bloated; layered fusion shells. Destined for core collapse.",
    era: "late",
  },
  {
    id: "sn",
    name: "Core-collapse supernova",
    short: "Supernova",
    t0: 0.52,
    t1: 0.66,
    note: "Iron core collapses; shock unbinds the star. Neutrinos flood out.",
    era: "seconds → months",
  },
  {
    id: "ns",
    name: "Neutron star",
    short: "Neutron star",
    t0: 0.66,
    t1: 1,
    note: "City-sized remnant of neutrons. Pulsars, magnetars — extreme density.",
    era: "remnant · ~1.4–2 M☉",
    endState: "ns",
  },
  {
    id: "bh",
    name: "Stellar black hole",
    short: "Black hole",
    t0: 0.66,
    t1: 1,
    note: "If the core is massive enough, spacetime collapses past any surface.",
    era: "remnant · ≳3 M☉",
    endState: "bh",
  },
];

function stagesFor(path, endState) {
  if (path === "low") return STAGES_LOW;
  return STAGES_HIGH.filter((s) => {
    if (s.endState && s.endState !== endState) return false;
    return true;
  });
}

function stageAt(stages, t) {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  for (const s of stages) {
    if (x >= s.t0 && x <= s.t1) return s;
  }
  return stages[stages.length - 1];
}

function localU(stage, t) {
  const span = Math.max(1e-6, stage.t1 - stage.t0);
  return THREE.MathUtils.clamp((t - stage.t0) / span, 0, 1);
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function makeLabelSprite(text, color = "#e0f2fe") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = "600 42px 'DM Sans', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(40, 28, 432, 72);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: 0.95,
  });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(14, 3.5, 1);
  spr.position.set(0, 10, 0);
  return spr;
}

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => disposeMat(m));
      else disposeMat(o.material);
    }
  });
}

function disposeMat(m) {
  m.map?.dispose?.();
  m.dispose?.();
}

function createCloudParticles(count = 3200) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // filamentary / clumpy distribution
    const arm = Math.floor(Math.random() * 5);
    const ang = (arm / 5) * Math.PI * 2 + Math.random() * 0.9;
    const r = 4 + Math.pow(Math.random(), 0.55) * 22;
    const y = (Math.random() - 0.5) * (6 + r * 0.15);
    pos[i * 3] = Math.cos(ang) * r + (Math.random() - 0.5) * 2.5;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.sin(ang) * r + (Math.random() - 0.5) * 2.5;
    const cool = 0.35 + Math.random() * 0.35;
    col[i * 3] = 0.35 + cool * 0.2;
    col[i * 3 + 1] = 0.25 + cool * 0.45;
    col[i * 3 + 2] = 0.55 + cool * 0.45;
    seed[i] = Math.random() * Math.PI * 2;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.PointsMaterial({
    size: 0.55,
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  return new THREE.Points(geo, mat);
}

function createShellParticles(count = 1800) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 1;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi);
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    // teal / magenta PN hues
    const mix = Math.random();
    col[i * 3] = 0.25 + mix * 0.55;
    col[i * 3 + 1] = 0.75 - mix * 0.2;
    col[i * 3 + 2] = 0.95;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.35,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}

function createDisk(inner = 2.2, outer = 7.5, color = 0xff8844) {
  const geo = new THREE.RingGeometry(inner, outer, 96, 4);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2.35;
  return mesh;
}

function starMaterial(color, emissive, glow = 1.2) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: glow,
    roughness: 0.45,
    metalness: 0.05,
  });
}

/**
 * @returns {object} API
 */
export function createStarLifecycle() {
  const root = new THREE.Group();
  root.name = "starLifecycle";
  root.visible = false;

  const ambient = new THREE.AmbientLight(0x1a2035, 0.55);
  const key = new THREE.PointLight(0xffe6c0, 2.2, 120, 1.2);
  key.position.set(0, 0, 0);
  root.add(ambient, key);

  const cloud = createCloudParticles();
  root.add(cloud);

  const disk = createDisk();
  root.add(disk);

  const jets = new THREE.Group();
  const jetGeo = new THREE.CylinderGeometry(0.15, 0.55, 14, 12, 1, true);
  const jetMat = new THREE.MeshBasicMaterial({
    color: 0x88ddff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const jetA = new THREE.Mesh(jetGeo, jetMat);
  const jetB = new THREE.Mesh(jetGeo, jetMat.clone());
  jetA.position.y = 8;
  jetB.position.y = -8;
  jets.add(jetA, jetB);
  root.add(jets);

  const star = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 48),
    starMaterial(0xfff4d6, 0xffcc66, 1.4)
  );
  star.scale.setScalar(0.01);
  root.add(star);

  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, 32, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  root.add(corona);

  const pnShell = createShellParticles();
  root.add(pnShell);

  const shock = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.MeshBasicMaterial({
      color: 0xfff1c1,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    })
  );
  root.add(shock);

  const remnant = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    starMaterial(0xdbeafe, 0x93c5fd, 2.2)
  );
  remnant.scale.setScalar(0.01);
  remnant.visible = false;
  root.add(remnant);

  // Event horizon + photon ring for BH
  const horizon = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  horizon.scale.setScalar(0.01);
  horizon.visible = false;
  root.add(horizon);

  const photonRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.35, 0.06, 16, 96),
    new THREE.MeshBasicMaterial({
      color: 0xffcc88,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  photonRing.rotation.x = Math.PI / 2.1;
  photonRing.visible = false;
  root.add(photonRing);

  const accretion = createDisk(1.6, 9, 0xffaa55);
  accretion.visible = false;
  root.add(accretion);

  const label = makeLabelSprite("Molecular cloud");
  root.add(label);

  // Soft bg star dust local to theater
  const bg = createCloudParticles(900);
  bg.material.size = 0.22;
  bg.material.opacity = 0.35;
  bg.scale.setScalar(2.4);
  root.add(bg);

  const api = {
    root,
    path: /** @type {MassPath} */ ("low"),
    endState: /** @type {'ns'|'bh'} */ ("ns"),
    t: 0,
    playing: false,
    autoSpeed: 0.04, // scrub units per second when autoplay
    _time: 0,
    cloud,
    disk,
    jets,
    jetA,
    jetB,
    star,
    corona,
    pnShell,
    shock,
    remnant,
    horizon,
    photonRing,
    accretion,
    label,
    key,
    bg,
  };

  return api;
}

export function getLifecycleCameraFrame() {
  return {
    position: new THREE.Vector3(0, 8, 28),
    target: new THREE.Vector3(0, 0, 0),
    minDist: 6,
    maxDist: 80,
  };
}

export function setLifecyclePath(api, path, endState) {
  api.path = path === "high" ? "high" : "low";
  if (endState === "bh" || endState === "ns") api.endState = endState;
  // keep t; morph will adapt
}

export function setLifecycleProgress(api, t) {
  api.t = THREE.MathUtils.clamp(t, 0, 1);
}

export function getLifecycleStages(api) {
  return stagesFor(api.path, api.endState);
}

export function getLifecycleStage(api) {
  return stageAt(getLifecycleStages(api), api.t);
}

/**
 * Per-frame update — morph visuals from scrubber t
 */
export function updateStarLifecycle(api, dt) {
  if (!api || !api.root.visible) return getLifecycleStage(api);

  api._time += dt;
  if (api.playing) {
    api.t = Math.min(1, api.t + api.autoSpeed * dt);
  }

  const stages = getLifecycleStages(api);
  const stage = stageAt(stages, api.t);
  const u = localU(stage, api.t);
  const t = api.t;
  const high = api.path === "high";
  const bhEnd = high && api.endState === "bh";

  // Weights for overlapping morphs
  const wCloud = 1 - smoothstep(0.08, 0.3, t);
  const wProto = smoothstep(0.1, 0.2, t) * (1 - smoothstep(0.26, 0.38, t));
  const wMain = smoothstep(0.24, 0.36, t) * (1 - smoothstep(high ? 0.38 : 0.46, high ? 0.5 : 0.58, t));
  const wGiant = smoothstep(high ? 0.38 : 0.46, high ? 0.46 : 0.54, t) *
    (1 - smoothstep(high ? 0.5 : 0.6, high ? 0.58 : 0.7, t));
  const wPn = !high
    ? smoothstep(0.6, 0.68, t) * (1 - smoothstep(0.78, 0.9, t))
    : 0;
  const wSn = high
    ? smoothstep(0.5, 0.56, t) * (1 - smoothstep(0.62, 0.72, t))
    : 0;
  const wRem = high
    ? smoothstep(0.64, 0.74, t)
    : smoothstep(0.76, 0.88, t);
  const wWd = !high ? wRem : 0;
  const wNs = high && !bhEnd ? wRem : 0;
  const wBh = high && bhEnd ? wRem : 0;

  // —— Cloud collapse ——
  const collapse = smoothstep(0.05, 0.28, t);
  const cloudScale = THREE.MathUtils.lerp(1.15, 0.25, collapse);
  api.cloud.scale.setScalar(cloudScale);
  api.cloud.material.opacity = 0.85 * wCloud + 0.12 * wProto;
  api.cloud.rotation.y = api._time * 0.03;
  api.cloud.visible = wCloud + wProto > 0.02;

  // —— Accretion disk (protostar) ——
  api.disk.visible = wProto > 0.02 || (wBh > 0.02);
  if (wProto > 0.02) {
    api.disk.material.opacity = 0.55 * wProto;
    api.disk.scale.setScalar(THREE.MathUtils.lerp(1.4, 0.7, u));
    api.disk.rotation.z = api._time * 0.4;
    api.disk.material.color.setHex(0xff8844);
  }

  // —— Jets ——
  const jetOp = 0.55 * wProto;
  api.jetA.material.opacity = jetOp;
  api.jetB.material.opacity = jetOp;
  api.jets.visible = jetOp > 0.02;
  api.jets.rotation.y = api._time * 0.15;

  // —— Star body (proto → main → giant) ——
  let starR = 0.01;
  let starCol = new THREE.Color(0xffe6b0);
  let emCol = new THREE.Color(0xffaa44);
  let emI = 1.2;

  if (wProto > 0.01) {
    starR = Math.max(starR, THREE.MathUtils.lerp(0.4, high ? 1.6 : 1.1, smoothstep(0.14, 0.28, t)) * wProto + starR * (1 - wProto));
  }
  if (wMain > 0.01) {
    const rMain = high ? 2.4 : 1.35;
    starR = THREE.MathUtils.lerp(starR, rMain, wMain);
    if (high) {
      starCol.setHex(0xa5d8ff);
      emCol.setHex(0x60a5fa);
      emI = 2.4;
    } else {
      starCol.setHex(0xfff4d6);
      emCol.setHex(0xffcc66);
      emI = 1.6;
    }
  }
  if (wGiant > 0.01) {
    const rG = high ? 6.8 : 4.2;
    starR = THREE.MathUtils.lerp(starR, rG, wGiant);
    starCol.setHex(high ? 0xff6b4a : 0xff7a45);
    emCol.setHex(high ? 0xff4422 : 0xff6633);
    emI = 1.8;
  }
  // fade star during PN / SN / remnant
  const starFade = Math.max(0, 1 - wPn * 0.85 - wSn * 0.9 - wRem * 0.95);
  api.star.visible = starR > 0.05 && starFade > 0.04;
  api.star.scale.setScalar(Math.max(0.01, starR * starFade));
  api.star.material.color.copy(starCol);
  api.star.material.emissive.copy(emCol);
  api.star.material.emissiveIntensity = emI * starFade;
  api.star.rotation.y += dt * 0.25;

  api.corona.scale.setScalar(Math.max(0.01, starR * 1.35 * starFade));
  api.corona.material.opacity = 0.22 * wMain * starFade + 0.18 * wGiant * starFade;
  api.corona.material.color.copy(emCol);

  api.key.intensity = 1.2 + wMain * 1.5 + wGiant * 1.2 + wSn * 4 + wProto * 0.8;
  api.key.color.copy(emCol);

  // —— Planetary nebula ——
  if (wPn > 0.01) {
    const expand = THREE.MathUtils.lerp(2.5, 11, smoothstep(0.62, 0.9, t));
    api.pnShell.scale.setScalar(expand);
    api.pnShell.material.opacity = 0.7 * wPn;
    api.pnShell.rotation.y = api._time * 0.08;
    // hot core shrinks toward WD
    const coreR = THREE.MathUtils.lerp(1.2, 0.35, smoothstep(0.62, 0.85, t));
    if (starFade < 0.5) {
      api.star.visible = true;
      api.star.scale.setScalar(coreR * (0.4 + 0.6 * wPn));
      api.star.material.color.setHex(0xdbeafe);
      api.star.material.emissive.setHex(0x93c5fd);
      api.star.material.emissiveIntensity = 2.5 * wPn;
    }
  } else {
    api.pnShell.material.opacity = 0;
  }
  api.pnShell.visible = wPn > 0.02;

  // —— Supernova ——
  if (wSn > 0.01) {
    const boom = smoothstep(0.52, 0.66, t);
    const R = THREE.MathUtils.lerp(2, 18, Math.pow(boom, 0.7));
    api.shock.scale.setScalar(R);
    api.shock.material.opacity = 0.65 * wSn * (1 - boom * 0.5);
    api.shock.material.color.setHSL(0.08 + boom * 0.05, 0.85, 0.75);
    api.key.intensity = 2 + boom * 8;
  } else {
    api.shock.material.opacity = 0;
  }
  api.shock.visible = wSn > 0.02;

  // —— White dwarf ——
  if (wWd > 0.01) {
    api.remnant.visible = true;
    api.remnant.scale.setScalar(0.55 * wWd);
    api.remnant.material.color.setHex(0xf8fafc);
    api.remnant.material.emissive.setHex(0xe2e8f0);
    api.remnant.material.emissiveIntensity = 2.8 * wWd;
    api.horizon.visible = false;
    api.photonRing.visible = false;
    api.accretion.visible = false;
  } else if (wNs > 0.01) {
    api.remnant.visible = true;
    const pulse = 1 + 0.04 * Math.sin(api._time * 18);
    api.remnant.scale.setScalar(0.42 * wNs * pulse);
    api.remnant.material.color.setHex(0xbfdbfe);
    api.remnant.material.emissive.setHex(0x60a5fa);
    api.remnant.material.emissiveIntensity = 3.2 * wNs;
    // beam hint
    api.jetA.material.opacity = Math.max(api.jetA.material.opacity, 0.35 * wNs);
    api.jetB.material.opacity = Math.max(api.jetB.material.opacity, 0.35 * wNs);
    api.jets.visible = true;
    api.horizon.visible = false;
    api.photonRing.visible = false;
    api.accretion.visible = false;
  } else if (wBh > 0.01) {
    api.remnant.visible = false;
    api.horizon.visible = true;
    api.horizon.scale.setScalar(1.1 * wBh);
    api.photonRing.visible = true;
    api.photonRing.material.opacity = 0.85 * wBh;
    api.photonRing.scale.setScalar(wBh);
    api.photonRing.rotation.z = api._time * 0.6;
    api.accretion.visible = true;
    api.accretion.material.opacity = 0.7 * wBh;
    api.accretion.material.color.setHex(0xff9944);
    api.accretion.rotation.z = api._time * 0.55;
    api.accretion.scale.setScalar(1);
  } else {
    api.remnant.visible = false;
    api.horizon.visible = false;
    api.photonRing.visible = false;
    if (wProto < 0.02) api.accretion.visible = false;
  }

  // Label
  if (api.label.material.map) {
    // refresh text when stage changes
    if (api._lastStageId !== stage.id) {
      api._lastStageId = stage.id;
      const canvas = api.label.material.map.image;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, 512, 128);
      ctx.font = "600 40px 'DM Sans', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(24, 28, 464, 72);
      ctx.fillStyle = high ? "#fde68a" : "#e0f2fe";
      ctx.fillText(stage.name, 256, 68);
      api.label.material.map.needsUpdate = true;
    }
  }
  api.label.position.y = 8 + Math.max(starR, 2) * 0.35;
  api.label.material.opacity = 0.9;

  api.bg.rotation.y = api._time * 0.01;

  return stage;
}

export function disposeStarLifecycle(api) {
  if (!api?.root) return;
  disposeObject(api.root);
}

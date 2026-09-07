/**
 * Cosmos — interactive Three.js solar system
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { PLANETS, SUN, COMETS } from "./bodies.js";
import {
  createEarthTheater,
  setEarthMode,
  selectSite,
  startLaunch,
  updateEarthTheater,
  pickLaunchSite,
  getSiteCameraFrame,
  getSurfaceCameraFrame,
  getLeoCameraFrame,
  missionsForSite,
  LAUNCH_SITES,
  EARTH_R,
} from "./earth.js";
import {
  createStarLifecycle,
  updateStarLifecycle,
  setLifecyclePath,
  setLifecycleProgress,
  getLifecycleCameraFrame,
  getLifecycleStages,
  getLifecycleStage,
} from "./starLifecycle.js";

// —— Visual AU scale (compress outer system for readability) ——
// true AU → scene units via soft power curve
function auToScene(au) {
  // Keep inner system readable; pull Neptune closer without breaking order
  const compressed = Math.pow(au, 0.72) * 14;
  return compressed;
}

function trueAnomalyFromMean(M, e, iters = 12) {
  // Solve Kepler: M = E - e sin E (more iters for high-e comets)
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < iters; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    E = E - f / (fp || 1e-9);
  }
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const denom = 1 - e * cosE;
  const cosNu = (cosE - e) / denom;
  const sinNu = (Math.sqrt(Math.max(0, 1 - e * e)) * sinE) / denom;
  return Math.atan2(sinNu, cosNu);
}

/** Position in orbital plane from elements (days since epoch) */
function keplerPosition(a_au, e, periodDays, iDeg, days, phase0 = 0) {
  const a = auToScene(a_au);
  const n = (Math.PI * 2) / periodDays; // rad/day
  const M = (n * days + phase0) % (Math.PI * 2);
  const nu = trueAnomalyFromMean(M < 0 ? M + Math.PI * 2 : M, e);
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
  const xOrb = r * Math.cos(nu);
  const zOrb = r * Math.sin(nu);
  const i = THREE.MathUtils.degToRad(iDeg);
  // Rotate about X by inclination
  const y = zOrb * Math.sin(i);
  const z = zOrb * Math.cos(i);
  return new THREE.Vector3(xOrb, y, z);
}

// —— State ——
const state = {
  simDays: 0,
  /** days of simulated time per real second at slider “1×” baseline mapping */
  timeScale: 1,
  playing: true,
  showOrbits: true,
  showLabels: true,
  showStars: true,
  showBelt: true,
  showComets: true,
  showMoons: true,
  follow: false,
  focusId: "sun",
  epoch: new Date("2000-01-01T12:00:00Z"),
  /** solar | earth | leo | stars */
  viewMode: "solar",
  earthSiteId: null,
  earthMissionId: null,
  followLaunchCam: true,
  lifePath: "low",
  lifeEnd: "ns",
};

const bodyRuntime = new Map(); // id -> { group, mesh, orbitLine, label, def, phase0 }
let sunMesh;
let starField;
let asteroidBelt;
let labelSprites = [];
let earthTheater = null;
let starLife = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let camTween = null; // { fromPos, toPos, fromTarget, toTarget, t, dur }

// —— DOM ——
const $ = (id) => document.getElementById(id);
const host = $("canvas-host");
const bodyList = $("body-list");
const simDateEl = $("sim-date");
const simElapsedEl = $("sim-elapsed");
const speedReadout = $("speed-readout");
const speedSlider = $("speed");
const detailName = $("detail-name");
const detailType = $("detail-type");
const detailBlurb = $("detail-blurb");
const detailStats = $("detail-stats");
const btnPlay = $("btn-play");
const iconPlay = $("icon-play");
const iconPause = $("icon-pause");
const loader = $("loader");

// Slider 0–1000 → log time scale (Earth days of sim per real second)
function sliderToScaleFixed(v) {
  if (v <= 0) return 0;
  const t = v / 1000;
  // v≈375 → 1 d/s · v≈500 → 10 · v≈625 → 100 · v≈750 → 1k · v≈1000 → 1e5
  return Math.pow(10, t * 8 - 3);
}

function scaleToSlider(scale) {
  if (scale <= 0) return 0;
  // invert: scale = 10^(t*8 - 3) => log10(scale) = t*8 - 3 => t = (log10(scale)+3)/8
  const t = (Math.log10(scale) + 3) / 8;
  return Math.min(1000, Math.max(0, t * 1000));
}

function formatScale(s) {
  if (s === 0) return "0×";
  if (s < 0.01) return s.toExponential(1) + "×";
  if (s < 10) return s.toFixed(2) + "×";
  if (s < 1000) return s.toFixed(0) + "×";
  if (s < 1e6) return (s / 1000).toFixed(s < 10000 ? 1 : 0) + "k×";
  return (s / 1e6).toFixed(1) + "M×";
}

function formatElapsed(days) {
  const sign = days < 0 ? "−" : "";
  const d = Math.abs(days);
  if (d < 365.25) return sign + d.toFixed(1) + " d";
  const y = d / 365.256;
  if (y < 100) return sign + y.toFixed(2) + " y";
  return sign + y.toFixed(1) + " y";
}

function formatDate(epoch, days) {
  const d = new Date(epoch.getTime() + days * 86400000);
  if (Number.isNaN(d.getTime())) return "—";
  if (state.viewMode === "stars") return "cosmic scrub";
  if (state.viewMode !== "solar") return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
  return d.toISOString().slice(0, 10);
}

function setSolarSystemVisible(vis) {
  for (const rt of bodyRuntime.values()) {
    if (rt.group) rt.group.visible = vis;
    if (rt.orbitLine) {
      if (!vis) rt.orbitLine.visible = false;
      else if (rt.kind === "comet") rt.orbitLine.visible = state.showOrbits && state.showComets;
      else rt.orbitLine.visible = state.showOrbits;
    }
  }
  if (starField) starField.visible = vis && state.showStars;
  if (asteroidBelt) asteroidBelt.visible = vis && state.showBelt;
  if (typeof sunLight !== "undefined" && sunLight) sunLight.visible = vis;
  if (typeof fill !== "undefined" && fill) fill.visible = vis;
}

function applyCameraFrame(frame, { animate = true, dur = 1.1 } = {}) {
  if (!frame) return;
  controls.minDistance = frame.minDist ?? 4;
  controls.maxDistance = frame.maxDist ?? 900;
  if (!animate) {
    camera.position.copy(frame.position);
    controls.target.copy(frame.target);
    controls.update();
    camTween = null;
    return;
  }
  camTween = {
    fromPos: camera.position.clone(),
    toPos: frame.position.clone(),
    fromTarget: controls.target.clone(),
    toTarget: frame.target.clone(),
    t: 0,
    dur,
  };
}

function setModeButtons(mode) {
  $("btn-solar")?.classList.toggle("active", mode === "solar");
  $("btn-earth")?.classList.toggle("active", mode === "earth" || mode === "site");
  $("btn-leo")?.classList.toggle("active", mode === "leo");
  $("btn-stars")?.classList.toggle("active", mode === "stars");
}


function hideLifecycleUI() {
  $("life-bar")?.classList.add("hidden");
  document.body.classList.remove("stars-mode", "stars-high");
  if (starLife) {
    starLife.root.visible = false;
    starLife.playing = false;
  }
  if (speedReadout) speedReadout.textContent = formatScale(state.timeScale);
}

function syncLifecycleHud(stage) {
  if (!starLife) return;
  const s = stage || getLifecycleStage(starLife);
  if ($("life-stage-name")) $("life-stage-name").textContent = s.name;
  if ($("life-era")) $("life-era").textContent = s.era || "";
  if ($("life-note")) $("life-note").textContent = s.note || "";
  const scrub = $("life-scrub");
  if (scrub && document.activeElement !== scrub) {
    scrub.value = String(Math.round(starLife.t * 1000));
  }
  document.querySelectorAll(".life-tick").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === s.id);
  });
  detailName.textContent = s.name;
  detailType.textContent = state.lifePath === "high" ? "High-mass track" : "Low-mass track";
  detailBlurb.textContent = s.note;
  const endLabel =
    state.lifePath === "high"
      ? state.lifeEnd === "bh"
        ? "Black hole"
        : "Neutron star"
      : "White dwarf";
  detailStats.innerHTML = [
    ["Mode", "Star lifecycle"],
    ["Path", state.lifePath === "high" ? "Massive (≥8 M☉)" : "Sun-like (~1 M☉)"],
    ["Stage", s.short || s.name],
    ["Fork", state.lifePath === "high" ? "SN → NS / BH" : "PN → WD"],
    ["End", endLabel],
    ["Key", "T · scrub timeline"],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
}

function buildLifecycleTicks() {
  const host = $("life-ticks");
  if (!host || !starLife) return;
  const stages = getLifecycleStages(starLife);
  host.innerHTML = stages
    .map(
      (s) =>
        `<button type="button" class="life-tick" data-id="${s.id}" data-t="${((s.t0 + s.t1) / 2).toFixed(3)}" title="${s.name}">${s.short}</button>`
    )
    .join("");
  host.querySelectorAll(".life-tick").forEach((btn) => {
    btn.addEventListener("click", () => {
      setLifecycleProgress(starLife, Number(btn.dataset.t));
      starLife.playing = false;
      syncLifecycleHud();
    });
  });
}

function applyLifecyclePath(path, endState) {
  if (!starLife) return;
  state.lifePath = path === "high" ? "high" : "low";
  if (endState === "bh" || endState === "ns") state.lifeEnd = endState;
  setLifecyclePath(starLife, state.lifePath, state.lifeEnd);
  document.body.classList.toggle("stars-high", state.lifePath === "high");
  $("life-mass-low")?.classList.toggle("active", state.lifePath === "low");
  $("life-mass-high")?.classList.toggle("active", state.lifePath === "high");
  $("life-end-ns")?.classList.toggle("active", state.lifeEnd === "ns");
  $("life-end-bh")?.classList.toggle("active", state.lifeEnd === "bh");
  $("life-caption").textContent =
    state.lifePath === "high"
      ? "High-mass track · after supergiant: supernova → neutron star or black hole"
      : "Low-mass track · after red giant: planetary nebula → white dwarf";
  buildLifecycleTicks();
  syncLifecycleHud();
}

function enterSolarMode() {
  state.viewMode = "solar";
  state.earthSiteId = null;
  state.earthMissionId = null;
  document.body.classList.remove("earth-mode", "leo-mode", "stars-mode", "stars-high");
  setModeButtons("solar");
  $("brand-sub").textContent = "Solar system · ephemeris-lite";
  $("earth-bar")?.classList.add("hidden");
  hideLifecycleUI();
  if (earthTheater) {
    earthTheater.root.visible = false;
    setEarthMode(earthTheater, "surface");
  }
  setSolarSystemVisible(true);
  controls.minDistance = 4;
  controls.maxDistance = 900;
  bloom.strength = 0.55;
  updateBodies(state.simDays, 0);
  const rt = bodyRuntime.get(state.focusId) || bodyRuntime.get("earth");
  if (rt) {
    const target = new THREE.Vector3();
    rt.group.getWorldPosition(target);
    applyCameraFrame({
      position: target.clone().add(new THREE.Vector3(8, 5, 12)),
      target,
      minDist: 4,
      maxDist: 900,
    });
    updateDetail(state.focusId);
  }
}

function enterEarthMode() {
  state.viewMode = "earth";
  document.body.classList.add("earth-mode");
  document.body.classList.remove("leo-mode", "stars-mode", "stars-high");
  setModeButtons("earth");
  $("brand-sub").textContent = "Earth surface · launch sites";
  hideLifecycleUI();
  $("earth-bar")?.classList.remove("hidden");
  $("earth-bar-title").textContent = "Earth surface";
  $("earth-caption").textContent = "Click a marker or pick a site below";
  $("earth-missions-wrap")?.classList.add("hidden");
  setSolarSystemVisible(false);
  if (earthTheater) {
    earthTheater.root.visible = true;
    setEarthMode(earthTheater, "surface");
  }
  if (state.timeScale > 20) setTimeScale(1);
  bloom.strength = 0.28;
  applyCameraFrame(getSurfaceCameraFrame());
  buildEarthSitesUI();
  updateDetailEarth();
}

function enterLeoMode() {
  state.viewMode = "leo";
  state.earthSiteId = null;
  state.earthMissionId = null;
  document.body.classList.add("leo-mode");
  document.body.classList.remove("earth-mode", "stars-mode", "stars-high");
  setModeButtons("leo");
  $("brand-sub").textContent = "Low Earth Orbit · stations";
  hideLifecycleUI();
  $("earth-bar")?.classList.remove("hidden");
  $("earth-bar-title").textContent = "Low Earth Orbit";
  $("earth-caption").textContent = "Clean orbital theater — separate from surface launches";
  $("earth-missions-wrap")?.classList.add("hidden");
  $("earth-sites").innerHTML = "";
  setSolarSystemVisible(false);
  if (earthTheater) {
    earthTheater.root.visible = true;
    setEarthMode(earthTheater, "leo");
  }
  if (state.timeScale > 30) setTimeScale(2);
  bloom.strength = 0.32;
  applyCameraFrame(getLeoCameraFrame());
  detailName.textContent = "LEO";
  detailType.textContent = "Orbit theater";
  detailBlurb.textContent =
    "Hyper-clear Earth from orbit. ISS path highlighted. Launch sequences live under Earth surface mode — pick a site, then a mission.";
  detailStats.innerHTML = [
    ["Mode", "LEO"],
    ["Focus", "ISS · 51.6°"],
    ["Hint", "E = surface · S = solar"],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
  $("earth-phase").textContent = "Low Earth Orbit";
}


function enterStarsMode() {
  state.viewMode = "stars";
  state.earthSiteId = null;
  state.earthMissionId = null;
  document.body.classList.add("stars-mode");
  document.body.classList.remove("earth-mode", "leo-mode");
  document.body.classList.toggle("stars-high", state.lifePath === "high");
  setModeButtons("stars");
  $("brand-sub").textContent = "Star lifecycle · cosmic time scrub";
  $("earth-bar")?.classList.add("hidden");
  $("life-bar")?.classList.remove("hidden");
  setSolarSystemVisible(false);
  if (earthTheater) {
    earthTheater.root.visible = false;
  }
  if (starLife) {
    starLife.root.visible = true;
    starLife.playing = false;
    applyLifecyclePath(state.lifePath, state.lifeEnd);
  }
  bloom.strength = 0.72;
  applyCameraFrame(getLifecycleCameraFrame(), { dur: 1.2 });
  syncLifecycleHud();
}

function setViewMode(mode) {
  if (mode === "solar") enterSolarMode();
  else if (mode === "leo") enterLeoMode();
  else if (mode === "stars") enterStarsMode();
  else enterEarthMode();
}

function buildEarthSitesUI() {
  const host = $("earth-sites");
  if (!host) return;
  host.innerHTML = LAUNCH_SITES.map(
    (s) =>
      `<button type="button" class="earth-site ${s.id === state.earthSiteId ? "active" : ""}" data-id="${s.id}">${s.short}</button>`
  ).join("");
  host.querySelectorAll(".earth-site").forEach((btn) => {
    btn.addEventListener("click", () => onSelectSite(btn.dataset.id));
  });
}

function onSelectSite(siteId) {
  if (!earthTheater) return;
  if (state.viewMode === "leo") enterEarthMode();
  const site = selectSite(earthTheater, siteId);
  if (!site) return;
  state.viewMode = "earth";
  state.earthSiteId = siteId;
  state.earthMissionId = null;
  document.body.classList.add("earth-mode");
  setModeButtons("earth");
  $("earth-bar-title").textContent = site.name;
  $("earth-caption").textContent = `${site.era} · ${site.blurb}`;
  buildEarthSitesUI();
  buildEarthMissionsUI(siteId);
  applyCameraFrame(getSiteCameraFrame(earthTheater, siteId), { dur: 1.4 });
  updateDetailEarth(site);
}

function buildEarthMissionsUI(siteId) {
  const wrap = $("earth-missions-wrap");
  const host = $("earth-missions");
  if (!wrap || !host) return;
  const missions = missionsForSite(siteId);
  wrap.classList.toggle("hidden", missions.length === 0);
  host.innerHTML = missions
    .map(
      (m) =>
        `<button type="button" class="earth-mission ${m.id === state.earthMissionId ? "active" : ""}" data-id="${m.id}" title="${m.blurb}">${m.name}</button>`
    )
    .join("");
  host.querySelectorAll(".earth-mission").forEach((btn) => {
    btn.addEventListener("click", () => onStartMission(btn.dataset.id));
  });
}

function onStartMission(missionId) {
  if (!earthTheater) return;
  const mission = startLaunch(earthTheater, missionId);
  if (!mission) return;
  state.earthMissionId = missionId;
  state.followLaunchCam = true;
  state.playing = true;
  if (state.timeScale === 0) setTimeScale(1);
  buildEarthMissionsUI(mission.siteId);
  $("earth-caption").textContent = `${mission.date} · ${mission.blurb}`;
  $("earth-phase").textContent = "T−0 · Ignition";
  detailName.textContent = mission.name;
  detailType.textContent = "Launch sequence";
  detailBlurb.textContent = mission.blurb;
  detailStats.innerHTML = [
    ["Date", mission.date],
    ["Vehicle", mission.vehicle],
    ["Beyond LEO", mission.beyond ? "Yes" : "No"],
    ["Cam", "Auto-follow (drag to take over)"],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
}

function updateDetailEarth(site) {
  const s =
    site ||
    (state.earthSiteId && LAUNCH_SITES.find((x) => x.id === state.earthSiteId));
  detailName.textContent = s ? s.name : "Earth";
  detailType.textContent = s ? "Launch site" : "Surface theater";
  detailBlurb.textContent = s
    ? s.blurb
    : "Hyper-clear Earth with historical launch sites only. Select a site, then a mission for full liftoff → orbit → beyond.";
  detailStats.innerHTML = [
    ["Mode", "Earth surface"],
    ["Sites", String(LAUNCH_SITES.length)],
    ["Hint", "Click markers or chips"],
    ["Keys", "E surface · L LEO · S solar"],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
}

// —— Three.js setup ——
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);
scene.fog = new THREE.FogExp2(0x03040a, 0.0012);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 42, 78);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 4;
controls.maxDistance = 900;
controls.target.set(0, 0, 0);
controls.autoRotate = false;

// Soft ambient + sun light
scene.add(new THREE.AmbientLight(0x1a1e2e, 0.35));
const sunLight = new THREE.PointLight(0xfff2d6, 2.8, 0, 0.35);
sunLight.position.set(0, 0, 0);
scene.add(sunLight);
const fill = new THREE.DirectionalLight(0x4466aa, 0.15);
fill.position.set(-40, 30, -20);
scene.add(fill);

// Post: bloom for sun glow
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55,
  0.6,
  0.85
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// —— Star field ——
function createStarField(count = 8000) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    // Spherical shell
    const r = 400 + Math.random() * 800;
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    // Spectral variety
    const roll = Math.random();
    if (roll < 0.15) color.setHSL(0.6, 0.4, 0.85); // blue
    else if (roll < 0.3) color.setHSL(0.08, 0.5, 0.8); // orange
    else color.setHSL(0.1, 0.05, 0.75 + Math.random() * 0.25);

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    sizes[i] = 0.5 + Math.random() * 2.2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.PointsMaterial({
    size: 1.1,
    vertexColors: true,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Points(geo, mat);
}

// —— Asteroid belt (between Mars & Jupiter) ——
function createAsteroidBelt(count = 1400) {
  const positions = new Float32Array(count * 3);
  const aInner = auToScene(2.1);
  const aOuter = auToScene(3.3);

  for (let i = 0; i < count; i++) {
    const a = aInner + Math.random() * (aOuter - aInner);
    const e = Math.random() * 0.12;
    const iDeg = (Math.random() - 0.5) * 16;
    const nu = Math.random() * Math.PI * 2;
    const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
    const x = r * Math.cos(nu);
    const z0 = r * Math.sin(nu);
    const i = THREE.MathUtils.degToRad(iDeg);
    positions[i * 3] = x;
    positions[i * 3 + 1] = z0 * Math.sin(i) * 0.4;
    positions[i * 3 + 2] = z0 * Math.cos(i);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9aa3b5,
    size: 0.18,
    transparent: true,
    opacity: 0.75,
    sizeAttenuation: true,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.userData.basePositions = positions.slice(0);
  return pts;
}

function createOrbitLine(def, segments = 256) {
  // More samples for high-eccentricity (comets)
  const segs = def.eccentricity > 0.6 ? 512 : segments;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const frac = i / segs;
    const days = frac * def.periodDays;
    const p = keplerPosition(def.a_au, def.eccentricity, def.periodDays, def.inclinationDeg, days, 0);
    pts.push(p);
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const isComet = def.type === "Comet";
  const mat = new THREE.LineBasicMaterial({
    color: def.color,
    transparent: true,
    opacity: isComet ? 0.22 : 0.28,
  });
  const line = new THREE.LineLoop(geo, mat);
  return line;
}

function createTailTexture(r0, g0, b0) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext("2d");
  const grd = ctx.createLinearGradient(32, 0, 32, 256);
  grd.addColorStop(0, `rgba(${r0},${g0},${b0},0.95)`);
  grd.addColorStop(0.15, `rgba(${r0},${g0},${b0},0.55)`);
  grd.addColorStop(0.55, `rgba(${r0},${g0},${b0},0.12)`);
  grd.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 64, 256);
  // soft side falloff
  const side = ctx.createLinearGradient(0, 0, 64, 0);
  side.addColorStop(0, "rgba(0,0,0,0.85)");
  side.addColorStop(0.5, "rgba(0,0,0,0)");
  side.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, 64, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createCometGroup(def) {
  const group = new THREE.Group();

  const nucleus = new THREE.Mesh(
    new THREE.SphereGeometry(def.visualRadius, 20, 20),
    new THREE.MeshStandardMaterial({
      color: def.color,
      roughness: 0.85,
      metalness: 0.05,
      emissive: def.color,
      emissiveIntensity: 0.25,
    })
  );
  group.add(nucleus);

  // Coma (glow)
  const coma = new THREE.Mesh(
    new THREE.SphereGeometry(def.visualRadius * 2.4, 16, 16),
    new THREE.MeshBasicMaterial({
      color: def.color,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  group.add(coma);

  // Dust tail (warm) — sprite stretched along anti-sun direction
  const dustCol = new THREE.Color(def.tailDust || 0xffe4b5);
  const dustMap = createTailTexture(
    Math.round(dustCol.r * 255),
    Math.round(dustCol.g * 255),
    Math.round(dustCol.b * 255)
  );
  const dustMat = new THREE.SpriteMaterial({
    map: dustMap,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.85,
  });
  const dustTail = new THREE.Sprite(dustMat);
  dustTail.center.set(0.5, 1); // attach at top (nucleus end)
  group.add(dustTail);

  // Ion tail (blue) — slightly offset
  const ionCol = new THREE.Color(def.tailIon || 0x7dd3fc);
  const ionMap = createTailTexture(
    Math.round(ionCol.r * 255),
    Math.round(ionCol.g * 255),
    Math.round(ionCol.b * 255)
  );
  const ionMat = new THREE.SpriteMaterial({
    map: ionMap,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.7,
  });
  const ionTail = new THREE.Sprite(ionMat);
  ionTail.center.set(0.5, 1);
  group.add(ionTail);

  // Particle trail along recent path (anti-sun fan)
  const trailCount = 48;
  const trailPos = new Float32Array(trailCount * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  const trail = new THREE.Points(
    trailGeo,
    new THREE.PointsMaterial({
      color: def.tailDust || 0xffe4b5,
      size: 0.22,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
  );
  group.add(trail);

  return {
    group,
    mesh: nucleus,
    dustTail,
    ionTail,
    coma,
    trail,
    trailCount,
  };
}

/** Orient comet tails away from the Sun; length scales with 1/r near perihelion */
function updateCometTails(rt, worldPos) {
  const r = worldPos.length();
  const rAuVis = Math.max(r, 0.5);
  // Brighter / longer near perihelion
  const activity = THREE.MathUtils.clamp(8 / rAuVis, 0.15, 3.5);

  // Anti-sun unit vector in world space
  const antiSun = worldPos.clone().normalize(); // from sun to comet; tail points further out ≈ anti-sun for radiation pressure on dust is actually away from sun = same as radial out from sun through comet
  // Dust lags slightly — use radial outward
  const radial = antiSun;

  // Position tails just outside nucleus in world-aligned local space:
  // put sprites so they extend along -radial in local group (group at comet)
  // Local: tail should go in direction of radial (away from sun) from nucleus
  const dustLen = 2.5 * activity * (rt.def.visualRadius * 18 + 4);
  const ionLen = dustLen * 1.25;
  const dustW = 0.55 * activity + 0.35;
  const ionW = 0.28 * activity + 0.2;

  rt.dustTail.scale.set(dustW * 2.2, dustLen, 1);
  rt.ionTail.scale.set(ionW * 1.6, ionLen, 1);

  // Sprites face camera (screen-space glow); particle trail carries true anti-sun direction
  const tip = radial.clone().multiplyScalar(rt.def.visualRadius);
  rt.dustTail.position.copy(tip);
  rt.ionTail.position.copy(tip).add(new THREE.Vector3(0, 0.06, 0));
  rt.dustTail.material.opacity = THREE.MathUtils.clamp(0.25 + activity * 0.25, 0.2, 0.95);
  rt.ionTail.material.opacity = THREE.MathUtils.clamp(0.2 + activity * 0.22, 0.15, 0.85);
  rt.coma.material.opacity = THREE.MathUtils.clamp(0.08 + activity * 0.1, 0.06, 0.45);
  rt.coma.scale.setScalar(1 + activity * 0.35);

  // Particle tail in anti-sun direction (local space)
  const pos = rt.trail.geometry.attributes.position.array;
  for (let i = 0; i < rt.trailCount; i++) {
    const t = i / (rt.trailCount - 1);
    const spread = t * t * 0.8 * activity;
    const along = t * dustLen;
    // local coords: radial is world; convert to local = same if group not rotated
    pos[i * 3] = radial.x * along + (Math.sin(i * 2.7) * spread);
    pos[i * 3 + 1] = radial.y * along + (Math.cos(i * 1.9) * spread * 0.5);
    pos[i * 3 + 2] = radial.z * along + (Math.sin(i * 3.1) * spread);
  }
  rt.trail.geometry.attributes.position.needsUpdate = true;
  rt.trail.material.opacity = THREE.MathUtils.clamp(0.3 + activity * 0.2, 0.2, 0.9);
  rt.trail.material.size = 0.12 + activity * 0.08;
}

function makeLabelSprite(text, color = "#eef1f7") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = "600 28px DM Sans, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  const w = ctx.measureText(text).width + 28;
  roundRect(ctx, 128 - w / 2, 14, w, 36, 10);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: 0.92,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(6.5, 1.6, 1);
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function createPlanetMesh(def) {
  const geo = new THREE.SphereGeometry(def.visualRadius, 48, 48);
  const rough =
    def.type === "Gas giant" || def.type === "Ice giant"
      ? 0.55
      : def.type === "Dwarf planet"
        ? 0.85
        : 0.72;
  const mat = new THREE.MeshStandardMaterial({
    color: def.color,
    roughness: rough,
    metalness: 0.08,
    emissive: def.color,
    emissiveIntensity: 0.04,
  });
  const mesh = new THREE.Mesh(geo, mat);

  if (def.atmosphere) {
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(def.visualRadius * 1.08, 32, 32),
      new THREE.MeshBasicMaterial({
        color: def.atmosphere,
        transparent: true,
        opacity: 0.12,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    mesh.add(atmo);
  }

  if (def.hasRings) {
    const ringGeo = new THREE.RingGeometry(def.visualRadius * 1.4, def.visualRadius * 2.35, 96);
    // Flip UVs for double-sided look
    const pos = ringGeo.attributes.position;
    const uv = ringGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      uv.setXY(i, (x / (def.visualRadius * 2.35) + 1) / 2, (y / (def.visualRadius * 2.35) + 1) / 2);
    }
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xc4b59a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const rings = new THREE.Mesh(ringGeo, ringMat);
    rings.rotation.x = Math.PI / 2.15;
    mesh.add(rings);
  }

  // Royal crown 👑 (Pluto, Jupiter, …)
  if (def.hasCrown) {
    const crown = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      metalness: 0.85,
      roughness: 0.25,
      emissive: 0xb45309,
      emissiveIntensity: 0.25,
    });
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(def.visualRadius * 0.55, def.visualRadius * 0.08, 10, 28),
      gold
    );
    band.rotation.x = Math.PI / 2;
    band.position.y = def.visualRadius * 0.72;
    crown.add(band);
    // points of the crown
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(def.visualRadius * 0.1, def.visualRadius * 0.35, 6),
        gold
      );
      const r = def.visualRadius * 0.52;
      spike.position.set(
        Math.cos(a) * r,
        def.visualRadius * 0.95,
        Math.sin(a) * r
      );
      crown.add(spike);
      // jewel
      const jewel = new THREE.Mesh(
        new THREE.SphereGeometry(def.visualRadius * 0.06, 8, 8),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? 0xef4444 : 0x38bdf8,
          emissive: i % 2 === 0 ? 0x7f1d1d : 0x0c4a6e,
          emissiveIntensity: 0.4,
          metalness: 0.3,
          roughness: 0.3,
        })
      );
      jewel.position.set(Math.cos(a) * r, def.visualRadius * 1.12, Math.sin(a) * r);
      crown.add(jewel);
    }
    // big center gem
    const big = new THREE.Mesh(
      new THREE.SphereGeometry(def.visualRadius * 0.1, 10, 10),
      new THREE.MeshStandardMaterial({
        color: 0xa78bfa,
        emissive: 0x5b21b6,
        emissiveIntensity: 0.5,
        metalness: 0.4,
        roughness: 0.2,
      })
    );
    big.position.y = def.visualRadius * 1.2;
    crown.add(big);
    mesh.add(crown);
  }

  return mesh;
}

function createSun() {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(SUN.visualRadius, 64, 64);
  const mat = new THREE.MeshBasicMaterial({ color: SUN.color });
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  // Corona shells
  for (const [s, o] of [
    [1.15, 0.18],
    [1.45, 0.08],
    [1.9, 0.04],
  ]) {
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(SUN.visualRadius * s, 32, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffaa33,
        transparent: true,
        opacity: o,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    group.add(shell);
  }

  // Lens flare-ish disc
  const spriteMat = new THREE.SpriteMaterial({
    map: createGlowTexture(),
    color: 0xffcc66,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(spriteMat);
  glow.scale.set(22, 22, 1);
  group.add(glow);

  return { group, mesh };
}

function createGlowTexture() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,240,180,1)");
  grd.addColorStop(0.25, "rgba(255,180,60,0.55)");
  grd.addColorStop(0.55, "rgba(255,120,20,0.15)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// —— Build scene ——
function buildSystem() {
  starField = createStarField();
  scene.add(starField);

  asteroidBelt = createAsteroidBelt();
  scene.add(asteroidBelt);

  const sun = createSun();
  sunMesh = sun.mesh;
  scene.add(sun.group);
  bodyRuntime.set("sun", {
    id: "sun",
    def: SUN,
    group: sun.group,
    mesh: sun.mesh,
    orbitLine: null,
    label: null,
    phase0: 0,
  });

  const sunLabel = makeLabelSprite("Sol", "#fde68a");
  sunLabel.position.set(0, SUN.visualRadius + 2.2, 0);
  sun.group.add(sunLabel);
  bodyRuntime.get("sun").label = sunLabel;
  labelSprites.push(sunLabel);

  PLANETS.forEach((def, idx) => {
    const group = new THREE.Group();
    const mesh = createPlanetMesh(def);
    group.add(mesh);

    const phase0 = (idx * 0.9 + 0.3) % (Math.PI * 2);
    const orbitLine = createOrbitLine(def);
    scene.add(orbitLine);

    const label = makeLabelSprite(def.name, "#e8ecf4");
    label.position.set(0, def.visualRadius + 1.2, 0);
    group.add(label);
    labelSprites.push(label);

    // Moons (all named + minor swarms from moons.js)
    const moons = [];
    if (def.moons) {
      for (const m of def.moons) {
        const segs = m.major ? 20 : 10;
        const mMesh = new THREE.Mesh(
          new THREE.SphereGeometry(m.visualRadius, segs, segs),
          new THREE.MeshStandardMaterial({
            color: m.color,
            roughness: 0.9,
            metalness: 0.05,
          })
        );
        mMesh.castShadow = false;
        group.add(mMesh);
        // labels only for major moons (keep HUD clean)
        if (m.major && m.name) {
          const ml = makeLabelSprite(m.name, "#cbd5e1");
          ml.scale.set(3.2, 0.75, 1);
          ml.position.y = m.visualRadius + 0.35;
          mMesh.add(ml);
          labelSprites.push(ml);
        }
        moons.push({
          def: m,
          mesh: mMesh,
          phase0: Math.random() * Math.PI * 2,
        });
      }
    }

    scene.add(group);
    bodyRuntime.set(def.id, {
      id: def.id,
      def,
      group,
      mesh,
      orbitLine,
      label,
      phase0,
      moons,
      kind: "planet",
    });
  });

  COMETS.forEach((def, idx) => {
    const built = createCometGroup(def);
    const phase0 = def.phase0 ?? (idx * 1.7 + 0.5) % (Math.PI * 2);
    const orbitLine = createOrbitLine(def);
    scene.add(orbitLine);

    const label = makeLabelSprite(def.name, "#bae6fd");
    label.position.set(0, def.visualRadius + 1.4, 0);
    label.scale.set(8.5, 1.7, 1);
    built.group.add(label);
    labelSprites.push(label);

    scene.add(built.group);
    bodyRuntime.set(def.id, {
      id: def.id,
      def,
      group: built.group,
      mesh: built.mesh,
      orbitLine,
      label,
      phase0,
      kind: "comet",
      dustTail: built.dustTail,
      ionTail: built.ionTail,
      coma: built.coma,
      trail: built.trail,
      trailCount: built.trailCount,
    });
  });
}

function formatPeriod(b) {
  if (b.id === "sun") return "center";
  if (b.periodDays < 400) return `${Math.round(b.periodDays)} d`;
  const y = b.periodDays / 365.256;
  if (y < 100) return `${y.toFixed(1)} y`;
  if (y < 1000) return `${Math.round(y)} y`;
  return `${(y / 1000).toFixed(1)}k y`;
}

function bodyListButton(b, extraClass = "") {
  const hex = "#" + new THREE.Color(b.color).getHexString();
  return `<li>
    <button type="button" class="body-item ${extraClass} ${b.id === state.focusId ? "active" : ""}" data-id="${b.id}" role="option">
      <span class="body-swatch" style="background:${hex};--swatch:${hex}66"></span>
      <span class="name">${b.name}</span>
      <span class="period">${formatPeriod(b)}</span>
    </button>
  </li>`;
}

// —— HUD list ——
function buildBodyList() {
  const parts = [];
  parts.push(`<li class="body-list-heading" aria-hidden="true">Star & planets</li>`);
  parts.push(bodyListButton(SUN));
  for (const p of PLANETS) {
    if (p.id === "pluto") continue;
    parts.push(bodyListButton(p));
  }
  const pluto = PLANETS.find((p) => p.id === "pluto");
  if (pluto) {
    parts.push(`<li class="body-list-heading" aria-hidden="true">Dwarf · crowned</li>`);
    parts.push(bodyListButton(pluto, "dwarf"));
  }
  parts.push(`<li class="body-list-heading" aria-hidden="true">Comets</li>`);
  for (const c of COMETS) parts.push(bodyListButton(c, "comet"));
  bodyList.innerHTML = parts.join("");

  bodyList.querySelectorAll(".body-item").forEach((btn) => {
    btn.addEventListener("click", () => focusBody(btn.dataset.id));
  });
}

function findDef(id) {
  if (id === "sun") return SUN;
  return PLANETS.find((p) => p.id === id) || COMETS.find((c) => c.id === id);
}

function focusBody(id) {
  if (state.viewMode !== "solar") {
    if (id === "earth") {
      enterEarthMode();
      return;
    }
    enterSolarMode();
  }
  state.focusId = id;
  bodyList.querySelectorAll(".body-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.id === id);
  });
  updateDetail(id);

  const rt = bodyRuntime.get(id);
  if (!rt) return;
  const target = new THREE.Vector3();
  rt.group.getWorldPosition(target);

  // Frame distance by body size
  const r = id === "sun" ? SUN.visualRadius : rt.def.visualRadius;
  const isComet = rt.kind === "comet";
  const dist = Math.max(
    isComet ? 16 : 12,
    r * 14 + (id === "sun" ? 20 : auToScene(Math.min(rt.def.a_au || 1, 12)) * (isComet ? 0.12 : 0.08))
  );

  // Smooth camera: set controls target; nudge camera if far
  controls.target.copy(target);
  const offset = camera.position.clone().sub(controls.target);
  if (offset.length() < dist * 0.4 || offset.length() > dist * 3) {
    offset.set(dist * 0.55, dist * 0.35, dist * 0.75);
    camera.position.copy(target).add(offset);
  }
  controls.update();
}

function updateDetail(id) {
  const def = findDef(id);
  if (!def) return;
  detailName.textContent = def.name;
  detailType.textContent = def.type;
  detailBlurb.textContent = def.blurb;
  detailStats.innerHTML = Object.entries(def.stats)
    .map(
      ([k, v]) =>
        `<div><dt>${k}</dt><dd>${v}</dd></div>`
    )
    .join("");
}

// —— Simulation step ——
function updateBodies(simDays, dtReal) {
  for (const [id, rt] of bodyRuntime) {
    if (id === "sun") {
      // slow visual spin
      rt.mesh.rotation.y += dtReal * 0.05 * Math.sign(state.timeScale || 1);
      continue;
    }
    const d = rt.def;
    const pos = keplerPosition(d.a_au, d.eccentricity, d.periodDays, d.inclinationDeg, simDays, rt.phase0);
    rt.group.position.copy(pos);

    if (rt.kind === "comet") {
      const show = state.showComets;
      rt.group.visible = show;
      if (rt.orbitLine) rt.orbitLine.visible = show && state.showOrbits;
      if (show) updateCometTails(rt, pos);
      continue;
    }

    // axial spin (visual, not true tidal locking)
    if (d.rotationDays) {
      const spin = ((Math.PI * 2) / Math.abs(d.rotationDays)) * (state.timeScale * (1 / 60));
      // decouple spin rate from extreme time scales a bit
      const spinClamped = Math.sign(d.rotationDays) * Math.min(Math.abs(spin), 0.4);
      rt.mesh.rotation.y += spinClamped * (dtReal * 60);
    }

    if (rt.moons) {
      for (const m of rt.moons) {
        m.mesh.visible = state.showMoons;
        if (!state.showMoons) continue;
        const period = Math.max(0.05, m.def.periodDays);
        const ang = (Math.PI * 2 * simDays) / period + m.phase0;
        const a = m.def.a_planet;
        const i = THREE.MathUtils.degToRad(m.def.inclinationDeg || 0);
        // orbital plane with inclination about X
        const x = Math.cos(ang) * a;
        const z0 = Math.sin(ang) * a;
        const y = z0 * Math.sin(i);
        const z = z0 * Math.cos(i);
        m.mesh.position.set(x, y, z);
      }
    }
  }

  // Drift asteroid belt slowly
  if (asteroidBelt && state.showBelt && state.timeScale !== 0) {
    asteroidBelt.rotation.y += dtReal * 0.002 * Math.min(state.timeScale, 500) * 0.01;
  }
}

function updateLabels() {
  // Face camera
  for (const s of labelSprites) {
    s.visible = state.showLabels;
  }
}

// —— Controls wiring ——
function setTimeScale(scale, { syncSlider = true, syncPresets = true } = {}) {
  state.timeScale = scale;
  if (scale === 0) {
    state.playing = false;
  } else if (!state.playing && scale > 0) {
    // keep playing state independent unless from pause
  }
  speedReadout.textContent = formatScale(scale);
  if (syncSlider) speedSlider.value = String(scaleToSlider(scale));
  if (syncPresets) {
    document.querySelectorAll(".preset").forEach((p) => {
      const ps = Number(p.dataset.speed);
      const active =
        (ps === 0 && scale === 0) ||
        (ps > 0 && scale > 0 && Math.abs(Math.log10(scale) - Math.log10(ps)) < 0.15);
      p.classList.toggle("active", active);
    });
  }
  updatePlayIcons();
}

function updatePlayIcons() {
  const paused = !state.playing || state.timeScale === 0;
  iconPlay.classList.toggle("hidden", !paused);
  iconPause.classList.toggle("hidden", paused);
  btnPlay.setAttribute("aria-pressed", paused ? "false" : "true");
}

function wireHud() {
  speedSlider.addEventListener("input", () => {
    const v = Number(speedSlider.value);
    const scale = sliderToScaleFixed(v);
    state.playing = scale > 0;
    setTimeScale(scale, { syncSlider: false });
  });

  document.querySelectorAll(".preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = Number(btn.dataset.speed);
      state.playing = s > 0;
      setTimeScale(s);
    });
  });

  btnPlay.addEventListener("click", () => {
    if (state.playing && state.timeScale > 0) {
      state.playing = false;
    } else {
      state.playing = true;
      if (state.timeScale === 0) setTimeScale(1);
    }
    updatePlayIcons();
  });

  $("btn-reset").addEventListener("click", () => {
    state.simDays = 0;
    if (state.viewMode === "earth" || state.viewMode === "site") {
      if (state.earthSiteId) onSelectSite(state.earthSiteId);
      else enterEarthMode();
    } else if (state.viewMode === "leo") {
      enterLeoMode();
    } else if (state.viewMode === "stars") {
      if (starLife) {
        setLifecycleProgress(starLife, 0);
        starLife.playing = false;
        syncLifecycleHud();
      }
    } else {
      focusBody(state.focusId);
    }
  });

  $("btn-fs").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  $("btn-solar")?.addEventListener("click", () => setViewMode("solar"));
  $("btn-earth")?.addEventListener("click", () => setViewMode("earth"));
  $("btn-leo")?.addEventListener("click", () => setViewMode("leo"));
  $("btn-stars")?.addEventListener("click", () => setViewMode("stars"));

  const lifeScrub = $("life-scrub");
  lifeScrub?.addEventListener("input", () => {
    if (!starLife || state.viewMode !== "stars") return;
    state.playing = false;
    starLife.playing = false;
    updatePlayIcons();
    setLifecycleProgress(starLife, Number(lifeScrub.value) / 1000);
    syncLifecycleHud();
  });
  // Touch-friendly: pause sim while dragging scrubber
  lifeScrub?.addEventListener("pointerdown", () => {
    state.playing = false;
    if (starLife) starLife.playing = false;
    updatePlayIcons();
  });

  $("life-mass-low")?.addEventListener("click", () => applyLifecyclePath("low", state.lifeEnd));
  $("life-mass-high")?.addEventListener("click", () => applyLifecyclePath("high", state.lifeEnd));
  $("life-end-ns")?.addEventListener("click", () => applyLifecyclePath("high", "ns"));
  $("life-end-bh")?.addEventListener("click", () => applyLifecyclePath("high", "bh"));

  // Click launch sites on globe
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (state.viewMode !== "earth" || !earthTheater) return;
    if (earthTheater.mode === "site" && earthTheater.activeMission) {
      // user takes camera during launch
      state.followLaunchCam = false;
      return;
    }
    if (earthTheater.mode !== "surface") return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const id = pickLaunchSite(earthTheater, raycaster);
    if (id) onSelectSite(id);
  });

  $("tog-orbits").addEventListener("change", (e) => {
    state.showOrbits = e.target.checked;
    for (const rt of bodyRuntime.values()) {
      if (!rt.orbitLine) continue;
      if (rt.kind === "comet") {
        rt.orbitLine.visible = state.showOrbits && state.showComets;
      } else {
        rt.orbitLine.visible = state.showOrbits;
      }
    }
  });
  $("tog-labels").addEventListener("change", (e) => {
    state.showLabels = e.target.checked;
    updateLabels();
  });
  $("tog-stars").addEventListener("change", (e) => {
    state.showStars = e.target.checked;
    if (starField) starField.visible = state.showStars;
  });
  $("tog-belt").addEventListener("change", (e) => {
    state.showBelt = e.target.checked;
    if (asteroidBelt) asteroidBelt.visible = state.showBelt;
  });
  $("tog-comets").addEventListener("change", (e) => {
    state.showComets = e.target.checked;
    for (const rt of bodyRuntime.values()) {
      if (rt.kind === "comet") {
        rt.group.visible = state.showComets;
        if (rt.orbitLine) rt.orbitLine.visible = state.showComets && state.showOrbits;
      }
    }
  });
  $("tog-moons").addEventListener("change", (e) => {
    state.showMoons = e.target.checked;
    for (const rt of bodyRuntime.values()) {
      if (!rt.moons) continue;
      for (const m of rt.moons) m.mesh.visible = state.showMoons;
    }
  });
  $("tog-follow").addEventListener("change", (e) => {
    state.follow = e.target.checked;
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.code === "Space") {
      e.preventDefault();
      btnPlay.click();
    } else if (e.key === "r" || e.key === "R") {
      $("btn-reset").click();
    } else if (e.key === "f" || e.key === "F") {
      $("btn-fs").click();
    } else if (e.key === "c" || e.key === "C") {
      if (state.viewMode === "solar" && COMETS[0]) focusBody(COMETS[0].id);
    } else if (e.key === "e" || e.key === "E") {
      setViewMode("earth");
    } else if (e.key === "l" || e.key === "L") {
      setViewMode("leo");
    } else if (e.key === "s" || e.key === "S") {
      setViewMode("solar");
    } else if (e.key === "t" || e.key === "T") {
      setViewMode("stars");
    } else if (e.key === "p" || e.key === "P") {
      if (state.viewMode === "solar") focusBody("pluto");
    } else if (e.key >= "1" && e.key <= "9") {
      if (state.viewMode !== "solar") return;
      const ids = ["sun", ...PLANETS.filter((p) => p.id !== "pluto").map((p) => p.id)];
      const idx = Number(e.key) - 1;
      if (ids[idx]) focusBody(ids[idx]);
    }
  });
}

// —— Resize ——
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
}
window.addEventListener("resize", onResize);

// —— Loop ——
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (state.playing && state.timeScale !== 0 && state.viewMode === "solar") {
    // timeScale: Earth days of simulation per real second
    state.simDays += state.timeScale * dt;
  }

  // Camera tweens between modes / sites
  if (camTween) {
    camTween.t += dt;
    const u = Math.min(1, camTween.t / camTween.dur);
    const s = u * u * (3 - 2 * u);
    camera.position.lerpVectors(camTween.fromPos, camTween.toPos, s);
    controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, s);
    if (u >= 1) camTween = null;
  }

  if (state.viewMode === "stars" && starLife) {
    if (state.playing) starLife.playing = true;
    else starLife.playing = false;
    const stage = updateStarLifecycle(starLife, dt);
    syncLifecycleHud(stage);
  } else if (state.viewMode !== "solar" && earthTheater) {
    const { phaseLabel, cameraHint } = updateEarthTheater(earthTheater, dt, {
      autoPlay: state.playing,
    });
    if (phaseLabel && $("earth-phase")) $("earth-phase").textContent = phaseLabel;
    if (cameraHint && state.followLaunchCam && earthTheater.activeMission && !camTween) {
      camera.position.lerp(cameraHint.position, 1 - Math.pow(0.02, dt));
      controls.target.lerp(cameraHint.target, 1 - Math.pow(0.02, dt));
      if (cameraHint.minDist != null) controls.minDistance = cameraHint.minDist;
      if (cameraHint.maxDist != null) controls.maxDistance = cameraHint.maxDist;
    }
  } else {
    updateBodies(state.simDays, dt);
    updateLabels();

    if (state.follow) {
      const rt = bodyRuntime.get(state.focusId);
      if (rt) {
        const t = new THREE.Vector3();
        rt.group.getWorldPosition(t);
        controls.target.lerp(t, 1 - Math.pow(0.001, dt));
      }
    }
  }

  controls.update();

  if (state.viewMode === "stars" && starLife) {
    simDateEl.textContent = "lifecycle";
    simElapsedEl.textContent = (starLife.t * 100).toFixed(1) + "%";
    speedReadout.textContent = state.lifePath === "high" ? "HIGH" : "LOW";
  } else {
    simDateEl.textContent = formatDate(state.epoch, state.simDays);
    simElapsedEl.textContent = formatElapsed(state.simDays);
  }

  composer.render();
}

// —— Init ——
function init() {
  buildSystem();
  earthTheater = createEarthTheater();
  scene.add(earthTheater.root);
  starLife = createStarLifecycle();
  scene.add(starLife.root);
  buildBodyList();
  buildEarthSitesUI();
  wireHud();
  updateDetail("sun");
  setTimeScale(1);
  // Default speed: ~30 days/sec is nice for watching Earth; set to 30
  setTimeScale(30);

  // Initial body positions
  updateBodies(0, 0);

  requestAnimationFrame(() => {
    loader.classList.add("done");
  });

  animate();
}

init();

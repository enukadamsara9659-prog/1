// Shared GLSL chunks: noise, atmosphere, celestial bodies, volumetric clouds.

export const NOISE_GLSL = /* glsl */ `
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }

float vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  float n000 = hash13(i), n100 = hash13(i+vec3(1,0,0));
  float n010 = hash13(i+vec3(0,1,0)), n110 = hash13(i+vec3(1,1,0));
  float n001 = hash13(i+vec3(0,0,1)), n101 = hash13(i+vec3(1,0,1));
  float n011 = hash13(i+vec3(0,1,1)), n111 = hash13(i+vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x), mix(n010,n110,u.x), u.y),
             mix(mix(n001,n101,u.x), mix(n011,n111,u.x), u.y), u.z);
}
float fbm2(vec2 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * vnoise2(p); n += a; a *= 0.5; p *= 2.02;
  }
  return s / n;
}
float fbm3(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * vnoise3(p); n += a; a *= 0.5; p *= 2.03;
  }
  return s / n;
}
`;

export const SKY_GLSL = /* glsl */ `
const float PI = 3.14159265359;
const float Ra = 6420e3;   // atmosphere radius
const float Re = 6360e3;   // planet radius
const vec3 betaR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float betaM = 21e-6;

vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r*r;
  float d = b*b - c;
  if (d < 0.0) return vec2(1e20, -1e20);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

/**
 * Single-scattering atmosphere (Rayleigh + Mie).
 *   ro     : ray origin (planet-centred, metres; y = up)
 *   rd     : normalised ray direction
 *   sunDir : normalised direction *towards* the sun
 *   sunI   : sun radiance
 */
vec3 atmosphere(vec3 ro, vec3 rd, vec3 sunDir, float sunI, int steps, int lightSteps, vec3 groundCol, float groundLit){
  vec2 at = raySphere(ro, rd, Ra);
  if (at.y < 0.0) return vec3(0.0);
  float t0 = max(at.x, 0.0);
  float t1 = at.y;
  vec2 et = raySphere(ro, rd, Re);
  if (et.x > 0.0) t1 = min(t1, et.x);          // ray hits the ground
  if (t1 <= t0) return vec3(0.0);

  float segLen = (t1 - t0) / float(steps);
  float mu = dot(rd, sunDir);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.76;
  float gg = g * g;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - gg) * (1.0 + mu * mu)) / ((2.0 + gg) * pow(1.0 + gg - 2.0 * g * mu, 1.5));

  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  const float Hr = 7994.0, Hm = 1200.0;

  for (int i = 0; i < 24; i++){
    if (i >= steps) break;
    vec3 p = ro + rd * (t0 + segLen * (float(i) + 0.5));
    float h = max(length(p) - Re, 0.0);
    float dR = exp(-h / Hr) * segLen;
    float dM = exp(-h / Hm) * segLen;
    odR += dR; odM += dM;

    vec2 st = raySphere(p, sunDir, Ra);
    float segS = st.y / float(lightSteps);
    float odRS = 0.0, odMS = 0.0;
    bool shadow = false;
    vec2 sh = raySphere(p, sunDir, Re);
    if (sh.x > 0.0) shadow = true;
    if (!shadow){
      for (int j = 0; j < 8; j++){
        if (j >= lightSteps) break;
        vec3 ps = p + sunDir * (segS * (float(j) + 0.5));
        float hs = max(length(ps) - Re, 0.0);
        odRS += exp(-hs / Hr) * segS;
        odMS += exp(-hs / Hm) * segS;
      }
      vec3 tau = betaR * (odR + odRS) + vec3(betaM * 1.1) * (odM + odMS);
      vec3 att = exp(-tau);
      sumR += att * dR;
      sumM += att * dM;
    }
  }
  vec3 scat = sunI * (sumR * betaR * phaseR * 1.0 + sumM * betaM * phaseM);
  // distant ground seen through the atmosphere (aerial perspective towards the horizon)
  vec3 tauT = betaR * odR + vec3(betaM * 1.1) * odM;
  vec3 ground = groundCol * (0.25 + 0.75 * groundLit) * sunI * 0.0018;
  return scat + exp(-tauT) * ground;
}

float sunDisk(vec3 rd, vec3 sunDir, float angularRadius){
  float d = acos(clamp(dot(rd, sunDir), -1.0, 1.0));
  return 1.0 - smoothstep(angularRadius * 0.85, angularRadius * 1.25, d);
}

float starField(vec3 rd, float seed){
  vec3 p = rd * 260.0;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(id + seed);
  if (h < 0.972) return 0.0;
  vec3 off = hash33(id + 3.7) - 0.5;
  float d = length(f - off * 0.6);
  float mag = hash13(id + 11.3);
  return smoothstep(0.13, 0.0, d) * (0.25 + 0.95 * mag * mag);
}

float milkyWay(vec3 rd){
  float band = exp(-pow(abs(dot(rd, normalize(vec3(0.42, 0.78, -0.46)))) * 3.1, 2.0));
  float dust = fbm3(rd * 7.0 + 4.0, 4);
  return band * (0.35 + dust * 0.9);
}
`;

export const CLOUD_GLSL = /* glsl */ `
// Volumetric cloud slab, lit with a cheap multiple-scattering approximation.
precision highp sampler3D;
uniform sampler3D tNoise;
uniform vec3 uWind;
uniform float uCoverage;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uTime;
uniform vec2 uResolution;
uniform float uCloudSteps;

float remap(float v, float l0, float h0, float l1, float h1){
  return l1 + (v - l0) * (h1 - l1) / (h0 - l0 + 1e-6);
}

float cloudHeightFraction(vec3 p){ return clamp((p.y - uCloudBottom) / (uCloudTop - uCloudBottom), 0.0, 1.0); }

float sampleCloudDensity(vec3 p, float lod){
  float hf = cloudHeightFraction(p);
  if (hf < 0.0 || hf > 1.0) return 0.0;
  vec3 q = p * 0.0016 + uWind * uTime;
  // vertical profile: anvil-ish shape
  float profile = smoothstep(0.0, 0.22, hf) * smoothstep(1.0, 0.62, hf);
  vec4 n = texture(tNoise, q * 0.35);
  float base = n.r;
  float coverage = uCoverage;
  float shaped = clamp(remap(base, 1.0 - coverage, 1.0 - coverage * 0.35, 0.0, 1.0), 0.0, 1.0);
  float d = shaped * profile;
  if (d <= 0.001) return 0.0;
  // erode with higher frequency worley channels
  float erode = n.g * 0.55 + n.b * 0.28 + n.a * 0.17;
  float detail = mix(1.0, erode, clamp(hf * 1.6, 0.15, 0.85));
  d = remap(d, detail * 0.55, 1.0, 0.0, 1.0);
  return clamp(d, 0.0, 1.0) * (0.65 + 0.35 * profile);
}

vec4 marchClouds(vec3 ro, vec3 rd, float maxDist, int steps, float jitter){
  float bottom = uCloudBottom, top = uCloudTop;
  float t0 = 0.0, t1 = maxDist;
  if (rd.y > 0.0005){
    t0 = max(t0, (bottom - ro.y) / rd.y);
    t1 = min(t1, (top - ro.y) / rd.y);
  } else if (rd.y < -0.0005){
    t0 = max(t0, (top - ro.y) / rd.y);
    t1 = min(t1, (bottom - ro.y) / rd.y);
  } else {
    if (ro.y < bottom || ro.y > top) return vec4(0.0);
  }
  if (t1 <= t0) return vec4(0.0);
  t0 = max(t0, 0.0);
  t1 = min(t1, maxDist);
  if (t1 <= t0) return vec4(0.0);

  float segLen = (t1 - t0) / float(steps);
  float transmittance = 1.0;
  vec3 scattered = vec3(0.0);
  float t = t0 + segLen * jitter;
  const float extinction = 0.055;

  for (int i = 0; i < 64; i++){
    if (i >= steps || transmittance < 0.02 || t > t1) break;
    vec3 p = ro + rd * t;
    float d = sampleCloudDensity(p, 0.0);
    if (d > 0.002){
      // light march towards the sun
      float ls = (uCloudTop - uCloudBottom) / 4.0;
      float od = 0.0;
      for (int j = 0; j < 4; j++){
        vec3 lp = p + uSunDir * (ls * (float(j) + 0.5));
        od += sampleCloudDensity(lp, 0.0) * ls;
      }
      float sunT = exp(-od * extinction * 1.25);
      // powder/silver-lining
      float powder = 1.0 - exp(-d * 8.0);
      float hg = 0.65;
      float mu = dot(rd, uSunDir);
      float phase = mix(0.6, 1.6, pow(clamp(mu * 0.5 + 0.5, 0.0, 1.0), 3.0));
      vec3 sunLight = uSunColor * sunT * phase * powder * 1.35;
      vec3 amb = mix(uSkyColor * 0.55, uSkyColor * 1.25, cloudHeightFraction(p));
      vec3 lum = sunLight + amb;
      float sigma = d * extinction;
      float tr = exp(-sigma * segLen);
      vec3 integrated = lum * sigma * (1.0 - tr) / max(sigma, 1e-5);
      scattered += transmittance * integrated;
      transmittance *= tr;
    }
    t += segLen;
  }
  return vec4(scattered, transmittance);
}
`;

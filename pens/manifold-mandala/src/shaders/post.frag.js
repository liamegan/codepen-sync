export default /* glsl */ `#version 300 es
precision highp float;

// Manifold Garden-ish composite: tinted outlines, screen-space AO,
// depth fog into a soft pastel sky with a bright vanishing point.

uniform sampler2D b_scene;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_dpr;
uniform float u_fog;
uniform float u_fogStart; // distance before fog begins
uniform vec3 u_bgA; // centre / cream
uniform vec3 u_bgB; // warm corner
uniform vec3 u_bgC; // cool corner

out vec4 colour;

const float FAR = 1e4;

vec4 S(vec2 px) { return texture(b_scene, px / u_resolution); }
float D(vec4 s) { return s.a > 0. ? s.a : FAR; }

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 sky(vec2 px) {
  vec2 uv = px / u_resolution;
  vec2 q = (px - .5 * u_resolution) / u_resolution.y;
  vec3 c = mix(u_bgA, u_bgB, smoothstep(.2, 1.1, (1. - uv.x) * .7 + uv.y * .6));
  c = mix(c, u_bgC, smoothstep(.35, 1.2, uv.x * .5 + (1. - uv.y) * .9) * .7);
  c += vec3(1.) * exp(-length(q) * 4.5) * .35;
  return c;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 s = S(px);
  float d = D(s);
  bool geom = d < FAR;
  vec3 bg = sky(px);

  // --- outlines: depth + colour discontinuities over 8 neighbours
  float lw = max(1., u_dpr * .85);
  float edge = 0.;
  float dmin = d;
  vec3 ncol = s.rgb;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * .78539816;
    vec2 o = vec2(cos(a), sin(a)) * lw;
    vec4 sn = S(px + o);
    float dn = D(sn);
    float dd = abs(dn - d) / min(dn, d);
    edge = max(edge, smoothstep(.015, .06, dd));
    if (geom && dn < FAR) {
      edge = max(edge, smoothstep(.035, .09, length(sn.rgb - s.rgb)));
    }
    if (dn < dmin) {
      dmin = dn;
      ncol = sn.rgb;
    }
  }

  // --- screen-space ambient occlusion
  float ao = 1.;
  if (geom) {
    float occ = 0.;
    float rad = u_resolution.y * 1.4 / (d + 2.);
    float rot = hash(px) * 6.2831;
    for (int k = 0; k < 12; k++) {
      float f = (float(k) + .5) / 12.;
      float a = rot + float(k) * 2.39996;
      vec2 o = vec2(cos(a), sin(a)) * rad * sqrt(f);
      float ds = D(S(px + o));
      float diff = d - ds;
      occ += smoothstep(.05, .6, diff) * (1. - smoothstep(2., 6., diff));
    }
    ao = 1. - occ / 12. * .75;
  }

  // --- fog factor first, so lines and tint can key off it
  float fd = geom ? mix(d, dmin, edge) : dmin;
  float fx = max(fd - u_fogStart, 0.) / u_fog;
  float fog = fd >= FAR ? 1. : 1. - exp(-pow(fx, 1.3));

  vec3 col = geom ? s.rgb * ao : bg;

  // aerial perspective: take the sky's hue, keep the surface's luminance
  const vec3 LUMA = vec3(.299, .587, .114);
  vec3 tint = bg * (dot(col, LUMA) / max(dot(bg, LUMA), 1e-3));
  col = mix(col, tint, smoothstep(0., .7, fog) * .6);

  // outlines fade ahead of the surfaces
  float lineFade = 1. - smoothstep(.25, .8, fog);
  vec3 lineCol = ncol * vec3(.32, .26, .3);
  col = mix(col, lineCol, edge * .85 * lineFade);

  col = mix(col, bg, fog);

  // --- grade
  vec2 q = (px - .5 * u_resolution) / u_resolution.y;
  col *= 1. - .25 * smoothstep(.4, 1.1, length(q));
  col = mix(vec3(dot(col, vec3(.299, .587, .114))), col, 1.12);
  col += (hash(px + fract(u_time)) - .5) * .025;

  colour = vec4(col, 1.);
}
`;

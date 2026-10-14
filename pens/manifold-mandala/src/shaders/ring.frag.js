export default /* glsl */ `#version 300 es
precision highp float;

// Writes flat-lit albedo to rgb and linear view depth to alpha.
// The post pass uses both for outlines, AO and fog.

in vec3 v_pos;
in vec3 v_normal;
in vec3 v_col;

out vec4 colour;

void main() {
  vec3 n = normalize(v_normal);
  vec3 L = normalize(vec3(-.45, .65, .6));
  float dif = max(dot(n, L), 0.);
  float back = max(dot(n, -L), 0.);
  float hemi = n.y * .5 + .5;

  vec3 lit = v_col * (.5 + .55 * dif + .12 * hemi - .12 * back);
  colour = vec4(lit, -v_pos.z);
}
`;

/**
 * WebGL2 着色器源码(自写,无第三方引擎)。
 * 光束采用"线段+加色混合"模拟烟雾散射:每条光束用多个截面切片,
 * 片元亮度 ∝ 光束功率 × 路径烟雾散射系数积分(浓处亮)。
 */

export const SCENE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in float aAlpha;
uniform mat4 uViewProj;
out vec3 vColor;
out float vAlpha;
void main(){
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vColor = aColor;
  vAlpha = aAlpha;
}`;

export const SCENE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
uniform float uIntensity;
out vec4 frag;
void main(){
  // 加色混合:亮部自然过曝,符合暗场激光观感
  frag = vec4(vColor * uIntensity, vAlpha);
}`;

/** 烟雾箱体:半透明体积块,浓度越高越亮、略带色调 */
export const SMOKE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vLocal;
void main(){
  vec4 world = uModel * vec4(aPos,1.0);
  vLocal = aPos;
  gl_Position = uViewProj * world;
}`;

export const SMOKE_FS = `#version 300 es
precision highp float;
in vec3 vLocal;
uniform float uScatter;
uniform vec3 uTint;
out vec4 frag;
void main(){
  // 边缘菲涅耳式淡化,中心略亮,整体很淡以便看见光束
  float edge = 1.0 - 0.35*length(vLocal);
  float a = clamp(uScatter * 6.0, 0.0, 0.28) * edge;
  frag = vec4(uTint, a);
}`;

/** 安全热力图实例:观众格点按超标比着色(绿→黄→红) */
export const HEAT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aRatio;
uniform mat4 uViewProj;
uniform float uScale;
out float vRatio;
void main(){
  vRatio = aRatio;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_PointSize = uScale;
}`;

export const HEAT_FS = `#version 300 es
precision highp float;
in float vRatio;
out vec4 frag;
void main(){
  float x = clamp(vRatio, 0.0, 2.0) * 0.5;
  vec3 green = vec3(0.1, 0.9, 0.3);
  vec3 yellow = vec3(1.0, 0.85, 0.1);
  vec3 red = vec3(1.0, 0.12, 0.08);
  vec3 c = x < 0.5 ? mix(green, yellow, x*2.0) : mix(yellow, red, (x-0.5)*2.0);
  float emphasized = vRatio > 1.0 ? 1.0 : 0.35;
  frag = vec4(c, emphasized);
}`;

/** ILDA 二维预览(素材库/取景框) */
export const PREVIEW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec3 aColor;
out vec3 vColor;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vColor = aColor; }`;

export const PREVIEW_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 frag;
void main(){ frag = vec4(vColor, 1.0); }`;

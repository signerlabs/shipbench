//
//  SWMetaballs.metal
//  ShipSwift
//
//  Stitchable SwiftUI color effect — port of Paper Shaders' Metaballs
//  (https://shaders.paper.design/metaballs, MIT). Each blob is a radial
//  power-of-distance shape; per-ball shapes are summed and a smoothstep
//  threshold carves the final silhouette. Color is the shape-weighted
//  average of the per-ball colors, composited over `background`.
//
//  Paired with: SWMetaballs.swift
//  Entry point: `swMetaballs` — invoked via SwiftUI `.colorEffect(...)`.
//
//  Requires iOS 17+ / macOS 14+.
//

#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// 1D hash + smoothstep noise — replaces Paper's `noise(float x)` (which
// samples a texture in the original GLSL). Produces a smooth pseudo-
// random scalar in [0, 1] so the per-ball drift is continuous in time.
static float swMetaballsHash1(float x) {
    return fract(sin(x * 12.9898) * 43758.5453);
}

static float swMetaballsNoise1(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(swMetaballsHash1(i), swMetaballsHash1(i + 1.0), u);
}

// Paper's `getBallShape` — radial power-of-distance shape, 0..1.
// `aspectScale` rescales the (uv - c) difference so 1 unit on each axis
// corresponds to the same on-screen distance: keeps the blob round on
// portrait / landscape viewports instead of stretching with the frame.
static float swMetaballsBallShape(float2 uv, float2 c, float p, float2 aspectScale) {
    float2 diff = (uv - c) * aspectScale;
    float s = 0.5 * length(diff);
    s = 1.0 - saturate(s);
    return pow(s, p);
}

[[ stitchable ]] half4 swMetaballs(float2 position,
                                   half4  inColor,
                                   float4 boundingRect,
                                   float  time,
                                   float  speed,
                                   float  count,
                                   float  size,
                                   float  colorsCount,
                                   half4  color1,
                                   half4  color2,
                                   half4  color3,
                                   half4  color4,
                                   half4  color5,
                                   half4  color6,
                                   half4  color7,
                                   half4  color8,
                                   half4  background) {
    float2 sz = boundingRect.zw;
    // Paper's `v_objectUV + 0.5` maps the object rect to 0..1. We do the
    // same in pixel space — divide by the bounding rect to get 0..1.
    float2 shape_uv = position / max(sz, float2(1.0));
    // `aspectScale` lets `length()` measure visually equal distances on
    // both axes — divide pixels by the short side, so the short axis
    // scales to 1 and the long axis scales above 1.
    float minDim = max(min(sz.x, sz.y), 1.0);
    float2 aspectScale = sz / minDim;

    // Paper offsets time by 2503.4 in the first frame so the cluster
    // doesn't start in a "uniform initial state". `speed` is exposed
    // here as a wrapper-side multiplier on top of Paper's 0.2 factor.
    const float firstFrameOffset = 2503.4;
    float t = 0.2 * (time * speed + firstFrameOffset);

    // Pack the 8 color slots so the loop can index by ball.
    half4 colors[8] = { color1, color2, color3, color4,
                        color5, color6, color7, color8 };
    int colorsCountInt = max(int(colorsCount + 0.5), 1);

    // Paper unrolls 20 iterations; SwiftUI's stitchable color shaders
    // have a tighter instruction budget, so we cap at 8. `count` is
    // exposed as a float so the wrapper can fractional-fade the last
    // ball in / out — matching Paper's `fract(u_count)` behavior.
    float countClamped = min(max(count, 1.0), 8.0);
    int countCeil = int(ceil(countClamped));

    float3 totalColor = float3(0.0);
    float  totalShape = 0.0;

    for (int i = 0; i < 8; i++) {
        if (i >= countCeil) break;

        // Per-ball drift — two 1D noise samples placed on a circle so
        // each ball gets an independent, slowly meandering position.
        float idxFract = float(i) / 20.0;
        float angle = 6.2831853 * idxFract;
        float spd = 1.0 - 0.2 * idxFract;
        float noiseX = swMetaballsNoise1(angle * 10.0 + float(i) + t * spd);
        float noiseY = swMetaballsNoise1(angle * 20.0 + float(i) - t * spd);
        float2 pos = float2(0.5) + 1e-4 + 0.9 * (float2(noiseX, noiseY) - 0.5);

        // Pick color by `i % colorsCount` so adding balls beyond the
        // color count cycles through the palette.
        int safeIdx = i % colorsCountInt;
        half4 ballColor = colors[safeIdx];
        // Premultiply alpha — Paper's algorithm assumes premultiplied
        // color contributions when summing.
        float3 rgb = float3(ballColor.rgb) * float(ballColor.a);

        // Fractional last-ball fade: when `count` isn't a whole number,
        // shrink the last ball by `fract(count)` so it grows in.
        float sizeFrac = 1.0;
        if (float(i) > floor(countClamped - 1.0)) {
            sizeFrac *= fract(countClamped);
        }

        float p = 45.0 - 30.0 * size * sizeFrac;
        float shape = swMetaballsBallShape(shape_uv, pos, p, aspectScale);
        shape *= pow(size, 0.2);
        shape = smoothstep(0.0, 1.0, shape);

        totalColor += rgb * shape;
        totalShape += shape;
    }

    // Shape-weighted average — gives each blob its own hue while the
    // overlaps blend smoothly.
    totalColor /= max(totalShape, 1e-4);

    // Paper uses `fwidth(totalShape)` for an anti-aliased edge. Metal's
    // `fwidth` works inside fragment-shader-style stitchables — fall
    // back to a small constant if the compile target rejects it.
    float edge_width = fwidth(totalShape);
    float finalShape = smoothstep(0.4, 0.4 + edge_width, totalShape);

    float3 color = totalColor * finalShape +
                   float3(background.rgb) * (1.0 - finalShape);

    return half4(half3(color), 1.0);
}

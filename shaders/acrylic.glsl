uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float vis_x;
uniform float vis_y;
uniform float vis_w;
uniform float vis_h;
uniform float stage_x;
uniform float stage_y;
uniform float corner_radius;
uniform float corners_top;
uniform float corners_bottom;

uniform float lum_r;
uniform float lum_g;
uniform float lum_b;
uniform float lum_opacity;

uniform float tint_r;
uniform float tint_g;
uniform float tint_b;
uniform float tint_opacity;

uniform float saturation;
uniform float noise_amount;

uniform float border_edge;
uniform float border_r;
uniform float border_g;
uniform float border_b;
uniform float border_opacity;

float get_lum(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

vec3 clip_color(vec3 c) {
    float l = get_lum(c);
    float n = min(min(c.r, c.g), c.b);
    float x = max(max(c.r, c.g), c.b);
    if (n < 0.0 && l > n) {
        c = l + ((c - l) * l) / (l - n);
    }
    if (x > 1.0 && x > l) {
        c = l + ((c - l) * (1.0 - l)) / (x - l);
    }
    return clamp(c, 0.0, 1.0);
}

vec3 set_lum(vec3 c, float l) {
    float d = l - get_lum(c);
    return clip_color(c + vec3(d));
}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float circle_bounds(vec2 p, vec2 center, float clip_radius) {
    vec2 delta = p - center;
    float dist = length(delta);
    return clamp(clip_radius + 0.5 - dist, 0.0, 1.0);
}

float rect_coverage(vec2 p, vec4 bounds, float rad) {
    if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w) {
        return 0.0;
    }
    if (rad <= 0.0) {
        return 1.0;
    }
    vec2 center;
    float left = bounds.x + rad;
    float right = bounds.z - rad;
    if (p.x < left)
        center.x = left;
    else if (p.x > right)
        center.x = right;
    else
        return 1.0;

    float top = bounds.y + rad;
    float bottom = bounds.w - rad;
    if (corners_top > 0.5 && p.y < top)
        center.y = top;
    else if (corners_bottom > 0.5 && p.y > bottom)
        center.y = bottom;
    else
        return 1.0;

    return circle_bounds(p, center, rad);
}

void main() {
    vec2 uv = cogl_tex_coord_in[0].xy;
    vec2 pos = uv * vec2(width, height);
    vec4 bounds = vec4(vis_x, vis_y, vis_x + vis_w, vis_y + vis_h);

    float alpha = rect_coverage(pos, bounds, corner_radius);
    if (alpha <= 0.001) {
        cogl_color_out = vec4(0.0);
        return;
    }

    vec2 min_uv = 1.0 / max(vec2(width, height), vec2(1.0));
    vec2 max_uv = 1.0 - min_uv;
    vec4 src = texture2D(tex, clamp(uv, min_uv, max_uv));
    vec3 col = clamp(src.rgb / max(src.a, 0.0001), 0.0, 1.0);

    // Optional saturation adjustment before Luminosity blend
    if (abs(saturation - 1.0) > 0.001) {
        float base_lum = get_lum(col);
        col = clamp(mix(vec3(base_lum), col, saturation), 0.0, 1.0);
    }

    // 1. Windows 11 Acrylic Luminosity layer (preserves backdrop hue/saturation, normalizes luminance)
    if (lum_opacity > 0.0) {
        float target_lum = get_lum(vec3(lum_r, lum_g, lum_b));
        vec3 lum_blended = set_lum(col, target_lum);
        col = mix(col, lum_blended, clamp(lum_opacity, 0.0, 1.0));
    }

    // 2. Windows 11 Acrylic Tint layer
    if (tint_opacity > 0.0) {
        vec3 tint_col = vec3(tint_r, tint_g, tint_b);
        col = mix(col, tint_col, clamp(tint_opacity, 0.0, 1.0));
    }

    // 3. Stage-locked frosted micro-grain noise (triangular dither for matte Acrylic feel)
    if (noise_amount > 0.0) {
        vec2 npos = floor(pos + vec2(stage_x, stage_y));
        float n = (hash12(npos) + hash12(npos + vec2(17.3, 41.7)) - 1.0) * (noise_amount * 0.5);
        col = clamp(col + vec3(n), 0.0, 1.0);
    }

    // 4. 1px Windows 11 inner-edge hairline highlight/stroke (single edge or 4-sided rounded perimeter)
    if (border_opacity > 0.0 && border_edge >= -0.5) {
        float border_factor = 0.0;
        if (border_edge < 0.5) {
            if (pos.y >= bounds.y && pos.y < bounds.y + 1.0) border_factor = 1.0;
        } else if (border_edge < 1.5) {
            if (pos.y >= bounds.w - 1.0 && pos.y <= bounds.w) border_factor = 1.0;
        } else if (border_edge < 2.5) {
            if (pos.x >= bounds.z - 1.0 && pos.x <= bounds.z) border_factor = 1.0;
        } else if (border_edge < 3.5) {
            if (pos.x >= bounds.x && pos.x < bounds.x + 1.0) border_factor = 1.0;
        } else if (pos.x < bounds.x + corner_radius + 1.0 || pos.x > bounds.z - corner_radius - 1.0 ||
                   pos.y < bounds.y + 1.0 || pos.y > bounds.w - 1.0) {
            vec4 inner_bounds = vec4(bounds.x + 1.0, bounds.y + 1.0, bounds.z - 1.0, bounds.w - 1.0);
            float inner_rad = max(0.0, corner_radius - 1.0);
            border_factor = 1.0 - rect_coverage(pos, inner_bounds, inner_rad);
        }
        if (border_factor > 0.0) {
            col = mix(col, vec3(border_r, border_g, border_b), clamp(border_opacity * border_factor, 0.0, 1.0));
        }
    }

    cogl_color_out = vec4(col * alpha, alpha) * cogl_color_in;
}

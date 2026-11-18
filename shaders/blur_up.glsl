uniform sampler2D tex;
uniform float offset;
uniform float width;
uniform float height;

void main() {
    vec2 uv = cogl_tex_coord_in[0].xy;
    vec2 inv_size = 1.0 / max(vec2(width, height), vec2(1.0));
    vec2 min_uv = 2.0 * inv_size;
    vec2 max_uv = 1.0 - min_uv;
    vec2 off1 = (offset * 0.5) * inv_size;
    vec2 off2 = (offset * 1.5) * inv_size;

    vec4 sum = texture2D(tex, clamp(uv + vec2(-off2.x, 0.0), min_uv, max_uv));
    sum += texture2D(tex, clamp(uv + vec2(-off1.x,  off1.y), min_uv, max_uv)) * 2.0;
    sum += texture2D(tex, clamp(uv + vec2( 0.0,     off2.y), min_uv, max_uv));
    sum += texture2D(tex, clamp(uv + vec2( off1.x,  off1.y), min_uv, max_uv)) * 2.0;
    sum += texture2D(tex, clamp(uv + vec2( off2.x,  0.0), min_uv, max_uv));
    sum += texture2D(tex, clamp(uv + vec2( off1.x, -off1.y), min_uv, max_uv)) * 2.0;
    sum += texture2D(tex, clamp(uv + vec2( 0.0,    -off2.y), min_uv, max_uv));
    sum += texture2D(tex, clamp(uv + vec2(-off1.x, -off1.y), min_uv, max_uv)) * 2.0;

    cogl_color_out = (sum * (1.0 / 12.0)) * cogl_color_in;
}
